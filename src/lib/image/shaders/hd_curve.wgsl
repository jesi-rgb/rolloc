/**
 * NegPy Pass — H&D characteristic curve (photographic paper response)
 *
 * Takes the normalized log-density image from the normalization pass and maps it
 * through a logistic sigmoid that simulates the Hurter & Driffield characteristic
 * curve of photographic paper.
 *
 * Full pipeline per channel:
 *   1. Apply global CMY log-space offset  (color timing, like dichroic filters)
 *   2. Compute diff = (val + cmy_offset) - pivot
 *   3. Compute Gaussian shadow/highlight masks for localized CMY and density shifts
 *   4. Compute toe / shoulder sigmoid damping → k_mod
 *   5. density = D_max × sigmoid(slope × diff_adj × k_mod)
 *   6. transmittance = 10^(-density)
 *   7. output = transmittance^(1/2.2)  ← gamma-encoded (matches negpy)
 *
 * The 1/2.2 gamma is part of negpy's paper simulation (not display sRGB).
 * The tonecurve pass skips its sRGB encode when receiving this output.
 * The "invert" is already baked in by the normalization pass (log stretch).
 * This pass is purely the paper-print simulation.
 *
 * Uniform struct is aligned to 16-byte boundaries (WGSL rules):
 *   pivots        : vec4<f32>   @ 0   (rgb + pad)    → 16 bytes
 *   slopes        : vec4<f32>   @ 16  (rgb + pad)    → 16 bytes
 *   cmyOffsets    : vec4<f32>   @ 32  (rgb + pad)    → 16 bytes
 *   shadowCmy     : vec4<f32>   @ 48  (rgb + pad)    → 16 bytes
 *   highlightCmy  : vec4<f32>   @ 64  (rgb + pad)    → 16 bytes
 *   toe           : f32         @ 80                 →  4 bytes
 *   toeWidth      : f32         @ 84                 →  4 bytes
 *   toeHardness   : f32         @ 88                 →  4 bytes
 *   shoulder      : f32         @ 92                 →  4 bytes
 *   shoulderWidth : f32         @ 96                 →  4 bytes
 *   shoulderHardness: f32       @ 100                →  4 bytes
 *   shadows       : f32         @ 104                →  4 bytes
 *   highlights    : f32         @ 108                →  4 bytes
 *   dMax          : f32         @ 112                →  4 bytes
 *   _pad0         : f32         @ 116                →  4 bytes
 *   _pad1         : f32         @ 120                →  4 bytes
 *   _pad2         : f32         @ 124                →  4 bytes
 *   struct size = 128 bytes
 */

struct HDCurveUniforms {
	pivots           : vec4<f32>,
	slopes           : vec4<f32>,
	cmyOffsets       : vec4<f32>,
	shadowCmy        : vec4<f32>,
	highlightCmy     : vec4<f32>,
	toe              : f32,
	toeWidth         : f32,
	toeHardness      : f32,
	shoulder         : f32,
	shoulderWidth    : f32,
	shoulderHardness : f32,
	shadows          : f32,
	highlights       : f32,
	dMax             : f32,
	_pad0            : f32,
	_pad1            : f32,
	_pad2            : f32,
}

@group(0) @binding(0) var uSampler : sampler;
@group(0) @binding(1) var uTexture : texture_2d<f32>;
@group(0) @binding(2) var<uniform> u : HDCurveUniforms;

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

/// Numerically stable logistic sigmoid.
fn fast_sigmoid(x : f32) -> f32 {
	if (x >= 0.0) {
		return 1.0 / (1.0 + exp(-x));
	}
	let z = exp(x);
	return z / (1.0 + z);
}

/// Apply the full H&D pipeline to one channel.
/// Returns gamma-encoded (1/2.2) transmittance in [0, 1].
fn hd_channel(
	pixel       : f32,
	pivot       : f32,
	slope       : f32,
	cmy_offset  : f32,
	shadow_cmy  : f32,
	hi_cmy      : f32,
	toe         : f32,
	toe_width   : f32,
	toe_hard    : f32,
	shoulder    : f32,
	sh_width    : f32,
	sh_hard     : f32,
	shadows     : f32,
	highlights  : f32,
	d_max       : f32,
) -> f32 {
	let eps = 1e-6;

	// 1. Global CMY shift
	let val  = pixel + cmy_offset;
	let diff = val - pivot;

	// 2. Shadow / highlight localized Gaussian masks
	let s_center = (1.0 - pivot) * 0.9;
	let h_center = (0.0 - pivot) * 0.9;

	let s_mask = exp(-(pow(diff - s_center, 2.0)) / 0.15);
	let shadow_density_offset = shadows     * s_mask * 0.3;
	let shadow_color_offset   = shadow_cmy  * s_mask;

	let h_mask = exp(-(pow(diff - h_center, 2.0)) / 0.15);
	let hi_density_offset     = highlights  * h_mask * 0.3;
	let hi_color_offset       = hi_cmy      * h_mask;

	let diff_adj = diff
		+ shadow_color_offset + hi_color_offset
		- shadow_density_offset - hi_density_offset;

	// 3. Shoulder damping
	let sw_val  = sh_width * (diff_adj / max(pivot, eps));
	let w_s     = fast_sigmoid(sw_val);
	let prot_s  = pow(4.0 * pow(w_s - 0.5, 2.0), sh_hard);
	let damp_sh = shoulder * (1.0 - w_s) * prot_s;

	// 4. Toe damping
	let tw_val  = toe_width * (diff_adj / max(1.0 - pivot, eps));
	let w_t     = fast_sigmoid(tw_val);
	let prot_t  = pow(4.0 * pow(w_t - 0.5, 2.0), toe_hard);
	let damp_t  = toe * w_t * prot_t;

	// 5. Effective contrast
	var k_mod = 1.0 - damp_t - damp_sh;
	k_mod = clamp(k_mod, 0.1, 2.0);

	// 6. H&D sigmoid → print density
	let density = d_max * fast_sigmoid(slope * diff_adj * k_mod);

	// 7. Density → transmittance → perceptual (gamma 1/2.2)
	// Matches negpy: transmittance ** (1.0 / gamma) where gamma = 2.2
	let transmittance = clamp(pow(10.0, -density), 0.0, 1.0);
	return pow(transmittance, 1.0 / 2.2);
}

@fragment
fn fs_main(in : VertOut) -> @location(0) vec4<f32> {
	let color = textureSample(uTexture, uSampler, in.uv).rgb;

	let r = hd_channel(
		color.r, u.pivots.r, u.slopes.r,
		u.cmyOffsets.r, u.shadowCmy.r, u.highlightCmy.r,
		u.toe, u.toeWidth, u.toeHardness,
		u.shoulder, u.shoulderWidth, u.shoulderHardness,
		u.shadows, u.highlights, u.dMax,
	);
	let g = hd_channel(
		color.g, u.pivots.g, u.slopes.g,
		u.cmyOffsets.g, u.shadowCmy.g, u.highlightCmy.g,
		u.toe, u.toeWidth, u.toeHardness,
		u.shoulder, u.shoulderWidth, u.shoulderHardness,
		u.shadows, u.highlights, u.dMax,
	);
	let b = hd_channel(
		color.b, u.pivots.b, u.slopes.b,
		u.cmyOffsets.b, u.shadowCmy.b, u.highlightCmy.b,
		u.toe, u.toeWidth, u.toeHardness,
		u.shoulder, u.shoulderWidth, u.shoulderHardness,
		u.shadows, u.highlights, u.dMax,
	);

	return vec4<f32>(r, g, b, 1.0);
}
