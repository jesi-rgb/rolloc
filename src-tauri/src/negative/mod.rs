//! Negative conversion: analysis of a frame's density window and meters, and
//! the print curve solved from them; a slide gets the transparency transfer
//! instead. Ported from NegPy 0.68; mirrors src/lib/image/negative/ module for
//! module, so the WebGPU preview, the native export and the thumbnails render
//! the same picture.

pub mod baseline;
pub mod bounds;
pub mod cast;
pub mod constants;
pub mod curve;
pub mod filtration;
pub mod grade;
pub mod grid;
pub mod meter;
pub mod transfer;
pub mod types;

use constants::{ANALYSIS_BUFFER, AUTO_GRADE_NOMINAL_RANGE, TRANSFER_DENSITY_RANGE};
use curve::{PrintCurve, PrintCurveParams};
use transfer::Transfer;
use types::{AppliedBaseline, FilmType, LogBounds, NegativeAnalysis, ANALYSIS_VERSION};

/// The user-set inputs of the print curve solve (the subset of
/// `InversionParams` that shapes the base curve). The default is an untouched
/// colour negative, which is what a thumbnail renders.
#[derive(Debug, Clone, Copy)]
pub struct PrintInputs {
    pub film_type: FilmType,
    /// Auto Density: follow the metered anchor instead of the assumed one.
    pub auto_exposure: bool,
    /// Cast Removal strength, 0–1.
    pub cast_removal: f32,
    /// Global filtration sliders (cyan, magenta, yellow), each in [-1, 1].
    pub cmy: [f32; 3],
    pub shadow_cmy: [f32; 3],
    pub highlight_cmy: [f32; 3],
    pub toe: f32,
    pub shoulder: f32,
}

impl Default for PrintInputs {
    fn default() -> Self {
        Self {
            film_type: FilmType::C41,
            auto_exposure: true,
            cast_removal: 0.5,
            cmy: [0.0; 3],
            shadow_cmy: [0.0; 3],
            highlight_cmy: [0.0; 3],
            toe: 0.0,
            shoulder: 0.0,
        }
    }
}

/// Measure a negative, or describe a slide: `rgb` is linear camera-native
/// interleaved RGB.
///
/// The frame's own bounds are measured regardless of `baseline`; the baseline
/// decides which bounds the anchor and the neutral axis read. A slide is not
/// metered: the transfer's fixed window and the neutral meters, with the
/// baseline's key recorded only so `is_current` treats every film type alike.
/// Mirrors `analyzeNegative` in src/lib/image/negative/analysis.ts.
pub fn analyze(
    rgb: &[f32],
    width: usize,
    height: usize,
    film_type: FilmType,
    baseline: Option<&AppliedBaseline>,
) -> NegativeAnalysis {
    if film_type == FilmType::E6 {
        let bounds = transfer::transfer_bounds();
        return NegativeAnalysis {
            version: ANALYSIS_VERSION,
            floors: bounds.floors,
            ceils: bounds.ceils,
            anchor: transfer::transfer_assumed_anchor(),
            textural_range: AUTO_GRADE_NOMINAL_RANGE,
            neutral_axis: None,
            baseline_key: baseline.map(|b| b.key),
        };
    }
    let grid = grid::prefilter_log_grid(rgb, width, height, ANALYSIS_BUFFER);
    let base = bounds::analyze_log_bounds(&grid);
    let final_bounds = baseline::resolve_bounds(&base, baseline);
    NegativeAnalysis {
        version: ANALYSIS_VERSION,
        floors: base.floors,
        ceils: base.ceils,
        // Brightness must not depend on the colour-average toggle, so the
        // anchor reads the luma source's bounds, not the final mix.
        anchor: meter::measure_anchor(&grid, &baseline::luma_source_bounds(&base, baseline)),
        textural_range: grade::measure_textural_range(&grid),
        neutral_axis: if film_type == FilmType::C41 {
            cast::measure_neutral_axis(&grid, &final_bounds)
        } else {
            None
        },
        baseline_key: baseline.map(|b| b.key),
    }
}

/// Whether a cached analysis can stand in for a fresh measurement: same
/// analysis version, and metered against the baseline that applies now.
pub fn is_current(analysis: &NegativeAnalysis, baseline: Option<&AppliedBaseline>) -> bool {
    analysis.version == ANALYSIS_VERSION && analysis.baseline_key == baseline.map(|b| b.key)
}

