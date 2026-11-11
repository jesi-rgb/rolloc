//! Analysis grid of the negative pipeline.
//!
//! Every meter (bounds, anchor, textural range, neutral axis) reads the same
//! prefiltered image: log10 density → centred analysis crop → block-median
//! grid of at most `ANALYSIS_GRID` cells on the long side. An isolated extreme
//! (dust, a specular) vanishes inside its block's median, and the grid size is
//! fixed, so a preview-size decode and the full-size export measure alike.
//!
//! Port of NegPy 0.68 `prefilter_log_grid` / `_block_median_grid`
//! (negpy/features/exposure/normalization.py) and `textured_cells`
//! (negpy_core/src/meter.rs). Mirrors src/lib/image/negative/grid.ts — change
//! both together.

use rayon::prelude::*;

use super::constants::{
    ACTIVITY_BLOCK, ACTIVITY_GATE_DENSITY, ACTIVITY_MIN_FRACTION, ANALYSIS_GRID, LUMA,
};
use super::types::LogBounds;

/// Smallest linear value the log sees; also where NaN lands.
const LOG_FLOOR: f32 = 1e-6;

/// Log10-density image: `width × height` cells of interleaved RGB
/// (`data[(y * width + x) * 3 + channel]`), row-major. Values lie in [-6, 0].
/// An empty grid has `width == 0`.
#[derive(Debug, Clone, PartialEq)]
pub struct LogGrid {
    pub data: Vec<f32>,
    pub width: usize,
    pub height: usize,
}

/// log10 of a linear value clamped to [1e-6, 1]; NaN reads as 1e-6
/// (`f32::max` returns the non-NaN operand).
#[inline]
fn log_density(v: f32) -> f32 {
    v.max(LOG_FLOOR).min(1.0).log10()
}

/// Median of `values`, reordering them: the middle one, or the mean of the two
/// middle ones. NaN when empty.
fn median_in_place(values: &mut [f32]) -> f32 {
    let n = values.len();
    if n == 0 {
        return f32::NAN;
    }
    values.sort_unstable_by(f32::total_cmp);
    if n % 2 == 0 {
        (values[n / 2 - 1] + values[n / 2]) * 0.5
    } else {
        values[n / 2]
    }
}

/// The grid every meter reads: log10 density of `rgb` (linear, interleaved
/// RGB, `width * height * 3` values), cropped by `analysis_buffer` on each
/// edge, block-medianed to at most `ANALYSIS_GRID` cells on the long side.
/// Empty when the source is degenerate.
pub fn prefilter_log_grid(
    rgb: &[f32],
    width: usize,
    height: usize,
    analysis_buffer: f32,
) -> LogGrid {
    let safe = f64::from(analysis_buffer.clamp(0.0, 0.3));
    let cut_y = (height as f64 * safe) as usize;
    let cut_x = (width as f64 * safe) as usize;
    let cw = width.saturating_sub(2 * cut_x);
    let ch = height.saturating_sub(2 * cut_y);
    if cw == 0 || ch == 0 || rgb.len() < width * height * 3 {
        return LogGrid {
            data: Vec::new(),
            width: 0,
            height: 0,
        };
    }

    let b = cw.max(ch).div_ceil(ANALYSIS_GRID);
    if b <= 1 || ch < b || cw < b {
        // Already at or under the grid size: the cropped log image is the grid.
        let mut data = vec![0f32; cw * ch * 3];
        data.par_chunks_mut(cw * 3).enumerate().for_each(|(y, row)| {
            let start = ((y + cut_y) * width + cut_x) * 3;
            for (d, &s) in row.iter_mut().zip(&rgb[start..start + cw * 3]) {
                *d = log_density(s);
            }
        });
        return LogGrid {
            data,
            width: cw,
            height: ch,
        };
    }

    let (gw, gh) = (cw / b, ch / b);
    let mut data = vec![0f32; gw * gh * 3];
    data.par_chunks_mut(gw * 3).enumerate().for_each(|(gy, line)| {
        let mut block = vec![0f32; b * b];
        for gx in 0..gw {
            for c in 0..3 {
                let mut k = 0;
                for yy in 0..b {
                    let row = ((cut_y + gy * b + yy) * width + cut_x + gx * b) * 3 + c;
                    for xx in 0..b {
                        block[k] = log_density(rgb[row + xx * 3]);
                        k += 1;
                    }
                }
                line[gx * 3 + c] = median_in_place(&mut block);
            }
        }
    });
    LogGrid {
        data,
        width: gw,
        height: gh,
    }
}

