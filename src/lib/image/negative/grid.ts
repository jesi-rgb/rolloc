/**
 * Analysis grid of the negative pipeline.
 *
 * Every meter (bounds, anchor, textural range, neutral axis) reads the same
 * prefiltered image: log10 density → centred analysis crop → block-median
 * grid of at most `ANALYSIS_GRID` cells on the long side. An isolated extreme
 * (dust, a specular) vanishes inside its block's median, and the grid size is
 * fixed, so a preview-size decode and the full-size export measure alike.
 *
 * Port of NegPy 0.68 `prefilter_log_grid` / `_block_median_grid`
 * (negpy/features/exposure/normalization.py) and `textured_cells`
 * (negpy_core/src/meter.rs). Mirrored in src-tauri/src/negative/grid.rs —
 * change both together.
 */

import {
	ACTIVITY_BLOCK,
	ACTIVITY_GATE_DENSITY,
	ACTIVITY_MIN_FRACTION,
	ANALYSIS_BUFFER,
	ANALYSIS_GRID,
	LUMA,
} from './constants';
import type { LogBounds } from '$lib/types';

/** Smallest linear value the log sees; also where NaN lands. */
const LOG_FLOOR = 1e-6;

/**
 * Log10-density image: `width × height` cells of interleaved RGB
 * (`data[(y * width + x) * 3 + channel]`), row-major. Values lie in [-6, 0].
 * An empty grid has `width === 0`.
 */
export interface LogGrid {
	data: Float32Array;
	width: number;
	height: number;
}

/** The pixel sources the preview hands to the analysis. */
export type LinearSource =
	/** Linear-light floats, interleaved RGB or RGBA. */
	| { kind: 'linear-f32'; pixels: Float32Array; channels: 3 | 4 }
	/** Linear 16-bit RGBA (the `raw_decode` payload). */
	| { kind: 'linear-u16'; pixels: Uint16Array }
	/** sRGB-encoded 8-bit RGBA; gamma-expanded here. */
	| { kind: 'srgb-u8'; pixels: Uint8Array | Uint8ClampedArray };

/** log10 of a linear value clamped to [1e-6, 1]; NaN reads as 1e-6. */
function logDensity(v: number): number {
	return Math.log10(v > LOG_FLOOR ? (v < 1 ? v : 1) : LOG_FLOOR);
}

let srgb8LogLut: Float32Array | null = null;
let u16LogLut: Float32Array | null = null;

