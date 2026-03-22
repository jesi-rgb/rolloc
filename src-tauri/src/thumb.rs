//! Native thumbnail generation command.
//!
//! Reads an image file from disk, decodes it with the `image` crate, resizes
//! to `max_px` on the long edge, and returns a JPEG as raw bytes via Tauri's
//! binary IPC channel.
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

use std::io::Cursor;

use image::{imageops::FilterType, DynamicImage};
use tauri::ipc::Response;

// ─── Command ──────────────────────────────────────────────────────────────────

/// Generate a JPEG thumbnail for the file at `path`.
///
/// - `path`    — absolute path to the source image.
/// - `max_px`  — maximum pixel count on the long edge (e.g. 300 for thumbs,
///               1200 for previews).
/// - `quality` — JPEG quality 1–100 (e.g. 88).
///
/// Returns raw JPEG bytes as a binary `Response` (no base64 overhead).
#[tauri::command]
pub async fn generate_thumb(
    path: String,
    max_px: u32,
    quality: u8,
) -> Result<Response, String> {
    let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        inner_generate(path, max_px, quality)
    })
    .await
    .map_err(|e| format!("task panicked: {:?}", e))??;

    Ok(Response::new(bytes))
}

fn inner_generate(path: String, max_px: u32, quality: u8) -> Result<Vec<u8>, String> {
    // ── Decode ────────────────────────────────────────────────────────────────
    let img = image::open(&path).map_err(|e| format!("decode failed: {e}"))?;

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

    // ── JPEG encode ───────────────────────────────────────────────────────────
    let mut buf = Cursor::new(Vec::with_capacity(32 * 1024));
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality);
    DynamicImage::from(thumb.to_rgb8())
        .write_with_encoder(encoder)
        .map_err(|e| format!("encode failed: {e}"))?;

    Ok(buf.into_inner())
}
