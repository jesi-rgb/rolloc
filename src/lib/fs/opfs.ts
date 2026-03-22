/**
 * Thumbnail/preview cache using OPFS (Origin Private File System).
 *
 * All cached images are stored in the browser's private file system, never touching
 * the user's local disk. This is the only place the app writes any data.
 *
 * Layout:
 *   /previews/{frameId}.jpg   — medium-res preview ~1200px long edge
 *   /thumbs/{frameId}.jpg     — filmstrip thumbnail ~300px long edge
 *
 * Cache versioning:
 *   A version sentinel is stored at /cache-version.  On every first read or
 *   write per page load, the stored version is compared to CACHE_VERSION.  If
 *   they differ, all thumbs and previews are deleted before the operation
 *   proceeds.  Bump CACHE_VERSION here whenever the generation pipeline changes
 *   in a way that invalidates previously cached output.
 */

const DIR_PREVIEWS = 'previews';
const DIR_THUMBS   = 'thumbs';

// ─── Cache version ────────────────────────────────────────────────────────────

/**
 * Increment this whenever thumbnail or preview generation logic changes in a
 * way that makes previously cached output incorrect (e.g. orientation fix,
 * new resize algorithm, colour-space change).
 *
 * On next app load, ensureCacheVersion() will delete all cached files and
 * write the new version before any read or write is allowed.
 */
const CACHE_VERSION = 3;

let _cacheReady: Promise<void> | null = null;

// ─── OPFS directory setup ─────────────────────────────────────────────────────

let rootDirHandle:    FileSystemDirectoryHandle | null = null;
let previewsDirHandle: FileSystemDirectoryHandle | null = null;
let thumbsDirHandle:   FileSystemDirectoryHandle | null = null;

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

// ─── Low-level clear helpers (used by ensureCacheVersion) ────────────────────

async function _clearDir(getDirHandle: () => Promise<FileSystemDirectoryHandle>): Promise<void> {
	try {
		const dir = await getDirHandle();
		const names: string[] = [];
		for await (const [name] of dir.entries()) {
			names.push(name);
		}
		await Promise.all(names.map((n) => dir.removeEntry(n).catch(() => undefined)));
	} catch {
		// Directory may not exist yet — that's fine
	}
}

// ─── Cache version check ──────────────────────────────────────────────────────

/**
 * Ensures the OPFS cache version matches CACHE_VERSION.
 * If not, deletes all cached thumbnails and previews then writes the new version.
 * Runs at most once per page load.  Every public read/write function awaits this.
 */
function ensureCacheVersion(): Promise<void> {
	if (_cacheReady) return _cacheReady;
	_cacheReady = (async () => {
		const stored = await readCacheVersion();
		if (stored !== CACHE_VERSION) {
			await Promise.all([_clearDir(getThumbsDir), _clearDir(getPreviewsDir)]);
			// Reset cached handles — directories were just wiped and will be re-created.
			thumbsDirHandle   = null;
			previewsDirHandle = null;
			await writeCacheVersion(CACHE_VERSION);
		}
	})();
	return _cacheReady;
}

// ─── Cache version I/O (no ensureCacheVersion guard — called by it) ──────────

/**
 * Writes a version sentinel file to OPFS root.
 */
export async function writeCacheVersion(version: number): Promise<void> {
	const root = await getRootDir();
	const fileHandle = await root.getFileHandle('cache-version', { create: true });
	const writable = await fileHandle.createWritable();
	await writable.write(String(version));
	await writable.close();
}

/**
 * Returns the stored cache version, or 0 if absent.
 */
export async function readCacheVersion(): Promise<number> {
	try {
		const root = await getRootDir();
		const fileHandle = await root.getFileHandle('cache-version');
		const file = await fileHandle.getFile();
		const text = await file.text();
		const v = parseInt(text, 10);
		return isNaN(v) ? 0 : v;
	} catch {
		return 0;
	}
}

// ─── Write operations ─────────────────────────────────────────────────────────

async function writeCache(
	getDirHandle: () => Promise<FileSystemDirectoryHandle>,
	filename: string,
	blob: Blob,
): Promise<void> {
	await ensureCacheVersion();
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
	await ensureCacheVersion();
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

// ─── Bulk clear (exported for external callers) ───────────────────────────────

export async function clearAllThumbs(): Promise<void> {
	await _clearDir(getThumbsDir);
}

export async function clearAllPreviews(): Promise<void> {
	await _clearDir(getPreviewsDir);
}

// ─── Object URL helpers ───────────────────────────────────────────────────────

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
