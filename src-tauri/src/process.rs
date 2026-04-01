//! CPU-side image processing pipeline for native-resolution export.
//!
//! Ports the WebGPU shader math to Rust so we can process images end-to-end
//! in f32 precision without any GPU texture size limits or 8-bit quantization.
//!
//! Two pipeline configurations (mirroring pipeline.ts):
//!
//! **Negative path** (invert = true):
//!   1. Log normalization — log10 per-channel percentile stretch on camera-native data
//!      (removes orange mask, inverts; per-channel stretch handles color separation)
//!   2. H&D curve — sigmoid paper response with CMY timing, toe/shoulder
//!   3. CLAHE — contrast limited adaptive histogram equalization (local contrast)
//!   4. Tone curve — WB multipliers + RGB LUTs + global tone LUT (sRGB skipped, H&D already 1/2.2)
//!
//!   No color matrix in the negative path: the per-channel log normalization already
//!   handles color separation. Applying cam→sRGB after H&D causes a magenta tint
//!   because the matrix expects linear camera-native values, not post-processed data.
//!
//! **Positive path** (invert = false):
//!   1. Normalize/invert — black/white point + exposure compensation
//!   2. Color matrix — cam-native → linear sRGB
//!   3. Tone curve — WB multipliers + RGB LUTs + global tone LUT + sRGB gamma encode

use rayon::prelude::*;

// ─── NegPy constants (must match pipeline.ts) ─────────────────────────────────

const CMY_MAX_DENSITY: f32 = 0.15;
const DENSITY_MULTIPLIER: f32 = 0.15;
const GRADE_MULTIPLIER: f32 = 1.75;
const D_MAX: f32 = 4.0;

/// Default analysis buffer — crops this fraction of each edge before
/// computing log percentiles (matches NegPy's analysis_buffer = 0.07).
const ANALYSIS_BUFFER: f32 = 0.10;

// ─── Types (deserialized from JS) ─────────────────────────────────────────────

/// A 2D point with normalized coordinates (0–1 relative to image dimensions).
#[derive(serde::Deserialize, Debug, Clone, Copy)]
pub struct Point2D {
    pub x: f32,
    pub y: f32,
}

/// Quadrilateral crop defined by four corner points.
/// Points are normalized (0–1) relative to image dimensions.
#[derive(serde::Deserialize, Debug, Clone, Copy)]
pub struct CropQuad {
    pub tl: Point2D,
    pub tr: Point2D,
    pub br: Point2D,
    pub bl: Point2D,
}

/// Mirrors `EffectiveEdit` from types.ts — the fully resolved edit parameters.
#[derive(serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveEdit {
    pub camera_color_matrix: [f32; 9],
    #[serde(rename = "ashotWBCoeffs")]
    #[allow(dead_code)]
    pub ashot_wb_coeffs: [f32; 3],
    #[allow(dead_code)]
    pub light_source_temp: f32,
    pub exposure_compensation: f32,
    pub white_balance: WhiteBalance,
    pub tone_curve: CurvePoints,
    pub rgb_curves: [CurvePoints; 3],
    pub invert: bool,
    pub inversion_params: InversionParams,
    /// Not used in export processing but present in the type.
    #[serde(default)]
    #[allow(dead_code)]
    pub rebate_region: Option<serde_json::Value>,
    /// Quadrilateral crop with perspective correction.
    /// When None, no crop is applied (full image).
    #[serde(default)]
    pub crop_quad: Option<CropQuad>,
}

#[derive(serde::Deserialize, Debug, Clone)]
pub struct WhiteBalance {
    pub temperature: f32,
    pub tint: f32,
}

#[derive(serde::Deserialize, Debug, Clone)]
pub struct CurvePoints {
    pub points: Vec<CurvePoint>,
}

#[derive(serde::Deserialize, Debug, Clone, Copy)]
pub struct CurvePoint {
    pub x: f32,
    pub y: f32,
}

