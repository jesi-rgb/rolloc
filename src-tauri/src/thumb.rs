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

// ─── NegPy constants (must match process.rs / pipeline.ts) ────────────────────

const D_MAX: f32 = 4.0;
const ANALYSIS_BUFFER: f32 = 0.10;

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
///                 - "E6"  — slide/reversal (no inversion, just normalize)
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

// ─── Full NegPy inversion for thumbnails ──────────────────────────────────────

/// Per-channel log-density percentiles for the normalization pass.
struct LogPercentiles {
    floors: [f32; 3],
    ceils: [f32; 3],
}

/// Compute per-channel log10 percentiles from linear f32 RGB pixels.
/// Uses the same algorithm as process.rs for consistency.
fn compute_log_percentiles(pixels: &[f32], width: usize, height: usize) -> LogPercentiles {
    let log10_e: f32 = std::f32::consts::LOG10_E;
    let eps: f32 = 1e-6;
    let stride = 4_usize; // Sample every 4th pixel for speed

    let cut_y = (height as f32 * ANALYSIS_BUFFER).floor() as usize;
    let cut_x = (width as f32 * ANALYSIS_BUFFER).floor() as usize;
    let start_y = cut_y;
    let end_y = height.saturating_sub(cut_y);
    let start_x = cut_x;
    let end_x = width.saturating_sub(cut_x);

    let mut r_log = Vec::new();
    let mut g_log = Vec::new();
    let mut b_log = Vec::new();
    let mut mean_log = Vec::new();

    let mut y = start_y;
    while y < end_y {
        let mut x = start_x;
        while x < end_x {
            let i = (y * width + x) * 3;
            let r = pixels[i];
            let g = pixels[i + 1];
            let b = pixels[i + 2];

            if r > eps && g > eps && b > eps {
                let lr = r.ln() * log10_e;
                let lg = g.ln() * log10_e;
                let lb = b.ln() * log10_e;
                r_log.push(lr);
                g_log.push(lg);
                b_log.push(lb);
                mean_log.push((lr + lg + lb) / 3.0);
            }
            x += stride;
        }
        y += stride;
    }

    fn percentile(arr: &mut [f32], p: f32) -> f32 {
        if arr.is_empty() {
            return -1.0;
        }
        arr.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let idx = ((p / 100.0) * (arr.len() as f32 - 1.0)).floor() as usize;
        arr[idx.min(arr.len() - 1)]
    }

    // Floors: find the 0.001th percentile of mean luminance, select pixels
    // at or below that threshold, and average their per-channel log values.
    let mut mean_sorted = mean_log.clone();
    let dark_threshold = percentile(&mut mean_sorted, 0.001);

    let mut floor_r = 0.0_f32;
    let mut floor_g = 0.0_f32;
    let mut floor_b = 0.0_f32;
    let mut dark_count = 0_usize;
    for (i, &m) in mean_log.iter().enumerate() {
        if m <= dark_threshold {
            floor_r += r_log[i];
            floor_g += g_log[i];
            floor_b += b_log[i];
            dark_count += 1;
        }
    }

    let floors = if dark_count > 0 {
        [
            floor_r / dark_count as f32,
            floor_g / dark_count as f32,
            floor_b / dark_count as f32,
        ]
    } else {
        [
            percentile(&mut r_log.clone(), 0.001),
            percentile(&mut g_log.clone(), 0.001),
            percentile(&mut b_log.clone(), 0.001),
        ]
    };

    LogPercentiles {
        floors,
        ceils: [
            percentile(&mut r_log, 99.999),
            percentile(&mut g_log, 99.999),
            percentile(&mut b_log, 99.999),
        ],
    }
}

/// Numerically stable logistic sigmoid (matches process.rs).
#[inline(always)]
fn fast_sigmoid(x: f32) -> f32 {
    if x >= 0.0 {
        1.0 / (1.0 + (-x).exp())
    } else {
        let z = x.exp();
        z / (1.0 + z)
    }
}

