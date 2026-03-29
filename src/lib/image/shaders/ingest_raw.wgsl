/**
 * RAW ingest pass — rgba16uint linear → rgba16float normalised.
 *
 * Reads a `texture_2d<u32>` (rgba16uint) containing camera-native linear
 * pixel data (0–65535 per channel) output by the `raw_decode` Tauri command.
 * As-shot white balance has already been applied in Rust (CFA sensor space,
 * before demosaic) so no WB correction is needed here.
 *
 * Steps:
 *   1. Normalise u16 → f32 [0, 1].
 *   2. Write to rgba16float for consumption by the invert/colormatrix/tonecurve
 *      pipeline (which expects texture_2d<f32>).
 *
 * No sRGB gamma is applied — data stays linear throughout.
 */

@group(0) @binding(0) var uTexture : texture_2d<u32>;

struct VertIn {
	@builtin(vertex_index) idx : u32,
}

struct VertOut {
	@builtin(position) pos : vec4<f32>,
	@location(0) uv         : vec2<f32>,
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
	// textureLoad requires integer texel coordinates.
	let dims  = textureDimensions(uTexture);
	let coord = vec2<i32>(
		i32(in.uv.x * f32(dims.x)),
		i32(in.uv.y * f32(dims.y)),
	);
	// Clamp to avoid out-of-bounds on the border texel.
	let clamped = clamp(coord, vec2<i32>(0), vec2<i32>(dims) - vec2<i32>(1));
	let raw = textureLoad(uTexture, clamped, 0);

	// Normalise u16 → f32 [0, 1].
	// WB was already applied in Rust (CFA sensor space) — no WB uniform needed.
	let rgb = vec3<f32>(f32(raw.r), f32(raw.g), f32(raw.b)) / 65535.0;

	return vec4<f32>(rgb, 1.0);
}
