/**
 * Perspective crop pass — samples from a projectively-mapped quadrilateral region
 * of the source texture and maps it to the output rectangle.
 *
 * The four corners of the crop quad are converted CPU-side into an 8-coefficient
 * projective homography:
 *
 *     W     = g*u + h*v + 1
 *     src.x = (a*u + b*v + c) / W
 *     src.y = (d*u + e*v + f) / W
 *
 * For rectangles/parallelograms the denominator is 1, giving the same result as
 * the previous bilinear mapping. For non-parallelogram quads this preserves
 * straight lines and straightens converging edges (keystone correction).
 */

@group(0) @binding(0) var uSampler : sampler;
@group(0) @binding(1) var uTexture : texture_2d<f32>;
@group(0) @binding(2) var<uniform> uCrop : CropUniforms;

struct CropUniforms {
	h0 : vec4<f32>,  // (a, b, c, d)
	h1 : vec4<f32>,  // (e, f, g, h)
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
 * Projective evaluation of the homography mapping output uv ∈ [0,1]² to source uv.
 */
fn projectiveSample(uv : vec2<f32>) -> vec2<f32> {
	let a = uCrop.h0.x;
	let b = uCrop.h0.y;
	let c = uCrop.h0.z;
	let d = uCrop.h0.w;
	let e = uCrop.h1.x;
	let f = uCrop.h1.y;
	let g = uCrop.h1.z;
	let h = uCrop.h1.w;

	let W = g * uv.x + h * uv.y + 1.0;
	return vec2<f32>(
		(a * uv.x + b * uv.y + c) / W,
		(d * uv.x + e * uv.y + f) / W,
	);
}

@fragment
fn fs_main(in : VertOut) -> @location(0) vec4<f32> {
	// Map output UV to source UV via the projective homography
	let srcUV = projectiveSample(in.uv);

	// Sample the source texture at the computed UV
	// Out-of-bounds UVs will be clamped by the sampler
	return textureSample(uTexture, uSampler, srcUV);
}
