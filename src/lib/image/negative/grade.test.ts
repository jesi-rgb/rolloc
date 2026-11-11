import { describe, it, expect } from 'vitest';
import {
	AUTO_GRADE_NOMINAL_RANGE,
	AUTO_GRADE_NOMINAL_RATIO,
	SLOPE_MAX,
	SLOPE_MIN,
} from './constants';
import {
	baseSlope,
	effectiveGradeRange,
	gradeToSlope,
	measureTexturalRange,
} from './grade';
import { gridLuma, percentiles } from './grid';
import type { LogGrid } from './grid';
import type { LogBounds, Vec3 } from '$lib/types';

// Vectors and expectations shared with the tests in src-tauri/src/negative/grade.rs.

const DIGITS = 4;

function bounds(floors: Vec3, ceils: Vec3): LogBounds {
	return { floors, ceils };
}

/**
 * 8×8 blocks stepping 0.1 log D (every 16×16 sector spans 0.3) with a fine ramp,
 * optionally beside a flat half at a mid value.
 */
function synth(w: number, h: number, flatLeft: boolean): LogGrid {
	const data = new Float32Array(w * h * 3);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			let v = -0.65;
			if (!flatLeft || x >= w / 2) {
				const xo = x - (flatLeft ? w / 2 : 0);
				const bx = xo >> 3;
				const by = y >> 3;
				v = -0.5 - 0.1 * ((bx + 2 * by) % 4) - 0.004 * (x % 8) - 0.003 * (y % 8);
			}
			const i = (y * w + x) * 3;
			data[i] = v + 0.05;
			data[i + 1] = v;
			data[i + 2] = v - 0.1;
		}
	}
	return { data, width: w, height: h };
}

const NORMAL = bounds([-1.5, -1.45, -1.2], [-0.15, -0.1, 0.15]);

describe('baseSlope', () => {
	it('matches the reference slopes at the neutral grade', () => {
		const cases: [LogBounds, number, number][] = [
			[NORMAL, 0.9, 2.893696],
			[bounds([-1.0, -0.9, -0.8], [-0.3, -0.2, -0.1]), 0.45, 2.100609],
			[bounds([-2.2, -2.1, -2.0], [-0.2, -0.1, 0.0]), 1.35, 3.429565],
			[bounds([-1.2, -1.4, -1.6], [0, 0, 0]), 0.8, 3.087715],
		];
		for (const [b, textural, expected] of cases) {
			expect(baseSlope(b, textural)).toBeCloseTo(expected, DIGITS);
		}
	});

	it('uses the range cap for a flat textural range', () => {
		expect(effectiveGradeRange(1.35, 0)).toBeCloseTo(3.5, DIGITS);
		expect(baseSlope(NORMAL, 0)).toBeCloseTo(8.826087, DIGITS);
	});

	it('rises with the negative contrast and stays in bounds', () => {
		// Textural range at a normal negative's ratio: never falls, rises strictly
		// between the slope floor and the overfill cap.
		let prev = 0;
		for (let i = 0; i <= 27; i++) {
			const range = 0.3 + 0.1 * i;
			const slope = baseSlope(
				bounds([-range, -range, -range], [0, 0, 0]),
				range / AUTO_GRADE_NOMINAL_RATIO,
			);
			expect(slope).toBeGreaterThanOrEqual(SLOPE_MIN);
			expect(slope).toBeLessThanOrEqual(SLOPE_MAX);
			expect(slope).toBeGreaterThanOrEqual(prev - 1e-6);
			if (range >= 0.75 && range < 1.75) expect(slope).toBeGreaterThan(prev + 0.05);
			prev = slope;
		}
		expect(prev).toBeCloseTo((2.9 * 0.85 * 1.62) / 1.15, DIGITS);
	});

	it('clamps at the extremes', () => {
		expect(baseSlope(bounds([-0.05, -0.05, -0.05], [0, 0, 0]), 2)).toBeCloseTo(SLOPE_MIN, DIGITS);
		expect(baseSlope(bounds([-5, -5, -5], [0, 0, 0]), 0.1)).toBeCloseTo(8.826087, DIGITS);
		expect(gradeToSlope(50, 3.5)).toBeCloseTo(SLOPE_MAX, DIGITS);
		expect(gradeToSlope(50, 1)).toBeCloseTo(5.8, DIGITS);
		expect(gradeToSlope(10, 1)).toBeCloseTo(5.8, DIGITS);
		expect(gradeToSlope(180, 1)).toBeCloseTo(SLOPE_MIN, DIGITS);
	});

	it('reads non-finite inputs as a normal negative', () => {
		const normal = baseSlope(NORMAL, 0.9);
		expect(gradeToSlope(NaN, NaN)).toBeCloseTo(normal, DIGITS);
		expect(baseSlope(bounds([NaN, 0, 0], [0, 0, 0]), 0.9)).toBeCloseTo(normal, DIGITS);
	});
});

describe('measureTexturalRange', () => {
	it('reads only the textured cells', () => {
		const grid = synth(64, 32, true);
		const measured = measureTexturalRange(grid);
		const luma = gridLuma(grid);
		const textured: number[] = [];
		for (let y = 0; y < 32; y++) for (let x = 32; x < 64; x++) textured.push(luma[y * 64 + x]);
		const [lo, hi] = percentiles(textured, [10, 90]);
		expect(measured).toBeCloseTo(hi - lo, DIGITS);
		expect(measured).toBeCloseTo(0.307, DIGITS);
		const [allLo, allHi] = percentiles(luma, [10, 90]);
		expect(measured).toBeGreaterThan(allHi - allLo + 0.01);
	});

	it('reads every cell of a grid smaller than one sector', () => {
		expect(measureTexturalRange(synth(12, 10, false))).toBeCloseTo(0.2092, DIGITS);
	});

	it('falls back on an empty grid and reads zero on a flat one', () => {
		const empty: LogGrid = { data: new Float32Array(0), width: 0, height: 0 };
		expect(measureTexturalRange(empty)).toBe(AUTO_GRADE_NOMINAL_RANGE);
		const flat: LogGrid = { data: new Float32Array(64 * 32 * 3).fill(-0.5), width: 64, height: 32 };
		expect(measureTexturalRange(flat)).toBe(0);
	});
});
