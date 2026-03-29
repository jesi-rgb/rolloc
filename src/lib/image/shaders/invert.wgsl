/**
 * Pass 1 — Normalize + Invert
 *
 * Reads the source texture (film negative, sRGB-encoded JPEG/TIFF or
 * linear camera-native RAW after the ingest pass).
 * Steps:
 *   1. Sample the source texel.
 *   2. Linearise sRGB → linear light  (skipped when isLinear = 1.0).
 *   3. Clamp to the rebate-derived [blackPoint, whitePoint] range per channel.
 *   4. Normalise to [0, 1].
 *   5. Invert (1 - x).
 *   6. Apply per-stop exposure compensation (multiply by 2^ev).
 *
 * Output is a linear-light RGB colour still in camera native space.
 */

struct Uniforms {
	/// Per-channel black points, derived from the rebate region sample (linear light).
	blackPoint : vec3<f32>,
	/// Per-channel white points (linear light, typically ~1.0).
	whitePoint : vec3<f32>,
	/// Exposure compensation in stops.
	exposureEV : f32,
	/// 1.0 = invert (negative film); 0.0 = pass-through (positive/already-scanned).
	invert     : f32,
	/// 1.0 = input is already linear (RAW path); 0.0 = sRGB-encoded (JPEG/TIFF path).
	isLinear   : f32,
	/// Padding to reach the next 16-byte boundary.
	_pad       : f32,
}

@group(0) @binding(0) var uSampler : sampler;
@group(0) @binding(1) var uTexture : texture_2d<f32>;
@group(0) @binding(2) var<uniform> u : Uniforms;

struct VertIn {
	@builtin(vertex_index) idx : u32,
}

struct VertOut {
	@builtin(position) pos : vec4<f32>,
	@location(0) uv         : vec2<f32>,
}

// Full-screen triangle — no vertex buffer needed.
@vertex
fn vs_main(in : VertIn) -> VertOut {
	// Generates: (-1,-1), (3,-1), (-1,3)
	let x = f32((in.idx << 1u) & 2u);
	let y = f32(in.idx & 2u);
	var out : VertOut;
	out.pos = vec4<f32>(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);
	out.uv  = vec2<f32>(x, 1.0 - y);
	return out;
}

// sRGB gamma expand (approximate, fast).
fn srgb_to_linear(c : f32) -> f32 {
	if (c <= 0.04045) {
		return c / 12.92;
	}
	return pow((c + 0.055) / 1.055, 2.4);
}

@fragment
fn fs_main(in : VertOut) -> @location(0) vec4<f32> {
	let srgb = textureSample(uTexture, uSampler, in.uv).rgb;

	// 1. sRGB → linear light (skip when input is already linear, e.g. RAW path)
	var lin : vec3<f32>;
	if (u.isLinear >= 0.5) {
		lin = srgb; // already linear
	} else {
		lin = vec3<f32>(
			srgb_to_linear(srgb.r),
			srgb_to_linear(srgb.g),
			srgb_to_linear(srgb.b),
		);
	}

	// 2. Normalise: remap [black, white] → [0, 1]
	let range = max(u.whitePoint - u.blackPoint, vec3<f32>(1e-6));
	let norm  = clamp((lin - u.blackPoint) / range, vec3<f32>(0.0), vec3<f32>(1.0));

	// 3. Conditionally invert (negative film only)
	let inv = select(norm, vec3<f32>(1.0) - norm, u.invert >= 0.5);

	// 4. Exposure compensation
	let ev  = pow(2.0, u.exposureEV);
	let out = clamp(inv * ev, vec3<f32>(0.0), vec3<f32>(1.0));

	return vec4<f32>(out, 1.0);
}
