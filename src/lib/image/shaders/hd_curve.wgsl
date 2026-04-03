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
 *   3. Compute toe / shoulder sigmoid masks for localized CMY and density shifts
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
 * For B&W mode (filmType == 1), the output is converted to luminance after
 * the H&D curve and the result is spread across all three channels. This
 * matches negpy's approach where get_luminance() is applied post-curve.
 *
 * filmType uniform values:
 *   0 = C41 (color negative) — default behavior
 *   1 = BW  (black & white negative) — convert to luminance post-curve
 *   2 = E6  (slide/reversal positive) — same as C41 (no special handling here)
 *
 * Uniform struct is aligned to 16-byte boundaries (WGSL rules):
 *   pivots        : vec4<f32>   @ 0   (rgb + pad)    → 16 bytes
 *   slopes        : vec4<f32>   @ 16  (rgb + pad)    → 16 bytes
 *   cmyOffsets    : vec4<f32>   @ 32  (rgb + pad)    → 16 bytes
 *   shadowCmy     : vec4<f32>   @ 48  (rgb + pad)    → 16 bytes
 *   highlightCmy  : vec4<f32>   @ 64  (rgb + pad)    → 16 bytes
 *   toe           : f32         @ 80                 →  4 bytes
 *   toeWidth      : f32         @ 84                 →  4 bytes
 *   filmType      : u32         @ 88                 →  4 bytes
 *   shoulder      : f32         @ 92                 →  4 bytes
 *   shoulderWidth : f32         @ 96                 →  4 bytes
 *   _unused1      : f32         @ 100                →  4 bytes
 *   shadows       : f32         @ 104                →  4 bytes
 *   highlights    : f32         @ 108                →  4 bytes
 *   dMax          : f32         @ 112                →  4 bytes
 *   _pad0         : f32         @ 116                →  4 bytes
 *   _pad1         : f32         @ 120                →  4 bytes
 *   _pad2         : f32         @ 124                →  4 bytes
 *   struct size = 128 bytes
 */

// Rec. 709 luminance coefficients (matches negpy's LUMA_R, LUMA_G, LUMA_B)
const LUMA_R: f32 = 0.2126;
const LUMA_G: f32 = 0.7152;
const LUMA_B: f32 = 0.0722;

struct HDCurveUniforms {
	pivots           : vec4<f32>,
	slopes           : vec4<f32>,
	cmyOffsets       : vec4<f32>,
	shadowCmy        : vec4<f32>,
	highlightCmy     : vec4<f32>,
	toe              : f32,
	toeWidth         : f32,
	filmType         : u32,     // 0 = C41, 1 = BW, 2 = E6
	shoulder         : f32,
	shoulderWidth    : f32,
	_unused1         : f32,
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
///
/// Core H&D math matches negpy's _apply_photometric_fused_kernel.
/// shadows/highlights are Rolloc extensions: global density level controls
/// that use the toe/shoulder sigmoid masks to target shadow/highlight regions.
fn hd_channel(
	pixel       : f32,
	pivot       : f32,
	slope       : f32,
	cmy_offset  : f32,
	shadow_cmy  : f32,
	hi_cmy      : f32,
	toe         : f32,
	toe_width   : f32,
	shoulder    : f32,
	sh_width    : f32,
	shadows     : f32,
	highlights  : f32,
	d_max       : f32,
) -> f32 {
	let eps = 1e-6;

	// 1. Global CMY shift
	let val  = pixel + cmy_offset;
	let diff = val - pivot;

	// 2. Toe mask (shadows): active at high diff (dense in negative space)
	// negpy: toe_width * (diff / max(1.0 - pivot, eps) - 0.5)
	let t_val = toe_width * (diff / max(1.0 - pivot, eps) - 0.5);
	let toe_mask = fast_sigmoid(t_val);

	// 3. Shoulder mask (highlights): active at low diff (thin in negative space)
	// negpy: -shoulder_width * (diff / max(pivot, eps) + 0.5)
	let s_val = -sh_width * (diff / max(pivot, eps) + 0.5);
	let shoulder_mask = fast_sigmoid(s_val);

	// 4. Density offsets (multiplier 0.1 matches negpy)
	let toe_density_offset      = toe      * toe_mask      * 0.1;
	let shoulder_density_offset = shoulder * shoulder_mask  * 0.1;

	// 5. Localized CMY color shifts via toe/shoulder masks
	let shadow_color_offset    = shadow_cmy * toe_mask;
	let highlight_color_offset = hi_cmy     * shoulder_mask;

	// 5b. Shadows/Highlights global density level controls (Rolloc extension).
	//     Uses the same sigmoid masks as toe/shoulder to target the same regions.
	let shadow_level_offset    = shadows    * toe_mask      * 0.1;
	let highlight_level_offset = highlights * shoulder_mask  * 0.1;

	// 6. Adjusted diff (negpy sign convention + Rolloc shadows/highlights extension)
	let diff_adj = diff
		+ shadow_color_offset + highlight_color_offset
		- toe_density_offset + shoulder_density_offset
		- shadow_level_offset + highlight_level_offset;

	// 7. Contrast damping (toe/shoulder reduce effective contrast)
	let damp_toe      = toe      * toe_mask      * 0.5;
	let damp_shoulder = shoulder * shoulder_mask  * 0.5;
	var k_mod = 1.0 - damp_toe - damp_shoulder;
	k_mod = clamp(k_mod, 0.1, 2.0);

	// 8. H&D sigmoid → print density
	let density = d_max * fast_sigmoid(slope * diff_adj * k_mod);

	// 9. Density → transmittance → perceptual (gamma 1/2.2)
	// Matches negpy: transmittance ** (1.0 / gamma) where gamma = 2.2
	let transmittance = pow(10.0, -density);
	return clamp(pow(max(transmittance, 0.0), 1.0 / 2.2), 0.0, 1.0);
}

@fragment
fn fs_main(in : VertOut) -> @location(0) vec4<f32> {
	let color = textureSample(uTexture, uSampler, in.uv).rgb;

	let r = hd_channel(
		color.r, u.pivots.r, u.slopes.r,
		u.cmyOffsets.r, u.shadowCmy.r, u.highlightCmy.r,
		u.toe, u.toeWidth,
		u.shoulder, u.shoulderWidth,
		u.shadows, u.highlights, u.dMax,
	);
	let g = hd_channel(
		color.g, u.pivots.g, u.slopes.g,
		u.cmyOffsets.g, u.shadowCmy.g, u.highlightCmy.g,
		u.toe, u.toeWidth,
		u.shoulder, u.shoulderWidth,
		u.shadows, u.highlights, u.dMax,
	);
	let b = hd_channel(
		color.b, u.pivots.b, u.slopes.b,
		u.cmyOffsets.b, u.shadowCmy.b, u.highlightCmy.b,
		u.toe, u.toeWidth,
		u.shoulder, u.shoulderWidth,
		u.shadows, u.highlights, u.dMax,
	);

	// B&W mode: convert to luminance (Rec. 709) and output as grayscale
	// This matches negpy's get_luminance() applied post-curve
	if (u.filmType == 1u) {
		let lum = LUMA_R * r + LUMA_G * g + LUMA_B * b;
		return vec4<f32>(lum, lum, lum, 1.0);
	}

	return vec4<f32>(r, g, b, 1.0);
}
