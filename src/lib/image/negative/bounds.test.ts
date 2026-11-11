import { describe, it, expect } from 'vitest';
import { analyzeLogBounds } from './bounds';
import { percentileOfSorted, sortedChannel } from './grid';
import type { LogGrid } from './grid';
import type { LogBounds, Vec3 } from '$lib/types';
import { BASE_COLOR_CLIP } from './constants';

// Shared vectors with the Rust tests in src-tauri/src/negative/bounds.rs.
// A C-41-like negative: per-channel film base (orange mask) and density range.
const BASE: Vec3 = [-0.25, -0.55, -0.85];
const RANGE: Vec3 = [1.4, 1.6, 1.8];

/** Log density of a gray of scene brightness `t` (0 = brightest highlight, 1 = base). */
function gray(t: number, c: number): number {
	return BASE[c] - RANGE[c] * (1 - t);
}

/**
 * A gray ramp with sparse highlights (`t = sqrt(u)`). With `object`, 3 % of the
 * cells become a saturated bright object: dense as the brightest highlight in R,
 * nearly so in G, a midtone in B.
 */
function ramp(width: number, height: number, object: boolean): LogGrid {
	const n = width * height;
	const data = new Float32Array(n * 3);
	const o0 = Math.floor((n * 40) / 100);
	const o1 = o0 + Math.floor((n * 3) / 100);
	for (let i = 0; i < n; i++) {
		const t = Math.sqrt((i + 0.5) / n);
		const ts = object && i >= o0 && i < o1 ? [0, 0.02, 0.6] : [t, t, t];
		for (let c = 0; c < 3; c++) data[i * 3 + c] = gray(ts[c], c);
	}
	return { data, width, height };
}

function flat(): LogGrid {
	const data = new Float32Array(32 * 32 * 3);
	for (let i = 0; i < 32 * 32; i++) data.set([-0.4, -0.7, -1.0], i * 3);
	return { data, width: 32, height: 32 };
}

function expectBounds(b: LogBounds, floors: Vec3, ceils: Vec3): void {
	for (let c = 0; c < 3; c++) {
		expect(b.floors[c]).toBeCloseTo(floors[c], 4);
		expect(b.ceils[c]).toBeCloseTo(ceils[c], 4);
	}
}

/** Largest cross-channel spread of the normalized value of a gray. */
function graySpread(b: LogBounds): number {
	let spread = 0;
	for (const t of [0.05, 0.3, 0.6, 0.95]) {
		const u = [0, 1, 2].map(
			(c) => (Math.fround(gray(t, c)) - b.floors[c]) / (b.ceils[c] - b.floors[c]),
		);
		spread = Math.max(spread, Math.max(...u) - Math.min(...u));
	}
	return spread;
}

describe('analyzeLogBounds', () => {
	it('keeps a gray ramp neutral under an orange mask and unequal channel ranges', () => {
		const b = analyzeLogBounds(ramp(160, 120, false));
		expectBounds(b, [-1.634313, -2.132072, -2.629831], [-0.250088, -0.550101, -0.850113]);
		for (let c = 0; c < 3; c++) expect(b.floors[c]).toBeLessThan(b.ceils[c]);
		expect(graySpread(b)).toBeLessThan(1e-3);
	});

	it('holds the dense end when a saturated bright object covers 3 % of the frame', () => {
		const clean = ramp(160, 120, false);
		const withObject = ramp(160, 120, true);
		const b0 = analyzeLogBounds(clean);
		const b1 = analyzeLogBounds(withObject);
		expectBounds(b1, [-1.638889, -2.137301, -2.635714], [-0.250088, -0.550101, -0.850113]);
		expect(graySpread(b1)).toBeLessThan(1e-3);

		// Independent per-channel percentiles at the colour clip read the object in R.
		const p1 = (g: LogGrid, c: 0 | 1 | 2): number =>
			percentileOfSorted(sortedChannel(g, c), BASE_COLOR_CLIP);
		const percentileShift = Math.abs(p1(withObject, 0) - p1(clean, 0));
		const boundsShift = Math.max(...[0, 1, 2].map((c) => Math.abs(b1.floors[c] - b0.floors[c])));
		expect(percentileShift).toBeCloseTo(0.140179, 4);
		expect(boundsShift).toBeCloseTo(0.005883, 4);
		expect(boundsShift).toBeLessThan(0.01);
	});

	it('stays neutral on a grid too small for the same-pixel refs', () => {
		const b = analyzeLogBounds(ramp(8, 6, false));
		expectBounds(b, [-1.506622, -1.986139, -2.465656], [-0.25738, -0.558434, -0.859489]);
		expect(graySpread(b)).toBeLessThan(1e-3);
	});

	it('collapses a flat grid to its value without NaN', () => {
		const b = analyzeLogBounds(flat());
		expectBounds(b, [-0.4, -0.7, -1.0], [-0.4, -0.7, -1.0]);
	});

	it('falls back on an empty grid', () => {
		const b = analyzeLogBounds({
			data: new Float32Array(0),
			width: 0,
			height: 0,
		});
		expect(b).toEqual({ floors: [-1, -1, -1], ceils: [0, 0, 0] });
	});
});
