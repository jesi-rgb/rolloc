/**
 * IndexedDB wrapper for Roloc.
 *
 * Stores:
 *   rolls     — Roll records (without directory path)
 *   frames    — Frame records
 *   libraries — Library records (without directory path)
 *   images    — LibraryImage records
 *   handles   — { rollId/libraryId, path: string } (absolute filesystem paths)
 */

import type { Roll, Frame, Library, LibraryImage } from '$lib/types';

const DB_NAME = 'roloc';
const DB_VERSION = 3;

// ─── Store names ──────────────────────────────────────────────────────────────

const STORE_ROLLS     = 'rolls';
const STORE_FRAMES    = 'frames';
const STORE_LIBRARIES = 'libraries';
const STORE_IMAGES    = 'images';
const STORE_HANDLES   = 'handles';

// ─── Open ─────────────────────────────────────────────────────────────────────

let _db: IDBDatabase | null = null;

/** Close and reset the cached connection. Intended for use in tests only. */
export function closeDB(): void {
	_db?.close();
	_db = null;
}

export function openDB(): Promise<IDBDatabase> {
	if (_db) return Promise.resolve(_db);

	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);

	req.onupgradeneeded = (event) => {
		const db = (event.target as IDBOpenDBRequest).result;

		if (!db.objectStoreNames.contains(STORE_ROLLS)) {
			db.createObjectStore(STORE_ROLLS, { keyPath: 'id' });
		}

		if (!db.objectStoreNames.contains(STORE_FRAMES)) {
			const frameStore = db.createObjectStore(STORE_FRAMES, { keyPath: 'id' });
			frameStore.createIndex('rollId', 'rollId', { unique: false });
		}

		if (!db.objectStoreNames.contains(STORE_LIBRARIES)) {
			db.createObjectStore(STORE_LIBRARIES, { keyPath: 'id' });
		}

		if (!db.objectStoreNames.contains(STORE_IMAGES)) {
			const imageStore = db.createObjectStore(STORE_IMAGES, { keyPath: 'id' });
			imageStore.createIndex('libraryId', 'libraryId', { unique: false });
		}

		if (!db.objectStoreNames.contains(STORE_HANDLES)) {
			// Key is rollId or libraryId, value is { rollId/libraryId, handle }
			db.createObjectStore(STORE_HANDLES, { keyPath: 'rollId' });
		}
	};

		req.onsuccess = (event) => {
			_db = (event.target as IDBOpenDBRequest).result;
			resolve(_db);
		};

		req.onerror = () => reject(req.error);
	});
}

// ─── Generic helpers ──────────────────────────────────────────────────────────

function tx(
	db: IDBDatabase,
	stores: string | string[],
	mode: IDBTransactionMode = 'readonly'
): IDBTransaction {
	return db.transaction(stores, mode);
}

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror  = () => reject(req.error);
	});
}

function cursorAll<T>(store: IDBObjectStore | IDBIndex): Promise<T[]> {
	return new Promise((resolve, reject) => {
		const results: T[] = [];
		const req = store.openCursor();
		req.onsuccess = () => {
			const cursor = req.result;
			if (cursor) {
				results.push(cursor.value as T);
				cursor.continue();
			} else {
				resolve(results);
			}
		};
		req.onerror = () => reject(req.error);
	});
}

// ─── Rolls ────────────────────────────────────────────────────────────────────

export async function getRolls(): Promise<Roll[]> {
	const db = await openDB();
	return cursorAll<Roll>(tx(db, STORE_ROLLS).objectStore(STORE_ROLLS));
}

export async function getRoll(id: string): Promise<Roll | undefined> {
	const db = await openDB();
	return request(tx(db, STORE_ROLLS).objectStore(STORE_ROLLS).get(id));
}

export async function putRoll(roll: Roll): Promise<void> {
	const db = await openDB();
	await request(tx(db, STORE_ROLLS, 'readwrite').objectStore(STORE_ROLLS).put(roll));
}

export async function deleteRoll(id: string): Promise<void> {
	const db = await openDB();
	const t = tx(db, [STORE_ROLLS, STORE_FRAMES, STORE_HANDLES], 'readwrite');
	// Delete roll
	t.objectStore(STORE_ROLLS).delete(id);
	// Delete its handle
	t.objectStore(STORE_HANDLES).delete(id);
	// Delete all frames belonging to this roll
	const frameIdx = t.objectStore(STORE_FRAMES).index('rollId');
	const frameReq = frameIdx.openCursor(IDBKeyRange.only(id));
	await new Promise<void>((resolve, reject) => {
		frameReq.onsuccess = () => {
			const cursor = frameReq.result;
			if (cursor) {
				cursor.delete();
				cursor.continue();
			} else {
				resolve();
			}
		};
		frameReq.onerror = () => reject(frameReq.error);
	});
}

// ─── Frames ───────────────────────────────────────────────────────────────────

export async function getFrames(rollId: string): Promise<Frame[]> {
	const frames = await getFramesByRoll(rollId);
	return frames.sort((a, b) => a.index - b.index);
}

async function getFramesByRoll(rollId: string): Promise<Frame[]> {
	const db = await openDB();
	return new Promise((resolve, reject) => {
		const results: Frame[] = [];
		const t = tx(db, STORE_FRAMES);
		const index = t.objectStore(STORE_FRAMES).index('rollId');
		const req = index.openCursor(IDBKeyRange.only(rollId));
		req.onsuccess = () => {
			const cursor = req.result;
			if (cursor) {
				results.push(cursor.value);
				cursor.continue();
			} else {
				resolve(results);
			}
		};
		req.onerror = () => reject(req.error);
	});
}

