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
export { getLibraries, getLibrary, getImages, putLibrary };

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
	const images: LibraryImage[] = files.map((file, idx) => ({
		id: crypto.randomUUID(),
		libraryId: id,
		relativePath: file.relativePath,
		filename: file.filename,
		index: idx,
		rating: 0,
		notes: '',
		// Use actual file creation/modification timestamp
		createdAt: file.createdAt,
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

	return newImages.length;
}
