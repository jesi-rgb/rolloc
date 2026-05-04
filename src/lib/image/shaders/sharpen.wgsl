/**
 * Unsharp Mask sharpening on perceptual luminance.
 *
 * Matches negpy's LAB lightness sharpening:
 *   sharpened_luma = luma + (luma - blur_luma) * amount
 * Then applies the ratio to all channels to preserve color.
 *
 * Uses a 5×5 Gaussian kernel (sigma ≈ 1.0) for the blur.
 * Amount is scaled by 2.5× to match negpy's `amount_f = amount * 2.5`.
 * A threshold of 2.0/100 (in L* units mapped to [0,1]) suppresses noise
 * sharpening in flat regions.
 */

struct SharpenUniforms {
    amount: f32,
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
};

@group(0) @binding(0) var tex_sampler: sampler;
@group(0) @binding(1) var input_tex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: SharpenUniforms;

const LUMA_COEFFS = vec3<f32>(0.2126, 0.7152, 0.0722);

// 5×5 Gaussian kernel (sigma ≈ 1.0), sum = 1.0
const gauss_kernel = array<f32, 25>(
    0.003765, 0.015019, 0.023792, 0.015019, 0.003765,
    0.015019, 0.059912, 0.094907, 0.059912, 0.015019,
    0.023792, 0.094907, 0.150342, 0.094907, 0.023792,
    0.015019, 0.059912, 0.094907, 0.059912, 0.015019,
    0.003765, 0.015019, 0.023792, 0.015019, 0.003765
);

fn to_perceptual(c: vec3<f32>) -> vec3<f32> {
    return pow(max(c, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.2));
}

fn to_linear(c: vec3<f32>) -> vec3<f32> {
    return pow(max(c, vec3<f32>(0.0)), vec3<f32>(2.2));
}

// ─── Full-screen triangle vertex shader ────────────────────────────────────
struct VertexOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VertexOut {
    var out: VertexOut;
    let x = f32(i32(idx & 1u) * 4 - 1);
    let y = f32(i32(idx >> 1u) * 4 - 1);
    out.pos = vec4<f32>(x, y, 0.0, 1.0);
    out.uv = vec2<f32>((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5);
    return out;
}

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let dims = textureDimensions(input_tex);
    let coords = vec2<i32>(vec2<f32>(dims) * uv);
    let color = textureLoad(input_tex, coords, 0).rgb;

    if (params.amount <= 0.0) {
        return vec4<f32>(color, 1.0);
    }

    // Compute blurred luminance using 5×5 Gaussian
    var blur_luma = 0.0;
    for (var j = -2; j <= 2; j++) {
        for (var i = -2; i <= 2; i++) {
            let sample_coords = clamp(coords + vec2<i32>(i, j), vec2<i32>(0), vec2<i32>(dims) - 1);
            let sample_color = textureLoad(input_tex, sample_coords, 0).rgb;
            let weight = gauss_kernel[(j + 2) * 5 + (i + 2)];
            blur_luma += dot(to_perceptual(sample_color), LUMA_COEFFS) * weight;
        }
    }

    let p_color = to_perceptual(color);
    let luma = dot(p_color, LUMA_COEFFS);
    let amount = params.amount * 2.5;
    let diff = luma - blur_luma;

    // Threshold: skip sharpening where detail is below noise floor
    // 2.0/100 in L* space ≈ 0.02 in perceptual [0,1]
    if (abs(diff) < 0.02) {
        return vec4<f32>(color, 1.0);
    }

    let sharpened_luma = luma + diff * amount;
    let ratio = sharpened_luma / max(luma, 1e-6);
    let result = to_linear(p_color * ratio);

    return vec4<f32>(clamp(result, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