/// The bounds to normalize with and the per-channel print curve. Mirrors
/// `solvePrintCurve` in src/lib/image/negative/solve.ts.
pub fn solve(
    inputs: &PrintInputs,
    analysis: &NegativeAnalysis,
    baseline: Option<&AppliedBaseline>,
) -> (LogBounds, PrintCurveParams) {
    if inputs.film_type == FilmType::E6 {
        return solve_transfer(inputs);
    }
    let bounds = baseline::resolve_bounds(&analysis.bounds(), baseline);
    let slope = grade::base_slope(&bounds, analysis.textural_range);
    let anchor = inputs.auto_exposure.then_some(analysis.anchor);

    // Cast Removal balances the colour layers of a colour negative; without it
    // (or without trustworthy neutrals) all three channels share one line.
    let cast = if inputs.film_type == FilmType::C41 {
        cast::cast_curve_params(
            slope,
            anchor,
            inputs.cast_removal,
            analysis.neutral_axis.as_ref(),
            &bounds,
        )
    } else {
        None
    };
    let (slopes, pivots, curvatures) = match cast {
        Some(c) => (c.slopes, c.pivots, c.curvatures),
        None => (
            [slope; 3],
            [curve::compute_pivot(slope, anchor); 3],
            [0.0; 3],
        ),
    };

    let (toe, shoulder) = curve::grade_coupled_shape(slopes[1], inputs.toe, inputs.shoulder);
    // B&W drops the colour filtration (NegPy `printed_exposure`): a B&W print collapses to
    // one density, which the nine per-channel CMY values would only shift unpredictably.
    let colour = inputs.film_type != FilmType::Bw;
    let cmy = |sliders: [f32; 3]| if colour { sliders } else { [0.0; 3] };
    let params = PrintCurveParams {
        slopes,
        pivots,
        curvatures,
        cmy_offsets: filtration::filtration_offsets(cmy(inputs.cmy), &bounds),
        shadow_cmy: filtration::regional_cmy(cmy(inputs.shadow_cmy)),
        highlight_cmy: filtration::regional_cmy(cmy(inputs.highlight_cmy)),
        toe,
        shoulder,
    };
    (bounds, params)
}

/// The transparency transfer of a slide (NegPy `TransferProcessor.process` at exposure offset 0
/// and contrast 1) as a straight line `D = R·(n + cmy_offset)` over the fixed window. Nothing in
/// it reads the frame: no metering, no roll baseline. Toe and shoulder are the sliders
/// themselves, clamped as NegPy's `per_channel_toe_shoulder` does; the paper's grade coupling
/// does not apply. Mirrors `solveTransfer` in src/lib/image/negative/solve.ts.
fn solve_transfer(inputs: &PrintInputs) -> (LogBounds, PrintCurveParams) {
    let bounds = transfer::transfer_bounds();
    let params = PrintCurveParams {
        slopes: [TRANSFER_DENSITY_RANGE; 3],
        pivots: [0.0; 3],
        curvatures: [0.0; 3],
        cmy_offsets: filtration::filtration_offsets(inputs.cmy, &bounds),
        shadow_cmy: filtration::regional_cmy(inputs.shadow_cmy),
        highlight_cmy: filtration::regional_cmy(inputs.highlight_cmy),
        toe: inputs.toe.clamp(-1.0, 1.0),
        shoulder: inputs.shoulder.clamp(-1.0, 1.0),
    };
    (bounds, params)
}

/// The linear-light matrix the normalization applies before the log: a RAW slide's camera matrix
/// with the as-shot white balance folded back in (the inversion path always decodes RAW without
/// it), `None` for negatives and display-referred slides. Mirrors `sourceMatrixFor` in
/// src/lib/image/pipeline.ts.
pub fn source_matrix(
    film_type: FilmType,
    scene_linear: bool,
    camera_color_matrix: &[f32; 9],
    as_shot_wb: [f32; 3],
) -> Option<[f32; 9]> {
    (film_type == FilmType::E6 && scene_linear)
        .then(|| transfer::slide_camera_matrix(camera_color_matrix, as_shot_wb))
}

/// The curve a normalized pixel renders through, up to the tone-preset encode: a negative's print
/// curve or a slide's transfer. Mirrors the film-type branches of `fs_main` in hd_curve.wgsl.
#[derive(Debug, Clone, Copy)]
pub enum FilmCurve {
    Colour(PrintCurve),
    /// One density collapsed from the channels, printed once on the base curve.
    Bw(PrintCurve),
    Slide(Transfer),
}

