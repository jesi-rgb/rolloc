// ─── Geometry ────────────────────────────────────────────────────────────────

/** Normalized rect, all values 0–1 relative to image dimensions. */
export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** A 2D point with normalized coordinates (0–1 relative to image dimensions). */
export interface Point2D {
	x: number;
	y: number;
}

/**
 * Quadrilateral crop defined by four corner points.
 * Allows perspective correction by placing each corner at the frame edge.
 * Points are normalized (0–1) relative to image dimensions.
 * Order: top-left, top-right, bottom-right, bottom-left (clockwise from TL).
 */
export interface CropQuad {
	tl: Point2D;
	tr: Point2D;
	br: Point2D;
	bl: Point2D;
}

/**
 * Crop aspect-ratio lock used by the crop overlay UI.
 * - `null`        → free-form crop (no constraint)
 * - `'original'`  → lock to the source image's native aspect ratio
 * - `number`      → lock to a fixed display ratio expressed as width / height
 *                   (e.g. 16 / 9 ≈ 1.778 for landscape, 9 / 16 for portrait)
 *
 * The value describes the *displayed* width:height ratio. The overlay converts
 * it into normalized image-space using the canvas dimensions.
 */
export type CropAspect = number | 'original' | null;

/** Default identity crop — full image, no perspective correction. */
export const DEFAULT_CROP_QUAD: CropQuad = {
	tl: { x: 0, y: 0 },
	tr: { x: 1, y: 0 },
	br: { x: 1, y: 1 },
	bl: { x: 0, y: 1 },
};

// ─── Transform parameters ─────────────────────────────────────────────────────

/**
 * Transform parameters for rotation and flipping.
 * Applied in the GPU pipeline before crop.
 *
 * Rotation is handled entirely by `rotation` (degrees, any value).
 * The 90° buttons simply add/subtract 90 to this value.
 */
export interface TransformParams {
	/** @deprecated Use `rotation` instead. Kept for backwards compatibility. */
	rotation90?: 0 | 1 | 2 | 3;
	/** Rotation in degrees (positive = counter-clockwise on screen). Supports any value. */
	rotation: number;
	/** Horizontal flip (mirror). Applied via CSS. */
	flipH: boolean;
	/** Vertical flip. Applied via CSS. */
	flipV: boolean;
	/**
	 * Zoom factor (1.0 = no zoom, 2.0 = 2x zoom), on top of the automatic
	 * zoom that keeps a rotated image covering the frame (`rotationCoverZoom`).
	 * Zooms from center, effectively cropping in. Range: 1.0 to 3.0.
	 */
	zoom: number;
}

export const DEFAULT_TRANSFORM: TransformParams = {
	rotation: 0,
	flipH: false,
	flipV: false,
	zoom: 1,
};

// ─── Color / Curve primitives ─────────────────────────────────────────────────

/** Row-major 3×3 matrix: [m00, m01, m02, m10, m11, m12, m20, m21, m22] */
export type Matrix3x3 = [
	number, number, number,
	number, number, number,
	number, number, number,
];

/** Per-channel RGB triple. */
export type Vec3 = [number, number, number];

/**
 * Per-channel log10-density window of a negative. `floors` is the dense end
 * (scene highlights, low log value), `ceils` the thin end (film base, high log
 * value). The normalization pass maps floor → 0 and ceil → 1.
 */
export interface LogBounds {
	floors: Vec3;
	ceils: Vec3;
}

/** A single control point on a tone curve, both axes 0–1. */
export interface CurvePoint {
	x: number;
	y: number;
}

/** Spline knots defining a tone curve. Monotone, sorted by x. */
export interface CurvePoints {
	points: CurvePoint[];
}

export interface WhiteBalance {
	/** Colour temperature in Kelvin (1000–20000). */
	temperature: number;
	/** Green–magenta tint, -100 to +100. */
	tint: number;
}

// ─── Film types ───────────────────────────────────────────────────────────────

