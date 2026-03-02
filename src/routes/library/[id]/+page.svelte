<script lang="ts">
	/**
	 * Library grid page — displays all images in a library as thumbnails.
	 *
	 * Clicking an image navigates to /library/[id]/[imageId] for full view.
	 *
	 * Keyboard shortcuts:
	 *   ← / → (or j / k)   — prev / next image
	 *   e / Enter          — view selected image
	 */
	import { onMount, untrack } from "svelte";
	import { goto, beforeNavigate, afterNavigate } from "$app/navigation";
	import { page } from "$app/state";
	import { resolve } from "$app/paths";
	import { SvelteMap } from "svelte/reactivity";
	import { getLibrary, getImages, getLibraryPath, rescanLibrary } from "$lib/db/libraries";
	import type { Library, LibraryImage } from "$lib/types";
	import LibraryImageThumb from "$lib/components/LibraryImageThumb.svelte";
	import ThemeSwitcher from "$lib/components/ThemeSwitcher.svelte";
	import KeyboardHintBar from "$lib/components/KeyboardHintBar.svelte";
	import { thumbURL } from "$lib/fs/opfs";
	import { getFile } from "$lib/fs/directory";
	import { getThumbURL } from "$lib/image/thumbgen";

	type SortKey = 'createdAt-desc' | 'createdAt-asc';
	
	type GroupBy = 'none' | 'day' | 'month' | 'year';

	const libraryId = $derived(page.params.id ?? "");
	// Capture initial value for scroll key to avoid reactivity warning
	const SCROLL_KEY = untrack(() => `library-scroll-${libraryId}`);
	const SORT_KEY = 'library-sort-preference';
	const GROUP_KEY = 'library-group-preference';

	let library = $state<Library | null>(null);
	let images = $state<LibraryImage[]>([]);
	let dirPath = $state<string | null>(null);
	let loading = $state(true);
	
	// Thumbnail URL cache — kept in memory for instant loading
	const thumbUrls = new SvelteMap<string, string>();
	
	// Load preferences from localStorage, with fallbacks
	const savedSort = typeof localStorage !== 'undefined' ? localStorage.getItem(SORT_KEY) : null;
	const savedGroup = typeof localStorage !== 'undefined' ? localStorage.getItem(GROUP_KEY) : null;
	
	let sortBy = $state<SortKey>((savedSort as SortKey) ?? 'createdAt-desc');
	let groupBy = $state<GroupBy>((savedGroup as GroupBy) ?? 'none');
	let selIdx = $state(0);
	let scrollContainer = $state<HTMLElement | null>(null);

	// Save preferences to localStorage when they change
	$effect(() => {
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem(SORT_KEY, sortBy);
		}
	});

	$effect(() => {
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem(GROUP_KEY, groupBy);
		}
	});

	let sortedImages = $derived(
		sortBy === 'createdAt-desc' ? [...images].sort((a, b) => {
			const dateDiff = b.createdAt - a.createdAt;
			return dateDiff !== 0 ? dateDiff : a.filename.localeCompare(b.filename);
		}) :
		sortBy === 'createdAt-asc' ? [...images].sort((a, b) => {
			const dateDiff = a.createdAt - b.createdAt;
			return dateDiff !== 0 ? dateDiff : a.filename.localeCompare(b.filename);
		}) :
		[...images]
	);

	interface ImageGroup {
		label: string;
		images: LibraryImage[];
	}

	let groupedImages = $derived.by(() => {
		if (groupBy === 'none') {
			return [{ label: '', images: sortedImages }];
		}

		const groups = new SvelteMap<string, LibraryImage[]>();

		for (const image of sortedImages) {
			const date = new Date(image.createdAt);
			let key: string;
			let label: string;

			if (groupBy === 'day') {
				key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
				label = date.toLocaleDateString(undefined, {
					year: 'numeric',
					month: 'long',
					day: 'numeric',
					weekday: 'long',
				});
			} else if (groupBy === 'month') {
				key = `${date.getFullYear()}-${date.getMonth()}`;
				label = date.toLocaleDateString(undefined, {
					year: 'numeric',
					month: 'long',
				});
			} else { // year
				key = `${date.getFullYear()}`;
				label = date.getFullYear().toString();
			}

			if (!groups.has(key)) {
				groups.set(key, []);
			}
			groups.get(key)!.push(image);
		}

		return Array.from(groups.entries()).map(([key, images]) => ({
			label: images.length > 0 
				? (groupBy === 'day' 
					? new Date(images[0].createdAt).toLocaleDateString(undefined, {
							year: 'numeric',
							month: 'long',
							day: 'numeric',
							weekday: 'long',
						})
					: groupBy === 'month'
					? new Date(images[0].createdAt).toLocaleDateString(undefined, {
							year: 'numeric',
							month: 'long',
						})
					: new Date(images[0].createdAt).getFullYear().toString())
				: key,
			images,
		}));
	});

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

		// Automatically rescan for new images
		try {
			const newCount = await rescanLibrary(libraryId);
			if (newCount > 0) {
				// Reload images if new ones were found
				images = await getImages(libraryId);
			}
		} catch (err) {
			console.error('Auto-rescan failed:', err);
		}

		loading = false;

		// Load all thumbnail URLs upfront and keep them in memory
		// This allows instant rendering when navigating back to the grid
		if (path) {
			void loadAllThumbnails(path, images);
		}

		// Restore scroll position after content has loaded
		const saved = sessionStorage.getItem(SCROLL_KEY);
		if (saved) {
			const scrollPos = parseInt(saved, 10);
			console.log('[Library onMount] Attempting to restore scroll to:', scrollPos);
			
			// Wait for next tick to ensure DOM is ready
			setTimeout(() => {
				const main = document.querySelector('main[data-scroll-container]') as HTMLElement | null;
				if (main) {
					main.scrollTop = scrollPos;
					console.log('[Library onMount] Scroll set to:', main.scrollTop);
					// Clear the saved position
					sessionStorage.removeItem(SCROLL_KEY);
				}
			}, 100);
		}
	});

	// Save scroll position when navigating away to an image
	beforeNavigate((nav) => {
		const main = document.querySelector('main[data-scroll-container]') as HTMLElement | null;
		if (main && nav.to?.route.id?.includes('[imageId]')) {
			const pos = main.scrollTop;
			sessionStorage.setItem(SCROLL_KEY, pos.toString());
			console.log('[Library beforeNavigate] Saved scroll position:', pos);
		}
	});

	function formatDate(ms: number): string {
		return new Date(ms).toLocaleDateString(undefined, {
			year: "numeric",
			month: "short",
			day: "numeric",
		});
	}

	/**
	 * Loads all thumbnail URLs and keeps them in memory.
	 * Tries cached OPFS first, falls back to generating from source file.
	 */
	async function loadAllThumbnails(dirPath: string, images: LibraryImage[]) {
		// Process in batches to avoid overwhelming the system
		const BATCH_SIZE = 20;
		
		for (let i = 0; i < images.length; i += BATCH_SIZE) {
			const batch = images.slice(i, i + BATCH_SIZE);
			
			await Promise.all(
				batch.map(async (image) => {
					try {
						// First try to load from OPFS cache
						let url = await thumbURL(image.id);
						
						// If not cached, generate it
						if (!url) {
							const file = await getFile(dirPath, image.relativePath);
							url = await getThumbURL(image.id, file);
						}
						
						if (url) {
							thumbUrls.set(image.id, url);
						}
					} catch (err) {
						console.error(`Failed to load thumbnail for ${image.filename}:`, err);
					}
				})
			);
		}
		
		console.log(`[Library] Loaded ${thumbUrls.size}/${images.length} thumbnails`);
	}

	// ─── Keyboard shortcuts ───────────────────────────────────────────────────

	async function handleKeydown(e: KeyboardEvent) {
		// Don't intercept when typing in an input or textarea
		const tag = (e.target as HTMLElement | null)?.tagName;
		if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

		if (sortedImages.length === 0) return;

		switch (e.key) {
			case "ArrowLeft":
			case "k":
				e.preventDefault();
				selIdx = Math.max(0, selIdx - 1);
				break;
			case "ArrowRight":
			case "j":
				e.preventDefault();
				selIdx = Math.min(sortedImages.length - 1, selIdx + 1);
				break;
			case "e":
			case "Enter":
				e.preventDefault();
				const selected = sortedImages[selIdx];
				if (selected) {
					await goto(resolve(`/library/${libraryId}/${selected.id}`));
				}
				break;
		}
	}
