/**
 * Thumbnail request queue with priority, concurrency control, and deduplication.
 *
 * Sits between the UI (IntersectionObserver in LibraryImageThumb / FrameThumb)
 * and the thumbnail generation pipeline (thumbgen + OPFS).
 *
 * Resolution order for each request:
 *   1. Module-level LRU cache (thumbCache) — synchronous, no async
 *   2. OPFS thumb file — fast read, no re-generation
 *   3. Generate from source — slow path, writes to OPFS + cache
 *      a. Native Tauri command (absolutePath) — Rust decode+resize, fastest
 *      b. JS worker pool (File blob) — fallback for browser context
 *
 * Priority:
 *   "high"  — viewport-visible items; processed before low-priority items
 *   "low"   — background pre-fetch items
 *
 * Progress tracking:
 *   thumbQueueProgress is a reactive counter object suitable for binding in Svelte.
 */

import { thumbCache } from './thumb-cache';
import { thumbURL } from '$lib/fs/opfs';
import { getThumbURL } from './thumbgen';
import { join } from '@tauri-apps/api/path';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ThumbPriority = 'high' | 'low';

interface QueueEntry {
	imageId: string;
	/** Absolute path to the source file (preferred — no file bytes in JS heap). */
	absolutePath: string;
	priority: ThumbPriority;
	resolve: (url: string) => void;
	reject: (err: unknown) => void;
}

// ─── Progress state ───────────────────────────────────────────────────────────

/**
 * Plain progress snapshot. Not reactive — use `onThumbProgress` to receive
 * notifications, then read these values in a Svelte `$state` variable.
 */
export const thumbQueueProgress = {
	cached:     0,
	generating: 0,
	total:      0,
};

/** Callback invoked after every progress counter mutation. */
let _progressCallback: (() => void) | null = null;

/**
 * Register a listener that is called after every progress update.
 * Pass `null` to unsubscribe.
 */
export function onThumbProgress(cb: (() => void) | null): void {
	_progressCallback = cb;
}

/** Notify the registered listener (if any). */
function notifyProgress(): void {
	_progressCallback?.();
}

// ─── Internal state ───────────────────────────────────────────────────────────

const CONCURRENCY = 6;

/** Pending work; high-priority items are dequeued first. */
const queue: QueueEntry[] = [];

/** In-flight deduplification: imageId → shared promise. */
const inflight = new Map<string, Promise<string>>();

/** Number of workers currently running. */
let activeWorkers = 0;

/**
 * Set of imageIds whose `total` contribution has already been accounted for by
 * `initThumbQueueForLibrary`.  When non-empty, `requestThumb` skips incrementing
 * `total` for IDs in this set (they were pre-counted by the library init).
 * Cleared by `resetThumbQueueProgress`.
 */
const _initialisedIds = new Set<string>();

/**
 * Set of imageIds already counted as `cached` (by either `initThumbQueueForLibrary`
 * or `processEntry`).  Prevents double-counting when both paths race for the same ID.
 * Cleared by `resetThumbQueueProgress`.
 */
const _countedAsCached = new Set<string>();

// ─── Queue processing ─────────────────────────────────────────────────────────

function dequeueNext(): QueueEntry | undefined {
	// High-priority first
	const highIdx = queue.findIndex((e) => e.priority === 'high');
	if (highIdx >= 0) return queue.splice(highIdx, 1)[0];
	return queue.shift();
}

async function processEntry(entry: QueueEntry): Promise<void> {
	const { imageId, absolutePath, resolve, reject } = entry;
	try {
		// Layer 2: OPFS cache hit
		const cachedUrl = await thumbURL(imageId);
		if (cachedUrl) {
			thumbCache.set(imageId, cachedUrl);
			if (!_countedAsCached.has(imageId)) {
				_countedAsCached.add(imageId);
				thumbQueueProgress.cached++;
				notifyProgress();
			}
			resolve(cachedUrl);
			return;
		}

		// Layer 3: generate from source (native Tauri path preferred)
		thumbQueueProgress.generating++;
		notifyProgress();
		const url = await getThumbURL(imageId, { absolutePath });
		thumbCache.set(imageId, url);
		if (!_countedAsCached.has(imageId)) {
			_countedAsCached.add(imageId);
			thumbQueueProgress.cached++;
		}
		resolve(url);
	} catch (err) {
		reject(err);
	} finally {
		thumbQueueProgress.generating = Math.max(0, thumbQueueProgress.generating - 1);
		notifyProgress();
		inflight.delete(imageId);
	}
}

