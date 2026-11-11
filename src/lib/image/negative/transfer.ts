/**
 * Transparency transfer: the render of a slide, "the slide as captured".
 *
 * A slide is already a positive, so it is not metered: it normalizes over a fixed window from
 * the source's white level (density 0) down `TRANSFER_DENSITY_RANGE` decades, the same for every
 * frame (`transferBounds`), and the transfer curve inverts that window exactly. At default
 * settings `10^−D` returns the source's linear value; the controls deviate from there:
 *   1. D = k·(n + cmyOffset − pivot)                         (solve: k = R, pivot = 0)
 *   2. D += shadowCmy·w + highlightCmy·(1 − w), w = σ(k_wb·(D − c_wb))   (regional CMY)
 *   3. D −= toe · softplus(D − toeKnee, width)               (shadow roll-off)
 *   4. D += shoulder · softplus(shoulderKnee − D, width)     (highlight roll-off)
 *   5. a scene-linear (RAW) source: ODT(2^baselineEv · 10^−D), Narkowicz's ACES fit;
 *      a display-referred (8-bit) source: 10^−D re-expanded with the standard display gamma.
 * The tone-preset encode and the tone stage after it are the negatives' own (hd_curve.wgsl).
 *
 * Port of NegPy 0.68 `apply_transfer_curve`, `transfer_bounds`, `wb_split_geometry`,
 * `display_rendering`, `slide_pick_wb` (negpy/features/transparency/logic.py) and
 * `camera_to_working_matrix` (negpy/features/process/capture_color.py), at Rolloc's neutral
 * density and grade (exposure offset 0, contrast 1: Brightness and Contrast act in the tone
 * stage) and the reference knee width. Mirrored in src-tauri/src/negative/transfer.rs and the
 * E6 branch of src/lib/image/shaders/hd_curve.wgsl — change all three together.
 */

import {
	CMY_MAX_DENSITY,
	D_MAX,
	D_MIN,
	REFERENCE_PRINT_DENSITY,
	REGIONAL_CMY_SHARPNESS,
	SLIDE_K_CYAN,
	SLIDE_K_YELLOW,
	STANDARD_TONE_GAMMA,
	TRANSFER_BASELINE_EV,
	TRANSFER_CONTRAST_PIVOT,
	TRANSFER_DENSITY_RANGE,
	TRANSFER_KNEE_WIDTH,
	TRANSFER_SHOULDER_KNEE,
	TRANSFER_TOE_KNEE,
} from './constants';
import type { LogBounds, Matrix3x3, Vec3 } from '$lib/types';
import type { PrintCurveParams } from './print-curve';

/** Linear gain of the baseline exposure a scene-linear slide gets before the display rendering. */
export const TRANSFER_BASELINE_GAIN = 2 ** TRANSFER_BASELINE_EV;

/** Smallest determinant / row sum the camera matrix construction divides by (NegPy's 1e-9). */
const MATRIX_EPS = 1e-9;

/**
 * The fixed window a slide normalizes with (NegPy `transfer_bounds`): the source's white level
 * (log10 = 0) down `TRANSFER_DENSITY_RANGE` decades, so `n = D / R`. Content-independent on
 * purpose: two exposures of one slide must not converge on one render.
 */
export function transferBounds(): LogBounds {
	const r = TRANSFER_DENSITY_RANGE;
	return { floors: [0, 0, 0], ceils: [-r, -r, -r] };
}

/**
 * Normalized position of a properly exposed slide's midtone on the fixed window (NegPy
 * `transfer_assumed_anchor`): the anchor a slide's analysis carries, since nothing is metered.
 */
export function transferAssumedAnchor(): number {
	return TRANSFER_CONTRAST_PIVOT / TRANSFER_DENSITY_RANGE;
}

/**
 * `[centre, sharpness]` of the shadow/highlight CMY split on the transfer's density scale
 * (NegPy `wb_split_geometry`): the print's split, centred on the reference print density with
 * `REGIONAL_CMY_SHARPNESS`, carried across by tonal position rather than by raw density.
 */
export function wbSplitGeometry(): [number, number] {
	const span = D_MAX - D_MIN;
	return [
		((REFERENCE_PRINT_DENSITY - D_MIN) / span) * TRANSFER_DENSITY_RANGE,
		(REGIONAL_CMY_SHARPNESS * span) / TRANSFER_DENSITY_RANGE,
	];
}

