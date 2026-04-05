/**
 * Thumbnail and preview generation.
 *
 * Generates JPEG blobs from image files and caches results in OPFS.
 *
 * Sizes:
 *   THUMB_SIZE   — 300px long edge  → filmstrip
 *   PREVIEW_SIZE — 1200px long edge → lightbox pre-render
 *
 * Generation paths (in order of preference):
 *   1. Native Tauri command (`generate_thumb`) — reads, decodes, resizes, and
 *      JPEG-encodes entirely in Rust using the `image` crate + Lanczos3.
 *      Requires an absolute file path.  Only the small JPEG blob (~10–30 KB)
 *      crosses the IPC boundary.  Tauri's thread pool handles parallelism.
 *   2. Web Worker pool — used when a pre-loaded File/Blob is available but the
 *      Tauri command is absent (browser context / tests).  Each worker uses
 *      ImageDecoder (Chromium 94+) for a single decode pass, falling back to
 *      createImageBitmap with resize hints.
 *   3. Main-thread fallback — OffscreenCanvas or regular canvas.  Used only
 *      when both Worker and OffscreenCanvas are unavailable.
 */

import { writeThumb, writePreview, readThumb, readPreview } from '$lib/fs/opfs';
import { invoke } from '@tauri-apps/api/core';
import {
	readExifOrientation,
	applyOrientationTransform,
	orientationSwapsDimensions,
} from '$lib/image/exif-orientation';
import { isRawExtension } from '$lib/fs/directory';
import type { ThumbWorkerRequest, ThumbWorkerResponse } from './thumb.worker';
import type { FilmType } from '$lib/types';

export const THUMB_SIZE   = 300;
export const PREVIEW_SIZE = 1200;
export const JPEG_QUALITY = 0.88;

// ─── Tauri detection ──────────────────────────────────────────────────────────

