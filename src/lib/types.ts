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
	/** Light source colour temperature used to interpolate the colour matrix. */
	lightSourceTemp: number;
	/** Default tone curve applied to all frames (global, post-inversion). */
	baseToneCurve: CurvePoints;
	/** Default per-channel RGB curves [R, G, B]. */
	baseRGBCurves: [CurvePoints, CurvePoints, CurvePoints];
	/** Whether to invert the image (true = film negative; false = positive/already-scanned). */
	invert: boolean;
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
}

/**
 * The fully resolved edit — what the GPU pipeline actually receives.
 * Computed at render time by merging roll defaults with frame overrides.
 */
export interface EffectiveEdit {
	rebateRegion: Rect;
	cameraColorMatrix: Matrix3x3;
	lightSourceTemp: number;
	exposureCompensation: number;
	whiteBalance: WhiteBalance;
	toneCurve: CurvePoints;
	rgbCurves: [CurvePoints, CurvePoints, CurvePoints];
	invert: boolean;
}

// ─── Domain entities ──────────────────────────────────────────────────────────

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
	/** Filename only — directory comes from the Library's stored handle. */
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

export const DEFAULT_ROLL_EDIT: RollEditParams = {
	rebateRegion: { x: 0, y: 0, w: 0.05, h: 1 },
	cameraColorMatrix: identityMatrix,
	lightSourceTemp: 5500,
	baseToneCurve: identityCurve,
	baseRGBCurves: [identityCurve, identityCurve, identityCurve],
	invert: false,
};

export const DEFAULT_FRAME_EDIT: FrameEditOverrides = {
	exposureCompensation: null,
	whiteBalance: null,
	toneCurve: null,
	rgbCurves: null,
	rebateRegion: null,
};

export const DEFAULT_WHITE_BALANCE: WhiteBalance = {
	temperature: 5500,
	tint: 0,
};

// ─── Resolution helper ────────────────────────────────────────────────────────

export function resolveEdit(roll: Roll, frame: Frame): EffectiveEdit {
	const r = roll.rollEdit;
	const f = frame.frameEdit;
	return {
		rebateRegion:         f.rebateRegion         ?? r.rebateRegion,
		cameraColorMatrix:    r.cameraColorMatrix,
		lightSourceTemp:      r.lightSourceTemp,
		exposureCompensation: f.exposureCompensation ?? 0,
		whiteBalance:         f.whiteBalance         ?? DEFAULT_WHITE_BALANCE,
		toneCurve:            f.toneCurve            ?? r.baseToneCurve,
		rgbCurves:            f.rgbCurves            ?? r.baseRGBCurves,
		invert:               r.invert,
	};
}
