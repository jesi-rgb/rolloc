//! Auto Density: where this negative's midtone sits in normalized space.
//!
//! The anchor is read over the frame's textured cells only, so sky, rebate and
//! flat walls do not drag it, and it moves only `ANCHOR_METER_STRENGTH` of the
//! way from `ASSUMED_ANCHOR` toward the measurement: a deliberately low- or
//! high-key scene keeps most of its key while gross mis-exposure is still
//! pulled toward correct.
//!
//! Port of NegPy 0.68 `measure_anchor_from_log`
//! (negpy/features/exposure/normalization.py), the `textured_anchor` binding
//! (negpy_core/src/py/meter.rs) and its `anchor_measure` kernel
//! (negpy_core/src/meter.rs). Mirrors src/lib/image/negative/meter.ts — change
//! both together.

use super::constants::{
    ANCHOR_METER_BAND, ANCHOR_METER_STRENGTH, ANCHOR_TRIM_CLIP, ASSUMED_ANCHOR,
};
use super::grid::{grid_luma, percentiles, textured_cells, LogGrid};
use super::types::LogBounds;

/// NegPy `anchor_measure`: the mean of the cells inside the `ANCHOR_TRIM_CLIP`
/// percentile trim, averaged with the trim's midpoint (Boyack & Juenger,
/// US 5,724,456), so a skewed histogram is placed by its detail-bearing span
/// rather than by its median. NaN when nothing survives the trim.
fn trimmed_anchor(lum: &[f32]) -> f64 {
    let trim = percentiles(lum, &[ANCHOR_TRIM_CLIP, 100.0 - ANCHOR_TRIM_CLIP]);
    let (lo, hi) = (trim[0], trim[1]);
    let (sum, n) = lum
        .iter()
        .filter(|&&v| v >= lo && v <= hi)
        .fold((0f64, 0usize), |(s, n), &v| (s + f64::from(v), n + 1));
    if n == 0 {
        return f64::NAN;
    }
    0.5 * (sum / n as f64 + 0.5 * (f64::from(lo) + f64::from(hi)))
}

/// The frame's anchor in normalized luma, already pulled and clamped to
/// `ASSUMED_ANCHOR ± ANCHOR_METER_BAND`. `bounds` are the ones the frame is
/// metered against (its own, or the roll's luma source). `ASSUMED_ANCHOR` when
/// the grid is empty or the measurement is not finite.
pub fn measure_anchor(grid: &LogGrid, bounds: &LogBounds) -> f32 {
    // As `textured_anchor`: the activity gate and the trim both read the
    // normalized luma plane, so the gate threshold is in normalized units.
    let lum = textured_cells(&grid_luma(grid, Some(bounds)), grid.width, grid.height);
    let measured = trimmed_anchor(&lum);
    if !measured.is_finite() {
        return ASSUMED_ANCHOR;
    }
    let assumed = f64::from(ASSUMED_ANCHOR);
    let band = f64::from(ANCHOR_METER_BAND);
    let pulled = assumed + f64::from(ANCHOR_METER_STRENGTH) * (measured - assumed);
    pulled.clamp(assumed - band, assumed + band) as f32
}

#[cfg(test)]
mod tests {
    // Shared vectors with src/lib/image/negative/meter.test.ts.
    use super::super::grid::median;
    use super::*;

    const BOUNDS: LogBounds = LogBounds {
        floors: [-2.2, -2.0, -1.8],
        ceils: [-0.4, -0.3, -0.2],
    };
    const SCENE_ANCHOR: f32 = 0.483_067_4;

    /// A grid whose every cell normalizes to `u(x, y)` in all three channels against `BOUNDS`.
    fn cell_grid(width: usize, height: usize, u: impl Fn(usize, usize) -> f64) -> LogGrid {
        let mut data = Vec::with_capacity(width * height * 3);
        for y in 0..height {
            for x in 0..width {
                let v = u(x, y);
                for c in 0..3 {
                    let f = f64::from(BOUNDS.floors[c]);
                    data.push((f + v * (f64::from(BOUNDS.ceils[c]) - f)) as f32);
                }
            }
        }
        LogGrid {
            data,
            width,
            height,
        }
    }