/** True when running inside a Tauri WebView (not a plain browser). */
function isTauri(): boolean {
	return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Call the native Rust `generate_thumb` command.
 * Returns a Blob containing the JPEG bytes.
 *
 * The Rust side returns `tauri::ipc::Response` (raw bytes), so `invoke`
 * resolves to an `ArrayBuffer` — no base64 round-trip.
 *
 * @param absolutePath Absolute path to the source image.
 * @param maxPx        Maximum pixel count on the long edge.
 * @param filmType     Film processing mode:
 *                     - 'C41' — color negative (inversion + orange mask removal)
 *                     - 'BW'  — B&W negative (inversion + grayscale)
 *                     - 'E6'  — slide/reversal (normalize only, no inversion)
 *                     - undefined/null — no processing (for libraries)
 */
async function generateThumbNative(
	absolutePath: string,
	maxPx: number,
	filmType?: FilmType | null,
): Promise<Blob> {
	const buf = await invoke<ArrayBuffer>('generate_thumb', {
		path:     absolutePath,
		maxPx,
		quality:  Math.round(JPEG_QUALITY * 100),
		filmType: filmType ?? '',
	});
	return new Blob([buf], { type: 'image/jpeg' });
}

/**
 * Call the native Rust `raw_thumb` command for RAW files.
 * Returns a Blob containing the JPEG bytes from the embedded preview
 * (or a demosaiced fallback if no embedded preview exists).
 */
async function generateRawThumbNative(absolutePath: string, maxPx: number): Promise<Blob> {
	const buf = await invoke<ArrayBuffer>('raw_thumb', {
		path:    absolutePath,
		maxPx,
		quality: Math.round(JPEG_QUALITY * 100),
	});
	return new Blob([buf], { type: 'image/jpeg' });
}

// ─── Worker pool ──────────────────────────────────────────────────────────────

const WORKER_COUNT = Math.max(2, Math.floor((navigator?.hardwareConcurrency ?? 4) / 2));

interface PendingTask {
	resolve: (blob: Blob) => void;
	reject: (err: Error) => void;
}

interface WorkerSlot {
	worker: Worker;
	busy: boolean;
	pendingId: string | null;
}

/** Lazily initialised pool — only created when first thumb is requested. */
let pool: WorkerSlot[] | null = null;
const taskQueue: Array<{ id: string; req: ThumbWorkerRequest; task: PendingTask }> = [];
const pendingTasks = new Map<string, PendingTask>();

function getPool(): WorkerSlot[] | null {
	if (pool !== null) return pool;
	if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return null;

	try {
		pool = Array.from({ length: WORKER_COUNT }, () => {
			const worker = new Worker(new URL('./thumb.worker.ts', import.meta.url), {
				type: 'module',
			});
			const slot: WorkerSlot = { worker, busy: false, pendingId: null };

			worker.onmessage = (e: MessageEvent<ThumbWorkerResponse>) => {
				slot.busy = false;
				slot.pendingId = null;

				const { id } = e.data;
				const task = pendingTasks.get(id);
				if (task) {
					pendingTasks.delete(id);
					if ('result' in e.data) {
						task.resolve(e.data.result);
					} else {
						task.reject(new Error(e.data.error));
					}
				}
				drainQueue(slot);
			};

			worker.onerror = (e) => {
				slot.busy = false;
				if (slot.pendingId) {
					const task = pendingTasks.get(slot.pendingId);
					if (task) {
						pendingTasks.delete(slot.pendingId);
						task.reject(new Error(e.message ?? 'Worker error'));
					}
					slot.pendingId = null;
				}
				drainQueue(slot);
			};

			return slot;
		});
		return pool;
	} catch {
		pool = null;
		return null;
	}
}

function drainQueue(slot: WorkerSlot): void {
	if (slot.busy || taskQueue.length === 0) return;
	const next = taskQueue.shift();
	if (!next) return;
	slot.busy = true;
	slot.pendingId = next.id;
	pendingTasks.set(next.id, next.task);
	slot.worker.postMessage(next.req);
}

function dispatchToPool(req: ThumbWorkerRequest): Promise<Blob> {
	const workers = getPool();
	if (!workers) return Promise.reject(new Error('no pool'));

	return new Promise<Blob>((resolve, reject) => {
		const task: PendingTask = { resolve, reject };
		const free = workers.find((s) => !s.busy);
		if (free) {
			free.busy = true;
			free.pendingId = req.id;
			pendingTasks.set(req.id, task);
			free.worker.postMessage(req);
		} else {
			taskQueue.push({ id: req.id, req, task });
		}
	});
}

// ─── Core decode + resize ─────────────────────────────────────────────────────

/**
 * Decodes a File/Blob and resizes to maxPx on the long edge, returning a
 * JPEG blob.  Uses the worker pool when available; falls back to
 * in-main-thread OffscreenCanvas or regular canvas.
 *
 * Only used when an absolute path is NOT available (browser / test context).
 */
async function generateResizedFromBlob(file: File | Blob, maxPx: number): Promise<Blob> {
	// ── Worker path ──
	const workers = getPool();
	if (workers) {
		const req: ThumbWorkerRequest = {
			id: crypto.randomUUID(),
			blob: file,
			maxPx,
			quality: JPEG_QUALITY,
		};
		try {
			return await dispatchToPool(req);
		} catch {
			// Fall through to main-thread path
		}
	}

	// ── Main-thread path (fallback) ──
	const orientation = await readExifOrientation(file);
	const swapped = orientationSwapsDimensions(orientation);

	const probe = await createImageBitmap(file);
	const { width, height } = probe;
	probe.close();

	// Scale from logical (post-rotation) dimensions.
	const logicalW = swapped ? height : width;
	const logicalH = swapped ? width  : height;
	const scale = Math.min(1, maxPx / Math.max(logicalW, logicalH));
	const w = Math.round(width  * scale);
	const h = Math.round(height * scale);

	const bitmap = await createImageBitmap(file, {
		resizeWidth: w,
		resizeHeight: h,
		resizeQuality: 'high',
	});

	// Output canvas is sized to logical (post-rotation) dimensions.
	const outW = swapped ? h : w;
	const outH = swapped ? w : h;

	let blob: Blob;

	if (typeof OffscreenCanvas !== 'undefined') {
		const canvas = new OffscreenCanvas(outW, outH);
		const ctx = canvas.getContext('2d')!;
		applyOrientationTransform(ctx, orientation, w, h);
		ctx.drawImage(bitmap, 0, 0);
		blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
	} else {
		const canvas = document.createElement('canvas');
		canvas.width  = outW;
		canvas.height = outH;
		const ctx = canvas.getContext('2d')!;
		applyOrientationTransform(ctx, orientation, w, h);
		ctx.drawImage(bitmap, 0, 0);
		blob = await new Promise<Blob>((resolve, reject) => {
			canvas.toBlob(
				(b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))),
				'image/jpeg',
				JPEG_QUALITY,
			);
		});
	}

	bitmap.close();
	return blob;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generates and caches a thumbnail for a frame.
 * No-ops if a thumb is already cached.
 * Returns the cached-or-newly-generated blob.
 *
 * Prefers the native Tauri path (absolutePath) when available — no file bytes
 * cross the IPC boundary.  Falls back to blob-based generation when a file
 * is provided instead.
 *
 * @param frameId  Unique identifier for the frame/image.
 * @param source   Path or File to the source image.
 * @param filmType Film processing mode:
 *                 - 'C41' — color negative (inversion + orange mask removal)
 *                 - 'BW'  — B&W negative (inversion + grayscale)
 *                 - 'E6'  — slide/reversal (normalize only, no inversion)
 *                 - undefined/null — no processing (for libraries)
 */
