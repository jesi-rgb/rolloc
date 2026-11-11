/**
 * Print curve of the negative pipeline: normalized negative value → print density.
 *
 * A straight line in density (optionally quadratic per channel, for Cast Removal) through a
 * variable-gamma paper S-curve and regional CMY, bounded by two independent softplus knees:
 * the shoulder rolls highlights into paper white, the toe rolls shadows into paper black.
 * Black point compensation maps paper black to display black.
 *
 * Port of NegPy 0.68 `CharacteristicCurve` and its helpers (negpy/features/exposure/logic.py),
 * the print curve kernel (negpy_core/src/print_curve.rs) and exposure.wgsl, at NegPy's defaults
 * with paper white off (`d_min = 0`), knee widths at the reference and BPC on. A B&W print
 * collapses the channels to one density first (`collapseBw`) and prints it on the base curve.
 * Mirrored in src-tauri/src/negative/curve.rs and src/lib/image/shaders/hd_curve.wgsl — change
 * all three.
 */

import {
	ANCHOR_TARGET_DENSITY,
	ASSUMED_ANCHOR,
	BW_FILTER_WEIGHTS_NONE,
	D_MAX,
	PAPER_GAMMA_WIDTH,
	PAPER_MIDTONE_GAMMA,
	REFERENCE_PRINT_DENSITY,
	REGIONAL_CMY_SHARPNESS,
	SHOULDER_GRADE_STRENGTH,
	SHOULDER_HEIGHT,
	SHOULDER_SHARPNESS_BASE,
	SLOPE_MAX,
	SLOPE_MIN,
	STANDARD_TONE_GAMMA,
	TOE_GRADE_STRENGTH,
	TOE_HEIGHT,
	TOE_SHARPNESS_BASE,
	TOE_SHOULDER_STRENGTH,
	TRANSFER_KNEE_WIDTH,
	TRANSFER_SHOULDER_KNEE,
	TRANSFER_TOE_KNEE,
} from './constants';
import { TRANSFER_BASELINE_GAIN, wbSplitGeometry } from './transfer';
import type { FilmType, Vec3 } from '$lib/types';

/** The solved print curve of one frame. */
export interface PrintCurveParams {
	/** Core per channel: v = k·(x − pivot) + curv·x², x = u + cmyOffset. */
	slopes: Vec3;
	pivots: Vec3;
	curvatures: Vec3;
	/** Normalized-space filtration, added to u. */
	cmyOffsets: Vec3;
	/** Absolute density, split by the regional weight. */
	shadowCmy: Vec3;
	highlightCmy: Vec3;
	/** Effective (grade-coupled) slider values. */
	toe: number;
	shoulder: number;
}

/** The post-curve tone stage of hd_curve.wgsl; semantics unchanged by the port. */
export interface ToneStageParams {
	exposure: number;
	contrast: number;
	shadows: number;
	highlights: number;
	vibrance: number;
	saturation: number;
	toneGamma: number;
	blackPoint: number;
	whitePoint: number;
	midtoneCurve: number;
}

/** Per-frame constants of the kernel, derived once from toe and shoulder. */
interface Prologue {
	/** Paper white and paper black of the knees. */
	dMinEff: number;
	dMaxEff: number;
	/** Shoulder (highlight) and toe (shadow) knee sharpness. */
	aHl: number;
	aSh: number;
	/** Transmittance BPC maps to display black. */
	bpcBlack: number;
}

/** Bisection steps of `straightLineTarget`, as NegPy. */
const MIDTONE_BISECTION_STEPS = 60;
/** Smallest slope `computePivot` divides by; a flatter one keeps the anchor as pivot. */
const MIN_PIVOT_SLOPE = 1e-6;

/** NegPy `_inv_softplus_np`: log(exp(y) − 1), stable for y > 0. */
function invSoftplus(y: number): number {
	return y > 20 ? y : Math.log(Math.expm1(Math.max(y, 1e-12)));
}

/** Overflow-free log(1 + exp(x)). */
function softplus(x: number): number {
	return Math.max(x, 0) + Math.log1p(Math.exp(-Math.abs(x)));
}

/** Overflow-free logistic sigmoid (NegPy `_fast_sigmoid`). */
function sigmoid(x: number): number {
	if (x >= 0) return 1 / (1 + Math.exp(-x));
	const z = Math.exp(x);
	return z / (1 + z);
}

/**
 * Straight-line value v that the base knees (toe = shoulder = 0) map onto `target`.
 * NegPy `_reference_linear_value` with `d_min = 0`: closed form via the inverse softplus.
 */
export function referenceLinearValue(target: number = REFERENCE_PRINT_DENSITY): number {
	const v1 = D_MAX - invSoftplus(TOE_SHARPNESS_BASE * (D_MAX - target)) / TOE_SHARPNESS_BASE;
	return invSoftplus(SHOULDER_SHARPNESS_BASE * v1) / SHOULDER_SHARPNESS_BASE;
}

