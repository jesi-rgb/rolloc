//! JPEG export commands.
//!
//! Two export paths:
//!
//! ## `export_jpeg` (legacy / non-RAW fallback)
//! Receives rendered RGBA8 pixels from the WebGPU pipeline (via IPC as raw bytes),
//! encodes them as a full-quality JPEG, and writes the result to the given path.
//!
//! ## `export_native` (new — native-resolution RAW export)
//! Decodes a RAW file at full sensor resolution, processes the image through the
//! complete colour pipeline in f32 precision (matching the GPU shaders), and writes
//! a high-quality JPEG.  No GPU texture size limits, no 8-bit quantization until
//! the final JPEG encode.  Eliminates banding/artifacts from GPU readback.
//!
//! This command MUST NOT be called with a path inside the roll's source directory
//! (originals are read-only per the architecture). The frontend is responsible for
//! providing a user-chosen save path from the native dialog.

use std::io::Cursor;
use std::path::Path;

use image::{DynamicImage, ImageBuffer, Rgb, Rgba};

use crate::process::{self, EffectiveEdit, LogPercentiles};
use crate::raw::read_exif_orientation;

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

// ─── Native export (full-res, f32 pipeline, no GPU) ───────────────────────────

/// Decode a RAW file at full sensor resolution, process it through the CPU-side
/// colour pipeline in f32 precision, and write the result as a high-quality JPEG.
///
/// - `source_path` — absolute path to the RAW file on disk.
/// - `export_path` — user-chosen destination path for the JPEG.
/// - `edit`        — the fully-resolved edit parameters (serialized EffectiveEdit).
/// - `log_perc`    — log percentiles from the preview render (for consistent normalization).
///                   When null/None, percentiles are recomputed from the full-res data.
/// - `skip_wb`     — when true (film inversion), skip as-shot WB during decode.
/// - `quality`     — JPEG quality 1–100.
#[tauri::command]
pub async fn export_native(
    source_path: String,
    export_path: String,
    edit: EffectiveEdit,
    log_perc: Option<LogPercentiles>,
    skip_wb: Option<bool>,
    quality: u8,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        inner_export_native(
            &source_path,
            &export_path,
            &edit,
            log_perc.as_ref(),
            skip_wb.unwrap_or(false),
            quality,
        )
    })
    .await
    .map_err(|e| format!("task panicked: {:?}", e))?
}

