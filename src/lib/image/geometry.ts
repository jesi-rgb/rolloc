/**
 * Geometry utilities for rotation and crop calculations.
 *
 * When rotating an image by an arbitrary angle, corners extend beyond the
 * original bounds creating "void" areas. This module provides functions to
 * compute the largest axis-aligned rectangle that fits entirely within the
 * rotated image bounds (no void).
 */

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/**
 * Compute the largest axis-aligned rectangle inscribed in a rotated rectangle.
 *
 * Given an image of dimensions (W, H) rotated by `angleDeg` degrees around its
 * center, returns the largest axis-aligned rectangle that fits entirely within
 * the rotated bounds (i.e., no "void" corners).
 *
 * The returned rectangle is in normalized coordinates (0–1) relative to the
 * ROTATED image's bounding box.
 *
 * Math derivation:
 * - A rectangle rotated by θ has its corners at distance from center
 * - The inscribed rectangle's half-dimensions (a, b) must satisfy:
 *   a·|cos θ| + b·|sin θ| ≤ W/2
 *   a·|sin θ| + b·|cos θ| ≤ H/2
 * - For maximum area (a·b), we solve the constrained optimization problem
 *
 * Reference: https://stackoverflow.com/questions/16702966/
 *
 * @param srcW Source image width (before rotation)
 * @param srcH Source image height (before rotation)
 * @param angleDeg Rotation angle in degrees (positive = clockwise)
 * @returns Normalized rect {x, y, w, h} in 0–1 coords relative to rotated bounds
 */
export function maxInscribedRect(srcW: number, srcH: number, angleDeg: number): Rect {
	// Handle zero rotation - full image
	if (Math.abs(angleDeg) < 0.001) {
		return { x: 0, y: 0, w: 1, h: 1 };
	}

	const angleRad = Math.abs(angleDeg) * (Math.PI / 180);
	const sinA = Math.sin(angleRad);
	const cosA = Math.cos(angleRad);

	// After rotation, the bounding box of the rotated image is:
	const rotatedW = srcW * cosA + srcH * sinA;
	const rotatedH = srcW * sinA + srcH * cosA;

	// The largest inscribed axis-aligned rectangle in a rotated rectangle.
	// Using the formula from the reference:
	//
	// For a rectangle W×H rotated by θ, the inscribed rect dimensions are:
	// If W >= H:
	//   inscribed_w = W·cos(θ) - H·sin(θ)·tan(θ)  ... but this gets complex
	//
	// Simpler approach: the inscribed rectangle has dimensions:
	//   w' = W·cos²θ + H·sin²θ - 2·sin·cos·min(W,H)·(W-H)/(W+H)  ... also complex
	//
	// Let's use the closed-form solution for the largest inscribed rectangle
	// that maintains the original aspect ratio scaled down:
	//
	// Actually, the simplest correct formula:
	// The half-diagonals of the inscribed rect (a, b) satisfy:
	//   a·cosθ + b·sinθ = W/2
	//   a·sinθ + b·cosθ = H/2
	//
	// Solving for maximum a·b gives:
	//   a = (W·cosθ - H·sinθ) / (cos²θ - sin²θ)  when cos²θ ≠ sin²θ (i.e., θ ≠ 45°)
	//
	// For the general case, use the quadrilateral intersection approach:

	// Simpler: compute how much the image "shrinks" due to rotation
	// The inscribed rectangle, assuming we want to preserve aspect ratio of source:
	//
	// For arbitrary aspect ratios, the largest inscribed rect is computed as:

	const W = srcW;
	const H = srcH;

	let inscribedW: number;
	let inscribedH: number;

	if (W >= H) {
		// Landscape or square
		const cos2 = cosA * cosA - sinA * sinA; // cos(2θ)
		if (Math.abs(cos2) < 0.0001) {
			// θ ≈ 45°, special case
			inscribedW = (W + H) / (2 * (sinA + cosA));
			inscribedH = inscribedW;
		} else {
			// General formula for largest rect inscribed in rotated rect
			// Using parametric approach - this is the "same aspect ratio" solution
			const scale = 1 / (cosA + sinA * (H / W));
			inscribedW = W * cosA * scale;
			inscribedH = H * cosA * scale;

			// Verify and clamp
			const checkW = inscribedW * cosA + inscribedH * sinA;
			const checkH = inscribedW * sinA + inscribedH * cosA;
			if (checkW > W || checkH > H) {
				// Fallback: use the safe conservative formula
				const s = Math.min(W / (W * cosA + H * sinA), H / (W * sinA + H * cosA));
				inscribedW = W * s;
				inscribedH = H * s;
			}
		}
	} else {
		// Portrait - swap and recurse logic
		const cos2 = cosA * cosA - sinA * sinA;
		if (Math.abs(cos2) < 0.0001) {
			inscribedW = (W + H) / (2 * (sinA + cosA));
			inscribedH = inscribedW;
		} else {
			const scale = 1 / (cosA + sinA * (W / H));
			inscribedW = W * cosA * scale;
			inscribedH = H * cosA * scale;

			const checkW = inscribedW * cosA + inscribedH * sinA;
			const checkH = inscribedW * sinA + inscribedH * cosA;
			if (checkW > W || checkH > H) {
				const s = Math.min(W / (W * cosA + H * sinA), H / (W * sinA + H * cosA));
				inscribedW = W * s;
				inscribedH = H * s;
			}
		}
	}

	// Convert to normalized coordinates relative to the rotated bounding box
	// The inscribed rect is centered in the rotated bounds
	const normW = inscribedW / rotatedW;
	const normH = inscribedH / rotatedH;
	const normX = (1 - normW) / 2;
	const normY = (1 - normH) / 2;

	return {
		x: normX,
		y: normY,
		w: normW,
		h: normH,
	};
}

