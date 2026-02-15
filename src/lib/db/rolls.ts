/**
 * High-level Roll operations.
 * Combines IndexedDB persistence with File System Access API.
 */

import { nanoid } from '$lib/utils/id';
import {
	putRoll,
	getRolls,
	getRoll,
	deleteRoll as idbDeleteRoll,
	putHandle,
	getHandle,
} from './idb';
import { listImageFiles, verifyPermission } from '$lib/fs/directory';
import { putFrames } from './idb';
import type { Roll, Frame } from '$lib/types';
import { DEFAULT_FRAME_EDIT, DEFAULT_ROLL_EDIT } from '$lib/types';

// ─── Create ───────────────────────────────────────────────────────────────────

export interface CreateRollOptions {
	label: string;
	filmStock?: string;
	camera?: string;
	notes?: string;
	handle: FileSystemDirectoryHandle;
}

/**
 * Creates a new Roll from a directory handle.
 * Enumerates image files and creates a Frame record for each.
 * Returns the created Roll.
 */
export async function createRoll(opts: CreateRollOptions): Promise<Roll> {
	const rollId = nanoid();

	const roll: Roll = {
		id: rollId,
		createdAt: Date.now(),
		label: opts.label,
		filmStock: opts.filmStock ?? '',
		camera: opts.camera ?? '',
		notes: opts.notes ?? '',
		rollEdit: { ...DEFAULT_ROLL_EDIT },
	};

	// Discover image files in the directory
	const files = await listImageFiles(opts.handle);

	const frames: Frame[] = files.map((f, i) => ({
		id: nanoid(),
		rollId,
		filename: f.relativePath,
		index: i + 1,
		rating: 0,
		flags: [],
		notes: '',
		capturedAt: null,
		frameEdit: { ...DEFAULT_FRAME_EDIT },
	}));

	// Persist
	await putRoll(roll);
	await putHandle(rollId, opts.handle);
	if (frames.length) await putFrames(frames);

	return roll;
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export { getRolls, getRoll };

// ─── Update ───────────────────────────────────────────────────────────────────

export async function updateRoll(roll: Roll): Promise<void> {
	await putRoll(roll);
}

// ─── Delete ───────────────────────────────────────────────────────────────────

export async function deleteRoll(id: string): Promise<void> {
	await idbDeleteRoll(id);
}

// ─── Handle permission ────────────────────────────────────────────────────────

/**
 * Returns the directory handle for a roll, verifying (and optionally
 * re-requesting) permission. Returns null if permission is not available.
 */
export async function getRollHandle(
	rollId: string,
	{ request = false }: { request?: boolean } = {}
): Promise<FileSystemDirectoryHandle | null> {
	const handle = await getHandle(rollId);
	if (!handle) return null;

	const ok = await verifyPermission(handle, { request });
	return ok ? handle : null;
}