/**
 * Film processing mode, matching negpy's ProcessMode.
 *
 * - C41: Color negative film (default) — requires inversion + orange mask removal
 * - BW:  Black & white negative — inversion + luminance conversion
 * - E6:  Slide/reversal film (positive) — no inversion, just normalization
 */
export type FilmType = 'C41' | 'BW' | 'E6';

/**
 * Tone presets control the hidden transfer-function parameters applied
 * during the H&D curve pass — gamma, black/white point, and midtone contrast.
 * The user-facing sliders (grade, toe, shoulder, etc.) are offsets on top.
 */
export type TonePreset = 'standard' | 'soft' | 'punch';

/**
 * Export matting border colour. Currently limited to neutral black or white —
 * rendered as a solid frame around the photo on export (and in the preview).
 */
export type BorderColor = 'black' | 'white';

/** Internal parameters derived from a TonePreset. Not exposed to the user. */
export interface TonePresetParams {
	/** Output gamma exponent (display gamma). Standard = 2.2. */
	gamma: number;
	/** Black point crush — output values below this map to 0. Range [0, 0.05]. */
	blackPoint: number;
	/** White point clip — output values above this map to 1. Range [0.95, 1.0]. */
	whitePoint: number;
	/** Midtone S-curve strength. 0 = linear, positive = more contrast. */
	midtoneCurve: number;
}

export const TONE_PRESETS: Record<TonePreset, TonePresetParams> = {
	standard: { gamma: 2.2, blackPoint: 0.0, whitePoint: 1.0, midtoneCurve: 0.0 },
	soft: { gamma: 2.5, blackPoint: 0.00, whitePoint: 1.1, midtoneCurve: -0.45 },
	punch:    { gamma: 1.9,  blackPoint: 0.00, whitePoint: 1.04, midtoneCurve: 0.2  },
};

// ─── NegPy inversion parameters ──────────────────────────────────────────────

/**
 * Parameters for the NegPy film-negative inversion pipeline.
 * Models the darkroom physics of projecting a negative through an enlarger.
 *
 * Stage 1 — Log normalization:
 *   Converts linear transmittance to log-density and per-channel stretches
 *   to [0,1], simultaneously inverting and removing the orange mask.
 *
 * Stage 2 — Print curve (paper response):
 *   A straight line in density between a shoulder (paper white) and a toe
 *   (paper black), with slope and pivot metered per frame. Ported from NegPy.
 */
export interface InversionParams {
	/**
	 * Auto Density. When enabled the print curve's pivot follows the frame's
	 * metered midtone (textured areas only, a partial pull); when disabled every
	 * frame prints from the same assumed midtone.
	 */
	autoExposure: boolean;

	/**
	 * Brightness, stored inverted: exposure in EV stops = 1.0 − density.
	 * Drives the post-curve tone stage (linear-light gain + soft highlight
	 * shoulder), not the H&D pivot. Default 1.0 = neutral.
	 */
	density: number;
	/**
	 * Contrast, stored in the legacy grade domain: amount = (grade − 2.5) / 2.5,
	 * clamped to [−1, +1]. Drives an S-curve pivoted on mid-grey rather than the
	 * H&D sigmoid slope. Default 2.5 = neutral.
	 */
	grade: number;

	// ── Global CMY color timing (log-space offsets) ──────────────────────────
	/** Global Cyan/Red shift (-1 to +1). */
	cmyCyan: number;
	/** Global Magenta/Green shift (-1 to +1). */
	cmyMagenta: number;
	/** Global Yellow/Blue shift (-1 to +1). */
	cmyYellow: number;

	// ── Shadow-targeted CMY shifts ───────────────────────────────────────────
	shadowCyan: number;
	shadowMagenta: number;
	shadowYellow: number;

	// ── Highlight-targeted CMY shifts ────────────────────────────────────────
	highlightCyan: number;
	highlightMagenta: number;
	highlightYellow: number;

