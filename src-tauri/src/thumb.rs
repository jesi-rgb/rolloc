//! Native thumbnail generation command.
//!
//! Reads an image file from disk, decodes it with the `image` crate, applies
//! EXIF orientation correction, resizes to `max_px` on the long edge, and
//! optionally applies the full NegPy film-negative inversion pipeline before
//! returning a JPEG as raw bytes via Tauri's binary IPC channel.
//!
//! Key design decisions:
//!   - `Triangle` (bilinear) filter instead of Lanczos3: ~10× faster for
//!     thumbnail-sized output where the quality difference is invisible at
//!     300px.  Lanczos3 is overkill here.
//!   - Raw bytes returned via `tauri::ipc::Response` — no base64 encoding.
//!     The JS side receives a plain `ArrayBuffer`.
//!   - `async` command + `spawn_blocking`: CPU work runs on Tokio's blocking
//!     thread pool, never on the WebView main thread or async executor.
//!     Multiple concurrent invocations are fully parallel.
//!   - EXIF orientation is applied via `kamadak-exif` so portrait shots
//!     stored sideways in the file are corrected before output.

use std::fs::File;
use std::io::{BufReader, Cursor};

use image::{imageops::FilterType, DynamicImage};
use tauri::ipc::Response;

use crate::negative::types::FilmType;
use crate::negative::{self, FilmCurve, Normalizer, PrintInputs};

// ─── Command ──────────────────────────────────────────────────────────────────

/// Generate a JPEG thumbnail for the file at `path`.
///
/// - `path`      — absolute path to the source image.
/// - `max_px`    — maximum pixel count on the long edge (e.g. 300 for thumbs,
///                 1200 for previews).
/// - `quality`   — JPEG quality 1–100 (e.g. 88).
/// - `film_type` — film processing mode:
///                 - "C41" — color negative (apply inversion + orange mask removal)
///                 - "BW"  — black & white negative (apply inversion + desaturate)
///                 - "E6"  — slide/reversal (the transparency transfer, no metering)
///                 - "none" or empty — no processing (for digital photos)
///
/// Returns raw JPEG bytes as a binary `Response` (no base64 overhead).
#[tauri::command]
pub async fn generate_thumb(
    path: String,
    max_px: u32,
    quality: u8,
    film_type: String,
) -> Result<Response, String> {
    let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        inner_generate(path, max_px, quality, &film_type)
    })
    .await
    .map_err(|e| format!("task panicked: {:?}", e))??;

    Ok(Response::new(bytes))
}

// ─── EXIF orientation ─────────────────────────────────────────────────────────

/// Read the EXIF `Orientation` tag from a file, returning values 1–8.
/// Returns 1 (no rotation) on any error or if the tag is absent.
fn read_exif_orientation(path: &str) -> u32 {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return 1,
    };
    let mut reader = BufReader::new(file);
    let exif = match exif::Reader::new().read_from_container(&mut reader) {
        Ok(e) => e,
        Err(_) => return 1,
    };
    match exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY) {
        Some(field) => match field.value.get_uint(0) {
            Some(v) if v >= 1 && v <= 8 => v,
            _ => 1,
        },
        None => 1,
    }
}

/// Apply EXIF orientation to a `DynamicImage` by rotating/flipping in-place.
///
/// EXIF orientation values:
///   1 — normal (top-left)              no-op
///   2 — flip horizontal
///   3 — rotate 180°
///   4 — flip vertical
///   5 — transpose (flip H + rotate 90° CCW)
///   6 — rotate 90° CW
///   7 — transverse (flip H + rotate 90° CW)
///   8 — rotate 90° CCW
fn apply_orientation(img: DynamicImage, orientation: u32) -> DynamicImage {
    match orientation {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(),
        6 => img.rotate90(),
        7 => img.rotate270().fliph(),
        8 => img.rotate270(),
        _ => img, // 1 or unknown — no transform
    }
}

// ─── Film render for thumbnails ───────────────────────────────────────────────

