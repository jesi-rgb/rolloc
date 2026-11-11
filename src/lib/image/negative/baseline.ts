/**
 * Roll baseline: one set of bounds pooled across a roll's frames, and how a
 * frame's own bounds are resolved against it.
 *
 * The orange mask and the film base are properties of the roll, not of the
 * frame; normalizing every frame against pooled bounds removes the
 * frame-to-frame colour drift that per-frame bounds pick up from content.
 *
 * Port of NegPy 0.68 `pool_frame_bounds`, `mix_luma_color_bounds`,
 * `resolve_bounds_detailed` and `luma_source_bounds`
 * (negpy/features/exposure/normalization.py). The mix / resolve / luma-source
 * functions are mirrored in src-tauri/src/negative/baseline.rs — change both
 * together. Pooling runs only in the app.
 */

import { LUMA, POOL_OUTLIER_DISTANCE } from './constants';
import type { AppliedBaseline, LogBounds, Vec3 } from '$lib/types';

/** One frame's own bounds, as measured by the analysis. */
export interface FrameBounds {
	id: string;
	floors: Vec3;
	ceils: Vec3;
}

/** Median of a non-empty list, in double precision (NumPy `median`). */
function medianF64(values: readonly number[]): number {
	const sorted = values.slice().sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function lumaOf(v: Vec3): number {
	return LUMA[0] * v[0] + LUMA[1] * v[1] + LUMA[2] * v[2];
}

/**
 * Pools per-frame bounds into one roll baseline (NegPy `pool_frame_bounds`).
 *
 * Each frame's colour is its luma-free offset, a 6-vector over both bounds.
 * With three frames or more, a frame whose colour lies further than
 * `POOL_OUTLIER_DISTANCE` from the per-component median is an outlier — shot
 * under a different light or scanned with another balance — and stays on its
 * own bounds. A colour offset also moves luma through G, so only the inliers
 * pool: luma is the median of their luma-weighted floor and ceil, colour the
 * mean of their offsets. When every frame is an outlier, all of them pool.
 *
 * No frames → `{ floors: [-1, -1, -1], ceils: [0, 0, 0] }` (the empty-grid
 * bounds) and no outliers; callers refuse to build a baseline from zero frames.
 */
export function poolFrameBounds(frames: readonly FrameBounds[]): {
	bounds: LogBounds;
	outlierIds: string[];
} {
	const n = frames.length;
	if (n === 0) return { bounds: { floors: [-1, -1, -1], ceils: [0, 0, 0] }, outlierIds: [] };

	const lumaF = frames.map((f) => lumaOf(f.floors));
	const lumaC = frames.map((f) => lumaOf(f.ceils));
	const chroma = frames.map((f, i) => [
		f.floors[0] - lumaF[i],
		f.floors[1] - lumaF[i],
		f.floors[2] - lumaF[i],
		f.ceils[0] - lumaC[i],
		f.ceils[1] - lumaC[i],
		f.ceils[2] - lumaC[i],
	]);

	const outlier = new Array<boolean>(n).fill(false);
	if (n >= 3) {
		const centre = [0, 1, 2, 3, 4, 5].map((k) => medianF64(chroma.map((c) => c[k])));
		for (let i = 0; i < n; i++) {
			let sq = 0;
			for (let k = 0; k < 6; k++) sq += (chroma[i][k] - centre[k]) ** 2;
			outlier[i] = Math.sqrt(sq) > POOL_OUTLIER_DISTANCE;
		}
	}
	const anyInlier = outlier.some((o) => !o);
	const pool: number[] = [];
	for (let i = 0; i < n; i++) if (!anyInlier || !outlier[i]) pool.push(i);

	const meanChroma = [0, 0, 0, 0, 0, 0];
	for (const i of pool) for (let k = 0; k < 6; k++) meanChroma[k] += chroma[i][k];
	for (let k = 0; k < 6; k++) meanChroma[k] /= pool.length;

	const lf = medianF64(pool.map((i) => lumaF[i]));
	const lc = medianF64(pool.map((i) => lumaC[i]));
	return {
		bounds: {
			floors: [lf + meanChroma[0], lf + meanChroma[1], lf + meanChroma[2]],
			ceils: [lc + meanChroma[3], lc + meanChroma[4], lc + meanChroma[5]],
		},
		outlierIds: frames.filter((_, i) => outlier[i]).map((f) => f.id),
	};
}

function sameBounds(a: LogBounds, b: LogBounds): boolean {
	for (let c = 0; c < 3; c++) {
		if (a.floors[c] !== b.floors[c] || a.ceils[c] !== b.ceils[c]) return false;
	}
	return true;
}

/**
 * Luma-weighted centre and range from `lumaSrc`, per-channel shape from
 * `colorSrc` (NegPy `mix_luma_color_bounds`). The colour source is shifted —
 * floors and ceils by separate amounts — so the result's luma centre and
 * range, which drive brightness and slope, are the luma source's: taking the
 * roll's colour never changes a frame's contrast or brightness. Identity
 * when both sources are the same bounds, so a self-mix cannot stack.
 */
export function mixLumaColorBounds(lumaSrc: LogBounds, colorSrc: LogBounds): LogBounds {
	if (sameBounds(lumaSrc, colorSrc)) return lumaSrc;
	const centre = (b: LogBounds): number =>
		LUMA[0] * ((b.floors[0] + b.ceils[0]) / 2) +
		LUMA[1] * ((b.floors[1] + b.ceils[1]) / 2) +
		LUMA[2] * ((b.floors[2] + b.ceils[2]) / 2);
	const range = (b: LogBounds): number =>
		LUMA[0] * (b.ceils[0] - b.floors[0]) +
		LUMA[1] * (b.ceils[1] - b.floors[1]) +
		LUMA[2] * (b.ceils[2] - b.floors[2]);
	const dC = centre(lumaSrc) - centre(colorSrc);
	const dR = range(lumaSrc) - range(colorSrc);
	const df = dC - dR / 2;
	const dc = dC + dR / 2;
	const cf = colorSrc.floors;
	const cc = colorSrc.ceils;
	return {
		floors: [cf[0] + df, cf[1] + df, cf[2] + df],
		ceils: [cc[0] + dc, cc[1] + dc, cc[2] + dc],
	};
}

/**
 * The bounds a frame renders with (NegPy `resolve_bounds_detailed`): tonal
 * range from the baseline when `useLuma`, colour from it when `useColor`,
 * each otherwise from the frame's own `base`. No baseline → `base`.
 */
export function resolveBounds(base: LogBounds, baseline: AppliedBaseline | null): LogBounds {
	if (baseline === null) return base;
	const roll: LogBounds = { floors: baseline.floors, ceils: baseline.ceils };
	if (baseline.useLuma && baseline.useColor) return roll;
	return mixLumaColorBounds(baseline.useLuma ? roll : base, baseline.useColor ? roll : base);
}

/**
 * The bounds the anchor is metered against (NegPy `luma_source_bounds`): the
 * baseline when `useLuma`, else the frame's own `base`. The anchor is a
 * luma-weighted percentile that reacts non-linearly to the per-channel cast,
 * so metering it here rather than on the mix keeps brightness independent of
 * the colour toggle.
 */
export function lumaSourceBounds(base: LogBounds, baseline: AppliedBaseline | null): LogBounds {
	if (baseline === null || !baseline.useLuma) return base;
	return { floors: baseline.floors, ceils: baseline.ceils };
}
