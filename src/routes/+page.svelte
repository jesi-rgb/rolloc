<script lang="ts">
	/**
	 * Home — Rolls tab (default) and Libraries tab (`?tab=libraries`).
	 *
	 * Rolls tab: roll switcher sidebar + filmstrip grid of the selected roll.
	 * The selection lives in `?roll=<id>` and defaults to the newest roll.
	 * Switching rolls only changes the query string, so this component stays
	 * mounted and per-roll state is reloaded from an effect keyed on `rollId`
	 * rather than in `onMount`.
	 *
	 * Keyboard shortcuts (Rolls tab):
	 *   ← / → (or j / k)   — prev / next frame
	 *   0–5                 — set rating on selected frame
	 *   p                   — toggle pick flag
	 *   x                   — toggle reject flag
	 */
	import { onMount, onDestroy, untrack } from "svelte";
	import { goto } from "$app/navigation";
	import { page } from "$app/state";
	import {
		getRoll,
		getRolls,
		getRollPath,
		putFrame,
		deleteRoll,
		purgeRollFolderData,
	} from "$lib/db/rolls";
	import { getFrames } from "$lib/db/idb";
	import { getLibraries, deleteLibrary } from "$lib/db/libraries";
	import type { Roll, Frame, FrameFlag, Library } from "$lib/types";
	import { DEFAULT_INVERSION_PARAMS, frameHasEdits } from "$lib/types";
	import AppHeader from "$lib/components/AppHeader.svelte";
	import FrameThumb from "$lib/components/FrameThumb.svelte";
	import KeyboardHintBar from "$lib/components/KeyboardHintBar.svelte";
	import NewRollDialog from "$lib/components/NewRollDialog.svelte";
	import RollExportBar from "$lib/components/RollExportBar.svelte";
	import RollSidebar from "$lib/components/RollSidebar.svelte";
	import { PaneGroup, Pane, PaneResizer } from "paneforge";
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
		cancelPrefetchThumbs,
		resetThumbQueueProgress,
		thumbQueueProgress,
		onThumbProgress,
	} from "$lib/image/thumb-queue";
	import {
		startDecodeWarm,
		stopDecodeWarm,
		decodeWarmProgress,
		onDecodeWarmProgress,
		isFrameWarm,
	} from "$lib/image/decode-warm";
	import { previewMaxPx } from "$lib/image/pipeline";
	import LibraryThumbStrip from "$lib/components/LibraryThumbStrip.svelte";
	import NewLibraryDialog from "$lib/components/NewLibraryDialog.svelte";
	import {
		ExportIcon,
		FolderMinusIcon,
		FilmStripIcon,
		ImagesIcon,
		PlusIcon,
		TrashIcon,
	} from "phosphor-svelte";
	import type { Component } from "svelte";
	import type { AppTab } from "$lib/components/AppHeader.svelte";

	const activeTab = $derived<AppTab>(
		page.url.searchParams.get("tab") === "libraries" ? "libraries" : "rolls",
	);

	/** Roll pinned in the URL, if any. */
	const rollParam = $derived(page.url.searchParams.get("roll"));

	function rollHref(id: string): string {
		return `/?roll=${encodeURIComponent(id)}`;
	}

	// ─── Sidebar: all rolls ───────────────────────────────────────────────────

	let rolls = $state<Roll[]>([]);
	let rollsLoading = $state(true);
	let showNewRoll = $state(false);
	let deleting = $state<string | null>(null);
	let purging = $state<string | null>(null);

	/** Selected roll: the one in `?roll=`, else the newest. */
	const rollId = $derived(rollParam ?? rolls[0]?.id ?? "");

	// ─── Libraries tab ────────────────────────────────────────────────────────

	let libraries = $state<Library[]>([]);
	let showNewLibrary = $state(false);

	function onLibraryCreated(library: Library): void {
		libraries = [library, ...libraries].sort((a, b) => b.createdAt - a.createdAt);
		showNewLibrary = false;
	}

	async function confirmDeleteLibrary(library: Library): Promise<void> {
		if (!confirm(`Delete library "${library.label}"? This cannot be undone.`))
			return;
		deleting = library.id;
		try {
			await deleteLibrary(library.id);
		} finally {
			deleting = null;
		}
		libraries = libraries.filter((lib) => lib.id !== library.id);
	}

	function formatDate(ms: number): string {
		return new Date(ms).toLocaleDateString(undefined, {
			year: "numeric",
			month: "short",
			day: "numeric",
		});
	}

	// ─── Selected roll ────────────────────────────────────────────────────────

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

	// ─── Background full-resolution decode ────────────────────────────────────

	/** Reactive snapshot of the shared decode-sweep counters. */
	let warmProgress = $state({ warm: 0, total: 0, running: false });
	/**
	 * Frame IDs with a full-resolution decode on disk.  A separate Set rather
	 * than reading `isFrameWarm` in the template: the module's set is not
	 * reactive, so the thumbs need a `$state` value to re-render from.
	 */
	let warmFrameIds = $state<Set<string>>(new Set());

	/**
	 * True once every frame has been counted into the thumb queue.  `thumbsReady`
	 * alone is not enough to start the decode sweep: before the queue has been
	 * populated its total is 0, which reads as "ready" and would put a
	 * multi-second demosaic in front of the thumbnails the user is waiting on.
	 */
	let thumbsEnqueued = $state(false);

	/**
	 * True while the sweep is walking frames.  `running` matters: after a
	 * roll switch the previous roll's stopped, half-done sweep would otherwise
	 * keep its progress bar up until the new sweep starts.
	 */
	const warming = $derived(
		warmProgress.running &&
			warmProgress.total > 0 &&
			warmProgress.warm < warmProgress.total,
	);

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
			rollId:    roll.id,
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

	// ─── Sidebar actions ──────────────────────────────────────────────────────

	function onRollCreated(created: Roll): void {
		rolls = [created, ...rolls].sort((a, b) => b.createdAt - a.createdAt);
		showNewRoll = false;
		void goto(rollHref(created.id));
	}

	async function confirmDeleteRoll(target: Roll): Promise<void> {
		if (!confirm(`Delete roll "${target.label}"? This cannot be undone.`))
			return;
		deleting = target.id;
		try {
			await deleteRoll(target.id);
		} finally {
			deleting = null;
		}
		const idx = rolls.findIndex((r) => r.id === target.id);
		rolls = rolls.filter((r) => r.id !== target.id);
		if (target.id !== rollId) return;
		// Deleted the roll on screen — move to its neighbour in the list, or
		// to the empty Rolls tab when it was the last one.
		const next = rolls[Math.min(idx, rolls.length - 1)];
		await goto(next ? rollHref(next.id) : "/", { replaceState: true });
	}

	/**
	 * Permanently deletes the roll's `.rolloc-meta` sidecar folder (cached
	 * edits + thumbnails) from disk, without removing the roll from the UI.
	 * A separate, more deliberate action from "Delete roll" above — the
	 * original image files are never touched by either action.
	 */
	async function confirmPurgeRollFolder(target: Roll): Promise<void> {
		if (
			!confirm(
				`Permanently delete cached edits and thumbnails for "${target.label}" from its folder (.rolloc-meta)? ` +
					`The original photos are never touched, but this cannot be undone.`,
			)
		)
			return;
		purging = target.id;
		try {
			await purgeRollFolderData(target.id);
		} finally {
			purging = null;
		}
	}

	// ─── Loading ──────────────────────────────────────────────────────────────

	/** Roll whose data is (being) loaded; null before the first load. */
	let loadedRollId: string | null = null;
	/** Bumped per load so a slow load for a roll the user already left is dropped. */
	let loadToken = 0;

	async function loadRoll(id: string): Promise<void> {
		const token = ++loadToken;

		// Switching away from another roll: its background work would otherwise
		// compete with — and skew the progress counters of — this one.  On the
		// first load the decode sweep is left alone: it may be this roll's,
		// still running from the frame editor.
		if (loadedRollId !== null && loadedRollId !== id) {
			cancelPrefetchThumbs();
			stopDecodeWarm();
		}
		loadedRollId = id;

		roll = null;
		frames = [];
		dirPath = null;
		selIdx = 0;
		loading = true;
		thumbsEnqueued = false;
		exitSelectionMode();
		resetThumbQueueProgress();
		warmFrameIds = new Set();

		if (!id) {
			loading = false;
			return;
		}

		const [r, f] = await Promise.all([getRoll(id), getFrames(id)]);
		if (token !== loadToken) return;
		if (!r) {
			loading = false;
			return;
		}
		// Camera scans usually encode order in the filename — sort with
		// natural/numeric-aware comparison so IMG_2 < IMG_10.
		const collator = new Intl.Collator(undefined, {
			numeric: true,
			sensitivity: "base",
		});
		const sorted = f.slice().sort((a, b) => collator.compare(a.filename, b.filename));

		const path = await getRollPath(id);
		if (token !== loadToken) return;
		roll = r;
		frames = sorted;
		dirPath = path ?? null;
		loading = false;

		// Kick off background generation for all frames immediately.
		// Uses the worker pool so it runs off the main thread; high-priority
		// requests from IntersectionObserver (FrameThumb) will jump the queue.
		// Pass each frame's film type for correct processing.
		if (path && sorted.length > 0) {
			// Awaited: it resolves once every frame is enqueued (not generated),
			// which is the point `thumbProgress.total` becomes meaningful.
			await prefetchThumbs(
				sorted.map((fr) => ({
					id: fr.id,
					relativePath: fr.filename,
					filmType: fr.frameEdit.inversionParams?.filmType ?? DEFAULT_INVERSION_PARAMS.filmType,
				})),
				path,
				null,
				true,
			);
			if (token !== loadToken) return;
		}
		thumbsEnqueued = true;
	}

	onMount(() => {
		// Keep our local reactive snapshots in sync with the shared queues.
		onThumbProgress(() => {
			thumbProgress = { ...thumbQueueProgress };
		});
		onDecodeWarmProgress(() => {
			warmProgress = { ...decodeWarmProgress };
			warmFrameIds = new Set(frames.filter((f) => isFrameWarm(f.id)).map((f) => f.id));
		});

		Promise.all([getRolls(), getLibraries()])
			.then(([r, l]) => {
				// Newest first by creation time.
				rolls = r.sort((a, b) => b.createdAt - a.createdAt);
				libraries = l.sort((a, b) => b.createdAt - a.createdAt);
			})
			.catch((err: unknown) => {
				console.error("[home] failed to load rolls/libraries:", err);
			})
			.finally(() => {
				rollsLoading = false;
			});
	});

	// Declared before the decode-sweep effect so a roll switch resets the
	// per-roll state before that effect sees it.  Waits for the roll list:
	// without `?roll=` the selection is only known once it has loaded.
	$effect(() => {
		if (rollsLoading) return;
		const id = rollId;
		untrack(() => void loadRoll(id));
	});

	onDestroy(() => {
		onThumbProgress(null);
		resetThumbQueueProgress();
		onDecodeWarmProgress(null);
		// The sweep itself keeps running — it is shared with the frame editor,
		// which is where the user is heading.  Only the subscription goes.
	});

	/**
	 * Start decoding the whole roll at full resolution as soon as the grid
	 * becomes clickable.
	 *
	 * Deliberately tied to `thumbsReady` rather than to page load: until then
	 * the thumbnail workers own the CPU, and a frame cannot be opened anyway.
	 * From that moment on, every ~4-second demosaic the sweep completes is one
	 * the user does not wait for when they open that frame.
	 */
	$effect(() => {
		if (!thumbsEnqueued || !thumbsReady) return;
		if (!dirPath || !roll || frames.length === 0) return;
		const path = dirPath;
		const id = roll.id;
		const invert = roll.rollEdit.invert;
		const targets = frames.map((f) => ({ id: f.id, filename: f.filename }));
		void previewMaxPx().then((maxPx) =>
			startDecodeWarm({ rollId: id, dirPath: path, frames: targets, invert, maxPx }),
		);
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
		if (activeTab !== "rolls") return;
		// Enter on a focused link/button (e.g. a sidebar roll) activates it;
		// opening the selected frame as well would race that navigation.
		if (e.key === "Enter" && (tag === "A" || tag === "BUTTON")) return;

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
	<title>
		{activeTab === "rolls" && roll ? `${roll.label} — Rolloc` : "Rolloc — Film Archive"}
	</title>
</svelte:head>

<svelte:window onkeydown={handleKeydown} />

<div class="h-screen bg-base text-content flex flex-col overflow-hidden">
	<!-- Tab links carry `?roll=` so Libraries → Rolls returns to the same roll. -->
	<AppHeader
		active={activeTab}
		rollsHref={rollParam ? rollHref(rollParam) : "/"}
		librariesHref={rollParam
			? `/?tab=libraries&roll=${encodeURIComponent(rollParam)}`
			: "/?tab=libraries"}
		actionLabel={activeTab === "rolls" ? "New Roll" : "New Library"}
		onAction={() =>
			activeTab === "rolls" ? (showNewRoll = true) : (showNewLibrary = true)}
	/>

	{#if rollsLoading}
		<div class="flex-1"></div>
	{:else if activeTab === "libraries"}
		<main class="flex-1 min-h-0 overflow-y-auto w-full px-l py-xl max-w-5xl mx-auto">
			{#if libraries.length === 0}
				{@render emptyState(
					ImagesIcon,
					"No libraries yet",
					"Select a folder of images to create your first library.",
					"New Library",
					() => (showNewLibrary = true),
				)}
			{:else}
				<ul class="flex flex-col gap-base">
					{#each libraries as library (library.id)}
						<li
							class="group relative flex flex-col rounded-lg bg-base-muted border border-base-subtle
							       hover:border-content-subtle transition overflow-hidden"
						>
							<!-- Thumbnail strip (first images) -->
							<a
								href="/library/{library.id}"
								class="block overflow-hidden"
								tabindex="-1"
								aria-hidden="true"
							>
								<LibraryThumbStrip libraryId={library.id} />
							</a>

							<!-- Metadata -->
							<a
								href="/library/{library.id}"
								class="flex flex-col gap-0.5 px-base py-sm pr-12"
							>
								<span class="flex items-baseline gap-sm min-w-0">
									<span class="font-semibold text-content truncate"
										>{library.label}</span
									>
									<span class="text-xs text-content-subtle shrink-0"
										>{formatDate(library.createdAt)}</span
									>
								</span>
								{#if library.notes}
									<span class="text-xs text-content-muted truncate"
										>{library.notes}</span
									>
								{/if}
							</a>

							<!-- Hover actions -->
							<div
								class="absolute bottom-sm right-sm flex items-center gap-xs
								       opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition"
							>
								<button
									type="button"
									onclick={() => confirmDeleteLibrary(library)}
									disabled={deleting === library.id}
									aria-label="Delete library"
									title="Delete library"
									class="p-1.5 rounded-md text-content-muted hover:text-danger hover:bg-base-subtle transition disabled:opacity-40"
								>
									<TrashIcon size={16} />
								</button>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</main>
	{:else if rolls.length === 0}
		<main class="flex-1 min-h-0 overflow-y-auto w-full px-l py-xl">
			{@render emptyState(
				FilmStripIcon,
				"No rolls yet",
				"Select a folder of film scans to create your first roll.",
				"New Roll",
				() => (showNewRoll = true),
			)}
		</main>
	{:else}
		<!-- Resizable sidebar; the split is remembered via PaneForge's autoSaveId
		     (a UI layout preference, like the theme — not user data). -->
		<PaneGroup direction="horizontal" autoSaveId="rolloc:roll-sidebar" class="flex-1 min-h-0">
			<Pane defaultSize={22} minSize={15} maxSize={40} order={1}>
				<RollSidebar {rolls} activeId={rollId} />
			</Pane>
			<!-- Same handle as the library image viewer's EXIF pane. -->
			<PaneResizer
				class="bg-base-subtle hover:bg-primary transition-colors
				cursor-col-resize shrink-0 w-1.5"
			/>
			<Pane order={2} class="flex flex-col min-w-0">
				<section class="flex-1 min-h-0 flex flex-col" aria-label={roll?.label ?? "Roll"}>
					<!-- Roll toolbar -->
					<div class="flex items-center gap-sm px-l h-12 border-b border-base-subtle shrink-0">
						{#if roll}
							<span class="font-semibold text-content truncate">{roll.label}</span>
							<span class="flex items-center gap-xs text-xs text-content-subtle whitespace-nowrap">
								{#if roll.filmStock}
									<span class="text-primary-muted/80">{roll.filmStock}</span>
									<span>·</span>
								{/if}
								{#if roll.camera}
									<span class="text-content-muted">{roll.camera}</span>
									<span>·</span>
								{/if}
								<span class="tabular-nums">
									{frames.length} frame{frames.length !== 1 ? "s" : ""}
								</span>
							</span>

							<div class="ml-auto flex items-center gap-xs">
								{#if !selecting && frames.length > 0}
									<button
										type="button"
										onclick={enterSelectionMode}
										class="flex items-center gap-xs px-sm py-xs text-xs rounded-md
										       text-content-muted hover:text-content hover:bg-base-muted transition"
									>
										<ExportIcon size={14} />
										Export
									</button>
								{/if}
								<button
									type="button"
									onclick={() => roll && confirmPurgeRollFolder(roll)}
									disabled={purging === roll.id}
									aria-label="Delete cached edits and thumbnails from folder"
									title="Permanently delete cached edits/thumbnails from this roll's folder"
									class="p-1.5 rounded-md text-content-muted hover:text-danger hover:bg-base-muted
									       transition-colors disabled:opacity-40"
								>
									<FolderMinusIcon size={14} />
								</button>
								<button
									type="button"
									onclick={() => roll && confirmDeleteRoll(roll)}
									disabled={deleting === roll.id}
									aria-label="Delete roll"
									title="Delete roll"
									class="p-1.5 rounded-md text-content-muted hover:text-danger hover:bg-base-muted
									       transition-colors disabled:opacity-40"
								>
									<TrashIcon size={14} />
								</button>
							</div>
						{/if}
					</div>

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
						<!-- Blank rather than a "Loading…" label: switching rolls is an IDB
						     read away, and a label flashing on every switch reads as jank. -->
						<div class="flex-1"></div>
					{:else if !roll}
						<div class="flex-1 flex items-center justify-center text-content-muted">
							Roll not found.
						</div>
					{:else if frames.length === 0}
						<div class="flex-1 flex items-center justify-center text-content-muted">
							No frames found in this roll.
						</div>
					{:else}
						<div class="relative flex-1 min-h-0">
							<!-- Loading overlay — blocks interaction until all thumbs are ready -->
							{#if !thumbsReady}
								<div
									class="absolute inset-0 z-10 flex flex-col items-center justify-center
									gap-sm bg-base/80 backdrop-blur-sm"
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
							<div inert={!thumbsReady || undefined} class="overflow-y-auto h-full">
								<div class="p-l grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-px">
									{#each frames as frame, i (frame.id)}
										<FrameThumb
											{frame}
											dirPath={dirPath!}
											fullRes={warmFrameIds.has(frame.id)}
											selected={!selecting && i === selIdx}
											{selecting}
											picked={pickedIds.has(frame.id)}
											onSelect={selecting
												? togglePicked
												: selectFrame}
											onDblClick={selecting ? undefined : openFrame}
										/>
									{/each}
								</div>
							</div>
						</div>

						<!-- Background decode progress — subtle, non-blocking.  The grid is
						     already usable; this only says how much of the roll will open
						     instantly. -->
						{#if warming}
							<div
								class="shrink-0 flex items-center gap-sm px-l py-1.5
								       border-t border-base-subtle text-xs text-content-subtle"
							>
								<span class="size-1.5 rounded-full bg-accent animate-pulse"></span>
								<span>Optimizing full-resolution previews</span>
								<div
									class="w-32 h-1 rounded-full bg-base-subtle overflow-hidden"
								>
									<div
										class="h-full bg-accent rounded-full transition-all duration-300"
										style="width: {Math.round(
											(warmProgress.warm / warmProgress.total) * 100,
										)}%"
									></div>
								</div>
								<span class="tabular-nums"
									>{warmProgress.warm} / {warmProgress.total}</span
								>
							</div>
						{/if}
					{/if}
				</section>
			</Pane>
		</PaneGroup>
	{/if}

	<!-- Keyboard shortcut hint bar -->
	<KeyboardHintBar
		hints={activeTab === "rolls" && roll && frames.length > 0
			? [
					{ keys: ["←", "→"], label: "navigate" },
					{ keys: ["e"], label: "edit" },
					{ keys: ["0–5"], label: "rate" },
					{ keys: ["p"], label: "pick" },
					{ keys: ["x"], label: "reject" },
				]
			: []}
	/>
</div>

{#snippet emptyState(
	Icon: Component,
	title: string,
	body: string,
	action: string,
	onAction: () => void,
)}
	<div class="flex flex-col items-center justify-center py-24 gap-sm text-center">
		<Icon size={48} weight="thin" class="text-content-subtle" />
		<h2 class="text-l font-semibold text-content mt-sm">{title}</h2>
		<p class="text-content-muted text-sm max-w-80">{body}</p>
		<button
			type="button"
			onclick={onAction}
			class="mt-sm flex items-center gap-xs px-sm py-xs rounded-md bg-primary
			       text-primary-content text-sm font-medium hover:bg-primary-muted
			       transition-[background-color,transform] duration-150 ease-out active:scale-[0.97]"
		>
			<PlusIcon size={14} weight="bold" />
			{action}
		</button>
	</div>
{/snippet}

{#if showNewRoll}
	<NewRollDialog
		onCreated={onRollCreated}
		onClose={() => (showNewRoll = false)}
	/>
{/if}

{#if showNewLibrary}
	<NewLibraryDialog
		onCreated={onLibraryCreated}
		onClose={() => (showNewLibrary = false)}
	/>
{/if}
