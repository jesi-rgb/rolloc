//! Density window of a negative: per channel, the dense end (`floors`, scene
//! highlights) and the thin end (`ceils`, film base) the render normalizes by.
//!
//! Port of NegPy 0.68 `analyze_log_exposure_bounds_from_log`,
//! `_sample_log_bounds` and `_same_pixel_color_floor_refs`
//! (negpy/features/exposure/normalization.py; kernel negpy_core/src/bounds.rs)
//! at NegPy's default settings: luma slider 0, colour clip `BASE_COLOR_CLIP`.
//! The grid is already cropped and block-medianed, so NegPy's roi / buffer /
//! block-median steps are not repeated here.
//!
//! Mirrors src/lib/image/negative/bounds.ts — change both together. Sums and
//! ratios run in f64; percentiles come from the shared f32 grid helpers.

use super::constants::{
    BASE_COLOR_CLIP, BASE_LUMA_CLIP, COLOR_BOUNDS_BAND_WIDTH, NEUTRAL_AXIS_CHROMA_CAP,
    NEUTRAL_AXIS_CHROMA_QUANTILE, NEUTRAL_AXIS_FIRST_PASS_CAP, NEUTRAL_AXIS_MIN_PIXELS,
};
use super::grid::{grid_luma, median, percentile_of_sorted, percentiles, sorted_channel, LogGrid};
use super::types::LogBounds;

/// Guard on spans and gammas the kernel divides by.
const EPSILON: f64 = 1e-6;

/// `_sample_log_bounds` (`percentile_clip >= 0`, slider 0): per-channel floors
/// and ceils at the `base` clip per tail, clamped to [0.00001, 50].
fn sample_bounds(sorted: &[Vec<f32>; 3], base: f32) -> ([f64; 3], [f64; 3]) {
    let clip = base.clamp(0.00001, 50.0);
    (
        std::array::from_fn(|c| f64::from(percentile_of_sorted(&sorted[c], clip))),
        std::array::from_fn(|c| f64::from(percentile_of_sorted(&sorted[c], 100.0 - clip))),
    )
}

/// Python's `sorted(v)[1]`.
fn middle_of([a, b, c]: [f64; 3]) -> f64 {
    a.min(b).max(a.max(b).min(c))
}

/// `rms_chroma` of one triplet.
fn rms_chroma(r: f64, g: f64, b: f64) -> f64 {
    (((r - g) * (r - g) + (g - b) * (g - b) + (r - b) * (r - b)) / 3.0).sqrt()
}

/// `same_pixel_color_floor_refs`: the dense-end colour refs from one shared
/// pixel set — the luma-extreme band's lowest-chroma cells, chroma read as
/// offsets from the thin-end refs `base` scaled by each channel's span (pass 1),
/// then by the pass-1 medians (pass 2). Independent per-channel percentiles
/// would read a different scene object per channel and take coloured highlight
/// content for film cast. None when the set is too small or too chromatic.
fn same_color_floor_refs(
    grid: &LogGrid,
    luma_floors: [f64; 3],
    luma_ceils: [f64; 3],
    base: [f64; 3],
    color_clip: f32,
) -> Option<[f64; 3]> {
    let norm = LogBounds {
        floors: luma_floors.map(|v| v as f32),
        ceils: luma_ceils.map(|v| v as f32),
    };
    let luma = grid_luma(grid, Some(&norm));
    let clip = color_clip.min(50.0 - COLOR_BOUNDS_BAND_WIDTH).max(0.00001);
    let band = percentiles(&luma, &[clip, clip + COLOR_BOUNDS_BAND_WIDTH]);
    let (lo, hi) = (band[0], band[1]);
    let base32 = base.map(|v| v as f32);
    let d: Vec<[f32; 3]> = grid
        .data
        .chunks_exact(3)
        .zip(&luma)
        .filter(|&(_, &l)| l >= lo && l <= hi)
        .map(|(p, _)| std::array::from_fn(|c| p[c] - base32[c]))
        .collect();
    if d.len() < NEUTRAL_AXIS_MIN_PIXELS {
        return None;
    }

    // The lowest-chroma quantile of the band with `gamma` as each channel's
    // span: the selected rows and their median chroma.
    let select = |gamma: [f64; 3]| -> Option<(Vec<usize>, f64)> {
        let g = gamma.map(|v| if v.abs() < EPSILON { EPSILON } else { v });
        let chroma: Vec<f32> = d
            .iter()
            .map(|p| {
                let r = f64::from(p[0]) / g[0];
                let gg = f64::from(p[1]) / g[1];
                let b = f64::from(p[2]) / g[2];
                rms_chroma(r, gg, b) as f32
            })
            .collect();
        let thr = percentiles(&chroma, &[NEUTRAL_AXIS_CHROMA_QUANTILE * 100.0])[0];
        let rows: Vec<usize> = (0..chroma.len()).filter(|&i| chroma[i] <= thr).collect();
        if rows.len() < NEUTRAL_AXIS_MIN_PIXELS {
            return None;
        }
        let picked: Vec<f32> = rows.iter().map(|&i| chroma[i]).collect();
        Some((rows, f64::from(median(&picked))))
    };
    let column_medians = |rows: &[usize]| -> [f64; 3] {
        std::array::from_fn(|c| {
            let col: Vec<f32> = rows.iter().map(|&i| d[i][c]).collect();
            f64::from(median(&col))
        })
    };

    let (first, first_chroma) = select(std::array::from_fn(|c| luma_floors[c] - base[c]))?;
    // A loose first cap: pass 2 would self-normalize a homogeneous coloured
    // cluster to zero chroma and read it as neutral.
    if first_chroma > f64::from(NEUTRAL_AXIS_FIRST_PASS_CAP) {
        return None;
    }
    let provisional = column_medians(&first);
    if provisional.iter().any(|v| v.abs() < EPSILON) {
        return None;
    }
    let (second, second_chroma) = select(provisional)?;
    if second_chroma > f64::from(NEUTRAL_AXIS_CHROMA_CAP) {
        return None;
    }
    let m = column_medians(&second);
    Some(std::array::from_fn(|c| base[c] + m[c]))
}

