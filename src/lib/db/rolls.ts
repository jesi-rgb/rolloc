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
	getFrames,
	putFrame as idbPutFrame,
	putFrames as idbPutFrames,
	deleteFrame as idbDeleteFrame,
} from './idb';
import { listImageFiles, verifyPermission, isIgnoredPath } from '$lib/fs/directory';
import type { Roll, Frame, FilmType } from '$lib/types';
import { DEFAULT_FRAME_EDIT, DEFAULT_ROLL_EDIT, DEFAULT_INVERSION_PARAMS } from '$lib/types';
import {
	hasSidecar,
	readMeta,
	flushMeta,
	writeMetaDebounced,
	isTauriEnv,
	purgeSidecar,
	type SidecarMeta,
} from '$lib/fs/sidecar';

// ─── Create ───────────────────────────────────────────────────────────────────

export interface CreateRollOptions {
	label: string;
	filmStock?: string;
	/** Nominal box speed in ISO/ASA. 0 = unset. */
	iso?: number;
	camera?: string;
	/** Lens used for this roll (freeform). */
	lens?: string;
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
		iso: opts.iso ?? 0,
		camera: opts.camera ?? '',
		lens: opts.lens ?? '',
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
	if (frames.length) await idbPutFrames(frames);

	// Write the sidecar folder immediately so the roll's directory becomes a
	// self-contained project from the moment it's created (see fs/sidecar.ts).
	if (isTauriEnv()) {
		await flushMeta(opts.path, roll, frames).catch((err) => {
			console.error(`[rolls] Failed to write initial sidecar for ${opts.path}:`, err);
		});
	}

	return roll;
}

// ─── Restore from sidecar ───────────────────────────────────────────────────

/**
 * Checks whether `path` already contains a `.rolloc-meta/meta.json` sidecar
 * from a previous import (e.g. the folder was moved from another machine/drive).
 * Returns the parsed sidecar contents, or null if none is found (or not
 * running under Tauri).
 */
export async function checkForSidecar(path: string): Promise<SidecarMeta | null> {
	if (!isTauriEnv()) return null;
	if (!(await hasSidecar(path))) return null;
	return readMeta(path);
}

/**
 * Restores a roll from a previously-found sidecar (`checkForSidecar`).
 *
 * Reuses the original roll/frame ids from the sidecar so the roll is
 * recognized as the same project on reopen. Reconciles the sidecar's frame
 * list against a fresh directory scan:
 *   - frames whose `filename` points inside an ignored directory (`exports/`,
 *     `.rolloc-meta/`) are dropped and their IDB records deleted — these are
 *     stale entries from before directory scanning excluded generated data
 *     (see `isIgnoredPath`), never legitimate source frames
 *   - files present on disk but not in the sidecar are appended as new frames
 *   - remaining frames in the sidecar whose file is no longer on disk are
 *     kept but flagged 'missing' rather than silently dropped
 *
 * Writes the reconciled roll+frames back into IndexedDB (the local index)
 * and refreshes the sidecar's `meta.json` to reflect the reconciliation.
 */
