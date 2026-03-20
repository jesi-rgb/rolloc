<script lang="ts">
	/**
	 * Library image thumbnail.
	 *
	 * Uses IntersectionObserver to defer thumbnail loading until the thumb
	 * enters the viewport, then requests it via the thumb queue (which checks
	 * the module-level LRU cache and OPFS before generating).
	 */
	import { onDestroy } from "svelte";
	import { StarIcon } from "phosphor-svelte";
	import type { LibraryImage } from "$lib/types";
	import { requestThumb } from "$lib/image/thumb-queue";
	import { getFile } from "$lib/fs/directory";

	interface Props {
		image: LibraryImage;
		libraryId: string;
		dirPath: string;
		selected?: boolean;
	}

	let { image, libraryId, dirPath, selected = false }: Props = $props();

	type ThumbStatus = "idle" | "loading" | "ready" | "error";
	let status = $state<ThumbStatus>("idle");
	let url = $state<string | null>(null);
	let el = $state<HTMLAnchorElement | null>(null);

	let observer: IntersectionObserver | null = null;

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
	});

	async function loadThumb() {
		status = "loading";
		try {
			const file = await getFile(dirPath, image.relativePath);
			const objUrl = await requestThumb(image.id, file, "high");
			url = objUrl;
			status = "ready";
		} catch {
			status = "error";
		}
	}
</script>

<a
	bind:this={el}
	href="/library/{libraryId}/{image.id}"
	class="relative flex flex-col rounded-lg overflow-hidden border transition-all w-full
	       focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-1 focus:ring-offset-base
	       {selected
		? 'border-primary ring-2 ring-primary ring-offset-1 ring-offset-base'
		: 'border-base-subtle hover:border-content-subtle'}"
>
	<!-- Thumbnail area — 3:2 aspect ratio -->
	<div class="relative w-full bg-base-muted" style="aspect-ratio: 3/2;">
		{#if status === "ready" && url}
			<img
				src={url}
				alt="Image {image.filename}"
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
	</div>

	<!-- Footer -->
	<div class="px-2 py-1.5 bg-base/80 flex justify-between gap-xs min-w-0">
		<span class="text-xs text-content-subtle truncate">{image.filename}</span>
		{#if image.rating > 0}
			<span
				class="flex items-center text-primary-muted whitespace-nowrap"
				aria-label="{image.rating} stars"
			>
				{#each [1, 2, 3, 4, 5] as star (star)}
					<StarIcon
						size={12}
						weight={star <= image.rating ? "fill" : "regular"}
					/>
				{/each}
			</span>
		{/if}
	</div>
</a>
