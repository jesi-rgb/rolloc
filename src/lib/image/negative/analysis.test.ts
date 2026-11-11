import { describe, it, expect } from 'vitest';
import { analyzeNegative } from './analysis';
import { BW_CHANNEL, collapseBw, printTransmittance } from './print-curve';
import { solvePrintCurve } from './solve';
import { DEFAULT_INVERSION_PARAMS } from '$lib/types';
import type { AppliedBaseline, InversionParams, Vec3 } from '$lib/types';

// The same synthetic negative, inputs and expected numbers are asserted by
// `negative::tests` in src-tauri/src/negative/mod.rs: the preview (this code)
// and the native export (that code) must print the same picture.

const W = 320;
const H = 240;

/** A gray scene behind an orange mask, with a warm patch in one corner. */
function syntheticNegative(): Float32Array {
	const base = [0.75, 0.45, 0.25];
	const gamma = [1.0, 1.1, 1.25];
	const patchTint = [0.0, 0.1, 0.25];
	const out = new Float32Array(W * H * 3);
	let state = 2024;
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			const noise = (state >>> 8) / 16777216;
			const density = 0.2 + 1.2 * (0.5 * (x / W) + 0.3 * (y / H) + 0.2 * noise);
			const warm = x < W / 4 && y > (3 * H) / 4;
			for (let c = 0; c < 3; c++) {
				const d = density + (warm ? patchTint[c] : 0);
				out[(y * W + x) * 3 + c] = base[c] * Math.pow(10, -gamma[c] * d);
			}
		}
	}
	return out;
}

const ROLL: AppliedBaseline = {
	floors: [-1.5, -2.0, -2.6],
	ceils: [-0.2, -0.5, -0.8],
	useLuma: true,
	useColor: false,
	key: 7,
};

const EDITED: InversionParams = {
	...DEFAULT_INVERSION_PARAMS,
	cmyMagenta: 0.3,
	shadowYellow: -0.2,
	toe: 0.2,
};

function expectVec(actual: Vec3, expected: Vec3, digits = 4): void {
	for (let c = 0; c < 3; c++) expect(actual[c]).toBeCloseTo(expected[c], digits);
}

describe('negative analysis and print solve', () => {
	const pixels = syntheticNegative();
	const analyze = (baseline: AppliedBaseline | null) =>
		analyzeNegative({ kind: 'linear-f32', pixels, channels: 3 }, W, H, 'C41', baseline);

	it('measures and prints a frame on its own bounds', () => {
		const { analysis, bounds } = analyze(null);
		expectVec(analysis.floors, [-1.41339, -1.764084, -2.212624]);
		expectVec(analysis.ceils, [-0.465608, -0.721524, -1.027897]);
		expect(analysis.anchor).toBeCloseTo(0.454299, 4);
		expect(analysis.texturalRange).toBeCloseTo(0.43566, 4);
		expect(analysis.neutralAxis?.confidence).toBeCloseTo(0.962474, 3);
		expect(analysis.baselineKey).toBeNull();
		expect(bounds).toEqual({ floors: analysis.floors, ceils: analysis.ceils });

		const { curve } = solvePrintCurve(EDITED, analysis, null);
		expectVec(curve.slopes, [3.157209, 3.157209, 3.15721], 3);
		expectVec(curve.pivots, [0.228501, 0.228501, 0.228501]);
		expectVec(curve.cmyOffsets, [0, 0.057551, 0]);
		const at = (u: number): Vec3 => [
			printTransmittance(u, 0, curve),
			printTransmittance(u, 1, curve),
			printTransmittance(u, 2, curve),
		];
		expectVec(at(0.25), [0.552041, 0.426344, 0.554956]);
		expectVec(at(0.5), [0.124862, 0.080995, 0.13151]);
	});

	it('takes the tonal range from the roll baseline and keeps its own colour', () => {
		const { analysis, bounds } = analyze(ROLL);
		// The frame's own bounds are stored; the roll only shapes the render.
		expectVec(analysis.floors, [-1.41339, -1.764084, -2.212624]);
		expect(analysis.anchor).toBeCloseTo(0.468572, 4);
		expect(analysis.baselineKey).toBe(7);
		expectVec(bounds.floors, [-1.628499, -1.979193, -2.427733]);
		expectVec(bounds.ceils, [-0.234252, -0.490168, -0.79654]);

		const { curve } = solvePrintCurve(EDITED, analysis, ROLL);
		expectVec(curve.slopes, [4.587286, 4.522192, 4.44139], 3);
		expectVec(curve.pivots, [0.313354, 0.31093, 0.307821], 3);
		const at = (u: number): Vec3 => [
			printTransmittance(u, 0, curve),
			printTransmittance(u, 1, curve),
			printTransmittance(u, 2, curve),
		];
		expectVec(at(0.25), [0.76332, 0.653959, 0.747426], 3);
		expectVec(at(0.5), [0.125019, 0.081271, 0.132441], 3);
	});

	it('prints a gray scene behind an orange mask as neutral', () => {
		const { analysis } = analyze(null);
		const { curve } = solvePrintCurve(DEFAULT_INVERSION_PARAMS, analysis, null);
		for (const u of [0.1, 0.3, 0.5, 0.7, 0.9]) {
			const g = printTransmittance(u, 1, curve);
			expect(Math.abs(printTransmittance(u, 0, curve) - g)).toBeLessThan(2e-3);
			expect(Math.abs(printTransmittance(u, 2, curve) - g)).toBeLessThan(2e-3);
		}
	});

	it('prints B&W as one density and drops the colour filtration', () => {
		const { analysis } = analyzeNegative(
			{ kind: 'linear-f32', pixels, channels: 3 },
			W,
			H,
			'BW',
			null,
		);
		expect(analysis.neutralAxis).toBeNull();
		const tinted: InversionParams = { ...EDITED, filmType: 'BW', highlightCyan: 0.4 };
		const { curve } = solvePrintCurve(tinted, analysis, null);
		const plain = { ...DEFAULT_INVERSION_PARAMS, filmType: 'BW' as const, toe: EDITED.toe };
		expect(curve).toEqual(solvePrintCurve(plain, analysis, null).curve);

		const print = (u: Vec3): number => printTransmittance(collapseBw(u), BW_CHANNEL, curve);
		// A gray prints as without the collapse: the red channel of the colour print above,
		// which no filtration touches, also gives 0.552041 at u = 0.25.
		expect(print([0.25, 0.25, 0.25])).toBeCloseTo(0.552041, 4);
		expect(print([0.5, 0.5, 0.5])).toBeCloseTo(0.124862, 4);
		expect(print([0.3, 0.5, 0.7])).toBeCloseTo(0.126711, 4);
	});

	it('follows the metered midtone only when Auto Density is on', () => {
		const { analysis } = analyze(null);
		const auto = solvePrintCurve(DEFAULT_INVERSION_PARAMS, analysis, null).curve;
		const fixed = solvePrintCurve(
			{ ...DEFAULT_INVERSION_PARAMS, autoExposure: false },
			analysis,
			null,
		).curve;
		// This frame meters slightly below the assumed midtone (0.454 vs 0.46),
		// so Auto Density moves the pivot down with it.
		expect(auto.pivots[1]).toBeLessThan(fixed.pivots[1]);
		expect(fixed.pivots[1] - auto.pivots[1]).toBeCloseTo(0.46 - analysis.anchor, 3);
	});
});

