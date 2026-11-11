/**
 * Density window of a negative: per channel, the dense end (`floors`, scene
 * highlights) and the thin end (`ceils`, film base) the render normalizes by.
 *
 * Port of NegPy 0.68 `analyze_log_exposure_bounds_from_log`,
 * `_sample_log_bounds` and `_same_pixel_color_floor_refs`
 * (negpy/features/exposure/normalization.py; kernel negpy_core/src/bounds.rs)
 * at NegPy's default settings: luma slider 0, colour clip `BASE_COLOR_CLIP`.
 * The grid is already cropped and block-medianed, so NegPy's roi / buffer /
 * block-median steps are not repeated here.
 *
 * Mirrors src-tauri/src/negative/bounds.rs — change both together. Every
 * percentile is rounded to f32 as the Rust grid helpers return it, so band and
 * chroma selections pick the same cells in both.
 */

import {
	BASE_COLOR_CLIP,
	BASE_LUMA_CLIP,
	COLOR_BOUNDS_BAND_WIDTH,
	NEUTRAL_AXIS_CHROMA_CAP,
	NEUTRAL_AXIS_CHROMA_QUANTILE,
	NEUTRAL_AXIS_FIRST_PASS_CAP,
	NEUTRAL_AXIS_MIN_PIXELS,
} from './constants';
import { gridLuma, median, percentileOfSorted, percentiles, sortedChannel } from './grid';
import type { LogGrid } from './grid';
import type { LogBounds, Vec3 } from '$lib/types';

/** Guard on spans and gammas the kernel divides by. */
const EPSILON = 1e-6;

/**
 * `_sample_log_bounds` (`percentile_clip >= 0`, slider 0): per-channel floors
 * and ceils at the `base` clip per tail, clamped to [0.00001, 50].
 */
function sampleBounds(sorted: readonly Float32Array[], base: number): [Vec3, Vec3] {
	const clip = Math.max(0.00001, Math.min(50, base));
	const at = (c: number, q: number): number => Math.fround(percentileOfSorted(sorted[c], q));
	return [
		[at(0, clip), at(1, clip), at(2, clip)],
		[at(0, 100 - clip), at(1, 100 - clip), at(2, 100 - clip)],
	];
}

