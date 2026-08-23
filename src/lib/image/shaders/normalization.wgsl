/**
 * NegPy Pass — Log normalization
 *
 * Converts linear transmittance values to normalized log-density, which
 * simultaneously inverts the negative and removes the orange mask.
 *
 * Algorithm (per channel, per pixel):
 *   0. sRGB → linear (when srgbExpand = 1) — the log-density model is defined
 *      on scene-linear transmittance.  RAW sources are already linear and set
 *      srgbExpand = 0.
 *   1. log10(max(pixel, ε))              — convert to log-density space
 *   2. (log - floor) / (ceil - floor)    — stretch per channel, UNCLAMPED
 *      For C-41/BW: floor < ceil → inverts the negative automatically.
 *      For E-6: floor > ceil → no inversion (slide film is already positive)
 *
 * The output is deliberately NOT clamped to [0, 1].  Densities outside the
 * measured floor/ceil bounds are rolled off by the H&D curve's sigmoid in the
 * next pass, which is bounded by construction (density ∈ [0, dMax]).  Hard
 * clipping here would destroy every highlight above the ceil percentile and
 * every shadow below the floor before the curve ever saw them, producing the
 * abrupt digital clipping the softplus/sigmoid rolloff exists to avoid.
 *
 * floors / ceils are computed CPU-side from per-channel analysis of the
 * full image and passed as uniforms.  Floors use the mean of pixels below
 * the 0.001th percentile of mean luminance; ceils use the 99.999th
 * per-channel percentile.  Analysis crops 10% of each edge (matching
 * negpy's ProcessConfig.analysis_buffer = 0.10).
 *
 * For E-6 (slide) film, the percentiles are swapped (floor = bright, ceil = dark)
 * so the output is not inverted — matching negpy's behavior.
 *
 * filmType uniform values:
 *   0 = C41 (color negative)
 *   1 = BW  (black & white negative)
 *   2 = E6  (slide/reversal positive)
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
	/// Film type: 0 = C41, 1 = BW, 2 = E6
	filmType    : u32,
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

/// log10(v) = log(v) * log10(e)
fn log10_f(v : f32) -> f32 {
	return log(v) * 0.43429448190325183;
}

/// Exact IEC 61966-2-1 sRGB EOTF (gamma-encoded → linear light).
/// Mirrors `srgb_to_linear` in invert.wgsl and export.rs so the preview and the
/// native export feed identical linear data into the log transform.
fn srgb_to_linear(c : f32) -> f32 {
	if (c <= 0.04045) {
		return c / 12.92;
	}
	return pow((c + 0.055) / 1.055, 2.4);
}

@fragment
fn fs_main(in : VertOut) -> @location(0) vec4<f32> {
	let sampled = textureSample(uTexture, uSampler, in.uv).rgb;

	// 0. sRGB → linear.  The log-density model is defined on linear
	//    transmittance; log10 of a gamma-encoded value is not related to
	//    log10 of the linear value by any affine map, so the floor/ceil
	//    stretch would be measuring a different quantity than the exporter.
	var color = sampled;
	if (u.srgbExpand >= 0.5) {
		color = vec3<f32>(
			srgb_to_linear(sampled.r),
			srgb_to_linear(sampled.g),
			srgb_to_linear(sampled.b),
		);
	}

	let eps = 1e-6;

	// 1. Log conversion
	let lc = vec3<f32>(
		log10_f(max(color.r, eps)),
		log10_f(max(color.g, eps)),
		log10_f(max(color.b, eps)),
	);

	// 2. Per-channel linear stretch [floor, ceil] → [0, 1]
	//    Independent per-channel stretch removes the orange mask and inverts.
	//    For E6 (filmType == 2), the offsets are inverted to match negpy behavior.
	var wp_off = u.wpOffset;
	var bp_off = u.bpOffset;
	if (u.filmType == 2u) {
		// E6 slide film: invert the manual offset directions
		wp_off = -u.wpOffset;
		bp_off = -u.bpOffset;
	}

	let floors = u.floors.rgb + vec3<f32>(bp_off);
	let ceils  = u.ceils.rgb  + vec3<f32>(wp_off);
	let delta  = ceils - floors;
	// Guard against degenerate range (divide by near-zero).
	// Use sign-preserving epsilon to handle both negative (C41/BW) and positive (E6) ranges.
	let safeDelta = sign(delta) * max(abs(delta), vec3<f32>(eps));

	// Deliberately unclamped — see the header note.  The H&D sigmoid in the
	// next pass is bounded, so out-of-range values roll off smoothly instead
	// of being hard-clipped here.
	var res = (lc - floors) / safeDelta;

	// 3. Optional shadow cast correction (removes residual color cast in shadows).
	if (u.shadowStrength > 0.0) {
		// Weight by in-range density only; out-of-range values must not
		// amplify the correction beyond its intended footprint.
		let density = clamp((res.r + res.g + res.b) / 3.0, 0.0, 1.0);
		let weight  = pow(density, 1.5);
		let correction = u.shadowCast.rgb * weight * u.shadowStrength;
		res = res + correction;
	}

	return vec4<f32>(res, 1.0);
}
