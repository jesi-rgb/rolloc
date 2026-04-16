<script lang="ts">
	/**
	 * Frame editor route — /roll/[id]/frame/[frameId]
	 *
	 * Full-screen lightbox + WebGPU inversion pipeline + edit controls.
	 *
	 * Keyboard shortcuts:
	 *   ← / → (or j / k)  — navigate to prev / next frame
	 *   Escape             — back to roll
	 *   C                  — toggle crop mode
	 *
	 * Filmomat-style color controls (mirrors physical keyboard layout):
	 *   Q / A  — +/− Cyan
	 *   W / S  — +/− Magenta
	 *   E / D  — +/− Yellow
	 *   R / F  — +/− Grade (contrast)
	 *   T / G  — +/− Density
	 */
	import { onMount, onDestroy } from "svelte";
	import { goto } from "$app/navigation";
	import { page } from "$app/state";
	import { getRoll, getRollPath, updateRoll } from "$lib/db/rolls";
	import { join, basename } from "@tauri-apps/api/path";
	import { invoke } from "@tauri-apps/api/core";
	import { save as saveDialog } from "@tauri-apps/plugin-dialog";
	import { getFrame, getFrames, putFrame } from "$lib/db/idb";
	import { readPreview, readThumb } from "$lib/fs/opfs";
	import { ensurePreview } from "$lib/image/thumbgen";
	import { createPipeline, parseRawDecodeBuffer } from "$lib/image/pipeline";
	import { resolveEdit, DEFAULT_INVERSION_PARAMS, DEFAULT_CROP_QUAD, DEFAULT_TRANSFORM } from "$lib/types";
	import { isRawExtension } from "$lib/fs/directory";
	import type { GpuPipeline, LogPercentiles } from "$lib/image/pipeline";
	import type {
		Roll,
		Frame,
		FrameEditOverrides,
		RollEditParams,
		CurvePoints,
		WhiteBalance,
		InversionParams,
		EffectiveEdit,
		CropQuad,
		TransformParams,
	} from "$lib/types";
	import WhiteBalanceControls from "$lib/components/WhiteBalanceControls.svelte";
	import CurvesEditor from "$lib/components/CurvesEditor.svelte";
	import InversionControls from "$lib/components/InversionControls.svelte";
	import KeyboardHintBar from "$lib/components/KeyboardHintBar.svelte";
	import CropOverlay from "$lib/components/CropOverlay.svelte";
	import HorizonOverlay from "$lib/components/HorizonOverlay.svelte";
	import TransformControls from "$lib/components/TransformControls.svelte";
	import { detectHorizonCandidates, createImageData } from "$lib/image/horizon-detect";
	import type { HorizonCandidate } from "$lib/image/horizon-detect";
	import { ArrowFatUpIcon } from "phosphor-svelte";

	// ─── Undo / redo history ──────────────────────────────────────────────────

	interface HistoryEntry {
		frameEdit: FrameEditOverrides;
		rollEdit: RollEditParams;
	}

	const HISTORY_MAX = 100;

	/** Ring of snapshots; index 0 = oldest retained entry. */
	let historyStack = $state<HistoryEntry[]>([]);
	/** Points at the entry that represents the *current* state. */
	let historyCursor = $state(-1);

	const canUndo = $derived(historyCursor > 0);
	const canRedo = $derived(historyCursor < historyStack.length - 1);

	// ─── Route params ──────────────────────────────────────────────────────────

	const rollId = $derived(page.params.id ?? "");
	const frameId = $derived(page.params.frameId ?? "");

	// ─── State ─────────────────────────────────────────────────────────────────

	let roll = $state<Roll | null>(null);
	let frame = $state<Frame | null>(null);
	let frames = $state<Frame[]>([]);
	let loading = $state(true);
	let gpuError = $state<string | null>(null);
	let renderError = $state<string | null>(null);

	/** Index of the current frame within the roll's frame list. */
	const frameIndex = $derived(frames.findIndex((f) => f.id === frameId));
	const hasPrev = $derived(frameIndex > 0);
	const hasNext = $derived(frameIndex < frames.length - 1);

	// ─── Canvas + pipeline refs ────────────────────────────────────────────────

	let canvasEl = $state<HTMLCanvasElement | null>(null);
	let pipeline = $state<GpuPipeline | null>(null);
	let currentBitmap = $state<ImageBitmap | null>(null);
	/** Raw binary payload from `raw_decode`; non-null only for RAW frames. */
	let currentRawBuffer = $state<ArrayBuffer | null>(null);
	/** Original image dimensions (before any transforms). */
	let originalWidth = $state(1);
	let originalHeight = $state(1);
	/** Histogram data from the last render (for curves editor visualization). */
	let currentHistogram = $state<import('$lib/image/pipeline').ChannelHistograms | null>(null);

	// ─── Pipeline init (once, on mount) ───────────────────────────────────────

	onMount(async () => {
		if (!navigator.gpu) {
			gpuError =
				"WebGPU is not supported in this browser. Try Chrome 113+ or Edge 113+.";
			return;
		}
	});

	onDestroy(() => {
		pipeline?.destroy();
		currentBitmap?.close();
		currentRawBuffer = null;
	});

	// ─── Create pipeline once canvas is in the DOM ────────────────────────────

	$effect(() => {
		if (!canvasEl || pipeline || gpuError) return;

		createPipeline(canvasEl)
			.then((p) => {
				pipeline = p;
			})
			.catch((err: unknown) => {
				gpuError = err instanceof Error ? err.message : String(err);
			});
	});

	// ─── History helpers ──────────────────────────────────────────────────────

	/**
	 * Push the current frame/roll edit state onto the history stack.
	 * Truncates any "future" entries if we're mid-stack (after undoing).
	 * Clamps the stack to HISTORY_MAX entries.
	 */
	function historyPush(
		frameEdit: FrameEditOverrides,
		rollEdit: RollEditParams,
	): void {
		// Drop everything after the cursor (future history).
		const base = historyStack.slice(0, historyCursor + 1);
		const next = [...base, { frameEdit, rollEdit }];
		// Cap length — drop oldest entries from the front.
		const capped =
			next.length > HISTORY_MAX
				? next.slice(next.length - HISTORY_MAX)
				: next;
		historyStack = capped;
		historyCursor = capped.length - 1;
	}

	/** Seed history with the initial loaded state (no undo past load). */
	function historyInit(
		frameEdit: FrameEditOverrides,
		rollEdit: RollEditParams,
	): void {
		historyStack = [{ frameEdit, rollEdit }];
		historyCursor = 0;
	}

	async function applyHistoryEntry(entry: HistoryEntry): Promise<void> {
		if (!frame || !roll) return;
		const newFrame: Frame = {
			...($state.snapshot(frame) as Frame),
			frameEdit: entry.frameEdit,
		};
		const newRoll: Roll = {
			...($state.snapshot(roll) as Roll),
			rollEdit: entry.rollEdit,
		};
		frame = newFrame;
		roll = newRoll;
		await Promise.all([
			putFrame(structuredClone(newFrame)),
			updateRoll(structuredClone(newRoll)),
		]);
		renderFrame();
	}

	async function undo(): Promise<void> {
		if (!canUndo) return;
		historyCursor -= 1;
		await applyHistoryEntry(historyStack[historyCursor]);
	}

	async function redo(): Promise<void> {
		if (!canRedo) return;
		historyCursor += 1;
		await applyHistoryEntry(historyStack[historyCursor]);
	}

	// ─── Load frame data + image whenever frameId changes ─────────────────────

	$effect(() => {
		// Capture reactive deps up front so the effect re-runs on navigation.
		const fid = frameId;
		const rid = rollId;
		if (!fid || !rid) return;

		loading = true;
		renderError = null;
		// Clear history on frame navigation — history is per-frame, in-memory only.
		historyStack = [];
		historyCursor = -1;

		async function load(): Promise<void> {
			const [r, f, allFrames] = await Promise.all([
				getRoll(rid),
				getFrame(fid),
				getFrames(rid),
			]);

			roll = r ?? null;
			frame = f ?? null;
			frames = allFrames;

			if (!roll || !frame) {
				loading = false;
				return;
			}

			// Seed undo history with the state loaded from the database.
			// Do this before any auto-matrix save so the initial state is index 0.
			historyInit(
				$state.snapshot(frame.frameEdit) as FrameEditOverrides,
				$state.snapshot(roll.rollEdit) as RollEditParams,
			);

			// ── Load full-res image ──────────────────────────────────────────
			// For RAW files: invoke raw_decode to get linear u16 pixel data.
			// For JPEG/TIFF: generate/load a JPEG preview blob, then createImageBitmap.

			const dirPath = await getRollPath(rid);

			if (frame && isRawExtension(frame.filename) && dirPath) {
				// RAW path — full linear decode via Tauri command.
				const absolutePath = await join(dirPath, frame.filename);
				let rawBuffer: ArrayBuffer;
				try {
					// Cap at 1500px on the long edge for the editing preview.
					// Full-res decode is deferred to export. Also respect the GPU
					// texture size limit (usually 8192, but can be lower on some devices).
					const gpuLimit = pipeline?.maxTextureDimension ?? 8192;
					const maxPx = Math.min(1500, gpuLimit);
					rawBuffer = await invoke<ArrayBuffer>("raw_decode", {
						path: absolutePath,
						maxPx,
						skipWb: roll.rollEdit.invert,
					});
				} catch (err) {
					renderError = `Failed to decode RAW file: ${err instanceof Error ? err.message : String(err)}`;
					loading = false;
					return;
				}

				currentBitmap?.close();
				currentBitmap = null;
				currentRawBuffer = rawBuffer;

				// Track original dimensions for crop overlay coordinate transforms
				const { width: rawW, height: rawH } = parseRawDecodeBuffer(rawBuffer);
				originalWidth = rawW;
				originalHeight = rawH;

				// Parse the metadata to auto-populate cameraColorMatrix and ashotWBCoeffs
				// on first open.
				// Do this after setting currentRawBuffer so renderFrame() triggered
				// by saveRollEdit has it available.
				const isIdentity = (m: number[]): boolean =>
					m[0] === 1 &&
					m[1] === 0 &&
					m[2] === 0 &&
					m[3] === 0 &&
					m[4] === 1 &&
					m[5] === 0 &&
					m[6] === 0 &&
					m[7] === 0 &&
					m[8] === 1;
				const isNeutralWB = (wb: [number, number, number]): boolean =>
					wb[0] === 1 && wb[1] === 1 && wb[2] === 1;
				try {
					const { meta } = parseRawDecodeBuffer(rawBuffer);
					const wbCoeffs: [number, number, number] = [
						meta.wbCoeffs[0],
						meta.wbCoeffs[1],
						meta.wbCoeffs[2],
					];
					const needsMatrix =
						isIdentity(roll.rollEdit.cameraColorMatrix) &&
						meta.colorMatrix.some((v: number) => v !== 0);
					const needsWB =
						isNeutralWB(roll.rollEdit.ashotWBCoeffs ?? [1, 1, 1]) &&
						wbCoeffs.some((v) => v !== 1);
					if (needsMatrix || needsWB) {
						loading = false;
						await saveRollEdit({
							...(needsMatrix
								? { cameraColorMatrix: meta.colorMatrix }
								: {}),
							...(needsWB ? { ashotWBCoeffs: wbCoeffs } : {}),
						});
						return; // saveRollEdit calls renderFrame() — don't set loading=false again
					}
				} catch {
					// Non-fatal — continue without updating the matrix / WB.
				}

				loading = false;
			} else {
				// JPEG / TIFF path — generate preview blob → ImageBitmap.
				let blob: Blob | null = null;

				if (dirPath) {
					try {
						const absolutePath = await join(
							dirPath,
							frame.filename,
						);
						blob = await ensurePreview(frame.id, { absolutePath });
					} catch {
						// File missing — try OPFS cache.
					}
				}

				if (!blob) blob = await readPreview(frame.id);
				if (!blob) blob = await readThumb(frame.id);

				if (!blob) {
					renderError =
						"No preview cached for this frame. Open the roll to generate thumbnails first.";
					loading = false;
					return;
				}

				const newBitmap = await createImageBitmap(blob);
				currentBitmap?.close();
				currentBitmap = newBitmap;
				currentRawBuffer = null;
				// Track original dimensions for crop overlay coordinate transforms
				originalWidth = newBitmap.width;
				originalHeight = newBitmap.height;
			}

			loading = false;
		}

		load().catch((err: unknown) => {
			renderError = err instanceof Error ? err.message : String(err);
			loading = false;
		});
	});

	// ─── Re-render whenever pipeline + image are both ready ──────────────────

	$effect(() => {
		if (
			pipeline &&
			(currentBitmap || currentRawBuffer) &&
			roll &&
			frame &&
			!loading &&
			!exporting
		) {
			renderFrame();
		}
	});

	// ─── Re-render whenever the effective edit changes ────────────────────────

	function renderFrame(editOverride?: EffectiveEdit): void {
		if (!pipeline || !roll || !frame) return;
		const edit = editOverride ?? resolveEdit(roll, frame);
		if (currentRawBuffer) {
			console.debug(
				"[frame] renderFrame: RAW path, byteLength =",
				currentRawBuffer.byteLength,
			);
			pipeline.renderRaw(edit, currentRawBuffer).then(() => {
				// Capture histogram from lastLogPerc after render completes
				currentHistogram = pipeline?.lastLogPerc?.histograms ?? null;
			}).catch((err: unknown) => {
				console.error("[frame] renderRaw error:", err);
				renderError = err instanceof Error ? err.message : String(err);
			});
		} else if (currentBitmap) {
			console.debug(
				"[frame] renderFrame: JPEG path, bitmap =",
				currentBitmap.width,
				"x",
				currentBitmap.height,
			);
			pipeline.render(edit, currentBitmap).then(() => {
				// Capture histogram from lastLogPerc after render completes
				currentHistogram = pipeline?.lastLogPerc?.histograms ?? null;
			}).catch((err: unknown) => {
				console.error("[frame] render error:", err);
				renderError = err instanceof Error ? err.message : String(err);
			});
		} else {
			console.warn(
				"[frame] renderFrame called but no image data available",
			);
		}
	}

	// ─── WB picker ────────────────────────────────────────────────────────────

	/** When true the canvas cursor changes to crosshair and the next click samples a pixel. */
	let wbPickerActive = $state(false);

	/**
	 * CMY_MAX_DENSITY from pipeline.ts — the scale factor for CMY slider units to
	 * log-density. Must stay in sync with the constant in pipeline.ts.
	 */
	const CMY_MAX_DENSITY = 0.15;

	function toggleWbPicker(): void {
		wbPickerActive = !wbPickerActive;
	}

	function cancelWbPicker(): void {
		wbPickerActive = false;
	}

	// ─── Crop mode ────────────────────────────────────────────────────────────
	//
	// Non-destructive workflow:
	// - While in crop mode: show the FULL uncropped canvas, overlay shows crop region
	// - User drags handles to position the crop (only updates overlay, no saves)
	// - On exit: save the crop position AND apply it (resize canvas)
	// - Re-entering crop mode: show full canvas again for adjustment

	/** When true, the crop overlay is visible and editable. */
	let cropModeActive = $state(false);

	/** When true, user is dragging the fine rotation slider — show denser alignment grid. */
	let fineRotating = $state(false);

	/** Local crop quad state while editing (not yet committed to frame). */
	let localCropQuad = $state<CropQuad | null>(null);

	/** Effective crop quad for the overlay: local state while editing, otherwise from frame. */
	const effectiveCropQuad = $derived.by(() => {
		if (localCropQuad) return localCropQuad;
		if (!frame || !roll) return DEFAULT_CROP_QUAD;
		return resolveEdit(roll, frame).cropQuad ?? DEFAULT_CROP_QUAD;
	});

	/**
	 * Render the canvas without crop applied (for crop mode editing).
	 * Keeps transforms (rotation/flip) active so user sees the final orientation
	 * while editing the crop. The CropOverlay transforms coordinates to/from
	 * original image space.
	 */
	function renderUncropped(): void {
		if (!pipeline || !roll || !frame) return;
		const edit = resolveEdit(roll, frame);
		// Render with cropQuad = null but KEEP transforms
		// The crop overlay will transform its coordinates to match
		renderFrame({ ...edit, cropQuad: null });
	}

	function toggleCropMode(): void {
		if (cropModeActive) {
			// Exiting crop mode — commit and apply the crop
			commitCropAndExit();
		} else {
			// Entering crop mode — show full uncropped image
			cropModeActive = true;
			// Initialize local quad from saved state (or default if none)
			if (frame && roll) {
				localCropQuad = resolveEdit(roll, frame).cropQuad ?? DEFAULT_CROP_QUAD;
			} else {
				localCropQuad = DEFAULT_CROP_QUAD;
			}
			renderUncropped();
		}
	}

	/**
	 * Commit the current crop position to IDB and exit crop mode.
	 * This is the only place where crop is saved and applied.
	 */
	function commitCropAndExit(): void {
		if (!frame || !roll) {
			cropModeActive = false;
			localCropQuad = null;
			return;
		}

		const quad = localCropQuad ?? DEFAULT_CROP_QUAD;

		// Check if the quad is effectively the identity (full image, no crop)
		const isIdentity =
			quad.tl.x === 0 && quad.tl.y === 0 &&
			quad.tr.x === 1 && quad.tr.y === 0 &&
			quad.br.x === 1 && quad.br.y === 1 &&
			quad.bl.x === 0 && quad.bl.y === 1;

		// Store null for identity crop to save space and indicate "no crop"
		const cropToStore = isIdentity ? null : quad;

		// Update frame state
		const snap = $state.snapshot(frame) as Frame;
		const updatedEdit: FrameEditOverrides = { ...snap.frameEdit, cropQuad: cropToStore };
		frame = { ...snap, frameEdit: updatedEdit };

		// Exit crop mode
		cropModeActive = false;
		localCropQuad = null;

		// Re-render with the crop applied
		renderFrame();

		// Save to IDB + push history
		const s = $state.snapshot(frame) as Frame;
		historyPush(
			structuredClone(s.frameEdit) as FrameEditOverrides,
			$state.snapshot(roll).rollEdit as RollEditParams,
		);
		putFrame(structuredClone(s)).catch((err: unknown) => {
			console.error("[crop] putFrame failed:", err);
		});
	}

	/**
	 * Live update while dragging a crop corner.
	 * Only updates the overlay position — does NOT save or re-render.
	 * The canvas stays showing the full uncropped image.
	 */
	function onCropChange(quad: CropQuad): void {
		localCropQuad = quad;
	}

	/**
	 * Cancel crop mode without saving changes.
	 * Reverts to the previously saved crop and re-renders.
	 */
	function cancelCrop(): void {
		cropModeActive = false;
		localCropQuad = null;
		// Re-render with the previously saved crop (not the local edits)
		renderFrame();
	}

	// ─── Horizon detection mode ───────────────────────────────────────────────
	//
	// Auto-straighten workflow:
	// 1. User clicks "Auto" button in TransformControls
	// 2. We read canvas pixels and run Hough line detection
	// 3. Show detected lines as overlay for user to select
	// 4. User clicks a line to select it (preview updates rotation)
	// 5. User clicks Apply → commit rotation, or Cancel → revert

	/** Whether horizon detection is running. */
	let detectingHorizon = $state(false);

	/** Detected horizon/vertical line candidates. */
	let horizonCandidates = $state<HorizonCandidate[]>([]);

	/** Currently selected candidate index (for preview). */
	let selectedHorizonIndex = $state<number | null>(null);

	/** Rotation value before horizon detection started (for cancel/revert). */
	let preHorizonRotation = $state<number>(0);

	/** Whether the horizon overlay is active (showing candidates). */
	const horizonModeActive = $derived(horizonCandidates.length > 0);

	/**
	 * Start horizon detection: read canvas pixels and find lines.
	 */
	async function startHorizonDetection(): Promise<void> {
		if (!pipeline || !canvasEl) return;

		detectingHorizon = true;

		try {
			// Read current canvas pixels
			const w = pipeline.lastOutputWidth;
			const h = pipeline.lastOutputHeight;
			const pixels = await pipeline.readPixels(0, 0, w, h);

			if (!pixels) {
				console.error('[horizon] Failed to read pixels from canvas');
				return;
			}

			// Create ImageData and run detection
			const imageData = createImageData(pixels, w, h);
			const candidates = detectHorizonCandidates(imageData);

			if (candidates.length === 0) {
				console.log('[horizon] No lines detected');
				// Do nothing — user just sees no overlay
				return;
			}

			console.log('[horizon] Found', candidates.length, 'candidates');

			// Store pre-detection rotation for revert on cancel
			preHorizonRotation = effectiveTransform.rotation;

			// Set candidates and auto-select the first (highest confidence)
			horizonCandidates = candidates;
			selectedHorizonIndex = 0;

			// Preview the first candidate's rotation
			applyHorizonPreview(0);
		} finally {
			detectingHorizon = false;
		}
	}

	/**
	 * Preview a horizon candidate by applying its rotation.
	 */
	function applyHorizonPreview(index: number): void {
		const candidate = horizonCandidates[index];
		if (!candidate) return;

		// Apply the rotation adjustment (additive to current fine rotation base)
		const newRotation = preHorizonRotation + candidate.angle;
		onTransformChange({ ...effectiveTransform, rotation: newRotation });
	}

	/**
	 * Called when user selects a horizon candidate.
	 */
	function onHorizonSelect(index: number): void {
		selectedHorizonIndex = index;
		applyHorizonPreview(index);
	}

	/**
	 * Called when user clicks Apply — commit the selected rotation.
	 */
	function onHorizonApply(): void {
		if (selectedHorizonIndex === null) return;

		const candidate = horizonCandidates[selectedHorizonIndex];
		if (!candidate) return;

		// Calculate the final rotation to commit
		const finalRotation = preHorizonRotation + candidate.angle;
		const finalTransform: TransformParams = {
			...effectiveTransform,
			rotation: finalRotation,
		};

		// Clear horizon mode first (so effectiveTransform doesn't change during commit)
		horizonCandidates = [];
		selectedHorizonIndex = null;

		// Commit the transform with the calculated rotation
		onTransformCommit(finalTransform);
	}

	/**
	 * Called when user cancels horizon mode — revert rotation.
	 */
	function onHorizonCancel(): void {
		// Revert to pre-detection rotation
		onTransformChange({ ...effectiveTransform, rotation: preHorizonRotation });

		// Clear horizon mode
		horizonCandidates = [];
		selectedHorizonIndex = null;
	}

	/**
	 * Sample a pixel from the last rendered output via GPU readback, treat it as
	 * the white/neutral point, and adjust the global CMY sliders accordingly.
	 *
	 * Uses pipeline.readPixels() which copies from the rgba8unorm output texture —
	 * the only reliable readback path for WebGPU canvases in Tauri.
	 */
	function handleWbPickerClick(e: MouseEvent): void {
		if (!wbPickerActive || !canvasEl || !pipeline) return;

		// Map pointer coords (CSS px) to canvas pixel coords.
		const rect = canvasEl.getBoundingClientRect();
		const scaleX = canvasEl.width / rect.width;
		const scaleY = canvasEl.height / rect.height;
		const px = Math.round((e.clientX - rect.left) * scaleX);
		const py = Math.round((e.clientY - rect.top) * scaleY);

		wbPickerActive = false;

		// Capture frame/roll refs before entering async context.
		if (!frame || !roll) return;
		const currentFrame = frame;
		const currentRoll = roll;

		// Sample a 3×3 neighbourhood centred on the click to reduce noise.
		const sampleSize = 3;
		const half = Math.floor(sampleSize / 2);
		const x0 = Math.max(0, px - half);
		const y0 = Math.max(0, py - half);
		const w = Math.min(sampleSize, canvasEl.width - x0);
		const h = Math.min(sampleSize, canvasEl.height - y0);

		pipeline
			.readPixels(x0, y0, w, h)
			.then((pixels) => {
				if (!pixels) return;
				const n = w * h;

				let sumR = 0,
					sumG = 0,
					sumB = 0;
				for (let i = 0; i < n; i++) {
					sumR += pixels[i * 4];
					sumG += pixels[i * 4 + 1];
					sumB += pixels[i * 4 + 2];
				}

				const r = Math.max(sumR / n / 255, 1e-6);
				const g = Math.max(sumG / n / 255, 1e-6);
				const b = Math.max(sumB / n / 255, 1e-6);

				// Ignore near-black samples — not useful as a white reference.
				if (r < 1e-4 && g < 1e-4 && b < 1e-4) return;

				const current = resolveEdit(
					currentRoll,
					currentFrame,
				).inversionParams;

				// Negpy algorithm (calculate_wb_shifts / _handle_wb_pick):
				//   Red is the anchor channel — cyan is always reset to 0.
				//   Magenta delta = log10(g/r) / CMY_MAX_DENSITY
				//   Yellow  delta = log10(b/r) / CMY_MAX_DENSITY
				//   A damping factor of 0.4 prevents overcorrection on the first click.
				const DAMPING = 0.4;
				const deltaMagenta =
					(Math.log10(g / r) / CMY_MAX_DENSITY) * DAMPING;
				const deltaYellow =
					(Math.log10(b / r) / CMY_MAX_DENSITY) * DAMPING;

				const clamp = (v: number): number =>
					Math.max(-1, Math.min(1, v));

				saveEdit({
					inversionParams: {
						...current,
						cmyCyan: 0,
						cmyMagenta: clamp(current.cmyMagenta + deltaMagenta),
						cmyYellow: clamp(current.cmyYellow + deltaYellow),
					},
				});
			})
			.catch((err: unknown) => {
				console.error("[wb-picker] readPixels failed:", err);
			});
	}

	// ─── Edit helpers ──────────────────────────────────────────────────────────

	async function saveEdit(patch: Partial<FrameEditOverrides>): Promise<void> {
		if (!frame || !roll) return;
		const snap = $state.snapshot(frame) as Frame;
		const updatedEdit: FrameEditOverrides = { ...snap.frameEdit, ...patch };
		const updated: Frame = { ...snap, frameEdit: updatedEdit };
		// Push the *new* state onto history before mutating reactive state.
		historyPush(
			structuredClone(updatedEdit),
			$state.snapshot(roll).rollEdit as RollEditParams,
		);
		frame = updated;
		await putFrame(structuredClone(updated));
		renderFrame();
	}

	async function saveRollEdit(patch: Partial<RollEditParams>): Promise<void> {
		if (!roll || !frame) return;
		const snap = $state.snapshot(roll) as Roll;
		const updatedRollEdit: RollEditParams = { ...snap.rollEdit, ...patch };
		const updatedRoll: Roll = { ...snap, rollEdit: updatedRollEdit };
		roll = updatedRoll;
		// Push the *new* state onto history before mutating reactive state.
		historyPush(
			$state.snapshot(frame).frameEdit as FrameEditOverrides,
			structuredClone(updatedRollEdit),
		);
		await updateRoll(structuredClone(updatedRoll));
		renderFrame();
	}

	function onWBChange(wb: WhiteBalance): void {
		saveEdit({ whiteBalance: wb });
	}

	/**
	 * Live preview while dragging an inversion slider.
	 * Renders the GPU canvas immediately with patched params — zero reactive
	 * state mutations, zero IDB writes, zero Svelte re-renders.
	 */
	function onInversionChange(params: InversionParams): void {
		if (!roll || !frame) return;
		const edit = resolveEdit(roll, frame);
		renderFrame({ ...edit, inversionParams: params });
	}

	/** 500ms debounce handle — coalesces rapid commits into one IDB write + history entry. */
	let inversionCommitTimer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * Apply inversion params immediately (updates frame state + GPU render),
	 * then debounce the IDB write + history push by 500ms so rapid changes
	 * (key-hold, quick taps) coalesce into a single undo entry.
	 */
	function onInversionCommit(params: InversionParams): void {
		if (!frame || !roll) return;
		// Apply immediately — update frame state so sliders and derived values
		// reflect the new value right away, without waiting for the IDB write.
		const snap = $state.snapshot(frame) as Frame;
		frame = {
			...snap,
			frameEdit: { ...snap.frameEdit, inversionParams: params },
		};
		// Re-render from the now-updated frame state.
		renderFrame();
		// Debounce the expensive work: IDB write + history push.
		if (inversionCommitTimer !== null) clearTimeout(inversionCommitTimer);
		inversionCommitTimer = setTimeout(() => {
			inversionCommitTimer = null;
			if (!frame || !roll) return;
			const s = $state.snapshot(frame) as Frame;
			historyPush(
				structuredClone(s.frameEdit) as FrameEditOverrides,
				$state.snapshot(roll).rollEdit as RollEditParams,
			);
			putFrame(structuredClone(s)).catch((err: unknown) => {
				console.error("[inversion] putFrame failed:", err);
			});
		}, 500);
	}

	// ─── Transform handlers ───────────────────────────────────────────────────

	// ─── Fine-tune helpers (Filmomat keyboard layout) ─────────────────────────

	/**
	 * Nudge a single inversion parameter by `delta`, clamped to [min, max].
	 * When `shift` is true the delta is multiplied by 10 for quicker coarse iteration.
	 * Applies immediately via onInversionCommit (instant frame state update +
	 * GPU render) with debounced IDB persist.
	 */
	function nudgeInversion(
		key: keyof InversionParams,
		delta: number,
		min: number,
		max: number,
		shift: boolean = false,
	): void {
		if (!roll || !frame) return;
		// Always read from current frame state — it is updated immediately on
		// every nudge so successive taps accumulate correctly.
		const current = effectiveInversionParams;
		const raw = (current[key] as number) + delta * (shift ? 10 : 1);
		const clamped =
			Math.round(Math.min(max, Math.max(min, raw)) * 1000) / 1000;
		onInversionCommit({ ...current, [key]: clamped });
	}

	type Channel = "global" | "r" | "g" | "b";

	/**
	 * Live preview while dragging a curve control point.
	 * Renders the GPU canvas immediately with patched curves — zero reactive
	 * state mutations, zero IDB writes, zero Svelte re-renders.
	 */
	function onCurveChange(channel: Channel, curve: CurvePoints): void {
		if (!roll || !frame) return;
		const edit = resolveEdit(roll, frame);
		if (channel === "global") {
			renderFrame({ ...edit, toneCurve: curve });
		} else {
			const existing = edit.rgbCurves;
			const updated: [CurvePoints, CurvePoints, CurvePoints] = [
				existing[0],
				existing[1],
				existing[2],
			];
			if (channel === "r") updated[0] = curve;
			else if (channel === "g") updated[1] = curve;
			else updated[2] = curve;
			renderFrame({ ...edit, rgbCurves: updated });
		}
	}

	/** 500ms debounce handle — coalesces rapid curve commits into one IDB write + history entry. */
	let curveCommitTimer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * Commit a curve change: update frame state immediately so derived
	 * values reflect the new curve, then debounce the IDB write + history push
	 * so rapid add/remove/reset actions coalesce into a single undo entry.
	 */
	function onCurveCommit(channel: Channel, curve: CurvePoints): void {
		if (!frame || !roll) return;
		const snap = $state.snapshot(frame) as Frame;

		let patch: Partial<FrameEditOverrides>;
		if (channel === "global") {
			patch = { toneCurve: curve };
		} else {
			const existing =
				snap.frameEdit.rgbCurves ??
				(roll ? [...roll.rollEdit.baseRGBCurves] : null);
			if (!existing) return;
			const updated: [CurvePoints, CurvePoints, CurvePoints] = [
				existing[0],
				existing[1],
				existing[2],
			];
			if (channel === "r") updated[0] = curve;
			else if (channel === "g") updated[1] = curve;
			else updated[2] = curve;
			patch = { rgbCurves: updated };
		}

		// Apply immediately — update frame state so curves and derived values
		// reflect the new value right away, without waiting for the IDB write.
		const updatedEdit: FrameEditOverrides = { ...snap.frameEdit, ...patch };
		frame = { ...snap, frameEdit: updatedEdit };
		// Re-render from the now-updated frame state.
		renderFrame();

		// Debounce the expensive work: IDB write + history push.
		if (curveCommitTimer !== null) clearTimeout(curveCommitTimer);
		curveCommitTimer = setTimeout(() => {
			curveCommitTimer = null;
			if (!frame || !roll) return;
			const s = $state.snapshot(frame) as Frame;
			historyPush(
				structuredClone(s.frameEdit) as FrameEditOverrides,
				$state.snapshot(roll).rollEdit as RollEditParams,
			);
			putFrame(structuredClone(s)).catch((err: unknown) => {
				console.error("[curves] putFrame failed:", err);
			});
		}, 500);
	}

	// ─── Transform handlers ───────────────────────────────────────────────────

	/**
	 * Live preview while adjusting transform (rotation, flip).
	 * Renders the GPU canvas immediately with patched transform.
	 */
	function onTransformChange(params: TransformParams): void {
		if (!roll || !frame) return;
		const edit = resolveEdit(roll, frame);
		renderFrame({ ...edit, transform: params });
	}

	/** 500ms debounce handle for transform commits. */
	let transformCommitTimer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * Commit transform changes: update frame state immediately, then
	 * debounce IDB write + history push.
	 */
	function onTransformCommit(params: TransformParams): void {
		if (!frame || !roll) return;
		const snap = $state.snapshot(frame) as Frame;
		frame = {
			...snap,
			frameEdit: { ...snap.frameEdit, transform: params },
		};
		renderFrame();

		if (transformCommitTimer !== null) clearTimeout(transformCommitTimer);
		transformCommitTimer = setTimeout(() => {
			transformCommitTimer = null;
			if (!frame || !roll) return;
			const s = $state.snapshot(frame) as Frame;
			historyPush(
				structuredClone(s.frameEdit) as FrameEditOverrides,
				$state.snapshot(roll).rollEdit as RollEditParams,
			);
			putFrame(structuredClone(s)).catch((err: unknown) => {
				console.error("[transform] putFrame failed:", err);
			});
		}, 500);
	}

	// ─── Export ────────────────────────────────────────────────────────────────

	let exporting = $state(false);
	let exportError = $state<string | null>(null);
	let exportSuccess = $state(false);

	/**
	 * Export the current frame as a full-quality JPEG.
	 *
	 * RAW frames: call `export_native` which decodes the RAW at full sensor
	 * resolution and processes entirely in Rust at f32 precision — no GPU
	 * texture size limits, no 8-bit quantization until the final JPEG encode.
	 * Log percentiles from the preview render are passed so colour normalization
	 * matches what the user sees.
	 *
	 * JPEG/TIFF frames: re-render the existing bitmap through the GPU pipeline,
	 * readback pixels, and encode via `export_jpeg`.
	 */
	async function exportFrame(): Promise<void> {
		if (!pipeline || !frame || !roll || exporting) return;

		exporting = true;
		exportError = null;
		exportSuccess = false;

		try {
			const currentFrame = frame;
			const currentRoll = roll;
			const edit = resolveEdit(currentRoll, currentFrame);

			// ── Suggest a default filename ─────────────────────────────────
			const stem = (
				await basename(currentFrame.filename).catch(
					() => currentFrame.filename,
				)
			).replace(/\.[^.]+$/, "");
			const defaultFileName = `${stem}_export.jpg`;

			// ── Open native Save As dialog ─────────────────────────────────
			const savePath = await saveDialog({
				title: "Export JPEG",
				defaultPath: defaultFileName,
				filters: [{ name: "JPEG Image", extensions: ["jpg", "jpeg"] }],
			});

			if (!savePath) {
				// User cancelled.
				return;
			}

			// Ensure .jpg extension on the path (dialog may or may not append it).
			const finalPath =
				savePath.endsWith(".jpg") || savePath.endsWith(".jpeg")
					? savePath
					: `${savePath}.jpg`;

			if (isRawExtension(currentFrame.filename)) {
				// ── RAW path: native f32 export via Rust ───────────────────
				const dirPath = await getRollPath(rollId);
				if (!dirPath) {
					throw new Error("Roll source directory not found.");
				}
				const absolutePath = await join(dirPath, currentFrame.filename);

				// Reuse log percentiles from the preview render so the
				// colour normalization is identical to what the user sees.
				const logPerc: LogPercentiles | null =
					pipeline.lastLogPerc ?? null;

				await invoke("export_native", {
					sourcePath: absolutePath,
					exportPath: finalPath,
					edit,
					logPerc,
					skipWb: currentRoll.rollEdit.invert,
					quality: 95,
				});
			} else {
				// ── JPEG/TIFF path: GPU readback ───────────────────────────
				if (!currentBitmap) {
					throw new Error("No image loaded for this frame.");
				}
				console.debug(
					"[export] JPEG path, rendering bitmap",
					currentBitmap.width,
					"x",
					currentBitmap.height,
					"edit:",
					edit,
				);
				await pipeline.render(edit, currentBitmap);

				// Get the actual output dimensions (after crop is applied)
				const exportWidth = pipeline.lastOutputWidth;
				const exportHeight = pipeline.lastOutputHeight;
				console.debug("[export] render complete, output size:", exportWidth, "x", exportHeight);

				// Readback rendered pixels from GPU
				const pixels = await pipeline.readPixels(
					0,
					0,
					exportWidth,
					exportHeight,
				);
				if (!pixels) {
					throw new Error(
						"Failed to read back rendered pixels from GPU.",
					);
				}

				await invoke("export_jpeg", {
					pixels: Array.from(pixels),
					width: exportWidth,
					height: exportHeight,
					path: finalPath,
					quality: 95,
				});
			}

			exportSuccess = true;
			// Auto-clear the success message after 3 seconds.
			setTimeout(() => {
				exportSuccess = false;
			}, 3000);

			// Re-render at the current (preview) resolution so the canvas shows
			// the editing preview again.
			renderFrame();
		} catch (err: unknown) {
			exportError = err instanceof Error ? err.message : String(err);
		} finally {
			exporting = false;
		}
	}

	// ─── Navigation ────────────────────────────────────────────────────────────

	function navigateTo(idx: number): void {
		const target = frames[idx];
		if (!target) return;
		goto(`/roll/${rollId}/frame/${target.id}`);
	}

	/** Throttle map: last timestamp each hotkey was processed (ms). */
	const keyLastFired = new Map<string, number>();
	const KEY_THROTTLE_MS = 150;

	async function handleKeydown(e: KeyboardEvent): Promise<void> {
		const el = e.target as HTMLElement | null;
		const tag = el?.tagName;
		if (tag === "TEXTAREA") return;
		if (tag === "INPUT") {
			const inputType = (el as HTMLInputElement).type;
			if (inputType !== "range") return;
			// For range inputs, block only the keys that move the slider vertically
			// or jump to endpoints — ArrowLeft/Right are reserved for frame navigation.
			const rangeNativeKeys = new Set([
				"ArrowUp",
				"ArrowDown",
				"Home",
				"End",
				"PageUp",
				"PageDown",
			]);
			if (rangeNativeKeys.has(e.key)) return;
		}

		// Undo / redo — intercept before other single-key shortcuts.
		if (e.key === "z" && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			if (e.shiftKey) {
				await redo();
			} else {
				await undo();
			}
			return;
		}
		if (e.key === "y" && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			await redo();
			return;
		}

		switch (e.key) {
			// ── Filmomat-style color controls ──────────────────────────────────
			// Top row (Q–Y) = positive nudges; bottom row (A–H) = negative nudges.
			// Q/A → Cyan  |  W/S → Magenta  |  E/D → Yellow
			// R/F → Grade  |  T/G → Density
			// Hold Shift for 10× step.
			case "q":
			case "Q":
			case "a":
			case "A":
			case "w":
			case "W":
			case "s":
			case "S":
			case "e":
			case "E":
			case "d":
			case "D":
			case "r":
			case "R":
			case "f":
			case "F":
			case "t":
			case "T":
			case "g":
			case "G": {
				// Throttle nudge keys to KEY_THROTTLE_MS to prevent runaway key-repeat.
				const k = e.key.toLowerCase();
				const now = performance.now();
				if (now - (keyLastFired.get(k) ?? 0) < KEY_THROTTLE_MS) return;
				keyLastFired.set(k, now);
				e.preventDefault();
				switch (k) {
					case "q":
						nudgeInversion("cmyCyan", +0.01, -1, 1, e.shiftKey);
						break;
					case "a":
						nudgeInversion("cmyCyan", -0.01, -1, 1, e.shiftKey);
						break;
					case "w":
						nudgeInversion("cmyMagenta", +0.01, -1, 1, e.shiftKey);
						break;
					case "s":
						nudgeInversion("cmyMagenta", -0.01, -1, 1, e.shiftKey);
						break;
					case "e":
						nudgeInversion("cmyYellow", +0.01, -1, 1, e.shiftKey);
						break;
					case "d":
						nudgeInversion("cmyYellow", -0.01, -1, 1, e.shiftKey);
						break;
					case "r":
						nudgeInversion("grade", +0.1, 0, 10, e.shiftKey);
						break;
					case "f":
						nudgeInversion("grade", -0.1, 0, 10, e.shiftKey);
						break;
					case "t":
						nudgeInversion("density", +0.01, 0, 10, e.shiftKey);
						break;
					case "g":
						nudgeInversion("density", -0.01, 0, 10, e.shiftKey);
						break;
				}
				break;
			}
			// ── Frame navigation ───────────────────────────────────────────────
			case "ArrowLeft":
			case "k":
				e.preventDefault();
				if (hasPrev) navigateTo(frameIndex - 1);
				break;
			case "ArrowRight":
			case "j":
				e.preventDefault();
				if (hasNext) navigateTo(frameIndex + 1);
				break;
			case "c":
			case "C":
				// Toggle crop mode (unless modifier keys are held)
				if (!e.metaKey && !e.ctrlKey && !e.altKey) {
					e.preventDefault();
					toggleCropMode();
				}
				break;
			case "Escape":
				e.preventDefault();
				if (cropModeActive) {
					cancelCrop();
				} else if (wbPickerActive) {
					cancelWbPicker();
				} else {
					goto(`/roll/${rollId}`);
				}
				break;
			case "Enter":
				if (cropModeActive) {
					e.preventDefault();
					commitCropAndExit();
				}
				break;
		}
	}

	// ─── Derived edit values for controls ─────────────────────────────────────

	/** Effective WB for the controls (frame override or roll default). */
	const effectiveWB = $derived.by(() => {
		if (!frame || !roll) return { temperature: 5500, tint: 0 };
		return resolveEdit(roll, frame).whiteBalance;
	});

	const effectiveToneCurve = $derived.by(() => {
		if (!frame || !roll)
			return {
				points: [
					{ x: 0, y: 0 },
					{ x: 1, y: 1 },
				],
			};
		return resolveEdit(roll, frame).toneCurve;
	});

	const effectiveRGBCurves = $derived.by(() => {
		const identity = {
			points: [
				{ x: 0, y: 0 },
				{ x: 1, y: 1 },
			],
		};
		const fallback: [typeof identity, typeof identity, typeof identity] = [
			identity,
			identity,
			identity,
		];
		if (!frame || !roll) return fallback;
		const curves = resolveEdit(roll, frame).rgbCurves;
		// Guard against old DB records or transient undo state where baseRGBCurves
		// may be undefined or a partial array.
		if (!Array.isArray(curves) || curves.length < 3) return fallback;
		return curves as [typeof identity, typeof identity, typeof identity];
	});

	const effectiveInversionParams = $derived.by(() => {
		if (!frame || !roll) return DEFAULT_INVERSION_PARAMS;
		return resolveEdit(roll, frame).inversionParams;
	});

	const effectiveTransform = $derived.by(() => {
		if (!frame || !roll) return DEFAULT_TRANSFORM;
		return resolveEdit(roll, frame).transform;
	});

	const frameLabel = $derived(frame ? `Frame ${frame.index}` : "Frame");
