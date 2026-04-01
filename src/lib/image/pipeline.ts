/**
 * WebGPU render pipeline for film negative inversion.
 *
 * Positive (invert = false) — 3-pass pipeline:
 *   Pass 0 (ingest_raw)   — rgba16uint linear → rgba16float  [RAW path only]
 *   Pass 1 (invert)       — normalize + pass-through + exposure (camera native linear)
 *   Pass 2 (colormatrix)  — 3×3 camera-to-sRGB colour matrix
 *   Pass 3 (tonecurve)    — white balance + RGB curves + global tone curve + γ encode
 *
 * Negative (invert = true) — NegPy pipeline (no camera colour matrix):
 *   Pass 0 (ingest_raw)     — rgba16uint linear → rgba16float  [RAW path only]
 *   Pass 1 (normalization)  — log10 conversion + per-channel percentile stretch
 *                             on camera-native data (per-channel stretch removes the
 *                             orange mask and inverts, matching negpy where rawpy
 *                             delivers Adobe RGB and normalization operates directly)
 *   Pass 2 (hd_curve)       — H&D sigmoid: CMY timing + toe/shoulder + paper response
 *                             outputs gamma-encoded transmittance (pow 1/2.2)
 *   Pass 2.5 (clahe)        — optional CLAHE local contrast enhancement
 *   Pass 3 (tonecurve)      — white balance + RGB curves + global tone curve (no sRGB γ)
 *
 * Usage:
 *   const gpu = await createPipeline(canvas);
 *   await gpu.render(effectiveEdit, imageBitmap);      // JPEG/TIFF source
 *   await gpu.renderRaw(effectiveEdit, rawBuffer);     // RAW source (from raw_decode)
 *   gpu.destroy();          // free GPU resources
 */

import invertWGSL           from './shaders/invert.wgsl?raw';
import colorMatrixWGSL      from './shaders/colormatrix.wgsl?raw';
import toneCurveWGSL        from './shaders/tonecurve.wgsl?raw';
import ingestRawWGSL        from './shaders/ingest_raw.wgsl?raw';
import normalizationWGSL    from './shaders/normalization.wgsl?raw';
import hdCurveWGSL          from './shaders/hd_curve.wgsl?raw';
import claheHistogramWGSL   from './shaders/clahe_histogram.wgsl?raw';
import claheRemapWGSL       from './shaders/clahe_remap.wgsl?raw';
import blitWGSL             from './shaders/blit.wgsl?raw';
import cropWGSL             from './shaders/crop.wgsl?raw';
import { buildCurveLUTs } from './curves';
import type { CropQuad, EffectiveEdit, InversionParams, Matrix3x3 } from '$lib/types';

// ─── NegPy constants ───────────────────────────────────────────────────────────

/** Maximum log-density shift per CMY slider unit (negpy EXPOSURE_CONSTANTS.cmy_max_density). */
const CMY_MAX_DENSITY = 0.15;
/** Maps the density slider to an exposure shift: shift = 0.01 + density * DENSITY_MULTIPLIER (negpy density_multiplier). */
const DENSITY_MULTIPLIER = 0.15;
/** Maps the grade slider to the sigmoid slope: slope = 1.0 + grade * GRADE_MULTIPLIER (negpy grade_multiplier). */
const GRADE_MULTIPLIER = 1.75;
/** Maximum print density (D_max) — deepest black photographic paper can produce. */
const D_MAX = 4.0;
/** CLAHE tile grid dimensions (8×8 matches negpy's default grid_dim). */
const CLAHE_TILES_X = 8;
const CLAHE_TILES_Y = 8;
/** Number of histogram bins per tile (must match NUM_BINS in the WGSL shaders). */
const CLAHE_NUM_BINS = 256;

// ─── White balance helpers ─────────────────────────────────────────────────────

/**
 * Convert colour temperature (K) + tint to per-channel multipliers [r, g, b].
 * Uses a simplified Planckian locus approximation good enough for photographic
 * colour correction.  The green channel is kept at 1.0 and r/b are scaled
 * relative to it.
 */
function temperatureToMultipliers(temperature: number, tint: number): [number, number, number] {
	// Map temperature to a normalised ratio of red vs blue
	// Based on the Kang et al. (2002) polynomial fit to Planckian locus in xy
	const t = Math.max(1000, Math.min(20000, temperature));

	let x: number;
	if (t <= 4000) {
		x = -0.2661239e9 / (t * t * t) - 0.2343589e6 / (t * t) + 0.8776956e3 / t + 0.179910;
	} else {
		x = -3.0258469e9 / (t * t * t) + 2.1070379e6 / (t * t) + 0.2226347e3 / t + 0.240390;
	}
	const y = x < 0.182
		? -1.1063814 * x * x * x - 1.34811020 * x * x + 2.18555832 * x - 0.20219683
		: -0.9549476 * x * x * x - 1.37418593 * x * x + 2.09137015 * x - 0.16748867;

	// Convert xy to XYZ (Y=1), then to linear sRGB
	const Y = 1.0;
	const X = (Y / y) * x;
	const Z = (Y / y) * (1 - x - y);

	// XYZ D65 → linear sRGB (IEC 61966-2-1)
	const r =  3.2406 * X - 1.5372 * Y - 0.4986 * Z;
	const g = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
	const b =  0.0557 * X - 0.2040 * Y + 1.0570 * Z;

	// Normalise so that green channel (most stable) is 1.0
	const gNorm = g > 0 ? g : 1;
	const tintFactor = Math.pow(2, tint / 100);

	return [
		Math.max(0.01, r / gNorm),
		Math.max(0.01, 1.0 / tintFactor),
		Math.max(0.01, b / gNorm),
	];
}

// ─── Log-space percentile computation (NegPy normalization) ──────────────────

/**
 * Default analysis buffer ratio — matches negpy's ProcessConfig.analysis_buffer.
 * Crops this fraction of each edge before computing percentiles, excluding the
 * film rebate border from the analysis.
 */
const ANALYSIS_BUFFER = 0.10;

/**
 * Per-channel log-density floor/ceil for the normalization shader.
 * The normalization pass does: normalized = (log10(pixel) - floor) / (ceil - floor)
 * For C-41 negatives: floor ≈ 0.5th percentile, ceil ≈ 99.5th percentile.
 * Since log10 of values < 1 is negative, floor < ceil < 0 for typical film.
 */
export interface LogPercentiles {
	floors: [number, number, number];
	ceils:  [number, number, number];
}

/**
 * Compute per-channel 0.5th / 99.5th log10 percentiles from a Float32Array of
 * linear RGBA pixels (length = w * h * 4, R at [0], G at [1], B at [2]).
 *
 * When `width` and `height` are provided, an analysis buffer crop is applied
 * (matching negpy's `analysis_buffer=0.10`) to exclude the film rebate border.
 *
 * When `colorMatrix` is provided (row-major 3×3), it is applied to each pixel
 * before the log transform — this is essential for the negative path where the
 * GPU applies the cam→sRGB matrix before the normalization shader.
 *
 * Downsamples by `stride` to keep it fast for large images (default: every 8th pixel).
 */
