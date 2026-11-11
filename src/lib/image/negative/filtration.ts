/**
 * Print filtration: the CMY sliders as absolute density, and the white-balance
 * picker that sets them from a sample of the negative.
 *
 * Ported from NegPy 0.68 `filtration_offsets`, `density_to_cmy` and
 * `calculate_wb_shifts_from_log` (negpy/features/exposure/logic.py) and the
 * regional CMY scaling in `ExposureProcessor` (processor.py). Mirrored in
 * src-tauri/src/negative/filtration.rs (the picker is UI-only).
 */

import { CMY_MAX_DENSITY } from './constants';
import type { LogBounds, Vec3 } from '$lib/types';

/** Smallest channel range a division sees (NegPy `max(abs(range), 1e-6)`). */
const MIN_RANGE = 1e-6;

/** `|ceil − floor|` of one channel, floored so it can divide. */
function channelRange(bounds: LogBounds, ch: 0 | 1 | 2): number {
	return Math.max(Math.abs(bounds.ceils[ch] - bounds.floors[ch]), MIN_RANGE);
}

function finiteOr0(v: number): number {
	return Number.isFinite(v) ? v : 0;
}

/**
 * Global CMY sliders as offsets added to the normalized value `u`
 * (`filtration_offsets`): `slider · CMY_MAX_DENSITY` is an absolute density
 * (1.0 = 20cc), divided by each channel's stretch range so the same slider
 * prints the same filtration on every frame and channel.
 */
export function filtrationOffsets(cmy: Vec3, bounds: LogBounds): Vec3 {
	return [
		finiteOr0((cmy[0] * CMY_MAX_DENSITY) / channelRange(bounds, 0)),
		finiteOr0((cmy[1] * CMY_MAX_DENSITY) / channelRange(bounds, 1)),
		finiteOr0((cmy[2] * CMY_MAX_DENSITY) / channelRange(bounds, 2)),
	];
}

/** Shadow/highlight CMY sliders as absolute print density (processor.py, `* cmy_max`). */
export function regionalCmy(cmy: Vec3): Vec3 {
	return [
		finiteOr0(cmy[0] * CMY_MAX_DENSITY),
		finiteOr0(cmy[1] * CMY_MAX_DENSITY),
		finiteOr0(cmy[2] * CMY_MAX_DENSITY),
	];
}

/**
 * Absolute magenta/yellow slider values that neutralize a patch of the negative
 * (`calculate_wb_shifts_from_log` + `density_to_cmy`). `rawLog` is the patch's
 * mean log10 density; it is normalized with `bounds` the way the render does,
 * and red is the anchor, so cyan stays 0. Each deviation from red is turned
 * into absolute density by its own channel's range. Clamped to [-1, 1];
 * (0, 0) when the sample is not finite.
 */
export function wbShiftsFromLog(rawLog: Vec3, bounds: LogBounds): { magenta: number; yellow: number } {
	const u = (ch: 0 | 1 | 2): number => {
		const span = bounds.ceils[ch] - bounds.floors[ch];
		const safe = Math.abs(span) > MIN_RANGE ? span : MIN_RANGE;
		return (rawLog[ch] - bounds.floors[ch]) / safe;
	};
	const ur = u(0);
	const magenta = ((ur - u(1)) * Math.abs(bounds.ceils[1] - bounds.floors[1])) / CMY_MAX_DENSITY;
	const yellow = ((ur - u(2)) * Math.abs(bounds.ceils[2] - bounds.floors[2])) / CMY_MAX_DENSITY;
	return {
		magenta: Math.min(Math.max(finiteOr0(magenta), -1), 1),
		yellow: Math.min(Math.max(finiteOr0(yellow), -1), 1),
	};
}
