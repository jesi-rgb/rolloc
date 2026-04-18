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
	import { DEFAULT_INVERSION_PARAMS } from "$lib/types";
	import { PaneGroup, Pane, PaneResizer } from "paneforge";
	import FrameThumb from "$lib/components/FrameThumb.svelte";
	import FrameMetaPanel from "$lib/components/FrameMetaPanel.svelte";
	import KeyboardHintBar from "$lib/components/KeyboardHintBar.svelte";
	import VirtualGrid from "$lib/components/VirtualGrid.svelte";
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
		frames = f;

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
		{/if}
	</header>

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
							selected={i === selIdx}
							onSelect={selectFrame}
							onDblClick={openFrame}
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
