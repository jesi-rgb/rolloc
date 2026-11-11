import { describe, it, expect } from 'vitest';
import {
	lumaSourceBounds,
	mixLumaColorBounds,
	poolFrameBounds,
	resolveBounds,
	type FrameBounds,
} from './baseline';
import { LUMA } from './constants';
import type { AppliedBaseline, LogBounds, Vec3 } from '$lib/types';

// Mix / resolve vectors are shared with src-tauri/src/negative/baseline.rs.
const BASE: LogBounds = { floors: [-1.48, -1.83, -2.31], ceils: [-0.12, -0.52, -0.88] };
const ROLL: LogBounds = { floors: [-1.62, -1.91, -2.18], ceils: [-0.21, -0.46, -0.74] };
const OTHER: LogBounds = { floors: [-1.4, -1.8, -2.3], ceils: [-0.1, -0.5, -0.9] };

function applied(useLuma: boolean, useColor: boolean): AppliedBaseline {
	return { floors: ROLL.floors, ceils: ROLL.ceils, useLuma, useColor, key: 1 };
}

function expectVec(got: Vec3, want: Vec3, digits: number): void {
	for (let c = 0; c < 3; c++) expect(got[c]).toBeCloseTo(want[c], digits);
}

function expectBounds(got: LogBounds, floors: Vec3, ceils: Vec3, digits = 9): void {
	expectVec(got.floors, floors, digits);
	expectVec(got.ceils, ceils, digits);
}

function lumaCentreRange(b: LogBounds): [number, number] {
	let centre = 0;
	let range = 0;
	for (let c = 0; c < 3; c++) {
		centre += (LUMA[c] * (b.floors[c] + b.ceils[c])) / 2;
		range += LUMA[c] * (b.ceils[c] - b.floors[c]);
	}
	return [centre, range];
}

/** Six frames of one roll; `d` carries a +0.4 log D red offset (a different light). */
const ROLL_FRAMES: FrameBounds[] = [
	{ id: 'a', floors: [-1.62, -1.91, -2.18], ceils: [-0.21, -0.46, -0.74] },
	{ id: 'b', floors: [-1.55, -1.88, -2.22], ceils: [-0.19, -0.44, -0.77] },
	{ id: 'c', floors: [-1.7, -1.97, -2.25], ceils: [-0.23, -0.47, -0.73] },
	{ id: 'd', floors: [-1.21, -1.93, -2.2], ceils: [0.19, -0.45, -0.75] },
	{ id: 'e', floors: [-1.58, -1.85, -2.15], ceils: [-0.2, -0.43, -0.76] },
	{ id: 'f', floors: [-1.66, -1.94, -2.21], ceils: [-0.22, -0.48, -0.75] },
];

describe('poolFrameBounds', () => {
	it('matches NegPy pool_frame_bounds and leaves the off-light frame out', () => {
		const { bounds, outlierIds } = poolFrameBounds(ROLL_FRAMES);
		expect(outlierIds).toEqual(['d']);
		expectBounds(
			bounds,
			[-1.6199864, -1.9079864, -2.1999864],
			[-0.2121388, -0.4581388, -0.7521388],
		);
	});

	it('flags nothing with two frames, however far apart', () => {
		const { bounds, outlierIds } = poolFrameBounds([ROLL_FRAMES[0], ROLL_FRAMES[3]]);
		expect(outlierIds).toEqual([]);
		expectBounds(bounds, [-1.415, -1.92, -2.19], [-0.01, -0.455, -0.745]);
	});

	it('pools every frame when every frame is an outlier', () => {
		const { bounds, outlierIds } = poolFrameBounds([
			{ id: 'r', floors: [-0.8, -1.9, -2.2], ceils: [0.6, -0.45, -0.75] },
			{ id: 'g', floors: [-1.6, -1.1, -2.2], ceils: [-0.2, 0.35, -0.75] },
			{ id: 'b', floors: [-1.6, -1.9, -1.4], ceils: [-0.2, -0.45, 0.05] },
		]);
		expect(outlierIds).toEqual(['r', 'g', 'b']);
		expectBounds(
			bounds,
			[-1.42992, -1.72992, -2.02992],
			[-0.02992, -0.27992, -0.57992],
		);
	});

	it('returns the roll itself when every frame agrees', () => {
		const same = [0, 1, 2, 3].map((i) => ({ id: String(i), ...ROLL }));
		const { bounds, outlierIds } = poolFrameBounds(same);
		expect(outlierIds).toEqual([]);
		expectBounds(bounds, ROLL.floors, ROLL.ceils);
	});
});

describe('mixLumaColorBounds', () => {
	it('takes the luma centre and range from one source and the shape from the other', () => {
		const mixed = mixLumaColorBounds(ROLL, OTHER);
		expectBounds(
			mixed,
			[-1.51678, -1.91678, -2.41678],
			[-0.083226, -0.483226, -0.883226],
		);
		const [c, r] = lumaCentreRange(mixed);
		const [rc, rr] = lumaCentreRange(ROLL);
		expect(c).toBeCloseTo(rc, 9);
		expect(r).toBeCloseTo(rr, 9);
	});

	it('is the identity when both sources are the same bounds', () => {
		expect(mixLumaColorBounds(ROLL, { floors: [...ROLL.floors], ceils: [...ROLL.ceils] })).toEqual(
			ROLL,
		);
	});
});

describe('resolveBounds', () => {
	it('renders the frame bounds without a baseline', () => {
		expect(resolveBounds(BASE, null)).toBe(BASE);
	});

	it('renders the baseline with both axes on', () => {
		expect(resolveBounds(BASE, applied(true, true))).toEqual(ROLL);
	});

	it('keeps the frame shape at the roll tonal range with luma only', () => {
		const got = resolveBounds(BASE, applied(true, false));
		expectBounds(
			got,
			[-1.557594, -1.907594, -2.387594],
			[-0.086114, -0.486114, -0.846114],
		);
		const [c, r] = lumaCentreRange(got);
		const [rc, rr] = lumaCentreRange(ROLL);
		expect(c).toBeCloseTo(rc, 9);
		expect(r).toBeCloseTo(rr, 9);
		for (let ch = 1; ch < 3; ch++) {
			expect(got.floors[ch] - got.floors[0]).toBeCloseTo(BASE.floors[ch] - BASE.floors[0], 9);
		}
	});

	it('keeps the frame tonal range with the roll shape with colour only', () => {
		const got = resolveBounds(BASE, applied(false, true));
		expectBounds(
			got,
			[-1.542406, -1.832406, -2.102406],
			[-0.243886, -0.493886, -0.773886],
		);
		const [c, r] = lumaCentreRange(got);
		const [bc, br] = lumaCentreRange(BASE);
		expect(c).toBeCloseTo(bc, 9);
		expect(r).toBeCloseTo(br, 9);
	});

	it('renders the frame bounds with both axes off', () => {
		expect(resolveBounds(BASE, applied(false, false))).toEqual(BASE);
	});
});

describe('lumaSourceBounds', () => {
	it('meters against the roll only when it supplies the tonal range', () => {
		expect(lumaSourceBounds(BASE, applied(true, false))).toEqual(ROLL);
		expect(lumaSourceBounds(BASE, applied(false, true))).toBe(BASE);
		expect(lumaSourceBounds(BASE, null)).toBe(BASE);
	});
});
