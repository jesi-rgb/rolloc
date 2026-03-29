<script lang="ts">
	/**
	 * Frame editor route — /roll/[id]/frame/[frameId]
	 *
	 * Full-screen lightbox + WebGPU inversion pipeline + edit controls.
	 *
	 * Keyboard shortcuts:
	 *   ← / → (or j / k)  — navigate to prev / next frame
	 *   Escape             — back to roll
	 */
	import { onMount, onDestroy } from "svelte";
	import { goto } from "$app/navigation";
	import { page } from "$app/state";
	import { getRoll, getRollPath, updateRoll } from "$lib/db/rolls";
	import { join } from "@tauri-apps/api/path";
	import { invoke } from "@tauri-apps/api/core";
	import { getFrame, getFrames, putFrame } from "$lib/db/idb";
	import { readPreview, readThumb } from "$lib/fs/opfs";
	import { ensurePreview } from "$lib/image/thumbgen";
	import { createPipeline, parseRawDecodeBuffer } from "$lib/image/pipeline";
	import { resolveEdit, DEFAULT_INVERSION_PARAMS } from "$lib/types";
	import { isRawExtension } from "$lib/fs/directory";
	import type { GpuPipeline } from "$lib/image/pipeline";
	import type {
		Roll,
		Frame,
		FrameEditOverrides,
		RollEditParams,
		CurvePoints,
		WhiteBalance,
		InversionParams,
	} from "$lib/types";
	import WhiteBalanceControls from "$lib/components/WhiteBalanceControls.svelte";
	import CurvesEditor from "$lib/components/CurvesEditor.svelte";
	import InversionControls from "$lib/components/InversionControls.svelte";
	import KeyboardHintBar from "$lib/components/KeyboardHintBar.svelte";

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

	// ─── Load frame data + image whenever frameId changes ─────────────────────

	$effect(() => {
		// Capture reactive deps up front so the effect re-runs on navigation.
		const fid = frameId;
		const rid = rollId;
		if (!fid || !rid) return;

		loading = true;
		renderError = null;

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
					});
				} catch (err) {
					renderError = `Failed to decode RAW file: ${err instanceof Error ? err.message : String(err)}`;
					loading = false;
					return;
				}

				currentBitmap?.close();
				currentBitmap = null;
				currentRawBuffer = rawBuffer;

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
			!loading
		) {
			renderFrame();
		}
	});

	// ─── Re-render whenever the effective edit changes ────────────────────────

	function renderFrame(): void {
		if (!pipeline || !roll || !frame) return;
		const edit = resolveEdit(roll, frame);
		if (currentRawBuffer) {
			console.debug(
				"[frame] renderFrame: RAW path, byteLength =",
				currentRawBuffer.byteLength,
			);
			pipeline.renderRaw(edit, currentRawBuffer).catch((err: unknown) => {
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
			pipeline.render(edit, currentBitmap).catch((err: unknown) => {
				console.error("[frame] render error:", err);
				renderError = err instanceof Error ? err.message : String(err);
			});
		} else {
			console.warn(
				"[frame] renderFrame called but no image data available",
			);
		}
	}

	// ─── Edit helpers ──────────────────────────────────────────────────────────

	async function saveEdit(patch: Partial<FrameEditOverrides>): Promise<void> {
		if (!frame) return;
		const snap = JSON.parse(
			JSON.stringify($state.snapshot(frame)),
		) as Frame;
		const updated: Frame = {
			...snap,
			frameEdit: { ...snap.frameEdit, ...patch },
		};
		frame = updated;
		await putFrame(JSON.parse(JSON.stringify(updated)) as Frame);
		renderFrame();
	}

	async function saveRollEdit(patch: Partial<RollEditParams>): Promise<void> {
		if (!roll) return;
		const snap = JSON.parse(JSON.stringify($state.snapshot(roll))) as Roll;
		roll = { ...snap, rollEdit: { ...snap.rollEdit, ...patch } };
		await updateRoll(JSON.parse(JSON.stringify(roll)) as Roll);
		renderFrame();
	}

	function onWBChange(wb: WhiteBalance): void {
		saveEdit({ whiteBalance: wb });
	}

	function onInversionChange(params: InversionParams): void {
		saveEdit({ inversionParams: params });
	}

	type Channel = "global" | "r" | "g" | "b";

	function onCurveChange(channel: Channel, curve: CurvePoints): void {
		if (!frame) return;
		const snap = $state.snapshot(frame) as Frame;
		if (channel === "global") {
			saveEdit({ toneCurve: curve });
		} else {
			// Patch the specific RGB channel
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
			saveEdit({ rgbCurves: updated });
		}
	}

	// ─── Navigation ────────────────────────────────────────────────────────────

	function navigateTo(idx: number): void {
		const target = frames[idx];
		if (!target) return;
		goto(`/roll/${rollId}/frame/${target.id}`);
	}

	async function handleKeydown(e: KeyboardEvent): Promise<void> {
		const tag = (e.target as HTMLElement | null)?.tagName;
		if (tag === "INPUT" || tag === "TEXTAREA") return;

		switch (e.key) {
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
			case "Escape":
				e.preventDefault();
				goto(`/roll/${rollId}`);
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
		if (!frame || !roll)
			return [identity, identity, identity] as [
				typeof identity,
				typeof identity,
				typeof identity,
			];
		return resolveEdit(roll, frame).rgbCurves;
	});

	const effectiveInversionParams = $derived.by(() => {
		if (!frame || !roll) return DEFAULT_INVERSION_PARAMS;
		return resolveEdit(roll, frame).inversionParams;
	});

	const frameLabel = $derived(frame ? `Frame ${frame.index}` : "Frame");
</script>

<svelte:head>
	<title>{frameLabel} — {roll?.label ?? "Roll"} — Roloc</title>
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
			<span class="text-content font-semibold">{frameLabel}</span>
			{#if frames.length > 0}
				<span class="text-xs text-content-subtle">
					{frameIndex + 1} / {frames.length}
				</span>
			{/if}
		{/if}

		<!-- Frame navigation arrows -->
		<div class="ml-auto flex items-center gap-xs">
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
			<canvas
				bind:this={canvasEl}
				class="max-w-full max-h-full object-contain rounded shadow-lg"
				style="display: block;"
			></canvas>

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
							<h3
								class="text-xs font-semibold text-content-subtle uppercase tracking-wider mb-sm"
							>
								Inversion
							</h3>
							<InversionControls
								value={effectiveInversionParams}
								onChange={onInversionChange}
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
				{/if}
			</div>
		</aside>
	</div>

	<!-- ── Keyboard hint bar ──────────────────────────────────────────────── -->
	<KeyboardHintBar
		hints={[
			{ keys: ["←", "→"], label: "navigate frames" },
			{ keys: ["Esc"], label: "back to roll" },
		]}
	/>
</div>
