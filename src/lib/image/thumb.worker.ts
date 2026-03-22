/**
 * Thumbnail generation worker.
 *
 * Runs in a separate thread to keep the main thread free during bulk
 * thumbnail generation.
 *
 * Decode strategy (in order of preference):
 *   1. ImageDecoder API — gets dimensions from metadata cheaply, then decodes
 *      once directly to an ImageBitmap. Single decode pass, no wasted work.
 *   2. createImageBitmap with resize hints — single-step hardware-accelerated
 *      decode + resize, but requires a dimension probe first (two decodes).
 *      Used as fallback when ImageDecoder is unavailable.
 *
 * This worker is only used for the JS-side fallback path (when the Tauri
 * native `generate_thumb` command is unavailable, e.g. in a browser context).
 *
 * Message protocol:
 *   IN:  { id: string; blob: Blob; maxPx: number; quality: number }
 *   OUT: { id: string; result: Blob }      — success
 *        { id: string; error: string }     — failure
 */

export interface ThumbWorkerRequest {
	id: string;
	blob: Blob;
	maxPx: number;
	quality: number;
}

export interface ThumbWorkerSuccess {
	id: string;
	result: Blob;
}

export interface ThumbWorkerError {
	id: string;
	error: string;
}

export type ThumbWorkerResponse = ThumbWorkerSuccess | ThumbWorkerError;

// ─── ImageDecoder availability ────────────────────────────────────────────────

/** True if the ImageDecoder API is available in this context. */
const HAS_IMAGE_DECODER = typeof ImageDecoder !== 'undefined';

// ─── Decode helpers ───────────────────────────────────────────────────────────

/**
 * Single-pass decode + resize using ImageDecoder.
 * Gets image dimensions from compressed metadata (no pixel decode needed),
 * then decodes once with exact target dimensions.
 */
async function resizeWithImageDecoder(
	blob: Blob,
	maxPx: number,
): Promise<ImageBitmap> {
	const decoder = new ImageDecoder({ data: blob.stream(), type: blob.type || 'image/jpeg' });
	await decoder.tracks.ready;

	const track = decoder.tracks.selectedTrack;
	if (!track) throw new Error('ImageDecoder: no track');

	// codedWidth/codedHeight come from the compressed stream header — no pixel decode.
	// TypeScript's lib types don't yet include these fields; they are present in
	// Chromium 94+ (and therefore in Tauri's WebView).
	const t = track as ImageTrack & { codedWidth?: number; codedHeight?: number };
	const naturalWidth  = t.codedWidth;
	const naturalHeight = t.codedHeight;

	if (!naturalWidth || !naturalHeight) {
		// Some decoders return 0 before the first frame; fall back to full decode.
		decoder.close();
		throw new Error('ImageDecoder: zero dimensions from track metadata');
	}

	const scale = Math.min(1, maxPx / Math.max(naturalWidth, naturalHeight));
	const w = Math.round(naturalWidth  * scale);
	const h = Math.round(naturalHeight * scale);

	// Decode frame 0 — single pixel decode pass.
	const { image } = await decoder.decode({ frameIndex: 0 });
	decoder.close();

	// Resize to target dimensions.
	return createImageBitmap(image, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
}

/**
 * Fallback: two-pass createImageBitmap (probe for dimensions, then resize).
 */
async function resizeWithCreateImageBitmap(
	blob: Blob,
	maxPx: number,
): Promise<ImageBitmap> {
	// Pass 1 — probe dimensions (decode headers only in most browsers).
	const probe = await createImageBitmap(blob);
	const { width, height } = probe;
	probe.close();

	const scale = Math.min(1, maxPx / Math.max(width, height));
	const w = Math.round(width  * scale);
	const h = Math.round(height * scale);

	// Pass 2 — single-step hardware-accelerated decode + resize.
	return createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
}

// ─── Message handler ──────────────────────────────────────────────────────────

self.onmessage = async (e: MessageEvent<ThumbWorkerRequest>) => {
	const { id, blob, maxPx, quality } = e.data;

	try {
		let bitmap: ImageBitmap;

		if (HAS_IMAGE_DECODER) {
			try {
				bitmap = await resizeWithImageDecoder(blob, maxPx);
			} catch {
				// ImageDecoder failed (e.g. unsupported format) — fall through.
				bitmap = await resizeWithCreateImageBitmap(blob, maxPx);
			}
		} else {
			bitmap = await resizeWithCreateImageBitmap(blob, maxPx);
		}

		const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
		const ctx = canvas.getContext('2d')!;
		ctx.drawImage(bitmap, 0, 0);
		bitmap.close();

		const result = await canvas.convertToBlob({ type: 'image/jpeg', quality });
		self.postMessage({ id, result } satisfies ThumbWorkerSuccess);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		self.postMessage({ id, error: message } satisfies ThumbWorkerError);
	}
};
