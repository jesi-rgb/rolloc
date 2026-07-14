/**
 * Self-contained-folder sidecar storage.
 *
 * When running under Tauri, all derived data for a roll (edit metadata, plus
 * generated thumbnails/previews) is written into a hidden folder inside the
 * roll's own directory:
 *
 *   <rollPath>/.rolloc-meta/meta.json          — { version, roll, frames }
 *   <rollPath>/.rolloc-meta/thumbs/{frameId}.jpg
 *   <rollPath>/.rolloc-meta/previews/{frameId}.jpg
 *
 * This makes a roll's folder a portable project: moving/copying it to another
 * drive or machine carries all edits and cached thumbnails along with it.
 * IndexedDB remains a fast local index (list of known rolls + their paths),
 * but the sidecar folder is the source of truth for edits and cached images.
 *
 * Falls back gracefully to being a no-op when not running under Tauri (e.g.
 * plain browser / Vitest "client" project) — callers should pair this with
 * `$lib/fs/opfs.ts` in that case.
 */

import { mkdir, readFile, readTextFile, remove, rename, writeFile, writeTextFile, exists } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import type { Roll, Frame } from '$lib/types';

const SIDECAR_DIR = '.rolloc-meta';
const DIR_THUMBS = 'thumbs';
const DIR_PREVIEWS = 'previews';
const META_FILE = 'meta.json';
const META_VERSION = 1;

export interface SidecarMeta {
	version: number;
	roll: Roll;
	frames: Frame[];
}