function computeLogPercentilesFromF32(
	pixels: Float32Array,
	width: number = 0,
	height: number = 0,
	stride: number = 8,
	colorMatrix?: Matrix3x3,
): LogPercentiles {
	const LOG10_E = 0.43429448190325183;
	const eps = 1e-6;

	// Optional color matrix application (row-major [m00,m01,m02, m10,m11,m12, m20,m21,m22]).
	const hasMatrix = colorMatrix !== undefined;
	const m = colorMatrix;

	// Collect per-pixel log10 values (r, g, b) and their mean luminance.
	// We store tuples so we can later select "darkest" pixels by mean luminance
	// and average their per-channel values — matching negpy's floor computation.
	const rLog: number[] = [];
	const gLog: number[] = [];
	const bLog: number[] = [];
	const meanLog: number[] = [];

	function processPixel(rawR: number, rawG: number, rawB: number): void {
		let r = rawR, g = rawG, b = rawB;
		if (hasMatrix && m) {
			r = Math.max(0, m[0] * rawR + m[1] * rawG + m[2] * rawB);
			g = Math.max(0, m[3] * rawR + m[4] * rawG + m[5] * rawB);
			b = Math.max(0, m[6] * rawR + m[7] * rawG + m[8] * rawB);
		}
		if (r > eps && g > eps && b > eps) {
			const lr = Math.log(r) * LOG10_E;
			const lg = Math.log(g) * LOG10_E;
			const lb = Math.log(b) * LOG10_E;
			rLog.push(lr);
			gLog.push(lg);
			bLog.push(lb);
			meanLog.push((lr + lg + lb) / 3);
		}
	}

	// Apply analysis buffer crop when dimensions are known.
	const hasDims = width > 0 && height > 0;
	const cutY = hasDims ? Math.floor(height * ANALYSIS_BUFFER) : 0;
	const cutX = hasDims ? Math.floor(width * ANALYSIS_BUFFER) : 0;
	const startY = cutY;
	const endY   = hasDims ? height - cutY : 0;
	const startX = cutX;
	const endX   = hasDims ? width - cutX : 0;

	if (hasDims) {
		for (let y = startY; y < endY; y += stride) {
			for (let x = startX; x < endX; x += stride) {
				const i = (y * width + x) * 4;
				processPixel(pixels[i], pixels[i + 1], pixels[i + 2]);
			}
		}
	} else {
		for (let i = 0; i < pixels.length; i += 4 * stride) {
			processPixel(pixels[i], pixels[i + 1], pixels[i + 2]);
		}
	}

	function percentile(arr: number[], p: number): number {
		if (arr.length === 0) return -1.0;
		const sorted = arr.slice().sort((a, b) => a - b);
		const idx = Math.floor((p / 100) * (sorted.length - 1));
		return sorted[idx];
	}

	// Floors: find the 0.001th percentile of mean luminance, select pixels
	// at or below that threshold, and average their per-channel log values.
	// This matches negpy's analyze_log_exposure_bounds() which uses the mean
	// of the darkest pixels rather than a raw per-channel percentile.
	const darkThreshold = percentile(meanLog, 0.001);
	let floorR = 0, floorG = 0, floorB = 0, darkCount = 0;
	for (let i = 0; i < meanLog.length; i++) {
		if (meanLog[i] <= darkThreshold) {
			floorR += rLog[i];
			floorG += gLog[i];
			floorB += bLog[i];
			darkCount++;
		}
	}
	const floors: [number, number, number] = darkCount > 0
		? [floorR / darkCount, floorG / darkCount, floorB / darkCount]
		: [percentile(rLog, 0.001), percentile(gLog, 0.001), percentile(bLog, 0.001)];

	return {
		floors,
		ceils: [
			percentile(rLog, 99.999),
			percentile(gLog, 99.999),
			percentile(bLog, 99.999),
		],
	};
}

/**
 * Compute log percentiles from a Uint16Array of linear u16 RGBA pixels
 * (as returned by `raw_decode`).  Values are divided by 65535 to normalise
 * to [0, 1] before the log transform.
 *
 * `width` and `height` are used to apply the analysis buffer crop.
 * `colorMatrix` — optional row-major 3×3 camera→sRGB matrix applied before log.
 */
function computeLogPercentilesFromU16(
	pixels: Uint16Array,
	width: number,
	height: number,
	stride: number = 8,
	colorMatrix?: Matrix3x3,
): LogPercentiles {
	// Normalise u16 → [0,1] float and reuse the float percentile path.
	// Do NOT truncate to the first N pixels — that produces a biased sample
	// from only the top rows of the image at high resolutions.  Instead let
	// the stride parameter do the downsampling so the entire image is covered.
	const f32 = new Float32Array(pixels.length);
	for (let i = 0; i < pixels.length; i++) {
		f32[i] = pixels[i] / 65535.0;
	}
	return computeLogPercentilesFromF32(f32, width, height, stride, colorMatrix);
}

/**
 * Read the pixels of an `ImageBitmap` to a Float32Array via OffscreenCanvas.
 * The result is sRGB-encoded [0,1] f32 values; callers should gamma-expand
 * before computing log percentiles if strictly necessary.  For the percentile
 * computation (which only needs relative ordering), sRGB values are adequate.
 */
async function bitmapToF32Pixels(bitmap: ImageBitmap): Promise<Float32Array> {
	const oc = new OffscreenCanvas(bitmap.width, bitmap.height);
	const ctx = oc.getContext('2d');
	if (!ctx) throw new Error('Could not create OffscreenCanvas 2D context');
	ctx.drawImage(bitmap, 0, 0);
	const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
	// Convert Uint8ClampedArray [0,255] sRGB to float [0,1].
	const f32 = new Float32Array(data.data.length);
	for (let i = 0; i < data.data.length; i++) {
		f32[i] = data.data[i] / 255.0;
	}
	return f32;
}

// ─── Types ────────────────────────────────────────────────────────────────────

/** Parsed metadata from the `raw_decode` binary payload. */
export interface RawDecodeMetadata {
	width: number;
	height: number;
	make: string;
	model: string;
	wbCoeffs: [number, number, number, number];
	colorMatrix: [
		number, number, number,
		number, number, number,
		number, number, number,
	];
	illuminantTemp: number;
	bps: number;
}

/** Parsed result from a `raw_decode` ArrayBuffer response. */
export interface RawDecodeResult {
	width: number;
	height: number;
	/** Uint16Array view of the RGBA pixel data (length = width * height * 4). */
	pixels: Uint16Array;
	meta: RawDecodeMetadata;
}

/**
 * Parse the binary payload returned by the `raw_decode` Tauri command.
 *
 * Layout:
 *   [0..4]   width  : u32 LE
 *   [4..8]   height : u32 LE
 *   [8 .. 8+w*h*8]  RGBA u16 LE  (4 channels × 2 bytes)
 *   [8+pixels .. +4]  meta JSON byte length u32 LE
 *   [.. ]             meta JSON UTF-8
 */
