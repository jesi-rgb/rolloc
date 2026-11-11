/**
 * WebGPU render pipeline for film negative inversion.
 *
 * Positive (invert = false) — 3-pass pipeline:
 *   Pass 0 (ingest_raw)   — rgba16uint linear → rgba16float  [RAW path only]
 *   Pass 1 (invert)       — normalize + pass-through + exposure (camera native linear)
 *   Pass 2 (colormatrix)  — 3×3 camera-to-sRGB colour matrix
 *   Pass 3 (tonecurve)    — white balance + RGB curves + global tone curve + γ encode
 *
 * Negative (invert = true) — print pipeline ported from NegPy (no camera colour matrix):
 *   Pass 0 (ingest_raw)     — rgba16uint linear → rgba16float  [RAW path only]
 *   Pass 1 (normalization)  — log10 conversion + per-channel stretch between the
 *                             measured density bounds, on camera-native data (the
 *                             stretch removes the orange mask and inverts)
 *   Pass 2 (hd_curve)       — print curve: CMY filtration + straight line between a
 *                             shoulder and a toe, then the tone stage; outputs
 *                             gamma-encoded transmittance
 *   Pass 2.5 (clahe)        — optional CLAHE local contrast enhancement
 *   Pass 3 (tonecurve)      — RGB curves + global tone curve (no sRGB γ)
 *
 * Slide (invert = true, film type E6) — the same passes with the transparency
 * transfer in place of the print: the normalization applies the camera matrix
 * (RAW only) and the transfer's fixed window, hd_curve runs the transfer.
 *
 * The bounds, meters and curve solve live in ./negative/ and are mirrored by
 * src-tauri/src/negative/ for the native export and thumbnails.
 *
 * Usage:
 *   const gpu = await createPipeline(canvas);
 *   await gpu.render(effectiveEdit, imageBitmap);      // JPEG/TIFF source
 *   await gpu.renderRaw(effectiveEdit, rawBuffer);     // RAW source (from raw_decode)
 *   gpu.destroy();          // free GPU resources
 */

import invertWGSL from './shaders/invert.wgsl?raw';
import colorMatrixWGSL from './shaders/colormatrix.wgsl?raw';
import toneCurveWGSL from './shaders/tonecurve.wgsl?raw';
import ingestRawWGSL from './shaders/ingest_raw.wgsl?raw';
import normalizationWGSL from './shaders/normalization.wgsl?raw';
import hdCurveWGSL from './shaders/hd_curve.wgsl?raw';
import glowWGSL from './shaders/glow.wgsl?raw';
import downsampleWGSL from './shaders/downsample.wgsl?raw';
import glowBlendWGSL from './shaders/glow_blend.wgsl?raw';
import claheHistogramWGSL from './shaders/clahe_histogram.wgsl?raw';
import claheRemapWGSL from './shaders/clahe_remap.wgsl?raw';
import sharpenWGSL from './shaders/sharpen.wgsl?raw';
import blitWGSL from './shaders/blit.wgsl?raw';
import cropWGSL from './shaders/crop.wgsl?raw';
import transformWGSL from './shaders/transform.wgsl?raw';
import borderWGSL from './shaders/border.wgsl?raw';
import outputHistogramWGSL from './shaders/output_histogram.wgsl?raw';
import { buildCurveLUTs } from './curves';
import { rotationCoverZoom } from './geometry';
import { analyzeNegative } from './negative/analysis';
import type { AnalysisResult, ChannelHistograms } from './negative/analysis';
import type { LinearSource } from './negative/grid';
import type { RgbCounts } from './histogram';
import {
	borderPixelsForContent,
	computeCropHomography,
	computeCropOutputDimensions,
	sampleSourceLogAt,
} from './negative/pick-geometry';
import type { PickGeometry } from './negative/pick-geometry';
import { packPrintCurveUniforms } from './negative/print-curve';
import type { ToneStageParams } from './negative/print-curve';
import { solvePrintCurve } from './negative/solve';
import { slideCameraMatrix } from './negative/transfer';
import type {
	BorderColor,
	CropQuad,
	EffectiveEdit,
	FilmType,
	InversionParams,
	LogBounds,
	Matrix3x3,
	NegativeAnalysis,
	TransformParams,
	Vec3,
} from '$lib/types';
import { TONE_PRESETS } from '$lib/types';
import { DEFAULT_TRANSFORM } from '$lib/types';

// ─── Tone stage constants ──────────────────────────────────────────────────────

/**
 * Neutral `density` / `grade` values. The Brightness and Contrast sliders are
 * stored in these two fields and drive the Lightroom-style tone stage
 * (exposure in EV, contrast S-curve), never the print curve, whose slope and
 * pivot are metered per frame (src/lib/image/negative/). Mirrored by
 * NEUTRAL_DENSITY / NEUTRAL_GRADE in src-tauri/src/process.rs.
 */
const NEUTRAL_DENSITY = 1.0;
const NEUTRAL_GRADE = 2.5;
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
	const r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
	const g = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
	const b = 0.0557 * X - 0.2040 * Y + 1.0570 * Z;

	// Normalise so that green channel (most stable) is 1.0
	const gNorm = g > 0 ? g : 1;
	const tintFactor = Math.pow(2, tint / 100);

	return [
		Math.max(0.01, r / gNorm),
		Math.max(0.01, 1.0 / tintFactor),
		Math.max(0.01, b / gNorm),
	];
}

/**
 * Long-edge cap, in pixels, for the resolution the editor *works* at.
 *
 * Every pass in the chain runs at this resolution on every render, so it sets
 * the interactive frame rate: cost scales with the pixel count, i.e. with the
 * square of this number.  A 26 MP frame at full resolution is ~4× the work of
 * 3072 px, and a 40 MP X-Trans frame is ~7×.
 *
 * Downscaling is only safe because it happens *after* a full-resolution
 * demosaic and uses an area average (`raw.rs`) or Lanczos3 (`decode.rs`).
 * Reaching a small image by demosaicking cheaply, or by point-sampling, is what
 * made the preview look crunchy — the resolution was never the problem.
 */
export const PREVIEW_MAX_PX = 2072;

/** Cached adapter limit, so repeat callers do not re-request an adapter. */
let _gpuMaxTextureDimension: number | null = null;

/**
 * The long-edge cap the editor actually decodes at: `PREVIEW_MAX_PX`, lowered
 * to the GPU's texture limit on devices that cannot hold that much.
 *
 * Callers that have a live pipeline should use its `maxTextureDimension`; this
 * exists for the ones that do not (the roll grid's background decode sweep),
 * which must arrive at the *same* number or every frame it warms would be
 * cached under a key the editor never asks for.
 */
export async function previewMaxPx(): Promise<number> {
	if (_gpuMaxTextureDimension === null) {
		try {
			const adapter = await navigator.gpu?.requestAdapter();
			_gpuMaxTextureDimension = adapter?.limits.maxTextureDimension2D ?? PREVIEW_MAX_PX;
		} catch {
			_gpuMaxTextureDimension = PREVIEW_MAX_PX;
		}
	}
	return Math.min(_gpuMaxTextureDimension, PREVIEW_MAX_PX);
}

// ─── sRGB source helpers ──────────────────────────────────────────────────────

/**
 * 256-entry sRGB→linear lookup table, keyed on the 8-bit sample value.
 *
 * Mirrors `srgb_to_linear` in `normalization.wgsl` / `invert.wgsl` and
 * `export.rs`, so the CPU-side source snapshot, the GPU preview and the
 * native export all operate on the same linear-light values.
 */
