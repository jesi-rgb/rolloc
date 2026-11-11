//! Roll baseline: how a frame's own bounds resolve against the bounds pooled
//! across its roll. The orange mask and the film base are roll properties, so
//! normalizing against pooled bounds removes frame-to-frame colour drift.
//!
//! Port of NegPy 0.68 `mix_luma_color_bounds`, `resolve_bounds_detailed` and
//! `luma_source_bounds` (negpy/features/exposure/normalization.py). Mirrors
//! src/lib/image/negative/baseline.ts — change both together. Pooling itself
//! (`poolFrameBounds`) runs only in the app.

use super::constants::LUMA;
use super::types::{AppliedBaseline, LogBounds};

/// Luma-weighted centre and range from `luma_src`, per-channel shape from
/// `color_src` (NegPy `mix_luma_color_bounds`). The colour source's floors and
/// ceils shift by separate amounts so the result's luma centre and range — the
/// brightness and slope drivers — are the luma source's. Identity when both
/// sources are the same bounds, so a self-mix cannot stack.
pub fn mix_luma_color_bounds(luma_src: &LogBounds, color_src: &LogBounds) -> LogBounds {
    if luma_src == color_src {
        return *luma_src;
    }
    let w = LUMA.map(f64::from);
    let centre = |b: &LogBounds| -> f64 {
        (0..3)
            .map(|c| w[c] * (f64::from(b.floors[c]) + f64::from(b.ceils[c])) / 2.0)
            .sum()
    };
    let range = |b: &LogBounds| -> f64 {
        (0..3)
            .map(|c| w[c] * (f64::from(b.ceils[c]) - f64::from(b.floors[c])))
            .sum()
    };
    let d_centre = centre(luma_src) - centre(color_src);
    let d_range = range(luma_src) - range(color_src);
    let df = d_centre - d_range / 2.0;
    let dc = d_centre + d_range / 2.0;
    LogBounds {
        floors: color_src.floors.map(|v| (f64::from(v) + df) as f32),
        ceils: color_src.ceils.map(|v| (f64::from(v) + dc) as f32),
    }
}

/// The bounds a frame renders with (NegPy `resolve_bounds_detailed`): tonal
/// range from the baseline when `use_luma`, colour from it when `use_color`,
/// each otherwise from the frame's own `base`. No baseline → `base`.
pub fn resolve_bounds(base: &LogBounds, baseline: Option<&AppliedBaseline>) -> LogBounds {
    let Some(b) = baseline else {
        return *base;
    };
    let roll = b.bounds();
    if b.use_luma && b.use_color {
        return roll;
    }
    mix_luma_color_bounds(
        if b.use_luma { &roll } else { base },
        if b.use_color { &roll } else { base },
    )
}

/// The bounds the anchor is metered against (NegPy `luma_source_bounds`): the
/// baseline when `use_luma`, else the frame's own `base`. Metering here rather
/// than on the mix keeps brightness independent of the colour toggle.
pub fn luma_source_bounds(base: &LogBounds, baseline: Option<&AppliedBaseline>) -> LogBounds {
    match baseline {
        Some(b) if b.use_luma => b.bounds(),
        _ => *base,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Shared with src/lib/image/negative/baseline.test.ts; expectations from the verified TS.
    const BASE: LogBounds = LogBounds {
        floors: [-1.48, -1.83, -2.31],
        ceils: [-0.12, -0.52, -0.88],
    };
    const ROLL: LogBounds = LogBounds {
        floors: [-1.62, -1.91, -2.18],
        ceils: [-0.21, -0.46, -0.74],
    };
    const OTHER: LogBounds = LogBounds {
        floors: [-1.4, -1.8, -2.3],
        ceils: [-0.1, -0.5, -0.9],
    };

    fn applied(use_luma: bool, use_color: bool) -> AppliedBaseline {
        AppliedBaseline {
            floors: ROLL.floors,
            ceils: ROLL.ceils,
            use_luma,
            use_color,
            key: 1.0,
        }
    }

    fn assert_bounds(got: LogBounds, floors: [f32; 3], ceils: [f32; 3]) {
        for c in 0..3 {
            assert!((got.floors[c] - floors[c]).abs() < 1e-5, "floor {c}: {got:?}");
            assert!((got.ceils[c] - ceils[c]).abs() < 1e-5, "ceil {c}: {got:?}");
        }
    }

    fn luma_centre_range(b: &LogBounds) -> (f32, f32) {
        let mut centre = 0.0;
        let mut range = 0.0;
        for ((w, f), c) in LUMA.iter().zip(b.floors).zip(b.ceils) {
            centre += w * (f + c) / 2.0;
            range += w * (c - f);
        }
        (centre, range)
    }

    #[test]
    fn mix_takes_luma_from_one_and_shape_from_the_other() {
        let mixed = mix_luma_color_bounds(&ROLL, &OTHER);
        assert_bounds(
            mixed,
            [-1.51678, -1.91678, -2.41678],
            [-0.083226, -0.483226, -0.883226],
        );
        let (c, r) = luma_centre_range(&mixed);
        let (rc, rr) = luma_centre_range(&ROLL);
        assert!((c - rc).abs() < 1e-5 && (r - rr).abs() < 1e-5);
    }

    #[test]
    fn mix_of_a_bounds_with_itself_is_identity() {
        assert_eq!(mix_luma_color_bounds(&ROLL, &ROLL), ROLL);
    }

    #[test]
    fn no_baseline_renders_the_frame_bounds() {
        assert_eq!(resolve_bounds(&BASE, None), BASE);
        assert_eq!(luma_source_bounds(&BASE, None), BASE);
    }

    #[test]
    fn both_axes_render_the_baseline() {
        assert_eq!(resolve_bounds(&BASE, Some(&applied(true, true))), ROLL);
    }

    #[test]
    fn luma_only_keeps_the_frame_shape_at_the_roll_tonal_range() {
        let got = resolve_bounds(&BASE, Some(&applied(true, false)));
        assert_bounds(
            got,
            [-1.557594, -1.907594, -2.387594],
            [-0.086114, -0.486114, -0.846114],
        );
        let (c, r) = luma_centre_range(&got);
        let (rc, rr) = luma_centre_range(&ROLL);
        assert!((c - rc).abs() < 1e-5 && (r - rr).abs() < 1e-5);
    }

    #[test]
    fn colour_only_keeps_the_frame_tonal_range_with_the_roll_shape() {
        let got = resolve_bounds(&BASE, Some(&applied(false, true)));
        assert_bounds(
            got,
            [-1.542406, -1.832406, -2.102406],
            [-0.243886, -0.493886, -0.773886],
        );
        let (c, r) = luma_centre_range(&got);
        let (bc, br) = luma_centre_range(&BASE);
        assert!((c - bc).abs() < 1e-5 && (r - br).abs() < 1e-5);
    }

    #[test]
    fn both_axes_off_render_the_frame_bounds() {
        assert_eq!(resolve_bounds(&BASE, Some(&applied(false, false))), BASE);
    }

    #[test]
    fn anchor_meters_against_the_roll_only_with_its_tonal_range() {
        assert_eq!(luma_source_bounds(&BASE, Some(&applied(true, false))), ROLL);
        assert_eq!(luma_source_bounds(&BASE, Some(&applied(false, true))), BASE);
    }
}