export function parseRawDecodeBuffer(buffer: ArrayBuffer): RawDecodeResult {
	const view = new DataView(buffer);
	const width  = view.getUint32(0, true);
	const height = view.getUint32(4, true);
	const pixelByteLen = width * height * 4 * 2; // u16 × 4 channels × 2 bytes/u16
	const pixelsOffset = 8;
	const pixels = new Uint16Array(buffer, pixelsOffset, width * height * 4);

	const metaLenOffset = pixelsOffset + pixelByteLen;
	const metaLen = view.getUint32(metaLenOffset, true);
	const metaBytes = new Uint8Array(buffer, metaLenOffset + 4, metaLen);
	const meta = JSON.parse(new TextDecoder().decode(metaBytes)) as RawDecodeMetadata;

	return { width, height, pixels, meta };
}

export interface GpuPipeline {
	/**
	 * Re-render the canvas from a JPEG/TIFF source (ImageBitmap, sRGB-encoded).
	 */
	render(edit: EffectiveEdit, bitmap: ImageBitmap): Promise<void>;
	/**
	 * Re-render the canvas from a RAW linear source.
	 * `rawBuffer` is the ArrayBuffer returned by the `raw_decode` Tauri command.
	 * `logPercOverride` — when provided, skips recomputing percentiles from the
	 * buffer and uses these values instead.  Pass `lastLogPerc` on export so the
	 * full-res render uses the same normalization as the preview.
	 */
	renderRaw(edit: EffectiveEdit, rawBuffer: ArrayBuffer, logPercOverride?: LogPercentiles): Promise<void>;
	/**
	 * Read back a rectangle of sRGB pixels from the last rendered output.
	 * Returns `null` if no render has completed yet or if the region is out of bounds.
	 * The returned array has length `w * h * 4` (RGBA, 0–255).
	 */
	readPixels(x: number, y: number, w: number, h: number): Promise<Uint8ClampedArray | null>;
	/** Release all GPU resources. Call when the editor unmounts. */
	destroy(): void;
	/**
	 * The device's `maxTextureDimension2D` limit.
	 * Pass this as `maxPx` to the `raw_decode` Tauri command so Rust can
	 * downsample images that would exceed the GPU texture size limit before
	 * sending data over IPC.
	 */
	maxTextureDimension: number;
	/** The log percentiles from the last RAW preview render, or null if not yet rendered. */
	lastLogPerc: LogPercentiles | null;
	/**
	 * The output dimensions from the last render (after crop is applied).
	 * Use these for readPixels() after rendering to get the correct cropped size.
	 */
	lastOutputWidth: number;
	lastOutputHeight: number;
}

// ─── LUT texture helper ───────────────────────────────────────────────────────

function createLutTexture(device: GPUDevice, data: Float32Array): GPUTexture {
	const texture = device.createTexture({
		size: [data.length, 1, 1],
		format: 'r32float',
		usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
		dimension: '1d',
	});
	device.queue.writeTexture(
		{ texture },
		data.buffer as ArrayBuffer,
		{ bytesPerRow: data.byteLength },
		[data.length, 1, 1],
	);
	return texture;
}

// ─── Off-screen texture helper ────────────────────────────────────────────────

function createRGBA16Texture(device: GPUDevice, width: number, height: number): GPUTexture {
	return device.createTexture({
		size: [width, height],
		format: 'rgba16float',
		usage:
			GPUTextureUsage.RENDER_ATTACHMENT |
			GPUTextureUsage.TEXTURE_BINDING,
	});
}

// ─── Sampler ──────────────────────────────────────────────────────────────────

function createLinearSampler(device: GPUDevice): GPUSampler {
	return device.createSampler({
		magFilter: 'linear',
		minFilter: 'linear',
	});
}

// ─── Full-screen-triangle render pass ────────────────────────────────────────

function drawFullscreenTriangle(
	encoder: GPUCommandEncoder,
	pipeline: GPURenderPipeline,
	bindGroup: GPUBindGroup,
	target: GPUTextureView,
): void {
	const pass = encoder.beginRenderPass({
		colorAttachments: [{
			view: target,
			loadOp: 'clear',
			storeOp: 'store',
			clearValue: { r: 0, g: 0, b: 0, a: 1 },
		}],
	});
	pass.setPipeline(pipeline);
	pass.setBindGroup(0, bindGroup);
	pass.draw(3);
	pass.end();
}

// ─── Uniform buffer helpers ───────────────────────────────────────────────────

function makeUniformBuffer(device: GPUDevice, data: Float32Array): GPUBuffer {
	const buf = device.createBuffer({
		size: Math.max(data.byteLength, 16),
		usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
	});
	device.queue.writeBuffer(buf, 0, data.buffer as ArrayBuffer);
	return buf;
}

// ─── NegPy uniform builders ───────────────────────────────────────────────────

/**
 * Build the normalization pass uniform buffer.
 *
 * NormUniforms layout (all vec4 + scalars, 16-byte aligned, total 48 bytes):
 *   floors         : vec4<f32>  @ 0   (rgb + pad)
 *   ceils          : vec4<f32>  @ 16  (rgb + pad)
 *   shadowCast     : vec4<f32>  @ 32  (rgb + pad)
 *   shadowStrength : f32        @ 48
 *   wpOffset       : f32        @ 52
 *   bpOffset       : f32        @ 56
 *   _pad           : f32        @ 60
 *   struct size = 64 bytes
 */
function makeNormalizationUniforms(
	device: GPUDevice,
	perc: LogPercentiles,
): GPUBuffer {
	const data = new Float32Array([
		perc.floors[0], perc.floors[1], perc.floors[2], 0,  // floors + pad
		perc.ceils[0],  perc.ceils[1],  perc.ceils[2],  0,  // ceils + pad
		0, 0, 0, 0,  // shadowCast + pad (no shadow cast correction for now)
		0.0,         // shadowStrength
		0.0,         // wpOffset
		0.0,         // bpOffset
		0.0,         // _pad
	]);
	return makeUniformBuffer(device, data);
}

/**
 * Build the H&D curve pass uniform buffer from InversionParams.
 *
 * HDCurveUniforms layout (total 128 bytes):
 *   pivots           : vec4<f32>  @ 0
 *   slopes           : vec4<f32>  @ 16
 *   cmyOffsets       : vec4<f32>  @ 32   (r=cyan, g=magenta, b=yellow in log-density)
 *   shadowCmy        : vec4<f32>  @ 48
 *   highlightCmy     : vec4<f32>  @ 64
 *   toe              : f32        @ 80
 *   toeWidth         : f32        @ 84
 *   _unused0         : f32        @ 88   (toeHardness slot, unused)
 *   shoulder         : f32        @ 92
 *   shoulderWidth    : f32        @ 96
 *   _unused1         : f32        @ 100  (shoulderHardness slot, unused)
 *   shadows          : f32        @ 104
 *   highlights       : f32        @ 108
 *   dMax             : f32        @ 112
 *   _pad0            : f32        @ 116
 *   _pad1            : f32        @ 120
 *   _pad2            : f32        @ 124
 *
 * Note: gamma is applied here as pow(transmittance, 1/2.2) matching negpy.
 * The tonecurve pass skips sRGB encode on the negpy path (skipSrgb flag).
 */
