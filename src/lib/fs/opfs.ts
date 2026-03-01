/**
 * Thumbnail/preview cache using OPFS (Origin Private File System).
 *
 * All cached images are stored in the browser's private file system, never touching
 * the user's local disk. This is the only place the app writes any data.
 *
 * Layout:
 *   /previews/{frameId}.jpg   — medium-res preview ~1200px long edge
 *   /thumbs/{frameId}.jpg     — filmstrip thumbnail ~300px long edge
 */

const DIR_PREVIEWS = 'previews';
const DIR_THUMBS = 'thumbs';

// ─── OPFS directory setup ─────────────────────────────────────────────────────

let rootDirHandle: FileSystemDirectoryHandle | null = null;
let previewsDirHandle: FileSystemDirectoryHandle | null = null;
let thumbsDirHandle: FileSystemDirectoryHandle | null = null;

async function getRootDir(): Promise<FileSystemDirectoryHandle> {
	if (rootDirHandle) return rootDirHandle;
	rootDirHandle = await navigator.storage.getDirectory();
	return rootDirHandle;
}

async function getPreviewsDir(): Promise<FileSystemDirectoryHandle> {
	if (previewsDirHandle) return previewsDirHandle;
	const root = await getRootDir();
	previewsDirHandle = await root.getDirectoryHandle(DIR_PREVIEWS, { create: true });
	return previewsDirHandle;
}

async function getThumbsDir(): Promise<FileSystemDirectoryHandle> {
	if (thumbsDirHandle) return thumbsDirHandle;
	const root = await getRootDir();
	thumbsDirHandle = await root.getDirectoryHandle(DIR_THUMBS, { create: true });
	return thumbsDirHandle;
}

// ─── Write operations ─────────────────────────────────────────────────────────

async function writeCache(
	getDirHandle: () => Promise<FileSystemDirectoryHandle>,
	filename: string,
	blob: Blob,
): Promise<void> {
	const dirHandle = await getDirHandle();
	const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
	const writable = await fileHandle.createWritable();
	await writable.write(blob);
	await writable.close();
}

export async function writePreview(frameId: string, blob: Blob): Promise<void> {
	await writeCache(getPreviewsDir, `${frameId}.jpg`, blob);
}

export async function writeThumb(frameId: string, blob: Blob): Promise<void> {
	await writeCache(getThumbsDir, `${frameId}.jpg`, blob);
}

// ─── Read operations ──────────────────────────────────────────────────────────

async function readCache(
	getDirHandle: () => Promise<FileSystemDirectoryHandle>,
	filename: string,
): Promise<Blob | null> {
	try {
		const dirHandle = await getDirHandle();
		const fileHandle = await dirHandle.getFileHandle(filename);
		const file = await fileHandle.getFile();
		return file;
	} catch {
		// File doesn't exist or other error — return null
		return null;
	}
}

export async function readPreview(frameId: string): Promise<Blob | null> {
	return readCache(getPreviewsDir, `${frameId}.jpg`);
}

export async function readThumb(frameId: string): Promise<Blob | null> {
	return readCache(getThumbsDir, `${frameId}.jpg`);
}

// ─── Delete operations ────────────────────────────────────────────────────────

async function removeCache(
	getDirHandle: () => Promise<FileSystemDirectoryHandle>,
	filename: string,
): Promise<void> {
	try {
		const dirHandle = await getDirHandle();
		await dirHandle.removeEntry(filename);
	} catch {
		// Ignore errors (file might not exist)
	}
}

export async function deleteFrameCache(frameId: string): Promise<void> {
	await Promise.all([
		removeCache(getPreviewsDir, `${frameId}.jpg`),
		removeCache(getThumbsDir, `${frameId}.jpg`),
	]);
}

// ─── URL helpers ──────────────────────────────────────────────────────────────

/**
 * Returns an object URL for a cached thumbnail, or null if not cached.
 * Caller is responsible for revoking the URL when done.
 */
export async function thumbURL(frameId: string): Promise<string | null> {
	const blob = await readThumb(frameId);
	return blob ? URL.createObjectURL(blob) : null;
}

export async function previewURL(frameId: string): Promise<string | null> {
	const blob = await readPreview(frameId);
	return blob ? URL.createObjectURL(blob) : null;
}
