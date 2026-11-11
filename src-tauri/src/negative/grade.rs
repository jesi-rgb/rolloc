//! Auto Grade: the straight-line slope of the print curve.
//!
//! The slope follows the negative's own density range, like a printer picking
//! a paper grade: a flat negative prints on a harder grade, a contrasty one on
//! a softer grade. The floor-to-ceil range sets the paper gamma and the
//! textural (P10–P90) range shrinks it toward a normal negative's, so frames of
//! very different contrast print with similar but not identical texture.
//!
//! Port of NegPy 0.68 `luminance_density_range` /
//! `measure_textural_range_from_log` (negpy/features/exposure/normalization.py,
//! kernels in negpy_core/src/meter.rs) and `effective_grade_range` /
//! `grade_to_slope` (negpy/features/exposure/logic.py). Mirrors
//! src/lib/image/negative/grade.ts — change both together.

use super::constants::*;
use super::grid::{grid_luma, percentiles, textured_cells, LogGrid};
use super::types::LogBounds;

/// Bounds `grade_to_slope` puts on the density range it reads, log10 D.
const GRADE_RANGE_MIN: f64 = 0.3;
const GRADE_RANGE_MAX: f64 = 3.5;

/// Below this textural range the frame is flat: `effective_grade_range`'s degenerate case.
const FLAT_TEXTURAL_RANGE: f64 = 1e-6;

/// NegPy `default_grade_range`: the effective range of a normal negative, used when unmeasured.
const DEFAULT_GRADE_RANGE: f64 =
    AUTO_GRADE_TARGET as f64 * AUTO_GRADE_NOMINAL_RATIO as f64 * AUTO_GRADE_NOMINAL_RANGE as f64;

/// Single density range of the negative: the `LUMA` weighting of the
/// per-channel floor-to-ceil ranges, so a strong single-channel cast does not
/// swing the slope the way a green-only range would. `abs` keeps a slide's
/// reversed window positive.
pub fn luminance_density_range(bounds: &LogBounds) -> f32 {
    (0..3)
        .map(|c| f64::from(LUMA[c]) * f64::from(bounds.ceils[c] - bounds.floors[c]).abs())
        .sum::<f64>() as f32
}

/// Textural density range, log10 D: the spread between the
/// `TEXTURAL_RANGE_CLIP` and `100 − TEXTURAL_RANGE_CLIP` percentiles of the
/// textured cells' raw-log luma. Both the activity gate and the percentiles
/// read raw log density (NegPy `textured_range` passes no normalization), so
/// the result does not depend on the bounds. Flat regions (sky, rebate, walls)
/// fall out at the gate and cannot shrink the range. An empty grid or a
/// non-finite result reads as `AUTO_GRADE_NOMINAL_RANGE`.
pub fn measure_textural_range(grid: &LogGrid) -> f32 {
    let cells = textured_cells(&grid_luma(grid, None), grid.width, grid.height);
    if cells.is_empty() {
        return AUTO_GRADE_NOMINAL_RANGE;
    }
    let p = percentiles(&cells, &[TEXTURAL_RANGE_CLIP, 100.0 - TEXTURAL_RANGE_CLIP]);
    let range = (p[1] - p[0]).abs();
    if range.is_finite() {
        range
    } else {
        AUTO_GRADE_NOMINAL_RANGE
    }
}

/// Density range fed to `grade_to_slope`, Auto Grade on (Alkofer, US 4,731,671):
/// `K · floor_ceil · ((1 − s) + s · nominal / textural)`, so the printed
/// textural range is (1 − s) of the frame's own plus s of a normal negative's,
/// capped at `AUTO_GRADE_MAX_OVERFILL` of the normal print span. A near-flat
/// frame returns the range cap and lets the slope clamp bound the boost.
/// Non-finite inputs read as unmeasured: a normal negative's range.
pub fn effective_grade_range(floor_ceil_range: f32, textural_range: f32) -> f32 {
    if !floor_ceil_range.is_finite() || !textural_range.is_finite() {
        return DEFAULT_GRADE_RANGE as f32;
    }
    let measured = f64::from(textural_range).abs();
    if measured < FLAT_TEXTURAL_RANGE {
        return GRADE_RANGE_MAX as f32;
    }
    let strength = f64::from(AUTO_GRADE_STRENGTH);
    let q = f64::from(AUTO_GRADE_NOMINAL_RANGE) / measured;
    let factor = ((1.0 - strength) + strength * q).min(q * f64::from(AUTO_GRADE_MAX_OVERFILL));
    (f64::from(AUTO_GRADE_TARGET) * f64::from(floor_ceil_range).abs() * factor) as f32
}