const [WB_SPLIT_CENTRE, WB_SPLIT_SHARPNESS] = wbSplitGeometry();

/** Overflow-free logistic sigmoid. */
function sigmoid(x: number): number {
	if (x >= 0) return 1 / (1 + Math.exp(-x));
	const z = Math.exp(x);
	return z / (1 + z);
}

/**
 * `width · log(1 + exp(−|x| / width))`: NegPy's `_softplus(x, width)` less its `max(x, 0)` part,
 * which the knees below apply as a pull toward the knee instead.
 */
function softplusTail(x: number, width: number): number {
	return width * Math.log1p(Math.exp(-Math.abs(x) / width));
}

/**
 * Density of one channel at normalized value `n`: steps 1–4 of the module header. Every term
 * vanishes at its neutral value, so at defaults this is exactly `R · n`.
 *
 * The knees are NegPy's `D − toe·softplus(D − toeKnee)` and `D + shoulder·softplus(shoulderKnee
 * − D)`. Past a knee the linear part of the softplus is applied as `(1 − a)·D + a·knee`, the same
 * value without cancelling D against itself, so a full roll-off flattens onto the knee and stays
 * monotonic in f32 (the Rust and WGSL mirrors).
 */
export function transferDensity(n: number, channel: 0 | 1 | 2, p: PrintCurveParams): number {
	let d = p.slopes[channel] * (n + p.cmyOffsets[channel] - p.pivots[channel]);
	const s = p.shadowCmy[channel];
	const h = p.highlightCmy[channel];
	if (s !== 0 || h !== 0) {
		const w = sigmoid(WB_SPLIT_SHARPNESS * (d - WB_SPLIT_CENTRE));
		d += s * w + h * (1 - w);
	}
	if (p.toe !== 0) {
		const x = d - TRANSFER_TOE_KNEE;
		const pulled = x > 0 ? (1 - p.toe) * d + p.toe * TRANSFER_TOE_KNEE : d;
		d = pulled - p.toe * softplusTail(x, TRANSFER_KNEE_WIDTH);
	}
	if (p.shoulder !== 0) {
		const x = TRANSFER_SHOULDER_KNEE - d;
		const pulled = x > 0 ? (1 - p.shoulder) * d + p.shoulder * TRANSFER_SHOULDER_KNEE : d;
		d = pulled + p.shoulder * softplusTail(x, TRANSFER_KNEE_WIDTH);
	}
	return d;
}

/** Scene-linear transmittance `10^−D` of one channel: the source's own value at defaults. */
export function transferLinear(n: number, channel: 0 | 1 | 2, p: PrintCurveParams): number {
	return Math.pow(10, -transferDensity(n, channel, p));
}

/**
 * Scene-linear → display-linear (NegPy `display_rendering`): Narkowicz's closed-form fit to the
 * ACES RRT + sRGB ODT. Monotonic on [0, ∞), 0 → 0, clamped to 1.
 */
export function displayRendering(sceneLinear: number): number {
	const x = Math.max(sceneLinear, 0);
	const num = x * (2.51 * x + 0.03);
	const den = x * (2.43 * x + 0.59) + 0.14;
	return Math.min(Math.max(num / Math.max(den, 1e-8), 0), 1);
}

/** IEC 61966-2-1 sRGB OETF: the inverse of the EOTF every 8-bit source was expanded with. */
function srgbEncode(linear: number): number {
	return linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
}

/**
 * The display-linear value of one channel that the tone-preset encode receives (step 5).
 *
 * A scene-linear source (a RAW capture, anchored to the sensor white level) gets NegPy's
 * baseline exposure and display rendering. A display-referred source (an 8-bit scan or bitmap,
 * expanded with the sRGB EOTF upstream) skips both, as NegPy's Positive path does, and is
 * re-expanded with `STANDARD_TONE_GAMMA` so the standard preset's encode returns the source's
 * own code values.
 */
export function transferDisplay(
	n: number,
	channel: 0 | 1 | 2,
	p: PrintCurveParams,
	sceneLinear: boolean,
): number {
	const linear = transferLinear(n, channel, p);
	if (sceneLinear) return displayRendering(linear * TRANSFER_BASELINE_GAIN);
	return Math.pow(srgbEncode(Math.min(Math.max(linear, 0), 1)), STANDARD_TONE_GAMMA);
}

