<script lang="ts">
	/**
	 * Lazy-loading frame thumbnail.
	 *
	 * Uses IntersectionObserver to defer image generation until the thumb
	 * scrolls near the viewport.  Thumb generation is routed through the
	 * shared thumb-queue so the worker pool and LRU cache are reused.
	 */
	import { CheckIcon, WarningIcon } from "phosphor-svelte";
	import { requestThumb } from "$lib/image/thumb-queue";
	import { join } from "@tauri-apps/api/path";
	import type { Frame, FilmType } from "$lib/types";
	import { DEFAULT_INVERSION_PARAMS } from "$lib/types";

	interface Props {
		frame: Frame;
		dirPath: string;
		/** Focus selection (keyboard/mouse focused frame). */
		selected?: boolean;
		/** When true, the thumb renders a checkbox overlay and clicks toggle
		 *  selection rather than focus. Used by the roll-level export flow. */
		selecting?: boolean;
		/** True when this frame is in the export selection set. Independent
		 *  of `selected` (which is the focus highlight). */
		picked?: boolean;
		/** True when a full-resolution decode of this frame is cached on disk,
		 *  i.e. the editor will open it instantly. */
		fullRes?: boolean;
		onSelect?: (frame: Frame) => void;
		onDblClick?: (frame: Frame) => void;
	}

	let {
		frame,
		dirPath,
		selected = false,
		selecting = false,
		picked = false,
		fullRes = false,
		onSelect,
		onDblClick,
	}: Props = $props();

	/**
	 * Get the film type for this frame.
	 * Uses the frame's inversionParams if set, otherwise defaults to C41.
	 */
	function getFilmType(): FilmType {
		return frame.frameEdit.inversionParams?.filmType
			?? DEFAULT_INVERSION_PARAMS.filmType;
	}

	type ThumbStatus = "idle" | "loading" | "ready" | "error";
	let status = $state<ThumbStatus>("idle");
	let url = $state<string | null>(null);
	let el = $state<HTMLButtonElement | null>(null);

	let observer: IntersectionObserver | null = null;

	// Attach IntersectionObserver once the element is mounted
	$effect(() => {
		const target = el;
		if (!target) return;

		const obs = new IntersectionObserver(
			(entries) => {
				if (entries[0]?.isIntersecting && status === "idle") {
					void loadThumb();
					obs.disconnect();
				}
			},
			{ rootMargin: "200px" },
		);
		obs.observe(target);
		observer = obs;

		return () => obs.disconnect();
	});

	$effect(() => {
		return () => observer?.disconnect();
	});

	async function loadThumb() {
		status = "loading";
		try {
			const absolutePath = await join(dirPath, frame.filename);
			// requestThumb routes through the worker pool + LRU cache.
			// The cache owns the object URL — do NOT revoke it here.
			// Pass the frame's film type for correct processing.
			const objUrl = await requestThumb(frame.id, absolutePath, "high", getFilmType(), dirPath);
			url = objUrl;
			status = "ready";
		} catch {
			status = "error";
		}
	}

	const flagColour: Record<string, string> = {
		pick: "bg-success",
		reject: "bg-danger",
		edited: "bg-accent",
	};
</script>

<!-- The div owns the 3:2 size: WebKit does not stretch a button grid item reliably. -->
<div class="relative w-full aspect-[3/2]">
	<button
		bind:this={el}
		onclick={() => onSelect?.(frame)}
		ondblclick={() => onDblClick?.(frame)}
		class="absolute inset-0 size-full overflow-hidden bg-base-muted focus:outline-none"
		aria-pressed={selecting ? picked : selected}
	>
		{#if status === "ready" && url}
			<img
				src={url}
				alt="Frame {frame.index}"
				class="absolute inset-0 w-full h-full object-cover"
			/>
		{:else if status === "loading"}
			<div class="absolute inset-0 bg-base-subtle animate-pulse"></div>
		{:else if status === "error"}
			<div
				class="absolute inset-0 flex items-center justify-center text-content-subtle"
				title="Could not load thumbnail"
			>
				<WarningIcon size={16} />
			</div>
		{/if}

		<!-- Flag badges -->
		{#if frame.flags.length > 0}
			<div class="absolute top-1.5 left-1.5 flex gap-1">
				{#each frame.flags as flag (flag)}
					<span
						class="size-2 rounded-full ring-2 ring-black/40 {flagColour[flag] ??
							'bg-content-subtle'}"
					></span>
				{/each}
			</div>
		{/if}

		<!-- Full-resolution-ready marker (the checkbox owns this corner in selection mode) -->
		{#if fullRes && !selecting}
			<div
				class="absolute bottom-1.5 right-1.5 size-1.5 rounded-full bg-accent ring-2 ring-black/40"
				title="Full resolution ready"
			></div>
		{/if}

		<!-- Selection checkbox overlay (selection mode only) -->
		{#if selecting}
			<div
				class="absolute top-1.5 right-1.5 size-5 rounded border-2
				       flex items-center justify-center transition
				       {picked
					? 'bg-accent border-accent text-base'
					: 'bg-black/40 border-white/70 text-transparent'}"
				aria-hidden="true"
			>
				<CheckIcon size={12} weight="bold" />
			</div>
		{/if}

		<!-- Border / focus / selection ring, drawn on top of the image.  The
		     resting border is a faint `content` tint so it reads in both themes. -->
		<div
			class="absolute inset-0 pointer-events-none transition
			       {selecting && picked
				? 'ring-2 ring-inset ring-accent'
				: selected
					? 'ring-2 ring-inset ring-primary'
					: 'ring-1 ring-inset ring-content/10'}"
		></div>
	</button>
</div>
