/**
 * CLAHE Pass A — Per-tile histogram computation + clip-redistribute + CDF.
 *
 * Dispatched as (tiles_x, tiles_y, 1) workgroups, each with 256 threads.
 * Each workgroup processes one tile of the image:
 *   1. Accumulate a 256-bin histogram of the L channel (Rec. 709 luminance).
 *   2. Clip the histogram at `clip_limit` and redistribute excess evenly.
 *   3. Compute the cumulative distribution function (CDF).
 *   4. Store the normalised CDF into the output storage buffer.
 *
 * The CDF buffer layout is: cdf[tile_y * tiles_x + tile_x][bin], stored
 * contiguously as tiles_x * tiles_y * 256 f32 values.
 *
 * Matches negpy's CLAHE approach (OpenCV createCLAHE) but implemented in
 * pure WebGPU compute.
 */

struct Params {
	width     : u32,
	height    : u32,
	tiles_x   : u32,
	tiles_y   : u32,
	clip_limit: f32,
	_pad0     : f32,
	_pad1     : f32,
	_pad2     : f32,
}

@group(0) @binding(0) var uTexture : texture_2d<f32>;
@group(0) @binding(1) var<uniform> u : Params;
@group(0) @binding(2) var<storage, read_write> cdf_buf : array<f32>;

const NUM_BINS : u32 = 256u;

/// Rec. 709 luminance weights (same as sRGB).
const LUMA_R : f32 = 0.2126;
const LUMA_G : f32 = 0.7152;
const LUMA_B : f32 = 0.0722;

/// Shared histogram for this workgroup (one tile).
var<workgroup> hist : array<atomic<u32>, 256>;

/// Shared scratch for CDF computation (non-atomic, used after barrier).
var<workgroup> scratch : array<u32, 256>;

@compute @workgroup_size(256, 1, 1)
fn main(
	@builtin(workgroup_id)        wg_id : vec3<u32>,
	@builtin(local_invocation_id) lid    : vec3<u32>,
) {
	let tile_x = wg_id.x;
	let tile_y = wg_id.y;
	let bin    = lid.x; // 0..255

	// ── 1. Zero histogram ────────────────────────────────────────────────
	atomicStore(&hist[bin], 0u);
	workgroupBarrier();

	// ── 2. Tile pixel bounds ─────────────────────────────────────────────
	// Tiles cover the image evenly; edge tiles may be smaller.
	let tile_w = (u.width  + u.tiles_x - 1u) / u.tiles_x;
	let tile_h = (u.height + u.tiles_y - 1u) / u.tiles_y;
	let x0 = tile_x * tile_w;
	let y0 = tile_y * tile_h;
	let x1 = min(x0 + tile_w, u.width);
	let y1 = min(y0 + tile_h, u.height);
	let tile_pixels = (x1 - x0) * (y1 - y0);

	// ── 3. Accumulate histogram ──────────────────────────────────────────
	// Each of the 256 threads strides through the tile pixels.
	var idx = bin;
	let total_px = tile_pixels;
	loop {
		if (idx >= total_px) { break; }
		let local_y = idx / (x1 - x0);
		let local_x = idx % (x1 - x0);
		let px = vec2<i32>(i32(x0 + local_x), i32(y0 + local_y));
		let col = textureLoad(uTexture, px, 0).rgb;

		// Luminance in [0, 1] → bin index [0, 255].
		let lum = clamp(LUMA_R * col.r + LUMA_G * col.g + LUMA_B * col.b, 0.0, 1.0);
		let b_idx = min(u32(lum * 255.0), 255u);
		atomicAdd(&hist[b_idx], 1u);

		idx += NUM_BINS;
	}
	workgroupBarrier();

	// ── 4. Clip + redistribute ───────────────────────────────────────────
	// clip_limit is in absolute count units (pre-computed CPU-side as
	// strength * 2.5 * (tile_pixels / 256)).
	let clip_u = u32(u.clip_limit);

	// Read histogram into scratch (non-atomic from here).
	scratch[bin] = atomicLoad(&hist[bin]);
	workgroupBarrier();

	// Iterative redistribution (up to 4 rounds — converges quickly).
	for (var round = 0u; round < 4u; round++) {
		// Count excess above clip limit.
		// Use shared atomics for reduction — thread 0 collects.
		atomicStore(&hist[bin], 0u);
		workgroupBarrier();

		if (scratch[bin] > clip_u) {
			atomicAdd(&hist[0], scratch[bin] - clip_u);
			scratch[bin] = clip_u;
		}
		workgroupBarrier();

		let excess = atomicLoad(&hist[0]);
		if (excess == 0u) { break; }

		// Distribute excess evenly across all bins.
		let per_bin = excess / NUM_BINS;
		let remainder = excess % NUM_BINS;
		scratch[bin] += per_bin;
		if (bin < remainder) {
			scratch[bin] += 1u;
		}
		workgroupBarrier();
	}

	// ── 5. Prefix sum → CDF ─────────────────────────────────────────────
	// Blelloch-style parallel prefix sum over 256 elements.
	// Since 256 threads = exactly our array size, we can do this in shared memory.

	// Copy scratch into hist (reused as atomic-free u32 array via atomicStore/Load).
	atomicStore(&hist[bin], scratch[bin]);
	workgroupBarrier();

	// Up-sweep (reduce)
	for (var stride = 1u; stride < NUM_BINS; stride <<= 1u) {
		let idx_a = (bin + 1u) * (stride << 1u) - 1u;
		if (idx_a < NUM_BINS) {
			let idx_b = idx_a - stride;
			atomicStore(&hist[idx_a], atomicLoad(&hist[idx_a]) + atomicLoad(&hist[idx_b]));
		}
		workgroupBarrier();
	}

	// Set last element to 0 (exclusive scan).
	if (bin == 0u) {
		atomicStore(&hist[NUM_BINS - 1u], 0u);
	}
	workgroupBarrier();

	// Down-sweep
	for (var stride = NUM_BINS >> 1u; stride >= 1u; stride >>= 1u) {
		let idx_a = (bin + 1u) * (stride << 1u) - 1u;
		if (idx_a < NUM_BINS) {
			let idx_b = idx_a - stride;
			let tmp = atomicLoad(&hist[idx_b]);
			atomicStore(&hist[idx_b], atomicLoad(&hist[idx_a]));
			atomicStore(&hist[idx_a], atomicLoad(&hist[idx_a]) + tmp);
		}
		workgroupBarrier();
	}

	// Convert exclusive scan to inclusive by adding the original value.
	// cdf[i] = exclusive_prefix[i] + count[i]
	let cdf_val = atomicLoad(&hist[bin]) + scratch[bin];

	// ── 6. Normalise CDF to [0, 1] and store ────────────────────────────
	let tile_idx = tile_y * u.tiles_x + tile_x;
	let cdf_norm = f32(cdf_val) / max(f32(tile_pixels), 1.0);
	cdf_buf[tile_idx * NUM_BINS + bin] = cdf_norm;
}
