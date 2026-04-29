/**
 * Background jobs store — currently models export jobs only, but designed to
 * accommodate other long-running operations later (e.g. library scans).
 *
 * The store survives navigation because it lives in a module-level `$state`
 * singleton: any component can `import { getJobs } from '$lib/jobs.svelte'`
 * and read it; mutations from anywhere propagate to all readers.
 *
 * Design notes:
 *
 *  - Jobs are serialized globally. `startExport()` always pushes a new job
 *    in `'queued'` status; an internal queue loop pulls them one at a time.
 *    This keeps RAW decode CPU usage predictable and avoids interleaved
 *    progress reports in the dock.
 *
 *  - Cancellation is "soft": the cancel signal is checked by
 *    `exportFramesBatch` between frames, so the in-flight `invoke()` always
 *    completes (the trailing JPEG still lands on disk). We update the job's
 *    `status` synchronously when the user clicks Cancel so the dock shows
 *    "Cancelling…" immediately — no waiting for the loop to react before
 *    the UI updates.
 *
 *  - Terminal jobs (done/cancelled/error) stay in the list so the user can
 *    see the result summary in the dock, until they dismiss it. The list is
 *    auto-pruned to the most recent 5 terminal jobs to bound memory.
 */
import { exportFramesBatch } from '$lib/export/batch';
import type {
	BatchExportProgress,
	ExportScale,
} from '$lib/export/batch';
import type { Frame, Roll } from '$lib/types';

export type JobStatus =
	| 'queued'
	| 'running'
	| 'cancelling'
	| 'cancelled'
	| 'done'
	| 'error';

/**
 * Returns true while the job is occupying a worker slot or waiting for one.
 * Useful for "exporting" booleans on consumer pages.
 */
export function isJobActive(status: JobStatus): boolean {
	return status === 'queued' || status === 'running' || status === 'cancelling';
}

/** True for jobs that have stopped — done, cancelled, or errored. */
export function isJobTerminal(status: JobStatus): boolean {
	return status === 'done' || status === 'cancelled' || status === 'error';
}

export interface ExportJob {
	id:         string;
	kind:       'export';
	rollId:     string;
	rollLabel:  string;
	scale:      ExportScale;
	startedAt:  number;
	finishedAt: number | null;
	progress:   BatchExportProgress;
	status:     JobStatus;
	/** Populated once the job reaches a terminal state. */
	result:     { exported: number; skipped: number; failed: number } | null;
}

// ─── State ────────────────────────────────────────────────────────────────────

const MAX_TERMINAL_JOBS = 5;

let _jobs = $state<ExportJob[]>([]);
let _runnerActive = false;

/**
 * Per-job cancellation signals.  Lives outside `$state` because it's a
 * mutable bag of refs — we only flip `.aborted = true` on it, never read it
 * for rendering.  Indexing by job id keeps the API of `exportFramesBatch`
 * unchanged (it accepts a `{ aborted: boolean }` object).
 */
const _signals = new Map<string, { aborted: boolean }>();

/**
 * Snapshot inputs for each queued job.  Held outside `$state` because frames
 * and rolls aren't reactive in any meaningful way for the dock UI, and we
 * don't want to deep-proxy the entire dataset.
 */
interface JobInputs {
	roll:    Roll;
	frames:  Frame[];
	dirPath: string;
}
const _inputs = new Map<string, JobInputs>();

// ─── Public read API ──────────────────────────────────────────────────────────

/** Reactive view of all jobs (queued, running, terminal). */
export function getJobs(): readonly ExportJob[] {
	return _jobs;
}

/** The single job currently running or being cancelled, if any. */
export function getActiveJob(): ExportJob | null {
	return _jobs.find((j) => j.status === 'running' || j.status === 'cancelling') ?? null;
}

/**
 * Most recent job for the given roll, regardless of status.  Used by the
 * roll page to drive its inline export bar without owning any state itself.
 */
