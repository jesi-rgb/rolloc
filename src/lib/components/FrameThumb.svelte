<script lang="ts">
	/**
	 * Lazy-loading frame thumbnail.
	 *
	 * Uses IntersectionObserver to defer image generation until the thumb
	 * scrolls near the viewport.  Thumb generation is routed through the
	 * shared thumb-queue so the worker pool and LRU cache are reused.
	 */
	import { StarIcon } from "phosphor-svelte";
	import { requestThumb } from "$lib/image/thumb-queue";
	import { join } from "@tauri-apps/api/path";
	import type { Frame, FilmType } from "$lib/types";
	import { DEFAULT_INVERSION_PARAMS } from "$lib/types";

	interface Props {
		frame: Frame;
		dirPath: string;
		selected?: boolean;
		onSelect?: (frame: Frame) => void;
		onDblClick?: (frame: Frame) => void;
	}

	let { frame, dirPath, selected = false, onSelect, onDblClick }: Props = $props();

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
			const objUrl = await requestThumb(frame.id, absolutePath, "high", getFilmType());
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

<button
	bind:this={el}
	onclick={() => onSelect?.(frame)}
	ondblclick={() => onDblClick?.(frame)}
	class="relative flex flex-col overflow-hidden transition-all w-full
	       focus:outline-none focus:ring-2 focus:ring-primary
	focus:ring-offset-1 focus:ring-offset-base
	       {selected ? 'ring ring-primary shadow-lg shadow-primary/20' : ''}"
	aria-pressed={selected}
>
	<!-- Film strip wrapper — subtle film rebate with sprocket holes -->
	<div class="bg-primary-subtle w-full flex flex-col py-xs">
		<!-- Top sprocket row -->
		<div class="flex justify-evenly items-center h-3 px-xs shrink-0">
			{#each { length: 8 } as _, i (i)}
				<span class="block size-2 aspect-square bg-base"></span>
			{/each}
		</div>

		<!-- Thumbnail area — 3:2 aspect ratio -->
		<div
			class="relative aspect-video w-full bg-primary-subtle mx-auto rounded-md"
		>
			{#if status === "ready" && url}
				<img
					src={url}
					alt="Frame {frame.index}"
					class="absolute inset-0 p-2 w-full h-full object-cover rounded-md"
				/>
			{:else if status === "loading"}
				<div
					class="absolute inset-0 bg-base-subtle animate-pulse"
				></div>
			{:else if status === "error"}
				<div
					class="absolute inset-0 flex items-center justify-center text-content-subtle text-xs"
				>
					error
				</div>
			{:else}
				<div class="absolute inset-0 bg-base-muted"></div>
			{/if}

			<!-- Flag badges -->
			{#if frame.flags.length > 0}
				<div class="absolute top-1.5 left-1.5 flex gap-1">
					{#each frame.flags as flag (flag)}
						<span
							class="inline-block size-sm rounded-full {flagColour[
								flag
							] ?? 'bg-content-subtle'}"
						></span>
						<span
							class="blur-xl inline-block size-xl rounded-full absolute
							-top-base -left-base {flagColour[flag] ?? 'bg-content-subtle'}"
						></span>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Bottom sprocket row -->
		<div class="flex justify-evenly items-center h-3 px-1 shrink-0">
			{#each { length: 8 } as _, i (i)}
				<span class="block size-2 aspect-square bg-base"></span>
			{/each}
		</div>
	</div>
</button>
