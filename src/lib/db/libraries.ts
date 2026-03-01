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

/**
 * Re-export IDB functions for convenience.
 */
export { getLibraries, getLibrary, getImages };

/**
 * Create a new library from a directory path.
 */
export async function createLibrary(label: string, dirPath: string): Promise<Library> {
	const id = crypto.randomUUID();
	const library: Library = {
		id,
		createdAt: Date.now(),
		label,
		notes: '',
	};

	// Scan directory for image files
	const files = await listImageFiles(dirPath);
	const now = Date.now();
	const images: LibraryImage[] = files.map((file, idx) => ({
		id: crypto.randomUUID(),
		libraryId: id,
		filename: file.filename,
		index: idx,
		rating: 0,
		notes: '',
		// Increment timestamp by index so images have unique createdAt values
		createdAt: now + idx,
	}));

	// Store library, images, and path
	await putLibrary(library);
	await putImages(images);
	await putPath(id, dirPath);

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
 * Get a file for an image in a library.
 */
export async function getImageFile(libraryId: string, filename: string): Promise<File | null> {
	const path = await getLibraryPath(libraryId);
	if (!path) return null;

	try {
		return await getFile(path, filename);
	} catch (err) {
		console.error(`Failed to get file ${filename}:`, err);
		return null;
	}
}
