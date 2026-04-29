/**
 * Transform pass — applies rotation and zoom to the image by remapping UV coordinates.
 *
 * Rotation is a single continuous value (in radians) with aspect ratio correction.
 * The 90° buttons simply add/subtract 90° to this value — no special handling needed.
 *
 * Zoom scales from center — values > 1.0 crop in (e.g., 2.0 = 2x zoom, shows center 50%).
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
	sourceAspect : f32,
	// Zoom factor (1.0 = no zoom, 2.0 = 2x zoom / crop in)
	zoom : f32,
	// Aspect ratio of the output texture (width/height)
	// Differs from sourceAspect when rotation is ±90°/±270° (dimensions swapped)
	outputAspect : f32,
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
	// Center UV around (0,0) for rotation and zoom
	var uv = in.uv - vec2<f32>(0.5, 0.5);
	
	// Apply zoom (scale UVs — larger zoom = smaller UV range = crop in)
	if (uTransform.zoom != 1.0) {
		uv = uv / uTransform.zoom;
	}
	
	// Apply rotation while keeping the source's pixel size constant on screen.
	//
	// The canvas dimensions are chosen by the host code as the source dims
	// optionally swapped for ±90°/±270° (the nearest-90° step). The intent:
	// - 0°/180°: output is sized like source → identity / 180° flip works.
	// - ±90°/±270°: output is sized as swapped source → rotation is exact.
	// - Fine rotations (e.g. 5°): output keeps source size; rotated corners
	//   clip into the sampler clamp region (caller crops as needed).
	//
	// We work in a "source-pixel" reference frame where the source occupies
	// physical extent (srcAspect, 1). Depending on the nearest-90° step, the
	// output canvas occupies either (srcAspect, 1) — same orientation as
	// source — or (1, srcAspect) — swapped. This is determined by comparing
	// outputAspect to sourceAspect: if outputAspect ≈ sourceAspect, the
	// canvas is in source orientation; otherwise it's swapped.
	let srcAspect = uTransform.sourceAspect;
	let outAspect = uTransform.outputAspect;
	let cosA = cos(uTransform.rotation);
	let sinA = sin(uTransform.rotation);
	
	// Decide canvas physical extent in source-pixel units.
	// If output is in swapped orientation (outAspect closer to 1/srcAspect
	// than to srcAspect), the canvas extent is (1, srcAspect); otherwise
	// it's (srcAspect, 1). Same total area as source either way.
	let swappedDist = abs(outAspect - 1.0 / srcAspect);
	let unswappedDist = abs(outAspect - srcAspect);
	let isSwapped = swappedDist < unswappedDist;
	let canvasW = select(srcAspect, 1.0, isSwapped);
	let canvasH = select(1.0, srcAspect, isSwapped);
	
	// Map output uv ∈ [-0.5, 0.5] to canvas physical extent
	let px = uv.x * canvasW;
	let py = uv.y * canvasH;
	
	// Rotate in physical space (inverse rotation to look up source pixel)
	let rx = px * cosA - py * sinA;
	let ry = px * sinA + py * cosA;
	
	// Convert back to source UV space (source physical is srcAspect × 1)
	uv.x = rx / srcAspect;
	uv.y = ry;
	
	// Un-center
	uv = uv + vec2<f32>(0.5, 0.5);
	
	// Sample the source texture
	// Out-of-bounds UVs will be clamped by the sampler
	return textureSample(uTexture, uSampler, uv);
}