export async function restoreRoll(meta: SidecarMeta, path: string): Promise<Roll> {
	// De-proxy: callers may pass a Svelte 5 `$state` proxy (e.g. from the new
	// roll dialog). IndexedDB `.put()` structured-clones its argument and throws
	// a DataCloneError ("The object can not be cloned." on WKWebView) when given
	// a reactive proxy. A JSON round-trip is lossless here because SidecarMeta is
	// pure JSON, and yields plain, cloneable objects.
	meta = JSON.parse(JSON.stringify(meta)) as SidecarMeta;

	// Drop stale frames that point into `exports/` or `.rolloc-meta/` — these
	// were only ever created by an older version of the scanner and are
	// never legitimate source frames. Purge their IDB records too so they
	// don't linger after being dropped from the reconciled list below.
	const staleFrames = meta.frames.filter((f) => isIgnoredPath(f.filename));
	const cleanFrames = meta.frames.filter((f) => !isIgnoredPath(f.filename));
	if (staleFrames.length) {
		await Promise.all(staleFrames.map((f) => idbDeleteFrame(f.id)));
	}

	const files = await listImageFiles(path);
	const byRelPath = new Map(files.map((f) => [f.relativePath, f]));

	const existingByFilename = new Map(cleanFrames.map((f) => [f.filename, f]));

	// Keep existing frames (in their original order/index), flagging any whose
	// backing file is no longer present on disk.
	const reconciled: Frame[] = cleanFrames.map((f) => {
		const stillExists = byRelPath.has(f.filename);
		const hasMissingFlag = f.flags.includes('missing');
		if (stillExists === !hasMissingFlag) return f;
		return {
			...f,
			flags: stillExists
				? f.flags.filter((fl) => fl !== 'missing')
				: [...f.flags, 'missing'],
		};
	});

	// Append any new files found on disk that aren't in the sidecar yet.
	let nextIndex = reconciled.reduce((max, f) => Math.max(max, f.index), 0) + 1;
	for (const file of files) {
		if (existingByFilename.has(file.relativePath)) continue;
		reconciled.push({
			id: nanoid(),
			rollId: meta.roll.id,
			filename: file.relativePath,
			index: nextIndex++,
			rating: 0,
			flags: [],
			notes: '',
			capturedAt: null,
			frameEdit: { ...DEFAULT_FRAME_EDIT },
		});
	}

	await putRoll(meta.roll);
	await putPath(meta.roll.id, path);
	if (reconciled.length) await idbPutFrames(reconciled);

	await flushMeta(path, meta.roll, reconciled).catch((err) => {
		console.error(`[rolls] Failed to write reconciled sidecar for ${path}:`, err);
	});

	return meta.roll;
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export { getRolls, getRoll };

// ─── Update ───────────────────────────────────────────────────────────────────

/**
 * Persists a roll's updated metadata/edit params. Also mirrors the change
 * into the roll's sidecar `meta.json` (debounced) when the roll's directory
 * is known and we're running under Tauri.
 */
export async function updateRoll(roll: Roll): Promise<void> {
	await putRoll(roll);
	await syncSidecarFrames(roll.id, roll);
}

/**
 * Persists a single frame's edits, then mirrors roll+frames into the
 * sidecar `meta.json` (debounced). Drop-in replacement for `idb.ts`'s
 * `putFrame` for any UI code editing frames within a roll.
 */
export async function putFrame(frame: Frame): Promise<void> {
	await idbPutFrame(frame);
	await syncSidecarFrames(frame.rollId);
}

/**
 * Persists multiple frames' edits, then mirrors roll+frames into the
 * sidecar `meta.json` (debounced). Assumes all frames belong to the same roll.
 */
export async function putFrames(frames: Frame[]): Promise<void> {
	await idbPutFrames(frames);
	const rollId = frames[0]?.rollId;
	if (rollId) await syncSidecarFrames(rollId);
}

/**
 * Schedules a debounced write of the roll's sidecar `meta.json` reflecting
 * the current IDB state. Pass `roll` to avoid a redundant `getRoll` lookup
 * when the caller already has it in hand (e.g. `updateRoll`).
 */
export async function syncSidecarFrames(rollId: string, roll?: Roll): Promise<void> {
	if (!isTauriEnv()) return;
	const path = await getPath(rollId);
	if (!path) return;
	const rollRecord = roll ?? (await getRoll(rollId));
	if (!rollRecord) return;
	const frames = await getFrames(rollId);
	writeMetaDebounced(path, rollRecord, frames);
}

// ─── Delete ───────────────────────────────────────────────────────────────────

/**
 * Removes a roll from the local UI/index only. Originals on disk are never
 * touched, and the roll's `.rolloc-meta` sidecar folder (edits + cached
 * thumbnails) is intentionally left in place — re-importing the same folder
 * later will restore everything via `checkForSidecar`/`restoreRoll`.
 *
 * To permanently delete the sidecar data too, use `purgeRollFolderData`.
 */
export async function deleteRoll(id: string): Promise<void> {
	await idbDeleteRoll(id);
}

/**
 * Permanently deletes a roll's `.rolloc-meta` sidecar folder (meta.json +
 * cached thumbnails/previews) from disk. Does NOT touch the original image
 * files. This is a separate, deliberate action from `deleteRoll` — call it
 * only when the user explicitly asks to purge cached data for a folder.
 */
export async function purgeRollFolderData(rollId: string): Promise<void> {
	const path = await getPath(rollId);
	if (!path) return;
	await purgeSidecar(path);
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
