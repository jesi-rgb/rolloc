/**
 * Transform pass — applies rotation (90° steps + fine adjustment) and flip
 * to the image by remapping UV coordinates.
 *
 * Order of operations:
 *   1. Flip (horizontal/vertical)
 *   2. 90° rotation (0, 90, 180, or 270 degrees clockwise)
 *   3. Fine rotation (arbitrary angle, typically -45 to +45 degrees)
 *
 * All operations are applied by transforming the UV coordinates, not the pixels.
 */

@group(0) @binding(0) var uSampler : sampler;
@group(0) @binding(1) var uTexture : texture_2d<f32>;
@group(0) @binding(2) var<uniform> uTransform : TransformUniforms;

struct TransformUniforms {
	// rotation90: 0=0°, 1=90°, 2=180°, 3=270° (clockwise)
	rotation90 : u32,
	// flipH: 1 = flip horizontal, 0 = no flip
	flipH : u32,
	// flipV: 1 = flip vertical, 0 = no flip
	flipV : u32,
	// fineRotation in radians
	fineRotation : f32,
}

struct VertIn {
	@builtin(vertex_index) idx : u32,
}

struct VertOut {
	@builtin(position) pos : vec4<f32>,
	@location(0) uv : vec2<f32>,
}

@vertex
fn vs_main(in : VertIn) -> VertOut {
	// Full-screen triangle: idx 0 → (0,0), idx 1 → (2,0), idx 2 → (0,2)
	let x = f32((in.idx << 1u) & 2u);
	let y = f32(in.idx & 2u);
	var out : VertOut;
	out.pos = vec4<f32>(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);
	// UV goes from (0,0) at top-left to (1,1) at bottom-right
	out.uv = vec2<f32>(x, 1.0 - y);
	return out;
}

/**
 * Apply 90° rotation steps to UV coordinates.
 * Rotation is clockwise when looking at the image.
 */
fn rotate90(uv : vec2<f32>, steps : u32) -> vec2<f32> {
	switch (steps % 4u) {
		case 0u: { return uv; }                           // 0°
		case 1u: { return vec2<f32>(1.0 - uv.y, uv.x); }  // 90° CW
		case 2u: { return vec2<f32>(1.0 - uv.x, 1.0 - uv.y); }  // 180°
		case 3u: { return vec2<f32>(uv.y, 1.0 - uv.x); }  // 270° CW
		default: { return uv; }
	}
}

/**
 * Apply fine rotation around the center of the image.
 */
fn rotateFine(uv : vec2<f32>, radians : f32) -> vec2<f32> {
	// Translate to center
	let centered = uv - vec2<f32>(0.5, 0.5);
	
	// Rotate
	let cosA = cos(radians);
	let sinA = sin(radians);
	let rotated = vec2<f32>(
		centered.x * cosA - centered.y * sinA,
		centered.x * sinA + centered.y * cosA
	);
	
	// Translate back
	return rotated + vec2<f32>(0.5, 0.5);
}

@fragment
fn fs_main(in : VertOut) -> @location(0) vec4<f32> {
	var uv = in.uv;
	
	// Apply fine rotation first (around center)
	if (uTransform.fineRotation != 0.0) {
		uv = rotateFine(uv, uTransform.fineRotation);
	}
	
	// Apply 90° rotation
	uv = rotate90(uv, uTransform.rotation90);
	
	// Apply flips
	if (uTransform.flipH == 1u) {
		uv.x = 1.0 - uv.x;
	}
	if (uTransform.flipV == 1u) {
		uv.y = 1.0 - uv.y;
	}
	
	// Sample the source texture
	// Out-of-bounds UVs will be clamped by the sampler
	return textureSample(uTexture, uSampler, uv);
}
