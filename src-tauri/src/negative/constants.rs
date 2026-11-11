//! Constants of the negative pipeline's print model and of the slide transfer.
//!
//! Ported from NegPy 0.68 `EXPOSURE_CONSTANTS` (negpy/features/exposure/models.py) and
//! `TRANSFER_CONSTANTS` with the slide picker's constants
//! (negpy/features/transparency/logic.py); the NegPy key is the lower-case name. Mirrors
//! src/lib/image/negative/constants.ts — change both together. (Roll pooling and the
//! white-balance pickers run in the frontend only, so their constants have no copy here.)

// ─── Luma ─────────────────────────────────────────────────────────────────────

/// Rec. 709 luma weights: the one weight set every meter and shader uses.
pub const LUMA: [f32; 3] = [0.2126, 0.7152, 0.0722];

// ─── Analysis grid ────────────────────────────────────────────────────────────

/// Fraction of each edge excluded from metering (rebate, holder).
pub const ANALYSIS_BUFFER: f32 = 0.10;
/// Long side of the block-median grid every meter reads.
pub const ANALYSIS_GRID: usize = 1024;
/// Activity gate: sectors of 2×2 blocks of this many cells vote…
pub const ACTIVITY_BLOCK: usize = 8;
/// …when their four block means span more than this log10 density…
pub const ACTIVITY_GATE_DENSITY: f32 = 0.05;
/// …and below this fraction of voting sectors, every cell votes.
pub const ACTIVITY_MIN_FRACTION: f32 = 0.05;

// ─── Bounds ───────────────────────────────────────────────────────────────────

/// Per-tail percentile clip of the luma window.
pub const BASE_LUMA_CLIP: f32 = 0.01;
/// Per-tail percentile clip of the per-channel colour references.
pub const BASE_COLOR_CLIP: f32 = 1.0;
/// Width, in percentile points, of the luma-extreme band the dense-end colour refs read.
pub const COLOR_BOUNDS_BAND_WIDTH: f32 = 4.0;

// ─── Neutral axis (dense-end colour refs and Cast Removal) ────────────────────

/// Normalized-luma bands the neutral references are read in.
pub const NEUTRAL_AXIS_HIGHLIGHT_BAND: (f32, f32) = (0.10, 0.30);
pub const NEUTRAL_AXIS_MID_BAND: (f32, f32) = (0.40, 0.60);
pub const NEUTRAL_AXIS_SHADOW_BAND: (f32, f32) = (0.72, 0.92);
/// Lowest-chroma fraction of a band kept as its near-neutral set.
pub const NEUTRAL_AXIS_CHROMA_QUANTILE: f32 = 0.30;
/// Median corrected chroma above which a set is not trustworthy (pass 2).
pub const NEUTRAL_AXIS_CHROMA_CAP: f32 = 0.29;
/// Pass-1 chroma ceiling: admits strong correctable casts, rejects saturated content.
pub const NEUTRAL_AXIS_FIRST_PASS_CAP: f32 = 0.55;
pub const NEUTRAL_AXIS_MIN_PIXELS: usize = 64;
/// Foliage sector: chroma floor and hue range (degrees) excluded from the neutral sets.
pub const NEUTRAL_AXIS_FOLIAGE_CHROMA: f32 = 0.03;
pub const NEUTRAL_AXIS_FOLIAGE_HUE: (f32, f32) = (-25.0, 80.0);
/// Sky and water sector, the same rule from azure to blue.
pub const NEUTRAL_AXIS_SKY_CHROMA: f32 = 0.06;
pub const NEUTRAL_AXIS_SKY_HUE: (f32, f32) = (-150.0, -60.0);
/// Confidence sample-size half-point: the size term is n / (n + this).
pub const NEUTRAL_AXIS_CONFIDENCE_N0: f32 = 256.0;
pub const NEUTRAL_AXIS_AGREEMENT_DEADZONE: f32 = 0.10;
pub const NEUTRAL_AXIS_AGREEMENT_SCALE: f32 = 0.20;
pub const NEUTRAL_AXIS_WIDTH_DEADZONE: f32 = 0.15;
pub const NEUTRAL_AXIS_WIDTH_SCALE: f32 = 0.30;
/// Clamp on each channel's deviation from green at any reference.
pub const MIDTONE_CAST_MAX_OFFSET: f32 = 0.2;
/// Curvature clamp as a fraction of slope; keeps the per-channel core monotonic.
pub const NEUTRAL_AXIS_CURV_MAX_RATIO: f32 = 0.45;

// ─── Auto Density ─────────────────────────────────────────────────────────────

/// Normalized midtone a frame is assumed to have when it is not metered.
pub const ASSUMED_ANCHOR: f32 = 0.46;
/// Per-tail percentile trim of the textured cells the anchor is read from.
pub const ANCHOR_TRIM_CLIP: f32 = 5.0;
/// Fraction of the way from the assumed anchor toward the metered one.
pub const ANCHOR_METER_STRENGTH: f32 = 0.2;
/// Hard clamp of the metered anchor around the assumed one.
pub const ANCHOR_METER_BAND: f32 = 0.12;
/// Print density the metered anchor lands on.
pub const ANCHOR_TARGET_DENSITY: f32 = 0.75;