export function getJobForRoll(rollId: string): ExportJob | null {
	for (let i = _jobs.length - 1; i >= 0; i--) {
		const j = _jobs[i];
		if (j && j.rollId === rollId) return j;
	}
	return null;
}

// ─── Public write API ─────────────────────────────────────────────────────────

export interface StartExportOptions {
	rollId:    string;
	rollLabel: string;
	roll:      Roll;
	frames:    Frame[];
	dirPath:   string;
	scale:     ExportScale;
}

/**
 * Enqueue a new export job.  Returns the job's id.  If no job is running,
 * the queue loop is kicked off immediately; otherwise the new job waits its
 * turn.
 */
export function startExport(opts: StartExportOptions): string {
	const id = crypto.randomUUID();

	const job: ExportJob = {
		id,
		kind:       'export',
		rollId:     opts.rollId,
		rollLabel:  opts.rollLabel,
		scale:      opts.scale,
		startedAt:  Date.now(),
		finishedAt: null,
		progress:   {
			processed: 0,
			total:     opts.frames.length,
			current:   null,
			exported:  0,
			skipped:   0,
			failed:    [],
		},
		status:  'queued',
		result:  null,
	};

	_signals.set(id, { aborted: false });
	_inputs.set(id, {
		roll:    opts.roll,
		frames:  opts.frames,
		dirPath: opts.dirPath,
	});

	_jobs = [..._jobs, job];

	void _runQueueLoop();

	return id;
}

/**
 * Mark a job for cancellation.  Effects:
 *
 *  - If queued: removed from the queue and marked `'cancelled'`.
 *  - If running: status flips to `'cancelling'`; the trailing frame finishes
 *    and the loop bails on the next iteration check.
 *  - If already terminal: no-op.
 */
export function cancelJob(jobId: string): void {
	const job = _jobs.find((j) => j.id === jobId);
	if (!job) return;

	if (job.status === 'queued') {
		// Skip ahead to terminal — the runner will drop it on its next pull.
		_updateJob(jobId, {
			status:     'cancelled',
			finishedAt: Date.now(),
			result:     {
				exported: 0,
				skipped:  0,
				failed:   0,
			},
		});
		_signals.delete(jobId);
		_inputs.delete(jobId);
		_pruneTerminal();
		return;
	}

	if (job.status === 'running') {
		// Snapshot current progress as the final result so the dock shows
		// what got written before cancellation.  We mark the job terminal
		// *immediately* — the trailing `invoke()` for the in-flight frame
		// cannot be aborted (Tauri offers no way to cancel an in-flight
		// invoke), so it will finish in Rust and write one extra JPEG.
		// We just stop reporting progress for it and move on.
		const failedCount = job.progress.failed.length;
		_updateJob(jobId, {
			status:     'cancelled',
			finishedAt: Date.now(),
			result:     {
				exported: job.progress.exported,
				skipped:  job.progress.skipped,
				failed:   failedCount,
			},
		});
		const sig = _signals.get(jobId);
		if (sig) sig.aborted = true;
		// Note: we deliberately do NOT remove the signal/inputs here.  The
		// in-flight `exportFramesBatch` still references `signal` until the
		// trailing frame resolves; the runner will clean up afterward.
	}
	// 'cancelling' / terminal → no-op
}

/** Remove a terminal job from the dock. */
export function dismissJob(jobId: string): void {
	const job = _jobs.find((j) => j.id === jobId);
	if (!job || !isJobTerminal(job.status)) return;
	_jobs = _jobs.filter((j) => j.id !== jobId);
	_signals.delete(jobId);
	_inputs.delete(jobId);
}

/** Remove all terminal jobs from the dock. */
export function clearFinished(): void {
	const removed = _jobs.filter((j) => isJobTerminal(j.status));
	for (const j of removed) {
		_signals.delete(j.id);
		_inputs.delete(j.id);
	}
	_jobs = _jobs.filter((j) => !isJobTerminal(j.status));
}

// ─── Internal: queue loop ─────────────────────────────────────────────────────

