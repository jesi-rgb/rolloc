/**
 * Negative analysis: everything measured from a frame's pixels that the print
 * curve is solved from. One prefiltered grid feeds every meter, so the bounds,
 * the anchor, the textural range and the neutral axis all read the same film.
 * A slide is not metered: it carries the transfer's fixed window and the neutral
 * meters, and only its histograms read the pixels.
 *
 * Mirrors NegPy 0.68 `NormalizationProcessor.process`
 * (negpy/features/exposure/processor.py) and, for slides, the fixed bounds of
 * `TransparencyBaseProcessor` (negpy/features/transparency/processor.py). Mirrored
 * by `negative::analyze` in src-tauri/src/negative/mod.rs — change both together.
 */

import { ANALYSIS_VERSION } from '$lib/types';
import { lumaSourceBounds, resolveBounds } from './baseline';
import { analyzeLogBounds } from './bounds';
import { measureNeutralAxis } from './cast';
import { AUTO_GRADE_NOMINAL_RANGE, LUMA } from './constants';
import { measureTexturalRange } from './grade';
import { prefilterLogGrid } from './grid';
import { measureAnchor } from './meter';
import { transferAssumedAnchor, transferBounds } from './transfer';
import type {
	AppliedBaseline,
	FilmType,
	LogBounds,
	Matrix3x3,
	NegativeAnalysis,
} from '$lib/types';
import type { LinearSource, LogGrid } from './grid';

/** Bins per histogram. */
const HIST_BINS = 256;

/**
 * Per-channel histograms of the normalized negative, for the curves editor.
 * Each array holds `HIST_BINS` log-scaled bin heights in [0, 1] (1 = the
 * tallest bin of that channel).
 */
export interface ChannelHistograms {
	r: Float32Array;
	g: Float32Array;
	b: Float32Array;
	luma: Float32Array;
}

export interface AnalysisResult {
	/** The frame's own measurements; this is what gets persisted. */
	analysis: NegativeAnalysis;
	/** The bounds to render with: the frame's own, mixed with the roll baseline. */
	bounds: LogBounds;
	histograms: ChannelHistograms;
}

/** Log-scaled bin heights, so small peaks stay visible beside large ones. */
function scaleHistogram(counts: Uint32Array): Float32Array {
	const out = new Float32Array(HIST_BINS);
	let max = 0;
	for (let i = 0; i < HIST_BINS; i++) if (counts[i] > max) max = counts[i];
	if (max === 0) return out;
	const logMax = Math.log(1 + max);
	for (let i = 0; i < HIST_BINS; i++) out[i] = Math.log(1 + counts[i]) / logMax;
	return out;
}

/** Histograms of the grid normalized with `bounds`, clamped to [0, 1]. */
function normalizedHistograms(grid: LogGrid, bounds: LogBounds): ChannelHistograms {
	const counts = [0, 1, 2, 3].map(() => new Uint32Array(HIST_BINS));
	const span = bounds.ceils.map((c, ch) => {
		const d = c - bounds.floors[ch];
		return Math.abs(d) < 1e-6 ? 1e-6 : d;
	});
	const { data } = grid;
	const top = HIST_BINS - 1;
	for (let p = 0; p < data.length; p += 3) {
		let luma = 0;
		for (let ch = 0; ch < 3; ch++) {
			const u = Math.min(Math.max((data[p + ch] - bounds.floors[ch]) / span[ch], 0), 1);
			counts[ch][Math.floor(u * top)]++;
			luma += LUMA[ch] * u;
		}
		counts[3][Math.floor(luma * top)]++;
	}
	return {
		r: scaleHistogram(counts[0]),
		g: scaleHistogram(counts[1]),
		b: scaleHistogram(counts[2]),
		luma: scaleHistogram(counts[3]),
	};
}

/**
 * The grid through a linear-light matrix: each cell back to linear, through `m`, to log density
 * again. The cells are block medians of log density, so this stands in for matrixing every pixel
 * before the median; it only feeds the histograms.
 */
function matrixGrid(grid: LogGrid, m: Matrix3x3): LogGrid {
	const { data } = grid;
	const out = new Float32Array(data.length);
	for (let p = 0; p < data.length; p += 3) {
		const r = Math.pow(10, data[p]);
		const g = Math.pow(10, data[p + 1]);
		const b = Math.pow(10, data[p + 2]);
		for (let ch = 0; ch < 3; ch++) {
			const v = m[ch * 3] * r + m[ch * 3 + 1] * g + m[ch * 3 + 2] * b;
			out[p + ch] = Math.log10(Math.min(Math.max(v, 1e-6), 1));
		}
	}
	return { data: out, width: grid.width, height: grid.height };
}

/**
 * Measure a negative, or describe a slide.
 *
 * @param src           The linear (or sRGB-encoded 8-bit) source pixels.
 * @param filmType      Colour negatives also get a neutral axis for Cast Removal. A slide
 *                      (`'E6'`) is not metered: the transfer's fixed window, the neutral
 *                      meters, and histograms over that window.
 * @param baseline      The roll baseline applying to this frame, or null. The
 *                      frame's own bounds are measured regardless; the baseline
 *                      decides which bounds the anchor and the neutral axis read.
 *                      It never applies to a slide; its key is still recorded so
 *                      the caches treat every film type alike.
 * @param sourceMatrix  The linear-light matrix the render applies before the log (a RAW
 *                      slide's `slideCameraMatrix`), so the histograms show what is
 *                      rendered; null for none.
 */
export function analyzeNegative(
	src: LinearSource,
	width: number,
	height: number,
	filmType: FilmType,
	baseline: AppliedBaseline | null,
	sourceMatrix: Matrix3x3 | null = null,
): AnalysisResult {
	const grid = prefilterLogGrid(src, width, height);
	if (filmType === 'E6') {
		const bounds = transferBounds();
		const rendered = sourceMatrix ? matrixGrid(grid, sourceMatrix) : grid;
		return {
			analysis: {
				version: ANALYSIS_VERSION,
				floors: bounds.floors,
				ceils: bounds.ceils,
				anchor: transferAssumedAnchor(),
				texturalRange: AUTO_GRADE_NOMINAL_RANGE,
				neutralAxis: null,
				baselineKey: baseline?.key ?? null,
			},
			bounds,
			histograms: normalizedHistograms(rendered, bounds),
		};
	}
	const base = analyzeLogBounds(grid);
	const bounds = resolveBounds(base, baseline);
	return {
		analysis: {
			version: ANALYSIS_VERSION,
			floors: base.floors,
			ceils: base.ceils,
			// Brightness must not depend on the colour-average toggle, so the
			// anchor reads the luma source's bounds, not the final mix.
			anchor: measureAnchor(grid, lumaSourceBounds(base, baseline)),
			texturalRange: measureTexturalRange(grid),
			neutralAxis: filmType === 'C41' ? measureNeutralAxis(grid, bounds) : null,
			baselineKey: baseline?.key ?? null,
		},
		bounds,
		histograms: normalizedHistograms(grid, bounds),
	};
}
