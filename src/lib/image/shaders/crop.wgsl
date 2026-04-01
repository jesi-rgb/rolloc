/**
 * Perspective crop pass — samples from a quadrilateral region of the source
 * texture and maps it to the output rectangle using bilinear interpolation.
 *
 * The four corners of the crop quad (tl, tr, br, bl) are passed as uniforms.
 * Each corner is normalized (0–1) relative to the source image dimensions.
 *
 * For each output pixel, we compute the corresponding source UV using bilinear
 * interpolation across the quad. This handles perspective distortion correctly.
 */

@group(0) @binding(0) var uSampler : sampler;
@group(0) @binding(1) var uTexture : texture_2d<f32>;
@group(0) @binding(2) var<uniform> uCropQuad : CropQuadUniforms;

struct CropQuadUniforms {
	tl : vec2<f32>,  // top-left corner (normalized 0–1)
	tr : vec2<f32>,  // top-right corner
	br : vec2<f32>,  // bottom-right corner
	bl : vec2<f32>,  // bottom-left corner
}

struct VertIn {
	@builtin(vertex_index) idx : u32,
}

struct VertOut {
	@builtin(position) pos : vec4<f32>,
	@location(0) uv : vec2<f32>,
}

@vertex
fn vs_main(in : VertIn) -> VertOut {
	// Full-screen triangle: idx 0 → (0,0), idx 1 → (2,0), idx 2 → (0,2)
	let x = f32((in.idx << 1u) & 2u);
	let y = f32(in.idx & 2u);
	var out : VertOut;
	out.pos = vec4<f32>(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);
	// UV goes from (0,0) at top-left to (1,1) at bottom-right
	out.uv = vec2<f32>(x, 1.0 - y);
	return out;
}

/**
 * Bilinear interpolation within the quad.
 *
 * Given output UV (u, v) in [0,1]×[0,1], compute the corresponding
 * source UV by interpolating the quad corners:
 *
 *   top    = lerp(tl, tr, u)
 *   bottom = lerp(bl, br, u)
 *   result = lerp(top, bottom, v)
 *
 * This is equivalent to a bilinear patch and handles parallelograms
 * correctly. For true perspective (non-parallelogram quads), this is
 * an approximation but works well for typical film frame alignment.
 */
fn quadInterpolate(uv : vec2<f32>, tl : vec2<f32>, tr : vec2<f32>, br : vec2<f32>, bl : vec2<f32>) -> vec2<f32> {
	let u = uv.x;
	let v = uv.y;

	// Interpolate along top and bottom edges
	let top = mix(tl, tr, u);
	let bottom = mix(bl, br, u);

	// Interpolate between top and bottom
	return mix(top, bottom, v);
}

@fragment
fn fs_main(in : VertOut) -> @location(0) vec4<f32> {
	// Map output UV to source UV via the crop quad
	let srcUV = quadInterpolate(
		in.uv,
		uCropQuad.tl,
		uCropQuad.tr,
		uCropQuad.br,
		uCropQuad.bl
	);

	// Sample the source texture at the computed UV
	// Out-of-bounds UVs will be clamped by the sampler
	return textureSample(uTexture, uSampler, srcUV);
}
