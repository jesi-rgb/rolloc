/**
 * Print pass — NegPy 0.68 print curve (photographic paper response) or, for a slide, the
 * transparency transfer, then the tone stage.
 *
 * Takes the normalized value u (unclamped) from the normalization pass. A negative (0 = scene
 * highlight, 1 = film base) is printed. B&W first collapses the channels to one value,
 * u = bwWeights · (u_r, u_g, u_b), printed once on the base (green) curve. Per channel:
 *   1. x = u + cmyOffset                                   (global filtration)
 *   2. v = k·(x − pivot) + curv·x², held at the vertex     (straight line / Cast Removal core)
 *   3. v += midtoneAmp · tanh((v − vStar) / gammaWidth)    (variable-gamma paper S-curve)
 *   4. v += shadowCmy·w + highlightCmy·(1 − w),
 *      w = sigmoid(regionalSharpness · (v − regionalCentre))   (regional CMY)
 *   5. v1 = dMinEff + softplus(aHl·(v − dMinEff)) / aHl     (shoulder → paper white)
 *   6. D  = dMaxEff − softplus(aSh·(dMaxEff − v1)) / aSh    (toe → paper black)
 *   7. T  = max((10^−D − bpcBlack) / (1 − bpcBlack), 0)     (black point compensation)
 *   8. out = T^(1/toneGamma), midtone curve, black/white point (tone preset)
 * A slide (u = D / 3 over the fixed window, 0 = the source's white) goes through the transfer
 * instead, exactly the identity at default settings:
 *   1. D = k·(u + cmyOffset − pivot)                       (solve: k = 3, pivot = 0)
 *   2. D += shadowCmy·w + highlightCmy·(1 − w), w as step 4 with the transfer's split geometry
 *   3. D −= toe · w·softplus((D − toeKnee) / w),  w = kneeWidth            (shadow roll-off)
 *   4. D += shoulder · w·softplus((shoulderKnee − D) / w)                  (highlight roll-off)
 *   5. scene-linear source: T = displayRendering(sceneGain · 10^−D) (baseline EV + ACES fit);
 *      display-referred source: T = srgbEncode(10^−D)^displayGamma
 *   6. step 8 above (the shared tone-preset encode)
 * then the Lightroom-style tone stage, B&W luma (a safeguard: the channels are already equal),
 * vibrance/saturation.
 *
 * The print ports NegPy's exposure.wgsl / negpy_core print_curve.rs, the transfer NegPy's
 * transfer.wgsl / negpy_core transfer.rs. Every per-frame value (vStar, knees, BPC black) and
 * every curve constant is computed on the CPU by `packPrintCurveUniforms` in
 * src/lib/image/negative/print-curve.ts, so this kernel and the scalar mirrors (print-curve.ts,
 * transfer.ts; src-tauri/src/negative/curve.rs, transfer.rs) share one prologue.
 *
 * filmType: 0 = C41, 1 = BW (one density before the curve, luminance after it), 2 = E6 (the
 * transfer instead of the print).
 *
 * Uniform layout (std140-compatible, written by packPrintCurveUniforms):
 *   slopes            : vec4<f32>  @ 0    (rgb + pad)
 *   pivots            : vec4<f32>  @ 16   (rgb + pad)
 *   curvatures        : vec4<f32>  @ 32   (rgb + pad)
 *   cmyOffsets        : vec4<f32>  @ 48   (rgb + pad)
 *   shadowCmy         : vec4<f32>  @ 64   (rgb + pad)
 *   highlightCmy      : vec4<f32>  @ 80   (rgb + pad)
 *   vStar             : f32        @ 96
 *   dMinEff           : f32        @ 100
 *   dMaxEff           : f32        @ 104
 *   aHl               : f32        @ 108
 *   aSh               : f32        @ 112
 *   bpcBlack          : f32        @ 116
 *   filmType          : u32        @ 120
 *   exposure          : f32        @ 124
 *   contrast          : f32        @ 128
 *   shadows           : f32        @ 132
 *   highlights        : f32        @ 136
 *   vibrance          : f32        @ 140
 *   saturation        : f32        @ 144
 *   toneGamma         : f32        @ 148
 *   blackPoint        : f32        @ 152
 *   whitePoint        : f32        @ 156
 *   midtoneCurve      : f32        @ 160
 *   midtoneAmp        : f32        @ 164  (PAPER_MIDTONE_GAMMA · PAPER_GAMMA_WIDTH)
 *   gammaWidth        : f32        @ 168  (PAPER_GAMMA_WIDTH)
 *   regionalCentre    : f32        @ 172  (REFERENCE_PRINT_DENSITY; E6: wbSplitGeometry centre)
 *   regionalSharpness : f32        @ 176  (REGIONAL_CMY_SHARPNESS; E6: wbSplitGeometry sharpness)
 *   bwWeightR         : f32        @ 180  (BW_FILTER_WEIGHTS_NONE, NegPy BwFilter.NONE)
 *   bwWeightG         : f32        @ 184
 *   bwWeightB         : f32        @ 188
 *   toeKnee           : f32        @ 192  (TRANSFER_TOE_KNEE)
 *   shoulderKnee      : f32        @ 196  (TRANSFER_SHOULDER_KNEE)
 *   kneeWidth         : f32        @ 200  (TRANSFER_KNEE_WIDTH)
 *   toe               : f32        @ 204  (curve toe; the transfer reads it, the print its prologue)
 *   shoulder          : f32        @ 208  (curve shoulder, likewise)
 *   sceneGain         : f32        @ 212  (TRANSFER_BASELINE_GAIN = 2^TRANSFER_BASELINE_EV)
 *   displayReferred   : u32        @ 216  (1 = 8-bit / bitmap source, 0 = scene-linear RAW)
 *   displayGamma      : f32        @ 220  (STANDARD_TONE_GAMMA)
 *   struct size = 224 bytes
 */

