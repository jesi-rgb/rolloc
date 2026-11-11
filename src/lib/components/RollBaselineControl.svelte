<script lang="ts">
	/**
	 * Roll baseline control for the roll toolbar: a trigger button and a
	 * popover that runs the roll analysis (progress, cancel), reads out the
	 * stored baseline and edits it — the "Tonal range" (`useLuma`) and
	 * "Colour balance" (`useColor`) axes, clear, re-run when stale.
	 *
	 * The film base and orange mask are roll properties: pooling bounds across
	 * the roll removes the frame-to-frame colour drift per-frame bounds pick up
	 * from content. Frames shot under another light are outliers and keep their
	 * own bounds.
	 *
	 * Owns the analysis run it starts; unmounting (leaving or switching the
	 * roll) cancels it, which leaves the stored baseline untouched.
	 */
	import { onDestroy } from "svelte";
	import { StackIcon, WarningIcon, TrashIcon, XIcon } from "phosphor-svelte";
	import ToggleButton from "$lib/components/ToggleButton.svelte";
	import { setRollBaseline } from "$lib/db/rolls";
	import {
		analyzeRoll,
		negativeFilmType,
		type FrameFailure,
		type RollAnalysisProgress,
	} from "$lib/image/negative/roll-analysis";
	import { ANALYSIS_VERSION } from "$lib/types";
	import type { Frame, Roll, RollBaseline } from "$lib/types";

	interface Props {
		roll: Roll;
		/** The roll's frames, for the readout's counts and outlier names. */
		frames: Frame[];
		/** Receives the roll as stored after every baseline change. */
		onRollChange: (roll: Roll) => void;
	}

	let { roll, frames, onRollChange }: Props = $props();

	let open = $state(false);
	let root = $state<HTMLDivElement | null>(null);

	let controller = $state<AbortController | null>(null);
	let progress = $state<RollAnalysisProgress | null>(null);
	let saving = $state(false);
	let error = $state<string | null>(null);
	/** Frames the last run in this session could not decode. */
	let failures = $state<FrameFailure[]>([]);

	const running = $derived(controller !== null);
	const busy = $derived(running || saving);
	const baseline = $derived(roll.baseline ?? null);
	const stale = $derived(baseline !== null && baseline.version !== ANALYSIS_VERSION);
	const applies = $derived(
		baseline !== null && !stale && (baseline.useLuma || baseline.useColor),
	);

	const negativeIds = $derived(
		frames.filter((f) => negativeFilmType(roll, f) !== null).map((f) => f.id),
	);
	const outlierNames = $derived.by(() => {
		if (!baseline) return [];
		const byId = new Map(frames.map((f) => [f.id, f.filename]));
		return baseline.outlierFrameIds.map((id) => byId.get(id) ?? id);
	});
	/** Negative frames that render against the roll baseline (everything but the outliers). */
	const followCount = $derived(
		baseline === null
			? 0
			: negativeIds.filter((id) => !baseline.outlierFrameIds.includes(id)).length,
	);
	const percent = $derived(
		progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0,
	);

	const analyzedAt = $derived(
		baseline === null
			? ""
			: new Date(baseline.analyzedAt).toLocaleString(undefined, {
					dateStyle: "medium",
					timeStyle: "short",
				}),
	);

	function message(err: unknown): string {
		return err instanceof Error ? err.message : String(err);
	}

	async function runAnalysis(): Promise<void> {
		if (busy) return;
		const ctrl = new AbortController();
		controller = ctrl;
		error = null;
		failures = [];
		progress = null;
		try {
			const result = await analyzeRoll({
				rollId: roll.id,
				signal: ctrl.signal,
				onProgress: (p) => {
					if (!ctrl.signal.aborted) progress = p;
				},
			});
			failures = result.failures;
			onRollChange(result.roll);
		} catch (err) {
			if (!ctrl.signal.aborted) error = message(err);
		} finally {
			if (controller === ctrl) {
				controller = null;
				progress = null;
			}
		}
	}

	function cancelAnalysis(): void {
		controller?.abort();
		controller = null;
		progress = null;
	}

	/** Persists a baseline edit (`null` clears it) and hands the stored roll up. */
	async function save(next: RollBaseline | null): Promise<void> {
		if (busy) return;
		saving = true;
		error = null;
		try {
			// Snapshot: `next` is spread from the reactive roll, and IndexedDB cannot clone proxies.
			const stored = await setRollBaseline(roll.id, next && $state.snapshot(next));
			if (stored) onRollChange(stored);
			else error = "This roll no longer exists.";
		} catch (err) {
			error = `Could not save the baseline: ${message(err)}`;
		} finally {
			saving = false;
		}
	}

	function clearBaseline(): void {
		failures = [];
		void save(null);
	}

	function onWindowPointerDown(e: PointerEvent): void {
		if (open && root && !root.contains(e.target as Node)) open = false;
	}

	function onPanelKeydown(e: KeyboardEvent): void {
		if (e.key === "Escape") {
			e.stopPropagation();
			open = false;
		}
	}

	onDestroy(() => controller?.abort());
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<div bind:this={root} class="relative">
	<button
		type="button"
		onclick={() => (open = !open)}
		aria-haspopup="dialog"
		aria-expanded={open}
		title="Roll baseline: one film base and mask for the whole roll"
		class="flex items-center gap-xs px-sm py-xs text-xs rounded-md transition
		       {open
			? 'bg-base-muted text-content'
			: 'text-content-muted hover:text-content hover:bg-base-muted'}"
	>
		<StackIcon size={14} />
		Baseline
		{#if running}
			<span class="tabular-nums text-content-subtle">{percent}%</span>
		{:else if stale}
			<WarningIcon size={12} class="text-primary" />
		{:else if applies}
			<span class="size-1.5 rounded-full bg-accent" aria-hidden="true"></span>
			<span class="sr-only">(active)</span>
		{/if}
	</button>

	{#if open}
		<div
			role="dialog"
			aria-label="Roll baseline"
			tabindex="-1"
			onkeydown={onPanelKeydown}
			class="absolute z-30 right-0 mt-xs w-80 flex flex-col gap-sm p-base
			       rounded-lg border border-base-subtle bg-surface shadow-lg animate-fadein"
		>
			<div class="flex items-start justify-between gap-sm">
				<div class="flex flex-col gap-0.5">
					<span class="text-sm font-semibold text-content">Roll baseline</span>
					<span class="text-xs text-content-muted">
						Pools the film base and mask across the roll so every frame shares one
						tonal range and colour balance.
					</span>
				</div>
				<button
					type="button"
					onclick={() => (open = false)}
					aria-label="Close"
					class="p-xs rounded text-content-muted hover:text-content hover:bg-base-subtle transition"
				>
					<XIcon size={14} />
				</button>
			</div>

			{#if running}
				<div class="flex flex-col gap-xs">
					<div class="flex items-center gap-sm">
						<div class="flex-1 h-1.5 rounded-full bg-base-subtle overflow-hidden">
							<div
								class="h-full bg-primary rounded-full transition-all duration-150"
								style="width: {percent}%"
							></div>
						</div>
						<span class="text-xs text-content-subtle tabular-nums shrink-0">
							{progress?.done ?? 0} / {progress?.total ?? "…"}
						</span>
					</div>
					<div class="flex items-center justify-between gap-sm text-xs">
						<span class="text-content-muted">
							Analyzing frames…
							{#if progress && progress.failed > 0}
								<span class="text-danger tabular-nums">{progress.failed} failed</span>
							{/if}
						</span>
						<button
							type="button"
							onclick={cancelAnalysis}
							class="px-sm py-xs rounded border border-danger text-danger font-medium
							       hover:bg-danger/10 transition"
						>
							Cancel
						</button>
					</div>
				</div>
			{:else if baseline === null}
				<button
					type="button"
					onclick={runAnalysis}
					disabled={busy || negativeIds.length === 0}
					title={negativeIds.length === 0 ? "This roll has no negative frames" : undefined}
					class="px-base py-xs rounded border border-primary text-primary text-sm font-medium
					       hover:bg-primary/10 transition disabled:opacity-40 disabled:cursor-not-allowed"
				>
					Analyze roll
				</button>
			{:else}
				{#if stale}
					<div class="flex items-start gap-xs text-xs text-content">
						<WarningIcon size={14} class="shrink-0 text-primary mt-px" />
						<span>
							Measured by an older analysis and not applied. Re-analyze the roll to use
							it again.
						</span>
					</div>
				{:else}
					<dl class="grid grid-cols-[auto_1fr] gap-x-sm gap-y-0.5 text-xs">
						<dt class="text-content-subtle">Analyzed</dt>
						<dd class="text-content tabular-nums">{analyzedAt}</dd>
						<dt class="text-content-subtle">Pooled</dt>
						<dd class="text-content tabular-nums">
							{followCount} frame{followCount === 1 ? "" : "s"} follow the roll
						</dd>
						<dt class="text-content-subtle">Outliers</dt>
						<dd class="text-content" title={outlierNames.join("\n") || undefined}>
							{#if outlierNames.length === 0}
								<span class="text-content-muted">None</span>
							{:else}
								<span class="tabular-nums">{outlierNames.length}</span> kept on their own
								bounds
							{/if}
						</dd>
					</dl>

					<div class="flex items-center gap-xs" role="group" aria-label="Apply from the roll">
						<ToggleButton
							fill
							active={baseline.useLuma}
							disabled={busy}
							title="Take the roll's density range: brightness and contrast"
							onclick={() => save({ ...baseline, useLuma: !baseline.useLuma })}
						>
							Tonal range
						</ToggleButton>
						<ToggleButton
							fill
							active={baseline.useColor}
							disabled={busy}
							title="Take the roll's per-channel balance: the mask colour"
							onclick={() => save({ ...baseline, useColor: !baseline.useColor })}
						>
							Colour balance
						</ToggleButton>
					</div>
				{/if}

				<div class="flex items-center justify-between gap-sm">
					<button
						type="button"
						onclick={runAnalysis}
						disabled={busy || negativeIds.length === 0}
						class="px-sm py-xs text-xs rounded border transition
						       disabled:opacity-40 disabled:cursor-not-allowed
						       {stale
							? 'border-primary text-primary font-medium hover:bg-primary/10'
							: 'border-base-subtle text-content-muted hover:border-content-muted hover:text-content'}"
					>
						Re-analyze
					</button>
					<button
						type="button"
						onclick={clearBaseline}
						disabled={busy}
						class="flex items-center gap-xs px-sm py-xs text-xs rounded text-content-muted
						       hover:text-danger hover:bg-base-subtle transition
						       disabled:opacity-40 disabled:cursor-not-allowed"
					>
						<TrashIcon size={12} />
						Clear
					</button>
				</div>
			{/if}

			{#if failures.length > 0}
				<div class="flex flex-col gap-0.5 text-xs">
					<span class="text-danger">
						<span class="tabular-nums">{failures.length}</span>
						frame{failures.length === 1 ? "" : "s"} could not be decoded and
						{failures.length === 1 ? "was" : "were"} left out:
					</span>
					<ul class="max-h-24 overflow-y-auto text-content-muted">
						{#each failures as failure (failure.frameId)}
							<li class="truncate" title={failure.message}>{failure.filename}</li>
						{/each}
					</ul>
				</div>
			{/if}

			{#if error}
				<p role="alert" class="text-xs text-danger">{error}</p>
			{/if}
		</div>
	{/if}
</div>
