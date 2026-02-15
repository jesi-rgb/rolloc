/**
 * Thumbnail and preview generation.
 *
 * Generates JPEG blobs from image files using an OffscreenCanvas (or
 * regular canvas fallback) and caches results in OPFS.
 *
 * Sizes:
 *   THUMB_SIZE   — 300px long edge  → filmstrip
 *   PREVIEW_SIZE — 1200px long edge → lightbox pre-render
 */

import { writeThumb, writePreview, readThumb, readPreview } from '$lib/fs/opfs';

const THUMB_SIZE   = 300;
const PREVIEW_SIZE = 1200;
const JPEG_QUALITY = 0.88;

// ─── Core decode + resize ─────────────────────────────────────────────────────

/**
 * Decodes a File/Blob into an ImageBitmap and draws it scaled onto a
 * canvas, returning a JPEG blob.
 */
async function generateResized(file: File | Blob, maxPx: number): Promise<Blob> {
	const bitmap = await createImageBitmap(file);
	const { width, height } = bitmap;

	const scale = Math.min(1, maxPx / Math.max(width, height));
	const w = Math.round(width  * scale);
	const h = Math.round(height * scale);

	let blob: Blob;

	if (typeof OffscreenCanvas !== 'undefined') {
		const canvas = new OffscreenCanvas(w, h);
		const ctx = canvas.getContext('2d')!;
		ctx.drawImage(bitmap, 0, 0, w, h);
		blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
	} else {
		// Fallback for browsers without OffscreenCanvas (rare)
		const canvas = document.createElement('canvas');
		canvas.width  = w;
		canvas.height = h;
		const ctx = canvas.getContext('2d')!;
		ctx.drawImage(bitmap, 0, 0, w, h);
		blob = await new Promise<Blob>((resolve, reject) => {
			canvas.toBlob(
				(b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))),
				'image/jpeg',
				JPEG_QUALITY
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
 */
export async function ensureThumb(frameId: string, file: File): Promise<Blob> {
	const existing = await readThumb(frameId);
	if (existing) return existing;

	const blob = await generateResized(file, THUMB_SIZE);
	await writeThumb(frameId, blob);
	return blob;
}

/**
 * Generates and caches a full preview for a frame.
 * No-ops if a preview is already cached.
 */
export async function ensurePreview(frameId: string, file: File): Promise<Blob> {
	const existing = await readPreview(frameId);
	if (existing) return existing;

	const blob = await generateResized(file, PREVIEW_SIZE);
	await writePreview(frameId, blob);
	return blob;
}

/**
 * Returns an object URL for the frame's thumbnail.
 * Generates the thumb if not yet cached (requires the source File).
 * Caller must call URL.revokeObjectURL() when done.
 */
export async function getThumbURL(frameId: string, file: File): Promise<string> {
	const blob = await ensureThumb(frameId, file);
	return URL.createObjectURL(blob);
}

/**
 * Returns an object URL for the frame's full preview (1200px long edge).
 * Generates the preview if not yet cached (requires the source File).
 * Caller must call URL.revokeObjectURL() when done.
 */
export async function getPreviewURL(frameId: string, file: File): Promise<string> {
	const blob = await ensurePreview(frameId, file);
	return URL.createObjectURL(blob);
}