#[derive(serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InversionParams {
    pub density: f32,
    pub grade: f32,
    pub cmy_cyan: f32,
    pub cmy_magenta: f32,
    pub cmy_yellow: f32,
    pub shadow_cyan: f32,
    pub shadow_magenta: f32,
    pub shadow_yellow: f32,
    pub highlight_cyan: f32,
    pub highlight_magenta: f32,
    pub highlight_yellow: f32,
    pub shadows: f32,
    pub highlights: f32,
    pub toe: f32,
    pub toe_width: f32,
    #[allow(dead_code)] // Present in TS type but not yet used in processing
    pub toe_hardness: f32,
    pub shoulder: f32,
    pub shoulder_width: f32,
    #[allow(dead_code)] // Present in TS type but not yet used in processing
    pub shoulder_hardness: f32,
    /// CLAHE blend strength [0,1]. 0 = off, 0.25 = negpy default.
    pub clahe_strength: f32,
    /// Film type: "C41" (color negative), "BW" (black & white), "E6" (slide).
    pub film_type: String,
    /// E6 normalize mode — not used in CPU processing yet.
    #[allow(dead_code)]
    #[serde(default)]
    pub e6_normalize: bool,
}

/// Per-channel log-density percentiles for the normalization pass.
#[derive(serde::Deserialize, Debug, Clone)]
pub struct LogPercentiles {
    pub floors: [f32; 3],
    pub ceils: [f32; 3],
}

// ─── Curve LUT building (Fritsch–Carlson monotone cubic) ──────────────────────

const LUT_SIZE: usize = 256;

/// Evaluate monotone cubic Hermite basis at parameter t ∈ [0, 1].
fn hermite(t: f32, y0: f32, y1: f32, m0: f32, m1: f32) -> f32 {
    let t2 = t * t;
    let t3 = t2 * t;
    (2.0 * t3 - 3.0 * t2 + 1.0) * y0
        + (t3 - 2.0 * t2 + t) * m0
        + (-2.0 * t3 + 3.0 * t2) * y1
        + (t3 - t2) * m1
}

/// Build a 256-entry LUT from curve control points.
fn build_lut(curve: &CurvePoints) -> [f32; LUT_SIZE] {
    let mut pts: Vec<CurvePoint> = curve.points.clone();
    pts.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal));
    let n = pts.len();
    let mut lut = [0.0_f32; LUT_SIZE];

    if n < 2 {
        for i in 0..LUT_SIZE {
            lut[i] = i as f32 / (LUT_SIZE as f32 - 1.0);
        }
        return lut;
    }

    // Secant slopes
    let mut delta = vec![0.0_f32; n - 1];
    for k in 0..n - 1 {
        let dx = pts[k + 1].x - pts[k].x;
        delta[k] = if dx == 0.0 {
            0.0
        } else {
            (pts[k + 1].y - pts[k].y) / dx
        };
    }

    // Initial tangents
    let mut m = vec![0.0_f32; n];
    m[0] = delta[0];
    m[n - 1] = delta[n - 2];
    for k in 1..n - 1 {
        m[k] = (delta[k - 1] + delta[k]) / 2.0;
    }

    // Monotonicity fix-up
    for k in 0..n - 1 {
        if delta[k].abs() < 1e-10 {
            m[k] = 0.0;
            m[k + 1] = 0.0;
        } else {
            let alpha = m[k] / delta[k];
            let beta = m[k + 1] / delta[k];
            let mag = (alpha * alpha + beta * beta).sqrt();
            if mag > 3.0 {
                m[k] = (3.0 * alpha / mag) * delta[k];
                m[k + 1] = (3.0 * beta / mag) * delta[k];
            }
        }
    }

    // Fill LUT
    for i in 0..LUT_SIZE {
        let x = i as f32 / (LUT_SIZE as f32 - 1.0);

        if x <= pts[0].x {
            lut[i] = pts[0].y.clamp(0.0, 1.0);
            continue;
        }
        if x >= pts[n - 1].x {
            lut[i] = pts[n - 1].y.clamp(0.0, 1.0);
            continue;
        }

        // Find segment
        let mut seg = 0;
        for k in 0..n - 1 {
            if x <= pts[k + 1].x {
                seg = k;
                break;
            }
        }

        let dx = pts[seg + 1].x - pts[seg].x;
        let t = if dx == 0.0 {
            0.0
        } else {
            (x - pts[seg].x) / dx
        };

        let val = hermite(t, pts[seg].y, pts[seg + 1].y, m[seg] * dx, m[seg + 1] * dx);
        lut[i] = val.clamp(0.0, 1.0);
    }

    lut
}

/// Look up a value in a 256-entry LUT with linear interpolation.
/// Matches the GPU tonecurve shader's interpolated LUT lookup.
#[inline(always)]
fn lut_lookup(lut: &[f32; LUT_SIZE], v: f32) -> f32 {
    let pos = v * (LUT_SIZE as f32 - 1.0);
    let lo = (pos as usize).min(LUT_SIZE - 1);
    let hi = (lo + 1).min(LUT_SIZE - 1);
    let frac = pos - lo as f32;
    lut[lo] + (lut[hi] - lut[lo]) * frac
}

