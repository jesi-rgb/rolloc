<script lang="ts">
	/**
	 * Compact strip of the first ~5 thumbnails for a library card.
	 * Mirrors the structure of RollThumbStrip, but sources images
	 * from the library's image records instead of roll frames.
	 */
	import { onDestroy, onMount } from "svelte";
	import { getImages } from "$lib/db/libraries";
	import { getLibraryPath } from "$lib/db/libraries";
	import { thumbURL } from "$lib/fs/opfs";
	import { getThumbURL } from "$lib/image/thumbgen";
	import { join } from "@tauri-apps/api/path";
	import type { LibraryImage } from "$lib/types";

	interface Props {
		libraryId: string;
	}

	let { libraryId }: Props = $props();

	const PREVIEW_COUNT = 15;

	interface ThumbEntry {
		image: LibraryImage;
		url: string | null;
	}

	let entries = $state<ThumbEntry[]>([]);
	const revokeUrls: string[] = [];

	onMount(async () => {
		const allImages = await getImages(libraryId);
		const images = allImages.slice(0, PREVIEW_COUNT);
		if (images.length === 0) return;

		// Show skeletons immediately
		entries = images.map((image) => ({ image, url: null }));

		let dirPath: string | null = null;

		for (let i = 0; i < images.length; i++) {
			const image = images[i];

			// Try OPFS cache first (no path needed)
			let url = await thumbURL(image.id);

			if (!url) {
				// Lazily acquire the directory path
				if (!dirPath) dirPath = await getLibraryPath(libraryId);
				if (dirPath) {
					try {
						const absolutePath = await join(
							dirPath,
							image.relativePath,
						);
						url = await getThumbURL(image.id, { absolutePath });
					} catch {
						// leave null — thumbnail stays as skeleton
					}
				}
			}

			if (url) {
				revokeUrls.push(url);
				entries[i] = { image, url };
			}
		}
	});

	onDestroy(() => {
		for (const url of revokeUrls) URL.revokeObjectURL(url);
	});
</script>

<!--
	Compact image strip of the first ~5 thumbnails for a library card.
	Shows animated skeletons while loading, falls back to a plain gradient
	if the library has no images yet.
-->
<div
	class="grid gap-px w-full overflow-hidden"
	style="height: 80px; grid-template-columns: repeat({entries.length ||
		1}, 1fr);"
>
	{#if entries.length === 0}
		<!-- No images yet: show the accent gradient bar -->
		<div
			class="w-full h-full bg-gradient-to-r from-primary to-orange-600 opacity-70"
		></div>
	{:else}
		{#each entries as entry (entry.image.id)}
			<div class="overflow-hidden bg-base-subtle relative min-w-0">
				{#if entry.url}
					<img
						src={entry.url}
						alt={entry.image.filename}
						class="w-full h-full object-cover"
					/>
				{:else}
					<div
						class="w-full h-full animate-pulse bg-base-muted"
					></div>
				{/if}
			</div>
		{/each}
	{/if}
</div>
