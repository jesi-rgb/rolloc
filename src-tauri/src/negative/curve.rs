//! Print curve of the negative pipeline: normalized negative value → print density.
//!
//! A straight line in density (optionally quadratic per channel, for Cast Removal) through a
//! variable-gamma paper S-curve and regional CMY, bounded by two independent softplus knees:
//! the shoulder rolls highlights into paper white, the toe rolls shadows into paper black.
//! Black point compensation maps paper black to display black.
//!
//! Port of NegPy 0.68 `CharacteristicCurve` and its helpers (negpy/features/exposure/logic.py),
//! the print curve kernel (negpy_core/src/print_curve.rs) and exposure.wgsl, at NegPy's defaults
//! with paper white off (`d_min = 0`), knee widths at the reference and BPC on. A B&W print
//! collapses the channels to one density first (`collapse_bw`) and prints it on the base curve.
//! Mirrors src/lib/image/negative/print-curve.ts and src/lib/image/shaders/hd_curve.wgsl —
//! change all three together.

use super::constants::{
    ANCHOR_TARGET_DENSITY, ASSUMED_ANCHOR, BW_FILTER_WEIGHTS_NONE, D_MAX, PAPER_GAMMA_WIDTH,
    PAPER_MIDTONE_GAMMA, REFERENCE_PRINT_DENSITY, REGIONAL_CMY_SHARPNESS, SHOULDER_GRADE_STRENGTH,
    SHOULDER_HEIGHT, SHOULDER_SHARPNESS_BASE, SLOPE_MAX, SLOPE_MIN, TOE_GRADE_STRENGTH, TOE_HEIGHT,
    TOE_SHARPNESS_BASE, TOE_SHOULDER_STRENGTH,
};

/// Bisection steps of `straight_line_target`, as NegPy.
const MIDTONE_BISECTION_STEPS: usize = 60;
/// Smallest slope `compute_pivot` divides by; a flatter one keeps the anchor as pivot.
const MIN_PIVOT_SLOPE: f32 = 1e-6;
/// Channel whose curve a B&W print uses: the base (green) curve; solve makes all three equal.
const BW_CHANNEL: usize = 1;

/// The solved print curve of one frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PrintCurveParams {
    /// Core per channel: v = k·(x − pivot) + curv·x², x = u + cmy_offset.
    pub slopes: [f32; 3],
    pub pivots: [f32; 3],
    pub curvatures: [f32; 3],
    /// Normalized-space filtration, added to u.
    pub cmy_offsets: [f32; 3],
    /// Absolute density, split by the regional weight.
    pub shadow_cmy: [f32; 3],
    pub highlight_cmy: [f32; 3],
    /// Effective (grade-coupled) slider values.
    pub toe: f32,
    pub shoulder: f32,
}

/// A print curve with its per-frame prologue resolved; `density` / `transmittance` are the
/// per-pixel path.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PrintCurve {
    p: PrintCurveParams,
    /// Centre of the paper S-curve.
    v_star: f32,
    /// Paper white and paper black of the knees.
    d_min_eff: f32,
    d_max_eff: f32,
    /// Shoulder (highlight) and toe (shadow) knee sharpness.
    a_hl: f32,
    a_sh: f32,
    /// Transmittance BPC maps to display black.
    bpc_black: f32,
}

/// NegPy `_inv_softplus_np`: log(exp(y) − 1), stable for y > 0.
fn inv_softplus(y: f64) -> f64 {
    if y > 20.0 {
        y
    } else {
        y.max(1e-12).exp_m1().ln()
    }
}

/// Overflow-free log(1 + exp(x)).
#[inline]
fn softplus(x: f32) -> f32 {
    x.max(0.0) + (-x.abs()).exp().ln_1p()
}

/// Overflow-free logistic sigmoid (NegPy `_fast_sigmoid`).
#[inline]
fn sigmoid(x: f32) -> f32 {
    if x >= 0.0 {
        1.0 / (1.0 + (-x).exp())
    } else {
        let z = x.exp();
        z / (1.0 + z)
    }
}

fn reference_linear_value_f64(target: f64) -> f64 {
    let (d_max, a_sh, a_hl) = (
        D_MAX as f64,
        TOE_SHARPNESS_BASE as f64,
        SHOULDER_SHARPNESS_BASE as f64,
    );
    let v1 = d_max - inv_softplus(a_sh * (d_max - target)) / a_sh;
    inv_softplus(a_hl * v1) / a_hl
}

