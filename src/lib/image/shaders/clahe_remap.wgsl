/**
 * CLAHE Pass B — Bilinear CDF interpolation + luminance remap.
 *
 * For each pixel:
 *   1. Compute luminance L from the H&D-curve output (gamma-encoded RGB).
 *   2. Find the 4 surrounding tile centers.
 *   3. Look up the remapped L in each tile's CDF.
 *   4. Bilinearly interpolate the 4 remapped values.
 *   5. Blend: L_final = L_original * (1 - strength) + L_remapped * strength.
 *   6. Reconstruct RGB preserving chrominance: out = pixel * (L_final / L_original).
 *
 * The CDF storage buffer is produced by clahe_histogram.wgsl.
 */

struct Params {
	width     : u32,
	height    : u32,
	tiles_x   : u32,
	tiles_y   : u32,
	strength  : f32,
	_pad0     : f32,
	_pad1     : f32,
	_pad2     : f32,
}

@group(0) @binding(0) var uSampler : sampler;
@group(0) @binding(1) var uTexture : texture_2d<f32>;
@group(0) @binding(2) var<uniform> u : Params;
@group(0) @binding(3) var<storage, read> cdf_buf : array<f32>;

const NUM_BINS : u32 = 256u;
const LUMA_R : f32 = 0.2126;
const LUMA_G : f32 = 0.7152;
const LUMA_B : f32 = 0.0722;

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

/// Look up a CDF value for a given tile and luminance bin, with linear
/// interpolation between bins.
fn cdf_lookup(tile_x : u32, tile_y : u32, lum : f32) -> f32 {
	// Clamp tile indices to valid range.
	let tx = min(tile_x, u.tiles_x - 1u);
	let ty = min(tile_y, u.tiles_y - 1u);
	let tile_idx = ty * u.tiles_x + tx;
	let base = tile_idx * NUM_BINS;

	let pos = lum * 255.0;
	let lo = clamp(u32(pos), 0u, 255u);
	let hi = min(lo + 1u, 255u);
	let frac = pos - f32(lo);

	let a = cdf_buf[base + lo];
	let b = cdf_buf[base + hi];
	return mix(a, b, frac);
}

@fragment
fn fs_main(in : VertOut) -> @location(0) vec4<f32> {
	let col = textureSample(uTexture, uSampler, in.uv).rgb;

	// Skip CLAHE when strength is zero.
	if (u.strength <= 0.0) {
		return vec4<f32>(col, 1.0);
	}

	// 1. Compute luminance.
	let lum = clamp(LUMA_R * col.r + LUMA_G * col.g + LUMA_B * col.b, 0.0, 1.0);

	// 2. Find the pixel's position in tile-space.
	//    Tile centers are at (tile_x + 0.5) * tile_w, (tile_y + 0.5) * tile_h.
	let px = in.uv.x * f32(u.width);
	let py = in.uv.y * f32(u.height);
	let tile_w = f32(u.width) / f32(u.tiles_x);
	let tile_h = f32(u.height) / f32(u.tiles_y);

	// Fractional tile coordinate (relative to tile centers).
	let ftx = (px / tile_w) - 0.5;
	let fty = (py / tile_h) - 0.5;

	// Integer tile indices for the 4 surrounding tiles.
	let tx0 = u32(max(floor(ftx), 0.0));
	let ty0 = u32(max(floor(fty), 0.0));
	let tx1 = min(tx0 + 1u, u.tiles_x - 1u);
	let ty1 = min(ty0 + 1u, u.tiles_y - 1u);

	// Interpolation weights.
	let fx = clamp(ftx - f32(tx0), 0.0, 1.0);
	let fy = clamp(fty - f32(ty0), 0.0, 1.0);

	// 3. Look up remapped luminance in each of the 4 surrounding tile CDFs.
	let c00 = cdf_lookup(tx0, ty0, lum);
	let c10 = cdf_lookup(tx1, ty0, lum);
	let c01 = cdf_lookup(tx0, ty1, lum);
	let c11 = cdf_lookup(tx1, ty1, lum);

	// 4. Bilinear interpolation.
	let remapped_lum = mix(mix(c00, c10, fx), mix(c01, c11, fx), fy);

	// 5. Blend with original.
	let final_lum = mix(lum, remapped_lum, u.strength);

	// 6. Reconstruct RGB preserving chrominance.
	//    Scale all channels by the luminance ratio.
	let eps = 1e-6;
	let ratio = final_lum / max(lum, eps);
	let out_rgb = clamp(col * ratio, vec3<f32>(0.0), vec3<f32>(1.0));

	return vec4<f32>(out_rgb, 1.0);
}
