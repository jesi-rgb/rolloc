/**
 * Pass 2 — Camera colour matrix
 *
 * Transforms linear-light camera-native RGB → linear sRGB (D65).
 * The matrix is a 3×3 provided as a uniform (row-major).
 * For Phase 3 with JPEG inputs this is essentially a no-op (identity matrix
 * unless the user has set a real camera matrix), but the shader is wired up
 * for Phase 5 (libraw RAW decode → real camera primaries).
 */

struct Uniforms {
	/// Column-major mat3x3 packed as 3×vec4 (each col is vec3 + 1 pad float).
	/// col0: [m00, m10, m20, pad], col1: [m01, m11, m21, pad], col2: [m02, m12, m22, pad]
	col0 : vec4<f32>,
	col1 : vec4<f32>,
	col2 : vec4<f32>,
	_pad : vec4<f32>,
}

@group(0) @binding(0) var uSampler : sampler;
@group(0) @binding(1) var uTexture : texture_2d<f32>;
@group(0) @binding(2) var<uniform> u : Uniforms;

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
	let col = textureSample(uTexture, uSampler, in.uv).rgb;

	// Reconstruct mat3x3 from explicit vec4 columns (avoids mat3x3 uniform layout issues).
	let c0 = u.col0.xyz;
	let c1 = u.col1.xyz;
	let c2 = u.col2.xyz;
	let out = mat3x3<f32>(c0, c1, c2) * col;

	return vec4<f32>(clamp(out, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