/// Process one channel through the H&D pipeline.
/// Returns gamma-encoded (1/2.2) transmittance in [0, 1].
/// 
/// Uses default NegPy parameters: density=1.0, grade=2.5
#[inline(always)]
fn hd_channel(pixel: f32) -> f32 {
    // Default parameters (matching DEFAULT_INVERSION_PARAMS in types.ts)
    let density = 1.0_f32;
    let grade = 2.5_f32;
    
    // Derived values (matching process.rs constants)
    let density_multiplier = 0.15_f32;
    let grade_multiplier = 1.75_f32;
    
    let pivot = 1.0 - (0.01 + density * density_multiplier);
    let slope = 1.0 + grade * grade_multiplier;
    
    let diff = pixel - pivot;
    
    // H&D sigmoid → print density
    let density_out = D_MAX * fast_sigmoid(slope * diff);
    
    // Density → transmittance → perceptual gamma (1/2.2)
    let transmittance = 10.0_f32.powf(-density_out);
    transmittance.max(0.0).powf(1.0 / 2.2).clamp(0.0, 1.0)
}

/// Apply the full NegPy film-negative inversion to an RGB8 image.
///
/// Pipeline (matches process.rs negative path):
///   1. Convert to f32 linear (sRGB decode)
///   2. Compute log10 percentiles (auto black/white point)
///   3. Log normalization — per-channel stretch inverts + removes orange mask
///   4. H&D curve — sigmoid paper response with proper density/grade
///   5. Gamma encode (1/2.2, already applied in hd_channel)
pub fn apply_quick_inversion(img: &mut image::RgbImage) {
    let (width, height) = img.dimensions();
    let width = width as usize;
    let height = height as usize;
    let pixel_count = width * height;

    // Skip inversion for very small images (likely corrupted or placeholders).
    if pixel_count < 100 {
        return;
    }

    // ── Step 1: Convert to f32 linear ─────────────────────────────────────────
    let mut pixels: Vec<f32> = Vec::with_capacity(pixel_count * 3);
    for p in img.pixels() {
        // sRGB → linear (gamma 2.2)
        pixels.push((p[0] as f32 / 255.0).powf(2.2));
        pixels.push((p[1] as f32 / 255.0).powf(2.2));
        pixels.push((p[2] as f32 / 255.0).powf(2.2));
    }

    // ── Step 2: Compute log10 percentiles ─────────────────────────────────────
    let perc = compute_log_percentiles(&pixels, width, height);

    // ── Step 3+4: Log normalization + H&D curve ───────────────────────────────
    let log10_e: f32 = std::f32::consts::LOG10_E;
    let eps: f32 = 1e-6;

    for chunk in pixels.chunks_mut(3) {
        let r = chunk[0];
        let g = chunk[1];
        let b = chunk[2];

        // Log normalization (inverts + removes orange mask)
        let lr = r.max(eps).ln() * log10_e;
        let lg = g.max(eps).ln() * log10_e;
        let lb = b.max(eps).ln() * log10_e;

        let safe_delta = |f: f32, c: f32| -> f32 {
            let d = c - f;
            let abs_d = d.abs().max(eps);
            d.signum() * abs_d
        };

        let nr = ((lr - perc.floors[0]) / safe_delta(perc.floors[0], perc.ceils[0])).clamp(0.0, 1.0);
        let ng = ((lg - perc.floors[1]) / safe_delta(perc.floors[1], perc.ceils[1])).clamp(0.0, 1.0);
        let nb = ((lb - perc.floors[2]) / safe_delta(perc.floors[2], perc.ceils[2])).clamp(0.0, 1.0);

        // H&D curve (already gamma encodes to 1/2.2)
        chunk[0] = hd_channel(nr);
        chunk[1] = hd_channel(ng);
        chunk[2] = hd_channel(nb);
    }

    // ── Step 5: Write back to image ───────────────────────────────────────────
    for (i, p) in img.pixels_mut().enumerate() {
        let idx = i * 3;
        p[0] = (pixels[idx] * 255.0).round() as u8;
        p[1] = (pixels[idx + 1] * 255.0).round() as u8;
        p[2] = (pixels[idx + 2] * 255.0).round() as u8;
    }
}

/// Apply B&W film negative inversion to an RGB8 image.
///
/// Same as C41 inversion but converts to grayscale after inversion.
/// Uses luminance weights (Rec. 709) for the grayscale conversion.
pub fn apply_bw_inversion(img: &mut image::RgbImage) {
    // First apply the standard inversion
    apply_quick_inversion(img);
    
    // Then convert to grayscale using luminance weights
    for p in img.pixels_mut() {
        let luma = (0.2126 * p[0] as f32 + 0.7152 * p[1] as f32 + 0.0722 * p[2] as f32).round() as u8;
        p[0] = luma;
        p[1] = luma;
        p[2] = luma;
    }
}