// ─── White balance (temperature + tint → multipliers) ─────────────────────────

/// Convert colour temperature (K) + tint to per-channel [R, G, B] multipliers.
/// Matches the Kang et al. (2002) polynomial fit in pipeline.ts.
fn temperature_to_multipliers(temperature: f32, tint: f32) -> [f32; 3] {
    let t = temperature.clamp(1000.0, 20000.0);

    let x = if t <= 4000.0 {
        -0.2661239e9 / (t * t * t) - 0.2343589e6 / (t * t) + 0.8776956e3 / t + 0.179910
    } else {
        -3.0258469e9 / (t * t * t) + 2.1070379e6 / (t * t) + 0.2226347e3 / t + 0.240390
    };

    let y = if x < 0.182 {
        -1.1063814 * x * x * x - 1.34811020 * x * x + 2.18555832 * x - 0.20219683
    } else {
        -0.9549476 * x * x * x - 1.37418593 * x * x + 2.09137015 * x - 0.16748867
    };

    // xy → XYZ (Y=1)
    let big_y = 1.0_f32;
    let big_x = (big_y / y) * x;
    let big_z = (big_y / y) * (1.0 - x - y);

    // XYZ D65 → linear sRGB
    let r = 3.2406 * big_x - 1.5372 * big_y - 0.4986 * big_z;
    let g = -0.9689 * big_x + 1.8758 * big_y + 0.0415 * big_z;
    let b = 0.0557 * big_x - 0.2040 * big_y + 1.0570 * big_z;

    let g_norm = if g > 0.0 { g } else { 1.0 };
    let tint_factor = 2.0_f32.powf(tint / 100.0);

    [
        (r / g_norm).max(0.01),
        (1.0 / tint_factor).max(0.01),
        (b / g_norm).max(0.01),
    ]
}

// ─── sRGB gamma ───────────────────────────────────────────────────────────────

/// Linear → sRGB gamma encode.
#[inline(always)]
fn linear_to_srgb(c: f32) -> f32 {
    if c <= 0.0031308 {
        c * 12.92
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    }
}

// ─── Log percentile computation ───────────────────────────────────────────────