/** Python's `sorted(v)[1]`. */
function middleOf(v: Vec3): number {
	const [a, b, c] = v;
	return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

/** `rms_chroma` of one triplet. */
function rmsChroma(r: number, g: number, b: number): number {
	return Math.sqrt(((r - g) * (r - g) + (g - b) * (g - b) + (r - b) * (r - b)) / 3);
}

/**
 * `same_pixel_color_floor_refs`: the dense-end colour refs from one shared
 * pixel set — the luma-extreme band's lowest-chroma cells, chroma read as
 * offsets from the thin-end refs `base` scaled by each channel's span (pass 1),
 * then by the pass-1 medians (pass 2). Independent per-channel percentiles
 * would read a different scene object per channel and take coloured highlight
 * content for film cast. Null when the set is too small or too chromatic.
 */
function sameColorFloorRefs(
	grid: LogGrid,
	lumaFloors: Vec3,
	lumaCeils: Vec3,
	base: Vec3,
	colorClip: number,
): Vec3 | null {
	const { data } = grid;
	const luma = gridLuma(grid, { floors: lumaFloors, ceils: lumaCeils });
	const clip = Math.max(0.00001, Math.min(50 - COLOR_BOUNDS_BAND_WIDTH, colorClip));
	const [lo, hi] = percentiles(luma, [clip, clip + COLOR_BOUNDS_BAND_WIDTH]).map(Math.fround);

	let count = 0;
	for (let i = 0; i < luma.length; i++) if (luma[i] >= lo && luma[i] <= hi) count++;
	if (count < NEUTRAL_AXIS_MIN_PIXELS) return null;
	const d = new Float32Array(count * 3);
	for (let i = 0, k = 0; i < luma.length; i++) {
		if (luma[i] < lo || luma[i] > hi) continue;
		for (let c = 0; c < 3; c++) d[k++] = data[i * 3 + c] - base[c];
	}

	const chroma = new Float32Array(count);
	/** The band's lowest-chroma quantile, `gamma` as each channel's span: rows, median chroma. */
	const select = (gamma: Vec3): { rows: Int32Array; chroma: number } | null => {
		const g = gamma.map((v) => (Math.abs(v) < EPSILON ? EPSILON : v));
		for (let i = 0, p = 0; i < count; i++, p += 3) {
			chroma[i] = rmsChroma(d[p] / g[0], d[p + 1] / g[1], d[p + 2] / g[2]);
		}
		const thr = Math.fround(percentiles(chroma, [NEUTRAL_AXIS_CHROMA_QUANTILE * 100])[0]);
		let kept = 0;
		for (let i = 0; i < count; i++) if (chroma[i] <= thr) kept++;
		if (kept < NEUTRAL_AXIS_MIN_PIXELS) return null;
		const rows = new Int32Array(kept);
		const picked = new Float32Array(kept);
		for (let i = 0, k = 0; i < count; i++) {
			if (chroma[i] > thr) continue;
			rows[k] = i;
			picked[k++] = chroma[i];
		}
		return { rows, chroma: Math.fround(median(picked)) };
	};
	const columnMedians = (rows: Int32Array): Vec3 => {
		const col = new Float32Array(rows.length);
		const at = (c: number): number => {
			for (let k = 0; k < rows.length; k++) col[k] = d[rows[k] * 3 + c];
			return Math.fround(median(col));
		};
		return [at(0), at(1), at(2)];
	};

	const first = select([lumaFloors[0] - base[0], lumaFloors[1] - base[1], lumaFloors[2] - base[2]]);
	// A loose first cap: pass 2 would self-normalize a homogeneous coloured
	// cluster to zero chroma and read it as neutral.
	if (first === null || first.chroma > NEUTRAL_AXIS_FIRST_PASS_CAP) return null;
	const provisional = columnMedians(first.rows);
	if (provisional.some((v) => Math.abs(v) < EPSILON)) return null;
	const second = select(provisional);
	if (second === null || second.chroma > NEUTRAL_AXIS_CHROMA_CAP) return null;
	const m = columnMedians(second.rows);
	return [base[0] + m[0], base[1] + m[1], base[2] + m[2]];
}

/**
 * Per-channel density window of a negative, read from its prefiltered grid
 * (`analyze_log_exposure_bounds_from_log`). The colour pass sets each channel's
 * refs — thin end from per-channel percentiles, dense end from the shared
 * near-neutral highlight set when it exists — and the luma pass sets how far
 * past them the window reaches, as one shared fraction of each channel's span,
 * so a gray scale normalizes neutral. Empty grid → `{ floors: [-1, -1, -1],
 * ceils: [0, 0, 0] }`; a flat grid gives `floor == ceil`.
 */
export function analyzeLogBounds(grid: LogGrid): LogBounds {
	const n = grid.width * grid.height;
	if (n === 0 || grid.data.length !== n * 3) return { floors: [-1, -1, -1], ceils: [0, 0, 0] };
	const sorted = [sortedChannel(grid, 0), sortedChannel(grid, 1), sortedChannel(grid, 2)];

	// Luma pass at the luma base clip (slider 0); colour pass at the colour clip, base 0.
	const [floors, ceils] = sampleBounds(sorted, BASE_LUMA_CLIP);
	const [percentileFloors, cCeils] = sampleBounds(sorted, BASE_COLOR_CLIP);
	const cFloors =
		sameColorFloorRefs(grid, floors, ceils, cCeils, BASE_COLOR_CLIP) ?? percentileFloors;

	const spans: Vec3 = [cFloors[0] - cCeils[0], cFloors[1] - cCeils[1], cFloors[2] - cCeils[2]];
	const total = spans[0] + spans[1] + spans[2];
	if (spans.every((s) => s * total > 0)) {
		// The luma window reaches past the colour refs by one shared fraction of
		// each channel's own span (a reach in log units would tint a film whose
		// channels differ in density range); a ratio of sums, so a near-flat
		// channel cannot inflate it. The window sits off the luma mean by the
		// base's mean-minus-median channel offset, where the print constants are tuned.
		let reachF = 0;
		let reachC = 0;
		for (let c = 0; c < 3; c++) {
			reachF += floors[c] - cFloors[c];
			reachC += ceils[c] - cCeils[c];
		}
		reachF /= total;
		reachC /= total;
		const shift = (cCeils[0] + cCeils[1] + cCeils[2] - 3 * middleOf(cCeils)) / total;
		const at = (refs: Vec3, reach: number, c: number): number =>
			refs[c] + (reach + shift) * spans[c];
		return {
			floors: [at(cFloors, reachF, 0), at(cFloors, reachF, 1), at(cFloors, reachF, 2)],
			ceils: [at(cCeils, reachC, 0), at(cCeils, reachC, 1), at(cCeils, reachC, 2)],
		};
	}
	// Spans of mixed sign (or none): the colour refs' offsets from their median
	// channel, placed around the luma pass's mean.
	const meanF = (floors[0] + floors[1] + floors[2]) / 3;
	const meanC = (ceils[0] + ceils[1] + ceils[2]) / 3;
	const midF = middleOf(cFloors);
	const midC = middleOf(cCeils);
	return {
		floors: [meanF + cFloors[0] - midF, meanF + cFloors[1] - midF, meanF + cFloors[2] - midF],
		ceils: [meanC + cCeils[0] - midC, meanC + cCeils[1] - midC, meanC + cCeils[2] - midC],
	};
}
