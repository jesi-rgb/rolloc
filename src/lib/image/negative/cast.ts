/**
 * Cast Removal: automatic gray balance of a colour negative.
 *
 * `measureNeutralAxis` finds the frame's near-neutral cells in a highlight,
 * midtone and shadow luma band and reads their raw log densities;
 * `castCurveParams` bends the red and blue print curves so those references
 * print like green's. Port of NegPy 0.68 `measure_neutral_axis_from_log`
 * (negpy/features/exposure/normalization.py), its kernel `neutral_axis`
 * (negpy_core/src/meter.rs), and the Cast Removal branch of
 * `per_channel_curve_params` (negpy/features/exposure/logic.py).
 *
 * The axis is measured in float32, as the kernel is: every per-cell value is
 * rounded with `Math.fround` so set membership, and therefore the references,
 * match src-tauri/src/negative/cast.rs exactly. Change both together.
 */

import {
	LUMA,
	MIDTONE_CAST_MAX_OFFSET,
	NEUTRAL_AXIS_AGREEMENT_DEADZONE,
	NEUTRAL_AXIS_AGREEMENT_SCALE,
	NEUTRAL_AXIS_CHROMA_CAP,
	NEUTRAL_AXIS_CHROMA_QUANTILE,
	NEUTRAL_AXIS_CONFIDENCE_N0,
	NEUTRAL_AXIS_CURV_MAX_RATIO,
	NEUTRAL_AXIS_FIRST_PASS_CAP,
	NEUTRAL_AXIS_FOLIAGE_CHROMA,
	NEUTRAL_AXIS_FOLIAGE_HUE,
	NEUTRAL_AXIS_HIGHLIGHT_BAND,
	NEUTRAL_AXIS_MID_BAND,
	NEUTRAL_AXIS_MIN_PIXELS,
	NEUTRAL_AXIS_SHADOW_BAND,
	NEUTRAL_AXIS_SKY_CHROMA,
	NEUTRAL_AXIS_SKY_HUE,
	NEUTRAL_AXIS_WIDTH_DEADZONE,
	NEUTRAL_AXIS_WIDTH_SCALE,
	SLOPE_MAX,
	SLOPE_MIN,
} from './constants';
import { median, percentiles } from './grid';
import type { LogGrid } from './grid';
import { computePivot } from './print-curve';
import type { LogBounds, NeutralAxis, Vec3 } from '$lib/types';

/** Per-channel straight-line core of the print curve: `v = k·(u − pivot) + curv·u²`. */
export interface CastCurve {
	slopes: Vec3;
	pivots: Vec3;
	curvatures: Vec3;
}

const f32 = Math.fround;

/** Float32 constants, as the Rust mirror holds them. */
const LUMA32: Vec3 = [f32(LUMA[0]), f32(LUMA[1]), f32(LUMA[2])];
const RAD_TO_DEG32 = f32(180 / Math.PI);
/** The chroma quantile as a float32 percentile, the rank the Rust mirror reads. */
const QUANTILE_PCT = f32(f32(NEUTRAL_AXIS_CHROMA_QUANTILE) * 100);
/** Foliage and sky sectors: (chroma floor, hue low, hue high) in degrees. */
const SUBJECTS: readonly [number, number, number][] = [
	[
		f32(NEUTRAL_AXIS_FOLIAGE_CHROMA),
		f32(NEUTRAL_AXIS_FOLIAGE_HUE[0]),
		f32(NEUTRAL_AXIS_FOLIAGE_HUE[1]),
	],
	[f32(NEUTRAL_AXIS_SKY_CHROMA), f32(NEUTRAL_AXIS_SKY_HUE[0]), f32(NEUTRAL_AXIS_SKY_HUE[1])],
];

/** The near-neutral set of one luma band. */
interface BandRefs {
	/** Raw log10 density per channel. */
	refs: Vec3;
	/** Median chroma of the set. */
	chroma: number;
	size: number;
	/** Widest P10–P90 spread of R − G or B − G across the set. */
	width: number;
}

/** `_rms_chroma` of one normalized triplet, in float32. */
function rmsChroma(r: number, g: number, b: number): number {
	const rg = f32(r - g);
	const gb = f32(g - b);
	const rb = f32(r - b);
	const sum = f32(f32(f32(rg * rg) + f32(gb * gb)) + f32(rb * rb));
	return f32(Math.sqrt(f32(sum / 3)));
}

