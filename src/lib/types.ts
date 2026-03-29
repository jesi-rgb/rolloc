// ─── Geometry ────────────────────────────────────────────────────────────────

/** Normalized rect, all values 0–1 relative to image dimensions. */
export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

// ─── Color / Curve primitives ─────────────────────────────────────────────────

/** Row-major 3×3 matrix: [m00, m01, m02, m10, m11, m12, m20, m21, m22] */
export type Matrix3x3 = [
	number, number, number,
	number, number, number,
	number, number, number,
];

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

// ─── NegPy inversion parameters ──────────────────────────────────────────────

/**
 * Parameters for the NegPy film-negative inversion pipeline.
 * Models the darkroom physics of projecting a negative through an enlarger.
 *
 * Stage 1 — Log normalization:
 *   Converts linear transmittance to log-density and per-channel stretches
 *   to [0,1], simultaneously inverting and removing the orange mask.
 *
 * Stage 2 — H&D sigmoid (paper response):
 *   Applies a logistic characteristic curve that simulates photographic paper.
 */
export interface InversionParams {
	/** Pivot point (0–1) — controls "exposure" / density shift. Default 0.5. */
	density: number;
	/** Sigmoid contrast slope — equivalent to paper "grade". Default 2.0. */
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

	// ── Tonal density adjustments ─────────────────────────────────────────────
	/** Overall shadow density lift/pull. */
	shadows: number;
	/** Overall highlight density lift/pull. */
	highlights: number;

	// ── Toe (shadow rolloff) ──────────────────────────────────────────────────
	toe: number;
	toeWidth: number;
	toeHardness: number;

	// ── Shoulder (highlight rolloff) ──────────────────────────────────────────
	shoulder: number;
	shoulderWidth: number;
	shoulderHardness: number;
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
}

export type FrameFlag = 'pick' | 'reject' | 'edited';

export interface Roll {
	id: string;
	createdAt: number; // unix ms
	label: string;
	filmStock: string;
	camera: string;
	notes: string;
	rollEdit: RollEditParams;
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
	density:          1.0,
	grade:            2.0,
	cmyCyan:          0.0,
	cmyMagenta:       0.0,
	cmyYellow:        0.0,
	shadowCyan:       0.0,
	shadowMagenta:    0.0,
	shadowYellow:     0.0,
	highlightCyan:    0.0,
	highlightMagenta: 0.0,
	highlightYellow:  0.0,
	shadows:          0.0,
	highlights:       0.0,
	toe:              0.0,
	toeWidth:         3.0,
	toeHardness:      1.0,
	shoulder:         0.0,
	shoulderWidth:    3.0,
	shoulderHardness: 1.0,
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
};

export const DEFAULT_WHITE_BALANCE: WhiteBalance = {
	temperature: 5500,
	tint: 0,
};

// ─── Resolution helper ────────────────────────────────────────────────────────

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
		rebateRegion:         f.rebateRegion         ?? r.rebateRegion,
		cameraColorMatrix:    colorMatrix,
		ashotWBCoeffs,
		lightSourceTemp:      r.lightSourceTemp,
		exposureCompensation: f.exposureCompensation ?? 0,
		whiteBalance:         f.whiteBalance         ?? DEFAULT_WHITE_BALANCE,
		toneCurve:            f.toneCurve            ?? r.baseToneCurve,
		rgbCurves:            f.rgbCurves            ?? r.baseRGBCurves,
		invert:               r.invert,
		// Per-frame override wins; fall back to roll default; guard against old DB records.
		inversionParams:
			(f as { inversionParams?: InversionParams | null }).inversionParams
			?? (r as { inversionParams?: InversionParams }).inversionParams
			?? DEFAULT_INVERSION_PARAMS,
	};
}