// Rec. 709 luminance coefficients (matches negpy's LUMA_R, LUMA_G, LUMA_B)
const LUMA_R: f32 = 0.2126;
const LUMA_G: f32 = 0.7152;
const LUMA_B: f32 = 0.0722;

struct HDCurveUniforms {
	slopes            : vec4<f32>,
	pivots            : vec4<f32>,
	curvatures        : vec4<f32>,
	cmyOffsets        : vec4<f32>,
	shadowCmy         : vec4<f32>,
	highlightCmy      : vec4<f32>,
	vStar             : f32,
	dMinEff           : f32,
	dMaxEff           : f32,
	aHl               : f32,
	aSh               : f32,
	bpcBlack          : f32,
	filmType          : u32,     // 0 = C41, 1 = BW, 2 = E6
	exposure          : f32,     // Lightroom-style exposure in EV stops
	contrast          : f32,     // Lightroom-style contrast, [-1, +1]
	shadows           : f32,     // Lightroom-style shadows, [-1, +1]
	highlights        : f32,     // Lightroom-style highlights, [-1, +1]
	vibrance          : f32,
	saturation        : f32,
	toneGamma         : f32,
	blackPoint        : f32,
	whitePoint        : f32,
	midtoneCurve      : f32,
	midtoneAmp        : f32,
	gammaWidth        : f32,
	regionalCentre    : f32,
	regionalSharpness : f32,
	bwWeightR         : f32,
	bwWeightG         : f32,
	bwWeightB         : f32,
	toeKnee           : f32,
	shoulderKnee      : f32,
	kneeWidth         : f32,
	toe               : f32,
	shoulder          : f32,
	sceneGain         : f32,
	displayReferred   : u32,
	displayGamma      : f32,
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

/// Overflow-free softplus log(1 + exp(x)).
fn softplus(x : f32) -> f32 {
	return max(x, 0.0) + log(1.0 + exp(-abs(x)));
}

/// Print density of one channel at normalized value `norm` (steps 1–6 of the header).
/// Mirrors `printDensity` in src/lib/image/negative/print-curve.ts.
fn print_density(
	norm         : f32,
	k            : f32,
	pivot        : f32,
	curv         : f32,
	cmy_offset   : f32,
	shadow_cmy   : f32,
	hi_cmy       : f32,
) -> f32 {
	var x = norm + cmy_offset;
	// NegPy quadratic_core: held at the vertex where the quadratic would fold back.
	if (curv != 0.0) {
		let vertex = -k / (2.0 * curv);
		if ((curv > 0.0 && x < vertex) || (curv < 0.0 && x > vertex)) {
			x = vertex;
		}
	}
	var v = k * (x - pivot) + curv * x * x;

	// Paper S-curve. The argument is clamped because some backends build tanh from exp and
	// overflow to NaN; tanh(±10) is already ±1 in f32, so the value is unchanged.
	let s = clamp((v - u.vStar) / u.gammaWidth, -10.0, 10.0);
	v = v + u.midtoneAmp * tanh(s);

	// Regional CMY: the shadow weight rises with density, the highlight weight falls.
	let w = fast_sigmoid(u.regionalSharpness * (v - u.regionalCentre));
	v = v + shadow_cmy * w + hi_cmy * (1.0 - w);

	let v1 = u.dMinEff + softplus(u.aHl * (v - u.dMinEff)) / u.aHl;
	return u.dMaxEff - softplus(u.aSh * (u.dMaxEff - v1)) / u.aSh;
}

/// Density → display-referred print value (steps 7–8 of the header), in [0, 1].
fn encode_print(density : f32) -> f32 {
	// Black point compensation: paper black → display black.
	let t = pow(10.0, -density);
	return encode_tone(max((t - u.bpcBlack) / (1.0 - u.bpcBlack), 0.0));
}

/// The tone-preset encode of a display-linear value (step 8), shared by print and transfer.
fn encode_tone(transmittance : f32) -> f32 {
	// Perceptual encode with the tone preset gamma.
	var out = clamp(pow(transmittance, 1.0 / u.toneGamma), 0.0, 1.0);

	// Midtone S-curve from the tone preset: midtoneCurve > 0 adds contrast, < 0 flattens.
	// out + strength · out · (1 − out) · (2·out − 1) preserves 0 and 1.
	if (u.midtoneCurve != 0.0) {
		out = out + u.midtoneCurve * out * (1.0 - out) * (2.0 * out - 1.0);
		out = clamp(out, 0.0, 1.0);
	}

	// Black/white point from the tone preset.
	out = clamp((out - u.blackPoint) / (u.whitePoint - u.blackPoint), 0.0, 1.0);

	return out;
}

// ─── Transparency transfer (slides) ───────────────────────────────────────────

/// width · log(1 + exp(−|x| / width)): NegPy's `_softplus(x, width)` less its max(x, 0) part,
/// which the knees apply as a pull toward the knee instead.
fn softplus_tail(x : f32, width : f32) -> f32 {
	return width * log(1.0 + exp(-abs(x) / width));
}

/// Scene-linear → display-linear: Narkowicz's closed-form fit to the ACES RRT + sRGB ODT
/// (NegPy `display_rendering`). Monotonic on [0, ∞), 0 → 0, clamped to 1.
fn display_rendering(v : f32) -> f32 {
	let x = max(v, 0.0);
	let num = x * (2.51 * x + 0.03);
	let den = x * (2.43 * x + 0.59) + 0.14;
	return clamp(num / max(den, 1e-8), 0.0, 1.0);
}

/// IEC 61966-2-1 sRGB OETF: the inverse of the EOTF the normalization pass expanded with.
fn srgb_encode(c : f32) -> f32 {
	if (c <= 0.0031308) {
		return c * 12.92;
	}
	return 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}

/// Display-linear value of one slide channel at normalized value `norm` (transfer steps 1–5 of
/// the header). Mirrors `transferDisplay` in src/lib/image/negative/transfer.ts. Past a knee the
/// linear part of its softplus is applied as (1 − a)·D + a·knee, so a full roll-off flattens
/// onto the knee without cancelling D against itself and stays monotonic in f32.
fn transfer_display(
	norm         : f32,
	k            : f32,
	pivot        : f32,
	cmy_offset   : f32,
	shadow_cmy   : f32,
	hi_cmy       : f32,
) -> f32 {
	var d = k * (norm + cmy_offset - pivot);
	if (shadow_cmy != 0.0 || hi_cmy != 0.0) {
		let w = fast_sigmoid(u.regionalSharpness * (d - u.regionalCentre));
		d = d + shadow_cmy * w + hi_cmy * (1.0 - w);
	}
	if (u.toe != 0.0) {
		let x = d - u.toeKnee;
		let pulled = select(d, (1.0 - u.toe) * d + u.toe * u.toeKnee, x > 0.0);
		d = pulled - u.toe * softplus_tail(x, u.kneeWidth);
	}
	if (u.shoulder != 0.0) {
		let x = u.shoulderKnee - d;
		let pulled = select(d, (1.0 - u.shoulder) * d + u.shoulder * u.shoulderKnee, x > 0.0);
		d = pulled + u.shoulder * softplus_tail(x, u.kneeWidth);
	}
	let transmittance = pow(10.0, -d);
	if (u.displayReferred != 0u) {
		return pow(srgb_encode(clamp(transmittance, 0.0, 1.0)), u.displayGamma);
	}
	return display_rendering(transmittance * u.sceneGain);
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

	var printed : vec3<f32>;
	if (u.filmType == 1u) {
		// B&W: one weighted density before the curve (NegPy exposure.wgsl `params.bw`), so
		// channel differences in the scan cannot tint the tone scale. Solve shares one curve
		// across the channels and zeroes the colour filtration for B&W.
		let v = dot(color, vec3<f32>(u.bwWeightR, u.bwWeightG, u.bwWeightB));
		printed = vec3<f32>(encode_print(print_density(
			v, u.slopes.g, u.pivots.g, u.curvatures.g,
			u.cmyOffsets.g, u.shadowCmy.g, u.highlightCmy.g,
		)));
	} else if (u.filmType == 2u) {
		// Slide: the transparency transfer instead of the print, then the same encode.
		printed = vec3<f32>(
			encode_tone(transfer_display(
				color.r, u.slopes.r, u.pivots.r, u.cmyOffsets.r, u.shadowCmy.r, u.highlightCmy.r,
			)),
			encode_tone(transfer_display(
				color.g, u.slopes.g, u.pivots.g, u.cmyOffsets.g, u.shadowCmy.g, u.highlightCmy.g,
			)),
			encode_tone(transfer_display(
				color.b, u.slopes.b, u.pivots.b, u.cmyOffsets.b, u.shadowCmy.b, u.highlightCmy.b,
			)),
		);
	} else {
		printed = vec3<f32>(
			encode_print(print_density(
				color.r, u.slopes.r, u.pivots.r, u.curvatures.r,
				u.cmyOffsets.r, u.shadowCmy.r, u.highlightCmy.r,
			)),
			encode_print(print_density(
				color.g, u.slopes.g, u.pivots.g, u.curvatures.g,
				u.cmyOffsets.g, u.shadowCmy.g, u.highlightCmy.g,
			)),
			encode_print(print_density(
				color.b, u.slopes.b, u.pivots.b, u.curvatures.b,
				u.cmyOffsets.b, u.shadowCmy.b, u.highlightCmy.b,
			)),
		);
	}

	var out_rgb = apply_tone(printed, u.toneGamma);

	// B&W mode: Rec. 709 luminance as grayscale. The channels are already equal here; this
	// mirrors NegPy's post-curve collapse (exposure/processor.py) as a safeguard.
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