/** `_subject_cells` for one normalized triplet: foliage or sky by hue and chroma. */
function isSubject(r: number, g: number, b: number): boolean {
	const dr = f32(r - g);
	const db = f32(b - g);
	const t = f32(f32(dr + db) / 2);
	const s = f32(f32(dr - db) / 2);
	const chroma = f32(Math.sqrt(t * t + s * s));
	if (!SUBJECTS.some(([c]) => chroma > c)) return false;
	const hue = f32(f32(Math.atan2(-s, t)) * RAD_TO_DEG32);
	return SUBJECTS.some(([c, lo, hi]) => chroma > c && hue > lo && hue < hi);
}

/** Span of each channel's normalization; under 1e-6 it divides by ±1e-6, by its sign. */
function spans(bounds: LogBounds): Vec3 {
	const out: Vec3 = [0, 0, 0];
	for (let c = 0; c < 3; c++) {
		const d = bounds.ceils[c] - bounds.floors[c];
		out[c] = Math.abs(d) < 1e-6 ? (d >= 0 ? 1e-6 : -1e-6) : d;
	}
	return out;
}

/** `normalize_refs`: raw log references at their normalized position, unclamped. */
function normalizeRefs(refs: Vec3, bounds: LogBounds): Vec3 {
	const span = spans(bounds);
	return [
		(refs[0] - bounds.floors[0]) / span[0],
		(refs[1] - bounds.floors[1]) / span[1],
		(refs[2] - bounds.floors[2]) / span[2],
	];
}

/**
 * Per-channel neutral axis of a frame: median raw-log density of the
 * lowest-chroma cells of a highlight, midtone and shadow luma band
 * (`measure_neutral_axis_from_log` with `exclude_subjects`). Foliage and sky
 * cells are dropped first. Pass 1 reads the sets under a loose chroma cap so
 * a strong but correctable cast keeps them; its midtone + shadow correction
 * re-ranks chroma for the strict pass 2. Confidence falls with a small set,
 * a set that is not gray after correction, a midtone/shadow disagreement and
 * a wide spread of offsets. `null` without a midtone or shadow set.
 */
