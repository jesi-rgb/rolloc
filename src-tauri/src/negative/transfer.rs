//! Transparency transfer: the render of a slide, "the slide as captured".
//!
//! A slide is already a positive, so it is not metered: it normalizes over a fixed window from
//! the source's white level (density 0) down `TRANSFER_DENSITY_RANGE` decades, the same for every
//! frame (`transfer_bounds`), and the transfer curve inverts that window exactly. At default
//! settings `10^−D` returns the source's linear value; the controls deviate from there:
//!   1. D = k·(n + cmy_offset − pivot)                        (solve: k = R, pivot = 0)
//!   2. D += shadow_cmy·w + highlight_cmy·(1 − w), w = σ(k_wb·(D − c_wb))   (regional CMY)
//!   3. D −= toe · softplus(D − toe_knee, width)              (shadow roll-off)
//!   4. D += shoulder · softplus(shoulder_knee − D, width)    (highlight roll-off)
//!   5. a scene-linear (RAW) source: ODT(2^baseline_ev · 10^−D), Narkowicz's ACES fit;
//!      a display-referred (8-bit) source: 10^−D re-expanded with the standard display gamma.
//! The tone-preset encode and the tone stage after it are the negatives' own (process.rs).
//!
//! Port of NegPy 0.68 `apply_transfer_curve`, `transfer_bounds`, `wb_split_geometry` and
//! `display_rendering` (negpy/features/transparency/logic.py, negpy_core/src/transfer.rs) and
//! `camera_to_working_matrix` (negpy/features/process/capture_color.py), at Rolloc's neutral
//! density and grade (exposure offset 0, contrast 1) and the reference knee width. Mirrors
//! src/lib/image/negative/transfer.ts and the E6 branch of src/lib/image/shaders/hd_curve.wgsl —
//! change all three together. The slide picker (`slidePickWb`) is UI-only and has no mirror here.

use super::constants::{
    D_MAX, D_MIN, REFERENCE_PRINT_DENSITY, REGIONAL_CMY_SHARPNESS, STANDARD_TONE_GAMMA,
    TRANSFER_BASELINE_EV, TRANSFER_CONTRAST_PIVOT, TRANSFER_DENSITY_RANGE, TRANSFER_KNEE_WIDTH,
    TRANSFER_SHOULDER_KNEE, TRANSFER_TOE_KNEE,
};
use super::curve::PrintCurveParams;
use super::types::LogBounds;

/// Smallest determinant / row sum the camera matrix construction divides by (NegPy's 1e-9).
const MATRIX_EPS: f64 = 1e-9;

/// The fixed window a slide normalizes with (NegPy `transfer_bounds`): the source's white level
/// (log10 = 0) down `TRANSFER_DENSITY_RANGE` decades, so `n = D / R`. Content-independent on
/// purpose: two exposures of one slide must not converge on one render.
pub fn transfer_bounds() -> LogBounds {
    LogBounds {
        floors: [0.0; 3],
        ceils: [-TRANSFER_DENSITY_RANGE; 3],
    }
}

/// Normalized position of a properly exposed slide's midtone on the fixed window (NegPy
/// `transfer_assumed_anchor`): the anchor a slide's analysis carries, since nothing is metered.
pub fn transfer_assumed_anchor() -> f32 {
    TRANSFER_CONTRAST_PIVOT / TRANSFER_DENSITY_RANGE
}

/// `(centre, sharpness)` of the shadow/highlight CMY split on the transfer's density scale
/// (NegPy `wb_split_geometry`): the print's split, centred on the reference print density with
/// `REGIONAL_CMY_SHARPNESS`, carried across by tonal position rather than by raw density.
pub fn wb_split_geometry() -> (f32, f32) {
    let span = D_MAX - D_MIN;
    (
        (REFERENCE_PRINT_DENSITY - D_MIN) / span * TRANSFER_DENSITY_RANGE,
        REGIONAL_CMY_SHARPNESS * span / TRANSFER_DENSITY_RANGE,
    )
}

/// Scene-linear → display-linear (NegPy `display_rendering`): Narkowicz's closed-form fit to the
/// ACES RRT + sRGB ODT. Monotonic on [0, ∞), 0 → 0, clamped to 1.
#[inline]
pub fn display_rendering(scene_linear: f32) -> f32 {
    let x = scene_linear.max(0.0);
    let num = x * (2.51 * x + 0.03);
    let den = x * (2.43 * x + 0.59) + 0.14;
    (num / den.max(1e-8)).clamp(0.0, 1.0)
}

