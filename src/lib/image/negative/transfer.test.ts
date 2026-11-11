import { describe, it, expect } from 'vitest';
import { CMY_MAX_DENSITY, STANDARD_TONE_GAMMA } from './constants';
import { solvePrintCurve } from './solve';
import {
	displayRendering,
	slideCameraMatrix,
	slidePickWb,
	transferBounds,
	transferDensity,
	transferDisplay,
	transferLinear,
} from './transfer';
import { DEFAULT_INVERSION_PARAMS } from '$lib/types';
import type { InversionParams, Matrix3x3, NegativeAnalysis, Vec3 } from '$lib/types';
import type { PrintCurveParams } from './print-curve';

// Shared with the tests in src-tauri/src/negative/transfer.rs — change both together.

const CHANNELS = [0, 1, 2] as const;

/** Any analysis: a slide's solve must not read it. */
const ANALYSIS: NegativeAnalysis = {
	version: 1,
	floors: [-1.4, -1.8, -2.2],
	ceils: [-0.5, -0.7, -1.0],
	anchor: 0.4,
	texturalRange: 0.6,
	neutralAxis: null,
	baselineKey: null,
};

function slide(patch: Partial<InversionParams> = {}): PrintCurveParams {
	return solvePrintCurve({ ...DEFAULT_INVERSION_PARAMS, filmType: 'E6', ...patch }, ANALYSIS, null)
		.curve;
}

/** Normalized value of a linear source value over the fixed window. */
function normalize(linear: number): number {
	const { floors, ceils } = transferBounds();
	return (Math.log10(Math.max(linear, 1e-6)) - floors[1]) / (ceils[1] - floors[1]);
}