</script>

<svelte:head>
	<title>{library?.label ?? "Library"} — Roloc</title>
</svelte:head>

<svelte:window onkeydown={handleKeydown} />

<div class="h-screen bg-base text-content flex flex-col">
	<!-- Top bar -->
	<header
		class="flex items-center gap-base px-l py-sm border-b border-base-subtle shrink-0"
	>
		<a
			href={resolve("/")}
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
					</select>
				</div>
				<div class="flex items-center gap-xs">
					<label
						for="group-select"
						class="text-xs text-content-subtle"
					>
						Group by:
					</label>
					<select
						id="group-select"
						bind:value={groupBy}
						class="text-xs px-2 py-1 rounded border border-base-subtle bg-base
						       text-content hover:border-content-subtle focus:border-primary
						       focus:outline-none transition"
					>
						<option value="none">None</option>
						<option value="day">Day</option>
						<option value="month">Month</option>
						<option value="year">Year</option>
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
	{:else if !dirPath}
		<div class="flex-1 flex items-center justify-center text-content-muted">
			Loading directory path…
		</div>
	{:else}
		<!-- Grid view -->
		<main bind:this={scrollContainer} data-scroll-container class="flex-1 overflow-y-auto p-l">
			{#each groupedImages as group (group.label)}
				{#if groupBy !== 'none'}
					<h2 class="text-lg font-semibold text-content mb-base mt-l first:mt-0">
						{group.label}
						<span class="text-sm text-content-subtle font-normal ml-xs">
							({group.images.length} image{group.images.length !== 1 ? 's' : ''})
						</span>
					</h2>
				{/if}
				<ul
					class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-sm mb-xl"
				>
					{#each group.images as image, i (image.id)}
						{@const globalIndex = sortedImages.findIndex(img => img.id === image.id)}
						<li>
							<LibraryImageThumb
								{image}
								{libraryId}
								thumbUrl={thumbUrls.get(image.id)}
								selected={globalIndex === selIdx}
							/>
						</li>
					{/each}
				</ul>
			{/each}
		</main>

		<!-- Keyboard shortcut hint bar -->
		<KeyboardHintBar
			hints={[
				{ keys: ["←", "→"], label: "navigate" },
				{ keys: ["e"], label: "view" },
			]}
		/>
	{/if}
</div>
