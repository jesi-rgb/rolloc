/**
 * Negative pass 1 — Log normalization
 *
 * Converts linear transmittance to normalized log density, which
 * simultaneously inverts the negative and removes the orange mask.
 *
 * Per channel, per pixel:
 *   0. sRGB → linear (when srgbExpand = 1). The log-density model is defined
 *      on scene-linear transmittance; RAW sources are already linear.
 *   1. rgb = sourceMatrix · rgb, in linear light. Identity for a negative; a RAW
 *      slide's camera matrix with the as-shot white balance folded in
 *      (`slideCameraMatrix` in src/lib/image/negative/transfer.ts).
 *   2. log10(max(pixel, ε))
 *   3. u = (log − floor) / (ceil − floor), UNCLAMPED
 *
 * `floor` is the dense end of the negative (scene highlights) and `ceil` the
 * thin end (film base), so u = 0 is a scene highlight and u = 1 a scene
 * shadow. The bounds are measured CPU-side (src/lib/image/negative/) and
 * already carry the roll baseline. A slide normalizes over the transfer's fixed
 * window (floor 0, ceil −3), so u = D / 3.
 *
 * The output is deliberately NOT clamped to [0, 1]. Densities outside the
 * bounds are rolled off by the print curve's knees in the next pass; clipping
 * here would destroy every highlight and shadow past the bounds before the
 * curve ever saw them.
 *
 * Mirrored by `Normalizer` in src-tauri/src/negative/mod.rs.
 *
 * Uniform layout (96 bytes):
 *   floors     : vec4<f32>  @ 0   (rgb + pad)
 *   ceils      : vec4<f32>  @ 16  (rgb + pad)
 *   matrixCol0 : vec4<f32>  @ 32  (column 0 of sourceMatrix + pad)
 *   matrixCol1 : vec4<f32>  @ 48
 *   matrixCol2 : vec4<f32>  @ 64
 *   srgbExpand : f32        @ 80
 *   _pad0..2   : f32        @ 84..92
 */

struct NormUniforms {
	/// Per-channel log-density floor (dense end). vec3 + pad.
	floors      : vec4<f32>,
	/// Per-channel log-density ceil (thin end). vec3 + pad.
	ceils       : vec4<f32>,
	/// Linear-light source matrix, column-major (each column vec3 + pad).
	matrixCol0  : vec4<f32>,
	matrixCol1  : vec4<f32>,
	matrixCol2  : vec4<f32>,
	/// 1.0 = source is sRGB-encoded and must be gamma-expanded to linear before
	/// the log transform; 0.0 = source is already scene-linear (RAW path).
	srgbExpand  : f32,
	_pad0       : f32,
	_pad1       : f32,
	_pad2       : f32,
}

@group(0) @binding(0) var uSampler  : sampler;
@group(0) @binding(1) var uTexture  : texture_2d<f32>;
@group(0) @binding(2) var<uniform> u : NormUniforms;

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

/// Exact IEC 61966-2-1 sRGB EOTF (gamma-encoded → linear light), so the
/// preview and the native export feed identical linear data into the log.
fn srgb_to_linear(c : f32) -> f32 {
	if (c <= 0.04045) {
		return c / 12.92;
	}
	return pow((c + 0.055) / 1.055, 2.4);
}

@fragment
fn fs_main(in : VertOut) -> @location(0) vec4<f32> {
	let sampled = textureSample(uTexture, uSampler, in.uv).rgb;

	var color = sampled;
	if (u.srgbExpand >= 0.5) {
		color = vec3<f32>(
			srgb_to_linear(sampled.r),
			srgb_to_linear(sampled.g),
			srgb_to_linear(sampled.b),
		);
	}
	color = mat3x3<f32>(u.matrixCol0.xyz, u.matrixCol1.xyz, u.matrixCol2.xyz) * color;

	let eps = 1e-6;
	// log10(v) = ln(v) · log10(e)
	let lc = log(max(color, vec3<f32>(eps))) * 0.43429448190325183;

	let floors = u.floors.rgb;
	let delta  = u.ceils.rgb - floors;
	// Sign-preserving guard against a degenerate window.
	let safeDelta = select(
		sign(delta) * max(abs(delta), vec3<f32>(eps)),
		vec3<f32>(eps),
		delta == vec3<f32>(0.0),
	);

	return vec4<f32>((lc - floors) / safeDelta, 1.0);
}