/// IEC 61966-2-1 sRGB OETF: the inverse of the EOTF every 8-bit source was expanded with.
#[inline]
fn srgb_encode(linear: f32) -> f32 {
    if linear <= 0.0031308 {
        linear * 12.92
    } else {
        1.055 * linear.powf(1.0 / 2.4) - 0.055
    }
}

/// Overflow-free logistic sigmoid.
#[inline]
fn sigmoid(x: f32) -> f32 {
    if x >= 0.0 {
        1.0 / (1.0 + (-x).exp())
    } else {
        let z = x.exp();
        z / (1.0 + z)
    }
}

/// `width · log(1 + exp(−|x| / width))`: NegPy's `_softplus(x, width)` less its `max(x, 0)` part,
/// which the knees apply as a pull toward the knee instead.
#[inline]
fn softplus_tail(x: f32, width: f32) -> f32 {
    width * (-x.abs() / width).exp().ln_1p()
}

/// Inverse of a row-major 3×3 in f64, or `None` when singular or not finite.
fn invert3(m: &[f64; 9]) -> Option<[f64; 9]> {
    let [a, b, c, d, e, f, g, h, i] = *m;
    let (c00, c01, c02) = (e * i - f * h, f * g - d * i, d * h - e * g);
    let det = a * c00 + b * c01 + c * c02;
    if !det.is_finite() || det.abs() < MATRIX_EPS {
        return None;
    }
    Some([
        c00 / det,
        (c * h - b * i) / det,
        (b * f - c * e) / det,
        c01 / det,
        (a * i - c * g) / det,
        (c * d - a * f) / det,
        c02 / det,
        (b * g - a * h) / det,
        (a * e - b * d) / det,
    ])
}

/// Linear-light matrix a RAW slide goes through before the log: camera-native RGB, decoded without
/// white balance, to linear sRGB with the as-shot balance folded back in (NegPy
/// `camera_to_working_matrix` with `camera_wb`).
///
/// `camera_color_matrix` is rawler's `cam_to_xyz_normalized` (its XYZ→camera rows normalized so
/// XYZ (1, 1, 1) reads as camera neutral) followed by XYZ→linear sRGB, so a balanced camera
/// neutral lands off neutral. NegPy normalizes the working→camera rows instead (dcraw's order),
/// which is this matrix with its columns scaled by `M⁻¹·(1, 1, 1)`: the rows then sum to 1, so a
/// balanced neutral stays neutral. The decode skips the as-shot multipliers on the inversion
/// path, so they are folded in, normalized to green. A singular or non-finite matrix applies no
/// primaries; an invalid white balance (non-finite or not positive) folds nothing.
pub fn slide_camera_matrix(camera_color_matrix: &[f32; 9], as_shot_wb: [f32; 3]) -> [f32; 9] {
    let m = camera_color_matrix.map(f64::from);
    let sums = m
        .iter()
        .all(|v| v.is_finite())
        .then(|| invert3(&m))
        .flatten()
        .map(|inv| std::array::from_fn::<f64, 3, _>(|r| inv[r * 3] + inv[r * 3 + 1] + inv[r * 3 + 2]))
        .filter(|s| s.iter().all(|v| v.abs() >= MATRIX_EPS));
    let wb = as_shot_wb.map(f64::from);
    let gains = if wb.iter().all(|v| v.is_finite() && *v > 0.0) {
        [wb[0] / wb[1], 1.0, wb[2] / wb[1]]
    } else {
        [1.0; 3]
    };
    std::array::from_fn(|k| {
        let (r, c) = (k / 3, k % 3);
        let primary = match sums {
            Some(s) => m[k] * s[c],
            None if r == c => 1.0,
            None => 0.0,
        };
        (primary * gains[c]) as f32
    })
}

/// The transfer of one slide, resolved from its solved curve (`negative::solve` for `E6`) and
/// how its source is encoded; `density` / `display` are the per-pixel path.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Transfer {
    p: PrintCurveParams,
    /// Regional CMY split centre and sharpness (`wb_split_geometry`).
    split_centre: f32,
    split_sharpness: f32,
    /// Linear gain of the baseline exposure, 2^`TRANSFER_BASELINE_EV`.
    baseline_gain: f32,
    /// A scene-linear (RAW) source; false for a display-referred (8-bit) one.
    scene_linear: bool,
}

impl Transfer {
    pub fn new(p: &PrintCurveParams, scene_linear: bool) -> Self {
        let (split_centre, split_sharpness) = wb_split_geometry();
        Self {
            p: *p,
            split_centre,
            split_sharpness,
            baseline_gain: 2f32.powf(TRANSFER_BASELINE_EV),
            scene_linear,
        }
    }

