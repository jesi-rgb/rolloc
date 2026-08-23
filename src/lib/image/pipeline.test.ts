import { describe, it, expect } from 'vitest';
import type { CropQuad } from '$lib/types';

// Minimal re-implementation of the homography helper for parity testing.
// Keep in sync with `computeCropHomography` in `pipeline.ts`.
function computeCropHomographyTS(quad: CropQuad): [number, number, number, number, number, number, number, number] {
	const x0 = quad.tl.x;
	const y0 = quad.tl.y;
	const x1 = quad.tr.x;
	const y1 = quad.tr.y;
	const x2 = quad.bl.x;
	const y2 = quad.bl.y;
	const x3 = quad.br.x;
	const y3 = quad.br.y;

	const a = x1 - x3;
	const b = x2 - x3;
	const rx = x0 - x1 - x2 + x3;
	const c = y1 - y3;
	const d = y2 - y3;
	const ry = y0 - y1 - y2 + y3;

	const det = a * d - b * c;
	let g = 0.0;
	let h = 0.0;
	if (Math.abs(det) > 1e-10) {
		g = (rx * d - b * ry) / det;
		h = (a * ry - rx * c) / det;
	}

	return [
		(g + 1) * x1 - x0,
		(h + 1) * x2 - x0,
		x0,
		(g + 1) * y1 - y0,
		(h + 1) * y2 - y0,
		y0,
		g,
		h,
	];
}

function applyHomography(h: number[], u: number, v: number): { x: number; y: number } {
	const w = h[6] * u + h[7] * v + 1;
	return {
		x: (h[0] * u + h[1] * v + h[2]) / w,
		y: (h[3] * u + h[4] * v + h[5]) / w,
	};
}

describe('computeCropHomography', () => {
	it('maps the unit square corners to the source quad exactly', () => {
		const quad: CropQuad = {
			tl: { x: 0.1, y: 0.1 },
			tr: { x: 0.9, y: 0.15 },
			br: { x: 0.85, y: 0.95 },
			bl: { x: 0.15, y: 0.9 },
		};
		const h = computeCropHomographyTS(quad);

		expect(applyHomography(h, 0, 0).x).toBeCloseTo(quad.tl.x, 10);
		expect(applyHomography(h, 0, 0).y).toBeCloseTo(quad.tl.y, 10);
		expect(applyHomography(h, 1, 0).x).toBeCloseTo(quad.tr.x, 10);
		expect(applyHomography(h, 1, 0).y).toBeCloseTo(quad.tr.y, 10);
		expect(applyHomography(h, 1, 1).x).toBeCloseTo(quad.br.x, 10);
		expect(applyHomography(h, 1, 1).y).toBeCloseTo(quad.br.y, 10);
		expect(applyHomography(h, 0, 1).x).toBeCloseTo(quad.bl.x, 10);
		expect(applyHomography(h, 0, 1).y).toBeCloseTo(quad.bl.y, 10);
	});

	it('preserves straight lines in perspective quadrilaterals', () => {
		// A wide keystone quad: top edge narrower than bottom edge.
		const quad: CropQuad = {
			tl: { x: 0.3, y: 0.1 },
			tr: { x: 0.7, y: 0.1 },
			br: { x: 0.95, y: 0.9 },
			bl: { x: 0.05, y: 0.9 },
		};
		const h = computeCropHomographyTS(quad);

		// Sample three points along a horizontal output line (v = 0.5)
		const a = applyHomography(h, 0.2, 0.5);
		const b = applyHomography(h, 0.5, 0.5);
		const c = applyHomography(h, 0.8, 0.5);

		// The area of the triangle formed by three collinear points should be ~0.
		const area = Math.abs(
			(a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y)) / 2,
		);
		expect(area).toBeLessThan(1e-6);
	});

	it('degenerates to identity for the default full-image quad', () => {
		const quad: CropQuad = {
			tl: { x: 0, y: 0 },
			tr: { x: 1, y: 0 },
			br: { x: 1, y: 1 },
			bl: { x: 0, y: 1 },
		};
		const h = computeCropHomographyTS(quad);
		const expected = [
			{ uv: [0, 0], p: { x: 0, y: 0 } },
			{ uv: [1, 0], p: { x: 1, y: 0 } },
			{ uv: [0.5, 0.25], p: { x: 0.5, y: 0.25 } },
			{ uv: [1, 1], p: { x: 1, y: 1 } },
		];
		for (const { uv, p } of expected) {
			const got = applyHomography(h, uv[0], uv[1]);
			expect(got.x).toBeCloseTo(p.x, 10);
			expect(got.y).toBeCloseTo(p.y, 10);
		}
	});
});