const SRGB_TO_LINEAR_LUT: Float32Array = (() => {
	const lut = new Float32Array(256);
	for (let i = 0; i < 256; i++) {
		const c = i / 255;
		lut[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
	}
	return lut;
})();

/**
 * Convert an 8-bit sRGB RGBA buffer to linear-light f32. The alpha channel is
 * expanded too — nothing reads it, so the extra work is not worth a branch
 * per sample.
 */
function srgbU8ToLinearF32(src: Uint8ClampedArray | Uint8Array): Float32Array {
	const out = new Float32Array(src.length);
	for (let i = 0; i < src.length; i++) {
		out[i] = SRGB_TO_LINEAR_LUT[src[i]];
	}
	return out;
}

/**
 * Read the pixels of an `ImageBitmap` to a linear-light RGBA Float32Array via
 * OffscreenCanvas. The negative analysis and the WB picker both read this
 * snapshot, so they see the same linear values the normalization shader
 * produces when it gamma-expands (`srgbExpand = 1`).
 */
async function bitmapToF32Pixels(bitmap: ImageBitmap): Promise<Float32Array> {
	const oc = new OffscreenCanvas(bitmap.width, bitmap.height);
	const ctx = oc.getContext('2d');
	if (!ctx) throw new Error('Could not create OffscreenCanvas 2D context');
	ctx.drawImage(bitmap, 0, 0);
	const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
	return srgbU8ToLinearF32(data.data);
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
	const width = view.getUint32(0, true);
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

/** Parsed result from the `decode_image_rgba` Tauri command. */
export interface DecodeImageRgbResult {
	width: number;
	height: number;
	/** Uint8ClampedArray view of the RGBA pixel data (length = width * height * 4). */
	pixels: Uint8ClampedArray;
}

/**
 * Parse the binary payload returned by the `decode_image_rgba` Tauri command.
 *
 * Layout:
 *   [0..4]   width  : u32 LE
 *   [4..8]   height : u32 LE
 *   [8 .. ]  RGBA u8 bytes
 */
export function parseDecodeImageRgbBuffer(buffer: ArrayBuffer): DecodeImageRgbResult {
	const view = new DataView(buffer);
	const width = view.getUint32(0, true);
	const height = view.getUint32(4, true);
	const pixelsOffset = 8;
	const pixels = new Uint8ClampedArray(buffer, pixelsOffset, width * height * 4);
	return { width, height, pixels };
}

export interface GpuPipeline {
	/**
	 * Re-render the canvas from a JPEG/TIFF source (ImageBitmap, sRGB-encoded).
	 */
	render(edit: EffectiveEdit, bitmap: ImageBitmap): Promise<void>;
	/**
	 * Re-render the canvas from a decoded-image RGBA8 buffer returned by the
	 * `decode_image_rgba` Tauri command. This avoids the lossy cached JPEG
	 * preview and renders straight from the original file.
	 */
	renderDecodedRgba(edit: EffectiveEdit, rgbaBuffer: ArrayBuffer): Promise<void>;
	/**
	 * Re-render the canvas from a RAW linear source.
	 * `rawBuffer` is the ArrayBuffer returned by the `raw_decode` Tauri command.
	 */
	renderRaw(edit: EffectiveEdit, rawBuffer: ArrayBuffer): Promise<void>;
	/**
	 * Read back a rectangle of sRGB pixels from the last rendered output.
	 * Returns `null` if no render has completed yet or if the region is out of bounds.
	 * The returned array has length `w * h * 4` (RGBA, 0–255).
	 */
	readPixels(x: number, y: number, w: number, h: number): Promise<Uint8ClampedArray | null>;
	/**
	 * Mean per-channel log10 density of the resident source around the point
	 * displayed at `(nx, ny)` (normalized over the whole displayed output, matte
	 * included), read through the last render's geometry. The WB picker's
	 * sample; normalize it with `lastBounds`. Null on the matte, outside the
	 * image, or when no CPU-side source is resident.
	 */
	sampleSourceLog(nx: number, ny: number): Vec3 | null;
	/** Release all GPU resources. Call when the editor unmounts. */
	destroy(): void;
	/**
	 * The device's `maxTextureDimension2D` limit.
	 * Pass this as `maxPx` to the `raw_decode` Tauri command so Rust can
	 * downsample images that would exceed the GPU texture size limit before
	 * sending data over IPC.
	 */
	maxTextureDimension: number;
	/**
	 * The analysis of the negative from the last render (the frame's own
	 * measurements — persist this for the exporter), or null when the last
	 * render was not a negative.
	 */
	lastAnalysis: NegativeAnalysis | null;
	/** The bounds the last negative render normalized with (roll baseline applied). */
	lastBounds: LogBounds | null;
	/** Histograms of the last negative render's normalized source, for the curves editor. */
	lastHistograms: ChannelHistograms | null;
	/**
	 * 256-bin R/G/B counts of the last render's displayed content (after tone
	 * curve, rotation and crop; matte excluded), counted on the GPU.
	 */
	lastOutputHistogram: RgbCounts | null;
	/**
	 * The output dimensions from the last render (after crop is applied).
	 * Use these for readPixels() after rendering to get the correct cropped size.
	 */
	lastOutputWidth: number;
	lastOutputHeight: number;
	/**
	 * Tell the pipeline how much space (in CSS pixels) the canvas may occupy
	 * on screen. The swap chain is sized to fit this box (times the device
	 * pixel ratio) instead of the full image resolution, and the blit pass
	 * box-filters the difference.
	 *
	 * Without this the browser composites a full-resolution canvas down to the
	 * viewport with a single bilinear tap, which aliases heavily and makes the
	 * preview look far harsher than the exported file.
	 *
	 * Pass `0, 0` to disable and render the swap chain at full resolution.
	 */
	setDisplayBox(cssWidth: number, cssHeight: number): void;
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

// ─── Negative uniform builders ────────────────────────────────────────────────

/**
 * Build the normalization pass uniform buffer (layout in normalization.wgsl).
 *
 * @param srgbExpand   - true for sRGB-encoded sources (JPEG/TIFF preview), false
 *                       for the RAW path whose data is already scene-linear.
 * @param sourceMatrix - linear-light matrix applied before the log (a RAW slide's
 *                       camera matrix); null for the identity.
 */
function makeNormalizationUniforms(
	device: GPUDevice,
	bounds: LogBounds,
	srgbExpand: boolean,
	sourceMatrix: Matrix3x3 | null,
): GPUBuffer {
	// Row-major source → WGSL columns: col0 = [m00, m10, m20], …
	const m = sourceMatrix ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
	return makeUniformBuffer(device, new Float32Array([
		bounds.floors[0], bounds.floors[1], bounds.floors[2], 0,
		bounds.ceils[0], bounds.ceils[1], bounds.ceils[2], 0,
		m[0], m[3], m[6], 0,
		m[1], m[4], m[7], 0,
		m[2], m[5], m[8], 0,
		srgbExpand ? 1 : 0, 0, 0, 0,
	]));
}

/**
 * The linear-light matrix a render applies before the log: a RAW slide's camera
 * matrix with the as-shot white balance folded back in (the inversion path always
 * decodes RAW without it: every `raw_decode` / `export_native` call passes
 * `skipWb: rollEdit.invert`). Negatives and display-referred slides use none.
 */
function sourceMatrixFor(edit: EffectiveEdit, isLinear: boolean): Matrix3x3 | null {
	return edit.invert && isLinear && edit.inversionParams.filmType === 'E6'
		? slideCameraMatrix(edit.cameraColorMatrix, edit.ashotWBCoeffs)
		: null;
}

/**
 * The post-curve tone stage of hd_curve.wgsl. Brightness is stored inverted
 * (higher density = darker), so exposure in EV stops is the offset from
 * neutral; Contrast maps the 0–5 grade domain onto [-1, +1] with the neutral
 * grade at 0. Mirrored by `ToneParams::from_inversion` in process.rs.
 */
function toneStageParams(inv: InversionParams): ToneStageParams {
	const preset = TONE_PRESETS[inv.tonePreset];
	return {
		exposure: NEUTRAL_DENSITY - inv.density,
		contrast: Math.max(-1, Math.min(1, (inv.grade - NEUTRAL_GRADE) / NEUTRAL_GRADE)),
		shadows: Math.max(-1, Math.min(1, inv.shadows)),
		highlights: Math.max(-1, Math.min(1, inv.highlights)),
		vibrance: inv.vibrance,
		saturation: inv.saturation,
		toneGamma: preset.gamma,
		blackPoint: preset.blackPoint,
		whitePoint: preset.whitePoint,
		midtoneCurve: preset.midtoneCurve,
	};
}

// ─── Glow uniform builder ─────────────────────────────────────────────────────

/**
 * Build the glow-blend pass uniform buffer.
 *
 * GlowBlendUniforms layout (total 16 bytes):
 *   glow_amount : f32  @ 0
 *   _pad0       : f32  @ 4
 *   _pad1       : f32  @ 8
 *   _pad2       : f32  @ 12
 */
function makeGlowUniforms(device: GPUDevice, glowAmount: number): GPUBuffer {
	const data = new Float32Array([glowAmount, 0, 0, 0]);
	return makeUniformBuffer(device, data);
}

/**
 * Build the glow-extract pass uniform buffer.
 *
 * GlowUniforms layout (total 16 bytes):
 *   sample_radius : f32  @ 0   — Fibonacci spiral radius, in downsampled pixels
 *   _pad0 .. _pad2 : f32
 *
 * The radius is scaled by the image's size relative to the reference preview
 * size so that the bloom covers a consistent fraction of the image at any
 * resolution (native export, lightbox preview, etc.).
 */
function makeGlowExtractUniforms(device: GPUDevice, sampleRadius: number): GPUBuffer {
	const data = new Float32Array([sampleRadius, 0, 0, 0]);
	return makeUniformBuffer(device, data);
}

/**
 * Reference image long-edge used to scale the glow sample radius. Matches
 * `PREVIEW_SIZE` in `src/lib/image/thumbgen.ts` (the lightbox pre-render
 * dimension at which the current 5-pixel spiral radius was tuned).
 */
const GLOW_REFERENCE_SIZE = 1200;

/**
 * Base Fibonacci-spiral sample radius (in downsampled pixels) at the
 * reference image size. This is what the shader used to hard-code.
 */
const GLOW_BASE_SAMPLE_RADIUS = 5;

/**
 * Clamp on the scaled radius. At 64 taps, the tap spacing becomes visibly
 * sparse past this value (taps start to "splotch"), and the extra reach
 * stops mattering visually.
 */
const GLOW_MAX_SAMPLE_RADIUS = 40;

/**
 * Compute the glow sample radius for an image of the given full-res dimensions.
 * Used by both the preview pipeline and the native export (in Rust) so they
 * produce identical bloom.
 */
function glowSampleRadiusForImage(width: number, height: number): number {
	const scale = Math.max(width, height) / GLOW_REFERENCE_SIZE;
	return Math.min(GLOW_BASE_SAMPLE_RADIUS * scale, GLOW_MAX_SAMPLE_RADIUS);
}

/**
 * Check if the GPU transform (rotation, zoom) is effectively a no-op.
 * Note: Flips are not considered here since they're handled via CSS.
 */
function isIdentityTransform(t: TransformParams): boolean {
	const zoom = t.zoom ?? 1;
	return Math.abs(t.rotation) < 0.001 && Math.abs(zoom - 1) < 0.001;
}

// ─── Border (matting) helpers ──────────────────────────────────────────────────

/**
 * Build the border pass uniform buffer.
 *
 * BorderUniforms layout (total 32 bytes):
 *   innerScale  : vec2<f32>  @ 0   (contentW/finalW, contentH/finalH)
 *   innerOffset : vec2<f32>  @ 8   (bp/finalW,       bp/finalH)
 *   color       : vec4<f32>  @ 16  (rgb solid matting colour + pad)
 */
function makeBorderUniforms(
	device: GPUDevice,
	contentW: number,
	contentH: number,
	finalW: number,
	finalH: number,
	color: BorderColor,
): GPUBuffer {
	const bpX = (finalW - contentW) / 2;
	const bpY = (finalH - contentH) / 2;
	const c = color === 'white' ? 1 : 0;
	const data = new Float32Array([
		contentW / finalW, contentH / finalH,   // innerScale
		bpX / finalW, bpY / finalH,         // innerOffset
		c, c, c, 1,                              // color
	]);
	return makeUniformBuffer(device, data);
}

/**
 * Build the crop pass uniform buffer.
 *
 * CropUniforms layout (total 32 bytes):
 *   h0 : vec4<f32>  @ 0   (a, b, c, d)
 *   h1 : vec4<f32>  @ 16  (e, f, g, h)
 */
function makeCropUniforms(device: GPUDevice, quad: CropQuad): GPUBuffer {
	const [a, b, c, d, e, f, g, h] = computeCropHomography(quad);
	const data = new Float32Array([a, b, c, d, e, f, g, h]);
	return makeUniformBuffer(device, data);
}

/**
 * Build the transform pass uniform buffer.
 *
 * TransformUniforms layout (total 16 bytes):
 *   rotation     : f32   @ 0   (radians)
 *   sourceAspect : f32   @ 4   (width/height of source texture)
 *   zoom         : f32   @ 8   (user zoom × rotation cover zoom; 1.0 = none)
 *   outputAspect : f32   @ 12  (width/height of output texture)
 */
function makeTransformUniforms(device: GPUDevice, t: TransformParams, sourceAspect: number, outputAspect: number): GPUBuffer {
	const data = new Float32Array([
		(t.rotation * Math.PI) / 180, // Convert degrees to radians
		sourceAspect,                  // Source texture aspect ratio
		// User zoom on top of the zoom that keeps rotated corners filled.
		(t.zoom ?? 1) * rotationCoverZoom(t.rotation, sourceAspect),
		outputAspect,                  // Output texture aspect ratio
	]);
	return makeUniformBuffer(device, data);
}

/**
 * Check if the rotation results in a dimension swap (portrait↔landscape).
 * This is true when the nearest 90° step is an odd multiple (90° or 270°).
 * Fine rotation adjustments (±45°) don't change the swap state.
 */
function isRotation90Multiple(rotation: number): boolean {
	const nearest90 = Math.round(rotation / 90);
	// Odd multiples of 90° (1, 3, 5, -1, -3, ...) swap dimensions
	return ((nearest90 % 2) + 2) % 2 === 1;
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

	// ── Display (swap chain) sizing ─────────────────────────────────────────

	/** Available on-screen space for the canvas, in CSS pixels. 0 = unknown. */
	let displayBoxW = 0;
	let displayBoxH = 0;
	/** Current swap chain dimensions, so we only reconfigure on change. */
	let canvasW = 0;
	let canvasH = 0;

	/**
	 * Size the swap chain so the image fits the display box at device
	 * resolution, preserving the aspect ratio of the `finalW × finalH` output.
	 * Never upscales beyond the processed resolution. Falls back to full
	 * resolution when the display box is unknown.
	 */
	function syncCanvasSize(finalW: number, finalH: number): void {
		let targetW = finalW;
		let targetH = finalH;

		if (displayBoxW > 0 && displayBoxH > 0) {
			const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
			const boxW = displayBoxW * dpr;
			const boxH = displayBoxH * dpr;
			// `min(…, 1)` keeps us from rendering more pixels than we processed.
			const scale = Math.min(boxW / finalW, boxH / finalH, 1);
			targetW = Math.max(1, Math.round(finalW * scale));
			targetH = Math.max(1, Math.round(finalH * scale));
		}

		if (targetW === canvasW && targetH === canvasH) return;

		canvas.width = targetW;
		canvas.height = targetH;
		canvasW = targetW;
		canvasH = targetH;
		context.configure({ device, format: presentationFormat, alphaMode: 'opaque' });
	}

	// ── Compile shader modules ──────────────────────────────────────────────

	const ingestRawModule = device.createShaderModule({ code: ingestRawWGSL });
	const invertModule = device.createShaderModule({ code: invertWGSL });
	const normalizationModule = device.createShaderModule({ code: normalizationWGSL });
	const hdCurveModule = device.createShaderModule({ code: hdCurveWGSL });
	const glowModule = device.createShaderModule({ code: glowWGSL });
	const downsampleModule = device.createShaderModule({ code: downsampleWGSL });
	const glowBlendModule = device.createShaderModule({ code: glowBlendWGSL });
	const claheHistModule = device.createShaderModule({ code: claheHistogramWGSL });
	const claheRemapModule = device.createShaderModule({ code: claheRemapWGSL });
	const sharpenModule = device.createShaderModule({ code: sharpenWGSL });
	const colorMatrixModule = device.createShaderModule({ code: colorMatrixWGSL });
	const toneCurveModule = device.createShaderModule({ code: toneCurveWGSL });
	const blitModule = device.createShaderModule({ code: blitWGSL });
	const cropModule = device.createShaderModule({ code: cropWGSL });

	// ── Build render pipelines ──────────────────────────────────────────────

	function makeRenderPipeline(module: GPUShaderModule, format: GPUTextureFormat): GPURenderPipeline {
		return device.createRenderPipeline({
			layout: 'auto',
			vertex: { module, entryPoint: 'vs_main' },
			fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
			primitive: { topology: 'triangle-list' },
		});
	}

	const ingestRawPipeline = makeRenderPipeline(ingestRawModule, 'rgba16float');
	const invertPipeline = makeRenderPipeline(invertModule, 'rgba16float');
	const normalizationPipeline = makeRenderPipeline(normalizationModule, 'rgba16float');
	const hdCurvePipeline = makeRenderPipeline(hdCurveModule, 'rgba16float');
	const glowPipeline = makeRenderPipeline(glowModule, 'rgba16float');
	const downsamplePipeline = makeRenderPipeline(downsampleModule, 'rgba16float');
	const glowBlendPipeline = makeRenderPipeline(glowBlendModule, 'rgba16float');
	const colorMatrixPipeline = makeRenderPipeline(colorMatrixModule, 'rgba16float');
	/**
	 * Tone curve renders to `rgba16float` for maximum precision.
	 * A blit pass with ordered dithering then converts to the 8-bit swap chain,
	 * and a separate readback copy quantises to `rgba8unorm` with dithering.
	 */
	const toneCurvePipeline = makeRenderPipeline(toneCurveModule, 'rgba16float');
	const blitPipeline = makeRenderPipeline(blitModule, presentationFormat);
	/** Blit pipeline targeting rgba8unorm for the readback texture. */
	const blitReadbackPipeline = makeRenderPipeline(blitModule, 'rgba8unorm');

	// ── CLAHE pipelines ────────────────────────────────────────────────────

	/** CLAHE remap fragment pipeline (fullscreen triangle). */
	const claheRemapPipeline = makeRenderPipeline(claheRemapModule, 'rgba16float');

	/** Sharpening (unsharp mask on luminance) pipeline. */
	const sharpenPipeline = makeRenderPipeline(sharpenModule, 'rgba16float');

	/**
	 * CLAHE histogram compute pipeline.
	 * Bind group layout: @binding(0) texture_2d<f32>, @binding(1) uniform, @binding(2) storage rw.
	 */
	const claheHistPipeline = device.createComputePipeline({
		layout: 'auto',
		compute: { module: claheHistModule, entryPoint: 'main' },
	});

	/** Output histogram compute pipeline (content texture → `outputHistBuffer`). */
	const outputHistPipeline = device.createComputePipeline({
		layout: 'auto',
		compute: { module: device.createShaderModule({ code: outputHistogramWGSL }), entryPoint: 'main' },
	});
	/** Rows per output-histogram workgroup (must match ROWS_PER_GROUP in the WGSL). */
	const OUTPUT_HIST_ROWS = 16;
	/** R, G, B × 256 u32 counts. */
	const OUTPUT_HIST_BYTES = 3 * 256 * 4;
	/**
	 * Persistent storage for the output histogram counts. Overlapping renders
	 * share it safely: each encodes clear → count → copy in one command buffer,
	 * and the queue runs command buffers in submission order.
	 */
	const outputHistBuffer = device.createBuffer({
		size: OUTPUT_HIST_BYTES,
		usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
	});
	let lastOutputHistogram: RgbCounts | null = null;

	// ── Crop pipeline (perspective quad → rect) ───────────────────────────────

	/**
	 * Crop pipeline applies perspective correction by sampling from a quadrilateral
	 * region of the source and mapping it to the output rectangle.
	 */
	const cropPipeline = makeRenderPipeline(cropModule, 'rgba16float');

	// ── Transform pipeline (rotation + flip) ──────────────────────────────────

	/**
	 * Transform pipeline applies rotation (UV-based, any angle).
	 * Flips are handled via CSS on the canvas element.
	 */
	const transformModule = device.createShaderModule({ code: transformWGSL });
	const transformPipeline = makeRenderPipeline(transformModule, 'rgba16float');

	// ── Border pipeline (matting frame around content) ────────────────────────

	/**
	 * Border pass composites the rendered content (smaller) into a larger output
	 * texture, filling the surrounding matte with a solid colour. Renders to the
	 * final, bordered-size output texture.
	 */
	const borderModule = device.createShaderModule({ code: borderWGSL });
	const borderPipeline = makeRenderPipeline(borderModule, 'rgba16float');

	// ── Mutable resources (rebuilt per render when image changes) ────────────

	let lastBitmap: ImageBitmap | null = null;
	/**
	 * Source buffers whose GPU upload is still resident in `sourceTexture`.
	 *
	 * Uploading is by far the most expensive part of a render on the RAW path
	 * (a 26 MP frame is a 207 MB `rgba16uint` copy plus an ingest pass plus a
	 * full rebuild of every intermediate).  None of it depends on the edit
	 * parameters, so re-doing it on every slider tick is what pinned the
	 * editor at ~1 fps.  Identity comparison is enough: the decode buffers are
	 * immutable and replaced wholesale on frame navigation.
	 */
	let lastRawBuffer: ArrayBuffer | null = null;
	let lastDecodedBuffer: ArrayBuffer | null = null;
	let sourceTexture: GPUTexture | null = null;
	let intermediateA: GPUTexture | null = null;
	let intermediateB: GPUTexture | null = null;
	/** Third intermediate needed for the 5-pass NegPy invert path. */
	let intermediateC: GPUTexture | null = null;
	/** Fourth intermediate: CLAHE remap output (between H&D curve and tonecurve). */
	let intermediateD: GPUTexture | null = null;
	/** Fifth intermediate: glow blend output (full resolution). */
	let intermediateE: GPUTexture | null = null;
	/** Downsampled texture for glow (1/4 resolution). */
	let glowDownsampleTex: GPUTexture | null = null;
	/** Glow blur output (1/4 resolution). */
	let glowBlurTex: GPUTexture | null = null;
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
	 * Content texture for the border (matting) pass (rgba16float).
	 * When a border is active, the final content stage renders here at content
	 * size, then the border pass composites it into the larger `outputTexture`.
	 * When no border is active this stays null and content renders straight to
	 * `outputTexture`.
	 */
	let contentTexture: GPUTexture | null = null;
	/** Dimensions `contentTexture` was last sized to (0 = unallocated). */
	let lastContentW = 0;
	let lastContentH = 0;
	/**
	 * Intermediate texture for the transform pass (rgba16float).
	 * When transform is active, tonecurve → preTransformTexture → transform → [crop] → outputTexture.
	 */
	let preTransformTexture: GPUTexture | null = null;
	/**
	 * Intermediate texture for the crop pass (rgba16float).
	 * When cropping is active, [transform] → preCropTexture → crop → outputTexture.
	 */
	let preCropTexture: GPUTexture | null = null;
	/**
	 * Persistent rgba8unorm readback texture (COPY_SRC | RENDER_ATTACHMENT | TEXTURE_BINDING).
	 * A dithered blit from outputTexture writes here; readPixels() copies from this texture.
	 */
	let readbackTexture: GPUTexture | null = null;
	/**
	 * Linear RGBA snapshot of the resident bitmap (JPEG/TIFF fallback path).
	 *
	 * `bitmapToF32Pixels()` is a full GPU→CPU readback plus an f32 copy, and its
	 * input does not change while the user drags sliders, so it is taken once
	 * per bitmap. The analysis and the WB picker both read it.
	 */
	let cachedF32Bitmap: ImageBitmap | null = null;
	let cachedF32Pixels: Float32Array | null = null;

	/**
	 * Analysis of the resident source.
	 *
	 * The analysis walks the source on the main thread, which costs more than
	 * the entire GPU pass chain. It depends only on the source pixels, the film
	 * type, the roll baseline and (for a RAW slide's histograms) the camera
	 * matrix — never on the edit parameters being dragged — so it is reused
	 * until one of those changes.
	 */
	let cachedAnalysis: {
		source: object;
		filmType: FilmType;
		baselineKey: number | null;
		/** `sourceMatrix` joined, '' for none. */
		matrixKey: string;
		result: AnalysisResult;
	} | null = null;
	/** The analysis the last render used; null when it was not a negative. */
	let lastResult: AnalysisResult | null = null;

	/**
	 * Analyse `source` for a negative or slide render (cached), remember it as
	 * the last result, and return it. `linearSource` is only called on a cache
	 * miss; `isLinear` is true for the RAW path.
	 */
	function measureNegative(
		edit: EffectiveEdit,
		source: object,
		w: number,
		h: number,
		isLinear: boolean,
		linearSource: () => LinearSource,
	): NegativeAnalysis {
		const filmType = edit.inversionParams.filmType;
		const baselineKey = edit.rollBaseline?.key ?? null;
		const sourceMatrix = sourceMatrixFor(edit, isLinear);
		const matrixKey = sourceMatrix?.join(',') ?? '';
		if (
			cachedAnalysis === null ||
			cachedAnalysis.source !== source ||
			cachedAnalysis.filmType !== filmType ||
			cachedAnalysis.baselineKey !== baselineKey ||
			cachedAnalysis.matrixKey !== matrixKey
		) {
			const result = analyzeNegative(
				linearSource(),
				w,
				h,
				filmType,
				edit.rollBaseline,
				sourceMatrix,
			);
			cachedAnalysis = { source, filmType, baselineKey, matrixKey, result };
		}
		lastResult = cachedAnalysis.result;
		return lastResult.analysis;
	}

	/** Track last output dimensions to detect when resize is needed. */
	let lastOutputWidth = 0;
	let lastOutputHeight = 0;
	/** Track last pre-crop texture dimensions (post-rotation, pre-crop). */
	let lastPreCropW = 0;
	let lastPreCropH = 0;

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
	 * @param analysis  The negative's analysis, required for the print curve.
	 *                  Must be provided when edit.invert = true.
	 */
	async function runMainPasses(
		edit: EffectiveEdit,
		w: number,
		h: number,
		isLinear: boolean,
		analysis: NegativeAnalysis | null,
	): Promise<void> {
		lastGeometry = {
			sourceWidth: w,
			sourceHeight: h,
			transform: edit.transform,
			cropQuad: edit.cropQuad,
			borderWidth: edit.inversionParams.borderWidth,
		};
		lastSourceMatrix = sourceMatrixFor(edit, isLinear);
		// ── Compute output dimensions (may differ from source if cropped/rotated) ───
		const hasCrop = edit.cropQuad !== null;
		const hasTransform = !isIdentityTransform(edit.transform);
		const swapDims = isRotation90Multiple(edit.transform.rotation);

		// Start with source dimensions, swap if rotated 90°/270°
		let outW = swapDims ? h : w;
		let outH = swapDims ? w : h;

		// Apply crop dimensions (crop is in post-rotation space, so use rotated dims)
		if (hasCrop && edit.cropQuad) {
			const cropDims = computeCropOutputDimensions(edit.cropQuad, outW, outH);
			outW = cropDims.width;
			outH = cropDims.height;
		}

		// ── Compute matting border + final (bordered) output dimensions ─────
		// `outW`/`outH` are the *content* size (post-crop/rotate). The matte is
		// added around it, growing the written/displayed image. `bp` is 0 when
		// the border is disabled, in which case content renders straight to
		// `outputTexture`.
		const contentW = outW;
		const contentH = outH;
		const bp = borderPixelsForContent(contentW, contentH, edit.inversionParams.borderWidth);
		const finalW = contentW + 2 * bp;
		const finalH = contentH + 2 * bp;

		// ── Resize output textures (FINAL/bordered size) ────────────────────
		// These stay at full processing resolution — readPixels(), the WB
		// picker and horizon detection all read from `readbackTexture`.
		if (finalW !== lastOutputWidth || finalH !== lastOutputHeight) {
			// Rebuild output + readback textures at new size
			outputTexture?.destroy();
			outputTexture = device.createTexture({
				size: [finalW, finalH],
				format: 'rgba16float',
				usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
			});
			readbackTexture?.destroy();
			readbackTexture = device.createTexture({
				size: [finalW, finalH],
				format: 'rgba8unorm',
				usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
			});

			lastOutputWidth = finalW;
			lastOutputHeight = finalH;
		}

		// ── Resize the swap chain to the on-screen display size ─────────────
		// Compositing a full-resolution canvas down to the viewport is a
		// single bilinear tap (no mip chain), which aliases badly. Rendering
		// the swap chain at display size and box-filtering in the blit pass
		// gives a preview that matches the exported file.
		syncCanvasSize(finalW, finalH);

		// ── Resize content texture (border pass input) when matte active ────
		if (bp > 0 && (contentW !== lastContentW || contentH !== lastContentH)) {
			contentTexture?.destroy();
			contentTexture = device.createTexture({
				size: [contentW, contentH],
				format: 'rgba16float',
				usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
			});
			lastContentW = contentW;
			lastContentH = contentH;
		}

		// The final content stage (tonecurve/transform/crop) renders here.
		// With a matte it's the content-sized texture (composited into
		// `outputTexture` by the border pass); otherwise straight to output.
		const finalContentTarget = bp > 0 ? contentTexture! : outputTexture!;

		// ── Resize pre-crop texture if rotation swaps dimensions ────────────
		// preCropTexture is the transform pass output (and crop pass input).
		// When rotation is 90°/270°, it needs swapped dimensions vs source.
		const preCropW = swapDims ? h : w;
		const preCropH = swapDims ? w : h;
		if (hasCrop && hasTransform && (preCropW !== lastPreCropW || preCropH !== lastPreCropH)) {
			preCropTexture?.destroy();
			preCropTexture = device.createTexture({
				size: [preCropW, preCropH],
				format: 'rgba16float',
				usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
			});
			lastPreCropW = preCropW;
			lastPreCropH = preCropH;
		}
		// ── Build LUT textures ──────────────────────────────────────────────

		const [toneLut, redLut, greenLut, blueLut] = buildCurveLUTs(
			edit.toneCurve,
			edit.rgbCurves,
		);

		const toneLutTex = createLutTexture(device, toneLut);
		const redLutTex = createLutTexture(device, redLut);
		const greenLutTex = createLutTexture(device, greenLut);
		const blueLutTex = createLutTexture(device, blueLut);

		// ── Build colour matrix uniforms ────────────────────────────────────
		// Source matrix m is row-major [m00,m01,m02, m10,m11,m12, m20,m21,m22].
		// WGSL mat3x3 col0 = [m00,m10,m20], col1 = [m01,m11,m21], col2 = [m02,m12,m22].
		const m: Matrix3x3 = edit.cameraColorMatrix;
		const colorMatrixUniforms = new Float32Array([
			m[0], m[3], m[6], 0,   // col0: [m00, m10, m20, pad]
			m[1], m[4], m[7], 0,   // col1: [m01, m11, m21, pad]
			m[2], m[5], m[8], 0,   // col2: [m02, m12, m22, pad]
			0, 0, 0, 0,   // _pad vec4
		]);
		const colorMatrixUniformBuf = makeUniformBuffer(device, colorMatrixUniforms);

		// ── Build tone curve (WB + LUT) uniforms ────────────────────────────
		// For the inversion path, skip white balance — the CMY color timing
		// controls handle color correction in log-density space, and applying
		// WB multipliers on top of the H&D output would double-correct.
		const [tcWbR, tcWbG, tcWbB] = edit.invert
			? [1.0, 1.0, 1.0] as [number, number, number]
			: temperatureToMultipliers(edit.whiteBalance.temperature, edit.whiteBalance.tint);
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

		if (edit.invert && analysis) {
			// ── Negative / slide path ────────────────────────────────────────
			// No cam→sRGB colour matrix pass: a negative's per-channel log
			// normalization (floors/ceils stretch) handles color separation and
			// orange mask removal independently per channel, and a matrix after
			// the print curve mixes encoded data (a magenta tint). A RAW slide
			// gets its camera matrix in linear light inside the normalization
			// pass instead, before the log (`sourceMatrixFor`).
			//
			// Pass 1: normalization    — sourceTexture  → intermediateA
			// Pass 2: hd_curve         — intermediateA  → intermediateB
			// Pass 2.25: glow          — intermediateB  → intermediateE (if glow > 0)
			// Pass 2.5: clahe_histogram — compute: intermediateE/B → claheCdfBuffer
			// Pass 2.6: clahe_remap    — fragment: intermediateE/B + CDF → intermediateC
			// Pass 3: tonecurve        — intermediateC/E/B  → outputTexture

			const inv = edit.inversionParams;
			const { bounds, curve } = solvePrintCurve(inv, analysis, edit.rollBaseline);
			const normBuf = makeNormalizationUniforms(device, bounds, !isLinear, lastSourceMatrix);
			const hdBuf = makeUniformBuffer(
				device,
				new Float32Array(
					packPrintCurveUniforms(curve, toneStageParams(inv), inv.filmType, isLinear),
				),
			);
			toClean.push(normBuf, hdBuf);

			// Normalization: linear source → normalized log-density
			const normBG = device.createBindGroup({
				layout: normalizationPipeline.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: sampler },
					{ binding: 1, resource: sourceTexture!.createView() },
					{ binding: 2, resource: { buffer: normBuf } },
				],
			});

			drawFullscreenTriangle(encoder, normalizationPipeline, normBG, intermediateA!.createView());

			// H&D curve (or slide transfer): normalized log-density → gamma-encoded positive
			const hdBG = device.createBindGroup({
				layout: hdCurvePipeline.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: sampler },
					{ binding: 1, resource: intermediateA!.createView() },
					{ binding: 2, resource: { buffer: hdBuf } },
				],
			});

			drawFullscreenTriangle(encoder, hdCurvePipeline, hdBG, intermediateB!.createView());

			// No color matrix after the curve — the encoded print must not be mixed.

			// ── Glow pass (skip when amount is zero) ─────────────────────────
			// Glow applies highlight bloom effect after H&D curve.
			// Uses fast downsampled processing for preview performance:
			//   1. Downsample H&D output to 1/4 res → glowDownsampleTex
			//   2. Extract highlights + blur at 1/4 res → glowBlurTex
			//   3. Blend upsampled glow onto full-res H&D output → intermediateE
			// (Native export uses HQ full-res glow in Rust process.rs)
			const glowAmount = edit.inversionParams.glow ?? 0;
			let postGlowTexture: GPUTexture;

			if (glowAmount > 0 && intermediateE && glowDownsampleTex && glowBlurTex) {
				// Step 1: Downsample H&D output to 1/4 resolution
				const downsampleBG = device.createBindGroup({
					layout: downsamplePipeline.getBindGroupLayout(0),
					entries: [
						{ binding: 0, resource: sampler },
						{ binding: 1, resource: intermediateB!.createView() },
					],
				});
				drawFullscreenTriangle(encoder, downsamplePipeline, downsampleBG, glowDownsampleTex.createView());

				// Step 2: Extract highlights + blur at low resolution (fast!)
				// Scale the Fibonacci-spiral radius by image size so the bloom
				// covers a consistent fraction of the image at any resolution.
				const sampleRadius = glowSampleRadiusForImage(w, h);
				const glowExtractBuf = makeGlowExtractUniforms(device, sampleRadius);
				toClean.push(glowExtractBuf);

				const glowBG = device.createBindGroup({
					layout: glowPipeline.getBindGroupLayout(0),
					entries: [
						{ binding: 0, resource: sampler },
						{ binding: 1, resource: glowDownsampleTex.createView() },
						{ binding: 2, resource: { buffer: glowExtractBuf } },
					],
				});
				drawFullscreenTriangle(encoder, glowPipeline, glowBG, glowBlurTex.createView());

				// Step 3: Blend upsampled glow onto full-res original
				const glowBlendBuf = makeGlowUniforms(device, glowAmount);
				toClean.push(glowBlendBuf);

				const glowBlendBG = device.createBindGroup({
					layout: glowBlendPipeline.getBindGroupLayout(0),
					entries: [
						{ binding: 0, resource: sampler },
						{ binding: 1, resource: intermediateB!.createView() },  // Original full-res
						{ binding: 2, resource: glowBlurTex.createView() },     // Upsampled via bilinear
						{ binding: 3, resource: { buffer: glowBlendBuf } },
					],
				});
				drawFullscreenTriangle(encoder, glowBlendPipeline, glowBlendBG, intermediateE.createView());

				postGlowTexture = intermediateE;
			} else {
				// Glow disabled — continue with H&D output
				postGlowTexture = intermediateB!;
			}

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
						{ binding: 0, resource: postGlowTexture.createView() },
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
						{ binding: 1, resource: postGlowTexture.createView() },
						{ binding: 2, resource: { buffer: claheRemapUnifBuf } },
						{ binding: 3, resource: { buffer: claheCdfBuffer } },
					],
				});

				drawFullscreenTriangle(encoder, claheRemapPipeline, claheRemapBG, intermediateC!.createView());

				beforeToneCurve = intermediateC!.createView();
			} else {
				// CLAHE disabled — feed glow output (or H&D output) to tonecurve.
				beforeToneCurve = postGlowTexture.createView();
			}

			// ── Sharpen pass (skip when amount is zero) ──────────────────────
			const sharpenAmount = edit.inversionParams.sharpen ?? 0;
			if (sharpenAmount > 0 && intermediateD) {
				const sharpenUnifData = new Float32Array([sharpenAmount, 0, 0, 0]);
				const sharpenUnifBuf = makeUniformBuffer(device, sharpenUnifData);
				toClean.push(sharpenUnifBuf);

				// The input to sharpen is whatever was going to feed tone curve
				const sharpenInputTex = (edit.inversionParams.claheStrength > 0 && intermediateC)
					? intermediateC
					: postGlowTexture;

				const sharpenBG = device.createBindGroup({
					layout: sharpenPipeline.getBindGroupLayout(0),
					entries: [
						{ binding: 0, resource: sampler },
						{ binding: 1, resource: sharpenInputTex.createView() },
						{ binding: 2, resource: { buffer: sharpenUnifBuf } },
					],
				});

				drawFullscreenTriangle(encoder, sharpenPipeline, sharpenBG, intermediateD.createView());
				beforeToneCurve = intermediateD.createView();
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
		// Determine target based on what passes follow:
		// - If transform or crop is active, render to an intermediate first
		// - Transform runs before crop, so:
		//   - hasTransform && hasCrop: tonecurve → preTransformTexture → transform → preCropTexture → crop → output
		//   - hasTransform only: tonecurve → preTransformTexture → transform → output
		//   - hasCrop only: tonecurve → preCropTexture → crop → output
		//   - neither: tonecurve → output
		let toneCurveTarget: GPUTexture;
		if (hasTransform) {
			toneCurveTarget = preTransformTexture!;
		} else if (hasCrop) {
			toneCurveTarget = preCropTexture!;
		} else {
			toneCurveTarget = finalContentTarget;
		}

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

		// ── Optional transform pass (rotation) ───────────────────────────────
		// When rotation is ±90°/±270°, the output dimensions are swapped.
		if (hasTransform) {
			const sourceAspect = w / h;
			// The transform output is either preCropTexture (if crop follows) or outputTexture.
			// When swapDims, these textures have swapped dimensions relative to source.
			const transformOutW = hasCrop ? (swapDims ? h : w) : outW;
			const transformOutH = hasCrop ? (swapDims ? w : h) : outH;
			const transformOutputAspect = transformOutW / transformOutH;
			const transformUnifBuf = makeTransformUniforms(device, edit.transform, sourceAspect, transformOutputAspect);
			toClean.push(transformUnifBuf);

			// Determine the transform output target
			const transformTarget = hasCrop ? preCropTexture! : finalContentTarget;

			const transformBG = device.createBindGroup({
				layout: transformPipeline.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: sampler },
					{ binding: 1, resource: preTransformTexture!.createView() },
					{ binding: 2, resource: { buffer: transformUnifBuf } },
				],
			});

			drawFullscreenTriangle(encoder, transformPipeline, transformBG, transformTarget.createView());
		}

		// ── Optional crop pass (perspective quad → rect) ─────────────────────
		// Crop coordinates are in the same space as the displayed image (post-rotation).
		// No coordinate transformation needed since rotation is purely visual.
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

			drawFullscreenTriangle(encoder, cropPipeline, cropBG, finalContentTarget.createView());
		}

		// ── Optional border (matting) pass → output texture ──────────────────
		// Composites the content-sized texture into the larger output texture,
		// filling the surrounding matte with the chosen solid colour.
		if (bp > 0) {
			const borderUnifBuf = makeBorderUniforms(
				device,
				contentW,
				contentH,
				finalW,
				finalH,
				edit.inversionParams.borderColor,
			);
			toClean.push(borderUnifBuf);

			const borderBG = device.createBindGroup({
				layout: borderPipeline.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: sampler },
					{ binding: 1, resource: contentTexture!.createView() },
					{ binding: 2, resource: { buffer: borderUnifBuf } },
				],
			});

			drawFullscreenTriangle(encoder, borderPipeline, borderBG, outputTexture!.createView());
		}

		// Note: Transform (rotation/flip) is applied via CSS in the UI for instant preview.
		// The GPU transform pass will be used during export (see exportWithTransform).

		// ── Dithered blit → canvas swap chain (8-bit display) ────────────────
		// The swap chain may be smaller than the output texture; the blit
		// shader box-filters over the footprint to avoid aliasing.
		const blitDisplayUnif = makeUniformBuffer(
			device,
			new Float32Array([finalW, finalH, canvasW || finalW, canvasH || finalH]),
		);
		toClean.push(blitDisplayUnif);

		const blitBG = device.createBindGroup({
			layout: blitPipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: sampler },
				{ binding: 1, resource: outputTexture!.createView() },
				{ binding: 2, resource: { buffer: blitDisplayUnif } },
			],
		});

		drawFullscreenTriangle(encoder, blitPipeline, blitBG, context.getCurrentTexture().createView());

		// ── Dithered blit → readback texture (rgba8unorm, COPY_SRC) ──────────
		// Full resolution — src and dst match, so this is a 1:1 copy.
		const blitReadbackUnif = makeUniformBuffer(
			device,
			new Float32Array([finalW, finalH, finalW, finalH]),
		);
		toClean.push(blitReadbackUnif);

		const readbackBG = device.createBindGroup({
			layout: blitReadbackPipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: sampler },
				{ binding: 1, resource: outputTexture!.createView() },
				{ binding: 2, resource: { buffer: blitReadbackUnif } },
			],
		});

		drawFullscreenTriangle(encoder, blitReadbackPipeline, readbackBG, readbackTexture!.createView());

		// ── Output histogram (compute) → staging buffer ──────────────────────
		// Counts the content (no matte) at full float precision, before the
		// 8-bit dither. Each render gets its own 3 KB staging buffer because a
		// previous render's may still be mapped.
		const histBG = device.createBindGroup({
			layout: outputHistPipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: finalContentTarget.createView() },
				{ binding: 1, resource: { buffer: outputHistBuffer } },
			],
		});
		encoder.clearBuffer(outputHistBuffer);
		const histPass = encoder.beginComputePass();
		histPass.setPipeline(outputHistPipeline);
		histPass.setBindGroup(0, histBG);
		histPass.dispatchWorkgroups(Math.ceil(contentH / OUTPUT_HIST_ROWS));
		histPass.end();
		const histStaging = device.createBuffer({
			size: OUTPUT_HIST_BYTES,
			usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
		});
		encoder.copyBufferToBuffer(outputHistBuffer, 0, histStaging, 0, OUTPUT_HIST_BYTES);

		device.queue.submit([encoder.finish()]);
		await device.queue.onSubmittedWorkDone();

		try {
			await histStaging.mapAsync(GPUMapMode.READ);
			const counts = new Uint32Array(histStaging.getMappedRange().slice(0));
			lastOutputHistogram = {
				r: counts.subarray(0, 256),
				g: counts.subarray(256, 512),
				b: counts.subarray(512, 768),
				pixels: contentW * contentH,
			};
			histStaging.unmap();
		} catch (err) {
			// The picture is already on screen; a missing histogram is not fatal.
			console.error('[pipeline] output histogram readback failed:', err);
		} finally {
			histStaging.destroy();
		}

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
			// Glow blend output (full resolution).
			intermediateE?.destroy();
			intermediateE = createRGBA16Texture(device, srcW, srcH);
			// Glow downsampled textures (1/4 resolution).
			const glowW = Math.max(1, Math.floor(srcW / 4));
			const glowH = Math.max(1, Math.floor(srcH / 4));
			glowDownsampleTex?.destroy();
			glowDownsampleTex = createRGBA16Texture(device, glowW, glowH);
			glowBlurTex?.destroy();
			glowBlurTex = createRGBA16Texture(device, glowW, glowH);
			// CLAHE CDF storage buffer.
			claheCdfBuffer?.destroy();
			const cdfSize = CLAHE_TILES_X * CLAHE_TILES_Y * CLAHE_NUM_BINS * 4; // f32
			claheCdfBuffer = device.createBuffer({
				size: cdfSize,
				usage: GPUBufferUsage.STORAGE,
			});
		}
		// Pre-transform texture at source resolution (tone curve renders here when transform is active).
		// After ensureRgba8Source sets sourceTexture, the non-null assertion below is safe.
		preTransformTexture?.destroy();
		preTransformTexture = device.createTexture({
			size: [srcW, srcH],
			format: 'rgba16float',
			usage:
				GPUTextureUsage.RENDER_ATTACHMENT |
				GPUTextureUsage.TEXTURE_BINDING,
		});
		// Pre-crop texture at source resolution (transform renders here when crop is also active)
		preCropTexture?.destroy();
		preCropTexture = device.createTexture({
			size: [srcW, srcH],
			format: 'rgba16float',
			usage:
				GPUTextureUsage.RENDER_ATTACHMENT |
				GPUTextureUsage.TEXTURE_BINDING,
		});
		lastPreCropW = srcW;
		lastPreCropH = srcH;
		// Reset output dimensions tracking so runMainPasses rebuilds output textures
		lastOutputWidth = 0;
		lastOutputHeight = 0;
		// Reset content (border-input) dimensions tracking so it's rebuilt too
		lastContentW = 0;
		lastContentH = 0;
	}

	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Shared setup: ensure source texture is `rgba8unorm` at (w,h) and upload
	 * the given RGBA u8 pixel data. Used by `render` (from ImageBitmap) and
	 * `renderDecodedRgba` (from Tauri decode command).
	 */
	function ensureRgba8Source(w: number, h: number): void {
		sourceTexture?.destroy();
		sourceTexture = device.createTexture({
			size: [w, h],
			format: 'rgba8unorm',
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
		});
		ensureIntermediates(w, h, true);
	}

	async function render(edit: EffectiveEdit, bitmap: ImageBitmap): Promise<void> {
		const w = bitmap.width;
		const h = bitmap.height;

		// Re-upload source texture only when the bitmap changes
		if (bitmap !== lastBitmap) {
			ensureRgba8Source(w, h);
			device.queue.copyExternalImageToTexture(
				{ source: bitmap },
				{ texture: sourceTexture! },
				[w, h],
			);
			lastBitmap = bitmap;
			// This bitmap now owns sourceTexture.
			lastRawBuffer = null;
			lastDecodedBuffer = null;
		}

		// Measure the negative. No color matrix applied — the analysis operates
		// on camera-native data, as the normalization pass does.
		let analysis: NegativeAnalysis | null = null;
		if (edit.invert) {
			// Refresh the f32 snapshot only when the source bitmap changes.
			if (bitmap !== cachedF32Bitmap || cachedF32Pixels === null) {
				cachedF32Pixels = await bitmapToF32Pixels(bitmap);
				cachedF32Bitmap = bitmap;
			}
			const snapshot = cachedF32Pixels;
			analysis = measureNegative(edit, bitmap, w, h, false, () => ({
				kind: 'linear-f32',
				pixels: snapshot,
				channels: 4,
			}));
		} else {
			lastResult = null;
		}

		await runMainPasses(edit, w, h, false, analysis);
	}

	// ─── Decoded-image render path ────────────────────────────────────────────

	async function renderDecodedRgba(edit: EffectiveEdit, rgbaBuffer: ArrayBuffer): Promise<void> {
		const { width: w, height: h, pixels } = parseDecodeImageRgbBuffer(rgbaBuffer);

		// ── Upload — skipped when this buffer is already resident ─────────────
		if (rgbaBuffer !== lastDecodedBuffer) {
			// Invalidate ImageBitmap cache so the next render() call re-uploads.
			lastBitmap = null;
			cachedF32Bitmap = null;
			cachedF32Pixels = null;

			ensureRgba8Source(w, h);
			// bytesPerRow must be 256-aligned for writeTexture.
			const bytesPerRow = Math.ceil((w * 4) / 256) * 256;
			let uploadData: ArrayBuffer;
			if (bytesPerRow === w * 4) {
				uploadData = (pixels.buffer as ArrayBuffer).slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength);
			} else {
				const buf = new ArrayBuffer(bytesPerRow * h);
				const dst = new Uint8Array(buf);
				for (let row = 0; row < h; row++) {
					dst.set(
						new Uint8Array(pixels.buffer, pixels.byteOffset + row * w * 4, w * 4),
						row * bytesPerRow,
					);
				}
				uploadData = buf;
			}

			device.queue.writeTexture(
				{ texture: sourceTexture! },
				uploadData,
				{ bytesPerRow },
				[w, h],
			);

			lastDecodedBuffer = rgbaBuffer;
			lastRawBuffer = null;
		}

		// Measure the negative. The 8-bit source is sRGB-encoded; the analysis
		// gamma-expands it, as the normalization shader does (srgbExpand = 1 on
		// this path) and as the exporter does before measuring.
		let analysis: NegativeAnalysis | null = null;
		if (edit.invert) {
			analysis = measureNegative(edit, rgbaBuffer, w, h, false, () => ({
				kind: 'srgb-u8',
				pixels,
			}));
		} else {
			lastResult = null;
		}

		await runMainPasses(edit, w, h, false, analysis);
	}

	// ─── RAW render path ──────────────────────────────────────────────────────

	async function renderRaw(edit: EffectiveEdit, rawBuffer: ArrayBuffer): Promise<void> {
		const { width: w, height: h, pixels } = parseRawDecodeBuffer(rawBuffer);

		// Measure the negative. No color matrix applied — the analysis operates
		// on camera-native linear data, as the normalization pass does.
		let analysis: NegativeAnalysis | null = null;
		if (edit.invert) {
			analysis = measureNegative(edit, rawBuffer, w, h, true, () => ({
				kind: 'linear-u16',
				pixels,
			}));
		} else {
			lastResult = null;
		}

		// Push error scopes to surface any WebGPU validation/OOM errors.
		device.pushErrorScope('validation');
		device.pushErrorScope('out-of-memory');

		// ── Upload + ingest — skipped when this buffer is already resident ────
		// Everything in here depends only on the source pixels, so on a slider
		// drag we go straight to the main passes with the ingested texture and
		// the intermediates from the first render of this frame.
		let rawTexture: GPUTexture | null = null;
		if (rawBuffer !== lastRawBuffer) {
			// Upload u16 pixel data as rgba16uint texture.
			rawTexture = device.createTexture({
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

			// ── Ingest pass: rgba16uint → rgba16float ────────────────────────
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

			// ── Swap sourceTexture + intermediates for the main passes ────────
			sourceTexture?.destroy();
			sourceTexture = ingestedTexture;
			ensureIntermediates(w, h, true);

			// This buffer now owns sourceTexture; invalidate the other paths'
			// residency so they re-upload when next used.
			lastRawBuffer = rawBuffer;
			lastDecodedBuffer = null;
			lastBitmap = null;
		}

		await runMainPasses(edit, w, h, true, analysis);

		rawTexture?.destroy();

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
		intermediateE?.destroy();
		glowDownsampleTex?.destroy();
		glowBlurTex?.destroy();
		claheCdfBuffer?.destroy();
		outputHistBuffer.destroy();
		outputTexture?.destroy();
		contentTexture?.destroy();
		preTransformTexture?.destroy();
		preCropTexture?.destroy();
		preTransformTexture?.destroy();
		readbackTexture?.destroy();
		cachedF32Bitmap = null;
		cachedF32Pixels = null;
		cachedAnalysis = null;
		lastResult = null;
		lastRawBuffer = null;
		lastDecodedBuffer = null;
		lastGeometry = null;
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

	/** Geometry of the last render, for `sampleSourceLog`. */
	let lastGeometry: PickGeometry | null = null;
	/** Linear-light matrix the last render applied before the log, for `sampleSourceLog`. */
	let lastSourceMatrix: Matrix3x3 | null = null;

	function sampleSourceLog(nx: number, ny: number): Vec3 | null {
		if (!lastGeometry) return null;
		if (lastRawBuffer) {
			const { width, height, pixels } = parseRawDecodeBuffer(lastRawBuffer);
			const src: LinearSource = { kind: 'linear-u16', pixels };
			return sampleSourceLogAt(src, width, height, nx, ny, lastGeometry, lastSourceMatrix);
		}
		if (lastDecodedBuffer) {
			const { width, height, pixels } = parseDecodeImageRgbBuffer(lastDecodedBuffer);
			return sampleSourceLogAt({ kind: 'srgb-u8', pixels }, width, height, nx, ny, lastGeometry);
		}
		// The bitmap path keeps a linear RGBA snapshot of the resident bitmap.
		if (lastBitmap && cachedF32Bitmap === lastBitmap && cachedF32Pixels) {
			const src: LinearSource = { kind: 'linear-f32', pixels: cachedF32Pixels, channels: 4 };
			return sampleSourceLogAt(src, lastBitmap.width, lastBitmap.height, nx, ny, lastGeometry);
		}
		return null;
	}

	return {
		render,
		renderDecodedRgba,
		renderRaw,
		readPixels,
		sampleSourceLog,
		destroy,
		maxTextureDimension,
		get lastAnalysis() { return lastResult?.analysis ?? null; },
		get lastBounds() { return lastResult?.bounds ?? null; },
		get lastHistograms() { return lastResult?.histograms ?? null; },
		get lastOutputHistogram() { return lastOutputHistogram; },
		get lastOutputWidth() { return lastOutputWidth; },
		get lastOutputHeight() { return lastOutputHeight; },
		setDisplayBox(cssWidth: number, cssHeight: number): void {
			displayBoxW = cssWidth;
			displayBoxH = cssHeight;
		},
	};
}
