<script lang="ts">
	/**
	 * RGB histogram component.
	 *
	 * Samples pixel data from a blob URL using OffscreenCanvas, then renders
	 * overlapping R, G, B channel curves as an SVG polygon.
	 *
	 * The sampling is done at a reduced resolution (max 200×200) to keep it fast
	 * on the main thread. The 256-bin histograms are normalised to the tallest
	 * bin across all three channels so they share the same scale.
	 */

	const BINS = 256;
	const SAMPLE_SIZE = 200; // max dimension for the sampling canvas
	const SVG_W = 256;
	const SVG_H = 80;
	/**
	 * Cap the normalisation peak at this percentile of all bin values across
	 * all three channels.  Bins above the cap are clamped to 1.0, preventing a
	 * single clipped-highlight spike from flattening the rest of the histogram.
	 * 0.996 ≈ the 99.6th percentile — matches the behaviour of Apple Preview /
	 * Lightroom where highlights still show as tall bars but don't eclipse the
	 * midtone distribution.
	 */
	const PEAK_PERCENTILE = 0.996;
	/**
	 * Debounce delay in ms before pixel sampling begins.  When flipping through
	 * images quickly we skip sampling entirely for images the user doesn't pause
	 * on, keeping navigation instant.
	 */
	const DEBOUNCE_MS = 150;

	interface Props {
		/** Blob URL of the current image. When null the histogram is hidden. */
		url: string | null;
	}

	let { url }: Props = $props();

	// Each entry is a normalised array of 256 values in [0, 1]
	let rBins = $state<number[]>([]);
	let gBins = $state<number[]>([]);
	let bBins = $state<number[]>([]);

	$effect(() => {
		const currentUrl: string | null = url;

		// Clear stale histogram immediately so the old image's bars don't linger
		rBins = [];
		gBins = [];
		bBins = [];

		if (!currentUrl) return;

		let cancelled = false;
		const safeUrl: string = currentUrl;

		// Debounce: only start sampling if the user pauses on this image.
		// If url changes again within DEBOUNCE_MS the timer is cleared before
		// it fires, so we never do any work for images scrolled past quickly.
		const timer = setTimeout(() => {
			if (cancelled) return;

			async function compute(): Promise<void> {
				const img = new Image();
				img.crossOrigin = "anonymous";

				await new Promise<void>((resolve, reject) => {
					img.onload = () => resolve();
					img.onerror = () => reject(new Error("Failed to load image"));
					img.src = safeUrl;
				});

				if (cancelled) return;

				// Scale down to a small sample canvas for performance
				const scale = Math.min(
					1,
					SAMPLE_SIZE / Math.max(img.naturalWidth, img.naturalHeight),
				);
				const w = Math.max(1, Math.round(img.naturalWidth * scale));
				const h = Math.max(1, Math.round(img.naturalHeight * scale));

				const canvas = new OffscreenCanvas(w, h);
				const ctx = canvas.getContext(
					"2d",
				) as OffscreenCanvasRenderingContext2D | null;
				if (!ctx) return;

				ctx.drawImage(img, 0, 0, w, h);
				const { data } = ctx.getImageData(0, 0, w, h);

				if (cancelled) return;

				const r = new Float32Array(BINS);
				const g = new Float32Array(BINS);
				const b = new Float32Array(BINS);

				for (let i = 0; i < data.length; i += 4) {
					r[data[i]]++;
					g[data[i + 1]]++;
					b[data[i + 2]]++;
				}

				// Normalise using a percentile cap so a single clipped-highlight spike
				// doesn't flatten the rest of the distribution.
				// Collect all non-zero bin counts, sort, take the PEAK_PERCENTILE value.
				const allCounts: number[] = [];
				for (let i = 0; i < BINS; i++) {
					if (r[i] > 0) allCounts.push(r[i]);
					if (g[i] > 0) allCounts.push(g[i]);
					if (b[i] > 0) allCounts.push(b[i]);
				}

				if (allCounts.length === 0 || cancelled) return;

				allCounts.sort((a, z) => a - z);
				const capIndex = Math.floor(allCounts.length * PEAK_PERCENTILE);
				const peak = allCounts[Math.min(capIndex, allCounts.length - 1)];

				if (peak === 0) return;

				rBins = Array.from(r, (v) => Math.min(v / peak, 1));
				gBins = Array.from(g, (v) => Math.min(v / peak, 1));
				bBins = Array.from(b, (v) => Math.min(v / peak, 1));
			}

			compute().catch((err: unknown) => {
				if (!cancelled) {
					console.error("[RgbHistogram] compute error:", err);
				}
			});
		}, DEBOUNCE_MS);

		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	});

	/**
	 * Turns a 256-element normalised array into an SVG polygon points string
	 * that forms a filled area chart.  The baseline sits at y=SVG_H.
	 */
	function binsToPoints(bins: number[]): string {
		if (bins.length === 0) return "";

		const points: string[] = [];

		// bottom-left corner
		points.push(`0,${SVG_H}`);

		for (let i = 0; i < BINS; i++) {
			const x = (i / (BINS - 1)) * SVG_W;
			const y = SVG_H - bins[i] * SVG_H;
			points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
		}

		// bottom-right corner
		points.push(`${SVG_W},${SVG_H}`);

		return points.join(" ");
	}

	const rPoints = $derived(binsToPoints(rBins));
	const gPoints = $derived(binsToPoints(gBins));
	const bPoints = $derived(binsToPoints(bBins));
	const ready = $derived(rBins.length > 0);

	// Expand the viewBox by the stroke half-width on every side so the edge
	// strokes aren't clipped.  The polygon coordinates stay in [0, SVG_W] ×
	// [0, SVG_H]; we just give them a 1px breathing room around the perimeter.
	const PAD = 1;
	const viewBox = $derived(
		`${-PAD} ${-PAD} ${SVG_W + PAD * 2} ${SVG_H + PAD * 2}`,
	);
</script>

{#if url}
	<div class="mb-base" style="height: {SVG_H}px;">
		{#if ready}
			<svg
				viewBox={viewBox}
				width="100%"
				height={SVG_H}
				xmlns="http://www.w3.org/2000/svg"
				class="block rounded"
				aria-label="RGB histogram"
				role="img"
			>
				<!--
					Each channel uses mix-blend-mode:screen so overlaps produce
					additive colour: R+G=yellow, R+B=magenta, G+B=cyan, R+G+B=grey.
					The channels are pure-hue primaries at full brightness so screen
					blending gives the correct photographic result.
					The SVG needs isolation:isolate to contain blending to itself.
				-->
				<g style="isolation: isolate;">
					<polygon
						points={bPoints}
						fill="rgba(0,80,255,0.55)"
						stroke="rgba(60,120,255,0.9)"
						stroke-width="1.5"
						stroke-linejoin="round"
						style="mix-blend-mode: screen;"
					/>
					<polygon
						points={gPoints}
						fill="rgba(0,220,0,0.55)"
						stroke="rgba(80,220,80,0.9)"
						stroke-width="1.5"
						stroke-linejoin="round"
						style="mix-blend-mode: screen;"
					/>
					<polygon
						points={rPoints}
						fill="rgba(255,0,0,0.55)"
						stroke="rgba(255,80,60,0.9)"
						stroke-width="1.5"
						stroke-linejoin="round"
						style="mix-blend-mode: screen;"
					/>
				</g>
			</svg>
		{/if}
	</div>
{/if}
