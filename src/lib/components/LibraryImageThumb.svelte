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
	import { join } from "@tauri-apps/api/path";

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
			const absolutePath = await join(dirPath, image.relativePath);
			const objUrl = await requestThumb(image.id, absolutePath, "high");
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
	class="relative flex flex-col overflow-hidden border transition-all w-full
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
</a>