/** Inverse of a row-major 3×3, or null when singular or not finite. */
function invert3(m: Matrix3x3): Matrix3x3 | null {
	const [a, b, c, d, e, f, g, h, i] = m;
	const c00 = e * i - f * h;
	const c01 = f * g - d * i;
	const c02 = d * h - e * g;
	const det = a * c00 + b * c01 + c * c02;
	if (!Number.isFinite(det) || Math.abs(det) < MATRIX_EPS) return null;
	return [
		c00 / det, (c * h - b * i) / det, (b * f - c * e) / det,
		c01 / det, (a * i - c * g) / det, (c * d - a * f) / det,
		c02 / det, (b * g - a * h) / det, (a * e - b * d) / det,
	];
}

/**
 * Linear-light matrix a RAW slide goes through before the log: camera-native RGB, decoded without
 * white balance, to linear sRGB with the as-shot balance folded back in (NegPy
 * `camera_to_working_matrix` with `camera_wb`).
 *
 * `cameraColorMatrix` is rawler's `cam_to_xyz_normalized` (its XYZ→camera rows normalized so XYZ
 * (1, 1, 1) reads as camera neutral) followed by XYZ→linear sRGB, so a balanced camera neutral
 * lands off neutral. NegPy normalizes the working→camera rows instead (dcraw's order), which is
 * this matrix with its columns scaled by `M⁻¹·(1, 1, 1)`: the rows then sum to 1, so a balanced
 * neutral stays neutral. The decode skips the as-shot multipliers on the inversion path, so they
 * are folded in, normalized to green. A singular or non-finite matrix applies no primaries; an
 * invalid white balance (non-finite or not positive) folds nothing.
 */
export function slideCameraMatrix(cameraColorMatrix: Matrix3x3, asShotWb: Vec3): Matrix3x3 {
	const inv = cameraColorMatrix.every(Number.isFinite) ? invert3(cameraColorMatrix) : null;
	const sums: Vec3 | null = inv && [
		inv[0] + inv[1] + inv[2],
		inv[3] + inv[4] + inv[5],
		inv[6] + inv[7] + inv[8],
	];
	const primaries = sums && sums.every((s) => Math.abs(s) >= MATRIX_EPS);
	const wbValid = asShotWb.every((v) => Number.isFinite(v) && v > 0);
	const gains: Vec3 = wbValid
		? [asShotWb[0] / asShotWb[1], 1, asShotWb[2] / asShotWb[1]]
		: [1, 1, 1];
	const out: Matrix3x3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
	for (let r = 0; r < 3; r++) {
		for (let c = 0; c < 3; c++) {
			const m = primaries && sums ? cameraColorMatrix[r * 3 + c] * sums[c] : r === c ? 1 : 0;
			out[r * 3 + c] = m * gains[c];
		}
	}
	return out;
}

/**
 * Global cyan/magenta/yellow sliders that print a picked slide patch gray (NegPy `slide_pick_wb`
 * at contrast 1): cyan and yellow along the Temperature direction, magenta as the tint
 * remainder. `rawLog` is the patch's mean log10 density in the space the transfer reads (after
 * the camera matrix); it is normalized with `bounds` and scaled back to absolute density by each
 * channel's range. Clamped to [-1, 1] as NegPy's caller does; 0 where the sample is not finite.
 */
export function slidePickWb(
	rawLog: Vec3,
	bounds: LogBounds,
): { cyan: number; magenta: number; yellow: number } {
	const offset = (ch: 0 | 1 | 2): number => {
		const span = bounds.ceils[ch] - bounds.floors[ch];
		const safe = Math.abs(span) > 1e-6 ? span : 1e-6;
		const n = (rawLog[ch] - bounds.floors[ch]) / safe;
		return (-n * Math.abs(span)) / CMY_MAX_DENSITY;
	};
	const o: Vec3 = [offset(0), offset(1), offset(2)];
	const a = (o[2] - o[0]) / (SLIDE_K_CYAN + SLIDE_K_YELLOW);
	const slider = (v: number): number => (Number.isFinite(v) ? Math.min(Math.max(v, -1), 1) : 0);
	return {
		cyan: slider(-SLIDE_K_CYAN * a),
		magenta: slider(o[1] - o[0] - SLIDE_K_CYAN * a),
		yellow: slider(SLIDE_K_YELLOW * a),
	};
}