function srgbToLinear(c: number): number {
	return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

const EDITED: Partial<InversionParams> = {
	cmyCyan: 0.2,
	cmyMagenta: -0.3,
	shadowYellow: 0.4,
	highlightCyan: -0.25,
	toe: 0.3,
	shoulder: -0.2,
};

/** [n, density, scene-linear display, display-referred display], per channel, at `EDITED`. */
const TABLE: [number, Vec3, Vec3, Vec3][] = [
	[-0.1, [-0.459106, -0.520897, -0.445742], [0.98198, 0.988717, 0.980394], [1, 1, 1]],
	[0, [-0.112789, -0.176225, -0.098242], [0.920693, 0.935708, 0.916948], [1, 1, 1]],
	[0.2, [0.551887, 0.481417, 0.571424], [0.585685, 0.638712, 0.570424], [0.286219, 0.336777, 0.273547]],
	[0.45, [1.302736, 1.223286, 1.330501], [0.092601, 0.120786, 0.084191], [0.04625, 0.056678, 0.043044]],
	[0.8, [2.165816, 2.092316, 2.194573], [0.004368, 0.005582, 0.003974], [0.003558, 0.004613, 0.003203]],
	[1.1, [2.814672, 2.744078, 2.842813], [0.000638, 0.000772, 0.000592], [0.000179, 0.000256, 0.000155]],
];

/** A camera's cam→linear sRGB matrix as raw.rs builds it (dcraw's Canon 5D Mark II). */
const CAMERA: Matrix3x3 = [
	2.220265, -1.245972, 0.230507,
	-0.040725, 1.288371, -0.299246,
	0.038354, -0.357347, 1.227694,
];
const AS_SHOT_WB: Vec3 = [2.1, 1, 1.45];
/** NegPy `camera_to_working_matrix(cam_xyz, camera_wb)` with sRGB as the working space. */
const SLIDE_MATRIX: Matrix3x3 = [
	4.343216, -1.320345, 0.365613,
	-0.079665, 1.365275, -0.474642,
	0.075027, -0.378677, 1.947278,
];

describe('slide transfer', () => {
	it('returns the source linear value at default settings across the window', () => {
		const curve = slide();
		for (let i = 0; i <= 100; i++) {
			const n = i / 100;
			for (const ch of CHANNELS) {
				expect(Math.abs(transferLinear(n, ch, curve) - Math.pow(10, -3 * n))).toBeLessThan(1e-5);
			}
		}
	});

	it('displays an 8-bit source unchanged through the standard tone preset', () => {
		const curve = slide();
		let worst = 0;
		for (let code = 0; code < 256; code++) {
			const n = normalize(srgbToLinear(code / 255));
			const shown = Math.pow(transferDisplay(n, 1, curve, false), 1 / STANDARD_TONE_GAMMA) * 255;
			worst = Math.max(worst, Math.abs(shown - code));
		}
		// Only code 0 moves: the log floors it at 1e-6 linear.
		expect(worst).toBeLessThan(0.004);
	});

	it('gives a RAW capture the baseline exposure and display rendering', () => {
		const curve = slide();
		expect(transferDisplay(normalize(0.18), 1, curve, true)).toBeCloseTo(0.429346, 5);
		expect(transferDisplay(normalize(1), 1, curve, true)).toBeCloseTo(0.888354, 5);
		expect(displayRendering(0)).toBe(0);
		expect(displayRendering(1e6)).toBe(1);
		let previous = Infinity;
		for (let i = -60; i <= 300; i++) {
			const v = transferDisplay(i / 100, 1, curve, true);
			expect(v).toBeLessThanOrEqual(previous);
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThanOrEqual(1);
			previous = v;
		}
		expect(previous).toBeLessThan(1e-8);
	});

	it('shifts green density by CMY_MAX_DENSITY per unit of magenta', () => {
		const curve = slide({ cmyMagenta: 1 });
		for (const n of [0, 0.25, 0.5, 1]) {
			expect(transferDensity(n, 0, curve)).toBeCloseTo(3 * n, 9);
			expect(transferDensity(n, 1, curve) - 3 * n).toBeCloseTo(CMY_MAX_DENSITY, 9);
			expect(transferDensity(n, 2, curve)).toBeCloseTo(3 * n, 9);
		}
	});

	it('splits shadow and highlight filtration about the transfer centre', () => {
		const shadow = slide({ shadowMagenta: 1 });
		const highlight = slide({ highlightMagenta: 1 });
		const shift = (p: PrintCurveParams, n: number): number => transferDensity(n, 1, p) - 3 * n;
		// Full on the own end, faded on the other, half each at the centre (D 0.924).
		expect(shift(shadow, 1)).toBeGreaterThan(0.99 * CMY_MAX_DENSITY);
		expect(shift(shadow, -1 / 3)).toBeLessThan(0.02 * CMY_MAX_DENSITY);
		expect(shift(highlight, -1 / 3)).toBeGreaterThan(0.98 * CMY_MAX_DENSITY);
		expect(shift(highlight, 1)).toBeLessThan(0.01 * CMY_MAX_DENSITY);
		expect(shift(shadow, 0.308)).toBeCloseTo(CMY_MAX_DENSITY / 2, 4);
		expect(shift(shadow, 0) + shift(highlight, 0)).toBeCloseTo(CMY_MAX_DENSITY, 9);
		expect(transferDensity(0.5, 0, shadow)).toBe(1.5);
	});

	it('moves only its own end of the scale with toe and shoulder, and stays monotonic', () => {
		for (const amount of [-1, -0.5, 0.5, 1]) {
			const toe = slide({ toe: amount });
			const shoulder = slide({ shoulder: amount });
			expect(Math.abs(transferDensity(1, 0, toe) - 3)).toBeGreaterThan(0.7 * Math.abs(amount));
			expect(Math.abs(transferDensity(0, 0, toe))).toBeLessThan(0.013 * Math.abs(amount) + 1e-12);
			expect(Math.abs(transferDensity(0, 0, shoulder))).toBeGreaterThan(0.5 * Math.abs(amount));
			expect(Math.abs(transferDensity(1, 0, shoulder) - 3)).toBeLessThan(0.0013 * Math.abs(amount));
			for (const p of [toe, shoulder]) {
				let previous = -Infinity;
				for (let i = -60; i <= 300; i++) {
					const d = transferDensity(i / 100, 0, p);
					expect(d).toBeGreaterThan(previous);
					previous = d;
				}
			}
		}
	});

	it('matches the shared vectors', () => {
		const curve = slide(EDITED);
		for (const [n, density, scene, display] of TABLE) {
			for (const ch of CHANNELS) {
				expect(transferDensity(n, ch, curve)).toBeCloseTo(density[ch], 5);
				expect(transferDisplay(n, ch, curve, true)).toBeCloseTo(scene[ch], 5);
				expect(transferDisplay(n, ch, curve, false)).toBeCloseTo(display[ch], 5);
			}
		}
	});
});

describe('slide camera matrix', () => {
	it('is NegPy’s working matrix with the as-shot balance folded in', () => {
		const m = slideCameraMatrix(CAMERA, AS_SHOT_WB);
		m.forEach((v, i) => expect(v).toBeCloseTo(SLIDE_MATRIX[i], 5));
		// An unbalanced camera neutral lands on display neutral.
		for (let r = 0; r < 3; r++) {
			const row = m[r * 3] / AS_SHOT_WB[0] + m[r * 3 + 1] / AS_SHOT_WB[1] + m[r * 3 + 2] / AS_SHOT_WB[2];
			expect(row).toBeCloseTo(1, 9);
		}
	});

	it('applies no primaries without a usable matrix and folds no invalid balance', () => {
		const identity: Matrix3x3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
		expect(slideCameraMatrix(identity, [1, 1, 1])).toEqual(identity);
		expect(slideCameraMatrix([0, 0, 0, 0, 0, 0, 0, 0, 0], [2, 1, 1.5])).toEqual([
			2, 0, 0, 0, 1, 0, 0, 0, 1.5,
		]);
		expect(slideCameraMatrix(CAMERA, [Number.NaN, 1, 1])).toEqual(
			slideCameraMatrix(CAMERA, [1, 1, 1]),
		);
		expect(slideCameraMatrix(CAMERA, [2, 1, 0]).every(Number.isFinite)).toBe(true);
	});
});

describe('slide white balance pick', () => {
	it('prints a picked cast neutral through the transfer', () => {
		const patch: Vec3 = [0.2, 0.18, 0.16];
		const rawLog = patch.map(Math.log10) as Vec3;
		const { cyan, magenta, yellow } = slidePickWb(rawLog, transferBounds());
		expect(cyan).toBeCloseTo(0.156469, 5);
		expect(magenta).toBeCloseTo(-0.072318, 5);
		expect(yellow).toBeCloseTo(-0.328081, 5);
		const curve = slide({ cmyCyan: cyan, cmyMagenta: magenta, cmyYellow: yellow });
		const out = CHANNELS.map((ch) => transferLinear(normalize(patch[ch]), ch, curve));
		expect(Math.abs(out[0] - out[1])).toBeLessThan(1e-3);
		expect(Math.abs(out[2] - out[1])).toBeLessThan(1e-3);
	});

	it('clamps to the slider range and ignores a sample that is not finite', () => {
		const strong = slidePickWb([Math.log10(0.4), Math.log10(0.18), Math.log10(0.05)], transferBounds());
		expect(strong.cyan).toBeLessThanOrEqual(1);
		expect(strong.yellow).toBe(-1);
		expect(slidePickWb([Number.NaN, 0, 0], transferBounds())).toEqual({
			cyan: 0,
			magenta: 0,
			yellow: 0,
		});
	});
});
