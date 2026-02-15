/**
 * OPFS (Origin Private File System) helpers.
 *
 * Layout:
 *   /previews/{frameId}.jpg   — medium-res preview ~1200px long edge
 *   /thumbs/{frameId}.jpg     — filmstrip thumbnail ~300px long edge
 */

const DIR_PREVIEWS = 'previews';
const DIR_THUMBS   = 'thumbs';

// ─── Root access ──────────────────────────────────────────────────────────────

async function getDir(name: string): Promise<FileSystemDirectoryHandle> {
	const root = await navigator.storage.getDirectory();
	return root.getDirectoryHandle(name, { create: true });
}

// ─── Write ────────────────────────────────────────────────────────────────────

async function writeFile(dir: FileSystemDirectoryHandle, filename: string, blob: Blob): Promise<void> {
	const fh = await dir.getFileHandle(filename, { create: true });
	const writable = await fh.createWritable();
	await writable.write(blob);
	await writable.close();
}

export async function writePreview(frameId: string, blob: Blob): Promise<void> {
	const dir = await getDir(DIR_PREVIEWS);
	await writeFile(dir, `${frameId}.jpg`, blob);
}

export async function writeThumb(frameId: string, blob: Blob): Promise<void> {
	const dir = await getDir(DIR_THUMBS);
	await writeFile(dir, `${frameId}.jpg`, blob);
}

// ─── Read ─────────────────────────────────────────────────────────────────────

async function readFile(dir: FileSystemDirectoryHandle, filename: string): Promise<Blob | null> {
	try {
		const fh = await dir.getFileHandle(filename);
		return fh.getFile();
	} catch {
		return null;
	}
}

export async function readPreview(frameId: string): Promise<Blob | null> {
	const dir = await getDir(DIR_PREVIEWS);
	return readFile(dir, `${frameId}.jpg`);
}

export async function readThumb(frameId: string): Promise<Blob | null> {
	const dir = await getDir(DIR_THUMBS);
	return readFile(dir, `${frameId}.jpg`);
}

// ─── Delete ───────────────────────────────────────────────────────────────────

async function removeFile(dir: FileSystemDirectoryHandle, filename: string): Promise<void> {
	try {
		await dir.removeEntry(filename);
	} catch {
		// Already gone — not an error
	}
}

export async function deleteFrameCache(frameId: string): Promise<void> {
	const [previews, thumbs] = await Promise.all([getDir(DIR_PREVIEWS), getDir(DIR_THUMBS)]);
	await Promise.all([
		removeFile(previews, `${frameId}.jpg`),
		removeFile(thumbs,   `${frameId}.jpg`),
	]);
}

// ─── URL helpers ─────────────────────────────────────────────────────────────

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
