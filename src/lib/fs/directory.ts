/**
 * File System Access API helpers.
 *
 * Responsible for:
 *   - Prompting the user to pick a directory
 *   - Enumerating supported image files within it
 *   - Reading file blobs from a stored handle
 */

/** File extensions we'll accept as image input (phase 1: JPEG/TIFF). */
const SUPPORTED_EXTENSIONS = new Set([
	'jpg', 'jpeg', 'tif', 'tiff',
	// Phase 5: RAW formats (added when libraw WASM is integrated)
	// 'arw', 'cr2', 'cr3', 'nef', 'raf', 'dng', 'orf', 'rw2',
]);

export interface DirectoryFile {
	filename: string;
	/** Full relative path from the directory root (for nested dirs). */
	relativePath: string;
}

// ─── Directory picker ─────────────────────────────────────────────────────────

/**
 * Opens the native directory picker and returns the handle.
 * Returns null if the user cancels.
 */
export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
	try {
		return await window.showDirectoryPicker({ mode: 'read' });
	} catch (err) {
		// User cancelled — DOMException with name 'AbortError'
		if (err instanceof DOMException && err.name === 'AbortError') return null;
		throw err;
	}
}

// ─── File enumeration ─────────────────────────────────────────────────────────

function isSupported(filename: string): boolean {
	const ext = filename.split('.').pop()?.toLowerCase() ?? '';
	return SUPPORTED_EXTENSIONS.has(ext);
}

/**
 * Recursively lists all supported image files in a directory handle.
 * Files are returned sorted by name.
 */
export async function listImageFiles(
	dir: FileSystemDirectoryHandle,
	prefix = ''
): Promise<DirectoryFile[]> {
	const results: DirectoryFile[] = [];

	for await (const [name, entry] of dir) {
		if (entry.kind === 'file' && isSupported(name)) {
			results.push({
				filename: name,
				relativePath: prefix ? `${prefix}/${name}` : name,
			});
		} else if (entry.kind === 'directory') {
			const subDir = await dir.getDirectoryHandle(name);
			const nested = await listImageFiles(subDir, prefix ? `${prefix}/${name}` : name);
			results.push(...nested);
		}
	}

	return results.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));
}

// ─── File access ──────────────────────────────────────────────────────────────

/**
 * Retrieves a File object from a stored directory handle by filename.
 * Supports one level of subdirectory via relativePath.
 */
export async function getFile(
	dir: FileSystemDirectoryHandle,
	relativePath: string
): Promise<File> {
	const parts = relativePath.split('/');
	let current: FileSystemDirectoryHandle = dir;

	for (let i = 0; i < parts.length - 1; i++) {
		current = await current.getDirectoryHandle(parts[i]);
	}

	const filename = parts[parts.length - 1];
	const fileHandle = await current.getFileHandle(filename);
	return fileHandle.getFile();
}

// ─── Permission check ─────────────────────────────────────────────────────────

/**
 * Checks (and optionally requests) read permission for a stored handle.
 * Returns true if permission is granted.
 *
 * Browser security: stored handles lose permission across sessions.
 * Call this before any file access and prompt the user if it returns false.
 */
export async function verifyPermission(
	handle: FileSystemDirectoryHandle,
	{ request = false }: { request?: boolean } = {}
): Promise<boolean> {
	const opts: FileSystemHandlePermissionDescriptor = { mode: 'read' };
	const state = await handle.queryPermission(opts);
	if (state === 'granted') return true;
	if (!request) return false;
	return (await handle.requestPermission(opts)) === 'granted';
}
