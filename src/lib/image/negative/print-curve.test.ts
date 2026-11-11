import { describe, it, expect } from 'vitest';
import {
	BW_CHANNEL,
	collapseBw,
	computePivot,
	gradeCoupledShape,
	printDensity,
	printTransmittance,
	referenceLinearValue,
	type PrintCurveParams,
} from './print-curve';
import {
	ASSUMED_ANCHOR,
	D_MAX,
	NEUTRAL_AXIS_CURV_MAX_RATIO,
	SHOULDER_HEIGHT,
	TOE_HEIGHT,
	TOE_SHOULDER_STRENGTH,
} from './constants';
import type { Vec3 } from '$lib/types';

// Shared with the tests in src-tauri/src/negative/curve.rs — change both together.

const ZERO: Vec3 = [0, 0, 0];

function flat(slope: number, pivot: number, toe: number, shoulder: number): PrintCurveParams {
	return {
		slopes: [slope, slope, slope],
		pivots: [pivot, pivot, pivot],
		curvatures: ZERO,
		cmyOffsets: ZERO,
		shadowCmy: ZERO,
		highlightCmy: ZERO,
		toe,
		shoulder,
	};
}

const REFERENCE_SLOPE = 2.894;
const [REF_TOE, REF_SHOULDER] = gradeCoupledShape(REFERENCE_SLOPE, 0, 0);
const REFERENCE = flat(
	REFERENCE_SLOPE,
	computePivot(REFERENCE_SLOPE, null),
	REF_TOE,
	REF_SHOULDER,
);

const PARAMS: PrintCurveParams[] = [
	REFERENCE,
	{
		slopes: [3.1, 2.9, 2.7],
		pivots: [0.2, 0.21, 0.23],
		curvatures: [0.5, 0, -0.4],
		cmyOffsets: [0.05, -0.03, 0.02],
		shadowCmy: [0.04, -0.02, 0],
		highlightCmy: [-0.03, 0.01, 0.05],
		toe: 0.4,
		shoulder: 0.3,
	},
	{
		slopes: [4, 4.2, 3.8],
		pivots: [0.3, 0.3, 0.3],
		curvatures: [1.0, -1.0, 0.3],
		cmyOffsets: [-0.1, 0.1, 0],
		shadowCmy: [0, 0.03, -0.04],
		highlightCmy: [0.02, 0, -0.02],
		toe: -0.5,
		shoulder: -0.3,
	},
	flat(6, 0.35, 1.2, 1.0),
];

/** [params index, channel, u, density, transmittance]. */
const TABLE: [number, 0 | 1 | 2, number, number, number][] = [
	[1, 0, -0.1, 0.10959, 0.775856],
	[1, 1, 0.46, 0.691546, 0.199436],
	[1, 2, 1.0, 1.714917, 0.014339],
	[2, 0, 0.2, 0.028964, 0.934694],
	[2, 1, 0.7, 1.51598, 0.018613],
	[2, 2, 1.3, 2.3, 0],
	[3, 1, 0.0, 0.29763, 0.501431],
	[3, 1, 1.0, 1.535, 0.024284],
];

/** Analytic undershoot of the toe softplus below paper white (NegPy has it too). */
const KNEE_SLACK = 2e-4;

