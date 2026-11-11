import { describe, it, expect } from 'vitest';
import { detectHorizonCandidates } from '$lib/image/horizon-detect';
import type { RgbaPixels } from '$lib/image/horizon-detect';

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Render a scene the way transform.wgsl does for `rotationDeg`: output pixel p
 * (centred, square-pixel units) samples the source at R(θ)·p. `scene` returns
 * a luma value for centred source coordinates. Adds grain so edges are not
 * perfectly clean.
 */
function renderRotated(
	width: number,
	height: number,
	rotationDeg: number,
	scene: (x: number, y: number) => number,
	seed = 1,
): RgbaPixels {
	const rand = rng(seed);
	const data = new Uint8ClampedArray(width * height * 4);
	const a = (rotationDeg * Math.PI) / 180;
	const cos = Math.cos(a);
	const sin = Math.sin(a);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const px = x + 0.5 - width / 2;
			const py = y + 0.5 - height / 2;
			const v = scene(px * cos - py * sin, px * sin + py * cos) + (rand() - 0.5) * 30;
			const i = (y * width + x) * 4;
			data[i] = data[i + 1] = data[i + 2] = v;
			data[i + 3] = 255;
		}
	}
	return { data, width, height };
}

/** Anti-aliased step: bright above `y0`, dark below. */
function horizonScene(y0: number): (x: number, y: number) => number {
	return (_x, y) => 60 + 140 * Math.min(1, Math.max(0, 0.5 - (y - y0)));
}

describe('detectHorizonCandidates', () => {
	it.each([4, -2.5, 0.7, -11])(
		'levels a horizon rendered at %f° on a 3:2 frame',
		(rotation) => {
			const img = renderRotated(900, 600, rotation, horizonScene(40));
			const [best] = detectHorizonCandidates(img);
			expect(best.type).toBe('horizontal');
			// rotation + angle must return the horizon to level.
			expect(rotation + best.angle).toBeCloseTo(0, 1);
		},
	);

	it('levels a tilted vertical edge on a portrait frame', () => {
		const rotation = 3;
		const pole = (x: number): number =>
			60 + 140 * Math.min(1, Math.max(0, 0.5 - Math.abs(x + 30) + 6));
		const img = renderRotated(500, 750, rotation, (x) => pole(x));
		const [best] = detectHorizonCandidates(img);
		expect(best.type).toBe('vertical');
		expect(rotation + best.angle).toBeCloseTo(0, 1);
	});

	it('reports the detected segment where the line is in the image', () => {
		const img = renderRotated(900, 600, 0, horizonScene(60));
		const [best] = detectHorizonCandidates(img);
		const midY = (best.line.y1 + best.line.y2) / 2;
		expect(midY).toBeCloseTo((300 + 60) / 600, 2);
		expect(Math.min(best.line.x1, best.line.x2)).toBeLessThan(0.05);
		expect(Math.max(best.line.x1, best.line.x2)).toBeGreaterThan(0.95);
	});

	it('ignores lines outside the region of interest', () => {
		// Strong tilted edge in the top fifth, weak level horizon in the middle.
		const scene = (x: number, y: number): number => {
			const top = y < -180 + x * Math.tan((6 * Math.PI) / 180) ? 230 : 0;
			return top || 90 + 40 * Math.min(1, Math.max(0, 0.5 - (y - 30)));
		};
		const img = renderRotated(900, 600, 0, scene);
		const region = { x: 0, y: 0.3, w: 1, h: 0.7 };
		const found = detectHorizonCandidates(img, { region });
		expect(found.length).toBeGreaterThan(0);
		expect(found.every((c) => Math.abs(c.angle) < 0.2)).toBe(true);
	});

	it('finds nothing in a featureless grainy frame', () => {
		const img = renderRotated(600, 400, 0, () => 128, 7);
		expect(detectHorizonCandidates(img)).toEqual([]);
	});

	it('returns candidates with distinct rotations, best first', () => {
		// Two parallel horizons → one candidate for that rotation.
		const scene = (_x: number, y: number): number =>
			y < -100 ? 220 : y < 120 ? 140 : 40;
		const img = renderRotated(900, 600, 2, scene);
		const found = detectHorizonCandidates(img);
		const angles = found.map((c) => c.angle);
		for (let i = 0; i < angles.length; i++) {
			for (let j = i + 1; j < angles.length; j++) {
				expect(Math.abs(angles[i] - angles[j])).toBeGreaterThanOrEqual(0.3);
			}
		}
		expect(found[0].confidence).toBe(1);
		expect(2 + found[0].angle).toBeCloseTo(0, 1);
	});
});
