/**
 * Background full-resolution decode sweep.
 *
 * Opening a frame in the editor costs a full-resolution demosaic — seconds per
 * RAW file. The result is cached on disk by Rust (`decode_cache.rs`), so the
 * cost is only paid once per frame; this module pays it *early*, while the user
 * is still looking at the grid or editing another frame, so by the time they
 * open a frame it is already a file read.
 *
 * Shared module state, not per-component: the sweep must survive navigating
 * from the roll grid into the editor and back, and both pages must agree on
 * which frames are warm so neither redoes the other's work.
 *
 * ## Shape
 * One decode at a time, deliberately. Each decode is a multi-second,
 * multi-threaded (rayon) demosaic that already saturates the machine — running
 * several would not finish the roll faster, and would compete with the frame
 * the user is actually waiting for.
 *
 * The next frame is picked as the nearest un-warm frame to `focus` (the frame
 * on screen), walking outward, so the sweep always closes in on where the user
 * is rather than grinding through the roll in a fixed order.
 */

import { invoke } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import { isTauriEnv } from '$lib/fs/sidecar';
import { isRawExtension } from '$lib/fs/directory';

// ─── Progress state ───────────────────────────────────────────────────────────

/**
 * Plain progress snapshot, mirroring `thumbQueueProgress`. Not reactive — use
 * `onDecodeWarmProgress` and copy it into a Svelte `$state` variable.
 */
export const decodeWarmProgress = {
	/** Frames with a full-resolution decode on disk. */
	warm: 0,
	/** Frames in the current sweep. 0 when no sweep has started. */
	total: 0,
	/** True while a sweep is walking the roll. */
	running: false,
};

let _progressCallback: (() => void) | null = null;

/** Register a progress listener. Pass `null` to unsubscribe. */
export function onDecodeWarmProgress(cb: (() => void) | null): void {
	_progressCallback = cb;
}

function notifyProgress(): void {
	decodeWarmProgress.warm = warmIds.size;
	decodeWarmProgress.total = targets.length;
	decodeWarmProgress.running = running;
	_progressCallback?.();
}

// ─── Internal state ───────────────────────────────────────────────────────────

interface WarmTarget {
	id: string;
	filename: string;
}

export interface StartOptions {
	rollId: string;
	/** Absolute path of the roll directory. */
	dirPath: string;
	frames: WarmTarget[];
	/** `rollEdit.invert` — becomes `skipWb`, which changes the decoded bytes. */
	invert: boolean;
	/** Long-edge cap the editor decodes at (see `previewMaxPx`). */
	maxPx: number;
}

/**
 * Identifies the sweep: roll plus every parameter in the cache key. A start
 * request with a matching session is a no-op; a differing one supersedes the
 * sweep in flight, because its warm set no longer says anything useful.
 */
let session = '';
let targets: WarmTarget[] = [];
let warmIds = new Set<string>();
let focusId: string | null = null;
let running = false;
let generation = 0;

