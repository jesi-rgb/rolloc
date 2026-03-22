/**
 * High-level library operations combining IDB + Tauri filesystem API.
 */

import type { Library, LibraryImage } from '$lib/types';
import {
	getLibraries,
	getLibrary,
	putLibrary,
	deleteLibrary as deleteLibraryRecord,
	getImages,
	putImages,
	getPath,
	putPath,
} from './idb';
import { listImageFiles } from '$lib/fs/directory';

/**
 * Re-export IDB functions for convenience.
 */
export { getLibraries, getLibrary, getImages, putLibrary };

// ─── Progressive scan subscriber ─────────────────────────────────────────────

/**
 * Callback invoked by the background scan (Phase B of createLibrary) each time
 * a batch of new images has been written to IDB.
 *
 * The library page registers itself here on mount and clears on destroy,
 * so only the currently-visible library page receives updates.
 */
export type ScanBatchCallback = (libraryId: string, newImages: LibraryImage[]) => void;

let _scanBatchCallback: ScanBatchCallback | null = null;

/** Register a listener for background scan batches. Only one listener at a time. */
export function onScanBatch(cb: ScanBatchCallback | null): void {
	_scanBatchCallback = cb;
}

const SCAN_BATCH_SIZE = 50;

/**
 * Create a new library from a directory path.
 *
 * Phase A (synchronous path): writes the Library record and path to IDB
 * immediately and returns — the caller can navigate to the library page at once.
 *
 * Phase B (background): scans the directory in batches of SCAN_BATCH_SIZE,
 * writing each batch to IDB and notifying the page via onScanBatch.
 */
export async function createLibrary(label: string, dirPath: string): Promise<Library> {
	const id = crypto.randomUUID();
	const library: Library = {
		id,
		createdAt: Date.now(),
		label,
		notes: '',
	};

	// Phase A — persist skeleton immediately so the page can render.
	await putLibrary(library);
	await putPath(id, dirPath);

	// Phase B — background scan + batch write (non-blocking).
	void (async () => {
		try {
			const files = await listImageFiles(dirPath);

			let globalIdx = 0;
			for (let start = 0; start < files.length; start += SCAN_BATCH_SIZE) {
				const batch = files.slice(start, start + SCAN_BATCH_SIZE);
				const newImages: LibraryImage[] = batch.map((file) => ({
					id: crypto.randomUUID(),
					libraryId: id,
					relativePath: file.relativePath,
					filename: file.filename,
					index: globalIdx++,
					rating: 0,
					notes: '',
					createdAt: file.createdAt,
				}));

				await putImages(newImages);
				_scanBatchCallback?.(id, newImages);

				// Yield to keep the UI thread responsive between batches.
				await new Promise<void>((r) => setTimeout(r, 0));
			}

		console.log(`[createLibrary] Scanned ${globalIdx} images for library "${label}"`);
		} catch (err) {
			console.error('[createLibrary] Background scan failed:', err);
		}
	})();

	return library;
}

/**
 * Delete a library and all its images.
 */
export async function deleteLibrary(id: string): Promise<void> {
	await deleteLibraryRecord(id);
}

/**
 * Get the directory path for a library.
 * In Tauri, no permission verification is needed — paths are persistent.
 */
export async function getLibraryPath(libraryId: string): Promise<string | null> {
	const path = await getPath(libraryId);
	return path ?? null;
}

/**
 * Re-scans a library directory for new images.
 * Adds only images that don't already exist in the database.
 * Returns the number of new images added.
 *
 * Thumbnail generation for new images is handled by the library page
 * via prefetchThumbs — not here — so we avoid loading all file bytes
 * in a single Promise.all burst.
 */
export async function rescanLibrary(libraryId: string): Promise<number> {
	const path = await getLibraryPath(libraryId);
	if (!path) {
		throw new Error('Library path not found');
	}

	// Get current images
	const existingImages = await getImages(libraryId);
	const existingFilenames = new Set(existingImages.map((img) => img.filename));

	// Scan directory
	const files = await listImageFiles(path);

	// Filter out images that already exist
	const newFiles = files.filter((file) => !existingFilenames.has(file.filename));

	if (newFiles.length === 0) {
		return 0;
	}

	// Find the highest existing index
	const maxIndex = existingImages.reduce((max, img) => Math.max(max, img.index), -1);

	// Create LibraryImage records for new files
	const newImages: LibraryImage[] = newFiles.map((file, idx) => ({
		id: crypto.randomUUID(),
		libraryId,
		relativePath: file.relativePath,
		filename: file.filename,
		index: maxIndex + 1 + idx,
		rating: 0,
		notes: '',
		createdAt: file.createdAt,
	}));

	await putImages(newImages);

	return newImages.length;
}
