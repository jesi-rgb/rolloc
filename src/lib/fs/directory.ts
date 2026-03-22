/**
 * File System helpers (Tauri version).
 *
 * Replaces browser File System Access API with Tauri's native fs/dialog plugins.
 * Responsible for:
 *   - Prompting the user to pick a directory (returns absolute path)
 *   - Enumerating supported image files within it
 *   - Reading file blobs from a stored path
 */

import { open } from '@tauri-apps/plugin-dialog';
import { readDir, readFile, stat } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';

/** File extensions we'll accept as image input (phase 1: JPEG/TIFF). */
const SUPPORTED_EXTENSIONS = new Set([
	'jpg',
	'jpeg',
	'tif',
	'tiff',
	// Phase 5: RAW formats (added when libraw WASM is integrated)
	// 'arw', 'cr2', 'cr3', 'nef', 'raf', 'dng', 'orf', 'rw2',
]);

export interface DirectoryFile {
	filename: string;
	/** Full relative path from the directory root (for nested dirs). */
	relativePath: string;
	/** File creation time (birthtime), or mtime if birthtime unavailable. */
	createdAt: number;
}

// ─── Directory picker ─────────────────────────────────────────────────────────

/**
 * Opens the native directory picker and returns the absolute path.
 * Returns null if the user cancels.
 */
export async function pickDirectory(): Promise<string | null> {
	try {
		const selected = await open({
			directory: true,
			multiple: false,
			title: 'Select Image Directory',
		});

		// open() returns string | string[] | null
		if (typeof selected === 'string') return selected;
		return null;
	} catch (err) {
		// User cancelled or error occurred
		console.error('[pickDirectory] Error:', err);
		return null;
	}
}

// ─── File enumeration ─────────────────────────────────────────────────────────

function isSupported(filename: string): boolean {
	// Skip macOS AppleDouble resource fork files (._filename)
	if (filename.startsWith('._')) return false;
	const ext = filename.split('.').pop()?.toLowerCase() ?? '';
	return SUPPORTED_EXTENSIONS.has(ext);
}

/**
 * Recursively lists all supported image files in a directory path.
 * Files are returned sorted by name.
 */
export async function listImageFiles(
	dirPath: string,
	prefix = ''
): Promise<DirectoryFile[]> {
	const results: DirectoryFile[] = [];

	try {
		const entries = await readDir(dirPath);

		for (const entry of entries) {
			if (!entry.isDirectory && entry.name && isSupported(entry.name)) {
				const fullPath = await join(dirPath, entry.name);
				const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

				// Get file metadata to extract creation/modification time
				let createdAt = Date.now(); // fallback to current time
				try {
					const fileInfo = await stat(fullPath);
					// Prefer birthtime (creation time), fall back to mtime (last modified)
					createdAt = (fileInfo.birthtime ?? fileInfo.mtime)?.getTime() ?? Date.now();
				} catch (err) {
					console.error(`Failed to stat ${fullPath}:`, err);
				}

				results.push({
					filename: entry.name,
					relativePath,
					createdAt,
				});
			} else if (entry.isDirectory && entry.name) {
				const subDirPath = await join(dirPath, entry.name);
				const nested = await listImageFiles(
					subDirPath,
					prefix ? `${prefix}/${entry.name}` : entry.name
				);
				results.push(...nested);
			}
		}
	} catch (err) {
		console.error(`[listImageFiles] Error reading directory ${dirPath}:`, err);
	}

	// Return results without sorting - let the UI handle sort order
	// (sorting here would override the chronological order from file metadata)
	return results;
}

// ─── File access ──────────────────────────────────────────────────────────────

/**
 * Retrieves a File object from a stored directory path by relative filename.
 * Supports nested subdirectories via relativePath (e.g. "subdir/image.jpg").
 */
export async function getFile(dirPath: string, relativePath: string): Promise<File> {
	const fullPath = await join(dirPath, relativePath);
	const uint8Array = await readFile(fullPath);

	// Convert Uint8Array to Blob, then to File
	const blob = new Blob([uint8Array]);
	const filename = relativePath.split('/').pop() ?? 'unknown';

	return new File([blob], filename, {
		type: inferMimeType(filename),
	});
}

function inferMimeType(filename: string): string {
	const ext = filename.split('.').pop()?.toLowerCase();
	if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
	if (ext === 'tif' || ext === 'tiff') return 'image/tiff';
	return 'application/octet-stream';
}

// ─── Permission check ─────────────────────────────────────────────────────────

/**
 * In Tauri, permissions are granted once at directory picker time.
 * This is a compatibility shim for the web version's permission model.
 * Always returns true since Tauri has persistent filesystem access.
 */
export async function verifyPermission(
	_path: string,
	_opts: { request?: boolean } = {}
): Promise<boolean> {
	// No permission verification needed in Tauri
	return true;
}
