import { describe, it, expect } from 'vitest';
import { castCurveParams, measureNeutralAxis } from './cast';
import type { CastCurve } from './cast';
import { NEUTRAL_AXIS_CURV_MAX_RATIO, SLOPE_MAX, SLOPE_MIN } from './constants';
import type { LogGrid } from './grid';
import { computePivot } from './print-curve';
import type { LogBounds, NeutralAxis, Vec3 } from '$lib/types';

// Shared vectors: src-tauri/src/negative/cast.rs builds the same grids and expects the same
// numbers.

const BOUNDS: LogBounds = { floors: [-2.0, -2.2, -2.4], ceils: [-0.5, -0.7, -0.9] };
const UNIT: LogBounds = { floors: [0, 0, 0], ceils: [1, 1, 1] };
/** R and B diverge from green in opposite directions toward the highlight. */
const BENT: NeutralAxis = {
	mid: [0.6, 0.5, 0.4],
	shadow: [0.9, 0.8, 0.7],
	highlight: [0.05, 0.2, 0.35],
	confidence: 1,
};

/** Deterministic uniform noise in [-0.5, 0.5): a 32-bit LCG the Rust tests reproduce exactly. */
function lcg(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 4294967296 - 0.5;
	};
}

/**
 * A 96×64 horizontal gray ramp across the bounds, green from u = −0.05 to 1.05,
 * with per-channel density tilts `u_c = gain_c·u + offset_c` (normalized), a
 * shared luminance noise of ±0.01 and a per-channel noise of ±0.001.
 */
function ramp(gain: Vec3, offset: Vec3): LogGrid {
	const width = 96;
	const height = 64;
	const rnd = lcg(7);
	const data = new Float32Array(width * height * 3);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const u = -0.05 + (1.1 * x) / (width - 1);
			const lumNoise = 0.02 * rnd();
			const i = (y * width + x) * 3;
			for (let c = 0; c < 3; c++) {
				const un = gain[c] * u + offset[c] + lumNoise + 0.002 * rnd();
				data[i + c] = BOUNDS.floors[c] + un * (BOUNDS.ceils[c] - BOUNDS.floors[c]);
			}
		}
	}
	return { data, width, height };
}

const TILT_GAIN: Vec3 = [0.95, 1, 0.9];
const TILT_OFFSET: Vec3 = [-0.03, 0, -0.01];

function normalized(refs: Vec3, bounds: LogBounds): Vec3 {
	const at = (c: 0 | 1 | 2): number =>
		(refs[c] - bounds.floors[c]) / (bounds.ceils[c] - bounds.floors[c]);
	return [at(0), at(1), at(2)];
}

function core(curve: CastCurve, ch: 0 | 1 | 2, u: number): number {
	return curve.slopes[ch] * (u - curve.pivots[ch]) + curve.curvatures[ch] * u * u;
}

function expectVec(actual: readonly number[], expected: readonly number[], tol = 1e-4): void {
	expect(actual.length).toBe(expected.length);
	actual.forEach((v, i) => expect(Math.abs(v - expected[i])).toBeLessThan(tol));
}

function expectAxis(axis: NeutralAxis | null, expected: NeutralAxis): void {
	expect(axis).not.toBeNull();
	if (axis === null) return;
	expectVec(axis.mid, expected.mid);
	expectVec(axis.shadow, expected.shadow);
	expect(axis.highlight).not.toBeNull();
	expectVec(axis.highlight ?? [], expected.highlight ?? []);
	expect(Math.abs(axis.confidence - expected.confidence)).toBeLessThan(1e-4);
}

function expectCurve(curve: CastCurve | null, expected: CastCurve): void {
	expect(curve).not.toBeNull();
	if (curve === null) return;
	expectVec(curve.slopes, expected.slopes);
	expectVec(curve.pivots, expected.pivots);
	expectVec(curve.curvatures, expected.curvatures);
}

