/**
 * Geometry for the rotation transform.
 */

/**
 * Zoom factor that makes a rotated source fully cover its output canvas, so
 * no clamped (out-of-source) pixels ever show at the corners.
 *
 * Mirrors transform.wgsl: the source spans (sourceAspect, 1) in physical
 * units and the canvas spans the same, swapped when the nearest 90° step is
 * odd. An output point p samples the source at R(θ)·p / zoom, so every canvas
 * corner must land inside the source rectangle. Mirrored in export.rs
 * (`apply_transform_and_crop`) so exports match the preview.
 *
 * Returns 1 at exact 90° steps and grows with the fine angle. The user's zoom
 * multiplies on top of it.
 */
export function rotationCoverZoom(rotationDeg: number, sourceAspect: number): number {
	const swapped = ((Math.round(rotationDeg / 90) % 2) + 2) % 2 === 1;
	const canvasW = swapped ? 1 : sourceAspect;
	const canvasH = swapped ? sourceAspect : 1;
	const a = (rotationDeg * Math.PI) / 180;
	const cos = Math.abs(Math.cos(a));
	const sin = Math.abs(Math.sin(a));
	return Math.max(
		1,
		(canvasW * cos + canvasH * sin) / sourceAspect,
		canvasW * sin + canvasH * cos,
	);
}