describe('print curve', () => {
	it('prints the reference curve', () => {
		const expected = [0.048126, 0.202311, 0.860859, 1.721165, 2.184727];
		[0, 0.2, 0.5, 0.8, 1].forEach((u, i) => {
			expect(printDensity(u, 1, REFERENCE)).toBeCloseTo(expected[i], 5);
		});
	});

	it('solves pivots and the S-curve centre', () => {
		expect(referenceLinearValue()).toBeCloseTo(0.712891, 5);
		expect(computePivot(REFERENCE_SLOPE, null)).toBeCloseTo(0.213666, 5);
		const pivots: [number, number, number][] = [
			[2, 0.103554, -0.016446],
			[2.9, 0.214175, 0.094175],
			[5, 0.317422, 0.197422],
			[10, 0.388711, 0.268711],
		];
		for (const [slope, unmetered, metered] of pivots) {
			expect(computePivot(slope, null)).toBeCloseTo(unmetered, 5);
			expect(computePivot(slope, 0.34)).toBeCloseTo(metered, 5);
		}
	});

	it('keeps the anchor as pivot for a degenerate slope', () => {
		expect(computePivot(0, 0.5)).toBe(0.5);
		expect(computePivot(Number.NaN, null)).toBe(ASSUMED_ANCHOR);
	});

	it('prints the anchor at the target density', () => {
		for (const slope of [2, 2.9, 5, 10]) {
			for (const anchor of [0.34, 0.46, 0.58]) {
				const p = flat(slope, computePivot(slope, anchor), 0, 0);
				expect(Math.abs(printDensity(anchor, 1, p) - 0.75)).toBeLessThan(1e-3);
			}
			const p = flat(slope, computePivot(slope, null), 0, 0);
			expect(Math.abs(printDensity(ASSUMED_ANCHOR, 1, p) - 0.75)).toBeLessThan(1e-3);
		}
	});

	it('is monotonic and bounded by paper white and paper black', () => {
		let worstDrop = 0;
		let worstExcursion = -Infinity;
		for (const slope of [2, 5, 10]) {
			for (const ratio of [-1, -0.5, 0, 0.5, 1]) {
				for (const toe of [-1, 0, 1]) {
					for (const shoulder of [-1, 0, 1]) {
						const curv = ratio * NEUTRAL_AXIS_CURV_MAX_RATIO * slope;
						const p: PrintCurveParams = {
							...flat(slope, 0.2, toe, shoulder),
							curvatures: [curv, curv, curv],
							cmyOffsets: [0.05, 0, -0.05],
							shadowCmy: [0.2, -0.2, 0],
							highlightCmy: [-0.2, 0.2, 0],
						};
						const t = toe * TOE_SHOULDER_STRENGTH;
						const dMin = Math.max(0, shoulder * TOE_SHOULDER_STRENGTH * SHOULDER_HEIGHT);
						const dMax = t < 0 ? D_MAX : D_MAX - t * TOE_HEIGHT;
						for (const ch of [0, 1, 2] as const) {
							let prev = -Infinity;
							for (let i = 0; i <= 400; i++) {
								const d = printDensity(-0.5 + i * 0.005, ch, p);
								worstDrop = Math.max(worstDrop, prev - d);
								worstExcursion = Math.max(worstExcursion, dMin - d, d - dMax);
								prev = d;
							}
						}
					}
				}
			}
		}
		expect(worstDrop).toBe(0);
		expect(worstExcursion).toBeLessThanOrEqual(KNEE_SLACK);
	});

	it('holds the quadratic core at its vertex instead of folding back', () => {
		const p: PrintCurveParams = { ...flat(2, -1.5, 0, 0), curvatures: [0.9, 0.9, 0.9] };
		const vertex = -2 / (2 * 0.9);
		expect(printDensity(-3, 0, p)).toBeCloseTo(printDensity(vertex, 0, p), 6);
		expect(printDensity(-1, 0, p)).toBeGreaterThan(printDensity(vertex, 0, p));
	});

	it('maps paper black to display black and never exceeds white', () => {
		for (const toe of [0, -0.3, -1]) {
			expect(printTransmittance(5, 1, { ...REFERENCE, toe, shoulder: 0 })).toBe(0);
		}
		for (const p of PARAMS) {
			for (let i = 0; i <= 40; i++) {
				const t = printTransmittance(-1 + i * 0.075, 0, p);
				expect(t).toBeGreaterThanOrEqual(0);
				expect(t).toBeLessThanOrEqual(1);
			}
		}
	});

	it('prints B&W on one density collapsed from the channels', () => {
		const v = collapseBw([0.3, 0.5, 0.7]);
		expect(v).toBeCloseTo(0.31 * 0.3 + 0.39 * 0.5 + 0.3 * 0.7, 6);
		expect(printDensity(v, BW_CHANNEL, REFERENCE)).toBeCloseTo(0.855261, 5);
		expect(printTransmittance(v, BW_CHANNEL, REFERENCE)).toBeCloseTo(0.135219, 5);
		// The weights sum to 1: a gray keeps its value, so it prints as before the collapse.
		for (const u of [-0.2, 0.25, 0.5, 1.1]) expect(collapseBw([u, u, u])).toBeCloseTo(u, 6);
	});

	it('matches the shared vectors', () => {
		for (const [i, ch, u, d, t] of TABLE) {
			expect(printDensity(u, ch, PARAMS[i])).toBeCloseTo(d, 5);
			expect(printTransmittance(u, ch, PARAMS[i])).toBeCloseTo(t, 5);
		}
	});
});
