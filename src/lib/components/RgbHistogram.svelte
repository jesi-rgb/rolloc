<script lang="ts">
	/**
	 * RGB histogram of an image blob URL.
	 *
	 * Samples pixel data using OffscreenCanvas at a reduced resolution
	 * (max 200×200) to keep it fast on the main thread, then renders the
	 * channels with `HistogramPlot`.
	 */
	import HistogramPlot from '$lib/components/HistogramPlot.svelte';
	import { HISTOGRAM_BINS, normalizeRgbCounts } from '$lib/image/histogram';
	import type { RgbBins } from '$lib/image/histogram';

	const SAMPLE_SIZE = 200; // max dimension for the sampling canvas
	const PLOT_H = 80;
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

	let bins = $state.raw<RgbBins | null>(null);

	$effect(() => {
		const currentUrl: string | null = url;

		// Clear stale histogram immediately so the old image's bars don't linger
		bins = null;

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

				const r = new Uint32Array(HISTOGRAM_BINS);
				const g = new Uint32Array(HISTOGRAM_BINS);
				const b = new Uint32Array(HISTOGRAM_BINS);

				for (let i = 0; i < data.length; i += 4) {
					r[data[i]]++;
					g[data[i + 1]]++;
					b[data[i + 2]]++;
				}

				if (cancelled) return;
				bins = normalizeRgbCounts({ r, g, b, pixels: w * h });
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
</script>

{#if url}
	<div class="mb-base" style="height: {PLOT_H}px;">
		{#if bins}
			<HistogramPlot {bins} />
		{/if}
	</div>
{/if}
