/**
 * High-level library operations combining IDB + File System Access API.
 */

import type { Library, LibraryImage } from '$lib/types';
import {
	getLibraries,
	getLibrary,
	putLibrary,
	deleteLibrary as deleteLibraryRecord,
	getImages,
	putImages,
	getHandle,
	putHandle,
} from './idb';
import { listImageFiles } from '$lib/fs/directory';

/**
 * Re-export IDB functions for convenience.
 */
export { getLibraries, getLibrary, getImages };

/**
 * Create a new library from a directory handle.
 */
export async function createLibrary(
	label: string,
	dirHandle: FileSystemDirectoryHandle
): Promise<Library> {
	const id = crypto.randomUUID();
	const library: Library = {
		id,
		createdAt: Date.now(),
		label,
		notes: '',
	};

	// Scan directory for image files
	const files = await listImageFiles(dirHandle);
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

	// Store library, images, and handle
	await putLibrary(library);
	await putImages(images);
	await putHandle(id, dirHandle);

	return library;
}

/**
 * Delete a library and all its images.
 */
export async function deleteLibrary(id: string): Promise<void> {
	await deleteLibraryRecord(id);
}

/**
 * Get the directory handle for a library.
 * Requests permission if needed.
 */
export async function getLibraryHandle(
	libraryId: string
): Promise<FileSystemDirectoryHandle | null> {
	const handle = await getHandle(libraryId);
	if (!handle) return null;

	// Request permission if needed
	const permission = await handle.queryPermission({ mode: 'read' });
	if (permission === 'granted') return handle;

	const requested = await handle.requestPermission({ mode: 'read' });
	return requested === 'granted' ? handle : null;
}

/**
 * Get a file handle for an image in a library.
 */
export async function getImageFile(
	libraryId: string,
	filename: string
): Promise<File | null> {
	const handle = await getLibraryHandle(libraryId);
	if (!handle) return null;

	try {
		const fileHandle = await handle.getFileHandle(filename);
		return await fileHandle.getFile();
	} catch (err) {
		console.error(`Failed to get file ${filename}:`, err);
		return null;
	}
}
