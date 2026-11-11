/**
 * Click → source mapping for the white-balance picker.
 *
 * NegPy's `_handle_wb_pick` (negpy/desktop/controller.py) samples the
 * normalized log negative at the clicked point. Rolloc keeps the source on the
 * CPU, so the click is carried back through the geometry the preview applies
 * after the print curve. Each pass below is the exact lookup its shader does
 * (output uv → input uv), composed from the screen inwards:
 *
 *   CSS flip (canvas `scale(±1, ±1)`) → matte border (border.wgsl)
 *   → crop homography (crop.wgsl) → rotation + zoom (transform.wgsl) → source
 *
 * Sizing follows `runMainPasses` in pipeline.ts.
 */

import { rotationCoverZoom } from '../geometry';
import type { LinearSource } from './grid';
import type { CropQuad, Matrix3x3, TransformParams, Vec3 } from '$lib/types';

/** The geometry of one preview render. */
export interface PickGeometry {
	/** Source pixel size, before rotation. */
	sourceWidth: number;
	sourceHeight: number;
	transform: TransformParams;
	/** Crop quad in the rotated image's uv space; null = no crop. */
	cropQuad: CropQuad | null;
	/** Matte width, percent of the content's shorter edge. */
	borderWidth: number;
}

/** Half-width of the sampled patch, source pixels (NegPy `radius = 4`). */
export const PICK_RADIUS = 4;

/** Smallest linear value the log sees. */
const LOG_FLOOR = 1e-6;

/**
 * Matte thickness in pixels for content of the given size; `borderWidth` is a
 * percentage of the shorter edge. Matches `border_pixels` in the Rust export.
 */
export function borderPixelsForContent(contentW: number, contentH: number, borderWidth: number): number {
	if (!(borderWidth > 0)) return 0;
	return Math.round((borderWidth / 100) * Math.min(contentW, contentH));
}

/**
 * Projective map of the unit square onto `quad`, as `[a, b, c, d, e, f, g, h]`:
 * `W = g·u + h·v + 1`, `x = (a·u + b·v + c) / W`, `y = (d·u + e·v + f) / W`.
 * Matches crop.wgsl and the helper in the Rust export.
 */
export function computeCropHomography(
	quad: CropQuad,
): [number, number, number, number, number, number, number, number] {
	const x0 = quad.tl.x;
	const y0 = quad.tl.y;
	const x1 = quad.tr.x;
	const y1 = quad.tr.y;
	const x2 = quad.bl.x;
	const y2 = quad.bl.y;
	const x3 = quad.br.x;
	const y3 = quad.br.y;

	// g·(x1−x3) + h·(x2−x3) = x0−x1−x2+x3, likewise in y.
	const a = x1 - x3;
	const b = x2 - x3;
	const rx = x0 - x1 - x2 + x3;
	const c = y1 - y3;
	const d = y2 - y3;
	const ry = y0 - y1 - y2 + y3;

	const det = a * d - b * c;
	let g = 0;
	let h = 0;
	if (Math.abs(det) > 1e-10) {
		g = (rx * d - b * ry) / det;
		h = (a * ry - rx * c) / det;
	}

	return [(g + 1) * x1 - x0, (h + 1) * x2 - x0, x0, (g + 1) * y1 - y0, (h + 1) * y2 - y0, y0, g, h];
}

/** Crop output size: the quad's mean opposite-edge lengths in source pixels, at least 1. */
export function computeCropOutputDimensions(
	quad: CropQuad,
	srcWidth: number,
	srcHeight: number,
): { width: number; height: number } {
	const edge = (ax: number, ay: number, bx: number, by: number): number =>
		Math.sqrt(Math.pow((bx - ax) * srcWidth, 2) + Math.pow((by - ay) * srcHeight, 2));
	const top = edge(quad.tl.x, quad.tl.y, quad.tr.x, quad.tr.y);
	const bottom = edge(quad.bl.x, quad.bl.y, quad.br.x, quad.br.y);
	const left = edge(quad.tl.x, quad.tl.y, quad.bl.x, quad.bl.y);
	const right = edge(quad.tr.x, quad.tr.y, quad.br.x, quad.br.y);
	return {
		width: Math.max(1, Math.round((top + bottom) / 2)),
		height: Math.max(1, Math.round((left + right) / 2)),
	};
}

/**
 * Source position, in continuous source pixels (`[0, width] × [0, height]`),
 * displayed at `(nx, ny)`: the click normalized over the whole displayed
 * output, matte included. Null outside the image or on the matte.
 */