/// Compute per-channel log10 percentiles from linear f32 RGB pixels.
///
/// Floor computation matches negpy: find the 0.001th percentile of the mean
/// luminance, select pixels at or below that threshold, and average their
/// per-channel log values.  Ceils use the 99.999th per-channel percentile.
///
/// `pixels` is a flat slice of [R, G, B, R, G, B, ...] f32 values in [0, 1].
/// `color_matrix` — optional row-major 3×3 camera→sRGB matrix applied before log.
pub fn compute_log_percentiles(
    pixels: &[f32],
    width: usize,
    height: usize,
    color_matrix: Option<&[f32; 9]>,
) -> LogPercentiles {
    let log10_e: f32 = std::f32::consts::LOG10_E;
    let eps: f32 = 1e-6;
    let stride = 8_usize;

    let cut_y = (height as f32 * ANALYSIS_BUFFER).floor() as usize;
    let cut_x = (width as f32 * ANALYSIS_BUFFER).floor() as usize;
    let start_y = cut_y;
    let end_y = height - cut_y;
    let start_x = cut_x;
    let end_x = width - cut_x;

    let mut r_log = Vec::new();
    let mut g_log = Vec::new();
    let mut b_log = Vec::new();
    let mut mean_log = Vec::new();

    let mut y = start_y;
    while y < end_y {
        let mut x = start_x;
        while x < end_x {
            let i = (y * width + x) * 3;
            let mut r = pixels[i];
            let mut g = pixels[i + 1];
            let mut b = pixels[i + 2];

            // Apply color matrix before log transform (matches GPU pipeline order).
            if let Some(m) = color_matrix {
                let cr = (m[0] * r + m[1] * g + m[2] * b).max(0.0);
                let cg = (m[3] * r + m[4] * g + m[5] * b).max(0.0);
                let cb = (m[6] * r + m[7] * g + m[8] * b).max(0.0);
                r = cr;
                g = cg;
                b = cb;
            }

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

// ─── Normalization pass (negative path, step 1) ──────────────────────────────

/// Apply log10 normalization per-channel: maps [floor, ceil] → [0, 1].
/// This simultaneously inverts the negative and removes the orange mask.
fn normalize_pixel(r: f32, g: f32, b: f32, perc: &LogPercentiles) -> [f32; 3] {
    let eps: f32 = 1e-6;
    let log10_e: f32 = std::f32::consts::LOG10_E;

    let lr = r.max(eps).ln() * log10_e;
    let lg = g.max(eps).ln() * log10_e;
    let lb = b.max(eps).ln() * log10_e;

    let floors = perc.floors;
    let ceils = perc.ceils;

    let safe_delta = |d: f32| -> f32 {
        let abs_d = d.abs().max(eps);
        d.signum() * abs_d
    };

    [
        ((lr - floors[0]) / safe_delta(ceils[0] - floors[0])).clamp(0.0, 1.0),
        ((lg - floors[1]) / safe_delta(ceils[1] - floors[1])).clamp(0.0, 1.0),
        ((lb - floors[2]) / safe_delta(ceils[2] - floors[2])).clamp(0.0, 1.0),
    ]
}

// ─── H&D curve pass (negative path, step 2) ──────────────────────────────────

/// Numerically stable logistic sigmoid.
#[inline(always)]
fn fast_sigmoid(x: f32) -> f32 {
    if x >= 0.0 {
        1.0 / (1.0 + (-x).exp())
    } else {
        let z = x.exp();
        z / (1.0 + z)
    }
}

/// Process one channel through the full H&D pipeline.
/// Returns gamma-encoded (1/2.2) transmittance in [0, 1].
///
/// Core H&D math matches negpy's _apply_photometric_fused_kernel.
/// shadows/highlights are Rolloc extensions: global density level controls
/// that use the toe/shoulder sigmoid masks to target shadow/highlight regions.
#[inline(always)]
fn hd_channel(
    pixel: f32,
    pivot: f32,
    slope: f32,
    cmy_offset: f32,
    shadow_cmy: f32,
    hi_cmy: f32,
    toe: f32,
    toe_width: f32,
    shoulder: f32,
    sh_width: f32,
    shadows: f32,
    highlights: f32,
    d_max: f32,
) -> f32 {
    let eps = 1e-6_f32;

    // 1. Global CMY shift
    let val = pixel + cmy_offset;
    let diff = val - pivot;

    // 2. Toe mask (shadows): active at high diff (dense in negative space)
    // negpy: toe_width * (diff / max(1.0 - pivot, eps) - 0.5)
    let t_val = toe_width * (diff / (1.0 - pivot).max(eps) - 0.5);
    let toe_mask = fast_sigmoid(t_val);

    // 3. Shoulder mask (highlights): active at low diff (thin in negative space)
    // negpy: -shoulder_width * (diff / max(pivot, eps) + 0.5)
    let s_val = -sh_width * (diff / pivot.max(eps) + 0.5);
    let shoulder_mask = fast_sigmoid(s_val);

    // 4. Density offsets (multiplier 0.1 matches negpy)
    let toe_density_offset = toe * toe_mask * 0.1;
    let shoulder_density_offset = shoulder * shoulder_mask * 0.1;

    // 5. Localized CMY color shifts via toe/shoulder masks
    let shadow_color_offset = shadow_cmy * toe_mask;
    let highlight_color_offset = hi_cmy * shoulder_mask;

    // 5b. Shadows/Highlights global density level controls (Rolloc extension).
    //     Uses the same sigmoid masks as toe/shoulder to target the same regions.
    let shadow_level_offset = shadows * toe_mask * 0.1;
    let highlight_level_offset = highlights * shoulder_mask * 0.1;

    // 6. Adjusted diff (negpy sign convention + Rolloc shadows/highlights extension)
    let diff_adj = diff + shadow_color_offset + highlight_color_offset - toe_density_offset
        + shoulder_density_offset
        - shadow_level_offset
        + highlight_level_offset;

    // 7. Contrast damping (toe/shoulder reduce effective contrast)
    let damp_toe = toe * toe_mask * 0.5;
    let damp_shoulder = shoulder * shoulder_mask * 0.5;
    let k_mod = (1.0 - damp_toe - damp_shoulder).clamp(0.1, 2.0);

    // 8. H&D sigmoid → print density
    let density = d_max * fast_sigmoid(slope * diff_adj * k_mod);

    // 9. Density → transmittance → perceptual gamma (1/2.2)
    let transmittance = 10.0_f32.powf(-density);
    transmittance.max(0.0).powf(1.0 / 2.2).clamp(0.0, 1.0)
}

/// Derived H&D parameters pre-computed from InversionParams.
struct HDParams {
    pivot: f32,
    slope: f32,
    cmy_r: f32,
    cmy_g: f32,
    cmy_b: f32,
    s_cmy_r: f32,
    s_cmy_g: f32,
    s_cmy_b: f32,
    h_cmy_r: f32,
    h_cmy_g: f32,
    h_cmy_b: f32,
    toe: f32,
    toe_width: f32,
    shoulder: f32,
    shoulder_width: f32,
    shadows: f32,
    highlights: f32,
}

impl HDParams {
    fn from_inversion(inv: &InversionParams) -> Self {
        Self {
            pivot: 1.0 - (0.01 + inv.density * DENSITY_MULTIPLIER),
            slope: 1.0 + inv.grade * GRADE_MULTIPLIER,
            cmy_r: inv.cmy_cyan * CMY_MAX_DENSITY,
            cmy_g: inv.cmy_magenta * CMY_MAX_DENSITY,
            cmy_b: inv.cmy_yellow * CMY_MAX_DENSITY,
            s_cmy_r: inv.shadow_cyan * CMY_MAX_DENSITY,
            s_cmy_g: inv.shadow_magenta * CMY_MAX_DENSITY,
            s_cmy_b: inv.shadow_yellow * CMY_MAX_DENSITY,
            h_cmy_r: inv.highlight_cyan * CMY_MAX_DENSITY,
            h_cmy_g: inv.highlight_magenta * CMY_MAX_DENSITY,
            h_cmy_b: inv.highlight_yellow * CMY_MAX_DENSITY,
            toe: inv.toe,
            toe_width: inv.toe_width,
            shoulder: inv.shoulder,
            shoulder_width: inv.shoulder_width,
            shadows: inv.shadows,
            highlights: inv.highlights,
        }
    }
}

/// Apply H&D curve to a normalized [0,1] RGB pixel.
/// When `is_bw` is true, converts output to luminance (grayscale) matching
/// the GPU shader's B&W mode.
fn hd_pixel(r: f32, g: f32, b: f32, p: &HDParams, is_bw: bool) -> [f32; 3] {
    let hr = hd_channel(
        r,
        p.pivot,
        p.slope,
        p.cmy_r,
        p.s_cmy_r,
        p.h_cmy_r,
        p.toe,
        p.toe_width,
        p.shoulder,
        p.shoulder_width,
        p.shadows,
        p.highlights,
        D_MAX,
    );
    let hg = hd_channel(
        g,
        p.pivot,
        p.slope,
        p.cmy_g,
        p.s_cmy_g,
        p.h_cmy_g,
        p.toe,
        p.toe_width,
        p.shoulder,
        p.shoulder_width,
        p.shadows,
        p.highlights,
        D_MAX,
    );
    let hb = hd_channel(
        b,
        p.pivot,
        p.slope,
        p.cmy_b,
        p.s_cmy_b,
        p.h_cmy_b,
        p.toe,
        p.toe_width,
        p.shoulder,
        p.shoulder_width,
        p.shadows,
        p.highlights,
        D_MAX,
    );

    // B&W mode: convert to luminance (Rec. 709, same as GPU shader)
    if is_bw {
        let lum = LUMA_R * hr + LUMA_G * hg + LUMA_B * hb;
        [lum, lum, lum]
    } else {
        [hr, hg, hb]
    }
}

// ─── Color matrix pass (positive path only) ──────────────────────────────────

// ─── CLAHE (Contrast Limited Adaptive Histogram Equalization) ─────────────────

/// CLAHE tile grid dimensions (matches negpy's default grid_dim=8).
const CLAHE_TILES_X: usize = 8;
const CLAHE_TILES_Y: usize = 8;
/// Number of histogram bins per tile.
const CLAHE_NUM_BINS: usize = 256;

/// Rec. 709 luminance weights (same as sRGB, matches the GPU shader).
const LUMA_R: f32 = 0.2126;
const LUMA_G: f32 = 0.7152;
const LUMA_B: f32 = 0.0722;

/// Apply CLAHE to an RGB f32 buffer in-place.
///
/// Operates on Rec. 709 luminance (matching the GPU shader implementation).
/// The algorithm:
///   1. Build per-tile 256-bin histograms of the luminance channel.
///   2. Clip each histogram at `clip_limit` and redistribute excess.
///   3. Compute CDFs from the clipped histograms.
///   4. For each pixel, bilinearly interpolate the CDF lookups from the 4
///      surrounding tile centers.
///   5. Blend: L_final = L * (1 - strength) + L_remapped * strength.
///   6. Reconstruct RGB: out = pixel * (L_final / L).
fn apply_clahe(pixels: &mut [f32], width: usize, height: usize, strength: f32) {
    if strength <= 0.0 {
        return;
    }

    let tiles_x = CLAHE_TILES_X;
    let tiles_y = CLAHE_TILES_Y;
    let num_bins = CLAHE_NUM_BINS;

    // Tile dimensions (ceil division — edge tiles may be smaller).
    let tile_w = (width + tiles_x - 1) / tiles_x;
    let tile_h = (height + tiles_y - 1) / tiles_y;

    // Step 1: Build per-tile histograms.
    let num_tiles = tiles_x * tiles_y;
    let mut histograms = vec![vec![0u32; num_bins]; num_tiles];

    for ty in 0..tiles_y {
        for tx in 0..tiles_x {
            let x0 = tx * tile_w;
            let y0 = ty * tile_h;
            let x1 = (x0 + tile_w).min(width);
            let y1 = (y0 + tile_h).min(height);
            let hist = &mut histograms[ty * tiles_x + tx];

            for y in y0..y1 {
                for x in x0..x1 {
                    let i = (y * width + x) * 3;
                    let lum =
                        (LUMA_R * pixels[i] + LUMA_G * pixels[i + 1] + LUMA_B * pixels[i + 2])
                            .clamp(0.0, 1.0);
                    let bin = (lum * 255.0).min(255.0) as usize;
                    hist[bin] += 1;
                }
            }
        }
    }

    // Step 2: Clip + redistribute.
    // clip_limit in absolute count units (same formula as GPU side).
    let tile_pixels = tile_w * tile_h;
    let clip_limit = (strength * 2.5 * (tile_pixels as f32 / num_bins as f32)) as u32;
    let clip_limit = clip_limit.max(1);

    for hist in &mut histograms {
        // Iterative redistribution (4 rounds, same as GPU shader).
        for _ in 0..4 {
            let mut excess = 0u32;
            for bin in hist.iter_mut() {
                if *bin > clip_limit {
                    excess += *bin - clip_limit;
                    *bin = clip_limit;
                }
            }
            if excess == 0 {
                break;
            }
            let per_bin = excess / num_bins as u32;
            let remainder = (excess % num_bins as u32) as usize;
            for (i, bin) in hist.iter_mut().enumerate() {
                *bin += per_bin;
                if i < remainder {
                    *bin += 1;
                }
            }
        }
    }

    // Step 3: Compute CDFs (normalized to [0, 1]).
    let mut cdfs = vec![vec![0.0_f32; num_bins]; num_tiles];
    for (tile_idx, hist) in histograms.iter().enumerate() {
        let cdf = &mut cdfs[tile_idx];
        // Compute the total pixel count for this tile (may be smaller for edge tiles).
        let tx = tile_idx % tiles_x;
        let ty_idx = tile_idx / tiles_x;
        let x0 = tx * tile_w;
        let y0 = ty_idx * tile_h;
        let x1 = (x0 + tile_w).min(width);
        let y1 = (y0 + tile_h).min(height);
        let total = ((x1 - x0) * (y1 - y0)).max(1) as f32;

        cdf[0] = hist[0] as f32;
        for i in 1..num_bins {
            cdf[i] = cdf[i - 1] + hist[i] as f32;
        }
        // Normalize to [0, 1].
        for v in cdf.iter_mut() {
            *v /= total;
        }
    }

    // Step 4–6: Remap each pixel with bilinear CDF interpolation.
    // We need to read original luminance and write back, so operate on a copy
    // would be inefficient — instead read pixels row-by-row.

    /// Linearly interpolated CDF lookup for a given tile and luminance.
    #[inline(always)]
    fn cdf_lookup(cdfs: &[Vec<f32>], tile_idx: usize, lum: f32) -> f32 {
        let cdf = &cdfs[tile_idx];
        let pos = lum * 255.0;
        let lo = (pos as usize).min(255);
        let hi = (lo + 1).min(255);
        let frac = pos - lo as f32;
        cdf[lo] + (cdf[hi] - cdf[lo]) * frac
    }

    // Process rows in parallel.
    let tile_w_f = tile_w as f32;
    let tile_h_f = tile_h as f32;
    let tiles_x_u = tiles_x;
    let tiles_y_u = tiles_y;

    pixels
        .par_chunks_mut(width * 3)
        .enumerate()
        .for_each(|(y, row)| {
            let py = y as f32 + 0.5;
            let fty = (py / tile_h_f) - 0.5;
            let ty0 = (fty.floor().max(0.0)) as usize;
            let ty1 = (ty0 + 1).min(tiles_y_u - 1);
            let fy = (fty - ty0 as f32).clamp(0.0, 1.0);

            for x in 0..width {
                let i = x * 3;
                let r = row[i];
                let g = row[i + 1];
                let b = row[i + 2];

                let lum = (LUMA_R * r + LUMA_G * g + LUMA_B * b).clamp(0.0, 1.0);

                let px = x as f32 + 0.5;
                let ftx = (px / tile_w_f) - 0.5;
                let tx0 = (ftx.floor().max(0.0)) as usize;
                let tx1 = (tx0 + 1).min(tiles_x_u - 1);
                let fx = (ftx - tx0 as f32).clamp(0.0, 1.0);

                // Bilinear interpolation of CDF lookups.
                let c00 = cdf_lookup(&cdfs, ty0 * tiles_x_u + tx0, lum);
                let c10 = cdf_lookup(&cdfs, ty0 * tiles_x_u + tx1, lum);
                let c01 = cdf_lookup(&cdfs, ty1 * tiles_x_u + tx0, lum);
                let c11 = cdf_lookup(&cdfs, ty1 * tiles_x_u + tx1, lum);

                let top = c00 + (c10 - c00) * fx;
                let bot = c01 + (c11 - c01) * fx;
                let remapped_lum = top + (bot - top) * fy;

                // Blend with original.
                let final_lum = lum * (1.0 - strength) + remapped_lum * strength;

                // Reconstruct RGB preserving chrominance.
                let eps = 1e-6_f32;
                let ratio = final_lum / lum.max(eps);
                row[i] = (r * ratio).clamp(0.0, 1.0);
                row[i + 1] = (g * ratio).clamp(0.0, 1.0);
                row[i + 2] = (b * ratio).clamp(0.0, 1.0);
            }
        });
}

// ─── Color matrix pass (positive path only) ──────────────────────────────────

/// Apply 3×3 color matrix (row-major) to a pixel.
#[inline(always)]
fn apply_color_matrix(r: f32, g: f32, b: f32, m: &[f32; 9]) -> [f32; 3] {
    [
        (m[0] * r + m[1] * g + m[2] * b).clamp(0.0, 1.0),
        (m[3] * r + m[4] * g + m[5] * b).clamp(0.0, 1.0),
        (m[6] * r + m[7] * g + m[8] * b).clamp(0.0, 1.0),
    ]
}

// ─── Tone curve pass (final color pass, both paths) ──────────────────────────

/// Apply WB multipliers + RGB LUTs + global tone LUT + optional sRGB gamma.
#[inline(always)]
fn tone_curve_pixel(
    r: f32,
    g: f32,
    b: f32,
    wb: &[f32; 3],
    red_lut: &[f32; LUT_SIZE],
    green_lut: &[f32; LUT_SIZE],
    blue_lut: &[f32; LUT_SIZE],
    tone_lut: &[f32; LUT_SIZE],
    skip_srgb: bool,
) -> [f32; 3] {
    // 1. White balance
    let mut cr = (r * wb[0]).clamp(0.0, 1.0);
    let mut cg = (g * wb[1]).clamp(0.0, 1.0);
    let mut cb = (b * wb[2]).clamp(0.0, 1.0);

    // 2. Per-channel RGB curves
    cr = lut_lookup(red_lut, cr);
    cg = lut_lookup(green_lut, cg);
    cb = lut_lookup(blue_lut, cb);

    // 3. Global tone curve
    cr = lut_lookup(tone_lut, cr);
    cg = lut_lookup(tone_lut, cg);
    cb = lut_lookup(tone_lut, cb);

    // 4. sRGB gamma encode (skip when H&D already applied 1/2.2)
    if !skip_srgb {
        cr = linear_to_srgb(cr);
        cg = linear_to_srgb(cg);
        cb = linear_to_srgb(cb);
    }

    [cr.clamp(0.0, 1.0), cg.clamp(0.0, 1.0), cb.clamp(0.0, 1.0)]
}

// ─── Full pipeline: process an RGB f32 buffer in-place ────────────────────────

/// Process a linear RGB f32 image through the complete pipeline.
///
/// - `pixels`: flat [R, G, B, R, G, B, ...] f32 in linear camera-native [0, 1].
/// - `width`, `height`: image dimensions.
/// - `edit`: the fully-resolved edit parameters.
/// - `log_perc`: pre-computed log percentiles from the preview render (for negatives).
///              If `None` and `edit.invert` is true, percentiles are computed from the data.
///
/// On return, `pixels` contains sRGB [0, 1] output.
pub fn process_image(
    pixels: &mut [f32],
    width: usize,
    height: usize,
    edit: &EffectiveEdit,
    log_perc: Option<&LogPercentiles>,
) {
    let pixel_count = width * height;
    assert_eq!(pixels.len(), pixel_count * 3);

    // Build LUTs
    let tone_lut = build_lut(&edit.tone_curve);
    let red_lut = build_lut(&edit.rgb_curves[0]);
    let green_lut = build_lut(&edit.rgb_curves[1]);
    let blue_lut = build_lut(&edit.rgb_curves[2]);

    // WB multipliers — skip for inversion path (CMY timing handles color correction).
    let wb = if edit.invert {
        [1.0, 1.0, 1.0]
    } else {
        temperature_to_multipliers(edit.white_balance.temperature, edit.white_balance.tint)
    };

    if edit.invert {
        // ── Negative path ──────────────────────────────────────────────────
        // negpy has NO camera color matrix — rawpy handles cam→AdobeRGB
        // during demosaic via output_color.  The per-channel log
        // normalization (floors/ceils stretch) handles color separation
        // and orange mask removal independently per channel, making a
        // cam→sRGB matrix unnecessary (and harmful: applying it to
        // post-H&D gamma-encoded data produces incorrect color mixing).

        // Compute or use provided log percentiles.
        // No color matrix applied — percentiles operate on camera-native data.
        let owned_perc;
        let perc = match log_perc {
            Some(p) => p,
            None => {
                owned_perc = compute_log_percentiles(pixels, width, height, None);
                &owned_perc
            }
        };

        let hd = HDParams::from_inversion(&edit.inversion_params);
        let is_bw = edit.inversion_params.film_type == "BW";

        // Step 1+2: Log normalization + H&D curve (fused, parallel by row).
        pixels.par_chunks_mut(width * 3).for_each(|row| {
            for i in (0..row.len()).step_by(3) {
                let r = row[i];
                let g = row[i + 1];
                let b = row[i + 2];

                // Step 1: Log normalization (on camera-native data)
                let [nr, ng, nb] = normalize_pixel(r, g, b, perc);

                // Step 2: H&D curve (converts to luminance for B&W mode)
                let [hr, hg, hb] = hd_pixel(nr, ng, nb, &hd, is_bw);

                row[i] = hr;
                row[i + 1] = hg;
                row[i + 2] = hb;
            }
        });

        // No color matrix in the negative path — per-channel log
        // normalization already handles color separation (matching negpy).

        // Step 3: CLAHE (needs the full H&D output before it can run).
        apply_clahe(pixels, width, height, edit.inversion_params.clahe_strength);

        // Step 4: Tone curve (skip sRGB — H&D already did 1/2.2).
        pixels.par_chunks_mut(width * 3).for_each(|row| {
            for i in (0..row.len()).step_by(3) {
                let r = row[i];
                let g = row[i + 1];
                let b = row[i + 2];

                let [fr, fg, fb] = tone_curve_pixel(
                    r, g, b, &wb, &red_lut, &green_lut, &blue_lut, &tone_lut, true,
                );

                row[i] = fr;
                row[i + 1] = fg;
                row[i + 2] = fb;
            }
        });
    } else {
        // ── Positive path ──────────────────────────────────────────────────
        let matrix = &edit.camera_color_matrix;

        pixels.par_chunks_mut(width * 3).for_each(|row| {
            for i in (0..row.len()).step_by(3) {
                let r = row[i];
                let g = row[i + 1];
                let b = row[i + 2];

                // Step 1: Normalize (no black/white region for now, no invert)
                // Apply exposure compensation
                let ev = 2.0_f32.powf(edit.exposure_compensation);
                let nr = (r * ev).clamp(0.0, 1.0);
                let ng = (g * ev).clamp(0.0, 1.0);
                let nb = (b * ev).clamp(0.0, 1.0);

                // Step 2: Color matrix — cam native → linear sRGB
                let [mr, mg, mb] = apply_color_matrix(nr, ng, nb, matrix);

                // Step 3: Tone curve + sRGB gamma
                let [fr, fg, fb] = tone_curve_pixel(
                    mr, mg, mb, &wb, &red_lut, &green_lut, &blue_lut, &tone_lut, false,
                );

                row[i] = fr;
                row[i + 1] = fg;
                row[i + 2] = fb;
            }
        });
    }
}