/// Straight-line slope k from a paper grade given as ISO R (R180 very soft …
/// R50 very hard): the literal H&D gamma, `GRADE_CONTRAST_SCALE · range / (R / 100)`,
/// with the range held to [0.3, 3.5] and k to [SLOPE_MIN, SLOPE_MAX]. A
/// non-finite range reads as unmeasured (a normal negative's), a NaN grade as
/// `NEUTRAL_ISO_R`.
pub fn grade_to_slope(iso_r: f32, density_range: f32) -> f32 {
    let range_in = if density_range.is_finite() {
        f64::from(density_range)
    } else {
        DEFAULT_GRADE_RANGE
    };
    let iso_r = if iso_r.is_nan() { NEUTRAL_ISO_R } else { iso_r };
    let er = f64::from(iso_r.clamp(ISO_R_MIN, ISO_R_MAX)) / 100.0;
    let range = range_in.abs().clamp(GRADE_RANGE_MIN, GRADE_RANGE_MAX);
    let k = f64::from(GRADE_CONTRAST_SCALE) * range / er;
    (k.clamp(f64::from(SLOPE_MIN), f64::from(SLOPE_MAX))) as f32
}

/// The base curve's slope: Auto Grade at the fixed neutral paper grade.
pub fn base_slope(bounds: &LogBounds, textural_range: f32) -> f32 {
    grade_to_slope(
        NEUTRAL_ISO_R,
        effective_grade_range(luminance_density_range(bounds), textural_range),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOL: f32 = 1e-4;

    fn bounds(floors: [f32; 3], ceils: [f32; 3]) -> LogBounds {
        LogBounds { floors, ceils }
    }

    /// Same synthetic grid as grade.test.ts: 8×8 blocks stepping 0.1 log D
    /// (every 16×16 sector spans 0.3) with a fine ramp, optionally beside a
    /// flat half at a mid value.
    fn synth(w: usize, h: usize, flat_left: bool) -> LogGrid {
        let mut data = vec![0f32; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let v = if flat_left && x < w / 2 {
                    -0.65
                } else {
                    let xo = x - if flat_left { w / 2 } else { 0 };
                    let (bx, by) = (xo >> 3, y >> 3);
                    -0.5 - 0.1 * ((bx + 2 * by) % 4) as f64
                        - 0.004 * (x % 8) as f64
                        - 0.003 * (y % 8) as f64
                };
                let i = (y * w + x) * 3;
                data[i] = (v + 0.05) as f32;
                data[i + 1] = v as f32;
                data[i + 2] = (v - 0.1) as f32;
            }
        }
        LogGrid {
            data,
            width: w,
            height: h,
        }
    }

    fn assert_close(actual: f32, expected: f32) {
        assert!(
            (actual - expected).abs() < TOL,
            "{actual} != {expected} (tol {TOL})"
        );
    }

    #[test]
    fn reference_slopes_at_neutral_grade() {
        let cases = [
            (
                bounds([-1.5, -1.45, -1.2], [-0.15, -0.1, 0.15]),
                0.9,
                2.893_696,
            ),
            (
                bounds([-1.0, -0.9, -0.8], [-0.3, -0.2, -0.1]),
                0.45,
                2.100_609,
            ),
            (
                bounds([-2.2, -2.1, -2.0], [-0.2, -0.1, 0.0]),
                1.35,
                3.429_565,
            ),
            (bounds([-1.2, -1.4, -1.6], [0.0, 0.0, 0.0]), 0.8, 3.087_715),
        ];
        for (b, textural, expected) in cases {
            assert_close(base_slope(&b, textural), expected);
        }
    }

    #[test]
    fn flat_textural_range_uses_range_cap() {
        let b = bounds([-1.5, -1.45, -1.2], [-0.15, -0.1, 0.15]);
        assert_close(effective_grade_range(1.35, 0.0), 3.5);
        assert_close(base_slope(&b, 0.0), 8.826_087);
    }

    /// Floor-ceil range swept with the textural range at a normal negative's
    /// ratio: never falls, rises strictly between the slope floor and the
    /// overfill cap, and stays in [SLOPE_MIN, SLOPE_MAX].
    #[test]
    fn slope_rises_with_negative_contrast() {
        let mut prev = 0.0;
        for i in 0..=27 {
            let range = 0.3 + 0.1 * i as f32;
            let b = bounds([-range, -range, -range], [0.0, 0.0, 0.0]);
            let slope = base_slope(&b, range / AUTO_GRADE_NOMINAL_RATIO);
            assert!((SLOPE_MIN..=SLOPE_MAX).contains(&slope));
            assert!(slope >= prev - 1e-6, "range {range}: {slope} < {prev}");
            if (0.75..1.75).contains(&range) {
                assert!(slope > prev + 0.05, "range {range}: {slope} <= {prev}");
            }
            prev = slope;
        }
        assert_close(prev, 2.9 * 0.85 * 1.62 / 1.15);
    }

    #[test]
    fn slope_stays_in_bounds_at_extremes() {
        let b = bounds([-0.05, -0.05, -0.05], [0.0, 0.0, 0.0]);
        assert_close(base_slope(&b, 2.0), SLOPE_MIN);
        let b = bounds([-5.0, -5.0, -5.0], [0.0, 0.0, 0.0]);
        assert_close(base_slope(&b, 0.1), 8.826_087);
        assert_close(grade_to_slope(50.0, 3.5), SLOPE_MAX);
        assert_close(grade_to_slope(50.0, 1.0), 5.8);
        assert_close(grade_to_slope(10.0, 1.0), 5.8);
        assert_close(grade_to_slope(180.0, 1.0), SLOPE_MIN);
    }

    #[test]
    fn non_finite_inputs_read_as_normal_negative() {
        let normal = base_slope(&bounds([-1.5, -1.45, -1.2], [-0.15, -0.1, 0.15]), 0.9);
        assert_close(grade_to_slope(f32::NAN, f32::NAN), normal);
        let b = bounds([f32::NAN, 0.0, 0.0], [0.0, 0.0, 0.0]);
        assert_close(base_slope(&b, 0.9), normal);
    }

    #[test]
    fn textural_range_ignores_flat_regions() {
        let grid = synth(64, 32, true);
        let measured = measure_textural_range(&grid);
        let luma = grid_luma(&grid, None);
        let textured: Vec<f32> = (0..32)
            .flat_map(|y| (32..64).map(move |x| y * 64 + x))
            .map(|i| luma[i])
            .collect();
        let p = percentiles(&textured, &[10.0, 90.0]);
        assert_close(measured, p[1] - p[0]);
        assert_close(measured, 0.307);
        let all = percentiles(&luma, &[10.0, 90.0]);
        assert!(measured > all[1] - all[0] + 0.01);
    }

    #[test]
    fn textural_range_of_tiny_grid_reads_every_cell() {
        assert_close(measure_textural_range(&synth(12, 10, false)), 0.2092);
    }

    #[test]
    fn textural_range_fallbacks() {
        let empty = LogGrid {
            data: Vec::new(),
            width: 0,
            height: 0,
        };
        assert_close(measure_textural_range(&empty), AUTO_GRADE_NOMINAL_RANGE);
        let flat = LogGrid {
            data: vec![-0.5; 64 * 32 * 3],
            width: 64,
            height: 32,
        };
        assert_close(measure_textural_range(&flat), 0.0);
    }
}