function makeHDCurveUniforms(
	device: GPUDevice,
	inv: InversionParams,
): GPUBuffer {
	// Pivot and slope match NegPy's PhotometricProcessor formula:
	//   exposure_shift = 0.01 + (density * DENSITY_MULTIPLIER)
	//   pivot          = 1.0 - exposure_shift
	//   slope          = 1.0 + (grade * GRADE_MULTIPLIER)
	// At defaults (density=1.0, grade=2.5): pivot=0.84, slope=5.375.
	const pivot = 1.0 - (0.01 + inv.density * DENSITY_MULTIPLIER);
	const slope = 1.0 + inv.grade * GRADE_MULTIPLIER;

	// CMY offsets convert slider values [-1,+1] to log-density via CMY_MAX_DENSITY.
	// NegPy convention: Cyan shifts Red channel, Magenta shifts Green, Yellow shifts Blue.
	const cmyR = inv.cmyCyan    * CMY_MAX_DENSITY;
	const cmyG = inv.cmyMagenta * CMY_MAX_DENSITY;
	const cmyB = inv.cmyYellow  * CMY_MAX_DENSITY;

	const sCmyR = inv.shadowCyan    * CMY_MAX_DENSITY;
	const sCmyG = inv.shadowMagenta * CMY_MAX_DENSITY;
	const sCmyB = inv.shadowYellow  * CMY_MAX_DENSITY;

	const hCmyR = inv.highlightCyan    * CMY_MAX_DENSITY;
	const hCmyG = inv.highlightMagenta * CMY_MAX_DENSITY;
	const hCmyB = inv.highlightYellow  * CMY_MAX_DENSITY;

	const data = new Float32Array([
		pivot, pivot, pivot, 0,           // pivots rgb + pad
		slope, slope, slope, 0,           // slopes rgb + pad
		cmyR,  cmyG,  cmyB,  0,           // cmyOffsets rgb + pad
		sCmyR, sCmyG, sCmyB, 0,           // shadowCmy rgb + pad
		hCmyR, hCmyG, hCmyB, 0,           // highlightCmy rgb + pad
		inv.toe,              // toe
		inv.toeWidth,         // toeWidth
		0.0,                  // _unused0 (toeHardness slot, ignored by shader)
		inv.shoulder,         // shoulder
		inv.shoulderWidth,    // shoulderWidth
		0.0,                  // _unused1 (shoulderHardness slot, ignored by shader)
		inv.shadows,          // shadows
		inv.highlights,       // highlights
		D_MAX,                // dMax
		0.0,                  // _pad0
		0.0,                  // _pad1
		0.0,                  // _pad2
	]);
	return makeUniformBuffer(device, data);
}

// ─── Crop uniform builder ─────────────────────────────────────────────────────

/**
 * Build the crop pass uniform buffer from a CropQuad.
 *
 * CropQuadUniforms layout (total 32 bytes):
 *   tl : vec2<f32>  @ 0   (top-left)
 *   tr : vec2<f32>  @ 8   (top-right)
 *   br : vec2<f32>  @ 16  (bottom-right)
 *   bl : vec2<f32>  @ 24  (bottom-left)
 */
function makeCropUniforms(device: GPUDevice, quad: CropQuad): GPUBuffer {
	const data = new Float32Array([
		quad.tl.x, quad.tl.y,
		quad.tr.x, quad.tr.y,
		quad.br.x, quad.br.y,
		quad.bl.x, quad.bl.y,
	]);
	return makeUniformBuffer(device, data);
}

/**
 * Calculate the output dimensions for a crop operation.
 *
 * For a quadrilateral crop, we compute the average width and height of the quad
 * in source pixels. This gives a natural aspect ratio that preserves the cropped
 * region without distortion.
 *
 * - Width: average of top edge (tl→tr) and bottom edge (bl→br)
 * - Height: average of left edge (tl→bl) and right edge (tr→br)
 */
function computeCropOutputDimensions(
	quad: CropQuad,
	srcWidth: number,
	srcHeight: number
): { width: number; height: number } {
	// Calculate edge lengths in pixel space
	const topWidth = Math.sqrt(
		Math.pow((quad.tr.x - quad.tl.x) * srcWidth, 2) +
		Math.pow((quad.tr.y - quad.tl.y) * srcHeight, 2)
	);
	const bottomWidth = Math.sqrt(
		Math.pow((quad.br.x - quad.bl.x) * srcWidth, 2) +
		Math.pow((quad.br.y - quad.bl.y) * srcHeight, 2)
	);
	const leftHeight = Math.sqrt(
		Math.pow((quad.bl.x - quad.tl.x) * srcWidth, 2) +
		Math.pow((quad.bl.y - quad.tl.y) * srcHeight, 2)
	);
	const rightHeight = Math.sqrt(
		Math.pow((quad.br.x - quad.tr.x) * srcWidth, 2) +
		Math.pow((quad.br.y - quad.tr.y) * srcHeight, 2)
	);

	// Average the opposite edges for the output dimensions
	const width = Math.round((topWidth + bottomWidth) / 2);
	const height = Math.round((leftHeight + rightHeight) / 2);

	// Ensure minimum size of 1 pixel
	return {
		width: Math.max(1, width),
		height: Math.max(1, height),
	};
}

// ─── Pipeline creation ────────────────────────────────────────────────────────

/**
 * Initialise the WebGPU pipeline for the given canvas.
 * Throws if WebGPU is not available or the adapter/device cannot be obtained.
 */
