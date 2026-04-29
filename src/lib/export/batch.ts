/**
 * Batch export — write a sequence of RAW frames as JPEGs into the roll's
 * `exports/` subfolder.
 *
 * Each frame is processed sequentially through the native Rust `export_native`
 * Tauri command, which decodes the RAW at full resolution, runs the same f32
 * colour pipeline used for the preview, and encodes a high-quality JPEG.
 *
 * The pure-Rust path means we don't need a `GpuPipeline` instance on the roll
 * page — batch export works without ever opening the per-frame editor.
 *
 * Non-RAW frames (JPEG/TIFF) are skipped: they require GPU readback to honour
 * edits, which would mean spinning up a full WebGPU pipeline here.  That's a
 * follow-up; for now the bar reports them as `skipped`.
 *
 * Files are always written to `<rollDirPath>/exports/<stem><suffix>.jpg`.
 * Existing files are silently overwritten (the OS-level "save dialog" approval
 * is implicit because the user explicitly hit "Export").
 */
import { invoke } from '@tauri-apps/api/core';
import { join, basename } from '@tauri-apps/api/path';

import { resolveEdit } from '$lib/types';
import { isRawExtension } from '$lib/fs/directory';
import type { Roll, Frame } from '$lib/types';

export type ExportScale = 0.25 | 0.5 | 1;

export interface BatchExportProgress {
	/** Number of frames processed so far (success + skipped + failed). */
	processed: number;
	/** Total frames in the export job. */
	total:     number;
	/** Filename of the frame currently being processed, if any. */
	current:   string | null;
	/** Frames written to disk so far. */
	exported:  number;
	/** Frames skipped (non-RAW, currently). */
	skipped:   number;
	/** Frames that errored — accumulated `{ filename, message }` records. */
	failed:    Array<{ filename: string; message: string }>;
}

export interface BatchExportOptions {
	roll:        Roll;
	frames:      Frame[];
	/** Absolute path of the roll's source directory. */
	dirPath:     string;
	scale:       ExportScale;
	/** JPEG quality 1–100. Defaults to 95 (matches single-frame export). */
	quality?:    number;
	/** Called after each frame finishes, with a fresh progress snapshot. */
	onProgress?: (p: BatchExportProgress) => void;
	/** Set `aborted` to true to stop after the in-flight frame completes. */
	signal?:     { aborted: boolean };
}

export interface BatchExportResult {
	exported: number;
	skipped:  number;
	failed:   Array<{ filename: string; message: string }>;
	/** True when the run was halted via `signal.aborted` before completion. */
	aborted:  boolean;
}

/** Build the destination filename for a frame at a given export scale. */
export function exportFilenameFor(filename: string, scale: ExportScale): string {
	const stem = filename.replace(/\.[^.]+$/, '');
	const suffix = scale === 0.25 ? '_sm' : scale === 0.5 ? '_md' : '';
	return `${stem}${suffix}.jpg`;
}

export async function exportFramesBatch(
	opts: BatchExportOptions,
): Promise<BatchExportResult> {
	const {
		roll,
		frames,
		dirPath,
		scale,
		quality = 95,
		onProgress,
		signal,
	} = opts;

	const exportsDir = await join(dirPath, 'exports');

	const progress: BatchExportProgress = {
		processed: 0,
		total:     frames.length,
		current:   null,
		exported:  0,
		skipped:   0,
		failed:    [],
	};

	let aborted = false;

	for (const frame of frames) {
		if (signal?.aborted) {
			aborted = true;
			break;
		}

		progress.current = frame.filename;
		onProgress?.({ ...progress });

		// Resolve the leaf filename — `frame.filename` is already a basename per
		// the schema, but go through `basename()` to be defensive against any
		// path-like values that may have crept in from older DB records.
		const leaf = await basename(frame.filename).catch(() => frame.filename);

		if (!isRawExtension(leaf)) {
			progress.skipped++;
			progress.processed++;
			progress.current = null;
			onProgress?.({ ...progress });
			continue;
		}

		try {
			const sourcePath = await join(dirPath, frame.filename);
			const outName    = exportFilenameFor(leaf, scale);
			const exportPath = await join(exportsDir, outName);

			const edit = resolveEdit(roll, frame);

			await invoke('export_native', {
				sourcePath,
				exportPath,
				edit,
				// Recompute percentiles from the full-res data — we don't have a
				// preview rendered here, so passing `null` lets the Rust side
				// derive them itself (matches behaviour when the editor hasn't
				// rendered yet).
				logPerc: null,
				skipWb:  roll.rollEdit.invert,
				quality,
				scale,
			});

			progress.exported++;
		} catch (err: unknown) {
			progress.failed.push({
				filename: frame.filename,
				message:  err instanceof Error ? err.message : String(err),
			});
		}

		progress.processed++;
		progress.current = null;
		onProgress?.({ ...progress });
	}

	return {
		exported: progress.exported,
		skipped:  progress.skipped,
		failed:   progress.failed,
		aborted,
	};
}
