//! JPEG export command.
//!
//! Receives rendered RGBA8 pixels from the WebGPU pipeline (via IPC as raw bytes),
//! encodes them as a full-quality JPEG, and writes the result to the given path.
//!
//! The pixel data arrives as `Vec<u8>` — a flat RGBA8 buffer in row-major order
//! (the same layout produced by `pipeline.readPixels()`). The alpha channel is
//! discarded: only the RGB channels are written to the JPEG.
//!
//! This command MUST NOT be called with a path inside the roll's source directory
//! (originals are read-only per the architecture). The frontend is responsible for
//! providing a user-chosen save path from the native dialog.

use std::io::Cursor;
use std::path::Path;

use image::{DynamicImage, ImageBuffer, Rgba};

// ─── Command ──────────────────────────────────────────────────────────────────

/// Encode an RGBA8 pixel buffer as JPEG and write it to `path`.
///
/// - `pixels`  — flat RGBA8 buffer (4 bytes per pixel, row-major).
/// - `width`   — image width in pixels.
/// - `height`  — image height in pixels.
/// - `path`    — absolute destination path (e.g. `/Users/…/export.jpg`).
/// - `quality` — JPEG quality 1–100. Pass 95 for "full quality" exports.
#[tauri::command]
pub async fn export_jpeg(
    pixels: Vec<u8>,
    width: u32,
    height: u32,
    path: String,
    quality: u8,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        inner_export(pixels, width, height, &path, quality)
    })
    .await
    .map_err(|e| format!("task panicked: {:?}", e))?
}

// ─── Core logic ───────────────────────────────────────────────────────────────

fn inner_export(
    pixels: Vec<u8>,
    width: u32,
    height: u32,
    path: &str,
    quality: u8,
) -> Result<(), String> {
    // Validate dimensions match buffer length.
    let expected = (width as usize) * (height as usize) * 4;
    if pixels.len() != expected {
        return Err(format!(
            "pixel buffer length {} does not match {}×{}×4 = {}",
            pixels.len(),
            width,
            height,
            expected
        ));
    }

    // Wrap into an ImageBuffer<Rgba<u8>, _> — zero-copy (borrows the Vec).
    let img: ImageBuffer<Rgba<u8>, Vec<u8>> =
        ImageBuffer::from_raw(width, height, pixels)
            .ok_or_else(|| "failed to create ImageBuffer from pixel data".to_string())?;

    // Drop alpha — JPEG does not support transparency.
    let rgb = DynamicImage::ImageRgba8(img).to_rgb8();

    // Encode to JPEG into an in-memory buffer first, then write atomically.
    let quality = quality.clamp(1, 100);
    let mut buf = Cursor::new(Vec::with_capacity(
        (width as usize) * (height as usize) / 4,
    ));
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality);
    DynamicImage::ImageRgb8(rgb)
        .write_with_encoder(encoder)
        .map_err(|e| format!("JPEG encode failed: {e}"))?;

    // Ensure parent directory exists.
    if let Some(parent) = Path::new(path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create parent directory: {e}"))?;
    }

    // Write the JPEG bytes to disk.
    std::fs::write(path, buf.into_inner())
        .map_err(|e| format!("failed to write file: {e}"))?;

    Ok(())
}
