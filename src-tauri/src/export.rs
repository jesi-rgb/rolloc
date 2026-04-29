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

use crate::process::{self, EffectiveEdit, LogPercentiles, TransformParams};
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

// ─── Transform + Crop helpers ─────────────────────────────────────────────────

use crate::process::CropQuad;

/// Compute the output dimensions for a crop operation.
/// The crop coordinates are normalized (0-1) relative to the SOURCE image dimensions,
/// even when rotation is applied (because the GPU uses UV-based rotation that doesn't
/// change the texture buffer dimensions).
fn compute_crop_dimensions(
    crop: &CropQuad,
    src_w: usize,
    src_h: usize,
) -> (usize, usize) {
    let sw = src_w as f32;
    let sh = src_h as f32;

    // Top edge length in pixels
    let top_len = ((crop.tr.x - crop.tl.x) * sw).hypot((crop.tr.y - crop.tl.y) * sh);
    // Bottom edge length
    let bot_len = ((crop.br.x - crop.bl.x) * sw).hypot((crop.br.y - crop.bl.y) * sh);
    // Left edge length
    let left_len = ((crop.bl.x - crop.tl.x) * sw).hypot((crop.bl.y - crop.tl.y) * sh);
    // Right edge length
    let right_len = ((crop.br.x - crop.tr.x) * sw).hypot((crop.br.y - crop.tr.y) * sh);

    let out_w = ((top_len + bot_len) / 2.0).round().max(1.0) as usize;
    let out_h = ((left_len + right_len) / 2.0).round().max(1.0) as usize;

    (out_w, out_h)
}

/// Sample a pixel from the source image using bilinear interpolation.
/// `x` and `y` are in pixel coordinates (can be fractional).
#[inline]
fn sample_bilinear(src: &[f32], src_w: usize, src_h: usize, x: f32, y: f32) -> [f32; 3] {
    // Clamp to valid range
    let x = x.clamp(0.0, (src_w - 1) as f32);
    let y = y.clamp(0.0, (src_h - 1) as f32);

    let x0 = x.floor() as usize;
    let y0 = y.floor() as usize;
    let x1 = (x0 + 1).min(src_w - 1);
    let y1 = (y0 + 1).min(src_h - 1);

    let fx = x - x0 as f32;
    let fy = y - y0 as f32;

    // Get the four corner pixels
    let idx00 = (y0 * src_w + x0) * 3;
    let idx10 = (y0 * src_w + x1) * 3;
    let idx01 = (y1 * src_w + x0) * 3;
    let idx11 = (y1 * src_w + x1) * 3;

    let mut result = [0.0_f32; 3];
    for c in 0..3 {
        let p00 = src[idx00 + c];
        let p10 = src[idx10 + c];
        let p01 = src[idx01 + c];
        let p11 = src[idx11 + c];

        // Bilinear interpolation
        let top = p00 * (1.0 - fx) + p10 * fx;
        let bot = p01 * (1.0 - fx) + p11 * fx;
        result[c] = top * (1.0 - fy) + bot * fy;
    }

    result
}

/// Check if rotation results in a dimension swap (portrait↔landscape).
/// This is true when the nearest 90° step is an odd multiple (90°, 270°, etc.).
/// Fine rotation adjustments (±45°) don't change the swap state.
fn is_rotation_90_multiple(rotation: f32) -> bool {
    let nearest90 = (rotation / 90.0).round() as i32;
    // Odd multiples of 90° swap dimensions
    nearest90.rem_euclid(2) == 1
}