/** log10 density of each 8-bit sRGB code, through the exact IEC 61966-2-1 EOTF. */
function getSrgb8LogLut(): Float32Array {
	if (srgb8LogLut === null) {
		const lut = new Float32Array(256);
		for (let i = 0; i < 256; i++) {
			const c = i / 255;
			lut[i] = logDensity(c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
		}
		srgb8LogLut = lut;
	}
	return srgb8LogLut;
}

/** log10 density of each linear 16-bit code. */
function getU16LogLut(): Float32Array {
	if (u16LogLut === null) {
		const lut = new Float32Array(65536);
		for (let i = 0; i < 65536; i++) lut[i] = logDensity(i / 65535);
		u16LogLut = lut;
	}
	return u16LogLut;
}

const EMPTY_GRID: LogGrid = { data: new Float32Array(0), width: 0, height: 0 };

/** Log density of the centre crop that excludes `buffer` of each edge. */
function croppedLog(src: LinearSource, width: number, height: number, buffer: number): LogGrid {
	const safe = Math.min(Math.max(buffer, 0), 0.3);
	const cutY = Math.floor(height * safe);
	const cutX = Math.floor(width * safe);
	const cw = width - 2 * cutX;
	const ch = height - 2 * cutY;
	const stride = src.kind === 'linear-f32' ? src.channels : 4;
	if (cw <= 0 || ch <= 0 || src.pixels.length < width * height * stride) return EMPTY_GRID;

	const out = new Float32Array(cw * ch * 3);
	let o = 0;
	if (src.kind === 'linear-f32') {
		const p = src.pixels;
		for (let y = cutY; y < cutY + ch; y++) {
			let i = (y * width + cutX) * stride;
			for (let x = 0; x < cw; x++, i += stride) {
				out[o++] = logDensity(p[i]);
				out[o++] = logDensity(p[i + 1]);
				out[o++] = logDensity(p[i + 2]);
			}
		}
	} else {
		const p = src.pixels;
		const lut = src.kind === 'linear-u16' ? getU16LogLut() : getSrgb8LogLut();
		for (let y = cutY; y < cutY + ch; y++) {
			let i = (y * width + cutX) * 4;
			for (let x = 0; x < cw; x++, i += 4) {
				out[o++] = lut[p[i]];
				out[o++] = lut[p[i + 1]];
				out[o++] = lut[p[i + 2]];
			}
		}
	}
	return { data: out, width: cw, height: ch };
}

/**
 * Per-channel median of each `b × b` block, `b = ceil(long side / ANALYSIS_GRID)`.
 * Images already at or under the grid size pass through untouched.
 */
function blockMedianGrid(img: LogGrid): LogGrid {
	const { data, width: w, height: h } = img;
	const b = Math.ceil(Math.max(w, h) / ANALYSIS_GRID);
	if (b <= 1 || h < b || w < b) return img;

	const gw = Math.floor(w / b);
	const gh = Math.floor(h / b);
	const out = new Float32Array(gw * gh * 3);
	const n = b * b;
	const block = new Float32Array(n);
	const mid = n >> 1;
	const even = (n & 1) === 0;

	for (let gy = 0; gy < gh; gy++) {
		for (let gx = 0; gx < gw; gx++) {
			for (let c = 0; c < 3; c++) {
				let k = 0;
				for (let yy = 0; yy < b; yy++) {
					let i = ((gy * b + yy) * w + gx * b) * 3 + c;
					for (let xx = 0; xx < b; xx++, i += 3) block[k++] = data[i];
				}
				block.sort();
				out[(gy * gw + gx) * 3 + c] = even ? (block[mid - 1] + block[mid]) * 0.5 : block[mid];
			}
		}
	}
	return { data: out, width: gw, height: gh };
}

/**
 * The grid every meter reads: log10 density of `src`, cropped by
 * `analysisBuffer` on each edge, block-medianed to at most `ANALYSIS_GRID`
 * cells on the long side. Empty when the source is degenerate.
 */
export function prefilterLogGrid(
	src: LinearSource,
	width: number,
	height: number,
	analysisBuffer: number = ANALYSIS_BUFFER,
): LogGrid {
	return blockMedianGrid(croppedLog(src, width, height, analysisBuffer));
}

/**
 * Luma of each grid cell, `LUMA`-weighted. With `norm`, each channel is first
 * normalized as the render does: `(value − floor) / (ceil − floor)`, unclamped.
 */
export function gridLuma(grid: LogGrid, norm?: LogBounds): Float32Array {
	const { data } = grid;
	const n = grid.width * grid.height;
	const out = new Float32Array(n);
	if (norm === undefined) {
		for (let i = 0, p = 0; i < n; i++, p += 3) {
			out[i] = LUMA[0] * data[p] + LUMA[1] * data[p + 1] + LUMA[2] * data[p + 2];
		}
		return out;
	}
	const f = norm.floors;
	const span: [number, number, number] = [0, 0, 0];
	for (let c = 0; c < 3; c++) {
		const d = norm.ceils[c] - f[c];
		span[c] = Math.abs(d) < 1e-6 ? (d >= 0 ? 1e-6 : -1e-6) : d;
	}
	for (let i = 0, p = 0; i < n; i++, p += 3) {
		out[i] =
			LUMA[0] * ((data[p] - f[0]) / span[0]) +
			LUMA[1] * ((data[p + 1] - f[1]) / span[1]) +
			LUMA[2] * ((data[p + 2] - f[2]) / span[2]);
	}
	return out;
}

/**
 * The cells of a `width × height` luma plane that carry texture, in row order.
 *
 * The plane is tiled into sectors of 2×2 blocks of `ACTIVITY_BLOCK` cells; a
 * sector votes when its four block means span more than
 * `ACTIVITY_GATE_DENSITY` (Boyack & Juenger, US 5,724,456), so rebate, sky and
 * flat walls drop out. When fewer than `ACTIVITY_MIN_FRACTION` of the sectors
 * vote — or the plane is smaller than one sector — every cell is returned.
 *
 * The gate compares luma differences, so it is meaningful only on a plane
 * whose unit is log10 density: pass `gridLuma(grid)` (raw log), or a
 * normalized plane when the caller wants the gate in normalized units.
 */
export function texturedCells(luma: Float32Array, width: number, height: number): Float32Array {
	const b = ACTIVITY_BLOCK;
	const hs = Math.floor(height / (2 * b)) * 2 * b;
	const ws = Math.floor(width / (2 * b)) * 2 * b;
	if (hs === 0 || ws === 0) return luma;

	const bh = hs / b;
	const bw = ws / b;
	const means = new Float32Array(bh * bw);
	for (let by = 0; by < bh; by++) {
		for (let bx = 0; bx < bw; bx++) {
			let sum = 0;
			for (let y = by * b; y < (by + 1) * b; y++) {
				const row = y * width + bx * b;
				for (let x = 0; x < b; x++) sum += luma[row + x];
			}
			means[by * bw + bx] = sum / (b * b);
		}
	}

	const sh = bh / 2;
	const sw = bw / 2;
	const active = new Uint8Array(sh * sw);
	let voting = 0;
	for (let sy = 0; sy < sh; sy++) {
		for (let sx = 0; sx < sw; sx++) {
			const i = 2 * sy * bw + 2 * sx;
			const a = means[i];
			const c = means[i + 1];
			const d = means[i + bw];
			const e = means[i + bw + 1];
			const lo = Math.min(a, c, d, e);
			const hi = Math.max(a, c, d, e);
			if (hi - lo > ACTIVITY_GATE_DENSITY) {
				active[sy * sw + sx] = 1;
				voting++;
			}
		}
	}
	if (voting / active.length < ACTIVITY_MIN_FRACTION) return luma;

	const out = new Float32Array(voting * 4 * b * b);
	let o = 0;
	for (let y = 0; y < hs; y++) {
		const sy = Math.floor(y / (2 * b));
		for (let x = 0; x < ws; x++) {
			if (active[sy * sw + Math.floor(x / (2 * b))] === 1) out[o++] = luma[y * width + x];
		}
	}
	return out;
}

/** One channel of the grid, sorted ascending. */
export function sortedChannel(grid: LogGrid, channel: 0 | 1 | 2): Float32Array {
	const n = grid.width * grid.height;
	const out = new Float32Array(n);
	for (let i = 0, p = channel; i < n; i++, p += 3) out[i] = grid.data[p];
	return out.sort();
}

/**
 * Percentile `q` (0–100) of ascending `sorted`, linearly interpolated between
 * the two nearest ranks (NumPy's default method). NaN when `sorted` is empty.
 */
export function percentileOfSorted(sorted: ArrayLike<number>, q: number): number {
	const n = sorted.length;
	if (n === 0) return NaN;
	const rank = ((n - 1) * Math.min(Math.max(q, 0), 100)) / 100;
	const lo = Math.floor(rank);
	const hi = Math.min(lo + 1, n - 1);
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/** Percentiles `qs` (each 0–100) of unsorted `values`; one sort for all of them. */
export function percentiles(values: ArrayLike<number>, qs: readonly number[]): number[] {
	const sorted = Float32Array.from(values).sort();
	return qs.map((q) => percentileOfSorted(sorted, q));
}

/** Percentile `q` (0–100) of unsorted `values`. NaN when empty. */
export function percentile(values: ArrayLike<number>, q: number): number {
	return percentiles(values, [q])[0];
}

/** Median of unsorted `values`. NaN when empty. */
export function median(values: ArrayLike<number>): number {
	return percentile(values, 50);
}
