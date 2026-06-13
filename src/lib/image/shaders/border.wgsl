/**
 * Border (matting) pass — composites the processed photo into the centre of a
 * larger canvas, filling the surrounding margin with a solid colour.
 *
 * The output texture is `content + 2 * border` in each dimension. For every
 * output texel we map back into the content texture; texels that fall outside
 * the content rectangle are painted with the matting colour.
 *
 * Mirrors `add_border` in the Rust export path so the preview and the exported
 * file are identical.
 */

@group(0) @binding(0) var uSampler : sampler;
@group(0) @binding(1) var uTexture : texture_2d<f32>;

struct BorderUniforms {
	/// content size / final size, per axis (the photo's fractional extent).
	innerScale  : vec2<f32>,
	/// border thickness / final size, per axis (top-left margin as a fraction).
	innerOffset : vec2<f32>,
	/// Solid matting colour (rgb); a is unused.
	color       : vec4<f32>,
}

@group(0) @binding(2) var<uniform> U : BorderUniforms;

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

@fragment
fn fs_main(in : VertOut) -> @location(0) vec4<f32> {
	// Map the final-canvas UV back into content UV space.
	let inner = (in.uv - U.innerOffset) / U.innerScale;

	if (inner.x < 0.0 || inner.x > 1.0 || inner.y < 0.0 || inner.y > 1.0) {
		return vec4<f32>(U.color.rgb, 1.0);
	}

	let col = textureSample(uTexture, uSampler, inner);
	return vec4<f32>(col.rgb, 1.0);
}
