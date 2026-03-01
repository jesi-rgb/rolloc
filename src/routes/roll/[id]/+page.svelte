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
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";
	import { page } from "$app/state";
	import { getRoll, getRollPath } from "$lib/db/rolls";
	import { getFrames, putFrame } from "$lib/db/idb";
	import type { Roll, Frame, FrameFlag } from "$lib/types";
	import { PaneGroup, Pane, PaneResizer } from "paneforge";
	import FrameThumb from "$lib/components/FrameThumb.svelte";
	import FrameMetaPanel from "$lib/components/FrameMetaPanel.svelte";
	import ThemeSwitcher from "$lib/components/ThemeSwitcher.svelte";
	import KeyboardHintBar from "$lib/components/KeyboardHintBar.svelte";

	// $page.params.id is typed string | undefined in SvelteKit; guard below
	const rollId = $derived(page.params.id ?? "");

	let roll = $state<Roll | null>(null);
	let frames = $state<Frame[]>([]);
	let dirPath = $state<string | null>(null);
	let selIdx = $state(0);
	let loading = $state(true);

	const selected = $derived(frames[selIdx] ?? null);

	onMount(async () => {
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

		// Get the directory path for this roll
		const path = await getRollPath(rollId);
		if (path) {
			dirPath = path;
		}
		loading = false;
	});

	function selectFrame(f: Frame) {
		const idx = frames.findIndex((fr) => fr.id === f.id);
		if (idx >= 0) selIdx = idx;
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
	<title>{roll?.label ?? "Roll"} — Roloc</title>
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
		<div class="ml-auto"><ThemeSwitcher /></div>
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
		<PaneGroup direction="horizontal" class="flex-1 min-h-0">
			<!-- Filmstrip grid pane -->
			<Pane defaultSize={45} minSize={20} order={1}>
				<div class="h-full overflow-y-auto p-l">
					<ul
						class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-sm"
					>
						{#each frames as frame, i (frame.id)}
							<li>
								<FrameThumb
									{frame}
									dirPath={dirPath!}
									selected={i === selIdx}
									onSelect={selectFrame}
								/>
							</li>
						{/each}
					</ul>
				</div>
			</Pane>

			<!-- Metadata panel pane -->
			{#if selected}
				<PaneResizer
					class="w-1.5 bg-base-subtle hover:bg-primary transition-colors cursor-col-resize shrink-0"
				/>
				<Pane defaultSize={55} minSize={20} order={2}>
					<FrameMetaPanel
						frame={selected}
						dirPath={dirPath}
						onUpdate={onFrameUpdated}
					/>
				</Pane>
			{/if}
		</PaneGroup>

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
