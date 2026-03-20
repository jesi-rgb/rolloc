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
import { listImageFiles, getFile } from '$lib/fs/directory';
import { generateThumbnails } from '$lib/image/thumbgen';

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

			// Pre-generate thumbnails in background (non-blocking).
			void _generateThumbsForLibrary(id, dirPath, label);
		} catch (err) {
			console.error('[createLibrary] Background scan failed:', err);
		}
	})();

	return library;
}

/**
 * Generate thumbnails for all images in a library.
 * Runs entirely in the background — no return value needed by callers.
 */
async function _generateThumbsForLibrary(
	libraryId: string,
	dirPath: string,
	label: string,
): Promise<void> {
	try {
		const images = await getImages(libraryId);
		const filePromises = images.map(async (img) => {
			try {
				const file = await getFile(dirPath, img.relativePath);
				return { id: img.id, file };
			} catch (err) {
				console.error(`Failed to load file for ${img.filename}:`, err);
				return null;
			}
		});

		const loadedFiles = (await Promise.all(filePromises)).filter(
			(item): item is { id: string; file: File } => item !== null,
		);

		const count = await generateThumbnails(loadedFiles, {
			concurrency: 4,
			onProgress: (current, total) => {
				console.log(`[createLibrary] Thumbnail generation: ${current}/${total}`);
			},
		});

		console.log(`[createLibrary] Generated ${count} new thumbnails for library "${label}"`);
	} catch (err) {
		console.error('[createLibrary] Thumbnail generation failed:', err);
	}
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
 * Get a file for an image in a library.
 */
export async function getImageFile(libraryId: string, relativePath: string): Promise<File | null> {
	const path = await getLibraryPath(libraryId);
	if (!path) return null;

	try {
		return await getFile(path, relativePath);
	} catch (err) {
		console.error(`Failed to get file ${relativePath}:`, err);
		return null;
	}
}

/**
 * Re-scans a library directory for new images.
 * Adds only images that don't already exist in the database.
 * Returns the number of new images added.
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
		// Use actual file creation/modification timestamp
		createdAt: file.createdAt,
	}));

	// Store new images
	await putImages(newImages);

	// Pre-generate thumbnails for new images in background (non-blocking)
	void (async () => {
		try {
			const filePromises = newImages.map(async (img) => {
				try {
					const file = await getFile(path, img.relativePath);
					return { id: img.id, file };
				} catch (err) {
					console.error(`Failed to load file for ${img.filename}:`, err);
					return null;
				}
			});

			const loadedFiles = (await Promise.all(filePromises)).filter(
				(item): item is { id: string; file: File } => item !== null
			);

			if (loadedFiles.length > 0) {
				const count = await generateThumbnails(loadedFiles, {
					concurrency: 4,
					onProgress: (current, total) => {
						console.log(`[rescanLibrary] Thumbnail generation: ${current}/${total}`);
					},
				});

				console.log(`[rescanLibrary] Generated ${count} new thumbnails`);
			}
		} catch (err) {
			console.error('[rescanLibrary] Thumbnail generation failed:', err);
		}
	})();

	return newImages.length;
}
