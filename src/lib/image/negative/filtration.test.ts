import { describe, it, expect } from 'vitest';
import { filtrationOffsets, regionalCmy, wbShiftsFromLog } from './filtration';
import type { LogBounds, Vec3 } from '$lib/types';

// Same vectors as the tests in src-tauri/src/negative/filtration.rs.
/** Channel ranges 1.35, 0.9, 1.8 log D. */
const A: LogBounds = { floors: [-1.5, -1.2, -1.0], ceils: [-0.15, -0.3, 0.8] };
/** Slide-like (floor above ceil): ranges 2.0, 2.2, 2.3. */
const E6: LogBounds = { floors: [0.0, -0.1, -0.2], ceils: [-2.0, -2.3, -2.5] };

function expectVec(actual: Vec3, expected: Vec3): void {
	for (let c = 0; c < 3; c++) expect(actual[c]).toBeCloseTo(expected[c], 6);
}

describe('filtrationOffsets', () => {
	it('divides slider × CMY_MAX_DENSITY by each channel range', () => {
		expectVec(filtrationOffsets([1, 1, 1], A), [0.2 / 1.35, 0.2 / 0.9, 0.2 / 1.8]);
		expectVec(filtrationOffsets([-0.5, 0.25, 0.8], A), [-0.0740740741, 0.0555555556, 0.0888888889]);
	});

	it('prints the same absolute density on every channel range', () => {
		const off = filtrationOffsets([1, 1, 1], A);
		const ranges = [1.35, 0.9, 1.8];
		for (let c = 0; c < 3; c++) expect(off[c] * ranges[c]).toBeCloseTo(0.2, 6);
	});

	it('keeps the slider direction when floor sits above ceil', () => {
		expectVec(filtrationOffsets([0.3, -0.7, 1], E6), [0.03, -0.0636363636, 0.0869565217]);
	});

	it('is zero at neutral sliders', () => {
		expectVec(filtrationOffsets([0, 0, 0], A), [0, 0, 0]);
	});
});

describe('regionalCmy', () => {
	it('is slider × CMY_MAX_DENSITY, independent of bounds', () => {
		expectVec(regionalCmy([0.5, -1, 0.3]), [0.1, -0.2, 0.06]);
	});
});

describe('wbShiftsFromLog', () => {
	it('converts each deviation from red to absolute density by its own range', () => {
		// u = (0.4444, 0.5, 0.5): m = −0.0556·0.9/0.2, y = −0.0556·1.8/0.2.
		const a = wbShiftsFromLog([-0.9, -0.75, -0.1], A);
		expect(a.magenta).toBeCloseTo(-0.25, 6);
		expect(a.yellow).toBeCloseTo(-0.5, 6);
		const b = wbShiftsFromLog([-0.85, -0.7, -0.05], A);
		expect(b.magenta).toBeCloseTo(-1 / 3, 6);
		expect(b.yellow).toBeCloseTo(-0.4166666667, 6);
	});

	it('leaves a patch that normalizes neutral alone', () => {
		// u = 0.5 on every channel.
		const s = wbShiftsFromLog([-0.825, -0.75, -0.1], A);
		expect(s.magenta).toBeCloseTo(0, 9);
		expect(s.yellow).toBeCloseTo(0, 9);
	});

	it('clamps to the slider range', () => {
		expect(wbShiftsFromLog([-0.6, -0.8, -0.3], A)).toEqual({ magenta: 1, yellow: 1 });
	});

	it('reads floor-above-ceil bounds the same way', () => {
		const s = wbShiftsFromLog([-1.0, -1.3, -1.2], E6);
		expect(s.magenta).toBeCloseTo(-0.5, 6);
		expect(s.yellow).toBeCloseTo(0.75, 6);
	});

	it('returns no shift for a non-finite sample', () => {
		expect(wbShiftsFromLog([Number.NaN, 0, 0], A)).toEqual({ magenta: 0, yellow: 0 });
	});
});