export async function createPipeline(canvas: HTMLCanvasElement): Promise<GpuPipeline> {
	if (!navigator.gpu) {
		throw new Error('WebGPU is not supported in this browser.');
	}

	const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
	if (!adapter) throw new Error('No WebGPU adapter available.');

	const device = await adapter.requestDevice();
	const maxTextureDimension = device.limits.maxTextureDimension2D;

	const contextOrNull = canvas.getContext('webgpu');
	if (!contextOrNull) throw new Error('Could not get WebGPU canvas context.');
	// Structurally impossible to be null beyond this point; we threw above.
	const context: GPUCanvasContext = contextOrNull;

	const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
	context.configure({ device, format: presentationFormat, alphaMode: 'opaque' });

	const sampler = createLinearSampler(device);

	// ── Compile shader modules ──────────────────────────────────────────────

	const ingestRawModule     = device.createShaderModule({ code: ingestRawWGSL });
	const invertModule        = device.createShaderModule({ code: invertWGSL });
	const normalizationModule = device.createShaderModule({ code: normalizationWGSL });
	const hdCurveModule       = device.createShaderModule({ code: hdCurveWGSL });
	const claheHistModule     = device.createShaderModule({ code: claheHistogramWGSL });
	const claheRemapModule    = device.createShaderModule({ code: claheRemapWGSL });
	const colorMatrixModule   = device.createShaderModule({ code: colorMatrixWGSL });
	const toneCurveModule     = device.createShaderModule({ code: toneCurveWGSL });
	const blitModule          = device.createShaderModule({ code: blitWGSL });
	const cropModule          = device.createShaderModule({ code: cropWGSL });

	// ── Build render pipelines ──────────────────────────────────────────────

	function makeRenderPipeline(module: GPUShaderModule, format: GPUTextureFormat): GPURenderPipeline {
		return device.createRenderPipeline({
			layout: 'auto',
			vertex:   { module, entryPoint: 'vs_main' },
			fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
			primitive: { topology: 'triangle-list' },
		});
	}

	const ingestRawPipeline     = makeRenderPipeline(ingestRawModule,     'rgba16float');
	const invertPipeline        = makeRenderPipeline(invertModule,         'rgba16float');
	const normalizationPipeline = makeRenderPipeline(normalizationModule,  'rgba16float');
	const hdCurvePipeline       = makeRenderPipeline(hdCurveModule,        'rgba16float');
	const colorMatrixPipeline   = makeRenderPipeline(colorMatrixModule,    'rgba16float');
	/**
	 * Tone curve renders to `rgba16float` for maximum precision.
	 * A blit pass with ordered dithering then converts to the 8-bit swap chain,
	 * and a separate readback copy quantises to `rgba8unorm` with dithering.
	 */
	const toneCurvePipeline     = makeRenderPipeline(toneCurveModule,      'rgba16float');
	const blitPipeline          = makeRenderPipeline(blitModule,           presentationFormat);
	/** Blit pipeline targeting rgba8unorm for the readback texture. */
	const blitReadbackPipeline  = makeRenderPipeline(blitModule,           'rgba8unorm');

	// ── CLAHE pipelines ────────────────────────────────────────────────────

	/** CLAHE remap fragment pipeline (fullscreen triangle). */
	const claheRemapPipeline = makeRenderPipeline(claheRemapModule, 'rgba16float');

	/**
	 * CLAHE histogram compute pipeline.
	 * Bind group layout: @binding(0) texture_2d<f32>, @binding(1) uniform, @binding(2) storage rw.
	 */
	const claheHistPipeline = device.createComputePipeline({
		layout: 'auto',
		compute: { module: claheHistModule, entryPoint: 'main' },
	});

	// ── Crop pipeline (perspective quad → rect) ───────────────────────────────

	/**
	 * Crop pipeline applies perspective correction by sampling from a quadrilateral
	 * region of the source and mapping it to the output rectangle.
	 */
	const cropPipeline = makeRenderPipeline(cropModule, 'rgba16float');

	// ── Mutable resources (rebuilt per render when image changes) ────────────

	let lastBitmap: ImageBitmap | null = null;
	let sourceTexture: GPUTexture | null = null;
	let intermediateA: GPUTexture | null = null;
	let intermediateB: GPUTexture | null = null;
	/** Third intermediate needed for the 5-pass NegPy invert path. */
	let intermediateC: GPUTexture | null = null;
	/** Fourth intermediate: CLAHE remap output (between H&D curve and tonecurve). */
	let intermediateD: GPUTexture | null = null;
	/**
	 * Storage buffer for CLAHE CDF data.
	 * Size: CLAHE_TILES_X * CLAHE_TILES_Y * CLAHE_NUM_BINS * 4 bytes (f32).
	 */
	let claheCdfBuffer: GPUBuffer | null = null;
	/**
	 * Persistent rgba16float output texture (RENDER_ATTACHMENT | TEXTURE_BINDING).
	 * The tone curve pass renders here at full precision; the blit pass dithers
	 * it down to the 8-bit swap chain.
	 */
	let outputTexture: GPUTexture | null = null;
	/**
	 * Intermediate texture for the crop pass (rgba16float).
	 * When cropping is active, tonecurve → preCropTexture → crop → outputTexture.
	 */
	let preCropTexture: GPUTexture | null = null;
	/**
	 * Persistent rgba8unorm readback texture (COPY_SRC | RENDER_ATTACHMENT | TEXTURE_BINDING).
	 * A dithered blit from outputTexture writes here; readPixels() copies from this texture.
	 */
	let readbackTexture: GPUTexture | null = null;
	/**
	 * Log percentiles cached from the last RAW preview render.
	 * Reused on export so full-res and preview-res produce identical normalization.
	 */
	let lastLogPerc: LogPercentiles | null = null;

	/** Track last output dimensions to detect when resize is needed. */
	let lastOutputWidth = 0;
	let lastOutputHeight = 0;

	// ─── Shared main-pass render logic ─────────────────────────────────────────

	/**
	 * Runs the main passes on `sourceTexture` depending on whether inversion
	 * is enabled.
	 *
	 * Positive path (invert = false): invert(passthrough) → colormatrix → tonecurve
	 * Negative path (invert = true):  normalization → hd_curve → colormatrix → tonecurve
	 *
	 * When crop is active, the output is resized to match the crop region's natural
	 * aspect ratio, and the crop shader extracts the region without distortion.
	 *
	 * @param isLinear  true for the RAW path (input is linear light);
	 *                  false for JPEG/TIFF (sRGB-encoded, needs gamma expand in invert pass).
	 * @param logPerc   Per-channel log percentiles required for the normalization pass.
	 *                  Must be provided when edit.invert = true.
	 */
	async function runMainPasses(
		edit: EffectiveEdit,
		w: number,
		h: number,
		isLinear: boolean,
		logPerc: LogPercentiles | null,
	): Promise<void> {
		// ── Compute output dimensions (may differ from source if cropped) ───
		const hasCrop = edit.cropQuad !== null;
		let outW = w;
		let outH = h;
		if (hasCrop && edit.cropQuad) {
			const cropDims = computeCropOutputDimensions(edit.cropQuad, w, h);
			outW = cropDims.width;
			outH = cropDims.height;
		}

		// ── Resize canvas + output textures if dimensions changed ───────────
		if (outW !== lastOutputWidth || outH !== lastOutputHeight) {
			canvas.width = outW;
			canvas.height = outH;
			context.configure({ device, format: presentationFormat, alphaMode: 'opaque' });

			// Rebuild output + readback textures at new size
			outputTexture?.destroy();
			outputTexture = device.createTexture({
				size: [outW, outH],
				format: 'rgba16float',
				usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
			});
			readbackTexture?.destroy();
			readbackTexture = device.createTexture({
				size: [outW, outH],
				format: 'rgba8unorm',
				usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
			});

			lastOutputWidth = outW;
			lastOutputHeight = outH;
		}
		// ── Build LUT textures ──────────────────────────────────────────────

		const [toneLut, redLut, greenLut, blueLut] = buildCurveLUTs(
			edit.toneCurve,
			edit.rgbCurves,
		);

		const toneLutTex  = createLutTexture(device, toneLut);
		const redLutTex   = createLutTexture(device, redLut);
		const greenLutTex = createLutTexture(device, greenLut);
		const blueLutTex  = createLutTexture(device, blueLut);

		// ── Build colour matrix uniforms ────────────────────────────────────
		// Source matrix m is row-major [m00,m01,m02, m10,m11,m12, m20,m21,m22].
		// WGSL mat3x3 col0 = [m00,m10,m20], col1 = [m01,m11,m21], col2 = [m02,m12,m22].
		const m: Matrix3x3 = edit.cameraColorMatrix;
		const colorMatrixUniforms = new Float32Array([
			m[0], m[3], m[6], 0,   // col0: [m00, m10, m20, pad]
			m[1], m[4], m[7], 0,   // col1: [m01, m11, m21, pad]
			m[2], m[5], m[8], 0,   // col2: [m02, m12, m22, pad]
			0,    0,    0,    0,   // _pad vec4
		]);
		const colorMatrixUniformBuf = makeUniformBuffer(device, colorMatrixUniforms);

		// ── Build tone curve (WB + LUT) uniforms ────────────────────────────
		const [tcWbR, tcWbG, tcWbB] = temperatureToMultipliers(
			edit.whiteBalance.temperature,
			edit.whiteBalance.tint,
		);
		const toneCurveUniforms = new Float32Array([
			tcWbR, tcWbG, tcWbB, 1.0,              // wbMultipliers
			edit.invert ? 1.0 : 0.0, 0.0, 0.0, 0.0, // flags: [skipSrgb, pad, pad, pad]
		]);
		const toneCurveUniformBuf = makeUniformBuffer(device, toneCurveUniforms);

		const lutSampler = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });

		const encoder = device.createCommandEncoder();

		const toClean: GPUBuffer[] = [colorMatrixUniformBuf, toneCurveUniformBuf];

		// Texture that feeds the final tonecurve pass.
		let beforeToneCurve: GPUTextureView;

		if (edit.invert && logPerc) {
			// ── NegPy inversion path ──────────────────────────────────────────
			// negpy has NO camera color matrix — rawpy converts cam→AdobeRGB
			// during demosaic via output_color.  The per-channel log
			// normalization (floors/ceils stretch) handles color separation
			// and orange mask removal independently per channel, making a
			// cam→sRGB matrix unnecessary (and harmful: applying it to
			// post-H&D gamma-encoded data produces incorrect color mixing,
			// causing a magenta tint).
			//
			// Pass 1: normalization  — sourceTexture  → intermediateA
			// Pass 2: hd_curve       — intermediateA  → intermediateB
			// Pass 2.5: clahe_histogram — compute: intermediateB → claheCdfBuffer
			// Pass 2.6: clahe_remap    — fragment: intermediateB + CDF → intermediateC
			// Pass 3: tonecurve      — intermediateC (or B)  → outputTexture

			const normBuf = makeNormalizationUniforms(device, logPerc);
			const hdBuf   = makeHDCurveUniforms(device, edit.inversionParams);
			toClean.push(normBuf, hdBuf);

			// Normalization: camera-native linear → normalized log-density
			const normBG = device.createBindGroup({
				layout: normalizationPipeline.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: sampler },
					{ binding: 1, resource: sourceTexture!.createView() },
					{ binding: 2, resource: { buffer: normBuf } },
				],
			});

			drawFullscreenTriangle(encoder, normalizationPipeline, normBG, intermediateA!.createView());

			// H&D curve: normalized log-density → gamma-encoded positive transmittance
			const hdBG = device.createBindGroup({
				layout: hdCurvePipeline.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: sampler },
					{ binding: 1, resource: intermediateA!.createView() },
					{ binding: 2, resource: { buffer: hdBuf } },
				],
			});

			drawFullscreenTriangle(encoder, hdCurvePipeline, hdBG, intermediateB!.createView());

			// No color matrix in the negative path — per-channel log
			// normalization already handles color separation (matching negpy).

			// ── CLAHE passes (skip when strength is zero) ────────────────────
			const claheStrength = edit.inversionParams.claheStrength;
			if (claheStrength > 0 && claheCdfBuffer) {
				// Compute pass: build per-tile histograms + CDFs.
				const tileW = Math.ceil(w / CLAHE_TILES_X);
				const tileH = Math.ceil(h / CLAHE_TILES_Y);
				const tilePixels = tileW * tileH;
				const clipLimit = claheStrength * 2.5 * (tilePixels / CLAHE_NUM_BINS);

				// The struct has u32 fields for width/height/tiles_x/tiles_y,
				// but we pass them via a Float32Array and reinterpret as u32 in
				// the uniform buffer. Use a DataView to write the u32 fields correctly.
				const claheHistUnifData = new ArrayBuffer(32);
				const claheHistView = new DataView(claheHistUnifData);
				claheHistView.setUint32(0, w, true);          // width
				claheHistView.setUint32(4, h, true);          // height
				claheHistView.setUint32(8, CLAHE_TILES_X, true);   // tiles_x
				claheHistView.setUint32(12, CLAHE_TILES_Y, true);  // tiles_y
				claheHistView.setFloat32(16, clipLimit, true);     // clip_limit
				claheHistView.setFloat32(20, 0, true);             // _pad0
				claheHistView.setFloat32(24, 0, true);             // _pad1
				claheHistView.setFloat32(28, 0, true);             // _pad2
				const claheHistUnifBuf = device.createBuffer({
					size: 32,
					usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
				});
				device.queue.writeBuffer(claheHistUnifBuf, 0, claheHistUnifData);
				toClean.push(claheHistUnifBuf);

				const claheHistBG = device.createBindGroup({
					layout: claheHistPipeline.getBindGroupLayout(0),
					entries: [
						{ binding: 0, resource: intermediateB!.createView() },
						{ binding: 1, resource: { buffer: claheHistUnifBuf } },
						{ binding: 2, resource: { buffer: claheCdfBuffer } },
					],
				});

				const computePass = encoder.beginComputePass();
				computePass.setPipeline(claheHistPipeline);
				computePass.setBindGroup(0, claheHistBG);
				computePass.dispatchWorkgroups(CLAHE_TILES_X, CLAHE_TILES_Y, 1);
				computePass.end();

				// Remap pass: bilinear CDF interpolation + luminance remap.
				const claheRemapUnifData = new ArrayBuffer(32);
				const claheRemapView = new DataView(claheRemapUnifData);
				claheRemapView.setUint32(0, w, true);              // width
				claheRemapView.setUint32(4, h, true);              // height
				claheRemapView.setUint32(8, CLAHE_TILES_X, true);  // tiles_x
				claheRemapView.setUint32(12, CLAHE_TILES_Y, true); // tiles_y
				claheRemapView.setFloat32(16, claheStrength, true); // strength
				claheRemapView.setFloat32(20, 0, true);            // _pad0
				claheRemapView.setFloat32(24, 0, true);            // _pad1
				claheRemapView.setFloat32(28, 0, true);            // _pad2
				const claheRemapUnifBuf = device.createBuffer({
					size: 32,
					usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
				});
				device.queue.writeBuffer(claheRemapUnifBuf, 0, claheRemapUnifData);
				toClean.push(claheRemapUnifBuf);

				const claheRemapBG = device.createBindGroup({
					layout: claheRemapPipeline.getBindGroupLayout(0),
					entries: [
						{ binding: 0, resource: sampler },
						{ binding: 1, resource: intermediateB!.createView() },
						{ binding: 2, resource: { buffer: claheRemapUnifBuf } },
						{ binding: 3, resource: { buffer: claheCdfBuffer } },
					],
				});

				drawFullscreenTriangle(encoder, claheRemapPipeline, claheRemapBG, intermediateC!.createView());

				beforeToneCurve = intermediateC!.createView();
			} else {
				// CLAHE disabled — feed H&D output directly to tonecurve.
				beforeToneCurve = intermediateB!.createView();
			}
		} else {
			// ── Positive / pass-through path ──────────────────────────────────
			// Pass 1: invert      — sourceTexture  → intermediateA
			// Pass 2: colormatrix — intermediateA  → intermediateB
			// Pass 3: tonecurve   — intermediateB  → outputTexture
			const invertUniforms = new Float32Array([
				0, 0, 0, 0,                       // blackPoint rgb + pad
				1, 1, 1, 0,                       // whitePoint rgb + pad
				edit.exposureCompensation,        // exposureEV
				0.0,                              // invert flag = off
				isLinear ? 1.0 : 0.0,            // isLinear flag
				0,                                // _pad
			]);
			const invertUniformBuf = makeUniformBuffer(device, invertUniforms);
			toClean.push(invertUniformBuf);

			const invertBG = device.createBindGroup({
				layout: invertPipeline.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: sampler },
					{ binding: 1, resource: sourceTexture!.createView() },
					{ binding: 2, resource: { buffer: invertUniformBuf } },
				],
			});

			drawFullscreenTriangle(encoder, invertPipeline, invertBG, intermediateA!.createView());

			// Color matrix: cam-native → linear sRGB
			const colorMatrixBG = device.createBindGroup({
				layout: colorMatrixPipeline.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: sampler },
					{ binding: 1, resource: intermediateA!.createView() },
					{ binding: 2, resource: { buffer: colorMatrixUniformBuf } },
				],
			});

			drawFullscreenTriangle(encoder, colorMatrixPipeline, colorMatrixBG, intermediateB!.createView());

			beforeToneCurve = intermediateB!.createView();
		}

		// ── Tone curve pass → output texture (rgba16float, full precision) ──────
		// When crop is active, render to preCropTexture first, then apply crop.
		const toneCurveTarget = hasCrop ? preCropTexture! : outputTexture!;

		const toneCurveBG = device.createBindGroup({
			layout: toneCurvePipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: lutSampler },
				{ binding: 1, resource: beforeToneCurve },
				{ binding: 2, resource: { buffer: toneCurveUniformBuf } },
				{ binding: 3, resource: toneLutTex.createView({ dimension: '1d' }) },
				{ binding: 4, resource: redLutTex.createView({ dimension: '1d' }) },
				{ binding: 5, resource: greenLutTex.createView({ dimension: '1d' }) },
				{ binding: 6, resource: blueLutTex.createView({ dimension: '1d' }) },
			],
		});

		drawFullscreenTriangle(encoder, toneCurvePipeline, toneCurveBG, toneCurveTarget.createView());

		// ── Optional crop pass (perspective quad → rect) ─────────────────────
		if (hasCrop && edit.cropQuad) {
			const cropUnifBuf = makeCropUniforms(device, edit.cropQuad);
			toClean.push(cropUnifBuf);

			const cropBG = device.createBindGroup({
				layout: cropPipeline.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: sampler },
					{ binding: 1, resource: preCropTexture!.createView() },
					{ binding: 2, resource: { buffer: cropUnifBuf } },
				],
			});

			drawFullscreenTriangle(encoder, cropPipeline, cropBG, outputTexture!.createView());
		}

		// ── Dithered blit → canvas swap chain (8-bit display) ────────────────
		const blitBG = device.createBindGroup({
			layout: blitPipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: sampler },
				{ binding: 1, resource: outputTexture!.createView() },
			],
		});

		drawFullscreenTriangle(encoder, blitPipeline, blitBG, context.getCurrentTexture().createView());

		// ── Dithered blit → readback texture (rgba8unorm, COPY_SRC) ──────────
		const readbackBG = device.createBindGroup({
			layout: blitReadbackPipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: sampler },
				{ binding: 1, resource: outputTexture!.createView() },
			],
		});

		drawFullscreenTriangle(encoder, blitReadbackPipeline, readbackBG, readbackTexture!.createView());

		device.queue.submit([encoder.finish()]);
		await device.queue.onSubmittedWorkDone();

		// Clean up per-frame GPU resources
		toneLutTex.destroy();
		redLutTex.destroy();
		greenLutTex.destroy();
		blueLutTex.destroy();
		for (const buf of toClean) buf.destroy();
	}

	// ─── Helper: ensure intermediate textures exist + intermediateC for NegPy ──

	/**
	 * Rebuild intermediate textures for the pipeline at source resolution.
	 * Output textures (outputTexture, readbackTexture) are sized dynamically
	 * in runMainPasses based on crop dimensions.
	 *
	 * @param srcW - Source image width
	 * @param srcH - Source image height
	 * @param needC - Whether NegPy inversion passes are needed
	 */
	function ensureIntermediates(srcW: number, srcH: number, needC: boolean): void {
		// Processing intermediates at source resolution
		intermediateA?.destroy();
		intermediateB?.destroy();
		intermediateA = createRGBA16Texture(device, srcW, srcH);
		intermediateB = createRGBA16Texture(device, srcW, srcH);
		if (needC) {
			intermediateC?.destroy();
			intermediateC = createRGBA16Texture(device, srcW, srcH);
			// CLAHE needs intermediateD (remap output) + CDF storage buffer.
			intermediateD?.destroy();
			intermediateD = createRGBA16Texture(device, srcW, srcH);
			claheCdfBuffer?.destroy();
			const cdfSize = CLAHE_TILES_X * CLAHE_TILES_Y * CLAHE_NUM_BINS * 4; // f32
			claheCdfBuffer = device.createBuffer({
				size: cdfSize,
				usage: GPUBufferUsage.STORAGE,
			});
		}
		// Pre-crop texture at source resolution (tone curve renders here when crop is active)
		preCropTexture?.destroy();
		preCropTexture = device.createTexture({
			size: [srcW, srcH],
			format: 'rgba16float',
			usage:
				GPUTextureUsage.RENDER_ATTACHMENT |
				GPUTextureUsage.TEXTURE_BINDING,
		});
		// Reset output dimensions tracking so runMainPasses rebuilds output textures
		lastOutputWidth = 0;
		lastOutputHeight = 0;
	}

	// ─────────────────────────────────────────────────────────────────────────

	async function render(edit: EffectiveEdit, bitmap: ImageBitmap): Promise<void> {
		const w = bitmap.width;
		const h = bitmap.height;

		// Re-upload source texture only when the bitmap changes
		if (bitmap !== lastBitmap) {
			sourceTexture?.destroy();
			sourceTexture = device.createTexture({
				size: [w, h],
				format: 'rgba8unorm',
				usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
			});
			device.queue.copyExternalImageToTexture(
				{ source: bitmap },
				{ texture: sourceTexture },
				[w, h],
			);
			lastBitmap = bitmap;
			ensureIntermediates(w, h, true);
		}

		// Compute log percentiles for the NegPy normalization pass.
		// No color matrix applied — percentiles operate on camera-native data,
		// matching negpy where rawpy delivers already-converted RGB and
		// normalization works directly on those values.
		let logPerc: LogPercentiles | null = null;
		if (edit.invert) {
			const f32 = await bitmapToF32Pixels(bitmap);
			logPerc = computeLogPercentilesFromF32(f32, w, h, 8);
		}

		await runMainPasses(edit, w, h, false, logPerc);
	}

	// ─── RAW render path ──────────────────────────────────────────────────────

	async function renderRaw(edit: EffectiveEdit, rawBuffer: ArrayBuffer, logPercOverride?: LogPercentiles): Promise<void> {
		const { width: w, height: h, pixels } = parseRawDecodeBuffer(rawBuffer);

		// Compute log percentiles for the NegPy normalization pass.
		// Always recompute when invert is on; cache the result so the export
		// render (which uses a higher-res buffer with different pixel statistics)
		// can reuse the percentiles from the preview render, keeping colours
		// consistent between what the user sees and the exported file.
		// No color matrix applied — percentiles operate on camera-native data,
		// matching negpy where normalization runs on raw linear RGB directly.
		let logPerc: LogPercentiles | null = null;
		if (edit.invert) {
			if (logPercOverride) {
				logPerc = logPercOverride;
			} else {
				logPerc = computeLogPercentilesFromU16(pixels, w, h, 8);
				lastLogPerc = logPerc;
			}
		} else {
			lastLogPerc = null;
		}

		// Push error scopes to surface any WebGPU validation/OOM errors.
		device.pushErrorScope('validation');
		device.pushErrorScope('out-of-memory');

		// Upload u16 pixel data as rgba16uint texture.
		const rawTexture = device.createTexture({
			size: [w, h],
			format: 'rgba16uint',
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
		});
		// Each pixel is 4 × u16 = 8 bytes; bytesPerRow must be aligned to 256.
		const bytesPerRow = Math.ceil((w * 8) / 256) * 256;
		let uploadData: Uint8Array<ArrayBuffer>;
		if (bytesPerRow === w * 8) {
			const buf = new ArrayBuffer(pixels.byteLength);
			new Uint8Array(buf).set(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
			uploadData = new Uint8Array(buf);
		} else {
			const buf = new ArrayBuffer(bytesPerRow * h);
			uploadData = new Uint8Array(buf);
			const srcRow = w * 8;
			for (let row = 0; row < h; row++) {
				uploadData.set(
					new Uint8Array(pixels.buffer, pixels.byteOffset + row * srcRow, srcRow),
					row * bytesPerRow,
				);
			}
		}

		device.queue.writeTexture(
			{ texture: rawTexture },
			uploadData,
			{ bytesPerRow, rowsPerImage: h },
			[w, h],
		);

		// ── Ingest pass: rgba16uint → rgba16float ────────────────────────────
		const ingestedTexture = device.createTexture({
			size: [w, h],
			format: 'rgba16float',
			usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
		});

		const ingestBG = device.createBindGroup({
			layout: ingestRawPipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: rawTexture.createView() },
			],
		});

		const ingestEncoder = device.createCommandEncoder();
		drawFullscreenTriangle(ingestEncoder, ingestRawPipeline, ingestBG, ingestedTexture.createView());
		device.queue.submit([ingestEncoder.finish()]);

		// ── Swap sourceTexture + intermediates for the main passes ────────────
		sourceTexture?.destroy();
		sourceTexture = ingestedTexture;
		ensureIntermediates(w, h, true);

		// Invalidate lastBitmap so next JPEG render re-uploads.
		lastBitmap = null;

		await runMainPasses(edit, w, h, true, logPerc);

		rawTexture.destroy();

		// Surface any GPU errors captured during this render.
		const oomErr = await device.popErrorScope();
		const valErr = await device.popErrorScope();
		if (oomErr) console.error('[raw] WebGPU OOM error:', oomErr.message);
		if (valErr) console.error('[raw] WebGPU validation error:', valErr.message);
		if (oomErr || valErr) {
			throw new Error(`WebGPU error: ${(valErr ?? oomErr)!.message}`);
		}
	}

	function destroy(): void {
		sourceTexture?.destroy();
		intermediateA?.destroy();
		intermediateB?.destroy();
		intermediateC?.destroy();
		intermediateD?.destroy();
		claheCdfBuffer?.destroy();
		outputTexture?.destroy();
		preCropTexture?.destroy();
		readbackTexture?.destroy();
		device.destroy();
	}

	/**
	 * Copy a rectangle of pixels from the dithered readback texture back to CPU.
	 * Returns null if no render has completed yet or the region is invalid.
	 */
	async function readPixels(x: number, y: number, w: number, h: number): Promise<Uint8ClampedArray | null> {
		if (!readbackTexture || w <= 0 || h <= 0) return null;

		// rgba8unorm: 4 bytes per pixel.
		// GPU buffer bytesPerRow must be aligned to 256.
		const bytesPerPixel = 4;
		const unpaddedBytesPerRow = w * bytesPerPixel;
		const paddedBytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
		const bufferSize = paddedBytesPerRow * h;

		const readbackBuf = device.createBuffer({
			size: bufferSize,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
		});

		const encoder = device.createCommandEncoder();
		encoder.copyTextureToBuffer(
			{ texture: readbackTexture!, origin: { x, y, z: 0 } },
			{ buffer: readbackBuf, bytesPerRow: paddedBytesPerRow, rowsPerImage: h },
			{ width: w, height: h, depthOrArrayLayers: 1 },
		);
		device.queue.submit([encoder.finish()]);
		await readbackBuf.mapAsync(GPUMapMode.READ);

		const mapped = readbackBuf.getMappedRange();
		const result = new Uint8ClampedArray(w * h * bytesPerPixel);

		// Strip row padding when copying out.
		for (let row = 0; row < h; row++) {
			const src = new Uint8ClampedArray(mapped, row * paddedBytesPerRow, unpaddedBytesPerRow);
			result.set(src, row * unpaddedBytesPerRow);
		}

		readbackBuf.unmap();
		readbackBuf.destroy();
		return result;
	}

	return {
		render,
		renderRaw,
		readPixels,
		destroy,
		maxTextureDimension,
		get lastLogPerc() { return lastLogPerc; },
		get lastOutputWidth() { return lastOutputWidth; },
		get lastOutputHeight() { return lastOutputHeight; },
	};
}
