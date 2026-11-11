import { describe, it, expect } from 'vitest';
import { displayToSourcePixel, sampleLogPatch, sampleSourceLogAt } from './pick-geometry';
import type { PickGeometry } from './pick-geometry';
import type { CropQuad, TransformParams } from '$lib/types';

/** 400 × 200 landscape source, no geometry. */
const BASE: PickGeometry = {
	sourceWidth: 400,
	sourceHeight: 200,
	transform: { rotation: 0, flipH: false, flipV: false, zoom: 1 },
	cropQuad: null,
	borderWidth: 0,
};

function withTransform(t: Partial<TransformParams>, rest: Partial<PickGeometry> = {}): PickGeometry {
	return { ...BASE, ...rest, transform: { ...BASE.transform, ...t } };
}

function expectPoint(actual: [number, number] | null, x: number, y: number): void {
	expect(actual).not.toBeNull();
	if (!actual) return;
	expect(actual[0]).toBeCloseTo(x, 6);
	expect(actual[1]).toBeCloseTo(y, 6);
}

describe('displayToSourcePixel', () => {
	it('scales straight through without geometry', () => {
		expectPoint(displayToSourcePixel(0.25, 0.75, BASE), 100, 150);
	});

	it('undoes a 90° counter-clockwise rotation', () => {
		const g = withTransform({ rotation: 90 });
		// The source's top-right corner shows at the top-left.
		expectPoint(displayToSourcePixel(0, 0, g), 400, 0);
		// 50 px left of the displayed centre is 50 px above the source centre.
		expectPoint(displayToSourcePixel(0.25, 0.5, g), 200, 50);
		expectPoint(displayToSourcePixel(0.25, 0.5, withTransform({ rotation: -90 })), 200, 150);
	});

	it('undoes a 180° rotation', () => {
		expectPoint(displayToSourcePixel(0.1, 0.2, withTransform({ rotation: 180 })), 360, 160);
	});

	it('undoes the CSS flips', () => {
		expectPoint(displayToSourcePixel(0.1, 0.2, withTransform({ flipH: true })), 360, 40);
		expectPoint(displayToSourcePixel(0.1, 0.2, withTransform({ flipV: true })), 40, 160);
	});

	it('undoes zoom on top of a fine rotation', () => {
		const g = withTransform({ rotation: 5, zoom: 1.5 });
		expectPoint(displayToSourcePixel(0.5, 0.5, g), 200, 100);
		// 100 output px right of centre: R(5°)·(100, 0) / (1.5 × cover zoom 1.1705).
		const p = displayToSourcePixel(0.75, 0.5, g);
		expectPoint(p, 256.7386834893, 104.9639915887);
		if (p) {
			expect(Math.hypot(p[0] - 200, p[1] - 100)).toBeCloseTo(100 / (1.5 * 1.1705061836), 6);
			expect(Math.atan2(p[1] - 100, p[0] - 200)).toBeCloseTo((5 * Math.PI) / 180, 9);
		}
	});

	it('keeps the corners of a fine rotation inside the source (cover zoom)', () => {
		const g = withTransform({ rotation: 5 });
		expectPoint(displayToSourcePixel(0, 0, g), 37.2299369152, 0);
		expectPoint(displayToSourcePixel(1, 1, g), 362.7700630848, 200);
	});

	it('follows a perspective crop quad', () => {
		const quad: CropQuad = {
			tl: { x: 0.1, y: 0.05 },
			tr: { x: 0.85, y: 0.15 },
			br: { x: 0.95, y: 0.9 },
			bl: { x: 0.05, y: 0.8 },
		};
		const g: PickGeometry = { ...BASE, cropQuad: quad };
		expectPoint(displayToSourcePixel(0, 0, g), 40, 10);
		expectPoint(displayToSourcePixel(1, 0, g), 340, 30);
		expectPoint(displayToSourcePixel(1, 1, g), 380, 180);
		expectPoint(displayToSourcePixel(0, 1, g), 20, 160);
		// Projective, not bilinear: the centre lands on the diagonals' crossing.
		expectPoint(displayToSourcePixel(0.5, 0.5, g), 196.5517241379, 88.2758620690);
	});

	it('returns null on the matte and outside the image', () => {
		// 10% of the 200 px short edge: 20 px matte, 440 × 240 output.
		const g: PickGeometry = { ...BASE, borderWidth: 10 };
		expect(displayToSourcePixel(10 / 440, 0.5, g)).toBeNull();
		expect(displayToSourcePixel(0.5, 230 / 240, g)).toBeNull();
		expect(displayToSourcePixel(1.01, 0.5, BASE)).toBeNull();
		expect(displayToSourcePixel(0.5, -0.01, BASE)).toBeNull();
		expectPoint(displayToSourcePixel(0.5, 0.5, g), 200, 100);
		expectPoint(displayToSourcePixel(55 / 440, 25 / 240, g), 35, 5);
	});

	it('composes flip, matte, crop and rotation in display order', () => {
		// 90°: rotated 200 × 400; crop its middle → 100 × 200 content; 10 px matte → 120 × 220.
		const crop: CropQuad = {
			tl: { x: 0.25, y: 0.25 },
			tr: { x: 0.75, y: 0.25 },
			br: { x: 0.75, y: 0.75 },
			bl: { x: 0.25, y: 0.75 },
		};
		const g = withTransform({ rotation: 90, flipV: true }, { cropQuad: crop, borderWidth: 10 });
		// Content uv (0.5, 0.05), flipped to the bottom on screen: crop uv (0.5, 0.275),
		// 90 rotated px above centre, i.e. 90 source px right of it.
		expectPoint(displayToSourcePixel(0.5, 1 - 20 / 220, g), 290, 100);
		expect(displayToSourcePixel(0.5, 1 - 5 / 220, g)).toBeNull();
	});
});

