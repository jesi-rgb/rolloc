/**
 * Blit pass — samples the rgba16float output texture, applies ordered
 * dithering, and writes to the 8-bit swap chain / readback texture.
 *
 * Uses an 8×8 Bayer matrix for spatially stable dithering that breaks up
 * banding artifacts when converting from 16-bit float to 8-bit unorm.
 *
 * When the destination is smaller than the source (the on-screen canvas is
 * sized to the display box, not the full image resolution) this pass performs
 * a box-filter downsample over the destination pixel's source footprint.
 * A single bilinear tap only reads a 2×2 texel neighbourhood, which aliases
 * badly at high minification ratios and makes grainy film scans look harsh
 * and "crunchy". Averaging across the whole footprint matches what a proper
 * resampler (and therefore the exported file) produces.
 */

struct BlitUniforms {
	/// Source texture dimensions in texels.
	srcSize : vec2<f32>,
	/// Destination (render target) dimensions in texels.
	dstSize : vec2<f32>,
}

@group(0) @binding(0) var uSampler : sampler;
@group(0) @binding(1) var uTexture : texture_2d<f32>;
@group(0) @binding(2) var<uniform> u : BlitUniforms;

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

/// Maximum box-filter taps per axis. Each tap is bilinear (covering 2 texels),
/// so 4 taps resolve minification ratios up to 8× — beyond the worst case
/// produced by fitting a full-resolution image into the editor viewport.
const MAX_TAPS : i32 = 4;

/// Average the source over the destination pixel's footprint.
/// Falls back to a single tap when there is no minification (ratio <= 1),
/// which is the case for the full-resolution readback target.
fn sampleBox(uv : vec2<f32>) -> vec4<f32> {
	let ratio = u.srcSize / max(u.dstSize, vec2<f32>(1.0, 1.0));

	// Each bilinear tap already averages 2 texels, hence ratio / 2.
	let tapsX = clamp(i32(ceil(ratio.x * 0.5)), 1, MAX_TAPS);
	let tapsY = clamp(i32(ceil(ratio.y * 0.5)), 1, MAX_TAPS);

	if (tapsX == 1 && tapsY == 1) {
		return textureSampleLevel(uTexture, uSampler, uv, 0.0);
	}

	// The destination pixel spans exactly 1 / dstSize in UV space.
	let footprint = 1.0 / max(u.dstSize, vec2<f32>(1.0, 1.0));

	var acc = vec4<f32>(0.0);
	var count = 0.0;
	for (var j = 0; j < tapsY; j = j + 1) {
		let fy = (f32(j) + 0.5) / f32(tapsY) - 0.5;
		for (var i = 0; i < tapsX; i = i + 1) {
			let fx = (f32(i) + 0.5) / f32(tapsX) - 0.5;
			let offset = vec2<f32>(fx, fy) * footprint;
			acc = acc + textureSampleLevel(uTexture, uSampler, uv + offset, 0.0);
			count = count + 1.0;
		}
	}
	return acc / count;
}

@fragment
fn fs_main(in : VertOut) -> @location(0) vec4<f32> {
	let col = sampleBox(in.uv);
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