	// ── Cast removal ─────────────────────────────────────────────────────────
	/**
	 * Strength of the automatic gray balance, 0 (off) to 1. Fits the red and
	 * blue curves to green's along the frame's near-neutral pixels, scaled by
	 * how trustworthy those neutrals are. Colour negatives only.
	 */
	castRemoval: number;

	// ── Tonal adjustments (post-curve tone stage) ────────────────────────────
	/**
	 * Shadow lift/pull in [−1, +1]. Gamma move under a wide luminance mask
	 * (Lightroom-like reach into the midtones). Positive = brighter shadows.
	 */
	shadows: number;
	/**
	 * Highlight lift/recovery in [−1, +1]. Gamma move under a wide luminance
	 * mask. Positive = brighter highlights, negative = recovery.
	 */
	highlights: number;

	// ── Toe / shoulder (print curve knees) ───────────────────────────────────
	/** Lifts paper black: positive softens the shadow roll-off. [-1, +1] */
	toe: number;
	/** Lifts paper white: positive holds highlight density. [-1, +1] */
	shoulder: number;

	// ── CLAHE (local contrast enhancement) ────────────────────────────────────
	/** CLAHE blend strength [0,1]. 0 = off, 0.25 = negpy default. */
	claheStrength: number;

	// ── Color adjustments ─────────────────────────────────────────────────────
	/** Vibrance: intelligent saturation that protects already-saturated colors. [-1, +1] */
	vibrance: number;
	/** Saturation: uniform saturation adjustment. [-1, +1] */
	saturation: number;

	// ── Sharpening (unsharp mask on luminance) ────────────────────────────────
	/**
	 * Output sharpening amount. Applies unsharp mask to the luminance channel
	 * (matching negpy's LAB lightness sharpening). Range: 0 (off) to 1 (full).
	 * Default: 0.25 (negpy default).
	 */
	sharpen: number;

	// ── Glow (highlight bloom) ────────────────────────────────────────────────
	/**
	 * Glow: all-channel Gaussian bloom of highlights (lens diffusion effect).
	 * Extracts bright regions, blurs them, and blends via screen mode.
	 * Range: 0 (off) to 1 (full strength).
	 * Preview uses a fast downsampled algorithm; export uses full-res HQ glow.
	 */
	glow: number;

	// ── Film type ─────────────────────────────────────────────────────────────
	/**
	 * Film processing mode.
	 * - C41: Color negative (default) — orange mask removal + inversion
	 * - BW:  B&W negative — inversion + luminance conversion
	 * - E6:  Slide/reversal (positive) — no inversion needed
	 */
	filmType: FilmType;

	// ── Tone preset ──────────────────────────────────────────────────────────
	/**
	 * Selects the base transfer function applied during the H&D curve pass.
	 * Controls hidden gamma, black/white point, and midtone contrast params.
	 * User sliders are offsets applied on top of this baseline.
	 */
	tonePreset: TonePreset;

	// ── Export matting border ────────────────────────────────────────────────
	/**
	 * Width of the solid matting border drawn around the photo, expressed as a
	 * percentage of the image's shorter edge. 0 = no border (disabled). The
	 * border grows the output (matting), it does not cover the photo. Applied as
	 * the final stage of both the GPU preview and the native export so the two
	 * stay visually identical at any resolution.
	 */
	borderWidth: number;
	/** Matting border colour — neutral black or white. */
	borderColor: BorderColor;
}

// ─── Edit parameters ──────────────────────────────────────────────────────────

/**
 * Parameters set once per roll — shared baseline for all frames.
 * These live on the Roll record.
 */