    /// A skewed ramp of 1024 values: its trimmed mean and trim midpoint differ.
    fn ramp(i: usize) -> f64 {
        0.2 + 0.6 * (i as f64 / 1023.0).powi(2)
    }

    /// Textured scene content: 8-cell checker, grain-scale ripple and a gentle gradient.
    fn scene(x: usize, y: usize) -> f64 {
        let (fx, fy) = (x as f64, y as f64);
        0.4 + 0.1 * (((x >> 3) + (y >> 3)) & 1) as f64
            + 0.15 * (fx * 0.9).sin() * (fy * 0.6).sin()
            + 0.002 * (fx + fy)
    }

    #[test]
    fn pulls_toward_trimmed_textured_mean_and_midpoint() {
        let grid = cell_grid(64, 32, |x, y| if x < 32 { ramp(y * 32 + x) } else { 0.9 });
        let at = |q: f64| {
            let r = 1023.0 * q / 100.0;
            let l = r.floor() as usize;
            ramp(l) + (ramp(l + 1) - ramp(l)) * (r - l as f64)
        };
        let (lo, hi) = (at(5.0), at(95.0));
        let inner: Vec<f64> = (0..1024)
            .map(ramp)
            .filter(|&v| v >= lo && v <= hi)
            .collect();
        let m = 0.5 * (inner.iter().sum::<f64>() / inner.len() as f64 + 0.5 * (lo + hi));
        let anchor = measure_anchor(&grid, &BOUNDS);
        assert!((f64::from(anchor) - (0.46 + 0.2 * (m - 0.46))).abs() < 1e-4);
        assert!((anchor - 0.454_193_8).abs() < 1e-5);
    }

    #[test]
    fn ignores_large_flat_sky_or_rebate() {
        let base = cell_grid(64, 64, scene);
        let sky = cell_grid(64, 160, |x, y| if y < 96 { 0.08 } else { scene(x, y - 96) });
        let rebate = cell_grid(160, 64, |x, y| if x < 64 { scene(x, y) } else { 1.0 });
        let anchor = measure_anchor(&base, &BOUNDS);
        let base_median = median(&grid_luma(&base, Some(&BOUNDS)));
        assert!((anchor - SCENE_ANCHOR).abs() < 1e-5);
        for framed in [&sky, &rebate] {
            assert!((measure_anchor(framed, &BOUNDS) - anchor).abs() < 0.005);
            assert!((median(&grid_luma(framed, Some(&BOUNDS))) - base_median).abs() > 0.1);
        }
    }

    #[test]
    fn clamps_gross_frames_to_band_ends() {
        let thin = cell_grid(64, 64, |x, y| scene(x, y) + 0.9);
        let dense = cell_grid(64, 64, |x, y| scene(x, y) - 0.9);
        assert!((measure_anchor(&thin, &BOUNDS) - 0.58).abs() < 1e-6);
        assert!((measure_anchor(&dense, &BOUNDS) - 0.34).abs() < 1e-6);
    }

    #[test]
    fn meters_every_cell_without_texture_or_sector() {
        let blank = cell_grid(64, 64, |_, _| 0.7);
        let tiny = cell_grid(3, 2, |_, _| 0.5);
        assert!((measure_anchor(&blank, &BOUNDS) - 0.508).abs() < 1e-6);
        assert!((measure_anchor(&tiny, &BOUNDS) - 0.468).abs() < 1e-6);
    }

    #[test]
    fn falls_back_to_assumed_anchor() {
        let empty = LogGrid {
            data: Vec::new(),
            width: 0,
            height: 0,
        };
        assert_eq!(measure_anchor(&empty, &BOUNDS), ASSUMED_ANCHOR);
        let nan_bounds = LogBounds {
            floors: [f32::NAN; 3],
            ceils: [0.0; 3],
        };
        assert_eq!(
            measure_anchor(&cell_grid(64, 64, scene), &nan_bounds),
            ASSUMED_ANCHOR
        );
    }
}