function sessionKey(o: StartOptions): string {
	return `${o.rollId}|${o.dirPath}|${o.maxPx}|${o.invert}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** True if this frame's full-resolution decode is already on disk. */
export function isFrameWarm(frameId: string): boolean {
	return warmIds.has(frameId);
}

/**
 * Point the sweep at a frame. The next decode it picks will be the nearest
 * un-warm neighbour of this one, so stepping through the roll pulls the sweep
 * along instead of racing it.
 *
 * Also marks the frame warm: the editor decodes whatever it displays, and that
 * decode populates the same cache entry.
 */
export function focusDecodeWarm(frameId: string, alreadyDecoded = false): void {
	focusId = frameId;
	if (alreadyDecoded && !warmIds.has(frameId)) {
		warmIds.add(frameId);
		notifyProgress();
	}
}

/** Abandon the sweep in flight. The decode already running still finishes. */
export function stopDecodeWarm(): void {
	generation++;
	running = false;
	notifyProgress();
}

/** Drop all sweep state. Call when leaving the roll entirely. */
export function resetDecodeWarm(): void {
	generation++;
	running = false;
	session = '';
	targets = [];
	warmIds = new Set();
	focusId = null;
	notifyProgress();
}

/**
 * Start (or resume) the sweep for a roll.
 *
 * Safe and cheap to call repeatedly — a call matching the sweep already in
 * flight returns immediately. Resolves when the roll is fully warm, so callers
 * that do not care should `void` it.
 */
export async function startDecodeWarm(opts: StartOptions): Promise<void> {
	if (!isTauriEnv() || opts.frames.length === 0) return;

	const key = sessionKey(opts);
	if (key === session && running) return;

	// A new session invalidates the old warm set — different params, different
	// cache entries.
	if (key !== session) {
		session = key;
		warmIds = new Set();
	}
	targets = opts.frames.slice();

	// Already fully warm.  Worth checking: the caller is a Svelte effect that
	// re-runs on any frame mutation (a rating, a flag), and without this every
	// keystroke would kick off a fresh probe round trip.
	if (warmIds.size >= targets.length) {
		notifyProgress();
		return;
	}

	const mine = ++generation;
	running = true;
	notifyProgress();

	try {
		await probeExisting(opts, mine);

		for (;;) {
			if (mine !== generation) return;
			const target = nextTarget();
			if (!target) return;

			// Marked before the decode, not after: a frame that cannot be
			// decoded must not be retried forever, and a cold frame is a slower
			// open rather than an error worth surfacing.
			warmIds.add(target.id);
			try {
				await warmOne(opts, target);
			} catch (err) {
				console.warn(`[decode-warm] ${target.filename} failed to warm:`, err);
			}
			notifyProgress();
		}
	} finally {
		if (mine === generation) {
			running = false;
			notifyProgress();
		}
	}
}

// ─── Internals ────────────────────────────────────────────────────────────────

/**
 * Ask Rust which frames are already cached, in one round trip.
 *
 * Without this the sweep would have to discover a warm frame by asking for a
 * decode of it, and a roll returned to a second time would report 0 warm frames
 * until it had walked the whole thing.
 */
async function probeExisting(opts: StartOptions, mine: number): Promise<void> {
	try {
		const items = await Promise.all(
			targets.map(async (t) => ({
				path: await join(opts.dirPath, t.filename),
				raw: isRawExtension(t.filename),
			})),
		);
		const warm = await invoke<boolean[]>('decode_cache_probe', {
			items,
			maxPx: opts.maxPx,
			skipWb: opts.invert,
		});
		if (mine !== generation) return;
		targets.forEach((t, i) => {
			if (warm[i]) warmIds.add(t.id);
		});
		notifyProgress();
	} catch (err) {
		// A failed probe only costs us the head start — the sweep still works.
		console.warn('[decode-warm] cache probe failed:', err);
	}
}

/** Nearest un-warm frame to `focusId`, walking outward from it. */
function nextTarget(): WarmTarget | null {
	if (warmIds.size >= targets.length) return null;
	const focus = focusId === null ? -1 : targets.findIndex((t) => t.id === focusId);
	// No focus yet (grid view, nothing opened): plain disk order.
	if (focus < 0) return targets.find((t) => !warmIds.has(t.id)) ?? null;

	for (let distance = 1; distance <= targets.length; distance++) {
		for (const candidate of [targets[focus + distance], targets[focus - distance]]) {
			if (candidate && !warmIds.has(candidate.id)) return candidate;
		}
	}
	return null;
}

/**
 * Decode one frame for the cache's benefit only.
 *
 * `warmOnly` makes Rust write the cache entry and return an empty response, so
 * a ~50 MB payload the caller would discard never crosses the IPC boundary.
 */
async function warmOne(opts: StartOptions, target: WarmTarget): Promise<void> {
	const absolutePath = await join(opts.dirPath, target.filename);
	if (isRawExtension(target.filename)) {
		await invoke('raw_decode', {
			path: absolutePath,
			maxPx: opts.maxPx,
			skipWb: opts.invert,
			warmOnly: true,
		});
	} else {
		await invoke('decode_image_rgba', {
			path: absolutePath,
			maxPx: opts.maxPx,
			warmOnly: true,
		});
	}
}
