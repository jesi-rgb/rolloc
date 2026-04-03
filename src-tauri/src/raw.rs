//! Camera RAW decoding commands.
//!
//! Two Tauri commands are exposed:
//!
//! ## `raw_thumb`
//! Fast path for thumbnail / preview generation from a RAW file.
//! Strategy (in order of preference):
//!   1. Extract the largest embedded JPEG preview stored in the RAW file
//!      (all modern RAW formats embed one; DNG typically embeds a full-res preview).
//!   2. If no embedded preview exists, fall back to a fast demosaic of the RAW
//!      sensor data and JPEG-encode the result.
//! Returns raw JPEG bytes (same contract as `generate_thumb` in thumb.rs).
//!
//! Both paths apply quick film-negative inversion (log percentile stretch +
//! sigmoid curve) to give a recognizable inverted preview.
//!
//! ## `raw_decode`
//! Full-quality decode for the editor pipeline.
//! Returns a compact binary payload:
//!   - 4-byte header: `width` (u32 LE), `height` (u32 LE)
//!   - then `width * height * 4 * 2` bytes of raw `rgba16` data (u16 LE, linear)
//!   - plus a JSON metadata trailer (colour matrix, WB coeffs, white/black levels)
//!     appended after the pixel data, prefixed with a 4-byte u32 LE length.
//!
//! The pixel layout is RGBX with 16-bit unsigned per channel (0–65535),
//! in linear camera-native colour space (no tone curve, no demosaic colour conversion).
//! The WebGPU pipeline ingests this as `rgba16uint` and processes it from there.
//!
//! ## Data flow (editor)
//!   RAW file → rawler decode → black/white level normalise → bilinear demosaic
//!     → rgba16 pixels over IPC → `rgba16uint` WebGPU texture → existing
//!     invert / colormatrix / tonecurve pipeline.

use std::fs::File;
use std::io::{BufReader, Cursor};
use std::path::Path;

use image::{imageops, imageops::FilterType, DynamicImage, ImageBuffer, Rgb};
use rawler::{
    decoders::RawDecodeParams,
    imgop::xyz::Illuminant,
    rawsource::RawSource,
    RawImage, RawImageData,
};
use serde::Serialize;
use tauri::ipc::Response;

use crate::thumb::apply_quick_inversion;

// ─── EXIF orientation ────────────────────────────────────────────────────────

/// Read the EXIF Orientation tag from a RAW/JPEG file using kamadak-exif.
/// Returns the tag value 1–8 (TIFF spec), defaulting to 1 (Normal) on any error.
pub fn read_exif_orientation(path: &str) -> u32 {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return 1,
    };
    let mut bufreader = BufReader::new(file);
    let exif = match exif::Reader::new().read_from_container(&mut bufreader) {
        Ok(e) => e,
        Err(_) => return 1,
    };
    exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)
        .and_then(|f| f.value.get_uint(0))
        .unwrap_or(1)
}