export interface RollEditParams {
	/** Rectangle within the image that contains unexposed film rebate. */
	rebateRegion: Rect;
	/**
	 * Camera-native RGB → XYZ D50 matrix.
	 * Sourced from libraw / DNG metadata. Fixed per camera body + light source.
	 */
	cameraColorMatrix: Matrix3x3;
	/**
	 * As-shot white balance coefficients [R, G, B] from the RAW file metadata.
	 * Normalised so G = 1.0. Applied as per-channel multipliers before the
	 * colour matrix pass. Only relevant for RAW files; defaults to [1, 1, 1].
	 */
	ashotWBCoeffs: [number, number, number];
	/** Light source colour temperature used to interpolate the colour matrix. */
	lightSourceTemp: number;
	/** Default tone curve applied to all frames (global, post-inversion). */
	baseToneCurve: CurvePoints;
	/** Default per-channel RGB curves [R, G, B]. */
	baseRGBCurves: [CurvePoints, CurvePoints, CurvePoints];
	/** Whether to invert the image (true = film negative; false = positive/already-scanned). */
	invert: boolean;
	/** Roll-level default NegPy inversion parameters — used when a frame has no override. */
	inversionParams: InversionParams;
}

/**
 * Per-frame overrides. Every field is nullable — null means
 * "inherit from RollEditParams".
 */
export interface FrameEditOverrides {
	/** Exposure compensation in stops, relative to roll baseline. */
	exposureCompensation: number | null;
	whiteBalance: WhiteBalance | null;
	/** Replaces baseToneCurve when set. */
	toneCurve: CurvePoints | null;
	/** Replaces baseRGBCurves when set. */
	rgbCurves: [CurvePoints, CurvePoints, CurvePoints] | null;
	/** Override rebate region for this specific frame. */
	rebateRegion: Rect | null;
	/** Per-frame NegPy inversion parameters. Null = inherit roll default. */
	inversionParams: InversionParams | null;
	/**
	 * Quadrilateral crop with perspective correction.
	 * Null = no crop (full image). When set, the four corners define
	 * where the output rectangle maps to in the source image.
	 */
	cropQuad: CropQuad | null;
	/**
	 * Transform parameters (rotation, flip).
	 * Null = inherit default (no transform).
	 */
	transform: TransformParams | null;
}

/**
 * The fully resolved edit — what the GPU pipeline actually receives.
 * Computed at render time by merging roll defaults with frame overrides.
 */
export interface EffectiveEdit {
	rebateRegion: Rect;
	cameraColorMatrix: Matrix3x3;
	/**
	 * As-shot white balance coefficients [R, G, B] from the RAW file.
	 * Applied as channel multipliers before the colour matrix. [1, 1, 1] for
	 * non-RAW sources.
	 */
	ashotWBCoeffs: [number, number, number];
	lightSourceTemp: number;
	exposureCompensation: number;
	whiteBalance: WhiteBalance;
	toneCurve: CurvePoints;
	rgbCurves: [CurvePoints, CurvePoints, CurvePoints];
	invert: boolean;
	/** NegPy inversion pipeline parameters (only used when invert = true). */
	inversionParams: InversionParams;
	/**
	 * Roll baseline bounds that apply to this frame, or null when the frame
	 * normalizes against its own bounds.
	 */
	rollBaseline: AppliedBaseline | null;
	/**
	 * Quadrilateral crop with perspective correction.
	 * When null, no crop is applied (full image).
	 */
	cropQuad: CropQuad | null;
	/** Transform parameters (rotation, flip). */
	transform: TransformParams;
}

export type FrameFlag = 'pick' | 'reject' | 'edited' | 'missing';

export interface Roll {
	id: string;
	createdAt: number; // unix ms
	label: string;
	filmStock: string;
	/**
	 * Nominal box speed of the film stock in ISO/ASA.
	 * 0 = unset / unknown. Old DB records that lack this field
	 * should be read with `roll.iso ?? 0`.
	 */
	iso: number;
	camera: string;
	/**
	 * Lens used for this roll (freeform, e.g. "Nikkor 50mm f/1.4").
	 * Old DB records that lack this field should be read with `roll.lens ?? ''`.
	 */
	lens: string;
	notes: string;
	rollEdit: RollEditParams;
	/** Pooled normalization bounds from the last roll analysis. Absent until one runs. */
	baseline?: RollBaseline;
}