describe('sampleLogPatch', () => {
	/** 16 × 16 linear RGBA: one grey level left of x = 8, another right of it. */
	function split(): Float32Array {
		const px = new Float32Array(16 * 16 * 4);
		for (let y = 0; y < 16; y++) {
			for (let x = 0; x < 16; x++) {
				const i = (y * 16 + x) * 4;
				const v = x < 8 ? 0.1 : 0.01;
				px.set([v, v * 2, v * 4, 1], i);
			}
		}
		return px;
	}

	it('averages the log density of NegPy’s [c − 4, c + 4) window', () => {
		const src = { kind: 'linear-f32' as const, pixels: split(), channels: 4 as const };
		// Window x ∈ [4, 12): half at log 0.1, half at log 0.01.
		const s = sampleLogPatch(src, 16, 16, 8.5, 8.5);
		expect(s).not.toBeNull();
		if (!s) return;
		expect(s[0]).toBeCloseTo(-1.5, 6);
		expect(s[1]).toBeCloseTo(-1.5 + Math.log10(2), 6);
		expect(s[2]).toBeCloseTo(-1.5 + Math.log10(4), 6);
		// Cut at the edge: window x ∈ [0, 4) stays on the 0.1 side.
		const e = sampleLogPatch(src, 16, 16, 0, 0);
		expect(e?.[0]).toBeCloseTo(-1, 6);
	});

	it('linearises sRGB codes and reads 16-bit codes as linear', () => {
		const srgb = new Uint8Array(4 * 4 * 4).fill(188);
		const u16 = new Uint16Array(4 * 4 * 4).fill(32768);
		// sRGB 188 → 0.50289 linear.
		expect(sampleLogPatch({ kind: 'srgb-u8', pixels: srgb }, 4, 4, 2, 2)?.[1]).toBeCloseTo(-0.2985300591, 6);
		expect(sampleLogPatch({ kind: 'linear-u16', pixels: u16 }, 4, 4, 2, 2)?.[2]).toBeCloseTo(
			Math.log10(32768 / 65535),
			6,
		);
	});

	it('clamps to the log floor and returns null for an empty source', () => {
		const black = new Float32Array(4 * 4 * 3);
		expect(sampleLogPatch({ kind: 'linear-f32', pixels: black, channels: 3 }, 4, 4, 1, 1)).toEqual([-6, -6, -6]);
		expect(sampleLogPatch({ kind: 'linear-f32', pixels: black, channels: 3 }, 0, 0, 0, 0)).toBeNull();
	});

	it('reads through the source matrix, unclamped above white', () => {
		const u16 = new Uint16Array(4 * 4 * 4);
		for (let i = 0; i < u16.length; i += 4) u16.set([39321, 26214, 13107, 65535], i);
		// Camera-native 0.6, 0.4, 0.2 with red doubled and green mixed into blue.
		const s = sampleLogPatch({ kind: 'linear-u16', pixels: u16 }, 4, 4, 2, 2, 4, [
			2, 0, 0, 0, 1, 0, 0, 0.5, 1,
		]);
		expect(s?.[0]).toBeCloseTo(Math.log10(1.2), 6);
		expect(s?.[1]).toBeCloseTo(Math.log10(0.4), 6);
		expect(s?.[2]).toBeCloseTo(Math.log10(0.4), 6);
	});
});

describe('sampleSourceLogAt', () => {
	it('samples where the click lands after the geometry', () => {
		const w = 64;
		const h = 32;
		const px = new Float32Array(w * h * 3).fill(0.5);
		// A distinct patch around source (52, 8), where a 90° rotation shows the
		// displayed point (8 / 32, 12 / 64).
		for (let y = 0; y < 16; y++) {
			for (let x = 44; x < 60; x++) px.set([0.02, 0.02, 0.02], (y * w + x) * 3);
		}
		const g: PickGeometry = { ...BASE, sourceWidth: w, sourceHeight: h, transform: { ...BASE.transform, rotation: 90 } };
		const src = { kind: 'linear-f32' as const, pixels: px, channels: 3 as const };
		expect(sampleSourceLogAt(src, w, h, 8 / 32, 12 / 64, g)?.[0]).toBeCloseTo(Math.log10(0.02), 6);
		expect(sampleSourceLogAt(src, w, h, 0.5, 0.5, g)?.[0]).toBeCloseTo(Math.log10(0.5), 6);
		// A geometry recorded for another source size samples nothing.
		expect(sampleSourceLogAt(src, w, h, 0.5, 0.5, BASE)).toBeNull();
	});
});