/// Apply EXIF orientation to a `DynamicImage` so pixels appear upright.
///
/// TIFF orientation values:
///   1 = Normal (no-op)
///   2 = Mirror horizontal
///   3 = Rotate 180
///   4 = Mirror vertical
///   5 = Transpose (mirror horizontal then rotate 270)
///   6 = Rotate 90 CW (camera held 90° CW → image is 90° CCW → rotate CW to fix)
///   7 = Transverse (mirror horizontal then rotate 90)
///   8 = Rotate 270 CW (camera held 90° CCW → rotate CCW to fix, i.e. 270 CW)
pub fn apply_orientation(img: DynamicImage, orientation: u32) -> DynamicImage {
    match orientation {
        2 => DynamicImage::from(imageops::flip_horizontal(&img)),
        3 => DynamicImage::from(imageops::rotate180(&img)),
        4 => DynamicImage::from(imageops::flip_vertical(&img)),
        5 => {
            let flipped = imageops::flip_horizontal(&img);
            DynamicImage::from(imageops::rotate270(&flipped))
        }
        6 => DynamicImage::from(imageops::rotate90(&img)),
        7 => {
            let flipped = imageops::flip_horizontal(&img);
            DynamicImage::from(imageops::rotate90(&flipped))
        }
        8 => DynamicImage::from(imageops::rotate270(&img)),
        _ => img, // 1 or unknown: no-op
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Encode an `image::DynamicImage` to JPEG bytes at `quality` (0–100).
fn encode_jpeg(img: DynamicImage, quality: u8) -> Result<Vec<u8>, String> {
    let mut buf = Cursor::new(Vec::with_capacity(256 * 1024));
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality);
    DynamicImage::from(img.to_rgb8())
        .write_with_encoder(encoder)
        .map_err(|e| format!("jpeg encode failed: {e}"))?;
    Ok(buf.into_inner())
}

/// Resize an `image::DynamicImage` to at most `max_px` on the long edge.
fn resize_to(img: DynamicImage, max_px: u32) -> DynamicImage {
    let (w, h) = (img.width(), img.height());
    if w <= max_px && h <= max_px {
        img
    } else {
        img.resize(max_px, max_px, FilterType::Triangle)
    }
}

// ─── Embedded-preview extraction ──────────────────────────────────────────────

/// Try to extract the largest embedded JPEG preview from the RAW file.
/// Returns the JPEG bytes decoded into a `DynamicImage`, or `None`.
fn extract_embedded_preview(path: &str) -> Option<DynamicImage> {
    let raw_source = RawSource::new(Path::new(path)).ok()?;
    let decoder = rawler::get_decoder(&raw_source).ok()?;
    let params = RawDecodeParams::default();

    // Try thumbnail first (usually smaller but faster), then full preview.
    // Both return Result<Option<DynamicImage>> — we want the largest available.
    if let Ok(Some(img)) = decoder.preview_image(&raw_source, &params) {
        return Some(img);
    }
    if let Ok(Some(img)) = decoder.thumbnail_image(&raw_source, &params) {
        return Some(img);
    }
    None
}

// ─── CFA-agnostic superpixel demosaic ────────────────────────────────────────

/// Convert a rawler-decoded CFA image to an RGB `DynamicImage` using a
/// superpixel (tile-average) method.
///
/// Works for any CFA tile size: 2×2 Bayer (RGGB etc.) *and* 6×6 Fujifilm
/// X-Trans.  Each output pixel is the average of all R, G, B samples within
/// one CFA tile, producing a downsampled image of size
/// `(w / cfa_w) × (h / cfa_h)`.  The result is good enough for thumbnails.
///
/// For already-demosaiced (cpp == 3) images, the caller should not call this.
fn demosaic_superpixel(raw: &RawImage) -> Result<DynamicImage, String> {
    let pixels = raw.pixels_u16();
    let w  = raw.width;
    let h  = raw.height;
    let cw = raw.camera.cfa.width;   // tile width  (2 for Bayer, 6 for X-Trans)
    let ch = raw.camera.cfa.height;  // tile height

    if pixels.len() < w * h {
        return Err(format!(
            "pixel buffer too small: got {}, expected {}",
            pixels.len(), w * h
        ));
    }

    let cfa    = &raw.camera.cfa;
    let blacks = raw.blacklevel.as_bayer_array(); // [f32; 4] in channel order
    let whites = raw.whitelevel.as_bayer_array();

    // Normalise a raw u16 value given the channel index (0=R, 1/3=G, 2=B).
    let norm = |ch: usize, v: u16| -> f32 {
        let i  = ch.min(3);
        let bl = blacks[i];
        let wl = whites[i];
        ((v as f32 - bl).max(0.0) / (wl - bl).max(1.0)).clamp(0.0, 1.0)
    };

    // Output dimensions (crop to complete tiles).
    let out_w = w / cw;
    let out_h = h / ch;

    let mut rgb: Vec<f32> = vec![0.0_f32; out_w * out_h * 3];

    for ty in 0..out_h {
        for tx in 0..out_w {
            let mut r_sum = 0.0_f32;
            let mut g_sum = 0.0_f32;
            let mut b_sum = 0.0_f32;
            let mut r_cnt = 0u32;
            let mut g_cnt = 0u32;
            let mut b_cnt = 0u32;

            for dy in 0..ch {
                for dx in 0..cw {
                    let py = ty * ch + dy;
                    let px = tx * cw + dx;
                    let v  = pixels[py * w + px];
                    // color_at(row, col)
                    match cfa.color_at(dy, dx) {
                        0 => { r_sum += norm(0, v); r_cnt += 1; }
                        2 => { b_sum += norm(2, v); b_cnt += 1; }
                        _ => { g_sum += norm(1, v); g_cnt += 1; }
                    }
                }
            }

            let r = if r_cnt > 0 { r_sum / r_cnt as f32 } else { 0.0 };
            let g = if g_cnt > 0 { g_sum / g_cnt as f32 } else { 0.0 };
            let b = if b_cnt > 0 { b_sum / b_cnt as f32 } else { 0.0 };

            let base = (ty * out_w + tx) * 3;
            // Apply gamma 2.2 for display.
            rgb[base]     = r.powf(1.0 / 2.2);
            rgb[base + 1] = g.powf(1.0 / 2.2);
            rgb[base + 2] = b.powf(1.0 / 2.2);
        }
    }

    let u8_data: Vec<u8> = rgb
        .iter()
        .map(|&v| (v * 255.0).round().clamp(0.0, 255.0) as u8)
        .collect();

    let img_buf: ImageBuffer<Rgb<u8>, Vec<u8>> =
        ImageBuffer::from_raw(out_w as u32, out_h as u32, u8_data)
            .ok_or_else(|| "failed to build image buffer".to_string())?;

    Ok(DynamicImage::ImageRgb8(img_buf))
}

// ─── apply_scaling wrapper that handles both integer and float data ────────────

/// Normalise raw pixel data to f32 0.0–1.0, producing a new flat Vec.
/// Works with both Integer (u16) and Float (f32) `RawImageData`.
/// Used by the full-res pipeline path (not yet wired up in JS).
#[allow(dead_code)]
fn raw_to_float(raw: &RawImage) -> Result<Vec<f32>, String> {
    match &raw.data {
        RawImageData::Integer(pixels) => {
            // as_bayer_array() → [f32; 4]; use index 0 as global black/white.
            let bl = raw.blacklevel.as_bayer_array()[0];
            let wl = raw.whitelevel.as_bayer_array()[0];
            let range = (wl - bl).max(1.0);
            Ok(pixels
                .iter()
                .map(|&p| ((p as f32 - bl) / range).clamp(0.0, 1.0))
                .collect())
        }
        RawImageData::Float(pixels) => {
            // Already normalised; clamp to be safe.
            Ok(pixels.iter().map(|&p| p.clamp(0.0, 1.0)).collect())
        }
    }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/// Fast thumbnail / preview for a RAW file.
///
/// Returns raw JPEG bytes — same binary contract as `generate_thumb`.
/// Applies quick film-negative inversion for recognizable preview.
#[tauri::command]
pub async fn raw_thumb(path: String, max_px: u32, quality: u8) -> Result<Response, String> {
    let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        // ── 1. Try embedded JPEG preview ────────────────────────────────────
        if let Some(preview_img) = extract_embedded_preview(&path) {
            let resized = resize_to(preview_img, max_px);
            // Apply quick inversion to the embedded preview
            let mut rgb = resized.to_rgb8();
            apply_quick_inversion(&mut rgb);
            return encode_jpeg(DynamicImage::from(rgb), quality);
        }

        // ── 2. Fall back: decode RAW and do a fast superpixel demosaic ──────
        let raw = rawler::decode_file(&path)
            .map_err(|e| format!("raw decode failed: {e}"))?;

        let rgb = if raw.cpp == 3 {
            // Already demosaiced (some DNGs) — convert directly.
            let pixels = raw.pixels_u16();
            let bl = raw.blacklevel.as_bayer_array()[0];
            let wl = raw.whitelevel.as_bayer_array()[0];
            let range = (wl - bl).max(1.0);
            let u8_data: Vec<u8> = pixels.iter().map(|&v| {
                let f = ((v as f32 - bl).max(0.0) / range).clamp(0.0, 1.0);
                (f.powf(1.0 / 2.2) * 255.0).round() as u8
            }).collect();
            let img_buf: ImageBuffer<Rgb<u8>, Vec<u8>> =
                ImageBuffer::from_raw(raw.width as u32, raw.height as u32, u8_data)
                    .ok_or_else(|| "failed to build image buffer".to_string())?;
            DynamicImage::ImageRgb8(img_buf)
        } else {
            demosaic_superpixel(&raw)?
        };
        let resized = resize_to(rgb, max_px);
        // Apply quick inversion to the demosaiced result
        let mut rgb_out = resized.to_rgb8();
        apply_quick_inversion(&mut rgb_out);
        encode_jpeg(DynamicImage::from(rgb_out), quality)
    })
    .await
    .map_err(|e| format!("task panicked: {e:?}"))??;

    Ok(Response::new(bytes))
}

