import { describe, it, expect } from 'vitest';
import { measureAnchor } from './meter';
import { gridLuma, median } from './grid';
import type { LogGrid } from './grid';
import type { LogBounds } from '$lib/types';

// Shared vectors with the `tests` module of src-tauri/src/negative/meter.rs.

const BOUNDS: LogBounds = { floors: [-2.2, -2.0, -1.8], ceils: [-0.4, -0.3, -0.2] };

/** A grid whose every cell normalizes to `u(x, y)` in all three channels against `BOUNDS`. */
function cellGrid(width: number, height: number, u: (x: number, y: number) => number): LogGrid {
	const data = new Float32Array(width * height * 3);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const v = u(x, y);
			for (let c = 0; c < 3; c++) {
				const f = BOUNDS.floors[c];
				data[(y * width + x) * 3 + c] = f + v * (BOUNDS.ceils[c] - f);
			}
		}
	}
	return { data, width, height };
}

/** A skewed ramp of 1024 values: its trimmed mean and trim midpoint differ. */
function ramp(i: number): number {
	return 0.2 + 0.6 * (i / 1023) ** 2;
}

/** Textured scene content: 8-cell checker, grain-scale ripple and a gentle gradient. */
function scene(x: number, y: number): number {
	return (
		0.4 +
		0.1 * (((x >> 3) + (y >> 3)) & 1) +
		0.15 * Math.sin(x * 0.9) * Math.sin(y * 0.6) +
		0.002 * (x + y)
	);
}

const SCENE_ANCHOR = 0.4830674;

describe('measureAnchor', () => {
	it('pulls 20% of the way to the trimmed textured mean averaged with the trim midpoint', () => {
		// Left half: the ramp, textured. Right half: flat, outside the activity gate.
		const grid = cellGrid(64, 32, (x, y) => (x < 32 ? ramp(y * 32 + x) : 0.9));
		const n = 1024;
		const at = (q: number): number => {
			const r = ((n - 1) * q) / 100;
			const l = Math.floor(r);
			return ramp(l) + (ramp(l + 1) - ramp(l)) * (r - l);
		};
		const lo = at(5);
		const hi = at(95);
		let sum = 0;
		let count = 0;
		for (let i = 0; i < n; i++) {
			if (ramp(i) >= lo && ramp(i) <= hi) {
				sum += ramp(i);
				count++;
			}
		}
		const m = 0.5 * (sum / count + 0.5 * (lo + hi));
		const anchor = measureAnchor(grid, BOUNDS);
		expect(anchor).toBeCloseTo(0.46 + 0.2 * (m - 0.46), 4);
		expect(anchor).toBeCloseTo(0.4541938, 5);
	});

	it('ignores a large flat sky or rebate that moves the all-cell median', () => {
		const base = cellGrid(64, 64, scene);
		const sky = cellGrid(64, 160, (x, y) => (y < 96 ? 0.08 : scene(x, y - 96)));
		const rebate = cellGrid(160, 64, (x, y) => (x < 64 ? scene(x, y) : 1.0));
		const anchor = measureAnchor(base, BOUNDS);
		const baseMedian = median(gridLuma(base, BOUNDS));
		expect(anchor).toBeCloseTo(SCENE_ANCHOR, 5);
		for (const framed of [sky, rebate]) {
			expect(Math.abs(measureAnchor(framed, BOUNDS) - anchor)).toBeLessThan(0.005);
			expect(Math.abs(median(gridLuma(framed, BOUNDS)) - baseMedian)).toBeGreaterThan(0.1);
		}
	});

	it('clamps grossly thin and grossly dense frames to the band ends', () => {
		const thin = cellGrid(64, 64, (x, y) => scene(x, y) + 0.9);
		const dense = cellGrid(64, 64, (x, y) => scene(x, y) - 0.9);
		expect(measureAnchor(thin, BOUNDS)).toBeCloseTo(0.58, 6);
		expect(measureAnchor(dense, BOUNDS)).toBeCloseTo(0.34, 6);
	});

	it('meters every cell of a frame with no texture or smaller than one sector', () => {
		expect(measureAnchor(cellGrid(64, 64, () => 0.7), BOUNDS)).toBeCloseTo(0.508, 6);
		expect(measureAnchor(cellGrid(3, 2, () => 0.5), BOUNDS)).toBeCloseTo(0.468, 6);
	});

	it('falls back to the assumed anchor when there is nothing to meter', () => {
		const empty: LogGrid = { data: new Float32Array(0), width: 0, height: 0 };
		expect(measureAnchor(empty, BOUNDS)).toBe(0.46);
		const nanBounds: LogBounds = { floors: [NaN, NaN, NaN], ceils: [0, 0, 0] };
		expect(measureAnchor(cellGrid(64, 64, scene), nanBounds)).toBe(0.46);
	});
});