export function measureNeutralAxis(grid: LogGrid, bounds: LogBounds): NeutralAxis | null {
	const cells = grid.width * grid.height;
	if (cells === 0 || grid.data.length < cells * 3) return null;

	// `normalize_log_image` on float32 bounds.
	const floors32: Vec3 = [f32(bounds.floors[0]), f32(bounds.floors[1]), f32(bounds.floors[2])];
	const ceils32: Vec3 = [f32(bounds.ceils[0]), f32(bounds.ceils[1]), f32(bounds.ceils[2])];
	const bounds32: LogBounds = { floors: floors32, ceils: ceils32 };
	const span32 = spans(bounds32).map(f32);

	const keepNorm = new Float32Array(cells * 3);
	const keepLog = new Float32Array(cells * 3);
	let n = 0;
	for (let i = 0, p = 0; i < cells; i++, p += 3) {
		const r = f32(f32(grid.data[p] - floors32[0]) / span32[0]);
		const g = f32(f32(grid.data[p + 1] - floors32[1]) / span32[1]);
		const b = f32(f32(grid.data[p + 2] - floors32[2]) / span32[2]);
		if (isSubject(r, g, b)) continue;
		const q = n * 3;
		keepNorm[q] = r;
		keepNorm[q + 1] = g;
		keepNorm[q + 2] = b;
		keepLog[q] = grid.data[p];
		keepLog[q + 1] = grid.data[p + 1];
		keepLog[q + 2] = grid.data[p + 2];
		n++;
	}
	const norm = keepNorm.subarray(0, n * 3);
	const log = keepLog.subarray(0, n * 3);
	const lum = new Float32Array(n);
	for (let i = 0, p = 0; i < n; i++, p += 3) {
		const rg = f32(f32(LUMA32[0] * norm[p]) + f32(LUMA32[1] * norm[p + 1]));
		lum[i] = f32(rg + f32(LUMA32[2] * norm[p + 2]));
	}

	const bandRefs = (
		band: [number, number],
		chroma: Float32Array,
		cap: number,
	): BandRefs | null => {
		const lo = f32(band[0]);
		const hi = f32(band[1]);
		const inBand: number[] = [];
		for (let i = 0; i < n; i++) if (lum[i] >= lo && lum[i] <= hi) inBand.push(i);
		if (inBand.length < NEUTRAL_AXIS_MIN_PIXELS) return null;
		const bandChroma = Float32Array.from(inBand, (i) => chroma[i]);
		const thr = f32(percentiles(bandChroma, [QUANTILE_PCT])[0]);
		const idx = inBand.filter((i) => chroma[i] <= thr);
		const nearNeutral = idx.length === 0 ? cap : f32(median(idx.map((i) => chroma[i])));
		if (idx.length < NEUTRAL_AXIS_MIN_PIXELS || nearNeutral > cap) return null;

		const medianOf = (f: (i: number) => number): number => f32(median(idx.map(f)));
		const green = medianOf((i) => log[i * 3 + 1]);
		const refs: Vec3 = [
			green + medianOf((i) => f32(log[i * 3] - log[i * 3 + 1])),
			green,
			green + medianOf((i) => f32(log[i * 3 + 2] - log[i * 3 + 1])),
		];
		const widthOf = (ch: number): number => {
			const off = Float32Array.from(idx, (i) => norm[i * 3 + ch] - norm[i * 3 + 1]);
			const [p10, p90] = percentiles(off, [10, 90]);
			return f32(p90) - f32(p10);
		};
		const width = Math.max(widthOf(0), widthOf(2));
		return { refs, chroma: nearNeutral, size: idx.length, width };
	};

	// Pass 1: loose cap on the raw chroma.
	const chroma1 = new Float32Array(n);
	for (let i = 0, p = 0; i < n; i++, p += 3) {
		chroma1[i] = rmsChroma(norm[p], norm[p + 1], norm[p + 2]);
	}
	const mid1 = bandRefs(NEUTRAL_AXIS_MID_BAND, chroma1, NEUTRAL_AXIS_FIRST_PASS_CAP);
	if (mid1 === null) return null;
	const sh1 = bandRefs(NEUTRAL_AXIS_SHADOW_BAND, chroma1, NEUTRAL_AXIS_FIRST_PASS_CAP);
	if (sh1 === null) return null;

	// The line through pass 1's midtone and shadow that maps R and B onto green.
	const nm = normalizeRefs(mid1.refs, bounds32);
	const ns = normalizeRefs(sh1.refs, bounds32);
	const gain: [number, number][] = [
		[1, 0],
		[1, 0],
		[1, 0],
	];
	for (const ch of [0, 2]) {
		const du = nm[ch] - ns[ch];
		if (Math.abs(du) < 1e-6) {
			gain[ch] = [1, f32(nm[1] - nm[ch])];
		} else {
			const a = (nm[1] - ns[1]) / du;
			gain[ch] = [f32(a), f32(nm[1] - a * nm[ch])];
		}
	}

	// Pass 2: strict cap on the chroma left after that correction.
	const chroma2 = new Float32Array(n);
	for (let i = 0, p = 0; i < n; i++, p += 3) {
		chroma2[i] = rmsChroma(
			f32(f32(gain[0][0] * norm[p]) + gain[0][1]),
			norm[p + 1],
			f32(f32(gain[2][0] * norm[p + 2]) + gain[2][1]),
		);
	}
	const cap = NEUTRAL_AXIS_CHROMA_CAP;
	const mid = bandRefs(NEUTRAL_AXIS_MID_BAND, chroma2, cap);
	if (mid === null) return null;
	const shadow = bandRefs(NEUTRAL_AXIS_SHADOW_BAND, chroma2, cap);
	if (shadow === null) return null;
	const highlight = bandRefs(NEUTRAL_AXIS_HIGHLIGHT_BAND, chroma2, cap);

	const tight = Math.min(Math.max(1 - Math.max(mid.chroma, shadow.chroma) / cap, 0), 1);
	const sizeTerm = mid.size / (mid.size + NEUTRAL_AXIS_CONFIDENCE_N0);
	const dm = normalizeRefs(mid.refs, bounds32);
	const ds = normalizeRefs(shadow.refs, bounds32);
	const spread = Math.max(
		Math.abs(dm[0] - dm[1] - (ds[0] - ds[1])),
		Math.abs(dm[2] - dm[1] - (ds[2] - ds[1])),
	);
	const agreeExcess = Math.max(spread - NEUTRAL_AXIS_AGREEMENT_DEADZONE, 0);
	const agree = 1 - Math.min(agreeExcess / NEUTRAL_AXIS_AGREEMENT_SCALE, 1);
	const width = Math.max(mid.width, shadow.width);
	const widthExcess = Math.max(width - NEUTRAL_AXIS_WIDTH_DEADZONE, 0);
	const single = 1 - Math.min(widthExcess / NEUTRAL_AXIS_WIDTH_SCALE, 1);
	const confidence = clamp(tight * sizeTerm * agree * single, 0, 1);

	const axis: NeutralAxis = {
		mid: mid.refs,
		shadow: shadow.refs,
		highlight: highlight?.refs ?? null,
		confidence,
	};
	const values = [...axis.mid, ...axis.shadow, ...(axis.highlight ?? []), confidence];
	return values.every(Number.isFinite) ? axis : null;
}