function maybeSpawnWorker(): void {
	while (activeWorkers < CONCURRENCY && queue.length > 0) {
		const entry = dequeueNext();
		if (!entry) break;
		activeWorkers++;
		void processEntry(entry).finally(() => {
			activeWorkers--;
			maybeSpawnWorker();
		});
	}
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Request a thumbnail URL for imageId.
 *
 * Returns a promise that resolves to an object URL.
 * The URL is owned by thumbCache — do NOT call revokeObjectURL on it.
 *
 * Deduplicates concurrent requests for the same imageId.
 * Checks thumbCache synchronously before enqueuing.
 *
 * @param imageId      Unique image identifier.
 * @param absolutePath Absolute filesystem path to the source image.
 * @param priority     "high" for viewport-visible items, "low" for prefetch.
 */
export function requestThumb(
	imageId: string,
	absolutePath: string,
	priority: ThumbPriority = 'high',
): Promise<string> {
	// Layer 1: module-level cache — synchronous
	const cached = thumbCache.get(imageId);
	if (cached) {
		return Promise.resolve(cached);
	}

	// Deduplicate in-flight requests
	const existing = inflight.get(imageId);
	if (existing) return existing;

	const promise = new Promise<string>((resolve, reject) => {
		queue.push({ imageId, absolutePath, priority, resolve, reject });
		// Only increment total if this ID was not pre-counted by initThumbQueueForLibrary.
		if (!_initialisedIds.has(imageId)) {
			thumbQueueProgress.total++;
			notifyProgress();
		}
	});

	inflight.set(imageId, promise);
	maybeSpawnWorker();
	return promise;
}

/**
 * Promote a pending low-priority request to high priority.
 * No-op if the request is already high priority, inflight, or cached.
 */
export function promoteThumb(imageId: string): void {
	const entry = queue.find((e) => e.imageId === imageId);
	if (entry) entry.priority = 'high';
}

/**
 * Reset progress counters. Call when leaving the library/roll page.
 */
export function resetThumbQueueProgress(): void {
	thumbQueueProgress.cached     = 0;
	thumbQueueProgress.generating = 0;
	thumbQueueProgress.total      = 0;
	_initialisedIds.clear();
	_countedAsCached.clear();
	notifyProgress();
}

/**
 * Initialise progress counters for a full library before any IntersectionObserver
 * fires.  Checks OPFS for each imageId in parallel (capped at CONCURRENCY) so
 * `thumbQueueProgress.total` reflects the whole library and `cached` reflects
 * how many are already on disk.  Images already in the module-level cache are
 * counted as cached immediately.
 *
 * Call this as early as possible after loading the image list so the hint bar
 * shows meaningful totals from the start.
 *
 * Race-safe: populates `_initialisedIds` so `requestThumb` does not double-count
 * `total`, and uses `_countedAsCached` so `processEntry` completions that race
 * with the OPFS scan do not double-count `cached`.
 */
export async function initThumbQueueForLibrary(imageIds: string[]): Promise<void> {
	thumbQueueProgress.total      = imageIds.length;
	thumbQueueProgress.cached     = 0;
	thumbQueueProgress.generating = 0;
	_initialisedIds.clear();
	_countedAsCached.clear();
	for (const id of imageIds) _initialisedIds.add(id);
	notifyProgress();

	// Check cache + OPFS in batches to avoid too many concurrent OPFS reads.
	const BATCH = CONCURRENCY * 2;
	for (let i = 0; i < imageIds.length; i += BATCH) {
		const batch = imageIds.slice(i, i + BATCH);
		await Promise.all(
			batch.map(async (id) => {
				if (_countedAsCached.has(id)) return;
				if (thumbCache.get(id)) {
					_countedAsCached.add(id);
					thumbQueueProgress.cached++;
					notifyProgress();
					return;
				}
				const url = await thumbURL(id);
				if (url) {
					thumbCache.set(id, url);
					_countedAsCached.add(id);
					thumbQueueProgress.cached++;
					notifyProgress();
				}
			}),
		);
	}
}

/**
 * Enqueue background thumbnail generation for images that are not yet cached.
 * Uses low priority so viewport-visible (high-priority) requests are processed
 * first.
 *
 * Reads 4 files concurrently from Tauri's native fs to keep the I/O pipeline
 * busy without starving the UI thread.  Yields between batches with
 * setTimeout(0) so high-priority viewport requests can interrupt.
 *
 * Safe to call multiple times — `requestThumb` deduplicates in-flight requests
 * and the module-level cache prevents redundant work.
 *
 * @param images  Array of `{ id, relativePath }` — the library images.
 * @param dirPath Absolute directory path.
 */
export async function prefetchThumbs(
	images: Array<{ id: string; relativePath: string }>,
	dirPath: string,
): Promise<void> {
	const READ_CONCURRENCY = 4;

	for (let i = 0; i < images.length; i += READ_CONCURRENCY) {
		const batch = images.slice(i, i + READ_CONCURRENCY);

		// Yield between batches so high-priority requests can jump the queue.
		await new Promise<void>((r) => setTimeout(r, 0));

		await Promise.all(
			batch.map(async (image) => {
				// Skip if already cached in memory — no work needed.
				if (thumbCache.get(image.id)) return;

				try {
					const absolutePath = await join(dirPath, image.relativePath);
					void requestThumb(image.id, absolutePath, 'low');
				} catch (err) {
					console.error(`[prefetchThumbs] Failed to build path for ${image.relativePath}:`, err);
				}
			}),
		);
	}
}