fn inner_export_native(
    source_path: &str,
    export_path: &str,
    edit: &EffectiveEdit,
    log_perc: Option<&LogPercentiles>,
    skip_wb: bool,
    quality: u8,
) -> Result<(), String> {
    // ── Decode RAW at full resolution (no max_px cap) ────────────────────────
    let raw = rawler::decode_file(source_path)
        .map_err(|e| format!("RAW decode failed: {e}"))?;

    let pw = raw.width;
    let ph = raw.height;
    let pixels = raw.pixels_u16();
    let blacks = raw.blacklevel.as_bayer_array();
    let whites = raw.whitelevel.as_bayer_array();

    // As-shot WB (same logic as raw_decode in raw.rs)
    let wb_raw = raw.wb_coeffs;
    let wb_g = if wb_raw[1].is_finite() && wb_raw[1] > 0.001 {
        wb_raw[1]
    } else {
        1.0_f32
    };
    let wb_r = if skip_wb {
        1.0_f32
    } else if wb_raw[0].is_finite() && wb_raw[0] > 0.001 {
        wb_raw[0] / wb_g
    } else {
        1.0_f32
    };
    let wb_b = if skip_wb {
        1.0_f32
    } else if wb_raw[2].is_finite() && wb_raw[2] > 0.001 {
        wb_raw[2] / wb_g
    } else {
        1.0_f32
    };
    let wb_for_ch = |ch: usize| -> f32 {
        match ch {
            0 => wb_r,
            2 => wb_b,
            _ => 1.0_f32,
        }
    };

    // Channel normalizer (black-subtracted, WB-scaled, clamped 0–1)
    let norm_ch = |ch: usize, v: f32| -> f32 {
        let bl = blacks[ch.min(3)];
        let wl = whites[ch.min(3)];
        let norm = (v - bl).max(0.0) / (wl - bl).max(1.0);
        (norm * wb_for_ch(ch)).clamp(0.0, 1.0)
    };

    // ── Demosaic at full resolution ──────────────────────────────────────────
    // For Bayer (2×2) CFA: use AHD (Adaptive Homogeneity-Directed) demosaic
    // which produces full sensor-resolution output (minus a small border).
    // For X-Trans (6×6) or other exotic CFA: fall back to superpixel.
    // For already-demosaiced data (cpp == 3): straight normalisation.

    let (out_w, out_h, rgb_f32) = if raw.cpp == 3 {
        // Already-demosaiced (some DNGs)
        let bl = blacks[0];
        let wl = whites[0];
        let range = (wl - bl).max(1.0);
        let ow = pw;
        let oh = ph;
        let mut buf = vec![0.0_f32; ow * oh * 3];
        for y in 0..oh {
            for x in 0..ow {
                let i = y * pw + x;
                let r =
                    ((pixels[i * 3] as f32 - bl).max(0.0) / range * wb_for_ch(0)).clamp(0.0, 1.0);
                let g = ((pixels[i * 3 + 1] as f32 - bl).max(0.0) / range * wb_for_ch(1))
                    .clamp(0.0, 1.0);
                let b = ((pixels[i * 3 + 2] as f32 - bl).max(0.0) / range * wb_for_ch(2))
                    .clamp(0.0, 1.0);
                let base = (y * ow + x) * 3;
                buf[base] = r;
                buf[base + 1] = g;
                buf[base + 2] = b;
            }
        }
        (ow, oh, buf)
    } else {
        let cfa = &raw.camera.cfa;
        let cfa_w = cfa.width;
        let cfa_h = cfa.height;

        if cfa_w == 2 && cfa_h == 2 {
            // Bayer 2×2 — AHD full-resolution demosaic.
            crate::demosaic::demosaic_ahd(pixels, pw, ph, |r, c| cfa.color_at(r, c), norm_ch)
        } else {
            // X-Trans or other — superpixel fallback.
            crate::demosaic::demosaic_superpixel(
                pixels,
                pw,
                ph,
                cfa_w,
                cfa_h,
                |r, c| cfa.color_at(r, c),
                norm_ch,
            )
        }
    };

    // ── EXIF orientation ─────────────────────────────────────────────────────
    let orientation = read_exif_orientation(source_path);
    let (final_w, final_h, rgb_f32) = if orientation != 1 && orientation != 0 {
        // Build an RGB u16 image, apply orientation via the `image` crate, extract f32.
        let u16_data: Vec<u16> = rgb_f32
            .iter()
            .map(|&v| (v * 65535.0).round().clamp(0.0, 65535.0) as u16)
            .collect();
        let img_buf: ImageBuffer<Rgb<u16>, Vec<u16>> =
            ImageBuffer::from_raw(out_w as u32, out_h as u32, u16_data)
                .ok_or_else(|| "failed to build u16 image for rotation".to_string())?;

        let rotated =
            crate::raw::apply_orientation(DynamicImage::ImageRgb16(img_buf), orientation);
        let rgb16 = rotated.to_rgb16();
        let rw = rgb16.width() as usize;
        let rh = rgb16.height() as usize;
        let f32_data: Vec<f32> = rgb16
            .as_raw()
            .iter()
            .map(|&v| v as f32 / 65535.0)
            .collect();
        (rw, rh, f32_data)
    } else {
        (out_w, out_h, rgb_f32)
    };

    // Rebind as mutable for processing.
    let mut rgb_f32 = rgb_f32;

    // ── Process through the CPU pipeline ─────────────────────────────────────
    process::process_image(&mut rgb_f32, final_w, final_h, edit, log_perc);

    // ── Convert f32 [0,1] sRGB → u8 [0,255] ─────────────────────────────────
    let u8_data: Vec<u8> = rgb_f32
        .iter()
        .map(|&v| (v * 255.0 + 0.5).floor().clamp(0.0, 255.0) as u8)
        .collect();

    let img_buf: ImageBuffer<Rgb<u8>, Vec<u8>> =
        ImageBuffer::from_raw(final_w as u32, final_h as u32, u8_data)
            .ok_or_else(|| "failed to create output ImageBuffer".to_string())?;

    // ── JPEG encode + write ──────────────────────────────────────────────────
    let quality = quality.clamp(1, 100);
    let mut buf = Cursor::new(Vec::with_capacity(final_w * final_h / 4));
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality);
    DynamicImage::ImageRgb8(img_buf)
        .write_with_encoder(encoder)
        .map_err(|e| format!("JPEG encode failed: {e}"))?;

    if let Some(parent) = Path::new(export_path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create parent directory: {e}"))?;
    }

    std::fs::write(export_path, buf.into_inner())
        .map_err(|e| format!("failed to write file: {e}"))?;

    Ok(())
}
