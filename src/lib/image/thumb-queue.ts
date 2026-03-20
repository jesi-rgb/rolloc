/**
 * Thumbnail request queue with priority, concurrency control, and deduplication.
 *
 * Sits between the UI (IntersectionObserver in LibraryImageThumb) and the
 * thumbnail generation pipeline (thumbgen + OPFS).
 *
 * Resolution order for each request:
 *   1. Module-level LRU cache (thumbCache) — synchronous, no async
 *   2. OPFS thumb file — fast read, no re-generation
 *   3. Generate from source File — slow path, writes to OPFS + cache
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

// ─── Types ────────────────────────────────────────────────────────────────────

export type ThumbPriority = 'high' | 'low';

interface QueueEntry {
	imageId: string;
	file: File;
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

// ─── Queue processing ─────────────────────────────────────────────────────────

function dequeueNext(): QueueEntry | undefined {
	// High-priority first
	const highIdx = queue.findIndex((e) => e.priority === 'high');
	if (highIdx >= 0) return queue.splice(highIdx, 1)[0];
	return queue.shift();
}

async function processEntry(entry: QueueEntry): Promise<void> {
	const { imageId, file, resolve, reject } = entry;
	try {
		// Layer 2: OPFS cache hit
		const cachedUrl = await thumbURL(imageId);
		if (cachedUrl) {
			thumbCache.set(imageId, cachedUrl);
			thumbQueueProgress.cached++;
			notifyProgress();
			resolve(cachedUrl);
			return;
		}

		// Layer 3: generate from source
		thumbQueueProgress.generating++;
		notifyProgress();
		const url = await getThumbURL(imageId, file);
		thumbCache.set(imageId, url);
		thumbQueueProgress.cached++;
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
 */
export function requestThumb(
	imageId: string,
	file: File,
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
		queue.push({ imageId, file, priority, resolve, reject });
		thumbQueueProgress.total++;
		notifyProgress();
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
 * Reset progress counters. Call when leaving the library page.
 */
export function resetThumbQueueProgress(): void {
	thumbQueueProgress.cached     = 0;
	thumbQueueProgress.generating = 0;
	thumbQueueProgress.total      = 0;
	notifyProgress();
}