/**
 * Leading coefficient of the parabola through three points (the third
 * divided difference); 0 when two abscissae coincide, where NegPy's
 * `np.linalg.solve` raises and falls back to 0, or when it overflows.
 */
function parabolaCurvature(x: Vec3, y: Vec3): number {
	const d01 = x[0] - x[1];
	const d12 = x[1] - x[2];
	const d02 = x[0] - x[2];
	if (d01 === 0 || d12 === 0 || d02 === 0) return 0;
	const curv = ((y[0] - y[1]) / d01 - (y[1] - y[2]) / d12) / d02;
	return Number.isFinite(curv) ? curv : 0;
}

function clamp(v: number, lo: number, hi: number): number {
	return Math.min(Math.max(v, lo), hi);
}

/**
 * Per-channel print-curve core that removes the frame's cast: green keeps
 * the shared straight line, R and B get a line through the green-matched
 * midtone and shadow references, bent by a highlight-driven curvature when a
 * highlight reference exists (`per_channel_curve_params`, Cast Removal branch,
 * no paper channel gammas or grade trims). The applied strength is
 * `axis.confidence × strength` (`effective_cast_strength`).
 *
 * `null` → no correction: the caller uses one shared straight line for all
 * channels. `strength` is the slider (0–1).
 */
export function castCurveParams(
	baseSlope: number,
	anchor: number | null,
	strength: number,
	axis: NeutralAxis | null,
	bounds: LogBounds,
): CastCurve | null {
	if (axis === null) return null;
	const effective = axis.confidence * strength;
	if (!(effective > 0)) return null;

	const midNorm = normalizeRefs(axis.mid, bounds);
	const shNorm = normalizeRefs(axis.shadow, bounds);
	const hlNorm = axis.highlight === null ? null : normalizeRefs(axis.highlight, bounds);

	const eps = 1e-6;
	const limit = MIDTONE_CAST_MAX_OFFSET;
	const slopeG = clamp(baseSlope, SLOPE_MIN, SLOPE_MAX);
	const pivotG = computePivot(slopeG, anchor);
	const curvLim = NEUTRAL_AXIS_CURV_MAX_RATIO * slopeG;
	/** Green's core at a green reference. */
	const target = (g: number): number => slopeG * (g - pivotG);
	const mG = midNorm[1];
	const sG = shNorm[1];
	const tM = target(mG);
	const tS = target(sG);
	/** A channel's reference pulled toward green's by the strength, at most `limit` away. */
	const clampDev = (g: number, v: number): number =>
		g + clamp(effective * (v - g), -limit, limit);

	const slopes: Vec3 = [slopeG, slopeG, slopeG];
	const pivots: Vec3 = [pivotG, pivotG, pivotG];
	const curvatures: Vec3 = [0, 0, 0];
	for (const ch of [0, 2] as const) {
		const uM = clampDev(mG, midNorm[ch]);
		const uS = clampDev(sG, shNorm[ch]);

		let curv = 0;
		if (hlNorm !== null) {
			const hG = hlNorm[1];
			const uH = clampDev(hG, hlNorm[ch]);
			curv = clamp(parabolaCurvature([uH, uM, uS], [target(hG), tM, tS]), -curvLim, curvLim);
		}

		// Re-pin midtone and shadow with this curvature; the midtone is exact through the pivot.
		const du = uM - uS;
		const slope = clamp(
			Math.abs(du) < eps ? slopeG : (tM - tS - curv * (uM * uM - uS * uS)) / du,
			SLOPE_MIN,
			SLOPE_MAX,
		);
		slopes[ch] = slope;
		pivots[ch] = Math.abs(slope) > eps ? uM - (tM - curv * uM * uM) / slope : pivotG;
		curvatures[ch] = curv;
	}

	const values = [...slopes, ...pivots, ...curvatures];
	return values.every(Number.isFinite) ? { slopes, pivots, curvatures } : null;
}