/** True when running inside a Tauri WebView (not a plain browser). */
export function isTauriEnv(): boolean {
	return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// ─── Path helpers ───────────────────────────────────────────────────────────

async function sidecarRoot(rollPath: string): Promise<string> {
	return join(rollPath, SIDECAR_DIR);
}

async function metaFilePath(rollPath: string): Promise<string> {
	return join(rollPath, SIDECAR_DIR, META_FILE);
}

async function thumbsDirPath(rollPath: string): Promise<string> {
	return join(rollPath, SIDECAR_DIR, DIR_THUMBS);
}

async function previewsDirPath(rollPath: string): Promise<string> {
	return join(rollPath, SIDECAR_DIR, DIR_PREVIEWS);
}

async function ensureDirs(rollPath: string): Promise<void> {
	const root = await sidecarRoot(rollPath);
	const thumbs = await thumbsDirPath(rollPath);
	const previews = await previewsDirPath(rollPath);
	await mkdir(root, { recursive: true });
	await mkdir(thumbs, { recursive: true });
	await mkdir(previews, { recursive: true });
}

/**
 * Returns true if `<rollPath>/.rolloc-meta/meta.json` exists.
 */
export async function hasSidecar(rollPath: string): Promise<boolean> {
	try {
		return await exists(await metaFilePath(rollPath));
	} catch {
		return false;
	}
}

// ─── Metadata read/write ────────────────────────────────────────────────────

/**
 * Reads and parses `meta.json`. Returns null if absent or unreadable/corrupt.
 */
export async function readMeta(rollPath: string): Promise<SidecarMeta | null> {
	try {
		const text = await readTextFile(await metaFilePath(rollPath));
		const parsed = JSON.parse(text) as SidecarMeta;
		if (!parsed || typeof parsed !== 'object' || !parsed.roll || !Array.isArray(parsed.frames)) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

/**
 * Writes `meta.json` immediately (atomic: writes to a temp file then renames).
 */
export async function flushMeta(rollPath: string, roll: Roll, frames: Frame[]): Promise<void> {
	await ensureDirs(rollPath);
	const finalPath = await metaFilePath(rollPath);
	const tmpPath = `${finalPath}.tmp`;
	const payload: SidecarMeta = { version: META_VERSION, roll, frames };
	await writeTextFile(tmpPath, JSON.stringify(payload, null, '\t'));
	// Atomic rename over any existing meta.json to avoid a torn/partial write
	// being read back if the process is interrupted mid-write.
	try {
		await rename(tmpPath, finalPath);
	} catch {
		await writeTextFile(finalPath, JSON.stringify(payload, null, '\t'));
		await remove(tmpPath).catch(() => undefined);
	}
}

// ─── Debounced metadata writer ──────────────────────────────────────────────

const DEBOUNCE_MS = 400;

interface PendingWrite {
	timer: ReturnType<typeof setTimeout>;
	roll: Roll;
	frames: Frame[];
}

const pendingWrites = new Map<string, PendingWrite>();

/**
 * Schedules a debounced write of `meta.json`. Multiple calls for the same
 * rollPath within DEBOUNCE_MS coalesce into a single write of the latest data.
 */
export function writeMetaDebounced(rollPath: string, roll: Roll, frames: Frame[]): void {
	const existing = pendingWrites.get(rollPath);
	if (existing) clearTimeout(existing.timer);

	const timer = setTimeout(() => {
		pendingWrites.delete(rollPath);
		void flushMeta(rollPath, roll, frames).catch((err) => {
			console.error(`[sidecar] Failed to write meta.json for ${rollPath}:`, err);
		});
	}, DEBOUNCE_MS);

	pendingWrites.set(rollPath, { timer, roll, frames });
}

/**
 * Immediately flushes any pending debounced write for rollPath, if one exists.
 * Useful before navigating away from a roll.
 */
export async function flushPendingMeta(rollPath: string): Promise<void> {
	const pending = pendingWrites.get(rollPath);
	if (!pending) return;
	clearTimeout(pending.timer);
	pendingWrites.delete(rollPath);
	await flushMeta(rollPath, pending.roll, pending.frames);
}

// ─── Thumb/preview cache ────────────────────────────────────────────────────

async function blobToBytes(blob: Blob): Promise<Uint8Array> {
	return new Uint8Array(await blob.arrayBuffer());
}

export async function writeThumb(rollPath: string, frameId: string, blob: Blob): Promise<void> {
	await ensureDirs(rollPath);
	const path = await join(await thumbsDirPath(rollPath), `${frameId}.jpg`);
	await writeFile(path, await blobToBytes(blob));
}

export async function writePreview(rollPath: string, frameId: string, blob: Blob): Promise<void> {
	await ensureDirs(rollPath);
	const path = await join(await previewsDirPath(rollPath), `${frameId}.jpg`);
	await writeFile(path, await blobToBytes(blob));
}

export async function readThumb(rollPath: string, frameId: string): Promise<Blob | null> {
	try {
		const path = await join(await thumbsDirPath(rollPath), `${frameId}.jpg`);
		const bytes = await readFile(path);
		return new Blob([bytes], { type: 'image/jpeg' });
	} catch {
		return null;
	}
}

export async function readPreview(rollPath: string, frameId: string): Promise<Blob | null> {
	try {
		const path = await join(await previewsDirPath(rollPath), `${frameId}.jpg`);
		const bytes = await readFile(path);
		return new Blob([bytes], { type: 'image/jpeg' });
	} catch {
		return null;
	}
}

export async function deleteFrameCache(rollPath: string, frameId: string): Promise<void> {
	const thumbPath = await join(await thumbsDirPath(rollPath), `${frameId}.jpg`);
	const previewPath = await join(await previewsDirPath(rollPath), `${frameId}.jpg`);
	await Promise.all([
		remove(thumbPath).catch(() => undefined),
		remove(previewPath).catch(() => undefined),
	]);
}

export async function thumbURL(rollPath: string, frameId: string): Promise<string | null> {
	const blob = await readThumb(rollPath, frameId);
	return blob ? URL.createObjectURL(blob) : null;
}

export async function previewURL(rollPath: string, frameId: string): Promise<string | null> {
	const blob = await readPreview(rollPath, frameId);
	return blob ? URL.createObjectURL(blob) : null;
}

// ─── Full purge (explicit, deliberate action only) ──────────────────────────

/**
 * Permanently deletes the entire `.rolloc-meta` folder for a roll, including
 * meta.json and all cached thumbnails/previews. This does NOT touch the
 * original image files. Only call this from an explicit, deliberate user
 * action — never as part of "remove roll from UI".
 */
export async function purgeSidecar(rollPath: string): Promise<void> {
	const pending = pendingWrites.get(rollPath);
	if (pending) {
		clearTimeout(pending.timer);
		pendingWrites.delete(rollPath);
	}
	const root = await sidecarRoot(rollPath);
	await remove(root, { recursive: true }).catch(() => undefined);
}