impl FilmCurve {
    /// `scene_linear`: the source is a RAW capture rather than display-referred (only a slide's
    /// transfer reads it).
    pub fn new(film_type: FilmType, params: &PrintCurveParams, scene_linear: bool) -> Self {
        match film_type {
            FilmType::C41 => Self::Colour(PrintCurve::new(params)),
            FilmType::Bw => Self::Bw(PrintCurve::new(params)),
            FilmType::E6 => Self::Slide(Transfer::new(params, scene_linear)),
        }
    }

    /// Display-linear value per channel, each in [0, 1]: the print's transmittance after black
    /// point compensation (a B&W print's one value in every channel), or the transfer's display
    /// value.
    #[inline]
    pub fn render(&self, normalized: [f32; 3]) -> [f32; 3] {
        match self {
            Self::Colour(c) => c.transmittance(normalized),
            Self::Bw(c) => [c.transmittance_bw(normalized); 3],
            Self::Slide(t) => t.display(normalized),
        }
    }
}

/// The normalization pass: linear transmittance → per-channel normalized log
/// density, `(log10 − floor) / (ceil − floor)`. The stretch inverts the
/// negative and removes the orange mask. Deliberately unclamped: tones outside
/// the bounds are rolled off by the print curve's knees. A source matrix (a RAW
/// slide's camera matrix, `source_matrix`) applies in linear light before the
/// log. Mirrors src/lib/image/shaders/normalization.wgsl.
#[derive(Debug, Clone, Copy)]
pub struct Normalizer {
    floors: [f32; 3],
    inv_span: [f32; 3],
    /// Row-major linear-light matrix applied before the log.
    matrix: Option<[f32; 9]>,
}

impl Normalizer {
    pub fn new(bounds: &LogBounds) -> Self {
        let mut inv_span = [0f32; 3];
        for c in 0..3 {
            let d = bounds.ceils[c] - bounds.floors[c];
            // Sign-preserving guard against a degenerate window.
            inv_span[c] = 1.0 / if d.abs() < 1e-6 { 1e-6f32.copysign(d) } else { d };
        }
        Self {
            floors: bounds.floors,
            inv_span,
            matrix: None,
        }
    }

    /// The same normalization with `matrix` applied to each pixel first.
    pub fn with_source_matrix(self, matrix: Option<[f32; 9]>) -> Self {
        Self { matrix, ..self }
    }

