<script lang="ts">
	/**
	 * Overlapping R, G, B histogram areas, filling its container.
	 *
	 * Each channel uses mix-blend-mode: screen so overlaps produce additive
	 * colour: R+G = yellow, R+B = magenta, G+B = cyan, R+G+B = grey. The
	 * channels are pure-hue primaries so screen blending gives the
	 * photographic result. `isolation: isolate` contains the blending.
	 */
	import { HISTOGRAM_BINS } from '$lib/image/histogram';
	import type { RgbBins } from '$lib/image/histogram';

	interface Props {
		/** Normalised bin heights; nothing is drawn while null. */
		bins: RgbBins | null;
	}

	let { bins }: Props = $props();

	/** Plot space; the SVG stretches it over the container. */
	const W = 256;
	const H = 100;

	/** Contour points along the bin tops (x across [0, W], baseline at y = H). */
	function toContour(channel: Float32Array): string {
		const points: string[] = [];
		for (let i = 0; i < HISTOGRAM_BINS; i++) {
			const x = (i / (HISTOGRAM_BINS - 1)) * W;
			const y = H - channel[i] * H;
			points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
		}
		return points.join(' ');
	}

	// Only the contour is stroked: stroking the closed area also outlines the
	// baseline and the side edges, which reads as a grey rule under the plot.
	const channels = $derived(
		bins
			? [
					{ id: 'b', contour: toContour(bins.b), fill: 'rgba(0,80,255,0.55)', stroke: 'rgba(60,120,255,0.9)' },
					{ id: 'g', contour: toContour(bins.g), fill: 'rgba(0,220,0,0.55)', stroke: 'rgba(80,220,80,0.9)' },
					{ id: 'r', contour: toContour(bins.r), fill: 'rgba(255,0,0,0.55)', stroke: 'rgba(255,80,60,0.9)' },
				]
			: [],
	);
</script>

<svg
	viewBox="0 0 {W} {H}"
	preserveAspectRatio="none"
	class="block w-full h-full overflow-visible"
	aria-label="RGB histogram"
	role="img"
>
	<g style="isolation: isolate;">
		{#each channels as ch (ch.id)}
			<polygon
				points="0,{H} {ch.contour} {W},{H}"
				fill={ch.fill}
				style="mix-blend-mode: screen;"
			/>
			<polyline
				points={ch.contour}
				fill="none"
				stroke={ch.stroke}
				stroke-width="1.25"
				stroke-linejoin="round"
				vector-effect="non-scaling-stroke"
				style="mix-blend-mode: screen;"
			/>
		{/each}
	</g>
</svg>
