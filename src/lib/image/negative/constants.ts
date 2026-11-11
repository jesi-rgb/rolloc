/**
 * Constants of the negative pipeline's print model and of the slide transfer.
 *
 * Ported from NegPy 0.68 `EXPOSURE_CONSTANTS` (negpy/features/exposure/models.py),
 * `POOL_OUTLIER_DISTANCE` (negpy/features/exposure/normalization.py) and
 * `TRANSFER_CONSTANTS` with the slide picker's constants
 * (negpy/features/transparency/logic.py); the NegPy key is the lower-case name.
 * Mirrored in src-tauri/src/negative/constants.rs — change both together.
 */

import type { Vec3 } from '$lib/types';

// ─── Luma ─────────────────────────────────────────────────────────────────────

/** Rec. 709 luma weights: the one weight set every meter and shader uses. */
export const LUMA: Vec3 = [0.2126, 0.7152, 0.0722];

// ─── Analysis grid ────────────────────────────────────────────────────────────

/** Fraction of each edge excluded from metering (rebate, holder). */
export const ANALYSIS_BUFFER = 0.10;
/** Long side of the block-median grid every meter reads. */
export const ANALYSIS_GRID = 1024;
/** Activity gate: sectors of 2×2 blocks of this many cells vote… */
export const ACTIVITY_BLOCK = 8;
/** …when their four block means span more than this log10 density… */
export const ACTIVITY_GATE_DENSITY = 0.05;
/** …and below this fraction of voting sectors, every cell votes. */
export const ACTIVITY_MIN_FRACTION = 0.05;

// ─── Bounds ───────────────────────────────────────────────────────────────────

/** Per-tail percentile clip of the luma window. */
export const BASE_LUMA_CLIP = 0.01;
/** Per-tail percentile clip of the per-channel colour references. */
export const BASE_COLOR_CLIP = 1.0;
/** Width, in percentile points, of the luma-extreme band the dense-end colour refs read. */
export const COLOR_BOUNDS_BAND_WIDTH = 4.0;

// ─── Neutral axis (dense-end colour refs and Cast Removal) ────────────────────

/** Normalized-luma bands the neutral references are read in. */
export const NEUTRAL_AXIS_HIGHLIGHT_BAND: [number, number] = [0.10, 0.30];
export const NEUTRAL_AXIS_MID_BAND: [number, number] = [0.40, 0.60];
export const NEUTRAL_AXIS_SHADOW_BAND: [number, number] = [0.72, 0.92];
/** Lowest-chroma fraction of a band kept as its near-neutral set. */
export const NEUTRAL_AXIS_CHROMA_QUANTILE = 0.30;
/** Median corrected chroma above which a set is not trustworthy (pass 2). */
export const NEUTRAL_AXIS_CHROMA_CAP = 0.29;
/** Pass-1 chroma ceiling: admits strong correctable casts, rejects saturated content. */
export const NEUTRAL_AXIS_FIRST_PASS_CAP = 0.55;
export const NEUTRAL_AXIS_MIN_PIXELS = 64;
/** Foliage sector: chroma floor and hue range (degrees) excluded from the neutral sets. */
export const NEUTRAL_AXIS_FOLIAGE_CHROMA = 0.03;
export const NEUTRAL_AXIS_FOLIAGE_HUE: [number, number] = [-25.0, 80.0];
/** Sky and water sector, the same rule from azure to blue. */
export const NEUTRAL_AXIS_SKY_CHROMA = 0.06;
export const NEUTRAL_AXIS_SKY_HUE: [number, number] = [-150.0, -60.0];
/** Confidence sample-size half-point: the size term is n / (n + this). */
export const NEUTRAL_AXIS_CONFIDENCE_N0 = 256;
export const NEUTRAL_AXIS_AGREEMENT_DEADZONE = 0.10;
export const NEUTRAL_AXIS_AGREEMENT_SCALE = 0.20;
export const NEUTRAL_AXIS_WIDTH_DEADZONE = 0.15;
export const NEUTRAL_AXIS_WIDTH_SCALE = 0.30;
/** Clamp on each channel's deviation from green at any reference. */
export const MIDTONE_CAST_MAX_OFFSET = 0.2;
/** Curvature clamp as a fraction of slope; keeps the per-channel core monotonic. */
export const NEUTRAL_AXIS_CURV_MAX_RATIO = 0.45;

// ─── Auto Density ─────────────────────────────────────────────────────────────

/** Normalized midtone a frame is assumed to have when it is not metered. */
export const ASSUMED_ANCHOR = 0.46;
/** Per-tail percentile trim of the textured cells the anchor is read from. */
export const ANCHOR_TRIM_CLIP = 5.0;
/** Fraction of the way from the assumed anchor toward the metered one. */
export const ANCHOR_METER_STRENGTH = 0.2;
/** Hard clamp of the metered anchor around the assumed one. */
export const ANCHOR_METER_BAND = 0.12;
/** Print density the metered anchor lands on. */
export const ANCHOR_TARGET_DENSITY = 0.75;