// ─── Metadata returned alongside the pixel buffer ─────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawDecodeMetadata {
    pub width: u32,
    pub height: u32,
    /// Camera make (e.g. "FUJIFILM").
    pub make: String,
    /// Camera model (e.g. "X-T4").
    pub model: String,
    /// As-shot white balance coefficients [R, G, B, (E)] from the RAW file.
    /// Normalised so that G = 1.0.
    pub wb_coeffs: [f32; 4],
    /// Camera → XYZ D50 colour matrix (row-major 3×3, row = [XYZ out], col = [RGB in]).
    /// This is the matrix the GPU pipeline needs for `cameraColorMatrix`.
    /// Derived from rawler's `xyz_to_cam` (inverted) at the D50 illuminant.
    pub color_matrix: [f32; 9],
    /// Illuminant temperature used to select the colour matrix (Kelvin).
    pub illuminant_temp: f32,
    /// Bits per sample of the original sensor data.
    pub bps: u32,
}

/// Full linear decode of a RAW file for the editor pipeline.
///
/// Binary response layout:
///   [0..4]   width  : u32 LE
///   [4..8]   height : u32 LE
///   [8..]    RGBA pixels: width * height * 4 channels * 2 bytes each (u16 LE, linear 0–65535)
///   After pixels:
///   [N..N+4] metadata JSON byte length : u32 LE
///   [N+4..]  metadata JSON (UTF-8)
///
/// The pixel data is in camera-native linear colour (bilinear demosaic applied).
/// The GPU ingest shader treats it as `rgba16uint` and processes it from there.
///
/// If `max_px` is Some(n), the output is downsampled so that neither dimension
/// exceeds `n` pixels.  Pass the device's `maxTextureDimension2D` limit here.
#[tauri::command]
pub async fn raw_decode(path: String, max_px: Option<u32>, skip_wb: Option<bool>) -> Result<Response, String> {
    let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        // ── Decode ──────────────────────────────────────────────────────────
        let raw = rawler::decode_file(&path)
            .map_err(|e| format!("raw decode failed: {e}"))?;

        let pw = raw.width;
        let ph = raw.height;

        let pixels = raw.pixels_u16();

        // as_bayer_array() → [f32; 4] in RGGB order.
        let blacks = raw.blacklevel.as_bayer_array();
        let whites = raw.whitelevel.as_bayer_array();

        // ── As-shot white balance in sensor/CFA space ────────────────────────
        // When skip_wb is true (film inversion pipeline), apply no WB — the
        // per-channel log-percentile normalization handles orange mask removal
        // from the raw unbalanced sensor data (matching negpy's approach:
        // use_camera_wb=False, user_wb=[1,1,1,1]).
        //
        // When skip_wb is false (positive/slide pipeline), apply WB multipliers
        // to raw pixel values before black/white level normalisation.  This is
        // the correct place — equivalent to how libraw applies cam_mul internally
        // before demosaic.
        let do_skip_wb = skip_wb.unwrap_or(false);
        let wb_raw = raw.wb_coeffs;
        let wb_g = if wb_raw[1].is_finite() && wb_raw[1] > 0.001 { wb_raw[1] } else { 1.0_f32 };
        let wb_r = if do_skip_wb { 1.0_f32 } else if wb_raw[0].is_finite() && wb_raw[0] > 0.001 { wb_raw[0] / wb_g } else { 1.0_f32 };
        let wb_b = if do_skip_wb { 1.0_f32 } else if wb_raw[2].is_finite() && wb_raw[2] > 0.001 { wb_raw[2] / wb_g } else { 1.0_f32 };
        // channel index → WB multiplier: 0=R, 1/3=G (=1.0), 2=B
        let wb_for_ch = |ch: usize| -> f32 {
            match ch {
                0 => wb_r,
                2 => wb_b,
                _ => 1.0_f32,
            }
        };

        // Build linear u16 RGBA pixel buffer (A = 65535 throughout).
        // Strategy: superpixel demosaic — one output pixel per CFA tile,
        // averaging all R, G, B samples within each tile.  When max_px is set
        // and the tile grid is larger than the limit, we stride over tiles so
        // the output is at most max_px on the long edge.  This means demosaic
        // and downscale happen in a single pass — O(out_w × out_h × tile_w × tile_h)
        // instead of O(full_res × tile²), which is critical for large sensors.
        //
        // For Bayer (2×2) the tile has 1R + 2G + 1B sample.
        // For Fujifilm X-Trans (6×6) the tile has 2R + 8G + 2B … (mixed pattern).
        // Either way: average all same-color samples in the tile → RGB.

        // ── Normalise helper (black-subtracted, WB-scaled, clamped 0–65535) ──
        let norm_ch = |ch: usize, v: f32| -> f32 {
            let bl = blacks[ch.min(3)];
            let wl = whites[ch.min(3)];
            let norm = (v - bl).max(0.0) / (wl - bl).max(1.0);
            (norm * wb_for_ch(ch)).clamp(0.0, 1.0)
        };
        let pf = |yy: usize, xx: usize| pixels[yy * pw + xx] as f32;

        let (out_w, out_h, rgba) = if raw.cpp == 3 {
            // ── Already-demosaiced RGB (some DNGs) ───────────────────────────
            let bl = blacks[0];
            let wl = whites[0];
            let range = (wl - bl).max(1.0);
            // Optionally stride for downscale.
            let stride = if let Some(limit) = max_px {
                let limit = limit as usize;
                ((pw.max(ph) + limit - 1) / limit).max(1)
            } else { 1 };
            let ow = (pw + stride - 1) / stride;
            let oh = (ph + stride - 1) / stride;
            let mut buf = vec![0u16; ow * oh * 4];
            for oy in 0..oh {
                for ox in 0..ow {
                    let sy = (oy * stride).min(ph - 1);
                    let sx = (ox * stride).min(pw - 1);
                    let i = sy * pw + sx;
                    let r = (((pixels[i * 3]     as f32 - bl).max(0.0) / range) * wb_for_ch(0) * 65535.0).min(65535.0) as u16;
                    let g = (((pixels[i * 3 + 1] as f32 - bl).max(0.0) / range) * wb_for_ch(1) * 65535.0).min(65535.0) as u16;
                    let b = (((pixels[i * 3 + 2] as f32 - bl).max(0.0) / range) * wb_for_ch(2) * 65535.0).min(65535.0) as u16;
                    let base = (oy * ow + ox) * 4;
                    buf[base]     = r;
                    buf[base + 1] = g;
                    buf[base + 2] = b;
                    buf[base + 3] = 65535;
                }
            }
            (ow, oh, buf)
        } else {
            // ── CFA demosaic — superpixel per tile ───────────────────────────
            let cfa   = &raw.camera.cfa;
            let cfa_w = cfa.width;
            let cfa_h = cfa.height;

            // Number of complete CFA tiles in each axis.
            let tiles_x = pw / cfa_w;
            let tiles_y = ph / cfa_h;

            // Stride in tile units to respect max_px.
            let tile_stride = if let Some(limit) = max_px {
                let limit = limit as usize;
                ((tiles_x.max(tiles_y) + limit - 1) / limit).max(1)
            } else { 1 };

            let ow = (tiles_x + tile_stride - 1) / tile_stride;
            let oh = (tiles_y + tile_stride - 1) / tile_stride;

            let mut buf = vec![0u16; ow * oh * 4];

            for oty in 0..oh {
                for otx in 0..ow {
                    // Source tile origin in CFA pixel coordinates.
                    let ty = (oty * tile_stride).min(tiles_y - 1);
                    let tx = (otx * tile_stride).min(tiles_x - 1);
                    let origin_y = ty * cfa_h;
                    let origin_x = tx * cfa_w;

                    let mut r_sum = 0.0_f32; let mut r_cnt = 0u32;
                    let mut g_sum = 0.0_f32; let mut g_cnt = 0u32;
                    let mut b_sum = 0.0_f32; let mut b_cnt = 0u32;

                    for dy in 0..cfa_h {
                        for dx in 0..cfa_w {
                            let py = origin_y + dy;
                            let px = origin_x + dx;
                            let c = cfa.color_at(dy, dx); // position within tile
                            let v = norm_ch(c, pf(py, px));
                            match c {
                                0 => { r_sum += v; r_cnt += 1; }
                                2 => { b_sum += v; b_cnt += 1; }
                                _ => { g_sum += v; g_cnt += 1; }
                            }
                        }
                    }

                    let r = if r_cnt > 0 { r_sum / r_cnt as f32 } else { 0.0 };
                    let g = if g_cnt > 0 { g_sum / g_cnt as f32 } else { 0.0 };
                    let b = if b_cnt > 0 { b_sum / b_cnt as f32 } else { 0.0 };

                    let base = (oty * ow + otx) * 4;
                    buf[base]     = (r * 65535.0) as u16;
                    buf[base + 1] = (g * 65535.0) as u16;
                    buf[base + 2] = (b * 65535.0) as u16;
                    buf[base + 3] = 65535;
                }
            }
            (ow, oh, buf)
        };

        // Alias for the rest of the function (orientation, metadata packing).
        let pw = out_w;
        let ph = out_h;

        // ── EXIF orientation ─────────────────────────────────────────────────
        // rawler hardcodes orientation to Normal (TODO in their source), so we
        // read it ourselves via kamadak-exif and rotate the pixel buffer here.
        // This ensures portrait RAF/DNG files appear upright in the editor.
        let orientation = read_exif_orientation(&path);
        let (w, h, rgba) = if orientation != 1 && orientation != 0 {
            // Build Rgb<u16> image, apply orientation, re-pack.
            let rgb16: Vec<u16> = rgba
                .chunks_exact(4)
                .flat_map(|px| [px[0], px[1], px[2]])
                .collect();
            let img_buf: ImageBuffer<image::Rgb<u16>, Vec<u16>> =
                ImageBuffer::from_raw(pw as u32, ph as u32, rgb16)
                    .ok_or_else(|| "failed to build u16 image for rotation".to_string())?;
            let rotated = apply_orientation(DynamicImage::ImageRgb16(img_buf), orientation);
            let rgb_rot = rotated.to_rgb16();
            let rw = rgb_rot.width();
            let rh = rgb_rot.height();
            let rgba_rot: Vec<u16> = rgb_rot
                .as_raw()
                .chunks_exact(3)
                .flat_map(|px| [px[0], px[1], px[2], 65535u16])
                .collect();
            (rw, rh, rgba_rot)
        } else {
            (pw as u32, ph as u32, rgba)
        };

        // ── Colour matrix ───────────────────────────────────────────────────
        // cam_to_xyz_normalized() → [[f32;4];3] (cam→XYZ D65, row=XYZ, col=cam).
        // The GPU shader expects cam→linear-sRGB.
        // cam_to_sRGB = XYZ_D65_to_sRGB × cam_to_xyz
        //
        // XYZ D65 → linear sRGB (IEC 61966-2-1):
        #[rustfmt::skip]
        const XYZ_TO_SRGB: [[f32; 3]; 3] = [
            [ 3.2406, -1.5372, -0.4986],
            [-0.9689,  1.8758,  0.0415],
            [ 0.0557, -0.2040,  1.0570],
        ];

        let cam_to_xyz = raw.cam_to_xyz_normalized();

        // Multiply: cam_to_sRGB[r][c] = sum_k XYZ_TO_SRGB[r][k] * cam_to_xyz[k][c]
        // cam_to_xyz is [[f32;4];3]: rows = XYZ (3), cols = cam (4, last unused)
        // XYZ_TO_SRGB is 3×3: rows = sRGB, cols = XYZ
        // Result: 3 rows (sRGB) × 3 cols (cam)
        let mut cam_to_srgb = [[0.0f32; 3]; 3];
        for r in 0..3 {
            for c in 0..3 {
                for k in 0..3 {
                    cam_to_srgb[r][c] += XYZ_TO_SRGB[r][k] * cam_to_xyz[k][c];
                }
            }
        }

        #[rustfmt::skip]
        let color_matrix_raw: [f32; 9] = [
            cam_to_srgb[0][0], cam_to_srgb[0][1], cam_to_srgb[0][2],
            cam_to_srgb[1][0], cam_to_srgb[1][1], cam_to_srgb[1][2],
            cam_to_srgb[2][0], cam_to_srgb[2][1], cam_to_srgb[2][2],
        ];

        // Sanitise: replace any NaN/Inf with 0.0.  If all nine values are
        // non-finite (rawler has no colour matrix for this camera model), fall
        // back to the identity so the GPU shader receives a valid matrix.
        let any_finite = color_matrix_raw.iter().any(|v| v.is_finite());
        #[rustfmt::skip]
        let color_matrix: [f32; 9] = if any_finite {
            color_matrix_raw.map(|v| if v.is_finite() { v } else { 0.0 })
        } else {
            [1.0, 0.0, 0.0,
             0.0, 1.0, 0.0,
             0.0, 0.0, 1.0]
        };

        // ── WB coefficients ─────────────────────────────────────────────────
        // Normalise so G (index 1) = 1.0.
        // wb[3] is the infrared/E channel — NaN on most cameras; replace with 1.0
        // (identity) because it is not used by the GPU pipeline.
        // serde_json serialises f32::NAN as JSON null which breaks the JS side.
        let wb = raw.wb_coeffs;
        let g_norm = if wb[1].is_finite() && wb[1] > 0.001 { wb[1] } else { 1.0 };
        let wb_norm = [
            if wb[0].is_finite() { wb[0] / g_norm } else { 1.0_f32 },
            1.0_f32,
            if wb[2].is_finite() { wb[2] / g_norm } else { 1.0_f32 },
            if wb[3].is_finite() { wb[3] / g_norm } else { 1.0_f32 },
        ];

        // Choose illuminant temp: prefer D55 (daylight), fall back to whatever.
        let illuminant_temp = if raw.color_matrix.contains_key(&Illuminant::D55) {
            5500.0_f32
        } else if raw.color_matrix.contains_key(&Illuminant::D65) {
            6500.0_f32
        } else {
            5500.0_f32
        };

        // ── Metadata struct ──────────────────────────────────────────────────
        let meta = RawDecodeMetadata {
            width:  w,
            height: h,
            make:   raw.clean_make.clone(),
            model:  raw.clean_model.clone(),
            wb_coeffs: wb_norm,
            color_matrix,
            illuminant_temp,
            bps: raw.bps as u32,
        };
        let meta_json = serde_json::to_vec(&meta)
            .map_err(|e| format!("meta serialise failed: {e}"))?;

        // ── Pack binary response ─────────────────────────────────────────────
        // Layout:
        //   [0..4]   width  u32 LE
        //   [4..8]   height u32 LE
        //   [8 .. 8 + w*h*8]  RGBA u16 LE  (4 channels × 2 bytes)
        //   [8+pixels .. +4]  meta JSON byte length u32 LE
        //   [.. ]             meta JSON UTF-8
        let pixel_bytes = rgba.len() * 2;
        let mut out = Vec::with_capacity(8 + pixel_bytes + 4 + meta_json.len());

        out.extend_from_slice(&w.to_le_bytes());
        out.extend_from_slice(&h.to_le_bytes());

        // RGBA u16 → bytes (LE)
        for v in &rgba {
            out.extend_from_slice(&v.to_le_bytes());
        }

        // Meta JSON length + JSON
        out.extend_from_slice(&(meta_json.len() as u32).to_le_bytes());
        out.extend_from_slice(&meta_json);

        Ok(out)
    })
    .await
    .map_err(|e| format!("task panicked: {e:?}"))??;

    Ok(Response::new(bytes))
}
