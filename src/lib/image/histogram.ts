/**
 * RGB histogram helpers shared by the library viewer (CPU-sampled from a blob)
 * and the frame editor (GPU-counted from the rendered output).
 */

/** Bins per channel (8-bit display values). */
export const HISTOGRAM_BINS = 256;

/**
 * Cap the normalisation peak at this percentile of all non-zero bin values
 * across the three channels. Bins above the cap are clamped to 1, so a single
 * clipped-highlight spike does not flatten the rest of the histogram — the
 * behaviour of Apple Preview / Lightroom, where highlights still show as tall
 * bars but do not eclipse the midtones.
 */
const PEAK_PERCENTILE = 0.996;

/** Raw per-channel counts, `HISTOGRAM_BINS` each. */
export interface RgbCounts {
	r: Uint32Array;
	g: Uint32Array;
	b: Uint32Array;
	/** Pixels counted (each pixel adds one to every channel). */
	pixels: number;
}

/** Per-channel bin heights in [0, 1], `HISTOGRAM_BINS` each. */
export interface RgbBins {
	r: Float32Array;
	g: Float32Array;
	b: Float32Array;
}

/**
 * Scale counts to [0, 1] against a shared, percentile-capped peak.
 * Returns null when every bin is empty.
 */
export function normalizeRgbCounts(counts: RgbCounts): RgbBins | null {
	const all: number[] = [];
	for (const ch of [counts.r, counts.g, counts.b]) {
		for (const v of ch) if (v > 0) all.push(v);
	}
	if (all.length === 0) return null;
	all.sort((a, z) => a - z);
	const peak = all[Math.min(Math.floor(all.length * PEAK_PERCENTILE), all.length - 1)];
	const scale = (ch: Uint32Array): Float32Array => Float32Array.from(ch, (v) => Math.min(v / peak, 1));
	return { r: scale(counts.r), g: scale(counts.g), b: scale(counts.b) };
}

/**
 * Share of pixels pinned at black (`bin 0`) and white (`bin 255`), taken as the
 * worst channel: a pixel clipped in one channel has already lost detail.
 */
export function clippedFractions(counts: RgbCounts): { shadows: number; highlights: number } {
	if (counts.pixels === 0) return { shadows: 0, highlights: 0 };
	const last = HISTOGRAM_BINS - 1;
	const shadows = Math.max(counts.r[0], counts.g[0], counts.b[0]);
	const highlights = Math.max(counts.r[last], counts.g[last], counts.b[last]);
	return { shadows: shadows / counts.pixels, highlights: highlights / counts.pixels };
}