    /// Density of one channel at normalized value `n`: steps 1–4 of the module header. Every
    /// term vanishes at its neutral value, so at defaults this is exactly `R · n`. A channel
    /// index past 2 reads blue.
    ///
    /// The knees are NegPy's `D − toe·softplus(D − toe_knee)` and `D + shoulder·softplus(
    /// shoulder_knee − D)`. Past a knee the linear part of the softplus is applied as
    /// `(1 − a)·D + a·knee`, the same value without cancelling D against itself, so a full
    /// roll-off flattens onto the knee and stays monotonic in f32.
    #[inline]
    pub fn density(&self, n: f32, channel: usize) -> f32 {
        let ch = channel.min(2);
        let p = &self.p;
        let mut d = p.slopes[ch] * (n + p.cmy_offsets[ch] - p.pivots[ch]);
        let (s, h) = (p.shadow_cmy[ch], p.highlight_cmy[ch]);
        if s != 0.0 || h != 0.0 {
            let w = sigmoid(self.split_sharpness * (d - self.split_centre));
            d += s * w + h * (1.0 - w);
        }
        if p.toe != 0.0 {
            let (a, k) = (p.toe, TRANSFER_TOE_KNEE);
            let x = d - k;
            let pulled = if x > 0.0 { (1.0 - a) * d + a * k } else { d };
            d = pulled - a * softplus_tail(x, TRANSFER_KNEE_WIDTH);
        }
        if p.shoulder != 0.0 {
            let (a, k) = (p.shoulder, TRANSFER_SHOULDER_KNEE);
            let x = k - d;
            let pulled = if x > 0.0 { (1.0 - a) * d + a * k } else { d };
            d = pulled + a * softplus_tail(x, TRANSFER_KNEE_WIDTH);
        }
        d
    }

    /// Scene-linear transmittance `10^−D` per channel: the source's own value at defaults.
    #[inline]
    pub fn linear(&self, normalized: [f32; 3]) -> [f32; 3] {
        std::array::from_fn(|ch| 10f32.powf(-self.density(normalized[ch], ch)))
    }

    /// The display-linear value per channel that the tone-preset encode receives (step 5), each
    /// in [0, 1]. A scene-linear source (a RAW capture, anchored to the sensor white level) gets
    /// NegPy's baseline exposure and display rendering. A display-referred source (an 8-bit scan,
    /// expanded with the sRGB EOTF upstream) skips both, as NegPy's Positive path does, and is
    /// re-expanded with `STANDARD_TONE_GAMMA` so the standard preset's encode returns the
    /// source's own code values.
    #[inline]
    pub fn display(&self, normalized: [f32; 3]) -> [f32; 3] {
        self.linear(normalized).map(|v| {
            if self.scene_linear {
                display_rendering(v * self.baseline_gain)
            } else {
                srgb_encode(v.clamp(0.0, 1.0)).powf(STANDARD_TONE_GAMMA)
            }
        })
    }
}

