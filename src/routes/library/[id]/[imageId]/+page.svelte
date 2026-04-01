<script lang="ts">
	/**
	 * Individual library image viewer with EXIF panel.
	 *
	 * Displays a single image at /library/[id]/[imageId] with prev/next navigation.
	 * Keyboard shortcuts: ← / → for navigation, Esc to return to library grid
	 */
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";
	import { page } from "$app/state";
	import { resolve } from "$app/paths";
	import { getLibrary, getImages, getLibraryPath } from "$lib/db/libraries";
	import type { Library, LibraryImage } from "$lib/types";
	import exifr from "exifr";
	import {
		parseFujifilmMakerNote,
		type FujifilmSettings,
	} from "$lib/image/fuji-makernote";
	import type { ExifData } from "$lib/components/exif-types";
	import ExifPanel from "$lib/components/ExifPanel.svelte";
	import KeyboardHintBar from "$lib/components/KeyboardHintBar.svelte";
	import { PaneGroup, Pane, PaneResizer } from "paneforge";
	import type { PaneAPI } from "paneforge";
	import { Sidebar, SidebarIcon } from "phosphor-svelte";

	interface ImageWithExif {
		image: LibraryImage;
		url: string | null;
		exif: ExifData | null;
		loading: boolean;
		error: string;
	}

	type SortKey = "createdAt-desc" | "createdAt-asc";
	const SORT_KEY = "library-sort-preference";

	const libraryId = $derived(page.params.id ?? "");
	const imageId = $derived(page.params.imageId ?? "");

	// Read sort preference from localStorage (same as library grid)
	const savedSort =
		typeof localStorage !== "undefined"
			? localStorage.getItem(SORT_KEY)
			: null;
	const sortBy: SortKey = (savedSort as SortKey) ?? "createdAt-desc";

	let library = $state<Library | null>(null);
	let images = $state<ImageWithExif[]>([]);
	let loading = $state(true);
	let error = $state("");

	// Zoom state
	let zoomed = $state(false);
	let zoomLevel = $state(2); // 2x zoom by default when zoomed in
	let mouseX = $state(0); // Normalized 0-1
	let mouseY = $state(0); // Normalized 0-1
	let imageContainer = $state<HTMLDivElement | null>(null);

	// Sorted images (match the library grid sort order)
	const sortedImages = $derived(
		sortBy === "createdAt-desc"
			? [...images].sort((a, b) => {
					const dateDiff = b.image.createdAt - a.image.createdAt;
					return dateDiff !== 0
						? dateDiff
						: a.image.filename.localeCompare(b.image.filename);
				})
			: [...images].sort((a, b) => {
					const dateDiff = a.image.createdAt - b.image.createdAt;
					return dateDiff !== 0
						? dateDiff
						: a.image.filename.localeCompare(b.image.filename);
				}),
	);

	// Derived values for current image (using sorted order)
	const currentIndex = $derived(
		sortedImages.findIndex((img) => img.image.id === imageId),
	);
	const current = $derived(sortedImages[currentIndex] ?? null);

	onMount(async () => {
		if (!libraryId || !imageId) {
			error = "Invalid URL parameters";
			loading = false;
			return;
		}

		try {
			const [lib, imgs] = await Promise.all([
				getLibrary(libraryId),
				getImages(libraryId),
			]);

			if (!lib) {
				error = "Library not found";
				loading = false;
				return;
			}

			library = lib;
			images = imgs.map((img) => ({
				image: img,
				url: null,
				exif: null,
				loading: false,
				error: "",
			}));

			// Load current image by imageId
			const idx = images.findIndex((img) => img.image.id === imageId);
			if (idx === -1) {
				error = "Image not found in library";
				loading = false;
				return;
			}

			await loadImage(idx);
			loading = false;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			loading = false;
		}
	});

	// React to imageId changes from navigation (arrow keys)
	$effect(() => {
		// When imageId changes and images are loaded, load the new image and prefetch neighbors
		if (images.length > 0 && imageId) {
			// Find in original images array (not sorted) since loadImage uses that array
			const idx = images.findIndex((img) => img.image.id === imageId);
			if (idx !== -1) {
				loadImage(idx).then(() => prefetchNeighbors());
			}
		}
	});

	/**
	 * Prefetch the 2 images before and 2 images after the current image in sorted order
	 * so navigation feels instant with no flicker.
	 */
	function prefetchNeighbors(): void {
		const sorted = sortedImages;
		const ci = sorted.findIndex((img) => img.image.id === imageId);
		if (ci === -1) return;

		for (let offset = -2; offset <= 2; offset++) {
			if (offset === 0) continue;
			const neighbor = sorted[ci + offset];
			if (!neighbor) continue;
			const origIdx = images.findIndex(
				(img) => img.image.id === neighbor.image.id,
			);
			if (origIdx !== -1) {
				// Fire-and-forget; errors are handled inside loadImage
				loadImage(origIdx);
			}
		}
	}

	async function loadImage(index: number) {
		if (index < 0 || index >= images.length) return;
		const item = images[index];
		if (item.url) return; // Already loaded

		item.loading = true;
		try {
			const dirPath = await getLibraryPath(library!.id);
			if (!dirPath) {
				item.error = "Directory path not found";
				return;
			}

			const { getFile } = await import("$lib/fs/directory");
			const file = await getFile(dirPath, item.image.relativePath);
			const url = URL.createObjectURL(file);
			item.url = url;

			// Extract EXIF
			try {
				// First pass: get standard EXIF with translated values
				const exif = await exifr.parse(file, {
					translateValues: true,
					translateKeys: true,
				});

				item.exif = {
					make: exif?.Make,
					model: exif?.Model,
					lensModel: exif?.LensModel,
					iso: exif?.ISO,
					fNumber: exif?.FNumber,
					exposureTime: exif?.ExposureTime,
					focalLength: exif?.FocalLength,
					dateTime: exif?.DateTimeOriginal || exif?.DateTime,
					exposureCompensation: exif?.ExposureCompensation,
				};

				// Extract Fujifilm-specific settings if this is a Fujifilm camera
				if (exif?.Make === "FUJIFILM") {
					try {
						// Second pass: get raw MakerNote data
						const rawData = await exifr.parse(file, {
							makerNote: true,
							translateKeys: false,
							translateValues: false,
							mergeOutput: false,
						});

						const makerNote = rawData?.makerNote;
						if (makerNote) {
							item.exif.fuji = parseFujifilmMakerNote(makerNote);
						}
					} catch (e) {
						console.warn("Failed to parse Fujifilm MakerNote:", e);
					}
				}
			} catch (e) {
				console.warn("Failed to parse EXIF:", e);
			}
		} catch (e) {
			item.error = e instanceof Error ? e.message : String(e);
		} finally {
			item.loading = false;
		}
	}

	async function nextImage() {
		const nextIdx = currentIndex + 1;
		if (nextIdx < sortedImages.length) {
			const nextId = sortedImages[nextIdx].image.id;
			await goto(resolve(`/library/${libraryId}/${nextId}`), {
				replaceState: true,
			});
		}
	}

	async function prevImage() {
		const prevIdx = currentIndex - 1;
		if (prevIdx >= 0) {
			const prevId = sortedImages[prevIdx].image.id;
			await goto(resolve(`/library/${libraryId}/${prevId}`), {
				replaceState: true,
			});
		}
	}

	// Keyboard navigation
	async function handleKeydown(e: KeyboardEvent) {
		const tag = (e.target as HTMLElement | null)?.tagName;
		if (tag === "INPUT" || tag === "TEXTAREA") return;

		switch (e.key) {
			case "ArrowLeft":
				e.preventDefault();
				await prevImage();
				break;
			case "ArrowRight":
				e.preventDefault();
				await nextImage();
				break;
			case "Escape":
				e.preventDefault();
				await goto(resolve(`/library/${libraryId}`));
				break;
		}
	}

	// Zoom handlers
	function handleImageClick() {
		zoomed = !zoomed;
		if (!zoomed) {
			// Reset zoom level when exiting zoom mode
			zoomLevel = 2;
		}
	}

	function handleMouseMove(e: MouseEvent) {
		if (!imageContainer) return;
		const rect = imageContainer.getBoundingClientRect();
		mouseX = (e.clientX - rect.left) / rect.width;
		mouseY = (e.clientY - rect.top) / rect.height;
	}

	function handleWheel(e: WheelEvent) {
		if (!zoomed) return;
		e.preventDefault();
		// Adjust zoom level: scroll up increases, scroll down decreases
		const delta = -e.deltaY * 0.01;
		zoomLevel = Math.max(1.5, Math.min(10, zoomLevel + delta));
	}

	// Reset zoom when navigating to a different image
	$effect(() => {
		if (imageId) {
			zoomed = false;
			zoomLevel = 2;
		}
	});

	// EXIF pane collapse/expand
	let exifPane = $state<PaneAPI | null>(null);
	let exifPaneOpen = $state(true);

	function toggleExifPane(): void {
		if (!exifPane) return;
		if (exifPaneOpen) {
			exifPane.collapse();
			exifPaneOpen = false;
		} else {
			exifPane.expand();
			exifPaneOpen = true;
		}
	}
