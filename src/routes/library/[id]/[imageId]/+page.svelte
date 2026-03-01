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
	import { getFilmSimIcon } from "$lib/image/film-sim-icons";
	import MiniCalendar from "$lib/components/MiniCalendar.svelte";
	import AnalogClock from "$lib/components/AnalogClock.svelte";
	import KeyboardHintBar from "$lib/components/KeyboardHintBar.svelte";

	interface ImageWithExif {
		image: LibraryImage;
		url: string | null;
		exif: ExifData | null;
		loading: boolean;
		error: string;
	}

	interface ExifData {
		make?: string;
		model?: string;
		lensModel?: string;
		iso?: number;
		fNumber?: number;
		exposureTime?: number;
		focalLength?: number;
		dateTime?: string;
		exposureCompensation?: number;
		// Fujifilm-specific fields
		fuji?: FujifilmSettings;
	}

	const libraryId = $derived(page.params.id ?? "");
	const imageId = $derived(page.params.imageId ?? "");

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

	// Derived values for current image
	const currentIndex = $derived(
		images.findIndex((img) => img.image.id === imageId),
	);
	const current = $derived(images[currentIndex] ?? null);

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
		// When imageId changes and images are loaded, load the new image
		if (images.length > 0 && imageId) {
			const idx = images.findIndex((img) => img.image.id === imageId);
			if (idx !== -1) {
				loadImage(idx);
			}
		}
	});

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
			const file = await getFile(dirPath, item.image.filename);
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
		if (nextIdx < images.length) {
			const nextId = images[nextIdx].image.id;
			await goto(resolve(`/library/${libraryId}/${nextId}`));
		}
	}

	async function prevImage() {
		const prevIdx = currentIndex - 1;
		if (prevIdx >= 0) {
			const prevId = images[prevIdx].image.id;
			await goto(resolve(`/library/${libraryId}/${prevId}`));
		}
	}

	// Keyboard navigation
	async function handleKeydown(e: KeyboardEvent) {
		const tag = (e.target as HTMLElement | null)?.tagName;
		if (tag === "INPUT" || tag === "TEXTAREA") return;

		switch (e.key) {
			case "ArrowLeft":
				e.preventDefault();
				await nextImage();
				break;
			case "ArrowRight":
				e.preventDefault();
				await prevImage();
				break;
			case "Escape":
				e.preventDefault();
				await goto(resolve(`/library/${libraryId}`));
				break;
		}
	}

	function formatExposureTime(time: number | undefined): string {
		if (!time) return "—";
		if (time >= 1) return `${time.toFixed(1)}s`;
		return `1/${Math.round(1 / time)}s`;
	}

	function formatAperture(f: number | undefined): string {
		if (!f) return "—";
		return `f/${f.toFixed(1)}`;
	}

	function formatFocalLength(fl: number | undefined): string {
		if (!fl) return "—";
		return `${Math.round(fl)}mm`;
	}

	function formatEV(ev: number | undefined): string {
		if (ev === undefined || ev === null) return "—";
		const sign = ev >= 0 ? "+" : "";
		return `${sign}${ev.toFixed(1)} EV`;
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
</script>

<svelte:head>
	<title>{library?.label || "Library"} — Roloc</title>
</svelte:head>

<svelte:window onkeydown={handleKeydown} />

<div class="h-screen bg-base text-content flex flex-col">
	<!-- Header -->
	<header
		class="flex items-center justify-between px-l py-base border-b border-base-subtle shrink-0"
	>
		<div class="flex items-center gap-sm">
			<a
				href={resolve(`/library/${libraryId}`)}
				class="text-content-muted hover:text-content transition"
				>← {library?.label || "Back"}</a
			>
			{#if library}
				<h1 class="text-l font-semibold text-content">
					{library.label}
				</h1>
			{/if}
		</div>
		<div class="text-sm text-content-muted">
			{#if currentIndex >= 0 && images.length > 0}
				{currentIndex + 1} / {images.length}
			{/if}
		</div>
	</header>

	{#if loading}
		<div class="flex-1 flex items-center justify-center">
			<p class="text-content-muted">Loading…</p>
		</div>
	{:else if error}
		<div class="flex-1 flex items-center justify-center">
			<p class="text-danger">{error}</p>
		</div>
	{:else if !current}
		<div class="flex-1 flex items-center justify-center">
			<p class="text-content-muted">Image not found</p>
		</div>
	{:else}
		<div class="flex flex-1 min-h-0">
			<!-- Main image viewer -->
			<div
				bind:this={imageContainer}
				class="flex-1 flex items-center justify-center p-l overflow-hidden"
				class:cursor-zoom-in={!zoomed && current.url}
				class:cursor-zoom-out={zoomed}
				onmousemove={handleMouseMove}
				onwheel={handleWheel}
			>
				{#if current.loading}
					<p class="text-content-muted">Loading image…</p>
				{:else if current.error}
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

			<!-- EXIF panel -->
			<aside
				class="w-80 border-l border-base-subtle bg-base-muted overflow-y-auto p-base"
			>
				<h2
					class="text-sm font-medium text-center text-content-muted uppercase tracking-wide mb-base"
				>
					EXIF Data
				</h2>

				{#if current.exif}
					{#if current.exif.dateTime}
						<div class="mb-base">
							<dd class="text-content font-medium">
								<div class="flex flex-row gap-base items-start">
									<MiniCalendar
										date={current.exif.dateTime}
									/>
									<AnalogClock date={current.exif.dateTime} />
								</div>
							</dd>
						</div>
					{/if}
					<dl class="grid grid-cols-2 gap-base text-sm">
						{#if current.exif.make || current.exif.model}
							<div>
								<dt class="text-content-muted">Camera</dt>
								<dd class="text-content font-medium">
									{current.exif.make || ""}
									{current.exif.model || ""}
								</dd>
							</div>
						{/if}

						{#if current.exif.lensModel}
							<div>
								<dt class="text-content-muted">Lens</dt>
								<dd class="text-content font-medium">
									{current.exif.lensModel}
								</dd>
							</div>
						{/if}

						{#if current.exif.iso}
							<div>
								<dt class="text-content-muted">ISO</dt>
								<dd class="text-content font-medium">
									{current.exif.iso}
								</dd>
							</div>
						{/if}

						{#if current.exif.fNumber}
							<div>
								<dt class="text-content-muted">Aperture</dt>
								<dd class="text-content font-medium">
									{formatAperture(current.exif.fNumber)}
								</dd>
							</div>
						{/if}

						{#if current.exif.exposureTime}
							<div>
								<dt class="text-content-muted">
									Shutter Speed
								</dt>
								<dd class="text-content font-medium">
									{formatExposureTime(
										current.exif.exposureTime,
									)}
								</dd>
							</div>
						{/if}

						{#if current.exif.focalLength}
							<div>
								<dt class="text-content-muted">Focal Length</dt>
								<dd class="text-content font-medium">
									{formatFocalLength(
										current.exif.focalLength,
									)}
								</dd>
							</div>
						{/if}

						{#if current.exif.exposureCompensation !== undefined && current.exif.exposureCompensation !== null}
							<div>
								<dt class="text-content-muted">
									Exposure Comp
								</dt>
								<dd class="text-content font-medium">
									{formatEV(
										current.exif.exposureCompensation,
									)}
								</dd>
							</div>
						{/if}

						{#if current.exif.fuji}
							{#if current.exif.fuji.filmMode}
								{@const icon = getFilmSimIcon(
									current.exif.fuji.filmMode,
								)}
								<div>
									<dt class="text-content-muted">
										Film Simulation
									</dt>
									<dd
										class="text-content font-medium flex
										items-baseline gap-sm"
									>
										{#if icon}
											<span
												class="inline-block leading-none"
												style="font-family: '{icon.font}'; font-size: 1.25rem;"
												aria-hidden="true"
											>
												{icon.char}
											</span>
										{/if}
										<span>{current.exif.fuji.filmMode}</span
										>
									</dd>
								</div>
							{/if}

							{#if current.exif.fuji.grainEffect && current.exif.fuji.grainEffect !== "Off"}
								<div>
									<dt class="text-content-muted">
										Grain Effect
									</dt>
									<dd class="text-content font-medium">
										{current.exif.fuji.grainEffect}
									</dd>
								</div>
							{/if}

							{#if current.exif.fuji.colorChromeEffect && current.exif.fuji.colorChromeEffect !== "Off"}
								<div>
									<dt class="text-content-muted">
										Color Chrome
									</dt>
									<dd class="text-content font-medium">
										{current.exif.fuji.colorChromeEffect}
									</dd>
								</div>
							{/if}

							{#if current.exif.fuji.colorChromeFXBlue && current.exif.fuji.colorChromeFXBlue !== "Off"}
								<div>
									<dt class="text-content-muted">
										Color Chrome FX Blue
									</dt>
									<dd class="text-content font-medium">
										{current.exif.fuji.colorChromeFXBlue}
									</dd>
								</div>
							{/if}

							{#if current.exif.fuji.clarity && current.exif.fuji.clarity !== "0 (Normal)"}
								<div>
									<dt class="text-content-muted">Clarity</dt>
									<dd class="text-content font-medium">
										{current.exif.fuji.clarity}
									</dd>
								</div>
							{/if}

							{#if current.exif.fuji.dynamicRange}
								<div>
									<dt class="text-content-muted">
										Dynamic Range
									</dt>
									<dd class="text-content font-medium">
										{current.exif.fuji.dynamicRange}
									</dd>
								</div>
							{/if}
						{/if}
					</dl>
				{:else}
					<p class="text-sm text-content-muted">
						No EXIF data available
					</p>
				{/if}
			</aside>
		</div>

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