// Shared with src/lib/image/negative/transfer.test.ts — change both together.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::negative::constants::CMY_MAX_DENSITY;
    use crate::negative::{solve, FilmCurve, Normalizer, PrintInputs};
    use crate::negative::types::{FilmType, NegativeAnalysis};

    /// Any analysis: a slide's solve must not read it.
    fn analysis() -> NegativeAnalysis {
        NegativeAnalysis {
            version: 1,
            floors: [-1.4, -1.8, -2.2],
            ceils: [-0.5, -0.7, -1.0],
            anchor: 0.4,
            textural_range: 0.6,
            neutral_axis: None,
            baseline_key: None,
        }
    }

    fn slide_inputs() -> PrintInputs {
        PrintInputs {
            film_type: FilmType::E6,
            ..PrintInputs::default()
        }
    }

    fn slide(inputs: PrintInputs, scene_linear: bool) -> Transfer {
        Transfer::new(&solve(&inputs, &analysis(), None).1, scene_linear)
    }

    fn edited() -> PrintInputs {
        PrintInputs {
            cmy: [0.2, -0.3, 0.0],
            shadow_cmy: [0.0, 0.0, 0.4],
            highlight_cmy: [-0.25, 0.0, 0.0],
            toe: 0.3,
            shoulder: -0.2,
            ..slide_inputs()
        }
    }

    /// (n, density, scene-linear display, display-referred display), per channel, at `edited`.
    #[rustfmt::skip]
    const TABLE: [(f32, [f32; 3], [f32; 3], [f32; 3]); 6] = [
        (-0.1, [-0.459106, -0.520897, -0.445742], [0.98198, 0.988717, 0.980394], [1.0, 1.0, 1.0]),
        (0.0, [-0.112789, -0.176225, -0.098242], [0.920693, 0.935708, 0.916948], [1.0, 1.0, 1.0]),
        (0.2, [0.551887, 0.481417, 0.571424], [0.585685, 0.638712, 0.570424], [0.286219, 0.336777, 0.273547]),
        (0.45, [1.302736, 1.223286, 1.330501], [0.092601, 0.120786, 0.084191], [0.04625, 0.056678, 0.043044]),
        (0.8, [2.165816, 2.092316, 2.194573], [0.004368, 0.005582, 0.003974], [0.003558, 0.004613, 0.003203]),
        (1.1, [2.814672, 2.744078, 2.842813], [0.000638, 0.000772, 0.000592], [0.000179, 0.000256, 0.000155]),
    ];

    /// A camera's cam→linear sRGB matrix as raw.rs builds it (dcraw's Canon 5D Mark II).
    #[rustfmt::skip]
    const CAMERA: [f32; 9] = [
        2.220265, -1.245972, 0.230507,
        -0.040725, 1.288371, -0.299246,
        0.038354, -0.357347, 1.227694,
    ];
    const AS_SHOT_WB: [f32; 3] = [2.1, 1.0, 1.45];
    /// NegPy `camera_to_working_matrix(cam_xyz, camera_wb)` with sRGB as the working space.
    #[rustfmt::skip]
    const SLIDE_MATRIX: [f32; 9] = [
        4.343216, -1.320345, 0.365613,
        -0.079665, 1.365275, -0.474642,
        0.075027, -0.378677, 1.947278,
    ];

    /// Normalized value of a linear source value over the fixed window.
    fn normalize(linear: f32) -> f32 {
        Normalizer::new(&transfer_bounds()).apply([linear; 3])[1]
    }

    fn srgb_to_linear(c: f32) -> f32 {
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    }

    #[test]
    fn returns_the_source_linear_value_at_default_settings_across_the_window() {
        let t = slide(slide_inputs(), true);
        for i in 0..=100 {
            let linear = 10f32.powf(-3.0 * i as f32 / 100.0);
            for (ch, v) in t.linear([normalize(linear); 3]).into_iter().enumerate() {
                assert!((v - linear).abs() < 1e-5, "channel {ch}: {v} vs {linear}");
            }
        }
    }

    #[test]
    fn displays_an_8_bit_source_unchanged_through_the_standard_tone_preset() {
        let curve = FilmCurve::new(FilmType::E6, &solve(&slide_inputs(), &analysis(), None).1, false);
        let normalizer = Normalizer::new(&transfer_bounds());
        let mut worst = 0f32;
        for code in 0..256 {
            let linear = srgb_to_linear(code as f32 / 255.0);
            let shown = curve.render(normalizer.apply([linear; 3]))[1].powf(1.0 / STANDARD_TONE_GAMMA);
            worst = worst.max((shown * 255.0 - code as f32).abs());
        }
        // Only code 0 moves: the log floors it at 1e-6 linear.
        assert!(worst < 0.004, "worst {worst}");
    }

    #[test]
    fn gives_a_raw_capture_the_baseline_exposure_and_display_rendering() {
        let t = slide(slide_inputs(), true);
        assert!((t.display([normalize(0.18); 3])[1] - 0.429346).abs() < 1e-5);
        assert!((t.display([normalize(1.0); 3])[1] - 0.888354).abs() < 1e-5);
        assert_eq!(display_rendering(0.0), 0.0);
        assert_eq!(display_rendering(1e6), 1.0);
        let mut previous = f32::INFINITY;
        for i in -60..=300 {
            let v = t.display([i as f32 / 100.0; 3])[1];
            assert!(v <= previous && (0.0..=1.0).contains(&v), "n {i}: {v}");
            previous = v;
        }
        assert!(previous < 1e-8);
    }

    #[test]
    fn shifts_green_density_by_cmy_max_density_per_unit_of_magenta() {
        let t = slide(PrintInputs { cmy: [0.0, 1.0, 0.0], ..slide_inputs() }, true);
        for n in [0.0, 0.25, 0.5, 1.0] {
            assert!((t.density(n, 0) - 3.0 * n).abs() < 1e-5);
            assert!((t.density(n, 1) - 3.0 * n - CMY_MAX_DENSITY).abs() < 1e-5);
            assert!((t.density(n, 2) - 3.0 * n).abs() < 1e-5);
        }
    }

    #[test]
    fn splits_shadow_and_highlight_filtration_about_the_transfer_centre() {
        let shadow = slide(PrintInputs { shadow_cmy: [0.0, 1.0, 0.0], ..slide_inputs() }, true);
        let highlight = slide(PrintInputs { highlight_cmy: [0.0, 1.0, 0.0], ..slide_inputs() }, true);
        let shift = |t: &Transfer, n: f32| t.density(n, 1) - 3.0 * n;
        // Full on the own end, faded on the other, half each at the centre (D 0.924).
        assert!(shift(&shadow, 1.0) > 0.99 * CMY_MAX_DENSITY);
        assert!(shift(&shadow, -1.0 / 3.0) < 0.02 * CMY_MAX_DENSITY);
        assert!(shift(&highlight, -1.0 / 3.0) > 0.98 * CMY_MAX_DENSITY);
        assert!(shift(&highlight, 1.0) < 0.01 * CMY_MAX_DENSITY);
        assert!((shift(&shadow, 0.308) - CMY_MAX_DENSITY / 2.0).abs() < 5e-5);
        assert!((shift(&shadow, 0.0) + shift(&highlight, 0.0) - CMY_MAX_DENSITY).abs() < 1e-6);
        assert_eq!(shadow.density(0.5, 0), 1.5);
    }

    #[test]
    fn moves_only_its_own_end_of_the_scale_with_toe_and_shoulder_and_stays_monotonic() {
        for amount in [-1.0f32, -0.5, 0.5, 1.0] {
            let toe = slide(PrintInputs { toe: amount, ..slide_inputs() }, true);
            let shoulder = slide(PrintInputs { shoulder: amount, ..slide_inputs() }, true);
            assert!((toe.density(1.0, 0) - 3.0).abs() > 0.7 * amount.abs());
            assert!(toe.density(0.0, 0).abs() < 0.013 * amount.abs());
            assert!(shoulder.density(0.0, 0).abs() > 0.5 * amount.abs());
            assert!((shoulder.density(1.0, 0) - 3.0).abs() < 0.0013 * amount.abs());
            for t in [toe, shoulder] {
                let mut previous = f32::NEG_INFINITY;
                for i in -60..=300 {
                    let d = t.density(i as f32 / 100.0, 0);
                    assert!(d >= previous, "amount {amount}, n {i}: {d} < {previous}");
                    previous = d;
                }
            }
        }
    }

    #[test]
    fn matches_the_shared_vectors() {
        let scene = slide(edited(), true);
        let display = slide(edited(), false);
        for (n, density, rendered, referred) in TABLE {
            let got_scene = scene.display([n; 3]);
            let got_referred = display.display([n; 3]);
            for ch in 0..3 {
                assert!((scene.density(n, ch) - density[ch]).abs() < 1e-5, "n {n} ch {ch}");
                assert!((got_scene[ch] - rendered[ch]).abs() < 1e-5, "n {n} ch {ch}");
                assert!((got_referred[ch] - referred[ch]).abs() < 1e-5, "n {n} ch {ch}");
            }
        }
    }

    #[test]
    fn camera_matrix_is_negpys_working_matrix_with_the_as_shot_balance_folded_in() {
        let m = slide_camera_matrix(&CAMERA, AS_SHOT_WB);
        for (got, want) in m.iter().zip(SLIDE_MATRIX) {
            assert!((got - want).abs() < 1e-5, "{m:?}");
        }
        // An unbalanced camera neutral lands on display neutral.
        for r in 0..3 {
            let row: f32 = (0..3).map(|c| m[r * 3 + c] / AS_SHOT_WB[c]).sum();
            assert!((row - 1.0).abs() < 1e-5);
        }
    }

    #[test]
    fn camera_matrix_applies_no_primaries_without_a_usable_matrix_and_folds_no_invalid_balance() {
        let identity = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
        assert_eq!(slide_camera_matrix(&identity, [1.0; 3]), identity);
        assert_eq!(
            slide_camera_matrix(&[0.0; 9], [2.0, 1.0, 1.5]),
            [2.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.5]
        );
        assert_eq!(
            slide_camera_matrix(&CAMERA, [f32::NAN, 1.0, 1.0]),
            slide_camera_matrix(&CAMERA, [1.0; 3])
        );
        assert!(slide_camera_matrix(&CAMERA, [2.0, 1.0, 0.0]).iter().all(|v| v.is_finite()));
    }
}