</script>

<svelte:head>
	<title>{library?.label || "Library"} — Rolloc</title>
</svelte:head>

<svelte:window onkeydown={handleKeydown} />

<div class="h-screen bg-base text-content flex flex-col">
	<!-- Header -->
	<header
		class="flex items-center justify-between px-l py-base border-b border-base-subtle shrink-0"
	>
		<div class="flex items-center gap-sm">
			<button
				onclick={() => goto(resolve(`/library/${libraryId}`))}
				class="text-content-muted hover:text-content transition bg-transparent border-none cursor-pointer p-0"
				>← {library?.label || "Back"}</button
			>
			{#if library}
				<h1 class="text-l font-semibold text-content">
					{current.image.filename}
				</h1>
			{/if}
		</div>
		<div class="text-sm text-content-muted tabular-nums">
			{#if currentIndex >= 0 && sortedImages.length > 0}
				{currentIndex + 1} / {sortedImages.length}
			{/if}
		</div>
	</header>

	{#if error}
		<div class="flex-1 flex items-center justify-center">
			<p class="text-danger">{error}</p>
		</div>
	{:else if !current}
		<div class="flex-1 flex items-center justify-center">
			<p class="text-content-muted">Image not found</p>
		</div>
	{:else}
		<PaneGroup direction="horizontal" class="flex-1 min-h-0 relative">
			{#if !exifPaneOpen}
				<button
					class="absolute top-10 right-10"
					onclick={toggleExifPane}><SidebarIcon /></button
				>
			{/if}
			<!-- Main image viewer pane -->
			<Pane defaultSize={75} minSize={30} order={1}>
				<div
					bind:this={imageContainer}
					class="h-full flex items-center justify-center p-l overflow-hidden"
					class:cursor-zoom-in={!zoomed && current.url}
					class:cursor-zoom-out={zoomed}
					onmousemove={handleMouseMove}
					onwheel={handleWheel}
				>
					{#if current.error}
						<p class="text-danger">{current.error}</p>
					{:else if current.url}
						<img
							src={current.url}
							alt={current.image.filename}
							class="max-w-full max-h-full object-contain rounded-lg"
							style={zoomed
								? `transform: scale(${zoomLevel}) translate(${(0.5 - mouseX) * 100}%, ${(0.5 - mouseY) * 100}%); transform-origin: center;`
								: ""}
							onclick={handleImageClick}
						/>
					{/if}
				</div>
			</Pane>

			<!-- EXIF panel pane -->
			<PaneResizer
				class="bg-base-subtle hover:bg-primary transition-colors
				cursor-col-resize shrink-0 {exifPaneOpen ? 'w-1.5' : 'w-0'}"
			/>
			<Pane
				bind:this={exifPane}
				defaultSize={20}
				minSize={20}
				maxSize={30}
				collapsible={true}
				collapsedSize={0}
				order={2}
			>
				<ExifPanel
					exif={current.exif}
					url={current.url}
					open={exifPaneOpen}
					onToggle={toggleExifPane}
				/>
			</Pane>
		</PaneGroup>

		<!-- Keyboard shortcut hint bar -->
		<KeyboardHintBar
			hints={[
				{ keys: ["←", "→"], label: "navigate" },
				{ keys: ["Esc"], label: "back to grid" },
				{ keys: ["Click"], label: "zoom in/out" },
				{ keys: ["Scroll"], label: "zoom level" },
			]}
		/>
	{/if}
</div>
