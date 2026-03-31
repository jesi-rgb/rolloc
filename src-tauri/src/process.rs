//! CPU-side image processing pipeline for native-resolution export.
//!
//! Ports the WebGPU shader math to Rust so we can process images end-to-end
//! in f32 precision without any GPU texture size limits or 8-bit quantization.
//!
//! Two pipeline configurations (mirroring pipeline.ts):
//!
//! **Negative path** (invert = true):
//!   1. Log normalization — log10 per-channel percentile stretch (removes orange mask, inverts)
//!   2. H&D curve — sigmoid paper response with CMY timing, toe/shoulder
//!   3. Tone curve — WB multipliers + RGB LUTs + global tone LUT (sRGB skipped, H&D already 1/2.2)
//!
//! **Positive path** (invert = false):
//!   1. Normalize/invert — black/white point + exposure compensation
//!   2. Color matrix — cam-native → linear sRGB
//!   3. Tone curve — WB multipliers + RGB LUTs + global tone LUT + sRGB gamma encode

use rayon::prelude::*;

// ─── NegPy constants (must match pipeline.ts) ─────────────────────────────────

const CMY_MAX_DENSITY: f32 = 0.2;
const DENSITY_MULTIPLIER: f32 = 0.2;
const GRADE_MULTIPLIER: f32 = 2.0;
const D_MAX: f32 = 4.0;

/// Default analysis buffer — crops this fraction of each edge before
/// computing log percentiles (matches NegPy's analysis_buffer = 0.07).
const ANALYSIS_BUFFER: f32 = 0.07;

// ─── Types (deserialized from JS) ─────────────────────────────────────────────

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
    pub toe_hardness: f32,
    pub shoulder: f32,
    pub shoulder_width: f32,
    pub shoulder_hardness: f32,
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