/** Centre of the paper S-curve: the reference tone keeps its density through it. */
const V_STAR = referenceLinearValue();

/** The variable-gamma paper S-curve (NegPy `_through_midtone`). */
function throughMidtone(v: number): number {
	return v + PAPER_MIDTONE_GAMMA * PAPER_GAMMA_WIDTH * Math.tanh((v - V_STAR) / PAPER_GAMMA_WIDTH);
}

/**
 * Straight-line value that prints `target` through the S-curve and the base knees: the
 * inverse of `throughMidtone` at `referenceLinearValue(target)` (NegPy `_straight_line_target`).
 */
function straightLineTarget(target: number): number {
	const goal = referenceLinearValue(target);
	const reach = Math.abs(PAPER_MIDTONE_GAMMA) * PAPER_GAMMA_WIDTH;
	let lo = goal - reach;
	let hi = goal + reach;
	for (let i = 0; i < MIDTONE_BISECTION_STEPS; i++) {
		const mid = 0.5 * (lo + hi);
		if (throughMidtone(mid) < goal) lo = mid;
		else hi = mid;
	}
	return 0.5 * (lo + hi);
}

/**
 * Pivot that prints the anchor where the paper expects it (NegPy `compute_pivot` with the
 * density slider at neutral). A metered anchor lands on `ANCHOR_TARGET_DENSITY` through the
 * S-curve; `null` places `ASSUMED_ANCHOR` on the S-curve centre (NegPy `_anchor_linear_value`).
 */
export function computePivot(slope: number, anchor: number | null): number {
	const ref = anchor ?? ASSUMED_ANCHOR;
	const v = anchor === null ? V_STAR : straightLineTarget(ANCHOR_TARGET_DENSITY);
	if (!(slope > MIN_PIVOT_SLOPE)) return ref;
	return ref - v / slope;
}

/**
 * Grade-coupled toe and shoulder (NegPy `grade_coupled_shape`): harder grades get a snappier
 * toe and a more compressed shoulder. `slopeG` is the green (base) slope.
 */
export function gradeCoupledShape(slopeG: number, toe: number, shoulder: number): [number, number] {
	const n = Math.min(Math.max((slopeG - SLOPE_MIN) / (SLOPE_MAX - SLOPE_MIN), 0), 1);
	return [toe + TOE_GRADE_STRENGTH * n, shoulder + SHOULDER_GRADE_STRENGTH * n];
}

/**
 * Kernel prologue (negpy_core `print_curve.rs` prologue, `black_density_rgb`). The slider values
 * are clamped to [-1, 1] as NegPy's `per_channel_toe_shoulder` does, then scaled by
 * `TOE_SHOULDER_STRENGTH`. A negative toe sharpens the shadow knee instead of deepening black,
 * and raises the BPC clip point by the same height.
 */
function prologue(toe: number, shoulder: number): Prologue {
	const toeEff = Math.min(Math.max(toe, -1), 1) * TOE_SHOULDER_STRENGTH;
	const shoulderEff = Math.min(Math.max(shoulder, -1), 1) * TOE_SHOULDER_STRENGTH;
	const dMinEff = Math.max(0, shoulderEff * SHOULDER_HEIGHT);
	const negativeToe = toeEff < 0;
	const dMaxBase = negativeToe ? D_MAX : D_MAX - toeEff * TOE_HEIGHT;
	const aSh = negativeToe ? TOE_SHARPNESS_BASE * (1 - toeEff * 4) : TOE_SHARPNESS_BASE;
	const blackDensity = negativeToe ? D_MAX + toeEff * TOE_HEIGHT : D_MAX;
	return {
		dMinEff,
		dMaxEff: Math.max(dMaxBase, dMinEff + 0.1),
		aHl: SHOULDER_SHARPNESS_BASE,
		aSh,
		bpcBlack: Math.pow(10, -blackDensity),
	};
}

function densityWith(u: number, channel: 0 | 1 | 2, p: PrintCurveParams, pro: Prologue): number {
	const k = p.slopes[channel];
	const curv = p.curvatures[channel];
	let x = u + p.cmyOffsets[channel];
	// NegPy `quadratic_core`: held at the vertex where the quadratic would fold back.
	if (curv !== 0) {
		const vertex = -k / (2 * curv);
		if ((curv > 0 && x < vertex) || (curv < 0 && x > vertex)) x = vertex;
	}
	let v = k * (x - p.pivots[channel]) + curv * x * x;
	v = throughMidtone(v);
	const w = sigmoid(REGIONAL_CMY_SHARPNESS * (v - REFERENCE_PRINT_DENSITY));
	v += p.shadowCmy[channel] * w + p.highlightCmy[channel] * (1 - w);
	const v1 = pro.dMinEff + softplus(pro.aHl * (v - pro.dMinEff)) / pro.aHl;
	return pro.dMaxEff - softplus(pro.aSh * (pro.dMaxEff - v1)) / pro.aSh;
}

