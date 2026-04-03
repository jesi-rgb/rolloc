/**
 * Transform pass — applies rotation to the image by remapping UV coordinates.
 *
 * Rotation is a single continuous value (in radians) with aspect ratio correction.
 * The 90° buttons simply add/subtract 90° to this value — no special handling needed.
 *
 * Flips are handled via CSS on the canvas element, not in this shader.
 */

@group(0) @binding(0) var uSampler : sampler;
@group(0) @binding(1) var uTexture : texture_2d<f32>;
@group(0) @binding(2) var<uniform> uTransform : TransformUniforms;

struct TransformUniforms {
	// Rotation in radians (positive = clockwise)
	rotation : f32,
	// Aspect ratio of the source texture (width/height)
	// Needed for correct rotation without distortion
	sourceAspect : f32,
	// Padding to 16 bytes (std140 alignment)
	_pad0 : f32,
	_pad1 : f32,
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

@fragment
fn fs_main(in : VertOut) -> @location(0) vec4<f32> {
	// Center UV around (0,0) for rotation
	var uv = in.uv - vec2<f32>(0.5, 0.5);
	
	// Apply rotation with aspect ratio correction
	// This prevents distortion on non-square images
	if (uTransform.rotation != 0.0) {
		let aspect = uTransform.sourceAspect;
		let cosA = cos(uTransform.rotation);
		let sinA = sin(uTransform.rotation);
		
		// Scale X to square space, rotate, then scale back
		let correctedX = uv.x * aspect;
		let rx = correctedX * cosA - uv.y * sinA;
		let ry = correctedX * sinA + uv.y * cosA;
		uv.x = rx / aspect;
		uv.y = ry;
	}
	
	// Un-center
	uv = uv + vec2<f32>(0.5, 0.5);
	
	// Sample the source texture
	// Out-of-bounds UVs will be clamped by the sampler
	return textureSample(uTexture, uSampler, uv);
}
