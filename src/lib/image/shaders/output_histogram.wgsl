/**
 * Output histogram — 256-bin R, G, B counts of the final rendered content.
 *
 * Reads the display-encoded rgba16float content texture (after tone curve,
 * transform and crop; before the matte and the 8-bit dither), so the counts
 * describe the picture the user sees without matte or dither noise.
 *
 * Dispatched as (ceil(height / ROWS_PER_GROUP), 1, 1) workgroups of 256
 * threads. Each workgroup accumulates a band of rows into a shared histogram,
 * then flushes its non-zero bins to the global buffer — one global atomic per
 * occupied bin per band instead of three per pixel.
 *
 * Layout of `bins`: [0, 256) red, [256, 512) green, [512, 768) blue.
 * The caller clears it before the dispatch.
 */

@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> bins : array<atomic<u32>, 768>;

/// Rows each workgroup accumulates before flushing to global memory.
const ROWS_PER_GROUP : u32 = 16u;

var<workgroup> local : array<atomic<u32>, 768>;

@compute @workgroup_size(256)
fn main(
	@builtin(local_invocation_index) li : u32,
	@builtin(workgroup_id) wg : vec3<u32>,
) {
	for (var i = li; i < 768u; i = i + 256u) {
		atomicStore(&local[i], 0u);
	}
	workgroupBarrier();

	let size = textureDimensions(src);
	let y0 = wg.x * ROWS_PER_GROUP;
	let y1 = min(y0 + ROWS_PER_GROUP, size.y);
	for (var y = y0; y < y1; y = y + 1u) {
		for (var x = li; x < size.x; x = x + 256u) {
			let c = clamp(textureLoad(src, vec2<u32>(x, y), 0).rgb, vec3<f32>(0.0), vec3<f32>(1.0));
			let b = vec3<u32>(round(c * 255.0));
			atomicAdd(&local[b.r], 1u);
			atomicAdd(&local[256u + b.g], 1u);
			atomicAdd(&local[512u + b.b], 1u);
		}
	}
	workgroupBarrier();

	for (var i = li; i < 768u; i = i + 256u) {
		let v = atomicLoad(&local[i]);
		if (v != 0u) {
			atomicAdd(&bins[i], v);
		}
	}
}
