<script lang="ts">
	/**
	 * Roll detail page — filmstrip grid + metadata panel.
	 *
	 * Keyboard shortcuts:
	 *   ← / → (or j / k)   — prev / next frame
	 *   0–5                 — set rating on selected frame
	 *   p                   — toggle pick flag
	 *   x                   — toggle reject flag
	 */
	import { onMount, onDestroy } from "svelte";
	import { goto } from "$app/navigation";
	import { page } from "$app/state";
	import { getRoll, getRollPath } from "$lib/db/rolls";
	import { getFrames, putFrame } from "$lib/db/idb";
	import type { Roll, Frame, FrameFlag, FilmType } from "$lib/types";
	import { DEFAULT_INVERSION_PARAMS, frameHasEdits } from "$lib/types";
	import { PaneGroup, Pane, PaneResizer } from "paneforge";
	import FrameThumb from "$lib/components/FrameThumb.svelte";
	import FrameMetaPanel from "$lib/components/FrameMetaPanel.svelte";
	import KeyboardHintBar from "$lib/components/KeyboardHintBar.svelte";
	import VirtualGrid from "$lib/components/VirtualGrid.svelte";
	import RollExportBar from "$lib/components/RollExportBar.svelte";
	import { type ExportScale } from "$lib/export/batch";
	import {
		getJobForRoll,
		startExport,
		cancelJob,
		dismissJob,
		isJobActive,
	} from "$lib/jobs.svelte";
	import {
		prefetchThumbs,
		resetThumbQueueProgress,
		thumbQueueProgress,
		onThumbProgress,
	} from "$lib/image/thumb-queue";

	// $page.params.id is typed string | undefined in SvelteKit; guard below
	const rollId = $derived(page.params.id ?? "");

	let roll = $state<Roll | null>(null);
	let frames = $state<Frame[]>([]);
	let dirPath = $state<string | null>(null);
	let selIdx = $state(0);
	let loading = $state(true);

	// Reactive snapshot of the shared thumb-queue progress counters.
	let thumbProgress = $state({ cached: 0, generating: 0, total: 0 });

	/**
	 * True once all thumbnails for this roll are either cached or generated.
	 * While false, the filmstrip grid is inert (no interaction) and a progress
	 * overlay is shown so the user knows generation is in flight.
	 */
	const thumbsReady = $derived(
		thumbProgress.total === 0 ||
			thumbProgress.cached >= thumbProgress.total,
	);

	const selected = $derived(frames[selIdx] ?? null);

	// ─── Selection / batch export state ───────────────────────────────────────

	/** True when the user has entered "select frames for export" mode. */
	let selecting = $state(false);
	/** Set of frame IDs picked for export. */
	let pickedIds = $state<Set<string>>(new Set());
	let exportScale = $state<ExportScale>(1);

	const selectedCount = $derived(pickedIds.size);
	const editedCount = $derived(
		roll === null ? 0 : frames.filter((f) => frameHasEdits(f, roll!)).length,
	);

	// Live view of the most recent export job for this roll.  Driven by the
	// global jobs store so the bar keeps showing live progress even if the
	// user navigates away and comes back, and reflects state mutated from
	// the BackgroundJobsDock (cancel / dismiss).
	const job = $derived(rollId ? getJobForRoll(rollId) : null);
	const exporting = $derived(job !== null && isJobActive(job.status));
	const cancelling = $derived(job?.status === "cancelling");
	const queued = $derived(job?.status === "queued");
	const exportProgress = $derived(exporting ? (job?.progress ?? null) : null);
	const exportLastResult = $derived(
		job &&
			(job.status === "done" ||
				job.status === "cancelled" ||
				job.status === "error")
			? job.result
			: null,
	);

	function togglePicked(frame: Frame): void {
		// Use a fresh Set so the $state proxy notices the change.
		const next = new Set(pickedIds);
		if (next.has(frame.id)) {
			next.delete(frame.id);
		} else {
			next.add(frame.id);
		}
		pickedIds = next;
	}

	function enterSelectionMode(): void {
		selecting = true;
		// If there's a stale terminal job for this roll, dismiss it so the
		// bar starts clean.  Active jobs (queued/running) are left alone so
		// the user sees ongoing progress.
		if (job && !isJobActive(job.status)) {
			dismissJob(job.id);
		}
	}

	function exitSelectionMode(): void {
		selecting = false;
		pickedIds = new Set();
	}

	function selectAll(): void {
		pickedIds = new Set(frames.map((f) => f.id));
	}

	function selectEdited(): void {
		if (roll === null) return;
		const r = roll;
		pickedIds = new Set(frames.filter((f) => frameHasEdits(f, r)).map((f) => f.id));
	}

	function clearSelection(): void {
		pickedIds = new Set();
	}

	function invertSelection(): void {
		const next = new Set<string>();
		for (const f of frames) if (!pickedIds.has(f.id)) next.add(f.id);
		pickedIds = next;
	}

	function runExport(): void {
		if (!roll || !dirPath || pickedIds.size === 0 || exporting) return;
		const targets = frames.filter((f) => pickedIds.has(f.id));
		startExport({
			rollId,
			rollLabel: roll.label,
			roll,
			frames:    targets,
			dirPath,
			scale:     exportScale,
		});
		// Hand off to the background jobs dock — clear selection state so
		// the user comes back to a clean roll page.
		exitSelectionMode();
	}

	function cancelExport(): void {
		if (job && isJobActive(job.status)) {
			cancelJob(job.id);
		}
	}

	onMount(async () => {
		// Reset any counters left by a previous page visit.
		resetThumbQueueProgress();

		// Keep our local reactive snapshot in sync with the queue.
		onThumbProgress(() => {
			thumbProgress = { ...thumbQueueProgress };
		});

		if (!rollId) {
			loading = false;
			return;
		}

		const [r, f] = await Promise.all([getRoll(rollId), getFrames(rollId)]);
		roll = r ?? null;
		// Camera scans usually encode order in the filename — sort with
		// natural/numeric-aware comparison so IMG_2 < IMG_10.
		const collator = new Intl.Collator(undefined, {
			numeric: true,
			sensitivity: "base",
		});
		frames = f.slice().sort((a, b) => collator.compare(a.filename, b.filename));

		if (!roll) {
			loading = false;
			return;
		}

		const path = await getRollPath(rollId);
		if (path) dirPath = path;

		loading = false;

		// Kick off background generation for all frames immediately.
		// Uses the worker pool so it runs off the main thread; high-priority
		// requests from IntersectionObserver (FrameThumb) will jump the queue.
		// Pass each frame's film type for correct processing.
		if (dirPath && frames.length > 0) {
			void prefetchThumbs(
				frames.map((f) => ({
					id: f.id,
					relativePath: f.filename,
					filmType: f.frameEdit.inversionParams?.filmType ?? DEFAULT_INVERSION_PARAMS.filmType,
				})),
				dirPath,
			);
		}
	});

	onDestroy(() => {
		onThumbProgress(null);
		resetThumbQueueProgress();
	});

	function selectFrame(f: Frame) {
		const idx = frames.findIndex((fr) => fr.id === f.id);
		if (idx >= 0) selIdx = idx;
	}

	function openFrame(f: Frame) {
		void goto(`/roll/${rollId}/frame/${f.id}`);
	}

	function onFrameUpdated(updated: Frame) {
		frames = frames.map((f) => (f.id === updated.id ? updated : f));
	}

	// ─── Keyboard shortcuts ───────────────────────────────────────────────────

	async function handleKeydown(e: KeyboardEvent) {
		// Don't intercept when typing in an input or textarea
		const tag = (e.target as HTMLElement | null)?.tagName;
		if (tag === "INPUT" || tag === "TEXTAREA") return;

		// While in selection mode the keyboard maps to selection actions only.
		if (selecting) {
			if (e.key === "Escape" && !exporting) {
				e.preventDefault();
				exitSelectionMode();
			} else if (e.key === " " && selected) {
				// Space toggles the focused frame's pick state.
				e.preventDefault();
				togglePicked(selected);
			} else if (e.key === "ArrowLeft" || e.key === "k") {
				e.preventDefault();
				selIdx = Math.max(0, selIdx - 1);
			} else if (e.key === "ArrowRight" || e.key === "j") {
				e.preventDefault();
				selIdx = Math.min(frames.length - 1, selIdx + 1);
			}
			return;
		}

		switch (e.key) {
			case "ArrowLeft":
			case "k":
				e.preventDefault();
				selIdx = Math.max(0, selIdx - 1);
				break;
			case "ArrowRight":
			case "j":
				e.preventDefault();
				selIdx = Math.min(frames.length - 1, selIdx + 1);
				break;
			case "e":
			case "Enter":
				if (selected) {
					e.preventDefault();
					await goto(`/roll/${rollId}/frame/${selected.id}`);
				}
				break;
			default:
				if (/^[0-5]$/.test(e.key) && selected) {
					await setRating(selected, Number(e.key));
				} else if (e.key === "p" && selected) {
					await toggleFlag(selected, "pick");
				} else if (e.key === "x" && selected) {
					await toggleFlag(selected, "reject");
				}
		}
	}

	async function setRating(f: Frame, r: number) {
		const updated: Frame = { ...$state.snapshot(f), rating: r };
		await putFrame(updated);
		onFrameUpdated(updated);
	}

	async function toggleFlag(f: Frame, flag: FrameFlag) {
		const snap = $state.snapshot(f);
		const hasIt = snap.flags.includes(flag);
		const updated: Frame = {
			...snap,
			flags: hasIt
				? snap.flags.filter((fl) => fl !== flag)
				: [...snap.flags, flag],
		};
		await putFrame(updated);
		onFrameUpdated(updated);
	}
