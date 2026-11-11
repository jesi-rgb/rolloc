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
 *   exposure      : f32         @ 100                →  4 bytes
 *   shadows       : f32         @ 104                →  4 bytes
 *   highlights    : f32         @ 108                →  4 bytes
 *   dMax          : f32         @ 112                →  4 bytes
 *   vibrance      : f32         @ 116                →  4 bytes
 *   saturation    : f32         @ 120                →  4 bytes
 *   contrast      : f32         @ 124                →  4 bytes
 *   toneGamma     : f32         @ 128                →  4 bytes
 *   blackPoint    : f32         @ 132                →  4 bytes
 *   whitePoint    : f32         @ 136                →  4 bytes
 *   midtoneCurve  : f32         @ 140                →  4 bytes
 *   struct size = 144 bytes
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
	exposure         : f32,     // Lightroom-style exposure in EV stops
	shadows          : f32,     // Lightroom-style shadows, [-1, +1]
	highlights       : f32,     // Lightroom-style highlights, [-1, +1]
	dMax             : f32,
	vibrance         : f32,
	saturation       : f32,
	contrast         : f32,     // Lightroom-style contrast, [-1, +1]
	// ── Tone preset params (vec4 @ 128) ──
	toneGamma        : f32,
	blackPoint       : f32,
	whitePoint       : f32,
	midtoneCurve     : f32,
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
/// Core H&D math matches negpy's _apply_photometric_fused_kernel. This is the
/// fixed film/paper base; exposure, contrast, shadows and highlights are applied
/// afterwards by `apply_tone` in a display-referred domain.
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

	// 6. Adjusted diff (negpy sign convention)
	let diff_adj = diff
		+ shadow_color_offset + highlight_color_offset
		- toe_density_offset + shoulder_density_offset;

	// 7. Contrast damping (toe/shoulder reduce effective contrast)
	let damp_toe      = toe      * toe_mask      * 0.5;
	let damp_shoulder = shoulder * shoulder_mask  * 0.5;
	var k_mod = 1.0 - damp_toe - damp_shoulder;
	k_mod = clamp(k_mod, 0.1, 2.0);

	// 8. H&D sigmoid → print density
	let density = d_max * fast_sigmoid(slope * diff_adj * k_mod);

	// 9. Density → transmittance → perceptual (gamma from tone preset)
	// Matches negpy: transmittance ** (1.0 / gamma)
	let transmittance = pow(10.0, -density);
	var out = clamp(pow(max(transmittance, 0.0), 1.0 / u.toneGamma), 0.0, 1.0);

	// 10. Apply midtone S-curve from tone preset
	// midtoneCurve > 0 adds contrast, < 0 flattens.
	// Uses a simple cubic: out = out + strength * out * (1 - out) * (2*out - 1)
	// This preserves 0 and 1, pushes midtones toward/away from extremes.
	if (u.midtoneCurve != 0.0) {
		out = out + u.midtoneCurve * out * (1.0 - out) * (2.0 * out - 1.0);
		out = clamp(out, 0.0, 1.0);
	}

	// 11. Apply black/white point from tone preset
	out = clamp((out - u.blackPoint) / (u.whitePoint - u.blackPoint), 0.0, 1.0);

	return out;
}

// ─── Lightroom-style tone stage ───────────────────────────────────────────────
//
// Runs after the H&D paper curve, on display-referred RGB in [0,1]. Every
// operator is monotone and endpoint-preserving, so nothing clips or posterises:
//   • Exposure   — linear-light gain with a soft highlight shoulder (EV stops)
//   • Contrast   — S-curve pivoted on mid-grey (smoothstep / its inverse)
//   • Shadows    — gamma lift under a wide luminance mask
//   • Highlights — gamma roll under a wide luminance mask
// Mirrored exactly by `apply_tone` in src-tauri/src/process.rs.

/// Strength cap for the contrast S-curve at ±1.
const CONTRAST_MAX: f32 = 0.85;
/// Gamma travel of the shadows/highlights operators at ±1.
const SH_GAMMA: f32 = 0.6;
/// Linear-light level where the exposure shoulder starts.
const EXP_KNEE: f32 = 0.75;

/// Inverse of smoothstep(0, 1, x) — flattens the S back out for negative contrast.
fn inv_smoothstep(x: f32) -> f32 {
	return 0.5 - sin(asin(clamp(1.0 - 2.0 * x, -1.0, 1.0)) / 3.0);
}

/// Soft shoulder in linear light: identity below the knee, asymptotic to 1 above.
fn soft_shoulder(x: f32) -> f32 {
	if (x <= EXP_KNEE) {
		return x;
	}
	return EXP_KNEE + (1.0 - EXP_KNEE) * (1.0 - exp(-(x - EXP_KNEE) / (1.0 - EXP_KNEE)));
}

/// Contrast S-curve on one channel. `amt` ∈ [-1, +1].
fn contrast_channel(x: f32, amt: f32) -> f32 {
	let k = clamp(amt, -1.0, 1.0) * CONTRAST_MAX;
	let curved = select(inv_smoothstep(x), x * x * (3.0 - 2.0 * x), k > 0.0);
	return clamp(mix(x, curved, abs(k)), 0.0, 1.0);
}