describe('slide analysis and transfer solve', () => {
	const pixels = syntheticNegative();
	/** The same frame a stop and a half darker, with another crop of content. */
	const other = pixels.map((v, i) => (i % 7 === 0 ? v * 0.9 : v) * 0.35);
	const source = (p: Float32Array) => ({ kind: 'linear-f32' as const, pixels: p, channels: 3 as const });
	const SLIDE_EDIT: InversionParams = { ...EDITED, filmType: 'E6', castRemoval: 1 };

	it('carries the fixed window and the neutral meters, whatever the frame and roll', () => {
		for (const [p, baseline] of [[pixels, null], [other, ROLL]] as const) {
			const { analysis, bounds } = analyzeNegative(source(p), W, H, 'E6', baseline);
			expectVec(analysis.floors, [0, 0, 0]);
			expectVec(analysis.ceils, [-3, -3, -3]);
			expect(bounds).toEqual({ floors: analysis.floors, ceils: analysis.ceils });
			expect(analysis.anchor).toBeCloseTo(0.25, 6);
			expect(analysis.texturalRange).toBeCloseTo(0.9, 6);
			expect(analysis.neutralAxis).toBeNull();
			expect(analysis.baselineKey).toBe(baseline?.key ?? null);
		}
	});

	it('solves the same curve for two different slides', () => {
		const a = analyzeNegative(source(pixels), W, H, 'E6', null).analysis;
		const b = analyzeNegative(source(other), W, H, 'E6', ROLL).analysis;
		const solved = solvePrintCurve(SLIDE_EDIT, a, null);
		expect(solvePrintCurve(SLIDE_EDIT, b, ROLL)).toEqual(solved);
		// Even a negative's analysis: a slide's solve does not read it.
		const negative = analyzeNegative(source(pixels), W, H, 'C41', null).analysis;
		expect(solvePrintCurve(SLIDE_EDIT, negative, ROLL)).toEqual(solved);

		expectVec(solved.curve.slopes, [3, 3, 3], 6);
		expectVec(solved.curve.cmyOffsets, [0, 0.02, 0], 6);
		expectVec(solved.curve.shadowCmy, [0, 0, -0.04], 6);
		// The sliders themselves: the paper's grade coupling does not apply.
		expect(solved.curve.toe).toBe(0.2);
		expect(solved.curve.shoulder).toBe(0);
	});

	it('histograms the slide as rendered, through the source matrix', () => {
		// A gray ramp captured without white balance: red at half the level of green.
		const ramp = new Float32Array(W * H * 3);
		for (let i = 0; i < W * H; i++) {
			const g = 0.02 + (0.9 * (i % W)) / W;
			ramp.set([g / 2, g, g], i * 3);
		}
		const raw = analyzeNegative(source(ramp), W, H, 'E6', null).histograms;
		expect(raw.r).not.toEqual(raw.g);
		const balanced = analyzeNegative(source(ramp), W, H, 'E6', null, [2, 0, 0, 0, 1, 0, 0, 0, 1])
			.histograms;
		expect(balanced.r).toEqual(balanced.g);
	});
});
