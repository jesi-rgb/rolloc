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
	import { onMount, onDestroy, untrack } from "svelte";
	import { goto, beforeNavigate } from "$app/navigation";
	import { page } from "$app/state";
	import { resolve } from "$app/paths";
	import {
		getLibrary,
		getImages,
		getLibraryPath,
		rescanLibrary,
		onScanBatch,
	} from "$lib/db/libraries";
	import type { Library, LibraryImage } from "$lib/types";
	import { SvelteMap } from "svelte/reactivity";
	import LibraryImageThumb from "$lib/components/LibraryImageThumb.svelte";
	import KeyboardHintBar from "$lib/components/KeyboardHintBar.svelte";
	import VirtualGrid from "$lib/components/VirtualGrid.svelte";
	import {
		resetThumbQueueProgress,
		thumbQueueProgress,
		onThumbProgress,
		initThumbQueueForLibrary,
		prefetchThumbs,
	} from "$lib/image/thumb-queue";

	type SortKey = "createdAt-desc" | "createdAt-asc";
	type GroupBy = "none" | "day" | "month" | "year";

	const libraryId = $derived(page.params.id ?? "");
	const SCROLL_KEY = untrack(() => `library-scroll-${libraryId}`);
	const SORT_KEY = "library-sort-preference";
	const GROUP_KEY = "library-group-preference";

	let library = $state<Library | null>(null);
	let images = $state<LibraryImage[]>([]);
	let dirPath = $state<string | null>(null);
	let loading = $state(true);

	const savedSort =
		typeof localStorage !== "undefined"
			? localStorage.getItem(SORT_KEY)
			: null;
	const savedGroup =
		typeof localStorage !== "undefined"
			? localStorage.getItem(GROUP_KEY)
			: null;

	let sortBy = $state<SortKey>((savedSort as SortKey) ?? "createdAt-desc");
	let groupBy = $state<GroupBy>((savedGroup as GroupBy) ?? "none");
	let selIdx = $state(0);
	let scrollContainer = $state<HTMLElement | null>(null);
	let virtualScrollEl = $state<HTMLDivElement | null>(null);

	// Reactive snapshot of thumb queue progress for KeyboardHintBar.
	let thumbProgress = $state({ cached: 0, generating: 0, total: 0 });

	/**
	 * True once every image in the library has a cached thumbnail.
	 * While false, the grid is inert (pointer events blocked) and a progress
	 * overlay is shown so the user knows generation is running.
	 */
	const thumbsReady = $derived(
		thumbProgress.total === 0 ||
			thumbProgress.cached >= thumbProgress.total,
	);

	/** Derived progress label — shown only while generation is in progress. */
	let thumbProgressLabel = $derived(
		thumbProgress.total > 0 && thumbProgress.cached < thumbProgress.total
			? `thumbnails: ${thumbProgress.cached}/${thumbProgress.total}`
			: undefined,
	);

	$effect(() => {
		if (typeof localStorage !== "undefined") {
			localStorage.setItem(SORT_KEY, sortBy);
		}
	});

	$effect(() => {
		if (typeof localStorage !== "undefined") {
			localStorage.setItem(GROUP_KEY, groupBy);
		}
	});

	let sortedImages = $derived(
		sortBy === "createdAt-desc"
			? [...images].sort((a, b) => {
					const dateDiff = b.createdAt - a.createdAt;
					return dateDiff !== 0
						? dateDiff
						: a.filename.localeCompare(b.filename);
				})
			: sortBy === "createdAt-asc"
				? [...images].sort((a, b) => {
						const dateDiff = a.createdAt - b.createdAt;
						return dateDiff !== 0
							? dateDiff
							: a.filename.localeCompare(b.filename);
					})
				: [...images],
	);

	interface ImageGroup {
		label: string;
		images: LibraryImage[];
	}

	let groupedImages = $derived.by(() => {
		if (groupBy === "none") {
			return [{ label: "", images: sortedImages }];
		}

		const groups = new SvelteMap<string, LibraryImage[]>();

		for (const image of sortedImages) {
			const date = new Date(image.createdAt);
			let key: string;

			if (groupBy === "day") {
				key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
			} else if (groupBy === "month") {
				key = `${date.getFullYear()}-${date.getMonth()}`;
			} else {
				key = `${date.getFullYear()}`;
			}

			if (!groups.has(key)) {
				groups.set(key, []);
			}
			groups.get(key)!.push(image);
		}

		return Array.from(groups.entries()).map(([key, imgs]) => ({
			label:
				imgs.length > 0
					? groupBy === "day"
						? new Date(imgs[0].createdAt).toLocaleDateString(
								undefined,
								{
									year: "numeric",
									month: "long",
									day: "numeric",
									weekday: "long",
								},
							)
						: groupBy === "month"
							? new Date(imgs[0].createdAt).toLocaleDateString(
									undefined,
									{
										year: "numeric",
										month: "long",
									},
								)
							: new Date(imgs[0].createdAt)
									.getFullYear()
									.toString()
					: key,
			images: imgs,
		}));
	});

	onMount(async () => {
		// Reset progress counters from any previous visit
		resetThumbQueueProgress();

		// Subscribe to thumb progress notifications so the hint bar updates reactively.
		onThumbProgress(() => {
			thumbProgress = { ...thumbQueueProgress };
		});

		if (!libraryId) {
			loading = false;
			return;
		}

		// Register callback so background scan batches stream into this page.
		onScanBatch((batchLibraryId, newImages) => {
			if (batchLibraryId !== libraryId) return;
			images = [...images, ...newImages];
			// Feed newly-discovered images into the thumb queue immediately.
			if (dirPath) {
				void prefetchThumbs(newImages, dirPath);
				// Extend the progress total so the counter stays accurate.
				thumbQueueProgress.total += newImages.length;
				thumbProgress = { ...thumbQueueProgress };
			}
		});

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

		const path = await getLibraryPath(libraryId);
		if (path) dirPath = path;

		// Render immediately — rescan deferred to idle time (Phase 5)
		loading = false;

		// Kick off OPFS pre-scan and background thumb generation for all images
		// now that we have both the image list and dirPath.
		// initThumbQueueForLibrary sets accurate progress totals before any
		// IntersectionObserver fires; prefetchThumbs feeds files to the worker pool.
		if (dirPath && imgs.length > 0) {
			void initThumbQueueForLibrary(imgs.map((img) => img.id));
			void prefetchThumbs(imgs, dirPath);
		}

		// Restore scroll position
		const saved = sessionStorage.getItem(SCROLL_KEY);
		if (saved) {
			const scrollPos = parseInt(saved, 10);
			setTimeout(() => {
				// Try VirtualGrid scroller first (groupBy=none), then the main scroller
				const scroller =
					virtualScrollEl ??
					(document.querySelector(
						"main[data-scroll-container]",
					) as HTMLElement | null);
				if (scroller) {
					scroller.scrollTop = scrollPos;
					sessionStorage.removeItem(SCROLL_KEY);
				}
			}, 100);
		}

		// Defer rescan to idle time so the grid renders first
		const runRescan = async () => {
			try {
				const newCount = await rescanLibrary(libraryId);
				if (newCount > 0) {
					images = await getImages(libraryId);
				}
			} catch (err) {
				console.error("Auto-rescan failed:", err);
			}
		};

		if ("requestIdleCallback" in window) {
			requestIdleCallback(() => void runRescan());
		} else {
			setTimeout(() => void runRescan(), 1000);
		}
	});

	beforeNavigate((nav) => {
		if (nav.to?.route.id?.includes("[imageId]")) {
			// Save scroll position from whichever container is active
			const scroller =
				groupBy === "none" ? virtualScrollEl : scrollContainer;
			if (scroller) {
				sessionStorage.setItem(
					SCROLL_KEY,
					scroller.scrollTop.toString(),
				);
			}
		}
	});

	onDestroy(() => {
		// Unregister callbacks so stale updates don't affect other pages.
		onScanBatch(null);
		onThumbProgress(null);
		resetThumbQueueProgress();
	});

	function formatDate(ms: number): string {
		return new Date(ms).toLocaleDateString(undefined, {
			year: "numeric",
			month: "short",
			day: "numeric",
		});
	}

	// ─── Keyboard shortcuts ───────────────────────────────────────────────────

	async function handleKeydown(e: KeyboardEvent) {
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
			case "Enter": {
				e.preventDefault();
				const selected = sortedImages[selIdx];
				if (selected) {
					await goto(resolve(`/library/${libraryId}/${selected.id}`));
				}
				break;
			}
		}
	}