/// Per-channel density window of a negative, read from its prefiltered grid
/// (`analyze_log_exposure_bounds_from_log`). The colour pass sets each
/// channel's refs — thin end from per-channel percentiles, dense end from the
/// shared near-neutral highlight set when it exists — and the luma pass sets
/// how far past them the window reaches, as one shared fraction of each
/// channel's span, so a gray scale normalizes neutral. Empty grid →
/// `floors [-1; 3]`, `ceils [0; 3]`; a flat grid gives `floor == ceil`.
pub fn analyze_log_bounds(grid: &LogGrid) -> LogBounds {
    let n = grid.width * grid.height;
    if n == 0 || grid.data.len() != n * 3 {
        return LogBounds {
            floors: [-1.0; 3],
            ceils: [0.0; 3],
        };
    }
    let sorted: [Vec<f32>; 3] = std::array::from_fn(|c| sorted_channel(grid, c));

    // Luma pass at the luma base clip (slider 0); colour pass at the colour clip, base 0.
    let (floors, ceils) = sample_bounds(&sorted, BASE_LUMA_CLIP);
    let (percentile_floors, c_ceils) = sample_bounds(&sorted, BASE_COLOR_CLIP);
    let c_floors = same_color_floor_refs(grid, floors, ceils, c_ceils, BASE_COLOR_CLIP)
        .unwrap_or(percentile_floors);

    let spans: [f64; 3] = std::array::from_fn(|c| c_floors[c] - c_ceils[c]);
    let total: f64 = spans.iter().sum();
    if spans.iter().all(|s| s * total > 0.0) {
        // The luma window reaches past the colour refs by one shared fraction of
        // each channel's own span (a reach in log units would tint a film whose
        // channels differ in density range); a ratio of sums, so a near-flat
        // channel cannot inflate it. The window sits off the luma mean by the
        // base's mean-minus-median channel offset, where the print constants are tuned.
        let reach_f = (0..3).map(|c| floors[c] - c_floors[c]).sum::<f64>() / total;
        let reach_c = (0..3).map(|c| ceils[c] - c_ceils[c]).sum::<f64>() / total;
        let shift = (c_ceils.iter().sum::<f64>() - 3.0 * middle_of(c_ceils)) / total;
        return LogBounds {
            floors: std::array::from_fn(|c| (c_floors[c] + (reach_f + shift) * spans[c]) as f32),
            ceils: std::array::from_fn(|c| (c_ceils[c] + (reach_c + shift) * spans[c]) as f32),
        };
    }
    // Spans of mixed sign (or none): the colour refs' offsets from their median
    // channel, placed around the luma pass's mean.
    let mean_f = floors.iter().sum::<f64>() / 3.0;
    let mean_c = ceils.iter().sum::<f64>() / 3.0;
    let mid_f = middle_of(c_floors);
    let mid_c = middle_of(c_ceils);
    LogBounds {
        floors: std::array::from_fn(|c| (mean_f + c_floors[c] - mid_f) as f32),
        ceils: std::array::from_fn(|c| (mean_c + c_ceils[c] - mid_c) as f32),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Shared vectors with src/lib/image/negative/bounds.test.ts.
    // A C-41-like negative: per-channel film base (orange mask) and density range.
    const BASE: [f64; 3] = [-0.25, -0.55, -0.85];
    const RANGE: [f64; 3] = [1.4, 1.6, 1.8];

    /// Log density of a gray of scene brightness `t` (0 = brightest highlight, 1 = base).
    fn gray(t: f64, c: usize) -> f32 {
        (BASE[c] - RANGE[c] * (1.0 - t)) as f32
    }

    /// A gray ramp with sparse highlights (`t = sqrt(u)`). With `object`, 3 % of
    /// the cells become a saturated bright object: dense as the brightest
    /// highlight in R, nearly so in G, a midtone in B.
    fn ramp(width: usize, height: usize, object: bool) -> LogGrid {
        let n = width * height;
        let (o0, o1) = (n * 40 / 100, n * 40 / 100 + n * 3 / 100);
        let mut data = Vec::with_capacity(n * 3);
        for i in 0..n {
            let t = ((i as f64 + 0.5) / n as f64).sqrt();
            let ts = if object && (o0..o1).contains(&i) {
                [0.0, 0.02, 0.6]
            } else {
                [t; 3]
            };
            data.extend((0..3).map(|c| gray(ts[c], c)));
        }
        LogGrid {
            data,
            width,
            height,
        }
    }

    fn assert_bounds(b: &LogBounds, floors: [f32; 3], ceils: [f32; 3]) {
        for c in 0..3 {
            assert!((b.floors[c] - floors[c]).abs() < 1e-4, "{b:?}");
            assert!((b.ceils[c] - ceils[c]).abs() < 1e-4, "{b:?}");
        }
    }

    /// Largest cross-channel spread of the normalized value of a gray.
    fn gray_spread(b: &LogBounds) -> f64 {
        [0.05, 0.3, 0.6, 0.95]
            .iter()
            .map(|&t| {
                let u: Vec<f64> = (0..3)
                    .map(|c| {
                        f64::from(gray(t, c) - b.floors[c]) / f64::from(b.ceils[c] - b.floors[c])
                    })
                    .collect();
                u.iter().cloned().fold(f64::MIN, f64::max)
                    - u.iter().cloned().fold(f64::MAX, f64::min)
            })
            .fold(0.0, f64::max)
    }

    #[test]
    fn gray_ramp_stays_neutral_under_orange_mask() {
        let b = analyze_log_bounds(&ramp(160, 120, false));
        assert_bounds(
            &b,
            [-1.634313, -2.132072, -2.629831],
            [-0.250088, -0.550101, -0.850113],
        );
        assert!((0..3).all(|c| b.floors[c] < b.ceils[c]));
        assert!(gray_spread(&b) < 1e-3);
    }

    #[test]
    fn saturated_object_does_not_move_dense_end() {
        let clean = ramp(160, 120, false);
        let with_object = ramp(160, 120, true);
        let b0 = analyze_log_bounds(&clean);
        let b1 = analyze_log_bounds(&with_object);
        assert_bounds(
            &b1,
            [-1.638889, -2.137301, -2.635714],
            [-0.250088, -0.550101, -0.850113],
        );
        assert!(gray_spread(&b1) < 1e-3);

        // Independent per-channel percentiles at the colour clip read the object in R.
        let p1 = |g: &LogGrid| percentile_of_sorted(&sorted_channel(g, 0), BASE_COLOR_CLIP);
        let percentile_shift = (p1(&with_object) - p1(&clean)).abs();
        let bounds_shift = (0..3)
            .map(|c| (b1.floors[c] - b0.floors[c]).abs())
            .fold(0.0, f32::max);
        assert!(
            (percentile_shift - 0.140179).abs() < 1e-4,
            "{percentile_shift}"
        );
        assert!((bounds_shift - 0.005883).abs() < 1e-4, "{bounds_shift}");
        assert!(bounds_shift < 0.01);
    }

    #[test]
    fn tiny_grid_falls_back_to_percentile_refs_and_stays_neutral() {
        let b = analyze_log_bounds(&ramp(8, 6, false));
        assert_bounds(
            &b,
            [-1.506622, -1.986139, -2.465656],
            [-0.25738, -0.558434, -0.859489],
        );
        assert!(gray_spread(&b) < 1e-3);
    }

    #[test]
    fn flat_grid_collapses_to_its_value() {
        let grid = LogGrid {
            data: [-0.4f32, -0.7, -1.0].repeat(32 * 32),
            width: 32,
            height: 32,
        };
        let b = analyze_log_bounds(&grid);
        assert_bounds(&b, [-0.4, -0.7, -1.0], [-0.4, -0.7, -1.0]);
    }

    #[test]
    fn empty_grid_falls_back() {
        let b = analyze_log_bounds(&LogGrid {
            data: Vec::new(),
            width: 0,
            height: 0,
        });
        assert_eq!(
            b,
            LogBounds {
                floors: [-1.0; 3],
                ceils: [0.0; 3],
            }
        );
    }
}
