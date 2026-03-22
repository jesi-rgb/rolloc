/**
 * Minimal EXIF Orientation reader.
 *
 * Reads only the Orientation tag (0x0112) from the EXIF segment of a JPEG or
 * TIFF file.  Deliberately avoids pulling in a full EXIF library so this
 * module is safe to import inside a Web Worker.
 *
 * Returns a value 1–8 matching the EXIF Orientation enum, or 1 (no rotation)
 * if the tag is absent or the file is not a recognised format.
 *
 * EXIF Orientation values and the transforms they describe:
 *
 *   1 — Normal (top-left)        No transform needed
 *   2 — Mirrored horizontal      flipX
 *   3 — Rotated 180°             rotate 180
 *   4 — Mirrored vertical        flipY
 *   5 — Mirrored + rotated 90°CCW  transpose
 *   6 — Rotated 90° CW           rotate 90 CW
 *   7 — Mirrored + rotated 90°CW   transverse
 *   8 — Rotated 90° CCW          rotate 90 CCW
 *
 * Only JPEG (APP1/EXIF) and TIFF are supported; all other formats return 1.
 */

/** Valid EXIF orientation values. */
export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/**
 * Read the EXIF Orientation tag from a Blob/File.
 * Reads only the first ~64 KB, which is always sufficient to reach the
 * EXIF APP1 segment in any well-formed JPEG.
 */
export async function readExifOrientation(blob: Blob): Promise<ExifOrientation> {
	// Read enough bytes to cover the EXIF APP1 segment (never beyond 64 KB).
	const sliceSize = Math.min(blob.size, 65536);
	const buf = await blob.slice(0, sliceSize).arrayBuffer();
	const view = new DataView(buf);

	if (buf.byteLength < 4) return 1;

	const b0 = view.getUint8(0);
	const b1 = view.getUint8(1);

	// ── JPEG ─────────────────────────────────────────────────────────────────
	// JPEG starts with SOI marker FF D8.
	if (b0 === 0xff && b1 === 0xd8) {
		return readJpegOrientation(view);
	}

	// ── TIFF ─────────────────────────────────────────────────────────────────
	// TIFF: "II" (little-endian) = 0x49 0x49, or "MM" (big-endian) = 0x4d 0x4d
	if ((b0 === 0x49 && b1 === 0x49) || (b0 === 0x4d && b1 === 0x4d)) {
		return readTiffOrientation(view, 0);
	}

	return 1;
}

// ─── JPEG parser ──────────────────────────────────────────────────────────────

function readJpegOrientation(view: DataView): ExifOrientation {
	const len = view.byteLength;
	let offset = 2; // skip SOI (FF D8)

	while (offset + 4 <= len) {
		if (view.getUint8(offset) !== 0xff) break; // lost sync

		const marker = view.getUint8(offset + 1);
		// Skip fill bytes (FF FF …)
		if (marker === 0xff) {
			offset++;
			continue;
		}

		// Markers with no length field: SOI, EOI, RST0–RST7
		if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
			offset += 2;
			continue;
		}

		const segmentLength = view.getUint16(offset + 2, false); // big-endian
		if (offset + 2 + segmentLength > len) break; // truncated

		// APP1 marker = FF E1
		if (marker === 0xe1 && segmentLength >= 8) {
			// Check for "Exif\0\0" header at offset+4
			if (
				view.getUint8(offset + 4) === 0x45 && // E
				view.getUint8(offset + 5) === 0x78 && // x
				view.getUint8(offset + 6) === 0x69 && // i
				view.getUint8(offset + 7) === 0x66 && // f
				view.getUint8(offset + 8) === 0x00 && // \0
				view.getUint8(offset + 9) === 0x00    // \0
			) {
				// TIFF header starts at offset + 10
				const tiffStart = offset + 10;
				if (tiffStart + 8 <= len) {
					return readTiffOrientation(view, tiffStart);
				}
			}
		}

		offset += 2 + segmentLength;
	}

	return 1;
}

// ─── TIFF IFD parser ──────────────────────────────────────────────────────────

function readTiffOrientation(view: DataView, tiffStart: number): ExifOrientation {
	const len = view.byteLength;
	if (tiffStart + 8 > len) return 1;

	const b0 = view.getUint8(tiffStart);
	const b1 = view.getUint8(tiffStart + 1);
	let littleEndian: boolean;

	if (b0 === 0x49 && b1 === 0x49) {
		littleEndian = true;  // "II" = Intel = little-endian
	} else if (b0 === 0x4d && b1 === 0x4d) {
		littleEndian = false; // "MM" = Motorola = big-endian
	} else {
		return 1; // not a valid TIFF header
	}

	const magic = view.getUint16(tiffStart + 2, littleEndian);
	if (magic !== 42) return 1; // TIFF magic number

	const ifdOffset = view.getUint32(tiffStart + 4, littleEndian);
	const ifdAbs = tiffStart + ifdOffset;

	if (ifdAbs + 2 > len) return 1;

	const entryCount = view.getUint16(ifdAbs, littleEndian);
	const ORIENTATION_TAG = 0x0112;

	for (let i = 0; i < entryCount; i++) {
		const entryOffset = ifdAbs + 2 + i * 12;
		if (entryOffset + 12 > len) break;

		const tag = view.getUint16(entryOffset, littleEndian);
		if (tag === ORIENTATION_TAG) {
			// type=3 (SHORT), count=1, value in bytes 8–9
			const value = view.getUint16(entryOffset + 8, littleEndian);
			if (value >= 1 && value <= 8) return value as ExifOrientation;
			return 1;
		}
	}

	return 1;
}

// ─── Canvas transform helpers ─────────────────────────────────────────────────

/**
 * Apply the EXIF orientation transform to a 2D canvas context so that a
 * subsequent `drawImage(bitmap, 0, 0)` renders correctly upright.
 *
 * The canvas must already be sized to the *output* dimensions (i.e. width/height
 * swapped for 90°/270° rotations).
 *
 * @param ctx       The 2D context of the output canvas.
 * @param orientation  EXIF orientation value (1–8).
 * @param srcWidth  Pixel width of the source bitmap (before any rotation).
 * @param srcHeight Pixel height of the source bitmap (before any rotation).
 */
export function applyOrientationTransform(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	orientation: ExifOrientation,
	srcWidth: number,
	srcHeight: number,
): void {
	switch (orientation) {
		case 1: break; // normal — no transform
		case 2:        // flip horizontal
			ctx.transform(-1, 0, 0, 1, srcWidth, 0);
			break;
		case 3:        // rotate 180°
			ctx.transform(-1, 0, 0, -1, srcWidth, srcHeight);
			break;
		case 4:        // flip vertical
			ctx.transform(1, 0, 0, -1, 0, srcHeight);
			break;
		case 5:        // transpose (flip horizontal + rotate 90° CCW)
			ctx.transform(0, 1, 1, 0, 0, 0);
			break;
		case 6:        // rotate 90° CW
			ctx.transform(0, 1, -1, 0, srcHeight, 0);
			break;
		case 7:        // transverse (flip horizontal + rotate 90° CW)
			ctx.transform(0, -1, -1, 0, srcHeight, srcWidth);
			break;
		case 8:        // rotate 90° CCW
			ctx.transform(0, -1, 1, 0, 0, srcWidth);
			break;
	}
}

/**
 * Returns true for orientations that swap width and height (90°/270° rotations).
 */
export function orientationSwapsDimensions(orientation: ExifOrientation): boolean {
	return orientation === 5 || orientation === 6 || orientation === 7 || orientation === 8;
}