export async function ensureThumb(
	frameId: string,
	source: { absolutePath: string } | { file: File },
	filmType?: FilmType | null,
): Promise<Blob> {
	const existing = await readThumb(frameId);
	if (existing) return existing;

	let blob: Blob;
	if ('absolutePath' in source && isTauri()) {
		// Route RAW files through the dedicated raw_thumb command.
		if (isRawExtension(source.absolutePath)) {
			blob = await generateRawThumbNative(source.absolutePath, THUMB_SIZE);
		} else {
			blob = await generateThumbNative(source.absolutePath, THUMB_SIZE, filmType);
		}
	} else {
		const file = 'file' in source ? source.file : (() => { throw new Error('no source'); })();
		blob = await generateResizedFromBlob(file, THUMB_SIZE);
	}

	await writeThumb(frameId, blob);
	return blob;
}

/**
 * Generates and caches a full preview for a frame.
 * No-ops if a preview is already cached.
 *
 * @param frameId  Unique identifier for the frame/image.
 * @param source   Path or File to the source image.
 * @param filmType Film processing mode:
 *                 - 'C41' — color negative (inversion + orange mask removal)
 *                 - 'BW'  — B&W negative (inversion + grayscale)
 *                 - 'E6'  — slide/reversal (normalize only, no inversion)
 *                 - undefined/null — no processing (for libraries)
 */
export async function ensurePreview(
	frameId: string,
	source: { absolutePath: string } | { file: File },
	filmType?: FilmType | null,
): Promise<Blob> {
	const existing = await readPreview(frameId);
	if (existing) return existing;

	let blob: Blob;
	if ('absolutePath' in source && isTauri()) {
		// Route RAW files through the dedicated raw_thumb command.
		if (isRawExtension(source.absolutePath)) {
			blob = await generateRawThumbNative(source.absolutePath, PREVIEW_SIZE);
		} else {
			blob = await generateThumbNative(source.absolutePath, PREVIEW_SIZE, filmType);
		}
	} else {
		const file = 'file' in source ? source.file : (() => { throw new Error('no source'); })();
		blob = await generateResizedFromBlob(file, PREVIEW_SIZE);
	}

	await writePreview(frameId, blob);
	return blob;
}

/**
 * Returns an object URL for the frame's thumbnail.
 * Accepts either an absolute path (preferred, native Tauri) or a File object.
 * Caller must call URL.revokeObjectURL() when done.
 *
 * @param frameId  Unique identifier for the frame/image.
 * @param source   Path or File to the source image.
 * @param filmType Film processing mode:
 *                 - 'C41' — color negative (inversion + orange mask removal)
 *                 - 'BW'  — B&W negative (inversion + grayscale)
 *                 - 'E6'  — slide/reversal (normalize only, no inversion)
 *                 - undefined/null — no processing (for libraries)
 */
export async function getThumbURL(
	frameId: string,
	source: { absolutePath: string } | { file: File },
	filmType?: FilmType | null,
): Promise<string> {
	const blob = await ensureThumb(frameId, source, filmType);
	return URL.createObjectURL(blob);
}

/**
 * Returns an object URL for the frame's full preview (1200px long edge).
 * Accepts either an absolute path (preferred, native Tauri) or a File object.
 * Caller must call URL.revokeObjectURL() when done.
 *
 * @param frameId  Unique identifier for the frame/image.
 * @param source   Path or File to the source image.
 * @param filmType Film processing mode:
 *                 - 'C41' — color negative (inversion + orange mask removal)
 *                 - 'BW'  — B&W negative (inversion + grayscale)
 *                 - 'E6'  — slide/reversal (normalize only, no inversion)
 *                 - undefined/null — no processing (for libraries)
 */
export async function getPreviewURL(
	frameId: string,
	source: { absolutePath: string } | { file: File },
	filmType?: FilmType | null,
): Promise<string> {
	const blob = await ensurePreview(frameId, source, filmType);
	return URL.createObjectURL(blob);
}

// ─── Batch generation ─────────────────────────────────────────────────────────

/**
 * Pre-generates thumbnails for multiple images in batch.
 * Skips images that are already cached.
 * Continues on errors (logs but doesn't throw).
 * Returns the number of thumbnails successfully generated.
 */
export async function generateThumbnails(
	images: Array<{ id: string; absolutePath: string }>,
	options?: {
		concurrency?: number;
		onProgress?: (current: number, total: number) => void;
	},
): Promise<number> {
	const concurrency = options?.concurrency ?? Math.max(4, WORKER_COUNT * 2);
	const total = images.length;
	let completed = 0;
	let generated = 0;

	const queue = [...images];
	const workers = Array.from({ length: concurrency }, async () => {
		while (queue.length > 0) {
			const item = queue.shift();
			if (!item) break;

			try {
				const existing = await readThumb(item.id);
				if (existing) {
					completed++;
					options?.onProgress?.(completed, total);
					continue;
				}

				await ensureThumb(item.id, { absolutePath: item.absolutePath });
				generated++;
			} catch (err) {
				console.error(`Failed to generate thumbnail for ${item.id}:`, err);
			} finally {
				completed++;
				options?.onProgress?.(completed, total);
			}
		}
	});

	await Promise.all(workers);
	return generated;
}