describe('measureNeutralAxis', () => {
	it('reads the tilted gray ramp', () => {
		expectAxis(measureNeutralAxis(ramp(TILT_GAIN, TILT_OFFSET), BOUNDS), {
			mid: [-1.3082988, -1.4245241, -1.7170559],
			shadow: [-0.8291131, -0.9199735, -1.26345],
			highlight: [-1.7509394, -1.8907775, -2.1363784],
			confidence: 0.5695984,
		});
	});

	it('reads a strong cast through the loose first pass', () => {
		expectAxis(measureNeutralAxis(ramp([1.25, 1, 0.8], [-0.15, 0, 0.12]), BOUNDS), {
			mid: [-1.2865224, -1.4505409, -1.6205258],
			shadow: [-0.7533357, -1.0224457, -1.2770909],
			highlight: [-1.8075596, -1.8671136, -1.9546772],
			confidence: 0.5532539,
		});
	});

	it('finds no axis in saturated foliage or sky with no grays', () => {
		// Normalized R and B 0.15 above G (foliage), or R +0.05 / B −0.20 (sky).
		expect(measureNeutralAxis(ramp([1, 1, 1], [0.15, 0, 0.15]), BOUNDS)).toBeNull();
		expect(measureNeutralAxis(ramp([1, 1, 1], [0.05, 0, -0.2]), BOUNDS)).toBeNull();
	});

	it('needs enough cells in the midtone and shadow bands', () => {
		const data = ramp(TILT_GAIN, TILT_OFFSET).data.slice(0, 10 * 8 * 3);
		expect(measureNeutralAxis({ data, width: 10, height: 8 }, BOUNDS)).toBeNull();
		const empty: LogGrid = { data: new Float32Array(0), width: 0, height: 0 };
		expect(measureNeutralAxis(empty, BOUNDS)).toBeNull();
	});
});

