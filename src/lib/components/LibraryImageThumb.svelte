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
	import { resolve } from "$app/paths";
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

	type ThumbStatus = "loading" | "ready" | "error";
	let status = $state<ThumbStatus>("loading");
	let url = $state<string | null>(null);
	let el = $state<HTMLAnchorElement | null>(null);

	let observer: IntersectionObserver | null = null;

	$effect(() => {
		const target = el;
		if (!target) return;

		const obs = new IntersectionObserver(
			(entries) => {
				if (entries[0]?.isIntersecting) {
					void loadThumb();
					obs.disconnect();
				}
			},
			{ rootMargin: "1400px" },
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
	href={resolve(`/library/${libraryId}/${image.id}`)}
	class="relative flex flex-col overflow-hidden border transition-all w-full
	       focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-1 focus:ring-offset-base
	       {selected
		? 'border-primary ring-2 ring-primary ring-offset-1 ring-offset-base'
		: 'border-base-subtle hover:border-content-subtle'}"
>
	<!-- Thumbnail area — 3:2 aspect ratio -->
	<div class="relative w-full bg-base-muted" style="aspect-ratio: 3/2;">
		<!-- Skeleton shown until image is ready -->
		{#if status !== "ready"}
			<div class="absolute inset-0 bg-base-subtle animate-pulse"></div>
		{/if}
		{#if status === "ready" && url}
			<img
				src={url}
				alt="Image {image.filename}"
				class="absolute inset-0 w-full h-full object-cover animate-fadein"
			/>
		{:else if status === "error"}
			<div
				class="absolute inset-0 flex items-center justify-center text-content-subtle text-xs"
			>
				error
			</div>
		{/if}
	</div>
</a>
