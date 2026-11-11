//! Cast Removal: automatic gray balance of a colour negative.
//!
//! `measure_neutral_axis` finds the frame's near-neutral cells in a highlight,
//! midtone and shadow luma band and reads their raw log densities;
//! `cast_curve_params` bends the red and blue print curves so those references
//! print like green's. Port of NegPy 0.68 `measure_neutral_axis_from_log`
//! (negpy/features/exposure/normalization.py), its kernel `neutral_axis`
//! (negpy_core/src/meter.rs), and the Cast Removal branch of
//! `per_channel_curve_params` (negpy/features/exposure/logic.py).
//!
//! The axis is measured in f32, as the kernel is; the curve is solved in f64.
//! Mirrors src/lib/image/negative/cast.ts — change both together.

use super::constants::{
    LUMA, MIDTONE_CAST_MAX_OFFSET, NEUTRAL_AXIS_AGREEMENT_DEADZONE, NEUTRAL_AXIS_AGREEMENT_SCALE,
    NEUTRAL_AXIS_CHROMA_CAP, NEUTRAL_AXIS_CHROMA_QUANTILE, NEUTRAL_AXIS_CONFIDENCE_N0,
    NEUTRAL_AXIS_CURV_MAX_RATIO, NEUTRAL_AXIS_FIRST_PASS_CAP, NEUTRAL_AXIS_FOLIAGE_CHROMA,
    NEUTRAL_AXIS_FOLIAGE_HUE, NEUTRAL_AXIS_HIGHLIGHT_BAND, NEUTRAL_AXIS_MID_BAND,
    NEUTRAL_AXIS_MIN_PIXELS, NEUTRAL_AXIS_SHADOW_BAND, NEUTRAL_AXIS_SKY_CHROMA,
    NEUTRAL_AXIS_SKY_HUE, NEUTRAL_AXIS_WIDTH_DEADZONE, NEUTRAL_AXIS_WIDTH_SCALE, SLOPE_MAX,
    SLOPE_MIN,
};
use super::curve::compute_pivot;
use super::grid::{median, percentiles, LogGrid};
use super::types::{LogBounds, NeutralAxis};

/// Per-channel straight-line core of the print curve: `v = k·(u − pivot) + curv·u²`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CastCurve {
    pub slopes: [f32; 3],
    pub pivots: [f32; 3],
    pub curvatures: [f32; 3],
}

const RAD_TO_DEG: f32 = (180.0 / std::f64::consts::PI) as f32;
/// Foliage and sky sectors: (chroma floor, hue low, hue high) in degrees.
const SUBJECTS: [(f32, f32, f32); 2] = [
    (
        NEUTRAL_AXIS_FOLIAGE_CHROMA,
        NEUTRAL_AXIS_FOLIAGE_HUE.0,
        NEUTRAL_AXIS_FOLIAGE_HUE.1,
    ),
    (
        NEUTRAL_AXIS_SKY_CHROMA,
        NEUTRAL_AXIS_SKY_HUE.0,
        NEUTRAL_AXIS_SKY_HUE.1,
    ),
];

/// The near-neutral set of one luma band.
struct BandRefs {
    /// Raw log10 density per channel.
    refs: [f64; 3],
    /// Median chroma of the set.
    chroma: f64,
    size: usize,
    /// Widest P10–P90 spread of R − G or B − G across the set.
    width: f64,
}

/// `_rms_chroma` of one normalized triplet, in f32.
fn rms_chroma(r: f32, g: f32, b: f32) -> f32 {
    let (rg, gb, rb) = (r - g, g - b, r - b);
    (((rg * rg + gb * gb) + rb * rb) / 3.0).sqrt()
}

/// `_subject_cells` for one normalized triplet: foliage or sky by hue and chroma.
fn is_subject(n: [f32; 3]) -> bool {
    let (dr, db) = (n[0] - n[1], n[2] - n[1]);
    let (t, s) = ((dr + db) / 2.0, (dr - db) / 2.0);
    // np.hypot of float32 rounds the exact hypotenuse once.
    let (t64, s64) = (f64::from(t), f64::from(s));
    let chroma = (t64 * t64 + s64 * s64).sqrt() as f32;
    if !SUBJECTS.iter().any(|&(c, _, _)| chroma > c) {
        return false;
    }
    let hue = ((-s64).atan2(t64) as f32) * RAD_TO_DEG;
    SUBJECTS
        .iter()
        .any(|&(c, lo, hi)| chroma > c && hue > lo && hue < hi)
}

