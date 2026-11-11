/**
 * Print curve solve: turns a frame's analysis and the user's inversion
 * parameters into the bounds and per-channel curve the render kernel consumes.
 * A slide skips the print and gets the transparency transfer (./transfer.ts),
 * solved without its analysis.
 *
 * Mirrors NegPy 0.68 `PhotometricProcessor.process`
 * (negpy/features/exposure/processor.py) and, for slides, `TransferProcessor.process`
 * (negpy/features/transparency/processor.py). Mirrored by `negative::solve` in
 * src-tauri/src/negative/mod.rs — change both together.
 */

import { resolveBounds } from './baseline';
import { castCurveParams } from './cast';
import { TRANSFER_DENSITY_RANGE } from './constants';
import { filtrationOffsets, regionalCmy } from './filtration';
import { baseSlope } from './grade';
import { computePivot, gradeCoupledShape } from './print-curve';
import { transferBounds } from './transfer';
import type {
	AppliedBaseline,
	InversionParams,
	LogBounds,
	NegativeAnalysis,
	Vec3,
} from '$lib/types';
import type { PrintCurveParams } from './print-curve';

export interface SolvedPrint {
	/** The bounds the normalization pass stretches with. */
	bounds: LogBounds;
	curve: PrintCurveParams;
}

/**
 * The transparency transfer of a slide (NegPy `TransferProcessor.process` at exposure offset 0
 * and contrast 1) as a straight line `D = R·(n + cmyOffset)` over the fixed window. Nothing in
 * it reads the frame: no metering, no roll baseline. Toe and shoulder are the sliders themselves,
 * clamped as NegPy's `per_channel_toe_shoulder` does; the paper's grade coupling does not apply.
 */
function solveTransfer(inv: InversionParams): SolvedPrint {
	const bounds = transferBounds();
	const r = TRANSFER_DENSITY_RANGE;
	const clamp = (v: number): number => Math.min(Math.max(v, -1), 1);
	return {
		bounds,
		curve: {
			slopes: [r, r, r],
			pivots: [0, 0, 0],
			curvatures: [0, 0, 0],
			cmyOffsets: filtrationOffsets([inv.cmyCyan, inv.cmyMagenta, inv.cmyYellow], bounds),
			shadowCmy: regionalCmy([inv.shadowCyan, inv.shadowMagenta, inv.shadowYellow]),
			highlightCmy: regionalCmy([inv.highlightCyan, inv.highlightMagenta, inv.highlightYellow]),
			toe: clamp(inv.toe),
			shoulder: clamp(inv.shoulder),
		},
	};
}

export function solvePrintCurve(
	inv: InversionParams,
	analysis: NegativeAnalysis,
	baseline: AppliedBaseline | null,
): SolvedPrint {
	if (inv.filmType === 'E6') return solveTransfer(inv);
	const bounds = resolveBounds({ floors: analysis.floors, ceils: analysis.ceils }, baseline);
	const slope = baseSlope(bounds, analysis.texturalRange);
	const anchor = inv.autoExposure ? analysis.anchor : null;

	// Cast Removal balances the colour layers of a colour negative; without it
	// (or without trustworthy neutrals) all three channels share one line.
	const cast =
		inv.filmType === 'C41'
			? castCurveParams(slope, anchor, inv.castRemoval, analysis.neutralAxis, bounds)
			: null;
	const pivot = computePivot(slope, anchor);
	const { slopes, pivots, curvatures } = cast ?? {
		slopes: [slope, slope, slope],
		pivots: [pivot, pivot, pivot],
		curvatures: [0, 0, 0],
	};

	const [toe, shoulder] = gradeCoupledShape(slopes[1], inv.toe, inv.shoulder);
	// B&W drops the colour filtration (NegPy `printed_exposure`): a B&W print collapses to
	// one density, which the nine per-channel CMY values would only shift unpredictably.
	const colour = inv.filmType !== 'BW';
	const cmy = (c: number, m: number, y: number): Vec3 => (colour ? [c, m, y] : [0, 0, 0]);
	return {
		bounds,
		curve: {
			slopes,
			pivots,
			curvatures,
			cmyOffsets: filtrationOffsets(cmy(inv.cmyCyan, inv.cmyMagenta, inv.cmyYellow), bounds),
			shadowCmy: regionalCmy(cmy(inv.shadowCyan, inv.shadowMagenta, inv.shadowYellow)),
			highlightCmy: regionalCmy(
				cmy(inv.highlightCyan, inv.highlightMagenta, inv.highlightYellow),
			),
			toe,
			shoulder,
		},
	};
}