async function _runQueueLoop(): Promise<void> {
	if (_runnerActive) return;
	_runnerActive = true;

	try {
		// Loop until no more queued jobs.  We re-read the array each iteration
		// because new jobs can be enqueued while we're running.
		// eslint-disable-next-line no-constant-condition
		while (true) {
			const next = _jobs.find((j) => j.status === 'queued');
			if (!next) break;

			const inputs = _inputs.get(next.id);
			const signal = _signals.get(next.id);
			if (!inputs || !signal) {
				// Should not happen — defensively skip.
				_updateJob(next.id, {
					status:     'error',
					finishedAt: Date.now(),
					result:     { exported: 0, skipped: 0, failed: 0 },
				});
				continue;
			}

			_updateJob(next.id, { status: 'running' });

			try {
				const result = await exportFramesBatch({
					roll:    inputs.roll,
					frames:  inputs.frames,
					dirPath: inputs.dirPath,
					scale:   next.scale,
					signal,
					onProgress: (p) => {
						// If the job was cancelled mid-run, we've already
						// written a terminal status snapshot; ignore late
						// progress events from the in-flight frame.
						const current = _jobs.find((j) => j.id === next.id);
						if (!current || isJobTerminal(current.status)) return;
						_updateJob(next.id, { progress: p });
					},
				});

				// If the job was already cancelled while we awaited (the
				// user pressed Cancel mid-run), don't overwrite the
				// terminal state captured at cancel time.
				const current = _jobs.find((j) => j.id === next.id);
				if (!current || !isJobTerminal(current.status)) {
					_updateJob(next.id, {
						status:     result.aborted ? 'cancelled' : 'done',
						finishedAt: Date.now(),
						result:     {
							exported: result.exported,
							skipped:  result.skipped,
							failed:   result.failed.length,
						},
					});
				}

				if (result.failed.length > 0) {
					console.error(
						`[jobs] export ${next.id} had ${result.failed.length} failures:`,
						result.failed,
					);
				}
			} catch (err) {
				console.error(`[jobs] export ${next.id} crashed:`, err);
				const current = _jobs.find((j) => j.id === next.id);
				if (!current || !isJobTerminal(current.status)) {
					_updateJob(next.id, {
						status:     'error',
						finishedAt: Date.now(),
						result:     {
							exported: 0,
							skipped:  0,
							failed:   1,
						},
					});
				}
			} finally {
				_signals.delete(next.id);
				_inputs.delete(next.id);
				_pruneTerminal();
			}
		}
	} finally {
		_runnerActive = false;
	}
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Apply a partial update to a job by id.  Re-creates the array reference so
 * `$derived` consumers (e.g. `getActiveJob`, `getJobForRoll`) re-evaluate.
 *
 * We intentionally swap the entire array rather than mutating the element in
 * place, because Svelte 5's `$state` proxy detects element-level mutations
 * but external `$derived` watchers reading via `_jobs.find(...)` are clearer
 * when the array identity changes — and the array is small (single digits).
 */
function _updateJob(jobId: string, patch: Partial<ExportJob>): void {
	_jobs = _jobs.map((j) => (j.id === jobId ? { ...j, ...patch } : j));
}

/** Drop the oldest terminal jobs once we exceed `MAX_TERMINAL_JOBS`. */
function _pruneTerminal(): void {
	const terminal = _jobs.filter((j) => isJobTerminal(j.status));
	if (terminal.length <= MAX_TERMINAL_JOBS) return;

	// Sort by finishedAt ascending; drop the oldest beyond the cap.
	const sorted = terminal
		.slice()
		.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
	const dropCount = terminal.length - MAX_TERMINAL_JOBS;
	const dropIds = new Set(sorted.slice(0, dropCount).map((j) => j.id));

	for (const id of dropIds) {
		_signals.delete(id);
		_inputs.delete(id);
	}
	_jobs = _jobs.filter((j) => !dropIds.has(j.id));
}
