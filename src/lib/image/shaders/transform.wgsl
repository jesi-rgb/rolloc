/**
 * Transform pass — applies rotation (90° steps + fine adjustment) and flip
 * to the image by remapping UV coordinates.
 *
 * Order of operations (inverse, since we're mapping output→input):
 *   1. Fine rotation (with aspect ratio correction)
 *   2. Flip (horizontal/vertical)
 *   3. 90° rotation (0, 90, 180, or 270 degrees clockwise)
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
	// Aspect ratio of the OUTPUT texture (width/height)
	// Needed for correct fine rotation without distortion
	outputAspect : f32,
	// Padding to 32 bytes (std140 alignment)
	_pad0 : f32,
	_pad1 : f32,
	_pad2 : f32,
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

@fragment
fn fs_main(in : VertOut) -> @location(0) vec4<f32> {
	// Center UV around (0,0) for rotation
	var uv = in.uv - vec2<f32>(0.5, 0.5);
	
	// Apply fine rotation with aspect ratio correction
	// This prevents distortion on non-square images
	if (uTransform.fineRotation != 0.0) {
		let aspect = uTransform.outputAspect;
		let cosA = cos(uTransform.fineRotation);
		let sinA = sin(uTransform.fineRotation);
		
		// Scale X to square space, rotate, then scale back
		let correctedX = uv.x * aspect;
		let rx = correctedX * cosA - uv.y * sinA;
		let ry = correctedX * sinA + uv.y * cosA;
		uv.x = rx / aspect;
		uv.y = ry;
	}
	
	// Apply flips (in centered space)
	if (uTransform.flipH == 1u) {
		uv.x = -uv.x;
	}
	if (uTransform.flipV == 1u) {
		uv.y = -uv.y;
	}
	
	// Un-center before 90° rotation (which uses 0-1 space)
	uv = uv + vec2<f32>(0.5, 0.5);
	
	// Apply 90° rotation
	uv = rotate90(uv, uTransform.rotation90);
	
	// Sample the source texture
	// Out-of-bounds UVs will be clamped by the sampler
	return textureSample(uTexture, uSampler, uv);
}
