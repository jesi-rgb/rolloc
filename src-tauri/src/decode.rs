//! Shared image-decode helper.
//!
//! `image::open` applies the `image` crate's *default* allocation limit
//! (512 MiB).  A full-resolution 16-bit TIFF (e.g. a stitched panorama at
//! 6146×8240 → ~303 MB of RGB16 samples) exceeds that cap and the decode
//! fails instantly with "Memory limit exceeded".  That is why large 16-bit
//! files appeared to "never load": the failure surfaced as a perpetual
//! loading/retry state rather than a fast error.
//!
//! This helper decodes via `ImageReader` with a generous allocation cap so
//! large 8-bit *and* 16-bit images load.  The cap is still bounded (not
//! `no_limits`) so a malformed file claiming absurd dimensions can't OOM the
//! process — it stays a recoverable error.

use std::path::Path;

use image::{DynamicImage, ImageReader, Limits};
use tauri::ipc::Response;

/// Maximum decode allocation. 4 GiB comfortably covers full-resolution 16-bit
/// panoramas while still rejecting pathological / malformed headers.
const MAX_DECODE_ALLOC: u64 = 4 * 1024 * 1024 * 1024;

/// Decode an image file from `path` with raised allocation limits.
///
/// Drop-in replacement for `image::open(path)` that succeeds on large 16-bit
/// images.  Format is detected from content (with extension as a fallback).
pub fn decode_image(path: impl AsRef<Path>) -> Result<DynamicImage, String> {
    let reader = ImageReader::open(path.as_ref())
        .map_err(|e| format!("open failed: {e}"))?
        .with_guessed_format()
        .map_err(|e| format!("format detection failed: {e}"))?;

    let mut reader = reader;
    let mut limits = Limits::no_limits();
    limits.max_alloc = Some(MAX_DECODE_ALLOC);
    reader.limits(limits);

    reader.decode().map_err(|e| format!("decode failed: {e}"))
}

/// Decode a non-RAW image and return raw RGBA8 bytes.
///
/// - `path`   — absolute path to the source image (JPEG/TIFF/PNG/etc).
/// - `max_px` — optional long-edge cap. If provided, the image is downsampled
///   so its largest dimension is at most `max_px` using Lanczos3 filter.
///   Pass the GPU's maxTextureDimension2D limit here.
///
/// The returned binary response layout:
///   [0..4]   width  : u32 LE
///   [4..8]   height : u32 LE
///   [8..]    RGBA u8 pixels
#[tauri::command]
pub async fn decode_image_rgba(path: String, max_px: Option<u32>) -> Result<Response, String> {
    let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let mut img = decode_image(&path)?;

        // Apply EXIF orientation from the source file so the returned buffer
        // is already upright (the image crate does not auto-rotate).
        let orientation = read_exif_orientation(&path);
        img = apply_orientation(img, orientation);

        // Scale down if a cap was requested (e.g. GPU texture limit).
        if let Some(limit) = max_px {
            let (w, h) = (img.width(), img.height());
            let long = w.max(h);
            if long > limit {
                let scale = limit as f32 / long as f32;
                let new_w = ((w as f32) * scale).round() as u32;
                let new_h = ((h as f32) * scale).round() as u32;
                img = img.resize(new_w, new_h, image::imageops::FilterType::Lanczos3);
            }
        }

        let rgba = img.to_rgba8();
        let width = rgba.width();
        let height = rgba.height();
        let pixels = rgba.into_raw();

        let mut out = Vec::with_capacity(8 + pixels.len());
        out.extend_from_slice(&width.to_le_bytes());
        out.extend_from_slice(&height.to_le_bytes());
        out.extend_from_slice(&pixels);
        Ok(out)
    })
    .await
    .map_err(|e| format!("task panicked: {e:?}"))??;

    Ok(Response::new(bytes))
}

fn read_exif_orientation(path: impl AsRef<Path>) -> u32 {
    use exif::Reader;
    use std::fs::File;
    use std::io::BufReader;

    let file = match File::open(path.as_ref()) {
        Ok(f) => f,
        Err(_) => return 1,
    };
    let mut reader = BufReader::new(file);
    let exif = match Reader::new().read_from_container(&mut reader) {
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

fn apply_orientation(img: DynamicImage, orientation: u32) -> DynamicImage {
    match orientation {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(),
        6 => img.rotate90(),
        7 => img.rotate270().fliph(),
        8 => img.rotate270(),
        _ => img,
    }
}
