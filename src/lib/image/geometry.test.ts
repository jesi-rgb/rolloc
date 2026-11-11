import { describe, it, expect } from 'vitest';
import { rotationCoverZoom } from '$lib/image/geometry';

/**
 * Where each output-canvas corner samples the source, per transform.wgsl,
 * in source-normalized units (inside ⇔ both coords within [-0.5, 0.5]).
 */
function cornerSamples(rotationDeg: number, aspect: number, zoom: number): [number, number][] {
	const swapped = ((Math.round(rotationDeg / 90) % 2) + 2) % 2 === 1;
	const cw = swapped ? 1 : aspect;
	const ch = swapped ? aspect : 1;
	const a = (rotationDeg * Math.PI) / 180;
	return [
		[-0.5, -0.5],
		[0.5, -0.5],
		[0.5, 0.5],
		[-0.5, 0.5],
	].map(([u, v]) => {
		const px = (u / zoom) * cw;
		const py = (v / zoom) * ch;
		const rx = px * Math.cos(a) - py * Math.sin(a);
		const ry = px * Math.sin(a) + py * Math.cos(a);
		return [rx / aspect, ry];
	});
}

describe('rotationCoverZoom', () => {
	const cases: [number, number][] = [];
	for (const aspect of [1.5, 2 / 3, 1, 16 / 9]) {
		for (const rotation of [0.3, -4, 12, 45, -45, 90, 93.5, -97, 180, 177, 268]) {
			cases.push([rotation, aspect]);
		}
	}

	it.each(cases)('covers the canvas exactly at %f° (aspect %f)', (rotation, aspect) => {
		const zoom = rotationCoverZoom(rotation, aspect);
		const extent = Math.max(
			...cornerSamples(rotation, aspect, zoom).map(([x, y]) => Math.max(Math.abs(x), Math.abs(y))),
		);
		// Every corner inside the source, and the tightest corner on its edge.
		expect(extent).toBeCloseTo(0.5, 9);
	});

	it('is 1 at exact 90° steps', () => {
		for (const rotation of [0, 90, -90, 180, 270]) {
			expect(rotationCoverZoom(rotation, 1.5)).toBeCloseTo(1, 12);
		}
	});
});
