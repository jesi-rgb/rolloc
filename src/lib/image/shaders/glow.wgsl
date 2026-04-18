/**
 * Glow pass — highlight bloom extraction (runs at 1/4 resolution)
 *
 * Extracts bright regions from the image and applies a Gaussian-weighted blur.
 * Outputs ONLY the glow color (not blended with original) — the glow_blend
 * pass handles compositing onto the full-resolution image.
 *
 * Algorithm matches negpy's apply_glow_and_halation() logic:
 *   1. Compute luminance and extract highlight mask: mask = ((luma - 0.5) / 0.5)^2
 *   2. Sample surrounding pixels weighted by Gaussian × highlight mask
 *   3. Output the accumulated glow color (normalized)
 *
 * Uses a 64-tap Fibonacci spiral for uniform disk coverage with Gaussian weights.
 * At 1/4 resolution, this is fast enough for real-time preview.
 *
 * Radius is 15 pixels at full resolution, so ~4 pixels at 1/4 res.
 * We keep the same radius in the shader since the texture itself is smaller.
 */

// Rec. 709 luminance coefficients
const LUMA_COEFFS = vec3<f32>(0.2126, 0.7152, 0.0722);

// Highlight threshold for glow extraction
const HIGHLIGHT_THRESHOLD: f32 = 0.5;

// Glow blur radius in pixels (at the downsampled resolution)
// 15px at full res / 4 = ~4px, but we use a slightly larger radius
// to compensate for the lower resolution
const GLOW_RADIUS: f32 = 5.0;

// 64-tap Fibonacci spiral — uniform area coverage, smooth Gaussian approximation.
// Points lie in the unit disk; scale by the desired pixel radius when sampling.
const FIBONACCI_64 = array<vec2<f32>, 64>(
	vec2<f32>(0.088388, 0.000000),
	vec2<f32>(-0.112886, 0.103413),
	vec2<f32>(0.017279, -0.196886),
	vec2<f32>(0.142286, 0.185586),
	vec2<f32>(-0.261112, -0.046187),
	vec2<f32>(0.247348, -0.157342),
	vec2<f32>(-0.082733, 0.307763),
	vec2<f32>(-0.157781, -0.303797),
	vec2<f32>(0.342321, 0.125015),
	vec2<f32>(-0.356128, 0.147004),
	vec2<f32>(0.171677, -0.366864),
	vec2<f32>(0.126865, 0.404466),
	vec2<f32>(-0.382373, -0.221593),
	vec2<f32>(0.448567, -0.098616),
	vec2<f32>(-0.273753, 0.389386),
	vec2<f32>(-0.063243, -0.488045),
	vec2<f32>(0.388252, 0.327220),
	vec2<f32>(-0.522466, 0.021606),
	vec2<f32>(0.381099, -0.379244),
	vec2<f32>(-0.025497, 0.551396),
	vec2<f32>(-0.362617, -0.434536),
	vec2<f32>(0.574425, 0.077288),
	vec2<f32>(-0.486709, 0.338640),
	vec2<f32>(0.132997, -0.591185),
	vec2<f32>(0.307615, 0.536829),
	vec2<f32>(-0.601358, -0.191850),
	vec2<f32>(0.584143, -0.269889),
	vec2<f32>(-0.253065, 0.604686),
	vec2<f32>(-0.225855, -0.627935),
	vec2<f32>(0.600976, 0.315856),
	vec2<f32>(-0.667533, 0.175960),
	vec2<f32>(0.379431, -0.590102),
	vec2<f32>(0.120699, 0.702313),
	vec2<f32>(-0.572008, -0.442995),
	vec2<f32>(0.731702, -0.060620),
	vec2<f32>(-0.505760, 0.546712),
	vec2<f32>(0.003684, -0.755181),
	vec2<f32>(0.514305, 0.566946),
	vec2<f32>(-0.772295, -0.071576),
	vec2<f32>(0.625787, -0.474950),
	vec2<f32>(-0.142381, 0.782650),
	vec2<f32>(-0.428884, -0.681539),
	vec2<f32>(0.785920, 0.215388),
	vec2<f32>(-0.733486, 0.376413),
	vec2<f32>(0.289862, -0.781852),
	vec2<f32>(0.317911, 0.780942),
	vec2<f32>(-0.770264, -0.365042),
	vec2<f32>(0.823263, -0.253821),
	vec2<f32>(-0.440157, 0.751049),
	vec2<f32>(-0.184643, -0.859851),
	vec2<f32>(0.724177, 0.514422),
	vec2<f32>(-0.890157, 0.110939),
	vec2<f32>(0.587054, -0.689695),
	vec2<f32>(0.033320, 0.913689),
	vec2<f32>(-0.647727, -0.657276),
	vec2<f32>(0.930014, 0.047552),
	vec2<f32>(-0.724323, 0.598472),
	vec2<f32>(0.130975, -0.938767),
	vec2<f32>(0.542205, 0.787449),
	vec2<f32>(-0.939649, -0.216211),
	vec2<f32>(0.845937, -0.479274),
	vec2<f32>(-0.302492, 0.932436),
	vec2<f32>(-0.410097, -0.899101),
	vec2<f32>(0.916976, 0.389028)
);

// Sum of exp(-2*r^2) over all 64 Fibonacci samples — used to normalize the
// accumulator the same way a Gaussian convolution kernel is normalized (sum=1).
const BLOOM_GAUSS_SUM: f32 = 27.668145;

@group(0) @binding(0) var uSampler : sampler;
@group(0) @binding(1) var uTexture : texture_2d<f32>;

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
	let dims = vec2<f32>(textureDimensions(uTexture));
	let coords = vec2<i32>(in.uv * dims);

	// Accumulate highlight-weighted Gaussian samples
	var glow_accum = vec3<f32>(0.0);

	for (var tap = 0; tap < 64; tap++) {
		let offset = FIBONACCI_64[tap];
		let g_off = offset * GLOW_RADIUS;
		let g_coord = clamp(coords + vec2<i32>(g_off), vec2<i32>(0), vec2<i32>(dims) - 1);
		
		// Sample the neighbor pixel
		let g_uv = (vec2<f32>(g_coord) + 0.5) / dims;
		let g_samp = textureSample(uTexture, uSampler, g_uv).rgb;
		
		// Compute highlight mask for the sampled pixel
		let g_luma = dot(g_samp, LUMA_COEFFS);
		let g_hl_linear = max(0.0, (g_luma - HIGHLIGHT_THRESHOLD) / (1.0 - HIGHLIGHT_THRESHOLD));
		// Square the mask for more concentrated effect on bright highlights (matches negpy)
		let g_hl = g_hl_linear * g_hl_linear;
		
		// Gaussian weight based on distance (exp(-2*r^2) where r is in [0,1])
		let g_r = length(offset);
		let g_w = exp(-g_r * g_r * 2.0);
		
		// Accumulate: color * highlight_mask * gaussian_weight
		glow_accum += g_samp * (g_hl * g_w);
	}

	// Normalize by the sum of Gaussian weights
	// Output ONLY the glow color — blending happens in glow_blend pass
	let glow_color = glow_accum / BLOOM_GAUSS_SUM;

	return vec4<f32>(clamp(glow_color, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
