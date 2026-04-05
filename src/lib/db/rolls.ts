/**
 * High-level Roll operations.
 * Combines IndexedDB persistence with Tauri filesystem API.
 */

import { nanoid } from '$lib/utils/id';
import {
	putRoll,
	getRolls,
	getRoll,
	deleteRoll as idbDeleteRoll,
	putPath,
	getPath,
} from './idb';
import { listImageFiles, verifyPermission } from '$lib/fs/directory';
import { putFrames } from './idb';
import type { Roll, Frame, FilmType } from '$lib/types';
import { DEFAULT_FRAME_EDIT, DEFAULT_ROLL_EDIT, DEFAULT_INVERSION_PARAMS } from '$lib/types';

// ─── Create ───────────────────────────────────────────────────────────────────

export interface CreateRollOptions {
	label: string;
	filmStock?: string;
	camera?: string;
	notes?: string;
	path: string;  // Absolute directory path
	/**
	 * Film type to apply to all frames. When undefined (or 'mixed' from the UI),
	 * frames use the default (C41) and the user can adjust individually.
	 */
	filmType?: FilmType;
}

/**
 * Creates a new Roll from a directory path.
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
	const files = await listImageFiles(opts.path);

	// When a specific film type is selected (not 'mixed'), pre-populate each
	// frame's inversionParams so the user doesn't have to set it manually.
	const frameInversionParams = opts.filmType
		? { ...DEFAULT_INVERSION_PARAMS, filmType: opts.filmType }
		: null;

	const frames: Frame[] = files.map((f, i) => ({
		id: nanoid(),
		rollId,
		filename: f.relativePath,
		index: i + 1,
		rating: 0,
		flags: [],
		notes: '',
		capturedAt: null,
		frameEdit: {
			...DEFAULT_FRAME_EDIT,
			inversionParams: frameInversionParams,
		},
	}));

	// Persist
	await putRoll(roll);
	await putPath(rollId, opts.path);
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

// ─── Path access ──────────────────────────────────────────────────────────────

/**
 * Returns the directory path for a roll.
 * In Tauri, no permission verification is needed — paths are persistent.
 */
export async function getRollPath(rollId: string): Promise<string | null> {
	const path = await getPath(rollId);
	return path ?? null;
}