export function displayToSourcePixel(nx: number, ny: number, g: PickGeometry): [number, number] | null {
	const w = g.sourceWidth;
	const h = g.sourceHeight;
	if (!(w > 0 && h > 0) || !(nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1)) return null;
	const t = g.transform;

	// Output sizing as runMainPasses: swap at odd 90° steps, then the crop size.
	const swapDims = ((Math.round(t.rotation / 90) % 2) + 2) % 2 === 1;
	const rotW = swapDims ? h : w;
	const rotH = swapDims ? w : h;
	const content = g.cropQuad ? computeCropOutputDimensions(g.cropQuad, rotW, rotH) : { width: rotW, height: rotH };
	const bp = borderPixelsForContent(content.width, content.height, g.borderWidth);

	// The flip is a CSS transform of the whole canvas, applied last on screen.
	let x = t.flipH ? 1 - nx : nx;
	let y = t.flipV ? 1 - ny : ny;

	// border.wgsl: inner = (uv − bp/final) / (content/final).
	x = (x * (content.width + 2 * bp) - bp) / content.width;
	y = (y * (content.height + 2 * bp) - bp) / content.height;
	if (x < 0 || x > 1 || y < 0 || y > 1) return null;

	if (g.cropQuad) {
		const [a, b, c, d, e, f, gg, hh] = computeCropHomography(g.cropQuad);
		const den = gg * x + hh * y + 1;
		const cx = (a * x + b * y + c) / den;
		const cy = (d * x + e * y + f) / den;
		x = cx;
		y = cy;
	}

	// transform.wgsl, skipped by the pipeline when rotation and zoom are identity.
	const zoomUser = t.zoom ?? 1;
	if (!(Math.abs(t.rotation) < 0.001 && Math.abs(zoomUser - 1) < 0.001)) {
		const srcAspect = w / h;
		const outAspect = rotW / rotH;
		const isSwapped = Math.abs(outAspect - 1 / srcAspect) < Math.abs(outAspect - srcAspect);
		const canvasW = isSwapped ? 1 : srcAspect;
		const canvasH = isSwapped ? srcAspect : 1;
		const zoom = zoomUser * rotationCoverZoom(t.rotation, srcAspect);
		const rad = (t.rotation * Math.PI) / 180;
		const cos = Math.cos(rad);
		const sin = Math.sin(rad);
		const px = ((x - 0.5) / zoom) * canvasW;
		const py = ((y - 0.5) / zoom) * canvasH;
		x = (px * cos - py * sin) / srcAspect + 0.5;
		y = px * sin + py * cos + 0.5;
	}

	// The samplers clamp to the edge, so does the pick.
	return [Math.min(Math.max(x, 0), 1) * w, Math.min(Math.max(y, 0), 1) * h];
}

/**
 * log10 of a linear value floored at `LOG_FLOOR` (NaN reads as the floor) and, like the
 * normalization pass, not clamped above: a RAW slide's camera matrix folds the white balance
 * back in, which can lift an unclipped channel past 1.
 */
function logDensity(v: number): number {
	return Math.log10(v > LOG_FLOOR ? v : LOG_FLOOR);
}

function srgbToLinear(code: number): number {
	const c = code / 255;
	return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Mean per-channel log10 density of the patch around source pixel `(x, y)`.
 * The window is NegPy's: `[c − radius, c + radius)` on each axis around the
 * containing pixel `c`, cut at the image edge. Averaging log values matches
 * NegPy, which averages the normalized log (an affine map of it). `matrix`, when
 * given, is the linear-light matrix the render applies before the log (a RAW
 * slide's camera matrix), so the sample reads what the curve reads. Null when
 * the source is empty or shorter than `width × height`.
 */
export function sampleLogPatch(
	src: LinearSource,
	width: number,
	height: number,
	x: number,
	y: number,
	radius: number = PICK_RADIUS,
	matrix: Matrix3x3 | null = null,
): Vec3 | null {
	const stride = src.kind === 'linear-f32' ? src.channels : 4;
	if (!(width > 0 && height > 0) || src.pixels.length < width * height * stride) return null;
	if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
	const cx = Math.min(Math.max(Math.floor(x), 0), width - 1);
	const cy = Math.min(Math.max(Math.floor(y), 0), height - 1);
	const x0 = Math.max(cx - radius, 0);
	const x1 = Math.min(cx + radius, width);
	const y0 = Math.max(cy - radius, 0);
	const y1 = Math.min(cy + radius, height);

	const linear = (v: number): number =>
		src.kind === 'linear-f32' ? v : src.kind === 'linear-u16' ? v / 65535 : srgbToLinear(v);
	const sum: Vec3 = [0, 0, 0];
	const rgb: Vec3 = [0, 0, 0];
	for (let py = y0; py < y1; py++) {
		for (let px = x0; px < x1; px++) {
			const i = (py * width + px) * stride;
			for (let ch = 0; ch < 3; ch++) rgb[ch] = linear(src.pixels[i + ch]);
			for (let ch = 0; ch < 3; ch++) {
				const v = matrix
					? matrix[ch * 3] * rgb[0] + matrix[ch * 3 + 1] * rgb[1] + matrix[ch * 3 + 2] * rgb[2]
					: rgb[ch];
				sum[ch] += logDensity(v);
			}
		}
	}
	const n = (x1 - x0) * (y1 - y0);
	return [sum[0] / n, sum[1] / n, sum[2] / n];
}

/** The picker's sample: `sampleLogPatch` at the source position displayed at `(nx, ny)`. */
export function sampleSourceLogAt(
	src: LinearSource,
	width: number,
	height: number,
	nx: number,
	ny: number,
	geometry: PickGeometry,
	matrix: Matrix3x3 | null = null,
): Vec3 | null {
	if (width !== geometry.sourceWidth || height !== geometry.sourceHeight) return null;
	const p = displayToSourcePixel(nx, ny, geometry);
	return p ? sampleLogPatch(src, width, height, p[0], p[1], PICK_RADIUS, matrix) : null;
}
