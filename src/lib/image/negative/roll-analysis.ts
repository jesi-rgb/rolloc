/**
 * Roll analysis: measures every negative frame of a roll at preview size,
 * pools their bounds into a `RollBaseline` and stores it on the roll.
 *
 * Frames are decoded exactly as the editor decodes them (same command,
 * `maxPx` and `skipWb`), so a frame the background sweep or the editor has
 * already decoded is a cache read, and the bounds pooled here are the bounds
 * the editor would measure.
 */

import { invoke } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import { getRoll, getRollPath, setRollBaseline } from '$lib/db/rolls';
import { getFrames } from '$lib/db/idb';
import { isRawExtension } from '$lib/fs/directory';
import { isTauriEnv } from '$lib/fs/sidecar';
import { parseDecodeImageRgbBuffer, parseRawDecodeBuffer, previewMaxPx } from '$lib/image/pipeline';
import { ANALYSIS_VERSION, resolveEdit } from '$lib/types';
import type { FilmType, Frame, Roll, RollBaseline } from '$lib/types';
import { analyzeNegative } from './analysis';
import { poolFrameBounds, type FrameBounds } from './baseline';
import type { LinearSource } from './grid';

export interface RollAnalysisProgress {
	/** Frames handled so far, failed ones included. */
	done: number;
	/** Negative frames in the roll. */
	total: number;
	/** Frames that could not be decoded so far. */
	failed: number;
}

export interface FrameFailure {
	frameId: string;
	filename: string;
	message: string;
}

export interface RollAnalysisResult {
	/** The roll as stored, baseline included. */
	roll: Roll;
	baseline: RollBaseline;
	/** Frames whose bounds were measured (pooled + outliers). */
	analyzed: number;
	/** Frames skipped because they could not be decoded. */
	failures: FrameFailure[];
}

export interface AnalyzeRollOptions {
	rollId: string;
	/** Called once before the first frame and after every frame. */
	onProgress?: (progress: RollAnalysisProgress) => void;
	/**
	 * Cancels the run between frames (the decode in flight still finishes).
	 * A cancelled run rejects with the signal's reason and stores nothing.
	 */
	signal?: AbortSignal;
}

/**
 * The film type `frame` is inverted as when the inversion treats it as a
 * negative — the frames a roll baseline pools — else null.
 */
export function negativeFilmType(roll: Roll, frame: Frame): FilmType | null {
	const edit = resolveEdit(roll, frame);
	const filmType = edit.inversionParams.filmType;
	return edit.invert && (filmType === 'C41' || filmType === 'BW') ? filmType : null;
}

interface NegativeTarget {
	frame: Frame;
	filmType: FilmType;
}

interface DecodedFrame {
	src: LinearSource;
	width: number;
	height: number;
}

/** Decodes a frame at the editor's preview size into the analysis' linear source. */
async function decodeFrame(
	dirPath: string,
	frame: Frame,
	maxPx: number,
	skipWb: boolean,
): Promise<DecodedFrame> {
	const path = await join(dirPath, frame.filename);
	if (isRawExtension(frame.filename)) {
		const buffer = await invoke<ArrayBuffer>('raw_decode', { path, maxPx, skipWb });
		const { width, height, pixels } = parseRawDecodeBuffer(buffer);
		return { src: { kind: 'linear-u16', pixels }, width, height };
	}
	const buffer = await invoke<ArrayBuffer>('decode_image_rgba', { path, maxPx });
	const { width, height, pixels } = parseDecodeImageRgbBuffer(buffer);
	return { src: { kind: 'srgb-u8', pixels }, width, height };
}

/**
 * Analyzes every negative frame of the roll, pools their bounds and stores
 * the result as `roll.baseline` (both axes on). Frames that fail to decode
 * are skipped and reported. Rejects — leaving any previous baseline
 * untouched — when cancelled, when the roll or its folder is gone, or when
 * not a single frame could be measured.
 */
export async function analyzeRoll(opts: AnalyzeRollOptions): Promise<RollAnalysisResult> {
	const { rollId, onProgress, signal } = opts;
	if (!isTauriEnv()) throw new Error('Roll analysis needs the desktop app.');

	const [roll, frames, dirPath, maxPx] = await Promise.all([
		getRoll(rollId),
		getFrames(rollId),
		getRollPath(rollId),
		previewMaxPx(),
	]);
	if (!roll) throw new Error('This roll no longer exists.');
	if (!dirPath) throw new Error('The roll’s folder is unknown.');

	const targets: NegativeTarget[] = [];
	for (const frame of frames) {
		const filmType = negativeFilmType(roll, frame);
		if (filmType !== null) targets.push({ frame, filmType });
	}
	if (targets.length === 0) throw new Error('This roll has no negative frames to analyze.');

	const measured: FrameBounds[] = [];
	const failures: FrameFailure[] = [];
	const report = (): void =>
		onProgress?.({
			done: measured.length + failures.length,
			total: targets.length,
			failed: failures.length,
		});
	report();

	for (const { frame, filmType } of targets) {
		signal?.throwIfAborted();
		try {
			const { src, width, height } = await decodeFrame(dirPath, frame, maxPx, roll.rollEdit.invert);
			signal?.throwIfAborted();
			// The frame's own bounds: the baseline must never be pooled from bounds it shaped.
			const { analysis } = analyzeNegative(src, width, height, filmType, null);
			measured.push({ id: frame.id, floors: analysis.floors, ceils: analysis.ceils });
		} catch (err) {
			if (signal?.aborted) throw signal.reason;
			failures.push({
				frameId: frame.id,
				filename: frame.filename,
				message: err instanceof Error ? err.message : String(err),
			});
		}
		report();
	}

	if (measured.length === 0) {
		throw new Error(`None of the ${targets.length} negative frames could be decoded.`);
	}
	signal?.throwIfAborted();

	const { bounds, outlierIds } = poolFrameBounds(measured);
	const baseline: RollBaseline = {
		version: ANALYSIS_VERSION,
		floors: bounds.floors,
		ceils: bounds.ceils,
		outlierFrameIds: outlierIds,
		useLuma: true,
		useColor: true,
		analyzedAt: Date.now(),
	};
	const stored = await setRollBaseline(rollId, baseline);
	if (!stored) throw new Error('This roll no longer exists.');
	return { roll: stored, baseline, analyzed: measured.length, failures };
}