/// Span of each channel's normalization; under 1e-6 it divides by ±1e-6, by its sign.
fn span(floor: f64, ceil: f64) -> f64 {
    let d = ceil - floor;
    if d.abs() < 1e-6 {
        if d >= 0.0 {
            1e-6
        } else {
            -1e-6
        }
    } else {
        d
    }
}

/// `normalize_refs`: raw log references at their normalized position, unclamped.
fn normalize_refs(refs: [f64; 3], bounds: &LogBounds) -> [f64; 3] {
    std::array::from_fn(|c| {
        let floor = f64::from(bounds.floors[c]);
        (refs[c] - floor) / span(floor, f64::from(bounds.ceils[c]))
    })
}

/// `min(max(v, lo), hi)` that keeps a NaN, as the TypeScript mirror's `Math` clamp does.
fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    if v.is_nan() {
        v
    } else {
        v.max(lo).min(hi)
    }
}

/// Per-channel neutral axis of a frame: median raw-log density of the
/// lowest-chroma cells of a highlight, midtone and shadow luma band
/// (`measure_neutral_axis_from_log` with `exclude_subjects`). Foliage and sky
/// cells are dropped first. Pass 1 reads the sets under a loose chroma cap so
/// a strong but correctable cast keeps them; its midtone + shadow correction
/// re-ranks chroma for the strict pass 2. Confidence falls with a small set,
/// a set that is not gray after correction, a midtone/shadow disagreement and
/// a wide spread of offsets. `None` without a midtone or shadow set.
pub fn measure_neutral_axis(grid: &LogGrid, bounds: &LogBounds) -> Option<NeutralAxis> {
    let cells = grid.width * grid.height;
    if cells == 0 || grid.data.len() < cells * 3 {
        return None;
    }

    // `normalize_log_image` on the f32 bounds.
    let floors = bounds.floors;
    let span32: [f32; 3] = std::array::from_fn(|c| {
        let d = bounds.ceils[c] - floors[c];
        if d.abs() < 1e-6 {
            if d >= 0.0 {
                1e-6
            } else {
                -1e-6
            }
        } else {
            d
        }
    });
    let mut norm: Vec<[f32; 3]> = Vec::with_capacity(cells);
    let mut log: Vec<[f32; 3]> = Vec::with_capacity(cells);
    for p in grid.data[..cells * 3].chunks_exact(3) {
        let n: [f32; 3] = std::array::from_fn(|c| (p[c] - floors[c]) / span32[c]);
        if is_subject(n) {
            continue;
        }
        norm.push(n);
        log.push([p[0], p[1], p[2]]);
    }
    let lum: Vec<f32> = norm
        .iter()
        .map(|n| LUMA[0] * n[0] + LUMA[1] * n[1] + LUMA[2] * n[2])
        .collect();

    let band_refs = |(lo, hi): (f32, f32), chroma: &[f32], cap: f64| -> Option<BandRefs> {
        let band: Vec<usize> = (0..lum.len())
            .filter(|&i| lum[i] >= lo && lum[i] <= hi)
            .collect();
        if band.len() < NEUTRAL_AXIS_MIN_PIXELS {
            return None;
        }
        let band_chroma: Vec<f32> = band.iter().map(|&i| chroma[i]).collect();
        let thr = percentiles(&band_chroma, &[NEUTRAL_AXIS_CHROMA_QUANTILE * 100.0])[0];
        let idx: Vec<usize> = band.into_iter().filter(|&i| chroma[i] <= thr).collect();
        let median_of = |f: &dyn Fn(usize) -> f32| {
            f64::from(median(&idx.iter().map(|&i| f(i)).collect::<Vec<_>>()))
        };
        let near_neutral = if idx.is_empty() {
            cap
        } else {
            median_of(&|i| chroma[i])
        };
        if idx.len() < NEUTRAL_AXIS_MIN_PIXELS || near_neutral > cap {
            return None;
        }
        let green = median_of(&|i| log[i][1]);
        let refs = [
            green + median_of(&|i| log[i][0] - log[i][1]),
            green,
            green + median_of(&|i| log[i][2] - log[i][1]),
        ];
        let width_of = |ch: usize| {
            let off: Vec<f32> = idx.iter().map(|&i| norm[i][ch] - norm[i][1]).collect();
            let p = percentiles(&off, &[10.0, 90.0]);
            f64::from(p[1]) - f64::from(p[0])
        };
        Some(BandRefs {
            refs,
            chroma: near_neutral,
            size: idx.len(),
            width: width_of(0).max(width_of(2)),
        })
    };

    // Pass 1: loose cap on the raw chroma.
    let chroma1: Vec<f32> = norm.iter().map(|n| rms_chroma(n[0], n[1], n[2])).collect();
    let first_cap = f64::from(NEUTRAL_AXIS_FIRST_PASS_CAP);
    let mid1 = band_refs(NEUTRAL_AXIS_MID_BAND, &chroma1, first_cap)?;
    let sh1 = band_refs(NEUTRAL_AXIS_SHADOW_BAND, &chroma1, first_cap)?;

    // The line through pass 1's midtone and shadow that maps R and B onto green.
    let (nm, ns) = (
        normalize_refs(mid1.refs, bounds),
        normalize_refs(sh1.refs, bounds),
    );
    let mut gain = [(1.0f32, 0.0f32); 3];
    for ch in [0, 2] {
        let du = nm[ch] - ns[ch];
        let (a, b) = if du.abs() < 1e-6 {
            (1.0, nm[1] - nm[ch])
        } else {
            let a = (nm[1] - ns[1]) / du;
            (a, nm[1] - a * nm[ch])
        };
        gain[ch] = (a as f32, b as f32);
    }

    // Pass 2: strict cap on the chroma left after that correction.
    let chroma2: Vec<f32> = norm
        .iter()
        .map(|n| {
            rms_chroma(
                gain[0].0 * n[0] + gain[0].1,
                n[1],
                gain[2].0 * n[2] + gain[2].1,
            )
        })
        .collect();
    let cap = f64::from(NEUTRAL_AXIS_CHROMA_CAP);
    let mid = band_refs(NEUTRAL_AXIS_MID_BAND, &chroma2, cap)?;
    let shadow = band_refs(NEUTRAL_AXIS_SHADOW_BAND, &chroma2, cap)?;
    let highlight = band_refs(NEUTRAL_AXIS_HIGHLIGHT_BAND, &chroma2, cap);

    let tight = clamp(1.0 - mid.chroma.max(shadow.chroma) / cap, 0.0, 1.0);
    let size_term = mid.size as f64 / (mid.size as f64 + f64::from(NEUTRAL_AXIS_CONFIDENCE_N0));
    let (dm, ds) = (
        normalize_refs(mid.refs, bounds),
        normalize_refs(shadow.refs, bounds),
    );
    let spread = ((dm[0] - dm[1]) - (ds[0] - ds[1]))
        .abs()
        .max(((dm[2] - dm[1]) - (ds[2] - ds[1])).abs());
    let agree = 1.0
        - ((spread - f64::from(NEUTRAL_AXIS_AGREEMENT_DEADZONE)).max(0.0)
            / f64::from(NEUTRAL_AXIS_AGREEMENT_SCALE))
        .min(1.0);
    let width = mid.width.max(shadow.width);
    let single = 1.0
        - ((width - f64::from(NEUTRAL_AXIS_WIDTH_DEADZONE)).max(0.0)
            / f64::from(NEUTRAL_AXIS_WIDTH_SCALE))
        .min(1.0);
    let confidence = clamp(tight * size_term * agree * single, 0.0, 1.0);

    let to32 = |r: [f64; 3]| r.map(|v| v as f32);
    let axis = NeutralAxis {
        mid: to32(mid.refs),
        shadow: to32(shadow.refs),
        highlight: highlight.map(|h| to32(h.refs)),
        confidence: confidence as f32,
    };
    let finite = axis
        .mid
        .iter()
        .chain(&axis.shadow)
        .chain(axis.highlight.iter().flatten())
        .chain(std::iter::once(&axis.confidence))
        .all(|v| v.is_finite());
    finite.then_some(axis)
}

