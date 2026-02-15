/**
 * Monotone cubic spline interpolation for tone/RGB curves.
 *
 * Given a set of control points (sorted by x, both axes 0–1),
 * produces a 256-entry Float32Array LUT suitable for upload to a
 * WebGPU texture_1d<f32>.
 *
 * Algorithm: Fritsch–Carlson monotone cubic interpolation.
 * Guarantees the output is monotonically non-decreasing, preventing
 * "wiggles" that would invert tones.
 */

import type { CurvePoints } from '$lib/types';

const LUT_SIZE = 256;

// ─── Spline helpers ───────────────────────────────────────────────────────────

/**
 * Evaluate a monotone cubic Hermite spline at parameter t ∈ [0, 1]
 * between points (x0,y0) and (x1,y1) with tangents m0 and m1.
 */
function hermite(
	t: number,
	y0: number,
	y1: number,
	m0: number,
	m1: number,
): number {
	const t2 = t * t;
	const t3 = t2 * t;
	return (
		(2 * t3 - 3 * t2 + 1) * y0 +
		(t3 - 2 * t2 + t) * m0 +
		(-2 * t3 + 3 * t2) * y1 +
		(t3 - t2) * m1
	);
}

/**
 * Build a 256-entry LUT from a CurvePoints spline definition.
 * Returns a Float32Array where index i maps input (i/255) → output value ∈ [0,1].
 */
export function buildLUT(curve: CurvePoints): Float32Array {
	const pts = [...curve.points].sort((a, b) => a.x - b.x);
	const n = pts.length;
	const lut = new Float32Array(LUT_SIZE);

	// Degenerate: single point or empty — identity passthrough
	if (n < 2) {
		for (let i = 0; i < LUT_SIZE; i++) lut[i] = i / (LUT_SIZE - 1);
		return lut;
	}

	// ── Compute Fritsch–Carlson tangents ──────────────────────────────────────

	// Secant slopes between adjacent points
	const delta: number[] = [];
	for (let k = 0; k < n - 1; k++) {
		const dx = pts[k + 1].x - pts[k].x;
		delta[k] = dx === 0 ? 0 : (pts[k + 1].y - pts[k].y) / dx;
	}

	// Initial tangents: arithmetic mean of secants
	const m: number[] = new Array(n).fill(0);
	m[0] = delta[0];
	m[n - 1] = delta[n - 2];
	for (let k = 1; k < n - 1; k++) {
		m[k] = (delta[k - 1] + delta[k]) / 2;
	}

	// Monotonicity fix-up
	for (let k = 0; k < n - 1; k++) {
		if (Math.abs(delta[k]) < 1e-10) {
			m[k] = 0;
			m[k + 1] = 0;
		} else {
			const alpha = m[k] / delta[k];
			const beta = m[k + 1] / delta[k];
			const mag = Math.hypot(alpha, beta);
			if (mag > 3) {
				m[k] = (3 * alpha / mag) * delta[k];
				m[k + 1] = (3 * beta / mag) * delta[k];
			}
		}
	}

	// ── Fill LUT ──────────────────────────────────────────────────────────────

	for (let i = 0; i < LUT_SIZE; i++) {
		const x = i / (LUT_SIZE - 1);

		// Clamp outside defined range
		if (x <= pts[0].x) {
			lut[i] = Math.max(0, Math.min(1, pts[0].y));
			continue;
		}
		if (x >= pts[n - 1].x) {
			lut[i] = Math.max(0, Math.min(1, pts[n - 1].y));
			continue;
		}

		// Find segment
		let seg = 0;
		for (let k = 0; k < n - 1; k++) {
			if (x <= pts[k + 1].x) { seg = k; break; }
		}

		const dx = pts[seg + 1].x - pts[seg].x;
		const t = dx === 0 ? 0 : (x - pts[seg].x) / dx;

		// Scale tangents by segment width (Hermite expects dy/dt not dy/dx)
		const val = hermite(
			t,
			pts[seg].y,
			pts[seg + 1].y,
			m[seg] * dx,
			m[seg + 1] * dx,
		);

		lut[i] = Math.max(0, Math.min(1, val));
	}

	return lut;
}

/**
 * Convenience: build all four LUTs needed by the tone-curve pass.
 * Returns [toneLUT, redLUT, greenLUT, blueLUT].
 */
export function buildCurveLUTs(
	toneCurve: CurvePoints,
	rgbCurves: [CurvePoints, CurvePoints, CurvePoints],
): [Float32Array, Float32Array, Float32Array, Float32Array] {
	return [
		buildLUT(toneCurve),
		buildLUT(rgbCurves[0]),
		buildLUT(rgbCurves[1]),
		buildLUT(rgbCurves[2]),
	];
}