    #[inline]
    pub fn apply(&self, rgb: [f32; 3]) -> [f32; 3] {
        let rgb = match &self.matrix {
            Some(m) => std::array::from_fn(|r| {
                m[r * 3] * rgb[0] + m[r * 3 + 1] * rgb[1] + m[r * 3 + 2] * rgb[2]
            }),
            None => rgb,
        };
        [
            (rgb[0].max(1e-6).log10() - self.floors[0]) * self.inv_span[0],
            (rgb[1].max(1e-6).log10() - self.floors[1]) * self.inv_span[1],
            (rgb[2].max(1e-6).log10() - self.floors[2]) * self.inv_span[2],
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::curve::PrintCurve;
    use super::*;

    // The same synthetic negative, inputs and expected numbers are asserted by
    // src/lib/image/negative/analysis.test.ts: the native export (this code)
    // and the preview (that code) must print the same picture.

    const W: usize = 320;
    const H: usize = 240;

    /// A gray scene behind an orange mask, with a warm patch in one corner.
    fn synthetic_negative() -> Vec<f32> {
        let base = [0.75f64, 0.45, 0.25];
        let gamma = [1.0f64, 1.1, 1.25];
        let patch_tint = [0.0f64, 0.1, 0.25];
        let mut out = vec![0f32; W * H * 3];
        let mut state: u32 = 2024;
        for y in 0..H {
            for x in 0..W {
                state = state.wrapping_mul(1664525).wrapping_add(1013904223);
                let noise = f64::from(state >> 8) / 16777216.0;
                let scene = 0.5 * (x as f64 / W as f64) + 0.3 * (y as f64 / H as f64) + 0.2 * noise;
                let density = 0.2 + 1.2 * scene;
                let warm = x < W / 4 && y > 3 * H / 4;
                for c in 0..3 {
                    let d = density + if warm { patch_tint[c] } else { 0.0 };
                    out[(y * W + x) * 3 + c] = (base[c] * 10f64.powf(-gamma[c] * d)) as f32;
                }
            }
        }
        out
    }

    const ROLL: AppliedBaseline = AppliedBaseline {
        floors: [-1.5, -2.0, -2.6],
        ceils: [-0.2, -0.5, -0.8],
        use_luma: true,
        use_color: false,
        key: 7.0,
    };

    fn edited() -> PrintInputs {
        PrintInputs {
            cmy: [0.0, 0.3, 0.0],
            shadow_cmy: [0.0, 0.0, -0.2],
            toe: 0.2,
            ..PrintInputs::default()
        }
    }

    fn assert_vec(actual: [f32; 3], expected: [f32; 3], tolerance: f32) {
        for c in 0..3 {
            assert!(
                (actual[c] - expected[c]).abs() < tolerance,
                "channel {c}: {actual:?} vs {expected:?}"
            );
        }
    }

    #[test]
    fn measures_and_prints_a_frame_on_its_own_bounds() {
        let rgb = synthetic_negative();
        let analysis = analyze(&rgb, W, H, FilmType::C41, None);
        assert_vec(analysis.floors, [-1.41339, -1.764084, -2.212624], 1e-4);
        assert_vec(analysis.ceils, [-0.465608, -0.721524, -1.027897], 1e-4);
        assert!((analysis.anchor - 0.454299).abs() < 1e-4);
        assert!((analysis.textural_range - 0.43566).abs() < 1e-4);
        let axis = analysis.neutral_axis.expect("a gray scene has a neutral axis");
        assert!((axis.confidence - 0.962474).abs() < 1e-3);
        assert_eq!(analysis.baseline_key, None);
        assert!(is_current(&analysis, None));
        assert!(!is_current(&analysis, Some(&ROLL)));

        let (bounds, params) = solve(&edited(), &analysis, None);
        assert_eq!(bounds, analysis.bounds());
        assert_vec(params.slopes, [3.157209, 3.157209, 3.15721], 1e-3);
        assert_vec(params.pivots, [0.228501, 0.228501, 0.228501], 1e-4);
        assert_vec(params.cmy_offsets, [0.0, 0.057551, 0.0], 1e-4);
        let curve = PrintCurve::new(&params);
        assert_vec(curve.transmittance([0.25; 3]), [0.552041, 0.426344, 0.554956], 1e-4);
        assert_vec(curve.transmittance([0.5; 3]), [0.124862, 0.080995, 0.13151], 1e-4);
    }

    #[test]
    fn takes_the_tonal_range_from_the_roll_baseline_and_keeps_its_own_colour() {
        let rgb = synthetic_negative();
        let analysis = analyze(&rgb, W, H, FilmType::C41, Some(&ROLL));
        // The frame's own bounds are stored; the roll only shapes the render.
        assert_vec(analysis.floors, [-1.41339, -1.764084, -2.212624], 1e-4);
        assert!((analysis.anchor - 0.468572).abs() < 1e-4);
        assert!(is_current(&analysis, Some(&ROLL)));

        let (bounds, params) = solve(&edited(), &analysis, Some(&ROLL));
        assert_vec(bounds.floors, [-1.628499, -1.979193, -2.427733], 1e-4);
        assert_vec(bounds.ceils, [-0.234252, -0.490168, -0.79654], 1e-4);
        assert_vec(params.slopes, [4.587286, 4.522192, 4.44139], 1e-3);
        assert_vec(params.pivots, [0.313354, 0.31093, 0.307821], 1e-3);
        let curve = PrintCurve::new(&params);
        assert_vec(curve.transmittance([0.25; 3]), [0.76332, 0.653959, 0.747426], 1e-3);
        assert_vec(curve.transmittance([0.5; 3]), [0.125019, 0.081271, 0.132441], 1e-3);
    }

    #[test]
    fn prints_b_and_w_as_one_density_and_drops_the_colour_filtration() {
        let rgb = synthetic_negative();
        let analysis = analyze(&rgb, W, H, FilmType::Bw, None);
        assert!(analysis.neutral_axis.is_none());
        let tinted = PrintInputs {
            film_type: FilmType::Bw,
            highlight_cmy: [0.4, 0.0, 0.0],
            ..edited()
        };
        let (_, params) = solve(&tinted, &analysis, None);
        let plain = PrintInputs {
            film_type: FilmType::Bw,
            toe: edited().toe,
            ..PrintInputs::default()
        };
        assert_eq!(params, solve(&plain, &analysis, None).1);

        let curve = PrintCurve::new(&params);
        // A gray prints as without the collapse: the red channel of the colour print above,
        // which no filtration touches, also gives 0.552041 at u = 0.25.
        assert!((curve.transmittance_bw([0.25; 3]) - 0.552041).abs() < 1e-4);
        assert!((curve.transmittance_bw([0.5; 3]) - 0.124862).abs() < 1e-4);
        assert!((curve.transmittance_bw([0.3, 0.5, 0.7]) - 0.126711).abs() < 1e-4);
    }

    #[test]
    fn normalizer_maps_the_bounds_to_zero_and_one() {
        let bounds = LogBounds {
            floors: [-2.0, -1.5, -1.0],
            ceils: [-0.5, -0.25, 0.0],
        };
        let n = Normalizer::new(&bounds);
        assert_vec(n.apply([1e-2, 10f32.powf(-1.5), 0.1]), [0.0; 3], 1e-5);
        assert_vec(n.apply([10f32.powf(-0.5), 10f32.powf(-0.25), 1.0]), [1.0; 3], 1e-5);
        // A collapsed window (blank frame) stays finite.
        let flat = Normalizer::new(&LogBounds {
            floors: [-1.0; 3],
            ceils: [-1.0; 3],
        });
        assert!(flat.apply([0.0, 0.1, 1.0]).iter().all(|v| v.is_finite()));
    }

    #[test]
    fn carries_the_fixed_window_and_solves_the_same_curve_for_two_different_slides() {
        let rgb = synthetic_negative();
        // The same frame a stop and a half darker, with another crop of content.
        let other: Vec<f32> = rgb
            .iter()
            .enumerate()
            .map(|(i, v)| if i % 7 == 0 { v * 0.9 } else { *v } * 0.35)
            .collect();
        let a = analyze(&rgb, W, H, FilmType::E6, None);
        let b = analyze(&other, W, H, FilmType::E6, Some(&ROLL));
        for analysis in [&a, &b] {
            assert_vec(analysis.floors, [0.0; 3], 1e-6);
            assert_vec(analysis.ceils, [-3.0; 3], 1e-6);
            assert!((analysis.anchor - 0.25).abs() < 1e-6);
            assert!((analysis.textural_range - 0.9).abs() < 1e-6);
            assert!(analysis.neutral_axis.is_none());
        }
        assert!(is_current(&a, None));
        assert!(is_current(&b, Some(&ROLL)));

        let slide = PrintInputs {
            film_type: FilmType::E6,
            cast_removal: 1.0,
            ..edited()
        };
        let solved = solve(&slide, &a, None);
        assert_eq!(solve(&slide, &b, Some(&ROLL)), solved);
        // Even a negative's analysis: a slide's solve does not read it.
        let negative = analyze(&rgb, W, H, FilmType::C41, None);
        assert_eq!(solve(&slide, &negative, Some(&ROLL)), solved);

        let (bounds, params) = solved;
        assert_eq!(bounds, transfer::transfer_bounds());
        assert_vec(params.slopes, [3.0; 3], 1e-6);
        assert_vec(params.cmy_offsets, [0.0, 0.02, 0.0], 1e-6);
        assert_vec(params.shadow_cmy, [0.0, 0.0, -0.04], 1e-6);
        // The sliders themselves: the paper's grade coupling does not apply.
        assert_eq!(params.toe, 0.2);
        assert_eq!(params.shoulder, 0.0);
    }

    #[test]
    fn renders_an_unbalanced_raw_neutral_neutral_through_the_slide_camera_matrix() {
        #[rustfmt::skip]
        let camera = [
            2.220265, -1.245972, 0.230507,
            -0.040725, 1.288371, -0.299246,
            0.038354, -0.357347, 1.227694,
        ];
        let wb = [2.1, 1.0, 1.45];
        assert!(source_matrix(FilmType::C41, true, &camera, wb).is_none());
        assert!(source_matrix(FilmType::E6, false, &camera, wb).is_none());
        let matrix = source_matrix(FilmType::E6, true, &camera, wb);

        let slide = PrintInputs {
            film_type: FilmType::E6,
            ..PrintInputs::default()
        };
        let (bounds, params) = solve(&slide, &analyze(&[], 0, 0, FilmType::E6, None), None);
        let normalizer = Normalizer::new(&bounds).with_source_matrix(matrix);
        let curve = FilmCurve::new(FilmType::E6, &params, true);
        for level in [0.02f32, 0.18, 0.6] {
            // A gray as the sensor records it without white balance.
            let raw = [level / wb[0], level / wb[1], level / wb[2]];
            let n = normalizer.apply(raw);
            assert_vec(n, [-level.log10() / 3.0; 3], 1e-5);
            let shown = curve.render(n);
            assert_vec(shown, [shown[1]; 3], 1e-5);
        }
    }
}
