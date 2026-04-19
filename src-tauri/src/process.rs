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

/// Transform parameters: rotation, zoom, and flips.
/// Mirrors `TransformParams` from types.ts.
#[derive(serde::Deserialize, Debug, Clone, Copy, Default)]
#[serde(rename_all = "camelCase")]
pub struct TransformParams {
    /// Rotation in degrees (positive = clockwise). Supports any value.
    pub rotation: f32,
    /// Horizontal flip (mirror).
    pub flip_h: bool,
    /// Vertical flip.
    pub flip_v: bool,
    /// Zoom factor (1.0 = no zoom, 2.0 = 2x zoom / crop in from center).
    #[serde(default = "default_zoom")]
    pub zoom: f32,
}

fn default_zoom() -> f32 {
    1.0
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
    /// Transform parameters (rotation, flip).
    #[serde(default)]
    pub transform: TransformParams,
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
    /// Glow (highlight bloom) strength [0,1]. 0 = off.
    /// Applies Gaussian blur to bright highlights and blends via screen mode.
    #[serde(default)]
    pub glow: f32,
    /// Vibrance: intelligent saturation that protects already-saturated colors. [-1, +1]
    #[serde(default)]
    pub vibrance: f32,
    /// Saturation: uniform saturation adjustment. [-1, +1]
    #[serde(default)]
    pub saturation: f32,
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
    /// Auto-exposure correction in density units (matches GPU pipeline).
    /// Positive = image is dark, needs brightening (reduce pivot density).
    /// When `None`, treated as 0.0 (e.g. server-side compute_log_percentiles).
    #[serde(default, rename = "autoExposure")]
    pub auto_exposure: Option<f32>,
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
        auto_exposure: None,
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
    fn from_inversion(inv: &InversionParams, auto_exposure_adj: f32) -> Self {
        let effective_density = inv.density - auto_exposure_adj;
        Self {
            pivot: 1.0 - (0.01 + effective_density * DENSITY_MULTIPLIER),
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

// ─── Vibrance + Saturation ────────────────────────────────────────────────────
//
// Direct port of `apply_vibrance_saturation` in hd_curve.wgsl. The preview
// applies this inside the H&D fragment shader immediately after the H&D curve
// and before glow, so we do the same here in the CPU pipeline.

/// Apply vibrance and saturation adjustments to an RGB f32 buffer in-place.
///
/// - `saturation` ∈ [-1, +1]: uniform blend toward/away from grayscale.
/// - `vibrance` ∈ [-1, +1]: intelligent saturation that attenuates on already-
///   saturated pixels (stronger effect on desaturated ones).
///
/// Skipped when both values are zero. Not called for B&W (the caller guards).
fn apply_vibrance_saturation(
    pixels: &mut [f32],
    width: usize,
    vibrance: f32,
    saturation: f32,
) {
    if vibrance == 0.0 && saturation == 0.0 {
        return;
    }

    let sat_factor = 1.0 + saturation;

    pixels.par_chunks_mut(width * 3).for_each(|row| {
        for i in (0..row.len()).step_by(3) {
            let r = row[i];
            let g = row[i + 1];
            let b = row[i + 2];

            // Saturation: mix toward grayscale using Rec.709 luminance.
            let lum = LUMA_R * r + LUMA_G * g + LUMA_B * b;
            let mut rr = lum + (r - lum) * sat_factor;
            let mut gg = lum + (g - lum) * sat_factor;
            let mut bb = lum + (b - lum) * sat_factor;

            // Vibrance: stronger effect on less-saturated pixels.
            if vibrance != 0.0 {
                let max_c = rr.max(gg).max(bb);
                let min_c = rr.min(gg).min(bb);
                let chroma = max_c - min_c;
                // Match shader: sat_level = chroma / max_c (0 when max_c very small).
                let sat_level = if max_c < 0.001 {
                    0.0
                } else {
                    chroma / max_c.max(0.001)
                };
                let vib_strength = vibrance * (1.0 - sat_level);
                let vib_factor = 1.0 + vib_strength;

                let lum2 = LUMA_R * rr + LUMA_G * gg + LUMA_B * bb;
                rr = lum2 + (rr - lum2) * vib_factor;
                gg = lum2 + (gg - lum2) * vib_factor;
                bb = lum2 + (bb - lum2) * vib_factor;
            }

            // Match shader's final clamp.
            row[i] = rr.clamp(0.0, 1.0);
            row[i + 1] = gg.clamp(0.0, 1.0);
            row[i + 2] = bb.clamp(0.0, 1.0);
        }
    });
}

// ─── Glow (Highlight Bloom) ───────────────────────────────────────────────────
//
// Direct port of the GPU preview shaders (`glow.wgsl` + `glow_blend.wgsl`).
// We keep the export visually identical to the preview by reusing the same
// algorithm: downsample to 1/4 res, run a 64-tap Fibonacci-spiral sample of
// highlight-weighted color with Gaussian falloff, then bilinearly upsample
// and screen-blend onto the original.
//
// This is fast (64 taps at 1/16 the pixel count) and produces exactly the
// bloom the user sees during editing.

/// Highlight threshold for glow extraction (luma above this contributes).
/// Matches `HIGHLIGHT_THRESHOLD` in glow.wgsl.
const GLOW_HIGHLIGHT_THRESHOLD: f32 = 0.5;

/// Reference image long-edge used to scale the Fibonacci sample radius.
/// Must stay in sync with `GLOW_REFERENCE_SIZE` in pipeline.ts and with
/// `PREVIEW_SIZE` in thumbgen.ts — this is the lightbox pre-render size
/// at which the base 5-pixel radius was tuned.
const GLOW_REFERENCE_SIZE: f32 = 1200.0;

/// Base Fibonacci-spiral sample radius (in downsampled pixels) at the
/// reference image size. Matches `GLOW_BASE_SAMPLE_RADIUS` in pipeline.ts.
const GLOW_BASE_SAMPLE_RADIUS: f32 = 5.0;

/// Upper bound on the scaled radius — past this the 64 taps become visibly
/// sparse. Matches `GLOW_MAX_SAMPLE_RADIUS` in pipeline.ts.
const GLOW_MAX_SAMPLE_RADIUS: f32 = 40.0;

/// Compute the Fibonacci-spiral sample radius for an image of the given
/// full-resolution dimensions. Preview (TS) and export (Rust) call the
/// same formula so bloom spread is consistent across resolutions.
fn glow_sample_radius_for_image(width: usize, height: usize) -> f32 {
    let scale = (width.max(height) as f32) / GLOW_REFERENCE_SIZE;
    (GLOW_BASE_SAMPLE_RADIUS * scale).min(GLOW_MAX_SAMPLE_RADIUS)
}

/// Sum of exp(-2*r²) across the 64 Fibonacci samples — used to normalize
/// the accumulator, matching `BLOOM_GAUSS_SUM` in glow.wgsl. Independent of
/// the sample radius since the weights come from the unit-disk offset.
const GLOW_BLOOM_GAUSS_SUM: f32 = 27.668145;

/// 64-tap Fibonacci spiral — identical to `FIBONACCI_64` in glow.wgsl.
/// Points lie in the unit disk; scale by the per-image sample radius
/// (see `glow_sample_radius_for_image`) when sampling.
#[rustfmt::skip]
const GLOW_FIBONACCI_64: [(f32, f32); 64] = [
    ( 0.088388,  0.000000), (-0.112886,  0.103413), ( 0.017279, -0.196886), ( 0.142286,  0.185586),
    (-0.261112, -0.046187), ( 0.247348, -0.157342), (-0.082733,  0.307763), (-0.157781, -0.303797),
    ( 0.342321,  0.125015), (-0.356128,  0.147004), ( 0.171677, -0.366864), ( 0.126865,  0.404466),
    (-0.382373, -0.221593), ( 0.448567, -0.098616), (-0.273753,  0.389386), (-0.063243, -0.488045),
    ( 0.388252,  0.327220), (-0.522466,  0.021606), ( 0.381099, -0.379244), (-0.025497,  0.551396),
    (-0.362617, -0.434536), ( 0.574425,  0.077288), (-0.486709,  0.338640), ( 0.132997, -0.591185),
    ( 0.307615,  0.536829), (-0.601358, -0.191850), ( 0.584143, -0.269889), (-0.253065,  0.604686),
    (-0.225855, -0.627935), ( 0.600976,  0.315856), (-0.667533,  0.175960), ( 0.379431, -0.590102),
    ( 0.120699,  0.702313), (-0.572008, -0.442995), ( 0.731702, -0.060620), (-0.505760,  0.546712),
    ( 0.003684, -0.755181), ( 0.514305,  0.566946), (-0.772295, -0.071576), ( 0.625787, -0.474950),
    (-0.142381,  0.782650), (-0.428884, -0.681539), ( 0.785920,  0.215388), (-0.733486,  0.376413),
    ( 0.289862, -0.781852), ( 0.317911,  0.780942), (-0.770264, -0.365042), ( 0.823263, -0.253821),
    (-0.440157,  0.751049), (-0.184643, -0.859851), ( 0.724177,  0.514422), (-0.890157,  0.110939),
    ( 0.587054, -0.689695), ( 0.033320,  0.913689), (-0.647727, -0.657276), ( 0.930014,  0.047552),
    (-0.724323,  0.598472), ( 0.130975, -0.938767), ( 0.542205,  0.787449), (-0.939649, -0.216211),
    ( 0.845937, -0.479274), (-0.302492,  0.932436), (-0.410097, -0.899101), ( 0.916976,  0.389028),
];

/// Downsample an RGB float buffer to ~1/4 resolution via box average over 4×4 blocks.
/// The output dimensions are `(width/4, height/4)` (integer division, min 1).
fn glow_downsample_quarter(
    pixels: &[f32],
    width: usize,
    height: usize,
) -> (Vec<f32>, usize, usize) {
    let dw = (width / 4).max(1);
    let dh = (height / 4).max(1);
    let mut out = vec![0.0_f32; dw * dh * 3];

    out.par_chunks_mut(dw * 3).enumerate().for_each(|(dy, row)| {
        let y0 = dy * 4;
        let y1 = (y0 + 4).min(height);
        for dx in 0..dw {
            let x0 = dx * 4;
            let x1 = (x0 + 4).min(width);
            let mut sr = 0.0_f32;
            let mut sg = 0.0_f32;
            let mut sb = 0.0_f32;
            let mut n = 0.0_f32;
            for y in y0..y1 {
                let row_base = y * width * 3;
                for x in x0..x1 {
                    let i = row_base + x * 3;
                    sr += pixels[i];
                    sg += pixels[i + 1];
                    sb += pixels[i + 2];
                    n += 1.0;
                }
            }
            let inv_n = 1.0 / n;
            let di = dx * 3;
            row[di] = sr * inv_n;
            row[di + 1] = sg * inv_n;
            row[di + 2] = sb * inv_n;
        }
    });

    (out, dw, dh)
}

/// Sample a downsampled RGB buffer with nearest-neighbor at integer pixel coords,
/// clamped to the texture edge. Mirrors the shader's clamp-to-edge sampling.
#[inline]
fn glow_sample_nn(buf: &[f32], w: usize, h: usize, x: i32, y: i32) -> (f32, f32, f32) {
    let sx = x.clamp(0, w as i32 - 1) as usize;
    let sy = y.clamp(0, h as i32 - 1) as usize;
    let i = (sy * w + sx) * 3;
    (buf[i], buf[i + 1], buf[i + 2])
}

/// Apply glow (highlight bloom) effect to an RGB f32 buffer in-place.
///
/// This is a line-by-line port of the GPU preview pipeline (glow.wgsl +
/// glow_blend.wgsl), so preview and export produce the same visual result.
///
/// Steps:
///   1. Downsample the image to 1/4 resolution (box average over 4×4 blocks).
///   2. For each pixel in the downsampled buffer, accumulate 64 Fibonacci-spiral
///      samples weighted by:
///        - the sampled pixel's highlight mask  ((luma - 0.5)/0.5)² clamped to [0,1]
///        - a Gaussian falloff  exp(-2 * r²)   where r ∈ [0,1] is the spiral radius
///      Divide by the normalization constant BLOOM_GAUSS_SUM.
///   3. Bilinearly upsample the glow buffer to full resolution.
///   4. Screen-blend onto the original:  out = 1 - (1 - orig) * (1 - glow * amount).
fn apply_glow(pixels: &mut [f32], width: usize, height: usize, amount: f32) {
    if amount <= 0.0 || width == 0 || height == 0 {
        return;
    }

    // Step 1: downsample to ~1/4 resolution.
    let (src_small, dw, dh) = glow_downsample_quarter(pixels, width, height);

    // Compute the Fibonacci-spiral sample radius for this image's resolution.
    // Matches the per-image radius used in the preview (pipeline.ts).
    let sample_radius = glow_sample_radius_for_image(width, height);

    // Step 2: Fibonacci-spiral bloom accumulation on the downsampled buffer.
    let inv_norm = 1.0 / GLOW_BLOOM_GAUSS_SUM;
    let mut glow_small = vec![0.0_f32; dw * dh * 3];
    glow_small
        .par_chunks_mut(dw * 3)
        .enumerate()
        .for_each(|(y, row)| {
            for x in 0..dw {
                let mut acc_r = 0.0_f32;
                let mut acc_g = 0.0_f32;
                let mut acc_b = 0.0_f32;
                for &(ox, oy) in GLOW_FIBONACCI_64.iter() {
                    let gx = x as i32 + (ox * sample_radius).round() as i32;
                    let gy = y as i32 + (oy * sample_radius).round() as i32;
                    let (sr, sg, sb) = glow_sample_nn(&src_small, dw, dh, gx, gy);

                    let luma = LUMA_R * sr + LUMA_G * sg + LUMA_B * sb;
                    let hl_lin = ((luma - GLOW_HIGHLIGHT_THRESHOLD)
                        / (1.0 - GLOW_HIGHLIGHT_THRESHOLD))
                        .max(0.0);
                    let hl = hl_lin * hl_lin;

                    // Gaussian weight exp(-2 r²) where r = length(offset) ∈ [0,1].
                    let r2 = ox * ox + oy * oy;
                    let w = (-r2 * 2.0).exp();
                    let k = hl * w;

                    acc_r += sr * k;
                    acc_g += sg * k;
                    acc_b += sb * k;
                }
                let di = x * 3;
                row[di] = (acc_r * inv_norm).clamp(0.0, 1.0);
                row[di + 1] = (acc_g * inv_norm).clamp(0.0, 1.0);
                row[di + 2] = (acc_b * inv_norm).clamp(0.0, 1.0);
            }
        });

    // Steps 3 & 4 fused: bilinear upsample + screen blend in one pass.
    // For each full-resolution pixel, compute the corresponding fractional
    // coordinate in the downsampled glow buffer, fetch 4 neighbors, lerp,
    // and screen-blend with the original.
    let sx_scale = dw as f32 / width as f32;
    let sy_scale = dh as f32 / height as f32;

    pixels
        .par_chunks_mut(width * 3)
        .enumerate()
        .for_each(|(y, dst_row)| {
            // Fractional y in glow-space, centered on the source texel (match
            // GPU sampler semantics: sample at pixel centers).
            let fy = (y as f32 + 0.5) * sy_scale - 0.5;
            let y0 = fy.floor() as i32;
            let y1 = y0 + 1;
            let ty = fy - y0 as f32;
            let y0c = y0.clamp(0, dh as i32 - 1) as usize;
            let y1c = y1.clamp(0, dh as i32 - 1) as usize;

            for x in 0..width {
                let fx = (x as f32 + 0.5) * sx_scale - 0.5;
                let x0 = fx.floor() as i32;
                let x1 = x0 + 1;
                let tx = fx - x0 as f32;
                let x0c = x0.clamp(0, dw as i32 - 1) as usize;
                let x1c = x1.clamp(0, dw as i32 - 1) as usize;

                // Fetch 4 neighbors.
                let i00 = (y0c * dw + x0c) * 3;
                let i10 = (y0c * dw + x1c) * 3;
                let i01 = (y1c * dw + x0c) * 3;
                let i11 = (y1c * dw + x1c) * 3;

                // Bilinear lerp, per channel.
                let lerp = |a: f32, b: f32, t: f32| a + (b - a) * t;
                let gr = lerp(
                    lerp(glow_small[i00], glow_small[i10], tx),
                    lerp(glow_small[i01], glow_small[i11], tx),
                    ty,
                ) * amount;
                let gg = lerp(
                    lerp(glow_small[i00 + 1], glow_small[i10 + 1], tx),
                    lerp(glow_small[i01 + 1], glow_small[i11 + 1], tx),
                    ty,
                ) * amount;
                let gb = lerp(
                    lerp(glow_small[i00 + 2], glow_small[i10 + 2], tx),
                    lerp(glow_small[i01 + 2], glow_small[i11 + 2], tx),
                    ty,
                ) * amount;

                // Screen blend: out = 1 - (1 - base) * (1 - glow).
                let di = x * 3;
                dst_row[di] = (1.0 - (1.0 - dst_row[di]) * (1.0 - gr)).clamp(0.0, 1.0);
                dst_row[di + 1] =
                    (1.0 - (1.0 - dst_row[di + 1]) * (1.0 - gg)).clamp(0.0, 1.0);
                dst_row[di + 2] =
                    (1.0 - (1.0 - dst_row[di + 2]) * (1.0 - gb)).clamp(0.0, 1.0);
            }
        });
}

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

        let hd = HDParams::from_inversion(
            &edit.inversion_params,
            perc.auto_exposure.unwrap_or(0.0),
        );
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

        // Step 2.25: Vibrance + saturation — matches the preview's H&D shader,
        // which applies these immediately after the H&D curve (and skips them
        // for B&W film, which has already been collapsed to luminance).
        if !is_bw {
            apply_vibrance_saturation(
                pixels,
                width,
                edit.inversion_params.vibrance,
                edit.inversion_params.saturation,
            );
        }

        // Step 2.5: Glow (highlight bloom) — applied after H&D curve, before CLAHE.
        // Direct port of the GPU preview's glow.wgsl + glow_blend.wgsl so preview
        // and export produce matching output.
        apply_glow(pixels, width, height, edit.inversion_params.glow);

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
