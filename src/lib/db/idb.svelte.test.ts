/**
 * IndexedDB layer tests.
 *
 * These run in the "client" Vitest project (real Chromium via Playwright)
 * because they depend on the native `indexedDB` browser API.
 *
 * Each `describe` block deletes and recreates the database to ensure full
 * isolation. `closeDB()` resets the module-level singleton so `openDB()`
 * will re-initialise on the next call.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	openDB,
	closeDB,
	getRolls,
	getRoll,
	putRoll,
	deleteRoll,
	getFrames,
	getFrame,
	putFrame,
	putFrames,
	deleteFrame,
	getPath,
	putPath,
} from './idb';
import type { Roll, Frame } from '$lib/types';
import { DEFAULT_ROLL_EDIT, DEFAULT_FRAME_EDIT } from '$lib/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRoll(overrides: Partial<Roll> = {}): Roll {
	return {
		id: 'roll-1',
		createdAt: 1_000_000,
		label: 'Test Roll',
		filmStock: 'Portra 400',
		camera: 'Nikon FM2',
		notes: '',
		rollEdit: { ...DEFAULT_ROLL_EDIT },
		...overrides,
	};
}

function makeFrame(overrides: Partial<Frame> = {}): Frame {
	return {
		id: 'frame-1',
		rollId: 'roll-1',
		filename: 'DSC_0001.jpg',
		index: 1,
		rating: 0,
		flags: [],
		notes: '',
		capturedAt: null,
		frameEdit: { ...DEFAULT_FRAME_EDIT },
		...overrides,
	};
}

async function wipeDB(): Promise<void> {
	closeDB();
	await new Promise<void>((resolve, reject) => {
		const req = indexedDB.deleteDatabase('rolloc');
		req.onsuccess = () => resolve();
		req.onerror = () => reject(req.error);
		// onblocked fires when another connection is open; closeDB() above prevents this.
		req.onblocked = () => reject(new Error('deleteDatabase blocked'));
	});
}

// ─── openDB ───────────────────────────────────────────────────────────────────

describe('openDB', () => {
	beforeEach(wipeDB);
	afterEach(wipeDB);

	it('opens and returns an IDBDatabase instance', async () => {
		const db = await openDB();
		expect(db).toBeInstanceOf(IDBDatabase);
	});

	it('returns the same cached instance on subsequent calls', async () => {
		const a = await openDB();
		const b = await openDB();
		expect(a).toBe(b);
	});

	it('creates the expected object stores', async () => {
		const db = await openDB();
		const names = Array.from(db.objectStoreNames);
		expect(names).toContain('rolls');
		expect(names).toContain('frames');
		expect(names).toContain('handles');
	});
});

// ─── Rolls CRUD ───────────────────────────────────────────────────────────────

describe('rolls', () => {
	beforeEach(wipeDB);
	afterEach(wipeDB);

	it('getRolls returns empty array when no rolls exist', async () => {
		const rolls = await getRolls();
		expect(rolls).toEqual([]);
	});

	it('putRoll stores a roll and getRoll retrieves it', async () => {
		const roll = makeRoll();
		await putRoll(roll);
		const fetched = await getRoll('roll-1');
		expect(fetched).toEqual(roll);
	});

	it('getRoll returns undefined for a missing id', async () => {
		const result = await getRoll('does-not-exist');
		expect(result).toBeUndefined();
	});

	it('getRolls returns all stored rolls', async () => {
		const r1 = makeRoll({ id: 'roll-1', label: 'A' });
		const r2 = makeRoll({ id: 'roll-2', label: 'B' });
		await putRoll(r1);
		await putRoll(r2);
		const rolls = await getRolls();
		expect(rolls).toHaveLength(2);
		const ids = rolls.map((r) => r.id);
		expect(ids).toContain('roll-1');
		expect(ids).toContain('roll-2');
	});

	it('putRoll overwrites an existing roll (upsert)', async () => {
		const roll = makeRoll({ label: 'Original' });
		await putRoll(roll);
		await putRoll({ ...roll, label: 'Updated' });
		const fetched = await getRoll('roll-1');
		expect(fetched?.label).toBe('Updated');
	});

	it('deleteRoll removes the roll record', async () => {
		await putRoll(makeRoll());
		await deleteRoll('roll-1');
		const fetched = await getRoll('roll-1');
		expect(fetched).toBeUndefined();
	});

	it('deleteRoll also removes frames belonging to the roll', async () => {
		await putRoll(makeRoll());
		await putFrames([
			makeFrame({ id: 'f-1', rollId: 'roll-1', index: 1 }),
			makeFrame({ id: 'f-2', rollId: 'roll-1', index: 2 }),
		]);
		await deleteRoll('roll-1');
		const frames = await getFrames('roll-1');
		expect(frames).toEqual([]);
	});

	it('deleteRoll removes the path record', async () => {
		await putRoll(makeRoll());
		// Store a mock path value
		await putPath('roll-1', '/fake/path/to/roll');
		await deleteRoll('roll-1');
		const path = await getPath('roll-1');
		expect(path).toBeUndefined();
	});

	it('deleteRoll on a non-existent id does not throw', async () => {
		await expect(deleteRoll('ghost')).resolves.toBeUndefined();
	});
});

// ─── Frames CRUD ──────────────────────────────────────────────────────────────

describe('frames', () => {
	beforeEach(wipeDB);
	afterEach(wipeDB);

	it('getFrames returns empty array when no frames exist for a roll', async () => {
		const frames = await getFrames('roll-1');
		expect(frames).toEqual([]);
	});

	it('putFrame stores a frame and getFrame retrieves it', async () => {
		const frame = makeFrame();
		await putFrame(frame);
		const fetched = await getFrame('frame-1');
		expect(fetched).toEqual(frame);
	});

	it('getFrame returns undefined for a missing id', async () => {
		const result = await getFrame('ghost');
		expect(result).toBeUndefined();
	});

	it('getFrames returns only frames belonging to the requested roll', async () => {
		await putFrame(makeFrame({ id: 'f-1', rollId: 'roll-1', index: 1 }));
		await putFrame(makeFrame({ id: 'f-2', rollId: 'roll-2', index: 1 }));
		await putFrame(makeFrame({ id: 'f-3', rollId: 'roll-1', index: 2 }));

		const roll1Frames = await getFrames('roll-1');
		expect(roll1Frames).toHaveLength(2);
		expect(roll1Frames.map((f) => f.id)).toContain('f-1');
		expect(roll1Frames.map((f) => f.id)).toContain('f-3');
	});

	it('getFrames returns frames sorted by index ascending', async () => {
		await putFrames([
			makeFrame({ id: 'f-3', rollId: 'roll-1', index: 3 }),
			makeFrame({ id: 'f-1', rollId: 'roll-1', index: 1 }),
			makeFrame({ id: 'f-2', rollId: 'roll-1', index: 2 }),
		]);
		const frames = await getFrames('roll-1');
		expect(frames.map((f) => f.index)).toEqual([1, 2, 3]);
	});

	it('putFrames stores multiple frames atomically', async () => {
		const batch = [
			makeFrame({ id: 'f-1', rollId: 'roll-1', index: 1 }),
			makeFrame({ id: 'f-2', rollId: 'roll-1', index: 2 }),
			makeFrame({ id: 'f-3', rollId: 'roll-1', index: 3 }),
		];
		await putFrames(batch);
		const frames = await getFrames('roll-1');
		expect(frames).toHaveLength(3);
	});

	it('putFrame overwrites an existing frame (upsert)', async () => {
		const frame = makeFrame({ rating: 0 });
		await putFrame(frame);
		await putFrame({ ...frame, rating: 5 });
		const fetched = await getFrame('frame-1');
		expect(fetched?.rating).toBe(5);
	});

	it('deleteFrame removes a single frame', async () => {
		await putFrames([
			makeFrame({ id: 'f-1', index: 1 }),
			makeFrame({ id: 'f-2', index: 2 }),
		]);
		await deleteFrame('f-1');
		expect(await getFrame('f-1')).toBeUndefined();
		expect(await getFrame('f-2')).toBeDefined();
	});
});

// ─── Paths ───────────────────────────────────────────────────────────────────

describe('paths', () => {
	beforeEach(wipeDB);
	afterEach(wipeDB);

	it('getPath returns undefined when no path is stored', async () => {
		const result = await getPath('roll-1');
		expect(result).toBeUndefined();
	});

	it('putPath stores a path and getPath retrieves it', async () => {
		const testPath = '/Users/test/photos';
		await putPath('roll-1', testPath);
		const retrieved = await getPath('roll-1');
		expect(retrieved).toEqual(testPath);
	});

	it('putPath overwrites an existing path (upsert)', async () => {
		const oldPath = '/Users/test/old';
		const newPath = '/Users/test/new';
		await putPath('roll-1', oldPath);
		await putPath('roll-1', newPath);
		const retrieved = await getPath('roll-1');
		expect(retrieved).toBe(newPath);
	});

	it('getPath is keyed per rollId — separate rolls have separate paths', async () => {
		const path1 = '/Users/test/roll-one';
		const path2 = '/Users/test/roll-two';
		await putPath('roll-1', path1);
		await putPath('roll-2', path2);
		const r1 = await getPath('roll-1');
		const r2 = await getPath('roll-2');
		expect(r1).toBe(path1);
		expect(r2).toBe(path2);
	});
});