</script>

<svelte:head>
	<title>{frameLabel} — {roll?.label ?? "Roll"} — Rolloc</title>
</svelte:head>

<svelte:window onkeydown={handleKeydown} />

<div class="h-screen bg-base text-content flex flex-col overflow-hidden">
	<!-- ── Top bar ──────────────────────────────────────────────────────────── -->
	<header
		class="shrink-0 flex items-center gap-base px-l py-sm border-b border-base-subtle"
	>
		<a
			href="/roll/{rollId}"
			class="text-content-muted hover:text-content transition text-sm"
			>← Roll</a
		>

		{#if roll}
			<span class="text-content-muted text-sm">{roll.label}</span>
		{/if}

		{#if frame}
			<span class="text-content font-semibold">{frame.filename}</span>
		{/if}

		<!-- Frame navigation arrows -->
		<div class="ml-auto flex items-center gap-xs">
			{#if frames.length > 0}
				<span class="text-xs text-content-subtle">
					{frameIndex + 1} / {frames.length}
				</span>
			{/if}
			<button
				onclick={() => navigateTo(frameIndex - 1)}
				disabled={!hasPrev}
				aria-label="Previous frame"
				class="w-8 h-8 flex items-center justify-center rounded
				       border border-base-subtle text-content-muted
				       hover:text-content hover:border-content-muted
				       disabled:opacity-30 disabled:cursor-not-allowed transition">←</button
			>
			<button
				onclick={() => navigateTo(frameIndex + 1)}
				disabled={!hasNext}
				aria-label="Next frame"
				class="w-8 h-8 flex items-center justify-center rounded
				       border border-base-subtle text-content-muted
				       hover:text-content hover:border-content-muted
				       disabled:opacity-30 disabled:cursor-not-allowed transition">→</button
			>
		</div>
	</header>

	<!-- ── Main editor layout (always mounted so canvas persists) ──────────── -->
	<div class="flex-1 min-h-0 flex overflow-hidden relative">
		<!-- Canvas / preview area — always in DOM so the pipeline stays alive -->
		<div
			class="flex-1 min-w-0 flex items-center justify-center bg-base-muted overflow-hidden p-base relative"
		>
			<!-- Canvas container: flip transforms applied via CSS, rotation + zoom via GPU UV remapping.
			     w-full h-full + max-w-fit max-h-fit ensures the wrapper takes the full available
			     space while shrinking to fit the canvas, allowing max-w-full/max-h-full on the
			     canvas to reference the actual container dimensions. -->
			<div class="relative w-full h-full max-w-fit max-h-fit flex items-center justify-center">
				<canvas
					bind:this={canvasEl}
					onclick={handleWbPickerClick}
					class="max-w-full max-h-full object-contain shadow-lg rounded"
					style="display: block; cursor: {wbPickerActive
						? 'crosshair'
						: cropModeActive
							? 'crosshair'
							: 'default'}; transform: {effectiveTransform.flipH || effectiveTransform.flipV
						? `scale(${effectiveTransform.flipH ? -1 : 1}, ${effectiveTransform.flipV ? -1 : 1})`
						: 'none'};"
				></canvas>

				<!-- Crop overlay (inside transform wrapper so it rotates with canvas) -->
				{#if cropModeActive && canvasEl}
					<CropOverlay
						canvas={canvasEl}
						value={effectiveCropQuad}
						onChange={onCropChange}
						{fineRotating}
					/>
				{/if}

				<!-- Horizon detection overlay -->
				{#if horizonModeActive && canvasEl}
					<HorizonOverlay
						canvas={canvasEl}
						candidates={horizonCandidates}
						selectedIndex={selectedHorizonIndex}
						onSelect={onHorizonSelect}
						onApply={onHorizonApply}
						onCancel={onHorizonCancel}
					/>
				{/if}
			</div>

			<!-- WB picker hint overlay -->
			{#if wbPickerActive}
				<div
					class="absolute bottom-base left-1/2 -translate-x-1/2 flex items-center gap-sm
					       bg-base/90 border border-primary text-content text-xs px-sm py-xs rounded shadow-lg pointer-events-none"
				>
					Click a neutral white or gray area to set color balance
					<button
						class="pointer-events-auto text-content-muted hover:text-content transition ml-xs"
						onclick={cancelWbPicker}
						aria-label="Cancel WB picker">Cancel</button
					>
				</div>
			{/if}

			<!-- Loading overlay -->
			{#if loading}
				<div
					class="absolute inset-0 flex items-center justify-center bg-base-muted text-content-muted"
				>
					Loading…
				</div>
			{/if}

			<!-- GPU error overlay -->
			{#if gpuError}
				<div
					class="absolute inset-0 flex flex-col items-center justify-center gap-base text-center px-l bg-base-muted"
				>
					<div class="text-5xl opacity-30">⚠</div>
					<h2 class="text-xl font-semibold text-content">
						WebGPU unavailable
					</h2>
					<p class="text-content-muted max-w-sm text-sm">
						{gpuError}
					</p>
					<a
						href="/roll/{rollId}"
						class="text-sm text-primary hover:underline"
						>← Back to roll</a
					>
				</div>
			{/if}

			<!-- Frame not found overlay -->
			{#if !loading && !gpuError && (!roll || !frame)}
				<div
					class="absolute inset-0 flex items-center justify-center bg-base-muted text-content-muted"
				>
					Frame not found.
				</div>
			{/if}

			<!-- Render error overlay -->
			{#if renderError}
				<div
					class="absolute inset-0 flex flex-col items-center justify-center gap-base text-center px-l bg-base-muted"
				>
					<div class="text-5xl opacity-30">⚠</div>
					<h2 class="text-xl font-semibold text-content">
						Preview unavailable
					</h2>
					<p class="text-content-muted max-w-sm text-sm">
						{renderError}
					</p>
					<a
						href="/roll/{rollId}"
						class="text-sm text-primary hover:underline"
						>← Back to roll</a
					>
				</div>
			{/if}
		</div>

		<!-- Edit panel sidebar -->
		<aside
			class="w-72 shrink-0 border-l border-base-subtle bg-base
			       overflow-y-auto flex flex-col"
		>
			<div class="flex flex-col gap-l p-l">
				{#if roll && frame}
					<!-- Undo / Redo -->
					<section>
						<div class="flex items-center gap-xs">
							<button
								onclick={undo}
								disabled={!canUndo}
								title="Undo (Ctrl+Z)"
								aria-label="Undo"
								class="flex-1 flex items-center justify-center gap-xs
								       px-sm py-xs rounded border text-xs transition
								       border-base-subtle text-content-muted
								       hover:border-content-muted hover:text-content
								       disabled:opacity-30 disabled:cursor-not-allowed"
							>
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="12"
									height="12"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
									aria-hidden="true"
									><path d="M3 7v6h6" /><path
										d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"
									/></svg
								>
								Undo
							</button>
							<button
								onclick={redo}
								disabled={!canRedo}
								title="Redo (Ctrl+Shift+Z)"
								aria-label="Redo"
								class="flex-1 flex items-center justify-center gap-xs
								       px-sm py-xs rounded border text-xs transition
								       border-base-subtle text-content-muted
								       hover:border-content-muted hover:text-content
								       disabled:opacity-30 disabled:cursor-not-allowed"
							>
								Redo
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="12"
									height="12"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
									aria-hidden="true"
									><path d="M21 7v6h-6" /><path
										d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"
									/></svg
								>
							</button>
						</div>
					</section>

					<!-- Crop mode toggle -->
					<section>
						<button
							onclick={toggleCropMode}
							title="Toggle crop mode (C)"
							class="w-full flex items-center justify-center gap-sm
							       px-sm py-xs rounded border text-xs transition
							       {cropModeActive
								? 'border-primary bg-primary/10 text-primary'
								: 'border-base-subtle text-content-muted hover:border-content-muted hover:text-content'}"
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="14"
								height="14"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<path d="M6 2v14a2 2 0 0 0 2 2h14" />
								<path d="M18 22V8a2 2 0 0 0-2-2H2" />
							</svg>
							{cropModeActive ? 'Exit Crop' : 'Crop'}
						</button>
					</section>

					<!-- Transform controls (rotation, flip) -->
					<section>
						<h3
							class="text-xs font-semibold text-content-subtle uppercase tracking-wider mb-sm"
						>
							Transform
						</h3>
						<TransformControls
							value={effectiveTransform}
							onChange={onTransformChange}
							onCommit={onTransformCommit}
							onFineRotateDrag={(dragging: boolean) => (fineRotating = dragging)}
							onAutoStraighten={startHorizonDetection}
							{detectingHorizon}
						/>
					</section>

					<!-- Negative inversion toggle -->
					<section>
						<label class="flex items-center gap-sm cursor-pointer">
							<input
								type="checkbox"
								checked={roll.rollEdit.invert}
								onchange={(e) =>
									saveRollEdit({
										invert: e.currentTarget.checked,
									})}
								class="w-4 h-4 accent-primary"
							/>
							<span class="text-sm text-content"
								>Negative (invert)</span
							>
						</label>
					</section>

					<!-- NegPy inversion controls (only when invert = true) -->
					{#if roll.rollEdit.invert}
						<section>
							<div
								class="flex items-center justify-between mb-sm"
							>
								<h3
									class="text-xs font-semibold text-content-subtle uppercase tracking-wider"
								>
									Inversion
								</h3>
								<button
									onclick={toggleWbPicker}
									title="Pick a neutral white or gray pixel on the image to auto-set color balance"
									class="flex items-center gap-xs text-xs px-sm py-xs rounded border transition
									       {wbPickerActive
										? 'border-primary bg-primary/10 text-primary'
										: 'border-base-subtle text-content-muted hover:border-content-muted hover:text-content'}"
								>
									<svg
										xmlns="http://www.w3.org/2000/svg"
										width="12"
										height="12"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
										aria-hidden="true"
									>
										<path
											d="M2 13.5V19a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.5"
										/>
										<path
											d="M22 10.5V5a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v5.5"
										/>
										<line x1="12" y1="2" x2="12" y2="22" />
										<circle
											cx="12"
											cy="12"
											r="2"
											fill="currentColor"
											stroke="none"
										/>
									</svg>
									WB Picker
								</button>
							</div>
							<InversionControls
								value={effectiveInversionParams}
								onChange={onInversionChange}
								onCommit={onInversionCommit}
							/>
						</section>
					{/if}

					<!-- Curves section -->
					<section>
						<h3
							class="text-xs font-semibold text-content-subtle uppercase tracking-wider mb-sm"
						>
							Curves
						</h3>
						<CurvesEditor
							global={effectiveToneCurve}
							r={effectiveRGBCurves[0]}
							g={effectiveRGBCurves[1]}
							b={effectiveRGBCurves[2]}
							onChange={onCurveChange}
							onCommit={onCurveCommit}
							histogram={currentHistogram}
						/>
					</section>

					<!-- Frame info -->
					<section class="border-t border-base-subtle pt-l">
						<h3
							class="text-xs font-semibold text-content-subtle uppercase tracking-wider mb-sm"
						>
							File
						</h3>
						<p
							class="text-xs text-content-muted font-mono break-all"
						>
							{frame.filename}
						</p>
					</section>

					<!-- Export -->
					<section class="border-t border-base-subtle pt-l">
						<h3
							class="text-xs font-semibold text-content-subtle uppercase tracking-wider mb-sm"
						>
							Export
						</h3>

						<button
							onclick={exportFrame}
							disabled={exporting || loading || !pipeline}
							class="w-full flex items-center justify-center gap-sm
							       px-sm py-xs rounded border text-sm transition
							       border-primary text-primary
							       hover:bg-primary/10
							       disabled:opacity-40 disabled:cursor-not-allowed"
						>
							{#if exporting}
								Exporting…
							{:else}
								Export JPEG
							{/if}
						</button>

						{#if exportSuccess}
							<p class="mt-sm text-xs text-content-muted">
								Saved successfully.
							</p>
						{/if}

						{#if exportError}
							<p class="mt-sm text-xs text-red-500 break-all">
								{exportError}
							</p>
						{/if}
					</section>
				{/if}
			</div>
		</aside>
	</div>

	<!-- ── Keyboard hint bar ──────────────────────────────────────────────── -->
	<KeyboardHintBar
		hints={[
			{ keys: ["←", "→"], label: "navigate frames" },
			{ keys: ["C"], label: "crop" },
			{ keys: ["Q–E", "A–D"], label: "+/− CMY" },
			{ keys: ["R", "F"], label: "+/− grade" },
			{ keys: ["T", "G"], label: "+/− density" },
			{
				keys: [{ icon: ArrowFatUpIcon, eventKey: "Shift" }],
				label: "10× step",
			},
			{ keys: ["⌘Z"], label: "undo" },
			{ keys: ["⌘⇧Z"], label: "redo" },
			{ keys: ["Esc"], label: "back to roll" },
		]}
	/>
</div>