/// Apply transform (rotation, zoom, flips) and crop in a single pass.
///
/// The GPU pipeline works as follows:
/// 1. Transform shader rotates/zooms content via UV remapping
///    - When rotation is ±90°/±270°, the transform output has swapped dimensions
///    - Uses separate source/output aspect ratios for correct mapping
/// 2. Crop shader samples from the (visually transformed) buffer
///
/// So crop coordinates are normalized to the POST-ROTATION dimensions.
/// We need to:
/// 1. Determine post-rotation dimensions (swap w/h for 90°/270°)
/// 2. Compute crop output dimensions from those post-rotation dimensions
/// 3. For each output pixel, compute the crop quad sample position
/// 4. Apply inverse transform to map back to original source
///
/// Returns (output_width, output_height, result_pixels).
fn apply_transform_and_crop(
    src: &[f32],
    src_w: usize,
    src_h: usize,
    crop: &CropQuad,
    transform: &TransformParams,
) -> (usize, usize, Vec<f32>) {
    // Determine post-rotation dimensions
    let swap_dims = is_rotation_90_multiple(transform.rotation);
    let rot_w = if swap_dims { src_h } else { src_w };
    let rot_h = if swap_dims { src_w } else { src_h };

    // Output dimensions are computed from crop quad applied to POST-ROTATION dimensions
    let (out_w, out_h) = compute_crop_dimensions(crop, rot_w, rot_h);

    // Convert rotation from degrees to radians (matching GPU pipeline)
    let rotation_rad = transform.rotation * std::f32::consts::PI / 180.0;
    let cos_a = rotation_rad.cos();
    let sin_a = rotation_rad.sin();
    
    // Zoom factor (default to 1.0 if not set)
    let zoom = if transform.zoom > 0.0 { transform.zoom } else { 1.0 };
    
    // Aspect ratios matching the GPU shader
    let src_aspect = src_w as f32 / src_h as f32;
    let out_aspect = rot_w as f32 / rot_h as f32;

    let sw = src_w as f32;
    let sh = src_h as f32;

    let mut dst = vec![0.0_f32; out_w * out_h * 3];

    for out_y in 0..out_h {
        let v = out_y as f32 / (out_h - 1).max(1) as f32;

        for out_x in 0..out_w {
            let u = out_x as f32 / (out_w - 1).max(1) as f32;

            // Apply flips to the UV coordinates
            let u_flipped = if transform.flip_h { 1.0 - u } else { u };
            let v_flipped = if transform.flip_v { 1.0 - v } else { v };

            // Bilinear interpolation within the crop quad gives us a point in
            // the post-rotation normalized coordinate space [0,1]×[0,1].
            let top_x = crop.tl.x * (1.0 - u_flipped) + crop.tr.x * u_flipped;
            let top_y = crop.tl.y * (1.0 - u_flipped) + crop.tr.y * u_flipped;
            let bot_x = crop.bl.x * (1.0 - u_flipped) + crop.br.x * u_flipped;
            let bot_y = crop.bl.y * (1.0 - u_flipped) + crop.br.y * u_flipped;

            let crop_x = top_x * (1.0 - v_flipped) + bot_x * v_flipped;
            let crop_y = top_y * (1.0 - v_flipped) + bot_y * v_flipped;

            // Replicate the GPU transform shader logic:
            // 1. Center the UV
            // 2. Apply zoom
            // 3. Scale to physical space using output aspect
            // 4. Rotate
            // 5. Scale back to source UV using source aspect
            
            let centered_x = crop_x - 0.5;
            let centered_y = crop_y - 0.5;
            
            // Apply zoom
            let zoomed_x = centered_x / zoom;
            let zoomed_y = centered_y / zoom;
            
            // Scale to physical space using output aspect, rotate, scale back using source aspect
            let px = zoomed_x * out_aspect;
            let py = zoomed_y;
            
            let rx = px * cos_a - py * sin_a;
            let ry = px * sin_a + py * cos_a;
            
            let src_norm_x = (rx / src_aspect) + 0.5;
            let src_norm_y = ry + 0.5;

            // Convert normalized source coordinates to pixel coordinates
            let src_px_x = src_norm_x * sw;
            let src_px_y = src_norm_y * sh;

            let pixel = sample_bilinear(src, src_w, src_h, src_px_x, src_px_y);

            let dst_idx = (out_y * out_w + out_x) * 3;
            dst[dst_idx] = pixel[0];
            dst[dst_idx + 1] = pixel[1];
            dst[dst_idx + 2] = pixel[2];
        }
    }

    (out_w, out_h, dst)
}

/// Full-image "identity" crop quad — all corners at image boundaries.
fn full_image_crop() -> CropQuad {
    use crate::process::Point2D;
    CropQuad {
        tl: Point2D { x: 0.0, y: 0.0 },
        tr: Point2D { x: 1.0, y: 0.0 },
        br: Point2D { x: 1.0, y: 1.0 },
        bl: Point2D { x: 0.0, y: 1.0 },
    }
}

// ─── Downscaling helpers ──────────────────────────────────────────────────────

/// Downscale an f32 RGB image using bilinear interpolation.
/// This produces smoother results than nearest-neighbor for the
/// aggressive downscales (0.25x, 0.5x) used in export.
fn downscale_bilinear(
    src: &[f32],
    src_w: usize,
    src_h: usize,
    dst_w: usize,
    dst_h: usize,
) -> Vec<f32> {
    let mut dst = vec![0.0_f32; dst_w * dst_h * 3];

    let scale_x = src_w as f32 / dst_w as f32;
    let scale_y = src_h as f32 / dst_h as f32;

    for dst_y in 0..dst_h {
        // Map destination center to source coordinate
        let src_y = (dst_y as f32 + 0.5) * scale_y - 0.5;

        for dst_x in 0..dst_w {
            let src_x = (dst_x as f32 + 0.5) * scale_x - 0.5;
            let pixel = sample_bilinear(src, src_w, src_h, src_x, src_y);

            let dst_idx = (dst_y * dst_w + dst_x) * 3;
            dst[dst_idx] = pixel[0];
            dst[dst_idx + 1] = pixel[1];
            dst[dst_idx + 2] = pixel[2];
        }
    }

    dst
}

// ─── Ordered dithering helpers ────────────────────────────────────────────────