// ─── Auto Grade ───────────────────────────────────────────────────────────────

/// The fixed paper grade of the base curve, ISO R.
pub const NEUTRAL_ISO_R: f32 = 115.0;
pub const ISO_R_MIN: f32 = 50.0;
pub const ISO_R_MAX: f32 = 180.0;
/// Bounds on the straight-line slope k.
pub const SLOPE_MIN: f32 = 2.0;
pub const SLOPE_MAX: f32 = 10.0;
/// k = this × density range / (ISO R / 100).
pub const GRADE_CONTRAST_SCALE: f32 = 2.9;
pub const AUTO_GRADE_TARGET: f32 = 0.85;
/// 0 = fixed paper, 1 = every frame's textural range prints alike.
pub const AUTO_GRADE_STRENGTH: f32 = 0.4;
/// Cap on the textural range's print span, as a multiple of a normal negative's.
pub const AUTO_GRADE_MAX_OVERFILL: f32 = 1.2;
/// Textural (P10–P90) density range of a normal negative, log10 D.
pub const AUTO_GRADE_NOMINAL_RANGE: f32 = 0.9;
/// Floor-to-ceil / textural ratio of a normal negative.
pub const AUTO_GRADE_NOMINAL_RATIO: f32 = 1.5;
/// Per-tail percentile margin of the textural range.
pub const TEXTURAL_RANGE_CLIP: f32 = 10.0;

// ─── Print curve ──────────────────────────────────────────────────────────────

/// Paper black density.
pub const D_MAX: f32 = 2.3;
/// Density the reference tone prints at; centre of the paper S-curve and the regional CMY split.
pub const REFERENCE_PRINT_DENSITY: f32 = 0.75;
/// Global multiplier on the toe and shoulder slider values.
pub const TOE_SHOULDER_STRENGTH: f32 = 0.85;
/// Knee sharpness of the softplus bounds (toe → paper black, shoulder → paper white).
pub const TOE_SHARPNESS_BASE: f32 = 6.0;
pub const SHOULDER_SHARPNESS_BASE: f32 = 3.0;
/// Density moved per slider unit: d_max_eff = D_MAX − toe × this; d_min_eff = shoulder × this.
pub const TOE_HEIGHT: f32 = 0.90;
pub const SHOULDER_HEIGHT: f32 = 0.35;
/// Grade-coupled baseline roll-off added per unit of normalized slope.
pub const TOE_GRADE_STRENGTH: f32 = 0.15 * 0.35 / 0.90;
pub const SHOULDER_GRADE_STRENGTH: f32 = 0.12;
/// Variable-gamma paper S-curve: extra midtone gamma and its density half-width.
pub const PAPER_MIDTONE_GAMMA: f32 = 0.05;
pub const PAPER_GAMMA_WIDTH: f32 = 0.6;
/// Sharpness of the shadow/highlight split of the regional CMY offsets.
pub const REGIONAL_CMY_SHARPNESS: f32 = 3.0;

// ─── Filtration ───────────────────────────────────────────────────────────────

/// Absolute density per CMY slider unit (1.0 = 20cc).
pub const CMY_MAX_DENSITY: f32 = 0.2;

// ─── B&W ──────────────────────────────────────────────────────────────────────

/// Weights that collapse the normalized log channels of a B&W print to one density before the
/// curve: a panchromatic film, NegPy `BW_FILTER_WEIGHTS[BwFilter.NONE]`. They sum to 1, so a gray
/// does not move.
pub const BW_FILTER_WEIGHTS_NONE: [f32; 3] = [0.31, 0.39, 0.30];

// ─── Transparency transfer (slides) ───────────────────────────────────────────

/// Paper white density. The print above runs with paper white off; only the slide transfer's
/// mapping of print geometry by tonal position (`wb_split_geometry`) reads it.
pub const D_MIN: f32 = 0.06;
/// Log-density window a slide normalizes over: the source's white level down this many decades.
pub const TRANSFER_DENSITY_RANGE: f32 = 3.0;
/// Mid-grey of the slide curve as a density: ~18% of the white level.
pub const TRANSFER_CONTRAST_PIVOT: f32 = 0.75;
/// Densities where the toe (working down from the shadow end) and the shoulder start biting.
pub const TRANSFER_TOE_KNEE: f32 = 1.6;
pub const TRANSFER_SHOULDER_KNEE: f32 = 0.35;
/// Softness of both knees, in density, at the reference knee width.
pub const TRANSFER_KNEE_WIDTH: f32 = 0.45;
/// Baseline exposure, in stops, a scene-linear capture gets before the display rendering.
pub const TRANSFER_BASELINE_EV: f32 = 0.7;
/// Display gamma of the standard tone preset (`resolve_tone_preset("standard")` in process.rs).
/// A display-referred slide is re-expanded with it so the standard preset's encode returns the
/// source's own values. Not a NegPy constant: NegPy encodes a positive source with the OETF it
/// decoded it with.
pub const STANDARD_TONE_GAMMA: f32 = 2.2;