describe('castCurveParams', () => {
	const tilt = measureNeutralAxis(ramp(TILT_GAIN, TILT_OFFSET), BOUNDS);

	it('prints the neutral references of R and B like green at full strength', () => {
		expect(tilt).not.toBeNull();
		if (tilt === null) return;
		const curve = castCurveParams(4.2, null, 1, { ...tilt, confidence: 1 }, BOUNDS);
		expect(curve).not.toBeNull();
		if (curve === null) return;
		expect(curve.slopes[1]).toBe(4.2);
		expect(curve.pivots[1]).toBe(computePivot(4.2, null));
		expect(curve.curvatures[1]).toBe(0);
		const mid = normalized(tilt.mid, BOUNDS);
		const shadow = normalized(tilt.shadow, BOUNDS);
		for (const ch of [0, 2] as const) {
			expect(Math.abs(core(curve, ch, mid[ch]) - core(curve, 1, mid[1]))).toBeLessThan(1e-4);
			const atShadow = core(curve, ch, shadow[ch]) - core(curve, 1, shadow[1]);
			expect(Math.abs(atShadow)).toBeLessThan(1e-4);
		}
	});

	it('scales the correction by the measured confidence and the slider', () => {
		expectCurve(castCurveParams(4.2, null, 1, tilt, BOUNDS), {
			slopes: [4.3257555, 4.2, 4.4545123],
			pivots: [0.2649616, 0.290264, 0.268153],
			curvatures: [-0.0014982, 0, 0.0013901],
		});
		expectCurve(castCurveParams(4.2, 0.5, 0.5, tilt, BOUNDS), {
			slopes: [4.2619629, 4.2, 4.3235102],
			pivots: [0.3170305, 0.330264, 0.318066],
			curvatures: [-0.0007168, 0, 0.0006352],
		});
	});

	it('bends a strong cast', () => {
		const strong = measureNeutralAxis(ramp([1.25, 1, 0.8], [-0.15, 0, 0.12]), BOUNDS);
		expectCurve(castCurveParams(4.2, null, 1, strong, BOUNDS), {
			slopes: [3.6785524, 4.2, 4.7166944],
			pivots: [0.2482665, 0.290264, 0.3242401],
			curvatures: [0.0148269, 0, -0.0005569],
		});
	});

	it('leaves an uncast gray ramp nearly alone', () => {
		const flat = measureNeutralAxis(ramp([1, 1, 1], [0, 0, 0]), BOUNDS);
		const curve = castCurveParams(4.2, null, 1, flat, BOUNDS);
		expectCurve(curve, {
			slopes: [4.1997113, 4.2, 4.2003433],
			pivots: [0.2903003, 0.290264, 0.2903086],
			curvatures: [0.0002203, 0, -0.000238],
		});
		if (curve === null) return;
		for (const ch of [0, 2] as const) {
			expect(Math.abs(curve.slopes[ch] - curve.slopes[1])).toBeLessThan(1e-3);
			expect(Math.abs(curve.pivots[ch] - curve.pivots[1])).toBeLessThan(1e-3);
			expect(Math.abs(curve.curvatures[ch])).toBeLessThan(1e-3);
		}
	});

	it('clamps curvature and slope', () => {
		expectCurve(castCurveParams(4.2, null, 1, BENT, UNIT), {
			slopes: [SLOPE_MIN, 4.2, 6.279],
			pivots: [0.4997544, 0.290264, 0.2115478],
			curvatures: [NEUTRAL_AXIS_CURV_MAX_RATIO * 4.2, 0, -NEUTRAL_AXIS_CURV_MAX_RATIO * 4.2],
		});
		for (const baseSlope of [0.5, 2, 4.2, 9, 14]) {
			for (const strength of [0.25, 0.5, 1]) {
				for (const axis of [BENT, tilt]) {
					const bounds = axis === BENT ? UNIT : BOUNDS;
					const curve = castCurveParams(baseSlope, 0.45, strength, axis, bounds);
					expect(curve).not.toBeNull();
					if (curve === null) continue;
					const slopeG = curve.slopes[1];
					expect(slopeG).toBe(Math.min(Math.max(baseSlope, SLOPE_MIN), SLOPE_MAX));
					for (const ch of [0, 1, 2] as const) {
						expect(curve.slopes[ch]).toBeGreaterThanOrEqual(SLOPE_MIN);
						expect(curve.slopes[ch]).toBeLessThanOrEqual(SLOPE_MAX);
						const curvLim = NEUTRAL_AXIS_CURV_MAX_RATIO * slopeG;
						expect(Math.abs(curve.curvatures[ch])).toBeLessThanOrEqual(curvLim + 1e-12);
					}
				}
			}
		}
	});

	it('falls back to a straight line when the parabola is singular', () => {
		// R's highlight lands on its midtone: no parabola through both.
		const axis: NeutralAxis = {
			mid: [0.5, 0.5, 0.5],
			shadow: [0.85, 0.8, 0.8],
			highlight: [0.5, 0.375, 0.375],
			confidence: 1,
		};
		expectCurve(castCurveParams(4.2, null, 1, axis, UNIT), {
			slopes: [3.6, 4.2, 4.2],
			pivots: [0.255308, 0.290264, 0.290264],
			curvatures: [0, 0, 0],
		});
	});

	it('returns no correction without an axis or strength', () => {
		expect(castCurveParams(4.2, null, 1, null, BOUNDS)).toBeNull();
		expect(castCurveParams(4.2, null, 0, tilt, BOUNDS)).toBeNull();
		if (tilt === null) return;
		expect(castCurveParams(4.2, null, 1, { ...tilt, confidence: 0 }, BOUNDS)).toBeNull();
	});

	it('stays finite on collapsed bounds', () => {
		const collapsed: LogBounds = { floors: [0, 0, 0], ceils: [0, 0, 0] };
		const curve = castCurveParams(4.2, null, 1, BENT, collapsed);
		expect(curve).not.toBeNull();
		if (curve === null) return;
		const values = [...curve.slopes, ...curve.pivots, ...curve.curvatures];
		expect(values.every(Number.isFinite)).toBe(true);
	});
});
