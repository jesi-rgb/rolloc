/**
 * Glow blend pass — screen blend upsampled glow onto original image.
 *
 * Takes:
 *   - Original full-resolution image (binding 1)
 *   - Upsampled glow texture (binding 2) — sampled with bilinear filtering
 *   - Glow amount uniform (binding 3)
 *
 * Applies screen blend: output = 1 - (1 - original) * (1 - glow * amount)
 *
 * The glow texture is at 1/4 resolution; the bilinear sampler naturally
 * upsamples it to full resolution with soft edges (which is what we want
 * for a glow effect anyway).
 */

struct GlowBlendUniforms {
	glow_amount : f32,
	_pad0       : f32,
	_pad1       : f32,
	_pad2       : f32,
}

@group(0) @binding(0) var uSampler : sampler;
@group(0) @binding(1) var uOriginal : texture_2d<f32>;
@group(0) @binding(2) var uGlow : texture_2d<f32>;
@group(0) @binding(3) var<uniform> u : GlowBlendUniforms;

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

@fragment
fn fs_main(in : VertOut) -> @location(0) vec4<f32> {
	let original = textureSample(uOriginal, uSampler, in.uv).rgb;
	
	// Early exit if glow is disabled
	if (u.glow_amount <= 0.0) {
		return vec4<f32>(original, 1.0);
	}
	
	// Sample glow (bilinear upsampling happens automatically)
	let glow_color = textureSample(uGlow, uSampler, in.uv).rgb * u.glow_amount;
	
	// Screen blend: output = 1 - (1 - base) * (1 - glow)
	let result = 1.0 - (1.0 - original) * (1.0 - glow_color);
	
	return vec4<f32>(clamp(result, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