/// Apply E6 slide film normalization (no inversion) to an RGB8 image.
///
/// Slide film is already positive — just apply auto levels normalization
/// without the inversion step.
pub fn apply_e6_normalize(img: &mut image::RgbImage) {
    let (width, height) = img.dimensions();
    let width = width as usize;
    let height = height as usize;
    let pixel_count = width * height;

    if pixel_count < 100 {
        return;
    }

    // Convert to f32 linear
    let mut pixels: Vec<f32> = Vec::with_capacity(pixel_count * 3);
    for p in img.pixels() {
        pixels.push((p[0] as f32 / 255.0).powf(2.2));
        pixels.push((p[1] as f32 / 255.0).powf(2.2));
        pixels.push((p[2] as f32 / 255.0).powf(2.2));
    }

    // Compute percentiles for normalization
    let perc = compute_log_percentiles(&pixels, width, height);
    let log10_e: f32 = std::f32::consts::LOG10_E;
    let eps: f32 = 1e-6;

    // Normalize without inverting — stretch to full range
    for chunk in pixels.chunks_mut(3) {
        let r = chunk[0];
        let g = chunk[1];
        let b = chunk[2];

        let lr = r.max(eps).ln() * log10_e;
        let lg = g.max(eps).ln() * log10_e;
        let lb = b.max(eps).ln() * log10_e;

        let safe_delta = |f: f32, c: f32| -> f32 {
            let d = c - f;
            let abs_d = d.abs().max(eps);
            d.signum() * abs_d
        };

        // Normalize but don't invert — floor becomes 0, ceil becomes 1
        let nr = ((lr - perc.floors[0]) / safe_delta(perc.floors[0], perc.ceils[0])).clamp(0.0, 1.0);
        let ng = ((lg - perc.floors[1]) / safe_delta(perc.floors[1], perc.ceils[1])).clamp(0.0, 1.0);
        let nb = ((lb - perc.floors[2]) / safe_delta(perc.floors[2], perc.ceils[2])).clamp(0.0, 1.0);

        // For E6, we DON'T invert — the normalized value IS the output
        // Apply gamma correction (1/2.2) for display
        chunk[0] = nr.powf(1.0 / 2.2);
        chunk[1] = ng.powf(1.0 / 2.2);
        chunk[2] = nb.powf(1.0 / 2.2);
    }

    // Write back
    for (i, p) in img.pixels_mut().enumerate() {
        let idx = i * 3;
        p[0] = (pixels[idx] * 255.0).round() as u8;
        p[1] = (pixels[idx + 1] * 255.0).round() as u8;
        p[2] = (pixels[idx + 2] * 255.0).round() as u8;
    }
}

// ─── Core logic ───────────────────────────────────────────────────────────────

fn inner_generate(path: String, max_px: u32, quality: u8, film_type: &str) -> Result<Vec<u8>, String> {
    // ── Decode ────────────────────────────────────────────────────────────────
    let img = image::open(&path).map_err(|e| format!("decode failed: {e}"))?;

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
    let rgb = match film_type {
        "C41" => {
            // Color negative — full inversion + orange mask removal
            let mut rgb = thumb.to_rgb8();
            apply_quick_inversion(&mut rgb);
            DynamicImage::from(rgb)
        }
        "BW" => {
            // B&W negative — inversion + grayscale conversion
            let mut rgb = thumb.to_rgb8();
            apply_bw_inversion(&mut rgb);
            DynamicImage::from(rgb)
        }
        "E6" => {
            // Slide/reversal — no inversion, just normalize
            let mut rgb = thumb.to_rgb8();
            apply_e6_normalize(&mut rgb);
            DynamicImage::from(rgb)
        }
        _ => {
            // "none" or empty — no processing (digital photos / libraries)
            thumb
        }
    };

    // ── JPEG encode ───────────────────────────────────────────────────────────
    let mut buf = Cursor::new(Vec::with_capacity(32 * 1024));
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality);
    rgb.write_with_encoder(encoder)
        .map_err(|e| format!("encode failed: {e}"))?;

    Ok(buf.into_inner())
}
