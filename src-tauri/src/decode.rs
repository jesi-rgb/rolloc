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
