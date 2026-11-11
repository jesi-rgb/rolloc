/**
 * Auto Grade: the straight-line slope of the print curve.
 *
 * The slope follows the negative's own density range, like a printer picking a
 * paper grade: a flat negative prints on a harder grade, a contrasty one on a
 * softer grade. The floor-to-ceil range sets the paper gamma and the textural
 * (P10–P90) range shrinks it toward a normal negative's, so frames of very
 * different contrast print with similar but not identical texture.
 *
 * Port of NegPy 0.68 `luminance_density_range` / `measure_textural_range_from_log`
 * (negpy/features/exposure/normalization.py, kernels in negpy_core/src/meter.rs)
 * and `effective_grade_range` / `grade_to_slope`
 * (negpy/features/exposure/logic.py). Mirrored in src-tauri/src/negative/grade.rs —
 * change both together.
 */

import {
	AUTO_GRADE_MAX_OVERFILL,
	AUTO_GRADE_NOMINAL_RANGE,
	AUTO_GRADE_NOMINAL_RATIO,
	AUTO_GRADE_STRENGTH,
	AUTO_GRADE_TARGET,
	GRADE_CONTRAST_SCALE,
	ISO_R_MAX,
	ISO_R_MIN,
	LUMA,
	NEUTRAL_ISO_R,
	SLOPE_MAX,
	SLOPE_MIN,
	TEXTURAL_RANGE_CLIP,
} from './constants';
import { gridLuma, percentiles, texturedCells } from './grid';
import type { LogGrid } from './grid';
import type { LogBounds } from '$lib/types';

/** Bounds `grade_to_slope` puts on the density range it reads, log10 D. */
const GRADE_RANGE_MIN = 0.3;
const GRADE_RANGE_MAX = 3.5;

/** Below this textural range the frame is flat: `effective_grade_range`'s degenerate case. */
const FLAT_TEXTURAL_RANGE = 1e-6;

/** NegPy `default_grade_range`: the effective range of a normal negative, used when unmeasured. */
const DEFAULT_GRADE_RANGE = AUTO_GRADE_TARGET * AUTO_GRADE_NOMINAL_RATIO * AUTO_GRADE_NOMINAL_RANGE;

function clamp(v: number, lo: number, hi: number): number {
	return Math.min(Math.max(v, lo), hi);
}

/**
 * Single density range of the negative: the `LUMA` weighting of the per-channel
 * floor-to-ceil ranges, so a strong single-channel cast does not swing the slope
 * the way a green-only range would. `abs` keeps a slide's reversed window positive.
 */
export function luminanceDensityRange(bounds: LogBounds): number {
	const { floors, ceils } = bounds;
	return (
		LUMA[0] * Math.abs(ceils[0] - floors[0]) +
		LUMA[1] * Math.abs(ceils[1] - floors[1]) +
		LUMA[2] * Math.abs(ceils[2] - floors[2])
	);
}

/**
 * Textural density range, log10 D: the spread between the `TEXTURAL_RANGE_CLIP` and
 * `100 − TEXTURAL_RANGE_CLIP` percentiles of the textured cells' raw-log luma. Both the
 * activity gate and the percentiles read raw log density (NegPy `textured_range` passes
 * no normalization), so the result does not depend on the bounds. Flat regions (sky,
 * rebate, walls) fall out at the gate and cannot shrink the range. An empty grid or a
 * non-finite result reads as `AUTO_GRADE_NOMINAL_RANGE`.
 */
export function measureTexturalRange(grid: LogGrid): number {
	const cells = texturedCells(gridLuma(grid), grid.width, grid.height);
	if (cells.length === 0) return AUTO_GRADE_NOMINAL_RANGE;
	const [lo, hi] = percentiles(cells, [TEXTURAL_RANGE_CLIP, 100 - TEXTURAL_RANGE_CLIP]);
	const range = Math.abs(hi - lo);
	return Number.isFinite(range) ? range : AUTO_GRADE_NOMINAL_RANGE;
}

/**
 * Density range fed to `gradeToSlope`, Auto Grade on (Alkofer, US 4,731,671):
 * `K · floorCeil · ((1 − s) + s · nominal / textural)`, so the printed textural range
 * is (1 − s) of the frame's own plus s of a normal negative's, capped at
 * `AUTO_GRADE_MAX_OVERFILL` of the normal print span. A near-flat frame returns the
 * range cap and lets the slope clamp bound the boost. Non-finite inputs read as
 * unmeasured: a normal negative's range.
 */
export function effectiveGradeRange(floorCeilRange: number, texturalRange: number): number {
	if (!Number.isFinite(floorCeilRange) || !Number.isFinite(texturalRange)) {
		return DEFAULT_GRADE_RANGE;
	}
	const measured = Math.abs(texturalRange);
	if (measured < FLAT_TEXTURAL_RANGE) return GRADE_RANGE_MAX;
	const q = AUTO_GRADE_NOMINAL_RANGE / measured;
	const factor = Math.min(
		1 - AUTO_GRADE_STRENGTH + AUTO_GRADE_STRENGTH * q,
		q * AUTO_GRADE_MAX_OVERFILL,
	);
	return AUTO_GRADE_TARGET * Math.abs(floorCeilRange) * factor;
}

/**
 * Straight-line slope k from a paper grade given as ISO R (R180 very soft … R50 very
 * hard): the literal H&D gamma, `GRADE_CONTRAST_SCALE · range / (R / 100)`, with the
 * range held to [0.3, 3.5] and k to [SLOPE_MIN, SLOPE_MAX]. A non-finite range reads as
 * unmeasured (a normal negative's), a NaN grade as `NEUTRAL_ISO_R`.
 */
export function gradeToSlope(isoR: number, densityRange: number): number {
	const rangeIn = Number.isFinite(densityRange) ? densityRange : DEFAULT_GRADE_RANGE;
	const er = clamp(Number.isNaN(isoR) ? NEUTRAL_ISO_R : isoR, ISO_R_MIN, ISO_R_MAX) / 100;
	const range = clamp(Math.abs(rangeIn), GRADE_RANGE_MIN, GRADE_RANGE_MAX);
	return clamp((GRADE_CONTRAST_SCALE * range) / er, SLOPE_MIN, SLOPE_MAX);
}

/** The base curve's slope: Auto Grade at the fixed neutral paper grade. */
export function baseSlope(bounds: LogBounds, texturalRange: number): number {
	return gradeToSlope(
		NEUTRAL_ISO_R,
		effectiveGradeRange(luminanceDensityRange(bounds), texturalRange),
	);
}