</script>

<svelte:head>
	<title>{library?.label ?? "Library"} — Rolloc</title>
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
					<label for="sort-select" class="text-xs text-content-subtle"
						>Sort by:</label
					>
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
						class="text-xs text-content-subtle">Group by:</label
					>
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
		<!-- Grid view — wrapped in a relative container so the loading overlay
		     can be positioned absolutely over the grid content -->
		<div class="flex-1 overflow-hidden relative flex flex-col">
			<!-- Loading overlay — blocks interaction until all thumbs are ready -->

			<!-- Grid content — inert while loading so nothing is clickable/focusable -->
			<div class="flex-1 overflow-hidden flex flex-col">
				{#if groupBy === "none"}
					<!-- Flat virtualised grid — no grouping header needed -->
					<div class="flex-1 overflow-hidden">
						<VirtualGrid
							items={sortedImages}
							gap={8}
							overscan={3}
							bind:scrollEl={virtualScrollEl}
						>
							{#snippet item(image, i)}
								<LibraryImageThumb
									{image}
									{libraryId}
									dirPath={dirPath!}
									selected={i === selIdx}
								/>
							{/snippet}
						</VirtualGrid>
					</div>
				{:else}
					<!-- Grouped grid — regular DOM render with scroll container -->
					<main
						bind:this={scrollContainer}
						data-scroll-container
						class="flex-1 overflow-y-auto p-l"
					>
						{#each groupedImages as group (group.label)}
							<h2
								class="text-lg font-semibold text-content mb-base mt-l
						first:mt-0 border-b border-primary"
							>
								{group.label}
								<span
									class="text-sm text-content-subtle font-normal ml-xs
							"
								>
									({group.images.length} image{group.images
										.length !== 1
										? "s"
										: ""})
								</span>
							</h2>
							<ul
								class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 mb-xl"
							>
								{#each group.images as image (image.id)}
									{@const globalIndex =
										sortedImages.findIndex(
											(img) => img.id === image.id,
										)}
									<li>
										<LibraryImageThumb
											{image}
											{libraryId}
											{dirPath}
											selected={globalIndex === selIdx}
										/>
									</li>
								{/each}
							</ul>
						{/each}
					</main>
				{/if}
			</div>
			<!-- /inert wrapper -->
		</div>
		<!-- /relative container -->

		<!-- Keyboard shortcut hint bar -->
		<KeyboardHintBar
			hints={[
				{ keys: ["←", "→"], label: "navigate" },
				{ keys: ["e"], label: "view" },
			]}
			progress={thumbProgressLabel}
		/>
	{/if}
</div>
