/**
 * Blit pass — samples the rgba16float output texture, applies ordered
 * dithering, and writes to the 8-bit swap chain / readback texture.
 *
 * Uses an 8×8 Bayer matrix for spatially stable dithering that breaks up
 * banding artifacts when converting from 16-bit float to 8-bit unorm.
 */

@group(0) @binding(0) var uSampler : sampler;
@group(0) @binding(1) var uTexture : texture_2d<f32>;

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

/// 8×8 Bayer dither threshold (normalized to [-0.5/255, +0.5/255]).
fn bayer8x8(pos : vec2<u32>) -> f32 {
	// Classic 8×8 ordered dither matrix (values 0..63).
	let x = pos.x % 8u;
	let y = pos.y % 8u;

	// Compute Bayer value via bit-interleaving (no array needed).
	var v = 0u;
	var xb = x;
	var yb = y;
	v |= ((xb ^ yb) & 1u);          // bit 0
	v |= (((xb >> 1u) ^ yb) & 1u) << 1u;  // bit 1
	v |= ((xb ^ (yb >> 1u)) & 1u) << 2u;  // bit 2
	v |= (((xb >> 2u) ^ yb) & 1u) << 3u;  // bit 3
	v |= ((xb ^ (yb >> 2u)) & 1u) << 4u;  // bit 4
	v |= (((xb >> 1u) ^ (yb >> 1u)) & 1u) << 5u; // bit 5

	// Map [0, 63] to [-0.5, +0.5], then scale to one 8-bit step.
	return (f32(v) / 63.0 - 0.5) / 255.0;
}

@fragment
fn fs_main(in : VertOut) -> @location(0) vec4<f32> {
	let col = textureSample(uTexture, uSampler, in.uv);
	let px  = vec2<u32>(u32(in.pos.x), u32(in.pos.y));
	let d   = bayer8x8(px);
	// Add dither noise, then let the fixed-function unorm conversion quantize.
	return vec4<f32>(
		clamp(col.r + d, 0.0, 1.0),
		clamp(col.g + d, 0.0, 1.0),
		clamp(col.b + d, 0.0, 1.0),
		1.0,
	);
}