// ─── Negative analysis ────────────────────────────────────────────────────────

/**
 * Version of the negative analysis (bounds + meters). Bump whenever the
 * measurement changes: cached analyses and roll baselines stamped with another
 * version are ignored and re-measured.
 */
export const ANALYSIS_VERSION = 1;

/**
 * Near-neutral reference densities of a frame: per-channel raw log10 values of
 * the lowest-chroma pixels in a midtone, shadow and (when present) highlight
 * luma band. Cast Removal fits red and blue to green along it.
 */
export interface NeutralAxis {
	mid: Vec3;
	shadow: Vec3;
	highlight: Vec3 | null;
	/** How trustworthy the neutral sets are, 0–1. Scales the correction. */
	confidence: number;
}

/**
 * Everything measured from a frame's pixels that the print curve is solved
 * from. Computed by the preview and persisted so the native export renders the
 * same picture; the exporter re-measures when it is absent or stale.
 */
export interface NegativeAnalysis {
	version: number;
	/** The frame's own bounds — never the roll mix (see `LogBounds`). */
	floors: Vec3;
	ceils: Vec3;
	/** Metered midtone in normalized luma, already pulled toward the assumed anchor and clamped. */
	anchor: number;
	/** Luma spread of the textured areas, in log10 density. */
	texturalRange: number;
	neutralAxis: NeutralAxis | null;
	/** `AppliedBaseline.key` the meters were read against; null = the frame's own bounds. */
	baselineKey: number | null;
}

/** Bounds pooled across a roll: the orange mask and base are roll properties. */
export interface RollBaseline {
	version: number;
	floors: Vec3;
	ceils: Vec3;
	/** Frames whose colour sits far from the roll's; they keep their own bounds. */
	outlierFrameIds: string[];
	/** Take the roll's tonal range (luma-weighted centre and span). */
	useLuma: boolean;
	/** Take the roll's per-channel balance. */
	useColor: boolean;
	/** Unix ms of the analysis; identifies this baseline in cached analyses. */
	analyzedAt: number;
}

/** A `RollBaseline` as it applies to one frame. */
export interface AppliedBaseline {
	floors: Vec3;
	ceils: Vec3;
	useLuma: boolean;
	useColor: boolean;
	/**
	 * Identifies the baseline and its axis toggles: an analysis metered against
	 * another key is stale. Opaque — compare for equality only.
	 */
	key: number;
}

export interface Frame {
	id: string;
	rollId: string;
	/** Filename only — directory comes from the Roll's stored handle. */
	filename: string;
	/** 1-based index within the roll. */
	index: number;
	rating: number; // 0–5
	flags: FrameFlag[];
	notes: string;
	/** Unix ms from EXIF, null if unavailable. */
	capturedAt: number | null;
	frameEdit: FrameEditOverrides;
	/**
	 * Analysis cached from the last preview render, so batch export matches
	 * what the user approved in the editor. `undefined` if the frame has never
	 * been opened in the editor.
	 */
	cachedAnalysis?: NegativeAnalysis;
}

// ─── Library (image browsing mode) ────────────────────────────────────────────

export interface Library {
	id: string;
	createdAt: number; // unix ms
	label: string;
	notes: string;
}

