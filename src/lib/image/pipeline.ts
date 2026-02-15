/**
 * WebGPU render pipeline for film negative inversion.
 *
 * Three-pass pipeline:
 *   Pass 1 (invert)       — normalize + invert + exposure (camera native linear)
 *   Pass 2 (colormatrix)  — 3×3 camera-to-sRGB colour matrix
 *   Pass 3 (tonecurve)    — white balance + RGB curves + global tone curve + γ encode
 *
 * Usage:
 *   const gpu = await createPipeline(canvas);
 *   await gpu.render(effectiveEdit, imageBitmap);
 *   gpu.destroy();          // free GPU resources
 */

import invertWGSL      from './shaders/invert.wgsl?raw';
import colorMatrixWGSL from './shaders/colormatrix.wgsl?raw';
import toneCurveWGSL   from './shaders/tonecurve.wgsl?raw';
import { buildCurveLUTs } from './curves';
import type { EffectiveEdit } from '$lib/types';

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

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GpuPipeline {
	/** Re-render the canvas with a new edit and/or image bitmap. */
	render(edit: EffectiveEdit, bitmap: ImageBitmap): Promise<void>;
	/** Release all GPU resources. Call when the editor unmounts. */
	destroy(): void;
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

	const contextOrNull = canvas.getContext('webgpu');
	if (!contextOrNull) throw new Error('Could not get WebGPU canvas context.');
	// Structurally impossible to be null beyond this point; we threw above.
	const context: GPUCanvasContext = contextOrNull;

	const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
	context.configure({ device, format: presentationFormat, alphaMode: 'opaque' });

	const sampler = createLinearSampler(device);

	// ── Compile shader modules ──────────────────────────────────────────────

	const invertModule      = device.createShaderModule({ code: invertWGSL });
	const colorMatrixModule = device.createShaderModule({ code: colorMatrixWGSL });
	const toneCurveModule   = device.createShaderModule({ code: toneCurveWGSL });

	// ── Build render pipelines ──────────────────────────────────────────────

	function makeRenderPipeline(module: GPUShaderModule, format: GPUTextureFormat): GPURenderPipeline {
		return device.createRenderPipeline({
			layout: 'auto',
			vertex:   { module, entryPoint: 'vs_main' },
			fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
			primitive: { topology: 'triangle-list' },
		});
	}

	const invertPipeline      = makeRenderPipeline(invertModule,      'rgba16float');
	const colorMatrixPipeline = makeRenderPipeline(colorMatrixModule, 'rgba16float');
	const toneCurvePipeline   = makeRenderPipeline(toneCurveModule,   presentationFormat);

	// ── Mutable resources (rebuilt per render when image changes) ────────────

	let lastBitmap: ImageBitmap | null = null;
	let sourceTexture: GPUTexture | null = null;
	let intermediateA: GPUTexture | null = null;
	let intermediateB: GPUTexture | null = null;

	// ─────────────────────────────────────────────────────────────────────────

	async function render(edit: EffectiveEdit, bitmap: ImageBitmap): Promise<void> {
		const w = bitmap.width;
		const h = bitmap.height;

		// Resize canvas to match image
		canvas.width  = w;
		canvas.height = h;
		context.configure({ device, format: presentationFormat, alphaMode: 'opaque' });

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

			intermediateA?.destroy();
			intermediateB?.destroy();
			intermediateA = createRGBA16Texture(device, w, h);
			intermediateB = createRGBA16Texture(device, w, h);
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

		// ── Build uniforms ──────────────────────────────────────────────────

		// Pass 1 — invert uniforms: blackPoint(3), pad, whitePoint(3), exposureEV, invert
		// For now derive black/white from the rebate region values (identity: 0/1).
		// Phase 5 will sample the actual rebate region pixels.
		// WGSL struct layout (align 16):
		//   blackPoint: vec3<f32> @ 0   → 12 bytes + 4 pad = 16
		//   whitePoint: vec3<f32> @ 16  → 12 bytes + 4 pad = 16
		//   exposureEV: f32       @ 32  → 4 bytes
		//   invert:     f32       @ 36  → 4 bytes
		//   struct size rounds to 48
		const invertUniforms = new Float32Array([
			0, 0, 0, 0,                       // blackPoint rgb + pad
			1, 1, 1, 0,                       // whitePoint rgb + pad
			edit.exposureCompensation,        // exposureEV
			edit.invert ? 1.0 : 0.0,         // invert flag
			0, 0,                             // tail pad to 48 bytes
		]);
		const invertUniformBuf = makeUniformBuffer(device, invertUniforms);

		// Pass 2 — colour matrix (mat3x3<f32> = 12 floats in std140, padded)
		// WGSL mat3x3<f32> is stored column-major with vec3 padding → 4 floats/col = 48 bytes
		const m = edit.cameraColorMatrix;
		// WGSL mat3x3<f32> layout: 3 columns, each vec3<f32> padded to 16 bytes = 48 bytes.
		// Then _pad: f32 = 4 bytes. Struct size rounds to align 16 → 64 bytes (16 floats).
		// col0=[m[0],m[3],m[6]], col1=[m[1],m[4],m[7]], col2=[m[2],m[5],m[8]] (column-major)
		const colorMatrixUniforms = new Float32Array([
			m[0], m[3], m[6], 0,   // col 0 + pad
			m[1], m[4], m[7], 0,   // col 1 + pad
			m[2], m[5], m[8], 0,   // col 2 + pad
			0, 0, 0, 0,            // _pad + 3 tail floats to reach 64 bytes
		]);
		const colorMatrixUniformBuf = makeUniformBuffer(device, colorMatrixUniforms);

		// Pass 3 — white balance multipliers
		// WB is disabled for now (identity = no colour shift).
		const toneCurveUniforms = new Float32Array([1.0, 1.0, 1.0, 1.0]);
		const toneCurveUniformBuf = makeUniformBuffer(device, toneCurveUniforms);

		// ── Bind groups ─────────────────────────────────────────────────────

		const invertBG = device.createBindGroup({
			layout: invertPipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: sampler },
				{ binding: 1, resource: sourceTexture!.createView() },
				{ binding: 2, resource: { buffer: invertUniformBuf } },
			],
		});

		const colorMatrixBG = device.createBindGroup({
			layout: colorMatrixPipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: sampler },
				{ binding: 1, resource: intermediateA!.createView() },
				{ binding: 2, resource: { buffer: colorMatrixUniformBuf } },
			],
		});

		const lutSampler = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });

		const toneCurveBG = device.createBindGroup({
			layout: toneCurvePipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: lutSampler },
				{ binding: 1, resource: intermediateB!.createView() },
				{ binding: 2, resource: { buffer: toneCurveUniformBuf } },
				{ binding: 3, resource: toneLutTex.createView({ dimension: '1d' }) },
				{ binding: 4, resource: redLutTex.createView({ dimension: '1d' }) },
				{ binding: 5, resource: greenLutTex.createView({ dimension: '1d' }) },
				{ binding: 6, resource: blueLutTex.createView({ dimension: '1d' }) },
			],
		});

		// ── Encode & submit ─────────────────────────────────────────────────

		const encoder = device.createCommandEncoder();

		drawFullscreenTriangle(encoder, invertPipeline,      invertBG,      intermediateA!.createView());
		drawFullscreenTriangle(encoder, colorMatrixPipeline, colorMatrixBG, intermediateB!.createView());
		drawFullscreenTriangle(encoder, toneCurvePipeline,   toneCurveBG,   context.getCurrentTexture().createView());

		device.queue.submit([encoder.finish()]);
		await device.queue.onSubmittedWorkDone();

		// Clean up per-frame GPU resources
		toneLutTex.destroy();
		redLutTex.destroy();
		greenLutTex.destroy();
		blueLutTex.destroy();
		invertUniformBuf.destroy();
		colorMatrixUniformBuf.destroy();
		toneCurveUniformBuf.destroy();
	}

	function destroy(): void {
		sourceTexture?.destroy();
		intermediateA?.destroy();
		intermediateB?.destroy();
		device.destroy();
	}

	return { render, destroy };
}
