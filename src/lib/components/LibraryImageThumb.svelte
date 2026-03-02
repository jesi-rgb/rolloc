<script lang="ts">
	/**
	 * Library image thumbnail.
	 *
	 * Displays a pre-loaded thumbnail URL from the parent component.
	 */
	import { StarIcon } from "phosphor-svelte";
	import type { LibraryImage } from "$lib/types";

	interface Props {
		image: LibraryImage;
		libraryId: string;
		thumbUrl?: string;
		selected?: boolean;
	}

	let { image, libraryId, thumbUrl, selected = false }: Props = $props();
</script>

<a
	href="/library/{libraryId}/{image.id}"
	class="relative flex flex-col rounded-lg overflow-hidden border transition-all w-full
	       focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-1 focus:ring-offset-base
	       {selected
		? 'border-primary ring-2 ring-primary ring-offset-1 ring-offset-base'
		: 'border-base-subtle hover:border-content-subtle'}"
>
	<!-- Thumbnail area — 3:2 aspect ratio -->
	<div class="relative w-full bg-base-muted" style="aspect-ratio: 3/2;">
		{#if thumbUrl}
			<img
				src={thumbUrl}
				alt="Image {image.filename}"
				class="absolute inset-0 w-full h-full object-cover"
			/>
		{:else}
			<div class="absolute inset-0 bg-base-subtle animate-pulse"></div>
		{/if}
	</div>

	<!-- Footer -->
	<div class="px-2 py-1.5 bg-base/80 flex justify-between gap-xs min-w-0">
		<span class="text-xs text-content-subtle truncate"
			>{image.filename}</span
		>
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