/// Luma of each grid cell, `LUMA`-weighted. With `norm`, each channel is first
/// normalized as the render does: `(value − floor) / (ceil − floor)`, unclamped.
pub fn grid_luma(grid: &LogGrid, norm: Option<&LogBounds>) -> Vec<f32> {
    let cells = grid.data.chunks_exact(3);
    match norm {
        None => cells
            .map(|p| LUMA[0] * p[0] + LUMA[1] * p[1] + LUMA[2] * p[2])
            .collect(),
        Some(b) => {
            let mut span = [0f32; 3];
            for c in 0..3 {
                let d = b.ceils[c] - b.floors[c];
                span[c] = if d.abs() < 1e-6 {
                    if d >= 0.0 {
                        1e-6
                    } else {
                        -1e-6
                    }
                } else {
                    d
                };
            }
            cells
                .map(|p| {
                    LUMA[0] * ((p[0] - b.floors[0]) / span[0])
                        + LUMA[1] * ((p[1] - b.floors[1]) / span[1])
                        + LUMA[2] * ((p[2] - b.floors[2]) / span[2])
                })
                .collect()
        }
    }
}

/// The cells of a `width × height` luma plane that carry texture, in row order.
///
/// The plane is tiled into sectors of 2×2 blocks of `ACTIVITY_BLOCK` cells; a
/// sector votes when its four block means span more than
/// `ACTIVITY_GATE_DENSITY` (Boyack & Juenger, US 5,724,456), so rebate, sky
/// and flat walls drop out. When fewer than `ACTIVITY_MIN_FRACTION` of the
/// sectors vote — or the plane is smaller than one sector — every cell is
/// returned.
///
/// The gate compares luma differences, so it is meaningful only on a plane
/// whose unit is log10 density: pass `grid_luma(grid, None)` (raw log), or a
/// normalized plane when the caller wants the gate in normalized units.
pub fn textured_cells(luma: &[f32], width: usize, height: usize) -> Vec<f32> {
    let b = ACTIVITY_BLOCK;
    let hs = (height / (2 * b)) * 2 * b;
    let ws = (width / (2 * b)) * 2 * b;
    if hs == 0 || ws == 0 {
        return luma.to_vec();
    }

    let (bh, bw) = (hs / b, ws / b);
    let mut means = vec![0f32; bh * bw];
    for by in 0..bh {
        for bx in 0..bw {
            let mut sum = 0f32;
            for y in by * b..(by + 1) * b {
                let row = y * width + bx * b;
                sum += luma[row..row + b].iter().sum::<f32>();
            }
            means[by * bw + bx] = sum / (b * b) as f32;
        }
    }

    let (sh, sw) = (bh / 2, bw / 2);
    let active: Vec<bool> = (0..sh * sw)
        .map(|i| {
            let (sy, sx) = (i / sw, i % sw);
            let j = 2 * sy * bw + 2 * sx;
            let quad = [means[j], means[j + 1], means[j + bw], means[j + bw + 1]];
            let lo = quad.iter().copied().fold(f32::INFINITY, f32::min);
            let hi = quad.iter().copied().fold(f32::NEG_INFINITY, f32::max);
            hi - lo > ACTIVITY_GATE_DENSITY
        })
        .collect();
    let voting = active.iter().filter(|&&v| v).count();
    if (voting as f32 / active.len() as f32) < ACTIVITY_MIN_FRACTION {
        return luma.to_vec();
    }

    let mut out = Vec::with_capacity(voting * 4 * b * b);
    for y in 0..hs {
        let sy = y / (2 * b);
        for x in 0..ws {
            if active[sy * sw + x / (2 * b)] {
                out.push(luma[y * width + x]);
            }
        }
    }
    out
}

/// One channel (0 = R, 1 = G, 2 = B) of the grid, sorted ascending.
pub fn sorted_channel(grid: &LogGrid, channel: usize) -> Vec<f32> {
    let mut out: Vec<f32> = grid.data.chunks_exact(3).map(|p| p[channel]).collect();
    out.sort_unstable_by(f32::total_cmp);
    out
}

/// Percentile `q` (0–100) of ascending `sorted`, linearly interpolated between
/// the two nearest ranks (NumPy's default method). NaN when `sorted` is empty.
pub fn percentile_of_sorted(sorted: &[f32], q: f32) -> f32 {
    let n = sorted.len();
    if n == 0 {
        return f32::NAN;
    }
    let rank = (n - 1) as f64 * f64::from(q.clamp(0.0, 100.0)) / 100.0;
    let lo = rank.floor() as usize;
    let hi = (lo + 1).min(n - 1);
    let t = rank - lo as f64;
    (f64::from(sorted[lo]) + f64::from(sorted[hi] - sorted[lo]) * t) as f32
}

/// Percentiles `qs` (each 0–100) of unsorted `values`; one sort for all of them.
pub fn percentiles(values: &[f32], qs: &[f32]) -> Vec<f32> {
    let mut sorted = values.to_vec();
    sorted.sort_unstable_by(f32::total_cmp);
    qs.iter().map(|&q| percentile_of_sorted(&sorted, q)).collect()
}

/// Percentile `q` (0–100) of unsorted `values`. NaN when empty.
pub fn percentile(values: &[f32], q: f32) -> f32 {
    percentiles(values, &[q])[0]
}

/// Median of unsorted `values`. NaN when empty.
pub fn median(values: &[f32]) -> f32 {
    percentile(values, 50.0)
}
