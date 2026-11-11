<script lang="ts">
	/**
	 * Strip under the editor preview: live RGB histogram of the rendered
	 * output with shadow/highlight clipping indicators and readouts.
	 */
	import HistogramPlot from '$lib/components/HistogramPlot.svelte';
	import { clippedFractions, normalizeRgbCounts } from '$lib/image/histogram';
	import type { RgbCounts } from '$lib/image/histogram';

	interface Props {
		/** Counts from the last render; null until the first paint. */
		histogram: RgbCounts | null;
	}

	let { histogram }: Props = $props();

	/** Share of pixels above which a clipping indicator lights up (0.1%). */
	const CLIP_WARN = 0.001;

	const bins = $derived(histogram ? normalizeRgbCounts(histogram) : null);
	const clip = $derived(histogram ? clippedFractions(histogram) : null);

	function formatShare(v: number): string {
		if (v === 0) return '0%';
		if (v < 0.001) return '<0.1%';
		return `${(v * 100).toFixed(1)}%`;
	}
</script>

{#snippet clipIndicator(side: 'shadows' | 'highlights', share: number)}
	<svg
		viewBox="0 0 8 8"
		class="absolute top-xs size-2 transition-[color,opacity] duration-150 ease
		       {side === 'shadows' ? 'left-xs' : 'right-xs'}
		       {share >= CLIP_WARN ? 'text-content' : 'text-content-subtle opacity-40'}"
		aria-hidden="true"
	>
		<path d={side === 'shadows' ? 'M0 0H8L0 8Z' : 'M0 0H8V8Z'} fill="currentColor" />
	</svg>
{/snippet}

<!-- Height comes from the content plus py-sm, so the gaps above and below are equal. -->
<div class="flex items-center gap-l px-base py-sm border-t border-base-subtle bg-base">
	<div class="w-80 shrink-0 flex flex-col gap-1.5">
		<div
			class="relative h-13 rounded-md bg-base-muted ring-1 ring-inset ring-base-subtle
			       overflow-hidden"
		>
			<!-- Quarter-tone guides -->
			{#each [25, 50, 75] as pct (pct)}
				<div class="absolute inset-y-0 w-px bg-base-subtle" style:left="{pct}%"></div>
			{/each}
			<!-- Baseline sits 1px below the box so empty bins' stroke is clipped away. -->
			<div
				class="absolute inset-x-0 top-xs -bottom-px transition-opacity duration-200 ease-out
				       {bins ? 'opacity-100' : 'opacity-0'}"
			>
				<HistogramPlot {bins} />
			</div>
			{#if clip}
				{@render clipIndicator('shadows', clip.shadows)}
				{@render clipIndicator('highlights', clip.highlights)}
			{/if}
		</div>

		<!-- Readouts sit under their corner indicators: shadows left, highlights right. -->
		<dl class="flex justify-between text-[10px] leading-3">
			<div class="flex gap-xs">
				<dt class="text-content-subtle">Shadows clip</dt>
				<dd
					class="tabular-nums
					       {clip && clip.shadows >= CLIP_WARN ? 'text-content' : 'text-content-muted'}"
				>
					{clip ? formatShare(clip.shadows) : '—'}
				</dd>
			</div>
			<div class="flex gap-xs">
				<dt class="text-content-subtle">Highlights clip</dt>
				<dd
					class="tabular-nums
					       {clip && clip.highlights >= CLIP_WARN ? 'text-content' : 'text-content-muted'}"
				>
					{clip ? formatShare(clip.highlights) : '—'}
				</dd>
			</div>
		</dl>
	</div>
</div>