/// Render a film thumbnail with the app's default settings: the same analysis,
/// solve and curve as the editor preview and the native export
/// (`crate::negative`). A negative is inverted through the print curve (B&W
/// collapses to one density before it and prints gray); a slide goes through the
/// transparency transfer, which at defaults returns the 8-bit source as it is.
pub fn apply_default_render(img: &mut image::RgbImage, film_type: FilmType) {
    let width = img.width() as usize;
    let height = img.height() as usize;

    // Skip very small images (likely corrupted or placeholders).
    if width * height < 100 {
        return;
    }

    let srgb_lut = srgb_to_linear_lut();
    let linear: Vec<f32> = img.as_raw().iter().map(|&v| srgb_lut[v as usize]).collect();

    let analysis = negative::analyze(&linear, width, height, film_type, None);
    let inputs = PrintInputs {
        film_type,
        ..PrintInputs::default()
    };
    let (bounds, curve_params) = negative::solve(&inputs, &analysis, None);
    let normalizer = Normalizer::new(&bounds);
    // Thumbnails decode 8-bit images: display-referred, never scene-linear.
    let curve = FilmCurve::new(film_type, &curve_params, false);

    // Standard tone preset: gamma 2.2, no tone stage.
    let encode = |t: f32| (t.clamp(0.0, 1.0).powf(1.0 / 2.2) * 255.0).round() as u8;
    for (p, lin) in img.pixels_mut().zip(linear.chunks_exact(3)) {
        p.0 = curve.render(normalizer.apply([lin[0], lin[1], lin[2]])).map(encode);
    }
}

/// Build a 256-entry sRGB→linear LUT keyed on the 8-bit sample value.
///
/// Exact IEC 61966-2-1 EOTF — matches `srgb_to_linear` in `export.rs` and
/// `normalization.wgsl`.  The previous `powf(2.2)` approximation diverges by
/// up to ~1.5% near black, and the per-channel log stretch amplifies exactly
/// that region on C-41 (the orange mask squeezes the blue channel into a
/// narrow band just above zero), so the error surfaced as a thumbnail-only
/// colour cast.
fn srgb_to_linear_lut() -> [f32; 256] {
    std::array::from_fn(|i| {
        let c = i as f32 / 255.0;
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    })
}

// ─── Core logic ───────────────────────────────────────────────────────────────

fn inner_generate(path: String, max_px: u32, quality: u8, film_type: &str) -> Result<Vec<u8>, String> {
    // ── Decode ────────────────────────────────────────────────────────────────
    // Raised allocation limits so large 16-bit TIFFs (e.g. stitched panos)
    // decode instead of failing the `image` crate's default 512 MiB cap.
    let img = crate::decode::decode_image(&path)?;

    // ── EXIF orientation ──────────────────────────────────────────────────────
    let orientation = read_exif_orientation(&path);
    let img = apply_orientation(img, orientation);

    // ── Resize ────────────────────────────────────────────────────────────────
    // Triangle (bilinear) is ~10× faster than Lanczos3 and indistinguishable
    // at thumbnail sizes (300px).  Use it for thumbs; callers that need
    // preview quality can pass a larger max_px but still benefit from speed.
    let (w, h) = (img.width(), img.height());
    let thumb = if w <= max_px && h <= max_px {
        img
    } else {
        img.resize(max_px, max_px, FilterType::Triangle)
    };

    // ── Film processing based on type ─────────────────────────────────────────
    let film = match film_type {
        "C41" => Some(FilmType::C41),
        "BW" => Some(FilmType::Bw),
        "E6" => Some(FilmType::E6),
        // "none" or empty — no processing (digital photos / libraries)
        _ => None,
    };
    let rgb = match film {
        Some(film) => {
            let mut rgb = thumb.to_rgb8();
            apply_default_render(&mut rgb, film);
            DynamicImage::from(rgb)
        }
        None => thumb,
    };

    // ── JPEG encode ───────────────────────────────────────────────────────────
    let mut buf = Cursor::new(Vec::with_capacity(32 * 1024));
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality);
    rgb.write_with_encoder(encoder)
        .map_err(|e| format!("encode failed: {e}"))?;

    Ok(buf.into_inner())
}
