<script lang="ts">
	/**
	 * Lazy-loading frame thumbnail.
	 *
	 * Uses IntersectionObserver to defer image generation until the thumb
	 * scrolls near the viewport.
	 */
	import { onDestroy } from "svelte";
	import { StarIcon } from "phosphor-svelte";
	import { getThumbURL } from "$lib/image/thumbgen";
	import { getFile } from "$lib/fs/directory";
	import type { Frame } from "$lib/types";

	interface Props {
		frame: Frame;
		dirPath: string;
		selected?: boolean;
		onSelect?: (frame: Frame) => void;
	}

	let { frame, dirPath, selected = false, onSelect }: Props = $props();

	// Avoid shadowing the $state rune — use a distinct name
	type ThumbStatus = "idle" | "loading" | "ready" | "error";
	let status = $state<ThumbStatus>("idle");
	let url = $state<string | null>(null);
	let el = $state<HTMLButtonElement | null>(null);

	let currentUrl: string | null = null;
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

	onDestroy(() => {
		observer?.disconnect();
		if (currentUrl) URL.revokeObjectURL(currentUrl);
	});

	async function loadThumb() {
		status = "loading";
		try {
			const file = await getFile(dirPath, frame.filename);
			const objUrl = await getThumbURL(frame.id, file);
			if (currentUrl) URL.revokeObjectURL(currentUrl);
			currentUrl = objUrl;
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
	class="relative flex flex-col rounded-lg overflow-hidden border transition-all w-full
	       focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-1 focus:ring-offset-base
	       {selected
		? 'border-primary shadow-lg shadow-primary/20'
		: 'border-base-subtle hover:border-content-subtle'}"
	aria-label="Frame {frame.index}: {frame.filename}"
	aria-pressed={selected}
>
	<!-- Thumbnail area — 3:2 aspect ratio -->
	<div class="relative w-full bg-base-muted" style="aspect-ratio: 3/2;">
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

		<!-- Frame index -->
		<span
			class="absolute bottom-1.5 right-1.5 text-[10px] font-mono text-white/60 bg-black/50 rounded px-1 leading-tight"
		>
			{frame.index}
		</span>
	</div>

	<!-- Footer -->
	<div class="px-2 py-1.5 bg-base/80 flex justify-between gap-xs min-w-0">
		<span class="text-xs text-content-subtle truncate"
			>{frame.filename}</span
		>
		{#if frame.rating > 0}
			<span
				class="flex items-center text-primary-muted whitespace-nowrap"
				aria-label="{frame.rating} stars"
			>
				{#each [1, 2, 3, 4, 5] as star (star)}
					<StarIcon
						size={12}
						weight={star <= frame.rating ? "fill" : "regular"}
					/>
				{/each}
			</span>
		{/if}
	</div>
</button>
