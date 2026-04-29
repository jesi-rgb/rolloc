<script lang="ts">
	/**
	 * Roll-level export toolbar.
	 *
	 * Floating, content-fit panel pinned to the top-center of the viewport
	 * while the user is in selection mode.
	 *
	 * Provides:
	 *  - Quick selection actions: All, Edited, Clear, Invert.
	 *  - Joined scale + export button group (0.25× / 0.5× / 1× / Export).
	 *  - Inline progress bar + result summary while a job is in flight.
	 *  - Exit-selection close button.
	 *
	 * Pure presentational component — owns no async state itself; the parent
	 * route drives the actual export job and feeds progress back in.
	 */
	import { CheckIcon, XIcon } from "phosphor-svelte";
	import type { ExportScale, BatchExportProgress } from "$lib/export/batch";

	interface Props {
		/** Total frames in the roll — drives the "of N" counts. */
		totalFrames: number;
		/** Number of frames currently in the selection set. */
		selectedCount: number;
		/** Number of frames the user has marked as "edited" (non-null overrides). */
		editedCount: number;
		scale: ExportScale;
		exporting: boolean;
		/** Live progress while exporting; null when idle. */
		progress: BatchExportProgress | null;
		/** Last completed run's summary; null while a job is in flight or pre-job. */
		lastResult: {
			exported: number;
			skipped: number;
			failed: number;
		} | null;
		onScaleChange: (scale: ExportScale) => void;
		onSelectAll: () => void;
		onSelectEdited: () => void;
		onClear: () => void;
		onInvert: () => void;
		onExport: () => void;
		/** Cancel a running export (best-effort — current frame finishes). */
		onCancel: () => void;
		/** Exit selection mode entirely. */
		onExit: () => void;
	}

	let {
		totalFrames,
		selectedCount,
		editedCount,
		scale,
		exporting,
		progress,
		lastResult,
		onScaleChange,
		onSelectAll,
		onSelectEdited,
		onClear,
		onInvert,
		onExport,
		onCancel,
		onExit,
	}: Props = $props();

	const percent = $derived(
		progress && progress.total > 0
			? Math.round((progress.processed / progress.total) * 100)
			: 0,
	);

	const exportDisabled = $derived(exporting || selectedCount === 0);

	const SCALES: ExportScale[] = [0.25, 0.5, 1];
</script>

<div
	class="fixed top-2xl left-1/2 -translate-x-1/2 z-20
	       flex flex-col items-stretch gap-xs
	       rounded-lg border border-base-subtle bg-base/80 backdrop-blur-xl
	       shadow-lg shadow-black/10
	       px-base py-sm"
>
	<!-- Single-row toolbar ────────────────────────────────────────────── -->
	<div class="flex items-center gap-base whitespace-nowrap">
		<!-- Selection count -->
		<span class="text-sm text-content">
			<span class="font-semibold tabular-nums">{selectedCount}</span>
			<span class="text-content-muted">/ {totalFrames} selected</span>
		</span>

		<!-- Selection actions -->
		<div class="flex items-center gap-xs">
			<button
				type="button"
				onclick={onSelectAll}
				disabled={exporting}
				class="px-sm py-xs text-xs rounded border border-base-subtle text-content-muted
				       hover:border-content-muted hover:text-content transition
				       disabled:opacity-40 disabled:cursor-not-allowed"
			>
				Select all
			</button>
			<button
				type="button"
				onclick={onSelectEdited}
				disabled={exporting || editedCount === 0}
				title={editedCount === 0
					? "No edited frames in this roll"
					: undefined}
				class="px-sm py-xs text-xs rounded border border-base-subtle text-content-muted
				       hover:border-content-muted hover:text-content transition
				       disabled:opacity-40 disabled:cursor-not-allowed"
			>
				Select edited
				{#if editedCount > 0}
					<span class="text-content-subtle tabular-nums"
						>({editedCount})</span
					>
				{/if}
			</button>
			<button
				type="button"
				onclick={onInvert}
				disabled={exporting}
				class="px-sm py-xs text-xs rounded border border-base-subtle text-content-muted
				       hover:border-content-muted hover:text-content transition
				       disabled:opacity-40 disabled:cursor-not-allowed"
			>
				Invert
			</button>
			<button
				type="button"
				onclick={onClear}
				disabled={exporting || selectedCount === 0}
				class="px-sm py-xs text-xs rounded border border-base-subtle text-content-muted
				       hover:border-content-muted hover:text-content transition
				       disabled:opacity-40 disabled:cursor-not-allowed"
			>
				Clear
			</button>
		</div>

		<!-- Joined scale + export group ─────────────────────────────── -->
		<div class="flex items-stretch" aria-label="Export scale and action">
			{#each SCALES as s (s)}
				{@const sel = scale === s}
				<button
					type="button"
					onclick={() => onScaleChange(s)}
					aria-pressed={sel}
					disabled={exporting}
					class="px-sm py-xs text-xs font-medium transition border border-r-0 first:rounded-l
					       {sel
						? 'bg-primary/15 border-primary text-primary z-10'
						: 'border-base-subtle text-content-muted hover:border-content-muted hover:text-content'}
					       disabled:opacity-40 disabled:cursor-not-allowed"
				>
					{s}x
				</button>
			{/each}

			{#if exporting}
				<button
					type="button"
					onclick={onCancel}
					class="px-base py-xs rounded-r border border-danger text-danger text-sm font-medium
					       hover:bg-danger/10 transition"
				>
					Cancel
				</button>
			{:else}
				<button
					type="button"
					onclick={onExport}
					disabled={exportDisabled}
					class="px-base py-xs rounded-r border border-primary text-primary text-sm font-medium
					       hover:bg-primary/10 transition
					       disabled:opacity-40 disabled:cursor-not-allowed"
				>
					Export{selectedCount > 0 ? ` ${selectedCount}` : ""}
					{selectedCount === 1 ? "frame" : "frames"}
				</button>
			{/if}
		</div>

		<!-- Exit selection mode -->
		<button
			type="button"
			onclick={onExit}
			disabled={exporting}
			aria-label="Exit selection mode"
			class="p-xs rounded text-content-muted hover:text-content hover:bg-base-subtle
			       transition disabled:opacity-40 disabled:cursor-not-allowed"
		>
			<XIcon size={16} />
		</button>
	</div>

	<!-- Progress bar (only while exporting) ───────────────────────────── -->
	{#if exporting && progress}
		<div class="flex items-center gap-sm">
			<div
				class="flex-1 h-1.5 rounded-full bg-base-subtle overflow-hidden"
			>
				<div
					class="h-full bg-primary rounded-full transition-all duration-150"
					style="width: {percent}%"
				></div>
			</div>
			<span class="text-xs text-content-subtle tabular-nums shrink-0">
				{progress.processed} / {progress.total}
			</span>
		</div>
	{/if}

	<!-- Last-run summary (after a job completes) ──────────────────────── -->
	{#if !exporting && lastResult}
		<div class="flex items-center gap-base text-xs">
			<span class="flex items-center gap-1 text-success">
				<CheckIcon size={14} />
				<span class="tabular-nums">{lastResult.exported}</span> exported
			</span>
			{#if lastResult.skipped > 0}
				<span class="text-content-muted">
					<span class="tabular-nums">{lastResult.skipped}</span> skipped
					(non-RAW)
				</span>
			{/if}
			{#if lastResult.failed > 0}
				<span class="text-danger">
					<span class="tabular-nums">{lastResult.failed}</span> failed
				</span>
			{/if}
		</div>
	{/if}
</div>