/// Look up a value in a 256-entry LUT with nearest-neighbour indexing.
#[inline(always)]
fn lut_lookup(lut: &[f32; LUT_SIZE], v: f32) -> f32 {
    let idx = (v * 255.0 + 0.5).floor() as usize;
    lut[idx.min(LUT_SIZE - 1)]
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

/// Compute per-channel 0.5th / 99.5th log10 percentiles from linear f32 RGBA
/// pixels (3-channel RGB stored as flat f32 with stride 3).
///
/// `pixels` is a flat slice of [R, G, B, R, G, B, ...] f32 values in [0, 1].
pub fn compute_log_percentiles(pixels: &[f32], width: usize, height: usize) -> LogPercentiles {
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

    let mut y = start_y;
    while y < end_y {
        let mut x = start_x;
        while x < end_x {
            let i = (y * width + x) * 3;
            let r = pixels[i];
            let g = pixels[i + 1];
            let b = pixels[i + 2];
            if r > eps {
                r_log.push(r.ln() * log10_e);
            }
            if g > eps {
                g_log.push(g.ln() * log10_e);
            }
            if b > eps {
                b_log.push(b.ln() * log10_e);
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

    LogPercentiles {
        floors: [
            percentile(&mut r_log, 0.5),
            percentile(&mut g_log, 0.5),
            percentile(&mut b_log, 0.5),
        ],
        ceils: [
            percentile(&mut r_log, 99.5),
            percentile(&mut g_log, 99.5),
            percentile(&mut b_log, 99.5),
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
    toe_hard: f32,
    shoulder: f32,
    sh_width: f32,
    sh_hard: f32,
    shadows: f32,
    highlights: f32,
    d_max: f32,
) -> f32 {
    let eps = 1e-6_f32;

    // 1. Global CMY shift
    let val = pixel + cmy_offset;
    let diff = val - pivot;

    // 2. Shadow / highlight Gaussian masks
    let s_center = (1.0 - pivot) * 0.9;
    let h_center = (0.0 - pivot) * 0.9;

    let s_mask = (-(diff - s_center).powi(2) / 0.15).exp();
    let shadow_density_offset = shadows * s_mask * 0.3;
    let shadow_color_offset = shadow_cmy * s_mask;

    let h_mask = (-(diff - h_center).powi(2) / 0.15).exp();
    let hi_density_offset = highlights * h_mask * 0.3;
    let hi_color_offset = hi_cmy * h_mask;

    let diff_adj =
        diff + shadow_color_offset + hi_color_offset - shadow_density_offset - hi_density_offset;

    // 3. Shoulder damping
    let sw_val = sh_width * (diff_adj / pivot.max(eps));
    let w_s = fast_sigmoid(sw_val);
    let prot_s = (4.0 * (w_s - 0.5).powi(2)).powf(sh_hard);
    let damp_sh = shoulder * (1.0 - w_s) * prot_s;

    // 4. Toe damping
    let tw_val = toe_width * (diff_adj / (1.0 - pivot).max(eps));
    let w_t = fast_sigmoid(tw_val);
    let prot_t = (4.0 * (w_t - 0.5).powi(2)).powf(toe_hard);
    let damp_t = toe * w_t * prot_t;

    // 5. Effective contrast
    let k_mod = (1.0 - damp_t - damp_sh).clamp(0.1, 2.0);

    // 6. H&D sigmoid → print density
    let density = d_max * fast_sigmoid(slope * diff_adj * k_mod);

    // 7. Density → transmittance → perceptual gamma (1/2.2)
    let transmittance = 10.0_f32.powf(-density).clamp(0.0, 1.0);
    transmittance.powf(1.0 / 2.2)
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
    toe_hardness: f32,
    shoulder: f32,
    shoulder_width: f32,
    shoulder_hardness: f32,
    shadows: f32,
    highlights: f32,
}

impl HDParams {
    fn from_inversion(inv: &InversionParams) -> Self {
        Self {
            pivot: 1.0 - (0.1 + inv.density * DENSITY_MULTIPLIER),
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
            toe_hardness: inv.toe_hardness,
            shoulder: inv.shoulder,
            shoulder_width: inv.shoulder_width,
            shoulder_hardness: inv.shoulder_hardness,
            shadows: inv.shadows,
            highlights: inv.highlights,
        }
    }
}

/// Apply H&D curve to a normalized [0,1] RGB pixel.
fn hd_pixel(r: f32, g: f32, b: f32, p: &HDParams) -> [f32; 3] {
    [
        hd_channel(
            r,
            p.pivot,
            p.slope,
            p.cmy_r,
            p.s_cmy_r,
            p.h_cmy_r,
            p.toe,
            p.toe_width,
            p.toe_hardness,
            p.shoulder,
            p.shoulder_width,
            p.shoulder_hardness,
            p.shadows,
            p.highlights,
            D_MAX,
        ),
        hd_channel(
            g,
            p.pivot,
            p.slope,
            p.cmy_g,
            p.s_cmy_g,
            p.h_cmy_g,
            p.toe,
            p.toe_width,
            p.toe_hardness,
            p.shoulder,
            p.shoulder_width,
            p.shoulder_hardness,
            p.shadows,
            p.highlights,
            D_MAX,
        ),
        hd_channel(
            b,
            p.pivot,
            p.slope,
            p.cmy_b,
            p.s_cmy_b,
            p.h_cmy_b,
            p.toe,
            p.toe_width,
            p.toe_hardness,
            p.shoulder,
            p.shoulder_width,
            p.shoulder_hardness,
            p.shadows,
            p.highlights,
            D_MAX,
        ),
    ]
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

    // WB multipliers
    let wb = temperature_to_multipliers(edit.white_balance.temperature, edit.white_balance.tint);

    if edit.invert {
        // ── Negative path ──────────────────────────────────────────────────

        // Compute or use provided log percentiles.
        let owned_perc;
        let perc = match log_perc {
            Some(p) => p,
            None => {
                owned_perc = compute_log_percentiles(pixels, width, height);
                &owned_perc
            }
        };

        let hd = HDParams::from_inversion(&edit.inversion_params);

        // Process in parallel: chunk by row for cache friendliness.
        pixels.par_chunks_mut(width * 3).for_each(|row| {
            for i in (0..row.len()).step_by(3) {
                let r = row[i];
                let g = row[i + 1];
                let b = row[i + 2];

                // Step 1: Log normalization
                let [nr, ng, nb] = normalize_pixel(r, g, b, perc);

                // Step 2: H&D curve
                let [hr, hg, hb] = hd_pixel(nr, ng, nb, &hd);

                // Step 3: Tone curve (skip sRGB — H&D already did 1/2.2)
                let [fr, fg, fb] = tone_curve_pixel(
                    hr, hg, hb, &wb, &red_lut, &green_lut, &blue_lut, &tone_lut, true,
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