/// Straight-line value v that the base knees (toe = shoulder = 0) map onto `target` (default
/// `REFERENCE_PRINT_DENSITY`). NegPy `_reference_linear_value` with `d_min = 0`: closed form
/// via the inverse softplus.
pub fn reference_linear_value(target: Option<f32>) -> f32 {
    reference_linear_value_f64(target.unwrap_or(REFERENCE_PRINT_DENSITY) as f64) as f32
}

/// The variable-gamma paper S-curve (NegPy `_through_midtone`), in f64 for the pivot solve.
fn through_midtone_f64(v: f64, v_star: f64) -> f64 {
    let (mg, w) = (PAPER_MIDTONE_GAMMA as f64, PAPER_GAMMA_WIDTH as f64);
    v + mg * w * ((v - v_star) / w).tanh()
}

/// Straight-line value that prints `target` through the S-curve and the base knees: the
/// inverse of the S-curve at `reference_linear_value(target)` (NegPy `_straight_line_target`).
fn straight_line_target(target: f64) -> f64 {
    let goal = reference_linear_value_f64(target);
    let v_star = reference_linear_value_f64(REFERENCE_PRINT_DENSITY as f64);
    let reach = (PAPER_MIDTONE_GAMMA as f64).abs() * PAPER_GAMMA_WIDTH as f64;
    let (mut lo, mut hi) = (goal - reach, goal + reach);
    for _ in 0..MIDTONE_BISECTION_STEPS {
        let mid = 0.5 * (lo + hi);
        if through_midtone_f64(mid, v_star) < goal {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    0.5 * (lo + hi)
}

/// Pivot that prints the anchor where the paper expects it (NegPy `compute_pivot` with the
/// density slider at neutral). A metered anchor lands on `ANCHOR_TARGET_DENSITY` through the
/// S-curve; `None` places `ASSUMED_ANCHOR` on the S-curve centre (NegPy `_anchor_linear_value`).
pub fn compute_pivot(slope: f32, anchor: Option<f32>) -> f32 {
    let reference = anchor.unwrap_or(ASSUMED_ANCHOR);
    if slope.is_nan() || slope <= MIN_PIVOT_SLOPE {
        return reference;
    }
    let v = match anchor {
        Some(_) => straight_line_target(ANCHOR_TARGET_DENSITY as f64),
        None => reference_linear_value_f64(REFERENCE_PRINT_DENSITY as f64),
    };
    (reference as f64 - v / slope as f64) as f32
}

/// Grade-coupled toe and shoulder (NegPy `grade_coupled_shape`): harder grades get a snappier
/// toe and a more compressed shoulder. `slope_g` is the green (base) slope.
pub fn grade_coupled_shape(slope_g: f32, toe: f32, shoulder: f32) -> (f32, f32) {
    let n = ((slope_g - SLOPE_MIN) / (SLOPE_MAX - SLOPE_MIN)).clamp(0.0, 1.0);
    (
        toe + TOE_GRADE_STRENGTH * n,
        shoulder + SHOULDER_GRADE_STRENGTH * n,
    )
}

/// One B&W density from the normalized channels, taken before the curve so channel differences
/// in the scan cannot tint the tone scale: NegPy's `collapse_matrix` row (`matmul_3x3` in
/// `PhotometricProcessor.process`) at `BW_FILTER_WEIGHTS[BwFilter.NONE]`. The weights sum to 1,
/// so a gray keeps its value.
#[inline]
pub fn collapse_bw(normalized: [f32; 3]) -> f32 {
    let [wr, wg, wb] = BW_FILTER_WEIGHTS_NONE;
    normalized[0] * wr + normalized[1] * wg + normalized[2] * wb
}

impl PrintCurve {
    /// Resolves the kernel prologue (negpy_core `print_curve.rs` prologue, `black_density_rgb`).
    /// The slider values are clamped to [-1, 1] as NegPy's `per_channel_toe_shoulder` does, then
    /// scaled by `TOE_SHOULDER_STRENGTH`. A negative toe sharpens the shadow knee instead of
    /// deepening black, and raises the BPC clip point by the same height.
    pub fn new(p: &PrintCurveParams) -> Self {
        let toe = p.toe.clamp(-1.0, 1.0) as f64 * TOE_SHOULDER_STRENGTH as f64;
        let shoulder = p.shoulder.clamp(-1.0, 1.0) as f64 * TOE_SHOULDER_STRENGTH as f64;
        let (d_max, toe_height) = (D_MAX as f64, TOE_HEIGHT as f64);
        let d_min_eff = (shoulder * SHOULDER_HEIGHT as f64).max(0.0);
        let negative_toe = toe < 0.0;
        let (d_max_base, a_sh, black_density) = if negative_toe {
            (
                d_max,
                TOE_SHARPNESS_BASE as f64 * (1.0 - toe * 4.0),
                d_max + toe * toe_height,
            )
        } else {
            (d_max - toe * toe_height, TOE_SHARPNESS_BASE as f64, d_max)
        };
        Self {
            p: *p,
            v_star: reference_linear_value(None),
            d_min_eff: d_min_eff as f32,
            d_max_eff: d_max_base.max(d_min_eff + 0.1) as f32,
            a_hl: SHOULDER_SHARPNESS_BASE,
            a_sh: a_sh as f32,
            bpc_black: 10f64.powf(-black_density) as f32,
        }
    }

    /// Print density of one channel at normalized value `u`, before black point compensation.
    /// A channel index past 2 reads blue.
    #[inline]
    pub fn density(&self, u: f32, channel: usize) -> f32 {
        let ch = channel.min(2);
        let p = &self.p;
        let (k, curv) = (p.slopes[ch], p.curvatures[ch]);
        let mut x = u + p.cmy_offsets[ch];
        // NegPy `quadratic_core`: held at the vertex where the quadratic would fold back.
        if curv != 0.0 {
            let vertex = -k / (2.0 * curv);
            if (curv > 0.0 && x < vertex) || (curv < 0.0 && x > vertex) {
                x = vertex;
            }
        }
        let mut v = k * (x - p.pivots[ch]) + curv * x * x;
        v += PAPER_MIDTONE_GAMMA
            * PAPER_GAMMA_WIDTH
            * ((v - self.v_star) / PAPER_GAMMA_WIDTH).tanh();
        let w = sigmoid(REGIONAL_CMY_SHARPNESS * (v - REFERENCE_PRINT_DENSITY));
        v += p.shadow_cmy[ch] * w + p.highlight_cmy[ch] * (1.0 - w);
        let v1 = self.d_min_eff + softplus(self.a_hl * (v - self.d_min_eff)) / self.a_hl;
        self.d_max_eff - softplus(self.a_sh * (self.d_max_eff - v1)) / self.a_sh
    }

    /// Black point compensation of one density: paper black → 0, clamped to [0, 1].
    #[inline]
    fn compensate(&self, density: f32) -> f32 {
        let tb = self.bpc_black;
        ((10f32.powf(-density) - tb) / (1.0 - tb)).clamp(0.0, 1.0)
    }

    /// Print transmittance 10^−D per channel after black point compensation, each in [0, 1].
    #[inline]
    pub fn transmittance(&self, normalized: [f32; 3]) -> [f32; 3] {
        std::array::from_fn(|ch| self.compensate(self.density(normalized[ch], ch)))
    }

    /// B&W print transmittance after black point compensation, in [0, 1]: the channels collapse
    /// to one density (`collapse_bw`), printed once on the base curve.
    #[inline]
    pub fn transmittance_bw(&self, normalized: [f32; 3]) -> f32 {
        self.compensate(self.density(collapse_bw(normalized), BW_CHANNEL))
    }
}

// Shared with src/lib/image/negative/print-curve.test.ts — change both together.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::negative::constants::NEUTRAL_AXIS_CURV_MAX_RATIO;

    const ZERO: [f32; 3] = [0.0; 3];
    const REFERENCE_SLOPE: f32 = 2.894;
    /// Analytic undershoot of the toe softplus below paper white (NegPy has it too).
    const KNEE_SLACK: f32 = 2e-4;
    const TOL: f32 = 1e-5;

    fn flat(slope: f32, pivot: f32, toe: f32, shoulder: f32) -> PrintCurveParams {
        PrintCurveParams {
            slopes: [slope; 3],
            pivots: [pivot; 3],
            curvatures: ZERO,
            cmy_offsets: ZERO,
            shadow_cmy: ZERO,
            highlight_cmy: ZERO,
            toe,
            shoulder,
        }
    }

    fn reference() -> PrintCurveParams {
        let (toe, shoulder) = grade_coupled_shape(REFERENCE_SLOPE, 0.0, 0.0);
        flat(
            REFERENCE_SLOPE,
            compute_pivot(REFERENCE_SLOPE, None),
            toe,
            shoulder,
        )
    }

    fn params() -> [PrintCurveParams; 4] {
        [
            reference(),
            PrintCurveParams {
                slopes: [3.1, 2.9, 2.7],
                pivots: [0.2, 0.21, 0.23],
                curvatures: [0.5, 0.0, -0.4],
                cmy_offsets: [0.05, -0.03, 0.02],
                shadow_cmy: [0.04, -0.02, 0.0],
                highlight_cmy: [-0.03, 0.01, 0.05],
                toe: 0.4,
                shoulder: 0.3,
            },
            PrintCurveParams {
                slopes: [4.0, 4.2, 3.8],
                pivots: [0.3, 0.3, 0.3],
                curvatures: [1.0, -1.0, 0.3],
                cmy_offsets: [-0.1, 0.1, 0.0],
                shadow_cmy: [0.0, 0.03, -0.04],
                highlight_cmy: [0.02, 0.0, -0.02],
                toe: -0.5,
                shoulder: -0.3,
            },
            flat(6.0, 0.35, 1.2, 1.0),
        ]
    }

    /// (params index, channel, u, density, transmittance).
    const TABLE: [(usize, usize, f32, f32, f32); 8] = [
        (1, 0, -0.1, 0.10959, 0.775856),
        (1, 1, 0.46, 0.691546, 0.199436),
        (1, 2, 1.0, 1.714917, 0.014339),
        (2, 0, 0.2, 0.028964, 0.934694),
        (2, 1, 0.7, 1.51598, 0.018613),
        (2, 2, 1.3, 2.3, 0.0),
        (3, 1, 0.0, 0.29763, 0.501431),
        (3, 1, 1.0, 1.535, 0.024284),
    ];

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < TOL
    }

    #[test]
    fn prints_the_reference_curve() {
        let c = PrintCurve::new(&reference());
        let expected = [0.048126, 0.202311, 0.860859, 1.721165, 2.184727];
        for (u, e) in [0.0, 0.2, 0.5, 0.8, 1.0].into_iter().zip(expected) {
            assert!(close(c.density(u, 1), e), "u {u}: {}", c.density(u, 1));
        }
    }

    #[test]
    fn solves_pivots_and_the_s_curve_centre() {
        assert!(close(reference_linear_value(None), 0.712891));
        assert!(close(compute_pivot(REFERENCE_SLOPE, None), 0.213666));
        let pivots = [
            (2.0, 0.103554, -0.016446),
            (2.9, 0.214175, 0.094175),
            (5.0, 0.317422, 0.197422),
            (10.0, 0.388711, 0.268711),
        ];
        for (slope, unmetered, metered) in pivots {
            assert!(close(compute_pivot(slope, None), unmetered));
            assert!(close(compute_pivot(slope, Some(0.34)), metered));
        }
    }

    #[test]
    fn keeps_the_anchor_as_pivot_for_a_degenerate_slope() {
        assert_eq!(compute_pivot(0.0, Some(0.5)), 0.5);
        assert_eq!(compute_pivot(f32::NAN, None), ASSUMED_ANCHOR);
    }

    #[test]
    fn prints_the_anchor_at_the_target_density() {
        for slope in [2.0, 2.9, 5.0, 10.0] {
            for anchor in [0.34, 0.46, 0.58] {
                let c = PrintCurve::new(&flat(slope, compute_pivot(slope, Some(anchor)), 0.0, 0.0));
                assert!((c.density(anchor, 1) - 0.75).abs() < 1e-3);
            }
            let c = PrintCurve::new(&flat(slope, compute_pivot(slope, None), 0.0, 0.0));
            assert!((c.density(ASSUMED_ANCHOR, 1) - 0.75).abs() < 1e-3);
        }
    }

    #[test]
    fn is_monotonic_and_bounded_by_paper_white_and_paper_black() {
        let (mut worst_drop, mut worst_excursion) = (0f32, f32::NEG_INFINITY);
        for slope in [2.0, 5.0, 10.0] {
            for ratio in [-1.0, -0.5, 0.0, 0.5, 1.0] {
                for toe in [-1.0f32, 0.0, 1.0] {
                    for shoulder in [-1.0f32, 0.0, 1.0] {
                        let curv = ratio * NEUTRAL_AXIS_CURV_MAX_RATIO * slope;
                        let c = PrintCurve::new(&PrintCurveParams {
                            curvatures: [curv; 3],
                            cmy_offsets: [0.05, 0.0, -0.05],
                            shadow_cmy: [0.2, -0.2, 0.0],
                            highlight_cmy: [-0.2, 0.2, 0.0],
                            ..flat(slope, 0.2, toe, shoulder)
                        });
                        let t = toe * TOE_SHOULDER_STRENGTH;
                        let d_min = (shoulder * TOE_SHOULDER_STRENGTH * SHOULDER_HEIGHT).max(0.0);
                        let d_max = if t < 0.0 {
                            D_MAX
                        } else {
                            D_MAX - t * TOE_HEIGHT
                        };
                        for ch in 0..3 {
                            let mut prev = f32::NEG_INFINITY;
                            for i in 0..=400 {
                                let d = c.density(-0.5 + i as f32 * 0.005, ch);
                                worst_drop = worst_drop.max(prev - d);
                                worst_excursion = worst_excursion.max(d_min - d).max(d - d_max);
                                prev = d;
                            }
                        }
                    }
                }
            }
        }
        assert_eq!(worst_drop, 0.0);
        assert!(worst_excursion <= KNEE_SLACK, "{worst_excursion}");
    }

    #[test]
    fn holds_the_quadratic_core_at_its_vertex_instead_of_folding_back() {
        let c = PrintCurve::new(&PrintCurveParams {
            curvatures: [0.9; 3],
            ..flat(2.0, -1.5, 0.0, 0.0)
        });
        let vertex = -2.0 / (2.0 * 0.9);
        assert!((c.density(-3.0, 0) - c.density(vertex, 0)).abs() < 1e-6);
        assert!(c.density(-1.0, 0) > c.density(vertex, 0));
    }

    #[test]
    fn maps_paper_black_to_display_black_and_never_exceeds_white() {
        for toe in [0.0, -0.3, -1.0] {
            let c = PrintCurve::new(&PrintCurveParams {
                toe,
                shoulder: 0.0,
                ..reference()
            });
            assert_eq!(c.transmittance([5.0; 3]), [0.0; 3]);
        }
        for p in params() {
            let c = PrintCurve::new(&p);
            for i in 0..=40 {
                for t in c.transmittance([-1.0 + i as f32 * 0.075; 3]) {
                    assert!((0.0..=1.0).contains(&t));
                }
            }
        }
    }

    #[test]
    fn prints_b_and_w_on_one_density_collapsed_from_the_channels() {
        let c = PrintCurve::new(&reference());
        let u = [0.3, 0.5, 0.7];
        let v = collapse_bw(u);
        assert!(close(v, 0.31 * 0.3 + 0.39 * 0.5 + 0.30 * 0.7));
        assert!(close(c.density(v, 1), 0.855261), "{}", c.density(v, 1));
        assert!(close(c.transmittance_bw(u), 0.135219), "{}", c.transmittance_bw(u));
        // The weights sum to 1: a gray keeps its value, so it prints as before the collapse.
        for u in [-0.2, 0.25, 0.5, 1.1] {
            assert!(close(collapse_bw([u; 3]), u));
            assert!(close(c.transmittance_bw([u; 3]), c.transmittance([u; 3])[1]));
        }
    }

    #[test]
    fn matches_the_shared_vectors() {
        let ps = params();
        for (i, ch, u, d, t) in TABLE {
            let c = PrintCurve::new(&ps[i]);
            let mut normalized = [0.0; 3];
            normalized[ch] = u;
            assert!(
                close(c.density(u, ch), d),
                "{i} {ch} {u}: {}",
                c.density(u, ch)
            );
            assert!(close(c.transmittance(normalized)[ch], t), "{i} {ch} {u}");
        }
    }
}