</script>

<svelte:head>
	<title>{roll?.label ?? "Roll"} — Rolloc</title>
</svelte:head>

<svelte:window onkeydown={handleKeydown} />

<div class="h-screen bg-base text-content flex flex-col">
	<!-- Top bar -->
	<header
		class="flex items-center gap-base px-l py-sm border-b border-base-subtle shrink-0"
	>
		<a
			href="/"
			class="text-content-muted hover:text-content transition text-sm"
			>← Library</a
		>
		{#if roll}
			<span class="font-semibold text-content">{roll.label}</span>
			{#if roll.filmStock}
				<span class="text-primary-muted/80 text-sm"
					>{roll.filmStock}</span
				>
			{/if}
			{#if roll.camera}
				<span class="text-content-muted text-sm">{roll.camera}</span>
			{/if}
			<span class="text-xs text-content-subtle">
				{frames.length} frame{frames.length !== 1 ? "s" : ""}
			</span>

			<div class="flex-1"></div>

			{#if !selecting && frames.length > 0}
				<button
					type="button"
					onclick={enterSelectionMode}
					class="px-sm py-xs text-xs rounded border border-base-subtle
					       text-content-muted hover:border-content-muted hover:text-content
					       transition"
				>
					Export…
				</button>
			{/if}
		{/if}
	</header>

	{#if selecting}
		<RollExportBar
			totalFrames={frames.length}
			{selectedCount}
			{editedCount}
			scale={exportScale}
			{exporting}
			{cancelling}
			{queued}
			progress={exportProgress}
			lastResult={exportLastResult}
			onScaleChange={(s) => (exportScale = s)}
			onSelectAll={selectAll}
			onSelectEdited={selectEdited}
			onClear={clearSelection}
			onInvert={invertSelection}
			onExport={runExport}
			onCancel={cancelExport}
			onExit={exitSelectionMode}
		/>
	{/if}

	{#if loading}
		<div class="flex-1 flex items-center justify-center text-content-muted">
			Loading…
		</div>
	{:else if !roll}
		<div class="flex-1 flex items-center justify-center text-content-muted">
			Roll not found.
		</div>
	{:else if frames.length === 0}
		<div class="flex-1 flex items-center justify-center text-content-muted">
			No frames found in this roll.
		</div>
	{:else}
		<!-- Main layout: resizable filmstrip grid + metadata panel -->

		<div class="relative h-full py-xl">
			<!-- Loading overlay — blocks interaction until all thumbs are ready -->
			{#if !thumbsReady}
				<div
					class="absolute inset-0 z-10 flex flex-col items-center justify-center
					gap-3 bg-base/80 backdrop-blur-sm"
				>
					<p class="text-sm text-content-muted">
						Generating thumbnails…
					</p>
					{#if thumbProgress.total > 0}
						<div class="w-48 flex flex-col items-center gap-1.5">
							<div
								class="w-full h-1.5 rounded-full bg-base-subtle overflow-hidden"
							>
								<div
									class="h-full bg-primary rounded-full transition-all duration-150"
									style="width: {Math.round(
										(thumbProgress.cached /
											thumbProgress.total) *
											100,
									)}%"
								></div>
							</div>
							<span
								class="text-xs text-content-subtle tabular-nums"
							>
								{thumbProgress.cached} / {thumbProgress.total}
							</span>
						</div>
					{/if}
				</div>
			{/if}

			<!-- Grid — pointer events blocked by inert while loading -->
			<div inert={!thumbsReady || undefined} class="h-full">
				<VirtualGrid items={frames} gap={6} overscan={3}>
					{#snippet item(frame, i)}
						<FrameThumb
							{frame}
							dirPath={dirPath!}
							selected={!selecting && i === selIdx}
							{selecting}
							picked={pickedIds.has(frame.id)}
							onSelect={selecting
								? togglePicked
								: selectFrame}
							onDblClick={selecting ? undefined : openFrame}
						/>
					{/snippet}
				</VirtualGrid>
			</div>
		</div>

		<!-- Keyboard shortcut hint bar -->
		<KeyboardHintBar
			hints={[
				{ keys: ["←", "→"], label: "navigate" },
				{ keys: ["e"], label: "edit" },
				{ keys: ["0–5"], label: "rate" },
				{ keys: ["p"], label: "pick" },
				{ keys: ["x"], label: "reject" },
			]}
		/>
	{/if}
</div>
