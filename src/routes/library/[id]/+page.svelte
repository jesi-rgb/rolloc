<script lang="ts">
	/**
	 * Library grid page — displays all images in a library as thumbnails.
	 *
	 * Clicking an image navigates to /library/[id]/[imageId] for full view.
	 */
	import { onMount } from "svelte";
	import { page } from "$app/state";
	import { getLibrary, getImages, getLibraryPath } from "$lib/db/libraries";
	import type { Library, LibraryImage } from "$lib/types";
	import LibraryImageThumb from "$lib/components/LibraryImageThumb.svelte";
	import ThemeSwitcher from "$lib/components/ThemeSwitcher.svelte";

	type SortKey = 'createdAt-desc' | 'createdAt-asc' | 'filename-asc' | 'filename-desc' 
	             | 'rating-desc' | 'rating-asc' | 'index-asc' | 'index-desc';

	const libraryId = $derived(page.params.id ?? "");

	let library = $state<Library | null>(null);
	let images = $state<LibraryImage[]>([]);
	let dirPath = $state<string | null>(null);
	let loading = $state(true);
	let sortBy = $state<SortKey>('createdAt-desc');

	let sortedImages = $derived(
		sortBy === 'createdAt-desc' ? [...images].sort((a, b) => b.createdAt - a.createdAt) :
		sortBy === 'createdAt-asc' ? [...images].sort((a, b) => a.createdAt - b.createdAt) :
		sortBy === 'filename-asc' ? [...images].sort((a, b) => a.filename.localeCompare(b.filename)) :
		sortBy === 'filename-desc' ? [...images].sort((a, b) => b.filename.localeCompare(a.filename)) :
		sortBy === 'rating-desc' ? [...images].sort((a, b) => b.rating - a.rating) :
		sortBy === 'rating-asc' ? [...images].sort((a, b) => a.rating - b.rating) :
		sortBy === 'index-asc' ? [...images].sort((a, b) => a.index - b.index) :
		sortBy === 'index-desc' ? [...images].sort((a, b) => b.index - a.index) :
		[...images]
	);

	onMount(async () => {
		if (!libraryId) {
			loading = false;
			return;
		}

		const [lib, imgs] = await Promise.all([
			getLibrary(libraryId),
			getImages(libraryId),
		]);

		library = lib ?? null;
		images = imgs;

		if (!library) {
			loading = false;
			return;
		}

		// Get the directory path for this library
		const path = await getLibraryPath(libraryId);
		if (path) {
			dirPath = path;
		}
		loading = false;
	});

	function formatDate(ms: number): string {
		return new Date(ms).toLocaleDateString(undefined, {
			year: "numeric",
			month: "short",
			day: "numeric",
		});
	}
</script>

<svelte:head>
	<title>{library?.label ?? "Library"} — Roloc</title>
</svelte:head>

<div class="min-h-screen bg-base text-content flex flex-col">
	<!-- Top bar -->
	<header
		class="flex items-center gap-base px-l py-sm border-b border-base-subtle shrink-0"
	>
		<a
			href="/"
			class="text-content-muted hover:text-content transition text-sm"
			>← Library</a
		>
		{#if library}
			<span class="font-semibold text-content">{library.label}</span>
			{#if library.notes}
				<span class="text-content-muted text-sm">{library.notes}</span>
			{/if}
			<span class="text-xs text-content-subtle">
				{images.length} image{images.length !== 1 ? "s" : ""}
			</span>
		{/if}
		<div class="ml-auto flex items-center gap-base">
			{#if !loading && library && images.length > 0}
				<div class="flex items-center gap-xs">
					<label
						for="sort-select"
						class="text-xs text-content-subtle"
					>
						Sort by:
					</label>
					<select
						id="sort-select"
						bind:value={sortBy}
						class="text-xs px-2 py-1 rounded border border-base-subtle bg-base
						       text-content hover:border-content-subtle focus:border-primary
						       focus:outline-none transition"
					>
						<option value="createdAt-desc">Newest First</option>
						<option value="createdAt-asc">Oldest First</option>
						<option value="filename-asc">Filename (A-Z)</option>
						<option value="filename-desc">Filename (Z-A)</option>
						<option value="rating-desc">Rating (High-Low)</option>
						<option value="rating-asc">Rating (Low-High)</option>
						<option value="index-asc">Index (Ascending)</option>
						<option value="index-desc">Index (Descending)</option>
					</select>
				</div>
			{/if}
			<ThemeSwitcher />
		</div>
	</header>

	{#if loading}
		<div class="flex-1 flex items-center justify-center text-content-muted">
			Loading…
		</div>
	{:else if !library}
		<div class="flex-1 flex items-center justify-center text-content-muted">
			Library not found.
		</div>
	{:else if images.length === 0}
		<div class="flex-1 flex items-center justify-center text-content-muted">
			No images found in this library.
		</div>
	{:else}
		<!-- Grid view -->
		<main class="flex-1 overflow-y-auto p-l">
			<ul
				class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-sm"
			>
				{#each sortedImages as image (image.id)}
					<li>
						<LibraryImageThumb
							{image}
							{libraryId}
							dirPath={dirPath!}
						/>
					</li>
				{/each}
			</ul>
		</main>
	{/if}
</div>
