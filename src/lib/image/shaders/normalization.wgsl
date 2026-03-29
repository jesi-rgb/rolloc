/**
 * NegPy Pass — Log normalization
 *
 * Converts linear transmittance values to normalized log-density, which
 * simultaneously inverts the negative and removes the orange mask.
 *
 * Algorithm (per channel, per pixel):
 *   1. log10(clamp(pixel, ε, 1.0))       — convert to log-density space
 *   2. clamp((log - floor) / (ceil - floor), 0, 1)  — stretch per channel
 *      For C-41: floor < ceil → inverts the negative automatically.
 *
 * floors / ceils are computed CPU-side from per-channel percentiles of the
 * full image (0.5th / 99.5th) and passed as uniforms.
 *
 * This pass is only executed when invert = 1u. When disabled the shader is
 * bypassed and the source texture is read directly by the hd_curve pass.
 */

struct NormUniforms {
	/// Per-channel log-density floor (0.5th percentile). vec3 + pad.
	floors      : vec4<f32>,
	/// Per-channel log-density ceil (99.5th percentile). vec3 + pad.
	ceils       : vec4<f32>,
	/// Optional shadow cast correction vector (rgb + pad). Applied weighted by density^1.5.
	shadowCast  : vec4<f32>,
	/// Shadow cast correction strength [0,1].
	shadowStrength : f32,
	/// Manual white-point offset in log space (shifts ceils).
	wpOffset    : f32,
	/// Manual black-point offset in log space (shifts floors).
	bpOffset    : f32,
	_pad        : f32,
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

/// log10(v) = log(v) * log10(e)
fn log10_f(v : f32) -> f32 {
	return log(v) * 0.43429448190325183;
}

@fragment
fn fs_main(in : VertOut) -> @location(0) vec4<f32> {
	let color = textureSample(uTexture, uSampler, in.uv).rgb;

	let eps = 1e-6;

	// 1. Log conversion
	let lc = vec3<f32>(
		log10_f(max(color.r, eps)),
		log10_f(max(color.g, eps)),
		log10_f(max(color.b, eps)),
	);

	// 2. Per-channel linear stretch [floor, ceil] → [0, 1]
	//    Independent per-channel stretch removes the orange mask and inverts.
	let floors = u.floors.rgb + vec3<f32>(u.bpOffset);
	let ceils  = u.ceils.rgb  + vec3<f32>(u.wpOffset);
	let delta  = ceils - floors;
	// Guard against degenerate range (divide by near-zero).
	let safeDelta = sign(delta) * max(abs(delta), vec3<f32>(eps));

	var res = clamp((lc - floors) / safeDelta, vec3<f32>(0.0), vec3<f32>(1.0));

	// 3. Optional shadow cast correction (removes residual color cast in shadows).
	if (u.shadowStrength > 0.0) {
		let density = (res.r + res.g + res.b) / 3.0;
		let weight  = pow(density, 1.5);
		let correction = u.shadowCast.rgb * weight * u.shadowStrength;
		res = clamp(res + correction, vec3<f32>(0.0), vec3<f32>(1.0));
	}

	return vec4<f32>(res, 1.0);
}