export async function getFrame(id: string): Promise<Frame | undefined> {
	const db = await openDB();
	return request(tx(db, STORE_FRAMES).objectStore(STORE_FRAMES).get(id));
}

export async function putFrame(frame: Frame): Promise<void> {
	const db = await openDB();
	await request(tx(db, STORE_FRAMES, 'readwrite').objectStore(STORE_FRAMES).put(frame));
}

export async function putFrames(frames: Frame[]): Promise<void> {
	const db = await openDB();
	const store = tx(db, STORE_FRAMES, 'readwrite').objectStore(STORE_FRAMES);
	await Promise.all(frames.map((f) => request(store.put(f))));
}

export async function deleteFrame(id: string): Promise<void> {
	const db = await openDB();
	await request(tx(db, STORE_FRAMES, 'readwrite').objectStore(STORE_FRAMES).delete(id));
}

// ─── Directory paths ──────────────────────────────────────────────────────────

export interface PathRecord {
	rollId: string;
	path: string;  // Absolute filesystem path
}

export async function getPath(rollId: string): Promise<string | undefined> {
	const db = await openDB();
	const record: PathRecord | undefined = await request(
		tx(db, STORE_HANDLES).objectStore(STORE_HANDLES).get(rollId)
	);
	return record?.path;
}

export async function putPath(rollId: string, path: string): Promise<void> {
	const db = await openDB();
	const record: PathRecord = { rollId, path };
	await request(tx(db, STORE_HANDLES, 'readwrite').objectStore(STORE_HANDLES).put(record));
}

// ─── Libraries ────────────────────────────────────────────────────────────────

export async function getLibraries(): Promise<Library[]> {
	const db = await openDB();
	return cursorAll<Library>(tx(db, STORE_LIBRARIES).objectStore(STORE_LIBRARIES));
}

export async function getLibrary(id: string): Promise<Library | undefined> {
	const db = await openDB();
	return request(tx(db, STORE_LIBRARIES).objectStore(STORE_LIBRARIES).get(id));
}

export async function putLibrary(library: Library): Promise<void> {
	const db = await openDB();
	await request(tx(db, STORE_LIBRARIES, 'readwrite').objectStore(STORE_LIBRARIES).put(library));
}

export async function deleteLibrary(id: string): Promise<void> {
	const db = await openDB();
	const t = tx(db, [STORE_LIBRARIES, STORE_IMAGES, STORE_HANDLES], 'readwrite');
	// Delete library
	t.objectStore(STORE_LIBRARIES).delete(id);
	// Delete its handle
	t.objectStore(STORE_HANDLES).delete(id);
	// Delete all images belonging to this library
	const imageIdx = t.objectStore(STORE_IMAGES).index('libraryId');
	const imageReq = imageIdx.openCursor(IDBKeyRange.only(id));
	await new Promise<void>((resolve, reject) => {
		imageReq.onsuccess = () => {
			const cursor = imageReq.result;
			if (cursor) {
				cursor.delete();
				cursor.continue();
			} else {
				resolve();
			}
		};
		imageReq.onerror = () => reject(imageReq.error);
	});
}

// ─── Library Images ───────────────────────────────────────────────────────────

export async function getImages(libraryId: string): Promise<LibraryImage[]> {
	const images = await getImagesByLibrary(libraryId);
	// Migration: add createdAt to existing images that don't have it
	const now = Date.now();
	const needsMigration: LibraryImage[] = [];
	const migratedImages = images.map((img, idx) => {
		if (!img.createdAt) {
			// Use index to give each image a unique timestamp
			const migrated = { ...img, createdAt: now + idx } as LibraryImage;
			needsMigration.push(migrated);
			return migrated;
		}
		return img;
	});

	// Persist migrated images back to the database
	if (needsMigration.length > 0) {
		await putImages(needsMigration);
	}

	return migratedImages.sort((a, b) => a.index - b.index);
}

async function getImagesByLibrary(libraryId: string): Promise<LibraryImage[]> {
	const db = await openDB();
	return new Promise((resolve, reject) => {
		const results: LibraryImage[] = [];
		const t = tx(db, STORE_IMAGES);
		const index = t.objectStore(STORE_IMAGES).index('libraryId');
		const req = index.openCursor(IDBKeyRange.only(libraryId));
		req.onsuccess = () => {
			const cursor = req.result;
			if (cursor) {
				results.push(cursor.value);
				cursor.continue();
			} else {
				resolve(results);
			}
		};
		req.onerror = () => reject(req.error);
	});
}

export async function getImage(id: string): Promise<LibraryImage | undefined> {
	const db = await openDB();
	return request(tx(db, STORE_IMAGES).objectStore(STORE_IMAGES).get(id));
}

export async function putImage(image: LibraryImage): Promise<void> {
	const db = await openDB();
	await request(tx(db, STORE_IMAGES, 'readwrite').objectStore(STORE_IMAGES).put(image));
}

export async function putImages(images: LibraryImage[]): Promise<void> {
	const db = await openDB();
	const store = tx(db, STORE_IMAGES, 'readwrite').objectStore(STORE_IMAGES);
	await Promise.all(images.map((img) => request(store.put(img))));
}

export async function deleteImage(id: string): Promise<void> {
	const db = await openDB();
	await request(tx(db, STORE_IMAGES, 'readwrite').objectStore(STORE_IMAGES).delete(id));
}