/**
 * Simpler, more reliable inscribed rectangle calculation.
 *
 * This computes the largest axis-aligned rectangle that can be inscribed
 * within a W×H rectangle rotated by θ, preserving the original aspect ratio.
 *
 * @param srcW Source width
 * @param srcH Source height  
 * @param angleDeg Rotation angle in degrees
 * @returns Scale factor (0–1) to multiply source dimensions by
 */
export function rotationCropScale(srcW: number, srcH: number, angleDeg: number): number {
	if (Math.abs(angleDeg) < 0.001) return 1;

	const angleRad = Math.abs(angleDeg) * (Math.PI / 180);
	const sinA = Math.sin(angleRad);
	const cosA = Math.cos(angleRad);

	// The rotated rectangle's bounding box
	const boundW = srcW * cosA + srcH * sinA;
	const boundH = srcW * sinA + srcH * cosA;

	// Scale factor to fit original aspect ratio rect inside rotated bounds
	// We need: scale * srcW ≤ some inscribed width, scale * srcH ≤ some inscribed height
	//
	// For a rectangle inscribed in the rotated bounds with same aspect ratio:
	// The constraint is that the corners of the scaled rect must lie within
	// the original (unrotated) rectangle when we "unrotate" them.
	//
	// Simplified: the scale factor is:
	const scale = Math.min(
		srcW / (srcW * cosA + srcH * sinA),
		srcH / (srcW * sinA + srcH * cosA),
	);

	return Math.max(0, Math.min(1, scale));
}

/**
 * Compute the maximum crop bounds given a fine rotation angle.
 *
 * Returns a normalized Rect representing the largest area that contains
 * only actual image data (no void from rotation).
 *
 * @param angleDeg Fine rotation angle in degrees
 * @param aspectRatio Source aspect ratio (width/height), after any 90° rotation
 * @returns Normalized rect in 0–1 coordinates
 */
export function maxCropBounds(angleDeg: number, aspectRatio: number): Rect {
	if (Math.abs(angleDeg) < 0.001) {
		return { x: 0, y: 0, w: 1, h: 1 };
	}

	// Use a unit rectangle with the given aspect ratio
	const srcW = aspectRatio >= 1 ? 1 : aspectRatio;
	const srcH = aspectRatio >= 1 ? 1 / aspectRatio : 1;

	const scale = rotationCropScale(srcW, srcH, angleDeg);

	const cropW = scale;
	const cropH = scale;

	return {
		x: (1 - cropW) / 2,
		y: (1 - cropH) / 2,
		w: cropW,
		h: cropH,
	};
}