/** Print density of one channel at normalized value `u`, before black point compensation. */
export function printDensity(u: number, channel: 0 | 1 | 2, p: PrintCurveParams): number {
	return densityWith(u, channel, p, prologue(p.toe, p.shoulder));
}

/** Print transmittance 10^−D of one channel after black point compensation, in [0, 1]. */
export function printTransmittance(u: number, channel: 0 | 1 | 2, p: PrintCurveParams): number {
	const pro = prologue(p.toe, p.shoulder);
	const t = Math.pow(10, -densityWith(u, channel, p, pro));
	return Math.min(Math.max((t - pro.bpcBlack) / (1 - pro.bpcBlack), 0), 1);
}

/** Channel whose curve a B&W print uses: the base (green) curve; solve makes all three equal. */
export const BW_CHANNEL = 1;

/**
 * One B&W density from the normalized channels, taken before the curve so channel differences
 * in the scan cannot tint the tone scale: NegPy's `collapse_matrix` row (`matmul_3x3` in
 * `PhotometricProcessor.process`) at `BW_FILTER_WEIGHTS[BwFilter.NONE]`. The weights sum to 1,
 * so a gray keeps its value. Print it with `printTransmittance(collapseBw(u), BW_CHANNEL, p)`.
 */
export function collapseBw(u: Vec3): number {
	const [wr, wg, wb] = BW_FILTER_WEIGHTS_NONE;
	return u[0] * wr + u[1] * wg + u[2] * wb;
}

/** Byte size of `HDCurveUniforms` in hd_curve.wgsl. */
const UNIFORM_BYTES = 224;
const FILM_TYPE_CODE: Record<FilmType, number> = { C41: 0, BW: 1, E6: 2 };

/**
 * The uniform block of hd_curve.wgsl, byte for byte (layout documented in the shader header).
 * Every value derivable on the CPU (S-curve centre, knees, BPC black) and every curve constant
 * is packed here, so the shader and `printDensity` / `transferDisplay` share one prologue. A
 * slide's regional split takes the transfer's geometry (`wbSplitGeometry`); `sceneLinear` tells
 * its transfer whether the source is a scene-linear RAW capture or display-referred.
 */
export function packPrintCurveUniforms(
	curve: PrintCurveParams,
	tone: ToneStageParams,
	filmType: FilmType,
	sceneLinear: boolean,
): ArrayBuffer {
	const buf = new ArrayBuffer(UNIFORM_BYTES);
	const f = new Float32Array(buf);
	const u = new Uint32Array(buf);
	const vec3s: Vec3[] = [
		curve.slopes,
		curve.pivots,
		curve.curvatures,
		curve.cmyOffsets,
		curve.shadowCmy,
		curve.highlightCmy,
	];
	vec3s.forEach((v, i) => f.set(v, i * 4));
	const pro = prologue(curve.toe, curve.shoulder);
	f[24] = V_STAR;
	f[25] = pro.dMinEff;
	f[26] = pro.dMaxEff;
	f[27] = pro.aHl;
	f[28] = pro.aSh;
	f[29] = pro.bpcBlack;
	u[30] = FILM_TYPE_CODE[filmType];
	f[31] = tone.exposure;
	f[32] = tone.contrast;
	f[33] = tone.shadows;
	f[34] = tone.highlights;
	f[35] = tone.vibrance;
	f[36] = tone.saturation;
	f[37] = tone.toneGamma;
	f[38] = tone.blackPoint;
	f[39] = tone.whitePoint;
	f[40] = tone.midtoneCurve;
	f[41] = PAPER_MIDTONE_GAMMA * PAPER_GAMMA_WIDTH;
	f[42] = PAPER_GAMMA_WIDTH;
	const [centre, sharpness] =
		filmType === 'E6' ? wbSplitGeometry() : [REFERENCE_PRINT_DENSITY, REGIONAL_CMY_SHARPNESS];
	f[43] = centre;
	f[44] = sharpness;
	f.set(BW_FILTER_WEIGHTS_NONE, 45);
	f[48] = TRANSFER_TOE_KNEE;
	f[49] = TRANSFER_SHOULDER_KNEE;
	f[50] = TRANSFER_KNEE_WIDTH;
	f[51] = curve.toe;
	f[52] = curve.shoulder;
	f[53] = TRANSFER_BASELINE_GAIN;
	u[54] = sceneLinear ? 0 : 1;
	f[55] = STANDARD_TONE_GAMMA;
	return buf;
}