export interface LibraryImage {
	id: string;
	libraryId: string;
	/** Relative path from library root (e.g. "subdir/image.jpg" or "image.jpg"). */
	relativePath: string;
	/** Filename only (basename) — for display purposes. */
	filename: string;
	/** 0-based index within the library. */
	index: number;
	rating: number; // 0–5
	notes: string;
	/** Unix ms, set when the image is added to the library. */
	createdAt: number;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const identityCurve: CurvePoints = {
	points: [
		{ x: 0, y: 0 },
		{ x: 1, y: 1 },
	],
};

/** Identity matrix — passthrough, to be replaced with real camera matrix. */
const identityMatrix: Matrix3x3 = [
	1, 0, 0,
	0, 1, 0,
	0, 0, 1,
];

export const DEFAULT_INVERSION_PARAMS: InversionParams = {
	autoExposure: true,
	density: 1.0,
	grade: 2.5,
	cmyCyan: 0.0,
	cmyMagenta: 0.0,
	cmyYellow: 0.0,
	shadowCyan: 0.0,
	shadowMagenta: 0.0,
	shadowYellow: 0.0,
	highlightCyan: 0.0,
	highlightMagenta: 0.0,
	highlightYellow: 0.0,
	castRemoval: 0.5,
	shadows: 0.0,
	highlights: 0.0,
	toe: 0.0,
	shoulder: 0.0,
	claheStrength: 0.25,
	vibrance: 0.0,
	saturation: 0.0,
	sharpen: 0.25,
	glow: 0.0,
	filmType: 'C41',
	tonePreset: 'standard',
	borderWidth: 0,
	borderColor: 'black',
};

export const DEFAULT_ROLL_EDIT: RollEditParams = {
	rebateRegion: { x: 0, y: 0, w: 0.05, h: 1 },
	cameraColorMatrix: identityMatrix,
	ashotWBCoeffs: [1, 1, 1],
	lightSourceTemp: 5500,
	baseToneCurve: identityCurve,
	baseRGBCurves: [identityCurve, identityCurve, identityCurve],
	invert: true,
	inversionParams: DEFAULT_INVERSION_PARAMS,
};

export const DEFAULT_FRAME_EDIT: FrameEditOverrides = {
	exposureCompensation: null,
	whiteBalance: null,
	toneCurve: null,
	rgbCurves: null,
	rebateRegion: null,
	inversionParams: null,
	cropQuad: null,
	transform: null,
};

export const DEFAULT_WHITE_BALANCE: WhiteBalance = {
	temperature: 5500,
	tint: 0,
};

// ─── Resolution helper ────────────────────────────────────────────────────────

/**
 * The roll baseline as it applies to `frame`: null when the roll has none, it
 * was measured by another analysis version, both axes are switched off, or the
 * frame is an outlier (shot under a different light — it keeps its own bounds).
 */
function appliedBaseline(roll: Roll, frame: Frame): AppliedBaseline | null {
	const b = roll.baseline;
	if (!b || b.version !== ANALYSIS_VERSION) return null;
	if (!b.useLuma && !b.useColor) return null;
	if (b.outlierFrameIds.includes(frame.id)) return null;
	return {
		floors: b.floors,
		ceils: b.ceils,
		useLuma: b.useLuma,
		useColor: b.useColor,
		// Toggling an axis changes the bounds the meters read, so the toggles
		// are part of the identity (4× a unix-ms stamp stays exact in a double).
		key: b.analyzedAt * 4 + (b.useLuma ? 2 : 0) + (b.useColor ? 1 : 0),
	};
}

export function resolveEdit(roll: Roll, frame: Frame): EffectiveEdit {
	const r = roll.rollEdit;
	const f = frame.frameEdit;
	// Guard against rolls where cameraColorMatrix is missing, all-zero, or contains
	// null/NaN (e.g. rawler returned null for missing DNG matrix entries, or the field
	// didn't exist in an older DB record).  Fall back to identity so the GPU shader
	// always receives a valid non-zero matrix.
	const rawM = r.cameraColorMatrix as unknown;
	const colorMatrix: Matrix3x3 =
		Array.isArray(rawM) &&
			rawM.length === 9 &&
			(rawM as number[]).every((v) => typeof v === 'number' && isFinite(v)) &&
			(rawM as number[]).some((v) => v !== 0)
			? (rawM as Matrix3x3)
			: identityMatrix;

	// Guard against missing/invalid ashotWBCoeffs (older DB records won't have it).
	const rawWB = r.ashotWBCoeffs as unknown;
	const ashotWBCoeffs: [number, number, number] =
		Array.isArray(rawWB) &&
			rawWB.length === 3 &&
			(rawWB as number[]).every((v) => typeof v === 'number' && isFinite(v) && v > 0)
			? (rawWB as [number, number, number])
			: [1, 1, 1];

	return {
		rebateRegion: f.rebateRegion ?? r.rebateRegion,
		cameraColorMatrix: colorMatrix,
		ashotWBCoeffs,
		lightSourceTemp: r.lightSourceTemp,
		exposureCompensation: f.exposureCompensation ?? 0,
		whiteBalance: f.whiteBalance ?? DEFAULT_WHITE_BALANCE,
		toneCurve: f.toneCurve ?? r.baseToneCurve ?? identityCurve,
		// Guard against old DB records where baseRGBCurves may be missing.
		rgbCurves:
			f.rgbCurves ??
			((r as { baseRGBCurves?: [CurvePoints, CurvePoints, CurvePoints] }).baseRGBCurves ??
				[identityCurve, identityCurve, identityCurve]),
		invert: r.invert,
		// Per-frame override wins; fall back to roll default; guard against old DB records.
		// Spread DEFAULT_INVERSION_PARAMS first so any fields missing from older
		// DB records (e.g. claheStrength added later) get sensible defaults.
		inversionParams: {
			...DEFAULT_INVERSION_PARAMS,
			...((f as { inversionParams?: InversionParams | null }).inversionParams
				?? (r as { inversionParams?: InversionParams }).inversionParams
				?? DEFAULT_INVERSION_PARAMS),
		},
		rollBaseline: appliedBaseline(roll, frame),
		// Crop quad is frame-only (no roll-level default).
		cropQuad: (f as { cropQuad?: CropQuad | null }).cropQuad ?? null,
		// Transform is frame-only (no roll-level default).
		transform: (f as { transform?: TransformParams | null }).transform ?? DEFAULT_TRANSFORM,
	};
}

// ─── Edit-state helpers ───────────────────────────────────────────────────────

/**
 * True when a frame has been deliberately altered by the user via the editor's
 * transform, color, or effect controls — i.e. it diverges from the roll-level
 * baseline in a way the user authored.
 *
 * What counts as "edited":
 *   - Color   : `exposureCompensation`, `whiteBalance`, `toneCurve`, `rgbCurves`
 *   - Transform: `cropQuad`, `transform`
 *   - Effect  : `inversionParams` *only when it differs from the roll default*
 *
 * What does NOT count:
 *   - `rebateRegion` — currently auto-detected only, no user-facing UI.
 *   - `inversionParams` matching the roll default — at import time we eagerly
 *     seed each frame's `inversionParams` from the chosen film type so the
 *     pipeline has sane defaults; that's not a user edit.
 *
 * Used to drive "Select edited" in the export UI and any other "this frame has
 * been touched" affordance.
 */
export function frameHasEdits(frame: Frame, roll: Roll): boolean {
	const f = frame.frameEdit;
	if (
		f.exposureCompensation !== null ||
		f.whiteBalance !== null ||
		f.toneCurve !== null ||
		f.rgbCurves !== null ||
		f.cropQuad !== null ||
		f.transform !== null
	) {
		return true;
	}
	// `inversionParams` is pre-seeded at import for non-mixed rolls, so non-null
	// alone doesn't imply user intent. Only count it when it diverges from the
	// roll-level inversion baseline.
	if (f.inversionParams !== null) {
		return !inversionParamsEqual(f.inversionParams, roll.rollEdit.inversionParams);
	}
	return false;
}

/** Deep equality for `InversionParams` — flat record of primitives. */
function inversionParamsEqual(a: InversionParams, b: InversionParams): boolean {
	const keys = Object.keys(a) as (keyof InversionParams)[];
	for (const k of keys) {
		if (a[k] !== b[k]) return false;
	}
	return true;
}
