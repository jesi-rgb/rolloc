/**
 * Downsample pass — bilinear 4x4 box filter to 1/4 resolution.
 *
 * Takes a full-resolution texture and outputs to a texture 1/4 the size.
 * Uses a 4x4 tap pattern with equal weights for a simple box filter,
 * which is sufficient for the glow effect's blurry nature.
 *
 * The sampler's bilinear filtering gives us 4 free samples per tap,
 * so we sample at the corners of each 2x2 block to cover a 4x4 area.
 */

@group(0) @binding(0) var uSampler : sampler;
@group(0) @binding(1) var uTexture : texture_2d<f32>;

struct VertIn {
	@builtin(vertex_index) idx : u32,
}

struct VertOut {
	@builtin(position) pos : vec4<f32>,
	@location(0)       uv  : vec2<f32>,
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

@fragment
fn fs_main(in : VertOut) -> @location(0) vec4<f32> {
	let src_dims = vec2<f32>(textureDimensions(uTexture));
	let texel = 1.0 / src_dims;
	
	// Sample at 4 points offset by 0.5 texels from center
	// With bilinear filtering, each sample averages a 2x2 block
	// Total coverage: 4x4 texels
	let offset = texel * 0.5;
	
	let s0 = textureSample(uTexture, uSampler, in.uv + vec2<f32>(-offset.x, -offset.y));
	let s1 = textureSample(uTexture, uSampler, in.uv + vec2<f32>( offset.x, -offset.y));
	let s2 = textureSample(uTexture, uSampler, in.uv + vec2<f32>(-offset.x,  offset.y));
	let s3 = textureSample(uTexture, uSampler, in.uv + vec2<f32>( offset.x,  offset.y));
	
	return (s0 + s1 + s2 + s3) * 0.25;
}