/// Compute an 8×8 Bayer matrix threshold for position (x, y).
/// Returns a value in [-0.5, +0.5] (one 8-bit step = 1/255).
#[inline(always)]
fn bayer_8x8(x: usize, y: usize) -> f32 {
    let xb = (x % 8) as u32;
    let yb = (y % 8) as u32;
    // Bit-interleaved Bayer value (0..63).
    let mut v = 0u32;
    v |= (xb ^ yb) & 1;
    v |= (((xb >> 1) ^ yb) & 1) << 1;
    v |= ((xb ^ (yb >> 1)) & 1) << 2;
    v |= (((xb >> 2) ^ yb) & 1) << 3;
    v |= ((xb ^ (yb >> 2)) & 1) << 4;
    v |= (((xb >> 1) ^ (yb >> 1)) & 1) << 5;
    (v as f32 / 63.0) - 0.5
}

/// Convert f32 [0,1] to u8 [0,255] with an ordered-dither offset.
/// `dither` is in [-0.5, +0.5] (Bayer matrix output).
#[inline(always)]
fn f32_to_u8_dithered(v: f32, dither: f32) -> u8 {
    ((v * 255.0 + dither).round()).clamp(0.0, 255.0) as u8
}

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
/// - `scale`       — output scale factor (0.25, 0.5, or 1.0). Defaults to 1.0 if omitted.
#[tauri::command]
pub async fn export_native(
    source_path: String,
    export_path: String,
    edit: EffectiveEdit,
    log_perc: Option<LogPercentiles>,
    skip_wb: Option<bool>,
    quality: u8,
    scale: Option<f32>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        inner_export_native(
            &source_path,
            &export_path,
            &edit,
            log_perc.as_ref(),
            skip_wb.unwrap_or(false),
            quality,
            scale.unwrap_or(1.0),
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
    scale: f32,
) -> Result<(), String> {
    // Validate scale factor — must be one of the supported values.
    let scale = if scale <= 0.0 || scale > 1.0 {
        1.0_f32
    } else {
        scale
    };
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

        eprintln!("DEBUG export: CFA {}x{}, pattern: {}", cfa_w, cfa_h, cfa.name);
        eprintln!("DEBUG export: sensor {}x{}, cpp={}", pw, ph, raw.cpp);
        
        if cfa_w == 2 && cfa_h == 2 {
            // Bayer 2×2 — AHD full-resolution demosaic.
            let result = crate::demosaic::demosaic_ahd(pixels, pw, ph, |r, c| cfa.color_at(r, c), norm_ch);
            eprintln!("DEBUG export: AHD output {}x{}", result.0, result.1);
            result
        } else if cfa_w == 6 && cfa_h == 6 {
            // X-Trans 6×6 — bilinear full-resolution demosaic.
            let result = crate::demosaic::demosaic_xtrans_bilinear(pixels, pw, ph, |r, c| cfa.color_at(r, c), norm_ch);
            eprintln!("DEBUG export: X-Trans bilinear output {}x{}", result.0, result.1);
            result
        } else {
            // Other exotic CFA — superpixel fallback (produces smaller but correct image).
            let result = crate::demosaic::demosaic_superpixel(
                pixels,
                pw,
                ph,
                cfa_w,
                cfa_h,
                |r, c| cfa.color_at(r, c),
                norm_ch,
            );
            eprintln!("DEBUG export: superpixel output {}x{}", result.0, result.1);
            result
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

    // ── Apply transform (rotation + flips) and crop in a single pass ─────────
    // This combined operation correctly handles the fact that crop coordinates
    // are defined in the visually-rotated space, matching the GPU pipeline.
    let crop = edit.crop_quad.as_ref().cloned().unwrap_or_else(full_image_crop);
    let (final_w, final_h, rgb_f32) = apply_transform_and_crop(
        &rgb_f32,
        final_w,
        final_h,
        &crop,
        &edit.transform,
    );

    // ── Downscale if scale < 1.0 ─────────────────────────────────────────────
    // Compute scaled dimensions, then use bilinear downsampling to reduce size.
    let (final_w, final_h, rgb_f32) = if scale < 1.0 {
        let scaled_w = ((final_w as f32 * scale).round() as usize).max(1);
        let scaled_h = ((final_h as f32 * scale).round() as usize).max(1);
        eprintln!(
            "DEBUG export: scaling {}x{} -> {}x{} (scale={})",
            final_w, final_h, scaled_w, scaled_h, scale
        );
        let downscaled = downscale_bilinear(&rgb_f32, final_w, final_h, scaled_w, scaled_h);
        (scaled_w, scaled_h, downscaled)
    } else {
        (final_w, final_h, rgb_f32)
    };

    // ── Convert f32 [0,1] sRGB → u8 [0,255] with ordered dithering ─────────
    // Uses an 8×8 Bayer matrix to break up banding in smooth gradients
    // (sky, skin tones, etc.) that would otherwise appear after quantization.
    let u8_data: Vec<u8> = rgb_f32
        .chunks(3)
        .enumerate()
        .flat_map(|(i, pixel)| {
            let x = i % final_w;
            let y = i / final_w;
            let dither = bayer_8x8(x, y);
            [
                f32_to_u8_dithered(pixel[0], dither),
                f32_to_u8_dithered(pixel[1], dither),
                f32_to_u8_dithered(pixel[2], dither),
            ]
        })
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
