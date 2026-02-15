/**
 * IndexedDB wrapper for Roloc.
 *
 * Stores:
 *   rolls   — Roll records (without directory handle)
 *   frames  — Frame records
 *   handles — { rollId, handle: FileSystemDirectoryHandle }
 */

import type { Roll, Frame } from '$lib/types';

const DB_NAME = 'roloc';
const DB_VERSION = 1;

// ─── Store names ──────────────────────────────────────────────────────────────

const STORE_ROLLS   = 'rolls';
const STORE_FRAMES  = 'frames';
const STORE_HANDLES = 'handles';

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

			if (!db.objectStoreNames.contains(STORE_HANDLES)) {
				// Key is rollId, value is { rollId, handle }
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

// ─── Directory handles ────────────────────────────────────────────────────────

export interface HandleRecord {
	rollId: string;
	handle: FileSystemDirectoryHandle;
}

export async function getHandle(rollId: string): Promise<FileSystemDirectoryHandle | undefined> {
	const db = await openDB();
	const record: HandleRecord | undefined = await request(
		tx(db, STORE_HANDLES).objectStore(STORE_HANDLES).get(rollId)
	);
	return record?.handle;
}

export async function putHandle(rollId: string, handle: FileSystemDirectoryHandle): Promise<void> {
	const db = await openDB();
	const record: HandleRecord = { rollId, handle };
	await request(tx(db, STORE_HANDLES, 'readwrite').objectStore(STORE_HANDLES).put(record));
}