fn apply_tone(rgb_in: vec3<f32>, gamma: f32) -> vec3<f32> {
	var rgb = clamp(rgb_in, vec3<f32>(0.0), vec3<f32>(1.0));

	// ── Exposure: a true stop-based gain in linear light ─────────────────────
	if (u.exposure != 0.0) {
		let gain = pow(2.0, u.exposure);
		let lin = pow(rgb, vec3<f32>(gamma)) * gain;
		let rolled = vec3<f32>(
			soft_shoulder(lin.r),
			soft_shoulder(lin.g),
			soft_shoulder(lin.b),
		);
		rgb = pow(clamp(rolled, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(1.0 / gamma));
	}

	// ── Contrast: pivots on mid-grey, leaves black and white untouched ──────
	if (u.contrast != 0.0) {
		rgb = vec3<f32>(
			contrast_channel(rgb.r, u.contrast),
			contrast_channel(rgb.g, u.contrast),
			contrast_channel(rgb.b, u.contrast),
		);
	}

	// ── Shadows / Highlights: broad luminance-masked gamma moves ────────────
	// Both act on luminance and rescale RGB by the ratio, so hue and saturation
	// survive. The masks are deliberately wide (reaching into the midtones) —
	// that is what makes the sliders feel usable rather than band-limited.
	if (u.shadows != 0.0 || u.highlights != 0.0) {
		let lum = LUMA_R * rgb.r + LUMA_G * rgb.g + LUMA_B * rgb.b;
		var l = lum;

		if (u.shadows != 0.0) {
			let s = clamp(u.shadows, -1.0, 1.0);
			let lifted = pow(l, max(1.0 - SH_GAMMA * s, 0.05));
			let mask = 1.0 - smoothstep(0.0, 0.7, l);
			l = mix(l, lifted, mask);
		}

		if (u.highlights != 0.0) {
			let h = clamp(u.highlights, -1.0, 1.0);
			let rolled = 1.0 - pow(1.0 - l, max(1.0 + SH_GAMMA * h, 0.05));
			let mask = smoothstep(0.3, 1.0, l);
			l = mix(l, rolled, mask);
		}

		// Ratio-preserving rescale; falls back to an additive shift near black.
		if (lum > 1e-4) {
			rgb = clamp(rgb * (l / lum), vec3<f32>(0.0), vec3<f32>(1.0));
		} else {
			rgb = clamp(rgb + (l - lum), vec3<f32>(0.0), vec3<f32>(1.0));
		}
	}

	return rgb;
}

/// Apply vibrance and saturation adjustments.
/// Vibrance is "intelligent" saturation that protects already-saturated colors.
/// Both are applied in the linear/perceptual domain after H&D curve.
fn apply_vibrance_saturation(rgb: vec3<f32>, vibrance: f32, saturation: f32) -> vec3<f32> {
	// Compute luminance for desaturation reference
	let lum = LUMA_R * rgb.r + LUMA_G * rgb.g + LUMA_B * rgb.b;
	let gray = vec3<f32>(lum, lum, lum);
	
	// Saturation: uniform blend toward/away from grayscale
	// saturation = 0: no change, +1: double saturation, -1: grayscale
	let sat_factor = 1.0 + saturation;
	var result = mix(gray, rgb, sat_factor);
	
	// Vibrance: saturation that protects already-saturated colors
	// Compute saturation level (0 = gray, 1 = fully saturated)
	let max_c = max(max(result.r, result.g), result.b);
	let min_c = min(min(result.r, result.g), result.b);
	let chroma = max_c - min_c;
	// Avoid division by zero for very dark/bright pixels
	let sat_level = select(chroma / max(max_c, 0.001), 0.0, max_c < 0.001);
	
	// Vibrance factor: stronger effect on less-saturated pixels
	// When sat_level is low (desaturated), apply full vibrance
	// When sat_level is high (saturated), apply less vibrance
	let vib_strength = vibrance * (1.0 - sat_level);
	let vib_factor = 1.0 + vib_strength;
	
	// Recompute luminance after saturation adjustment
	let lum2 = LUMA_R * result.r + LUMA_G * result.g + LUMA_B * result.b;
	let gray2 = vec3<f32>(lum2, lum2, lum2);
	result = mix(gray2, result, vib_factor);
	
	return clamp(result, vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment
fn fs_main(in : VertOut) -> @location(0) vec4<f32> {
	let color = textureSample(uTexture, uSampler, in.uv).rgb;

	let r = hd_channel(
		color.r, u.pivots.r, u.slopes.r,
		u.cmyOffsets.r, u.shadowCmy.r, u.highlightCmy.r,
		u.toe, u.toeWidth,
		u.shoulder, u.shoulderWidth,
		u.dMax,
	);
	let g = hd_channel(
		color.g, u.pivots.g, u.slopes.g,
		u.cmyOffsets.g, u.shadowCmy.g, u.highlightCmy.g,
		u.toe, u.toeWidth,
		u.shoulder, u.shoulderWidth,
		u.dMax,
	);
	let b = hd_channel(
		color.b, u.pivots.b, u.slopes.b,
		u.cmyOffsets.b, u.shadowCmy.b, u.highlightCmy.b,
		u.toe, u.toeWidth,
		u.shoulder, u.shoulderWidth,
		u.dMax,
	);

	var out_rgb = apply_tone(vec3<f32>(r, g, b), u.toneGamma);

	// B&W mode: convert to luminance (Rec. 709) and output as grayscale
	// This matches negpy's get_luminance() applied post-curve
	if (u.filmType == 1u) {
		let lum = LUMA_R * out_rgb.r + LUMA_G * out_rgb.g + LUMA_B * out_rgb.b;
		return vec4<f32>(lum, lum, lum, 1.0);
	}

	// Apply vibrance and saturation (skip for B&W)
	if (u.vibrance != 0.0 || u.saturation != 0.0) {
		out_rgb = apply_vibrance_saturation(out_rgb, u.vibrance, u.saturation);
	}

	return vec4<f32>(out_rgb, 1.0);
}
