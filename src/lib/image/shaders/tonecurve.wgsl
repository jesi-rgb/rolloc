/**
 * Pass 3 — Tone curve + White balance + Display output
 *
 * Inputs:
 *   - Linear sRGB from Pass 2
 *   - 256-entry LUT textures for global tone curve and per-channel R/G/B curves
 *   - White balance multipliers derived from temperature/tint
 *
 * Steps:
 *   1. Apply white balance (chromatic adaptation via channel multipliers).
 *   2. Apply per-channel R/G/B curves (LUT lookup).
 *   3. Apply global tone curve (LUT lookup).
 *   4. Apply sRGB gamma encoding for display.
 */

const LUT_SIZE : f32 = 256.0;

struct Uniforms {
	/// Pre-computed white balance channel multipliers [r, g, b, 1.0]
	wbMultipliers : vec4<f32>,
}

@group(0) @binding(0) var uSampler     : sampler;
@group(0) @binding(1) var uTexture     : texture_2d<f32>;
@group(0) @binding(2) var<uniform> u   : Uniforms;
/// 1D LUT textures — each is a 256×1 R32Float texture
@group(0) @binding(3) var uToneLUT     : texture_1d<f32>;
@group(0) @binding(4) var uRedLUT      : texture_1d<f32>;
@group(0) @binding(5) var uGreenLUT    : texture_1d<f32>;
@group(0) @binding(6) var uBlueLUT     : texture_1d<f32>;

struct VertIn {
	@builtin(vertex_index) idx : u32,
}

struct VertOut {
	@builtin(position) pos : vec4<f32>,
	@location(0) uv         : vec2<f32>,
}

@vertex
fn vs_main(in : VertIn) -> VertOut {
	let x = f32((in.idx << 1u) & 2u);
	let y = f32(in.idx & 2u);
	var out : VertOut;
	out.pos = vec4<f32>(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);
	out.uv  = vec2<f32>(x, 1.0 - y);
	return out;
}

/// Look up a value in a 1D LUT texture (R channel, linear).
fn lutLookup(lut : texture_1d<f32>, v : f32) -> f32 {
	let idx = clamp(i32(v * (LUT_SIZE - 1.0) + 0.5), 0, i32(LUT_SIZE) - 1);
	return textureLoad(lut, idx, 0).r;
}

/// sRGB gamma encode (linear light → display sRGB).
fn linear_to_srgb(c : f32) -> f32 {
	if (c <= 0.0031308) {
		return c * 12.92;
	}
	return 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}

@fragment
fn fs_main(in : VertOut) -> @location(0) vec4<f32> {
	var col = textureSample(uTexture, uSampler, in.uv).rgb;

	// 1. White balance
	col = clamp(col * u.wbMultipliers.rgb, vec3<f32>(0.0), vec3<f32>(1.0));

	// 2. Per-channel RGB curves
	col = vec3<f32>(
		lutLookup(uRedLUT,   col.r),
		lutLookup(uGreenLUT, col.g),
		lutLookup(uBlueLUT,  col.b),
	);

	// 3. Global tone curve
	col = vec3<f32>(
		lutLookup(uToneLUT, col.r),
		lutLookup(uToneLUT, col.g),
		lutLookup(uToneLUT, col.b),
	);

	// 4. sRGB gamma encode for display
	let srgb = vec3<f32>(
		linear_to_srgb(col.r),
		linear_to_srgb(col.g),
		linear_to_srgb(col.b),
	);

	return vec4<f32>(clamp(srgb, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
