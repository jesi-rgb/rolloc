/**
 * Auto Density: where this negative's midtone sits in normalized space.
 *
 * The anchor is read over the frame's textured cells only, so sky, rebate and
 * flat walls do not drag it, and it moves only `ANCHOR_METER_STRENGTH` of the
 * way from `ASSUMED_ANCHOR` toward the measurement: a deliberately low- or
 * high-key scene keeps most of its key while gross mis-exposure is still
 * pulled toward correct.
 *
 * Port of NegPy 0.68 `measure_anchor_from_log`
 * (negpy/features/exposure/normalization.py), the `textured_anchor` binding
 * (negpy_core/src/py/meter.rs) and its `anchor_measure` kernel
 * (negpy_core/src/meter.rs). Mirrors src-tauri/src/negative/meter.rs — change
 * both together.
 */

import {
	ANCHOR_METER_BAND,
	ANCHOR_METER_STRENGTH,
	ANCHOR_TRIM_CLIP,
	ASSUMED_ANCHOR,
} from './constants';
import { gridLuma, percentiles, texturedCells } from './grid';
import type { LogGrid } from './grid';
import type { LogBounds } from '$lib/types';

/**
 * NegPy `anchor_measure`: the mean of the cells inside the `ANCHOR_TRIM_CLIP`
 * percentile trim, averaged with the trim's midpoint (Boyack & Juenger,
 * US 5,724,456), so a skewed histogram is placed by its detail-bearing span
 * rather than by its median. NaN when nothing survives the trim.
 */
function trimmedAnchor(lum: Float32Array): number {
	const [lo, hi] = percentiles(lum, [ANCHOR_TRIM_CLIP, 100 - ANCHOR_TRIM_CLIP]);
	let sum = 0;
	let n = 0;
	for (const v of lum) {
		if (v >= lo && v <= hi) {
			sum += v;
			n++;
		}
	}
	return n === 0 ? NaN : 0.5 * (sum / n + 0.5 * (lo + hi));
}

/**
 * The frame's anchor in normalized luma, already pulled and clamped to
 * `ASSUMED_ANCHOR ± ANCHOR_METER_BAND`. `bounds` are the ones the frame is
 * metered against (its own, or the roll's luma source). `ASSUMED_ANCHOR` when
 * the grid is empty or the measurement is not finite.
 */
export function measureAnchor(grid: LogGrid, bounds: LogBounds): number {
	// As `textured_anchor`: the activity gate and the trim both read the
	// normalized luma plane, so the gate threshold is in normalized units.
	const lum = texturedCells(gridLuma(grid, bounds), grid.width, grid.height);
	const measured = trimmedAnchor(lum);
	if (!Number.isFinite(measured)) return ASSUMED_ANCHOR;
	const pulled = ASSUMED_ANCHOR + ANCHOR_METER_STRENGTH * (measured - ASSUMED_ANCHOR);
	return Math.min(
		Math.max(pulled, ASSUMED_ANCHOR - ANCHOR_METER_BAND),
		ASSUMED_ANCHOR + ANCHOR_METER_BAND,
	);
}