/// Leading coefficient of the parabola through three points (the third
/// divided difference); 0 when two abscissae coincide, where NegPy's
/// `np.linalg.solve` raises and falls back to 0, or when it overflows.
fn parabola_curvature(x: [f64; 3], y: [f64; 3]) -> f64 {
    let (d01, d12, d02) = (x[0] - x[1], x[1] - x[2], x[0] - x[2]);
    if d01 == 0.0 || d12 == 0.0 || d02 == 0.0 {
        return 0.0;
    }
    let curv = ((y[0] - y[1]) / d01 - (y[1] - y[2]) / d12) / d02;
    if curv.is_finite() {
        curv
    } else {
        0.0
    }
}

/// Per-channel print-curve core that removes the frame's cast: green keeps
/// the shared straight line, R and B get a line through the green-matched
/// midtone and shadow references, bent by a highlight-driven curvature when a
/// highlight reference exists (`per_channel_curve_params`, Cast Removal branch,
/// no paper channel gammas or grade trims). The applied strength is
/// `axis.confidence × strength` (`effective_cast_strength`).
///
/// `None` → no correction: the caller uses one shared straight line for all
/// channels. `strength` is the slider (0–1).
pub fn cast_curve_params(
    base_slope: f32,
    anchor: Option<f32>,
    strength: f32,
    axis: Option<&NeutralAxis>,
    bounds: &LogBounds,
) -> Option<CastCurve> {
    let axis = axis?;
    let effective = f64::from(axis.confidence) * f64::from(strength);
    if !(effective > 0.0) {
        return None;
    }
    let widen = |r: [f32; 3]| r.map(f64::from);
    let mid_norm = normalize_refs(widen(axis.mid), bounds);
    let sh_norm = normalize_refs(widen(axis.shadow), bounds);
    let hl_norm = axis.highlight.map(|h| normalize_refs(widen(h), bounds));

    let eps = 1e-6;
    let limit = f64::from(MIDTONE_CAST_MAX_OFFSET);
    let (slope_min, slope_max) = (f64::from(SLOPE_MIN), f64::from(SLOPE_MAX));
    let slope_g32 = if base_slope.is_nan() {
        base_slope
    } else {
        base_slope.max(SLOPE_MIN).min(SLOPE_MAX)
    };
    let slope_g = f64::from(slope_g32);
    let pivot_g = f64::from(compute_pivot(slope_g32, anchor));
    let curv_lim = f64::from(NEUTRAL_AXIS_CURV_MAX_RATIO) * slope_g;
    // Green's core at a green reference.
    let target = |g: f64| slope_g * (g - pivot_g);
    let (m_g, s_g) = (mid_norm[1], sh_norm[1]);
    let (t_m, t_s) = (target(m_g), target(s_g));
    // A channel's reference pulled toward green's by the strength, at most `limit` away.
    let clamp_dev = |g: f64, v: f64| g + clamp(effective * (v - g), -limit, limit);

    let mut slopes = [slope_g; 3];
    let mut pivots = [pivot_g; 3];
    let mut curvatures = [0.0f64; 3];
    for ch in [0, 2] {
        let u_m = clamp_dev(m_g, mid_norm[ch]);
        let u_s = clamp_dev(s_g, sh_norm[ch]);

        let curv = hl_norm.map_or(0.0, |hl| {
            let h_g = hl[1];
            let u_h = clamp_dev(h_g, hl[ch]);
            let c = parabola_curvature([u_h, u_m, u_s], [target(h_g), t_m, t_s]);
            clamp(c, -curv_lim, curv_lim)
        });

        // Re-pin midtone and shadow with this curvature; the midtone is exact through the pivot.
        let du = u_m - u_s;
        let slope = clamp(
            if du.abs() < eps {
                slope_g
            } else {
                ((t_m - t_s) - curv * (u_m * u_m - u_s * u_s)) / du
            },
            slope_min,
            slope_max,
        );
        slopes[ch] = slope;
        pivots[ch] = if slope.abs() > eps {
            u_m - (t_m - curv * u_m * u_m) / slope
        } else {
            pivot_g
        };
        curvatures[ch] = curv;
    }

    let curve = CastCurve {
        slopes: slopes.map(|v| v as f32),
        pivots: pivots.map(|v| v as f32),
        curvatures: curvatures.map(|v| v as f32),
    };
    let finite = curve
        .slopes
        .iter()
        .chain(&curve.pivots)
        .chain(&curve.curvatures)
        .all(|v| v.is_finite());
    finite.then_some(curve)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Shared vectors: src/lib/image/negative/cast.test.ts builds the same grids and expects the
    // same numbers.

    const FLOORS: [f64; 3] = [-2.0, -2.2, -2.4];
    const CEILS: [f64; 3] = [-0.5, -0.7, -0.9];
    const BOUNDS: LogBounds = LogBounds {
        floors: [-2.0, -2.2, -2.4],
        ceils: [-0.5, -0.7, -0.9],
    };
    const UNIT: LogBounds = LogBounds {
        floors: [0.0; 3],
        ceils: [1.0; 3],
    };
    const TILT_GAIN: [f64; 3] = [0.95, 1.0, 0.9];
    const TILT_OFFSET: [f64; 3] = [-0.03, 0.0, -0.01];

    /// Deterministic uniform noise in [-0.5, 0.5): the TypeScript tests' 32-bit LCG.
    fn lcg(seed: u32) -> impl FnMut() -> f64 {
        let mut s = seed;
        move || {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            f64::from(s) / 4_294_967_296.0 - 0.5
        }
    }

    /// A 96×64 horizontal gray ramp across the bounds, green from u = −0.05 to 1.05, with
    /// per-channel density tilts `u_c = gain_c·u + offset_c` (normalized), a shared luminance
    /// noise of ±0.01 and a per-channel noise of ±0.001.
    fn ramp(gain: [f64; 3], offset: [f64; 3]) -> LogGrid {
        let (width, height) = (96usize, 64usize);
        let mut rnd = lcg(7);
        let mut data = vec![0f32; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let u = -0.05 + (1.1 * x as f64) / (width - 1) as f64;
                let lum_noise = 0.02 * rnd();
                let i = (y * width + x) * 3;
                for c in 0..3 {
                    let un = gain[c] * u + offset[c] + lum_noise + 0.002 * rnd();
                    data[i + c] = (FLOORS[c] + un * (CEILS[c] - FLOORS[c])) as f32;
                }
            }
        }
        LogGrid {
            data,
            width,
            height,
        }
    }

    fn normalized(refs: [f32; 3], b: &LogBounds) -> [f64; 3] {
        std::array::from_fn(|c| {
            f64::from(refs[c] - b.floors[c]) / f64::from(b.ceils[c] - b.floors[c])
        })
    }

    fn core(curve: &CastCurve, ch: usize, u: f64) -> f64 {
        f64::from(curve.slopes[ch]) * (u - f64::from(curve.pivots[ch]))
            + f64::from(curve.curvatures[ch]) * u * u
    }

    fn assert_vec(actual: &[f32], expected: &[f32], tol: f32) {
        assert_eq!(actual.len(), expected.len());
        for (a, e) in actual.iter().zip(expected) {
            assert!((a - e).abs() < tol, "{actual:?} != {expected:?}");
        }
    }

    fn assert_axis(axis: Option<NeutralAxis>, expected: NeutralAxis) {
        let axis = axis.expect("an axis");
        assert_vec(&axis.mid, &expected.mid, 1e-4);
        assert_vec(&axis.shadow, &expected.shadow, 1e-4);
        assert_vec(
            &axis.highlight.expect("a highlight ref"),
            &expected.highlight.expect("a highlight ref"),
            1e-4,
        );
        assert!((axis.confidence - expected.confidence).abs() < 1e-4);
    }

    fn assert_curve(curve: Option<CastCurve>, expected: CastCurve) {
        let curve = curve.expect("a cast curve");
        assert_vec(&curve.slopes, &expected.slopes, 1e-4);
        assert_vec(&curve.pivots, &expected.pivots, 1e-4);
        assert_vec(&curve.curvatures, &expected.curvatures, 1e-4);
    }

    fn tilt_axis() -> NeutralAxis {
        measure_neutral_axis(&ramp(TILT_GAIN, TILT_OFFSET), &BOUNDS).expect("an axis")
    }

    fn bent_axis() -> NeutralAxis {
        // R and B diverge from green in opposite directions toward the highlight.
        NeutralAxis {
            mid: [0.6, 0.5, 0.4],
            shadow: [0.9, 0.8, 0.7],
            highlight: Some([0.05, 0.2, 0.35]),
            confidence: 1.0,
        }
    }

    #[test]
    fn reads_the_tilted_gray_ramp() {
        assert_axis(
            measure_neutral_axis(&ramp(TILT_GAIN, TILT_OFFSET), &BOUNDS),
            NeutralAxis {
                mid: [-1.3082988, -1.4245241, -1.7170559],
                shadow: [-0.8291131, -0.9199735, -1.26345],
                highlight: Some([-1.7509394, -1.8907775, -2.1363784]),
                confidence: 0.5695984,
            },
        );
    }

    #[test]
    fn reads_a_strong_cast_through_the_loose_first_pass() {
        assert_axis(
            measure_neutral_axis(&ramp([1.25, 1.0, 0.8], [-0.15, 0.0, 0.12]), &BOUNDS),
            NeutralAxis {
                mid: [-1.2865224, -1.4505409, -1.6205258],
                shadow: [-0.7533357, -1.0224457, -1.2770909],
                highlight: Some([-1.8075596, -1.8671136, -1.9546772]),
                confidence: 0.5532539,
            },
        );
    }

    #[test]
    fn finds_no_axis_in_saturated_foliage_or_sky() {
        // Normalized R and B 0.15 above G (foliage), or R +0.05 / B −0.20 (sky).
        assert!(measure_neutral_axis(&ramp([1.0; 3], [0.15, 0.0, 0.15]), &BOUNDS).is_none());
        assert!(measure_neutral_axis(&ramp([1.0; 3], [0.05, 0.0, -0.2]), &BOUNDS).is_none());
    }

    #[test]
    fn needs_enough_cells_in_the_midtone_and_shadow_bands() {
        let full = ramp(TILT_GAIN, TILT_OFFSET);
        let tiny = LogGrid {
            data: full.data[..10 * 8 * 3].to_vec(),
            width: 10,
            height: 8,
        };
        assert!(measure_neutral_axis(&tiny, &BOUNDS).is_none());
        let empty = LogGrid {
            data: Vec::new(),
            width: 0,
            height: 0,
        };
        assert!(measure_neutral_axis(&empty, &BOUNDS).is_none());
    }

    #[test]
    fn prints_the_neutral_references_of_r_and_b_like_green_at_full_strength() {
        let tilt = tilt_axis();
        let axis = NeutralAxis {
            confidence: 1.0,
            ..tilt
        };
        let curve = cast_curve_params(4.2, None, 1.0, Some(&axis), &BOUNDS).expect("a cast curve");
        assert_eq!(curve.slopes[1], 4.2);
        assert_eq!(curve.pivots[1], compute_pivot(4.2, None));
        assert_eq!(curve.curvatures[1], 0.0);
        let mid = normalized(tilt.mid, &BOUNDS);
        let shadow = normalized(tilt.shadow, &BOUNDS);
        for ch in [0, 2] {
            assert!((core(&curve, ch, mid[ch]) - core(&curve, 1, mid[1])).abs() < 1e-4);
            assert!((core(&curve, ch, shadow[ch]) - core(&curve, 1, shadow[1])).abs() < 1e-4);
        }
    }

    #[test]
    fn scales_the_correction_by_the_measured_confidence_and_the_slider() {
        let tilt = tilt_axis();
        assert_curve(
            cast_curve_params(4.2, None, 1.0, Some(&tilt), &BOUNDS),
            CastCurve {
                slopes: [4.3257555, 4.2, 4.4545123],
                pivots: [0.2649616, 0.290264, 0.268153],
                curvatures: [-0.0014982, 0.0, 0.0013901],
            },
        );
        assert_curve(
            cast_curve_params(4.2, Some(0.5), 0.5, Some(&tilt), &BOUNDS),
            CastCurve {
                slopes: [4.2619629, 4.2, 4.3235102],
                pivots: [0.3170305, 0.330264, 0.318066],
                curvatures: [-0.0007168, 0.0, 0.0006352],
            },
        );
    }

    #[test]
    fn bends_a_strong_cast() {
        let strong = measure_neutral_axis(&ramp([1.25, 1.0, 0.8], [-0.15, 0.0, 0.12]), &BOUNDS);
        assert_curve(
            cast_curve_params(4.2, None, 1.0, strong.as_ref(), &BOUNDS),
            CastCurve {
                slopes: [3.6785524, 4.2, 4.7166944],
                pivots: [0.2482665, 0.290264, 0.3242401],
                curvatures: [0.0148269, 0.0, -0.0005569],
            },
        );
    }

    #[test]
    fn leaves_an_uncast_gray_ramp_nearly_alone() {
        let flat = measure_neutral_axis(&ramp([1.0; 3], [0.0; 3]), &BOUNDS);
        let curve = cast_curve_params(4.2, None, 1.0, flat.as_ref(), &BOUNDS);
        assert_curve(
            curve,
            CastCurve {
                slopes: [4.1997113, 4.2, 4.2003433],
                pivots: [0.2903003, 0.290264, 0.2903086],
                curvatures: [0.0002203, 0.0, -0.000238],
            },
        );
        let curve = curve.expect("a cast curve");
        for ch in [0, 2] {
            assert!((curve.slopes[ch] - curve.slopes[1]).abs() < 1e-3);
            assert!((curve.pivots[ch] - curve.pivots[1]).abs() < 1e-3);
            assert!(curve.curvatures[ch].abs() < 1e-3);
        }
    }

    #[test]
    fn clamps_curvature_and_slope() {
        let bent = bent_axis();
        let lim = NEUTRAL_AXIS_CURV_MAX_RATIO * 4.2;
        assert_curve(
            cast_curve_params(4.2, None, 1.0, Some(&bent), &UNIT),
            CastCurve {
                slopes: [SLOPE_MIN, 4.2, 6.279],
                pivots: [0.4997544, 0.290264, 0.2115478],
                curvatures: [lim, 0.0, -lim],
            },
        );
        let tilt = tilt_axis();
        for base_slope in [0.5f32, 2.0, 4.2, 9.0, 14.0] {
            for strength in [0.25f32, 0.5, 1.0] {
                for (axis, bounds) in [(&bent, &UNIT), (&tilt, &BOUNDS)] {
                    let curve =
                        cast_curve_params(base_slope, Some(0.45), strength, Some(axis), bounds)
                            .expect("a cast curve");
                    let slope_g = curve.slopes[1];
                    assert_eq!(slope_g, base_slope.clamp(SLOPE_MIN, SLOPE_MAX));
                    for ch in 0..3 {
                        assert!((SLOPE_MIN..=SLOPE_MAX).contains(&curve.slopes[ch]));
                        assert!(
                            curve.curvatures[ch].abs()
                                <= NEUTRAL_AXIS_CURV_MAX_RATIO * slope_g * (1.0 + 1e-6)
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn falls_back_to_a_straight_line_when_the_parabola_is_singular() {
        // R's highlight lands on its midtone: no parabola through both.
        let axis = NeutralAxis {
            mid: [0.5, 0.5, 0.5],
            shadow: [0.85, 0.8, 0.8],
            highlight: Some([0.5, 0.375, 0.375]),
            confidence: 1.0,
        };
        assert_curve(
            cast_curve_params(4.2, None, 1.0, Some(&axis), &UNIT),
            CastCurve {
                slopes: [3.6, 4.2, 4.2],
                pivots: [0.255308, 0.290264, 0.290264],
                curvatures: [0.0; 3],
            },
        );
    }

    #[test]
    fn returns_no_correction_without_an_axis_or_strength() {
        let tilt = tilt_axis();
        assert!(cast_curve_params(4.2, None, 1.0, None, &BOUNDS).is_none());
        assert!(cast_curve_params(4.2, None, 0.0, Some(&tilt), &BOUNDS).is_none());
        let unsure = NeutralAxis {
            confidence: 0.0,
            ..tilt
        };
        assert!(cast_curve_params(4.2, None, 1.0, Some(&unsure), &BOUNDS).is_none());
    }

    #[test]
    fn stays_finite_on_collapsed_bounds() {
        let collapsed = LogBounds {
            floors: [0.0; 3],
            ceils: [0.0; 3],
        };
        let curve = cast_curve_params(4.2, None, 1.0, Some(&bent_axis()), &collapsed)
            .expect("a cast curve");
        assert!(curve
            .slopes
            .iter()
            .chain(&curve.pivots)
            .chain(&curve.curvatures)
            .all(|v| v.is_finite()));
    }
}