// ─── Auto Grade ───────────────────────────────────────────────────────────────

/** The fixed paper grade of the base curve, ISO R. */
export const NEUTRAL_ISO_R = 115;
export const ISO_R_MIN = 50;
export const ISO_R_MAX = 180;
/** Bounds on the straight-line slope k. */
export const SLOPE_MIN = 2.0;
export const SLOPE_MAX = 10.0;
/** k = this × density range / (ISO R / 100). */
export const GRADE_CONTRAST_SCALE = 2.9;
export const AUTO_GRADE_TARGET = 0.85;
/** 0 = fixed paper, 1 = every frame's textural range prints alike. */
export const AUTO_GRADE_STRENGTH = 0.4;
/** Cap on the textural range's print span, as a multiple of a normal negative's. */
export const AUTO_GRADE_MAX_OVERFILL = 1.2;
/** Textural (P10–P90) density range of a normal negative, log10 D. */
export const AUTO_GRADE_NOMINAL_RANGE = 0.9;
/** Floor-to-ceil / textural ratio of a normal negative. */
export const AUTO_GRADE_NOMINAL_RATIO = 1.5;
/** Per-tail percentile margin of the textural range. */
export const TEXTURAL_RANGE_CLIP = 10.0;

// ─── Print curve ──────────────────────────────────────────────────────────────

/** Paper black density. */
export const D_MAX = 2.3;
/** Density the reference tone prints at; centre of the paper S-curve and the regional CMY split. */
export const REFERENCE_PRINT_DENSITY = 0.75;
/** Global multiplier on the toe and shoulder slider values. */
export const TOE_SHOULDER_STRENGTH = 0.85;
/** Knee sharpness of the softplus bounds (toe → paper black, shoulder → paper white). */
export const TOE_SHARPNESS_BASE = 6.0;
export const SHOULDER_SHARPNESS_BASE = 3.0;
/** Density moved per slider unit: d_max_eff = D_MAX − toe × this; d_min_eff = shoulder × this. */
export const TOE_HEIGHT = 0.90;
export const SHOULDER_HEIGHT = 0.35;
/** Grade-coupled baseline roll-off added per unit of normalized slope. */
export const TOE_GRADE_STRENGTH = (0.15 * 0.35) / 0.90;
export const SHOULDER_GRADE_STRENGTH = 0.12;
/** Variable-gamma paper S-curve: extra midtone gamma and its density half-width. */
export const PAPER_MIDTONE_GAMMA = 0.05;
export const PAPER_GAMMA_WIDTH = 0.6;
/** Sharpness of the shadow/highlight split of the regional CMY offsets. */
export const REGIONAL_CMY_SHARPNESS = 3.0;

// ─── Filtration ───────────────────────────────────────────────────────────────

/** Absolute density per CMY slider unit (1.0 = 20cc). */
export const CMY_MAX_DENSITY = 0.2;

// ─── B&W ──────────────────────────────────────────────────────────────────────

/**
 * Weights that collapse the normalized log channels of a B&W print to one density before the
 * curve: a panchromatic film, NegPy `BW_FILTER_WEIGHTS[BwFilter.NONE]`. They sum to 1, so a gray
 * does not move.
 */
export const BW_FILTER_WEIGHTS_NONE: Vec3 = [0.31, 0.39, 0.30];

// ─── Transparency transfer (slides) ───────────────────────────────────────────

/**
 * Paper white density. The print above runs with paper white off; only the slide transfer's
 * mapping of print geometry by tonal position (`wbSplitGeometry`) reads it.
 */
export const D_MIN = 0.06;
/** Log-density window a slide normalizes over: the source's white level down this many decades. */
export const TRANSFER_DENSITY_RANGE = 3.0;
/** Mid-grey of the slide curve as a density: ~18% of the white level. */
export const TRANSFER_CONTRAST_PIVOT = 0.75;
/** Densities where the toe (working down from the shadow end) and the shoulder start biting. */
export const TRANSFER_TOE_KNEE = 1.6;
export const TRANSFER_SHOULDER_KNEE = 0.35;
/** Softness of both knees, in density, at the reference knee width. */
export const TRANSFER_KNEE_WIDTH = 0.45;
/** Baseline exposure, in stops, a scene-linear capture gets before the display rendering. */
export const TRANSFER_BASELINE_EV = 0.7;
/** Slider units per mired along the slide picker's Temperature direction (cyan, yellow). */
export const SLIDE_K_CYAN = 0.0031;
export const SLIDE_K_YELLOW = 0.0065;
/**
 * Display gamma of the standard tone preset (`TONE_PRESETS.standard.gamma`). A display-referred
 * slide is re-expanded with it so the standard preset's encode returns the source's own values.
 * Not a NegPy constant: NegPy encodes a positive source with the OETF it decoded it with.
 */
export const STANDARD_TONE_GAMMA = 2.2;

// ─── Roll baseline ────────────────────────────────────────────────────────────

/** Luma-free colour distance (log D) from the pool's median past which a frame is an outlier. */
export const POOL_OUTLIER_DISTANCE = 0.3;
