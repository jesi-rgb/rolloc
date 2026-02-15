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
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { getRoll, getRollHandle, updateRoll } from '$lib/db/rolls';
	import { getFile } from '$lib/fs/directory';
	import { getFrame, getFrames, putFrame } from '$lib/db/idb';
	import { readPreview, readThumb } from '$lib/fs/opfs';
	import { ensurePreview } from '$lib/image/thumbgen';
	import { createPipeline } from '$lib/image/pipeline';
	import { resolveEdit } from '$lib/types';
	import type { GpuPipeline } from '$lib/image/pipeline';
	import type { Roll, Frame, FrameEditOverrides, RollEditParams, CurvePoints, WhiteBalance } from '$lib/types';
	import WhiteBalanceControls from '$lib/components/WhiteBalanceControls.svelte';
	import CurvesEditor from '$lib/components/CurvesEditor.svelte';

	// ─── Route params ──────────────────────────────────────────────────────────

	const rollId   = $derived(page.params.id      ?? '');
	const frameId  = $derived(page.params.frameId ?? '');

	// ─── State ─────────────────────────────────────────────────────────────────

	let roll     = $state<Roll   | null>(null);
	let frame    = $state<Frame  | null>(null);
	let frames   = $state<Frame[]>([]);
	let loading  = $state(true);
	let gpuError = $state<string | null>(null);
	let renderError = $state<string | null>(null);

	/** Index of the current frame within the roll's frame list. */
	const frameIndex = $derived(frames.findIndex((f) => f.id === frameId));
	const hasPrev    = $derived(frameIndex > 0);
	const hasNext    = $derived(frameIndex < frames.length - 1);

	// ─── Canvas + pipeline refs ────────────────────────────────────────────────

	let canvasEl      = $state<HTMLCanvasElement | null>(null);
	let pipeline      = $state<GpuPipeline | null>(null);
	let currentBitmap = $state<ImageBitmap | null>(null);

	// ─── Pipeline init (once, on mount) ───────────────────────────────────────

	onMount(async () => {
		if (!navigator.gpu) {
			gpuError = 'WebGPU is not supported in this browser. Try Chrome 113+ or Edge 113+.';
			return;
		}
	});

	onDestroy(() => {
		pipeline?.destroy();
		currentBitmap?.close();
	});

	// ─── Create pipeline once canvas is in the DOM ────────────────────────────

	$effect(() => {
		if (!canvasEl || pipeline || gpuError) return;

		createPipeline(canvasEl)
			.then((p) => { pipeline = p; })
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

		loading     = true;
		renderError = null;

		async function load(): Promise<void> {
			const [r, f, allFrames] = await Promise.all([
				getRoll(rid),
				getFrame(fid),
				getFrames(rid),
			]);

			roll   = r   ?? null;
			frame  = f   ?? null;
			frames = allFrames;

			if (!roll || !frame) { loading = false; return; }

			// ── Load full-res image ──────────────────────────────────────────
			// Priority: generate preview from original (full res) →
			//           cached preview → cached thumb (low-res fallback).

			const dirHandle = await getRollHandle(rid);
			let blob: Blob | null = null;

			if (dirHandle) {
				try {
					const file = await getFile(dirHandle, frame.filename);
					blob = await ensurePreview(frame.id, file);
				} catch {
					// Permission denied or file missing — try OPFS cache.
				}
			}

			if (!blob) blob = await readPreview(frame.id);
			if (!blob) blob = await readThumb(frame.id);

			if (!blob) {
				renderError = 'No preview cached for this frame. Open the roll to generate thumbnails first.';
				loading = false;
				return;
			}

			// Replace bitmap — close the previous one to free GPU memory.
			const newBitmap = await createImageBitmap(blob);
			currentBitmap?.close();
			currentBitmap = newBitmap;

			loading = false;
		}

		load().catch((err: unknown) => {
			renderError = err instanceof Error ? err.message : String(err);
			loading = false;
		});
	});

	// ─── Re-render whenever pipeline + bitmap are both ready ─────────────────

	$effect(() => {
		if (pipeline && currentBitmap && roll && frame && !loading) {
			renderFrame();
		}
	});

	// ─── Re-render whenever the effective edit changes ────────────────────────

	function renderFrame(): void {
		if (!pipeline || !currentBitmap || !roll || !frame) return;
		const edit = resolveEdit(roll, frame);
		pipeline.render(edit, currentBitmap).catch((err: unknown) => {
			renderError = err instanceof Error ? err.message : String(err);
		});
	}

	// ─── Edit helpers ──────────────────────────────────────────────────────────

	async function saveEdit(patch: Partial<FrameEditOverrides>): Promise<void> {
		if (!frame) return;
		const snap = JSON.parse(JSON.stringify($state.snapshot(frame))) as Frame;
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

	type Channel = 'global' | 'r' | 'g' | 'b';

	function onCurveChange(channel: Channel, curve: CurvePoints): void {
		if (!frame) return;
		const snap = $state.snapshot(frame) as Frame;
		if (channel === 'global') {
			saveEdit({ toneCurve: curve });
		} else {
			// Patch the specific RGB channel
			const existing = snap.frameEdit.rgbCurves ?? (roll ? [...roll.rollEdit.baseRGBCurves] : null);
			if (!existing) return;
			const updated: [CurvePoints, CurvePoints, CurvePoints] = [
				existing[0], existing[1], existing[2],
			];
			if (channel === 'r') updated[0] = curve;
			else if (channel === 'g') updated[1] = curve;
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
		if (tag === 'INPUT' || tag === 'TEXTAREA') return;

		switch (e.key) {
			case 'ArrowLeft':
			case 'k':
				e.preventDefault();
				if (hasPrev) navigateTo(frameIndex - 1);
				break;
			case 'ArrowRight':
			case 'j':
				e.preventDefault();
				if (hasNext) navigateTo(frameIndex + 1);
				break;
			case 'Escape':
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
		if (!frame || !roll) return { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] };
		return resolveEdit(roll, frame).toneCurve;
	});

	const effectiveRGBCurves = $derived.by(() => {
		const identity = { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] };
		if (!frame || !roll) return [identity, identity, identity] as [typeof identity, typeof identity, typeof identity];
		return resolveEdit(roll, frame).rgbCurves;
	});

	const frameLabel = $derived(
		frame ? `Frame ${frame.index}` : 'Frame'
	);
</script>

<svelte:head>
	<title>{frameLabel} — {roll?.label ?? 'Roll'} — Roloc</title>
</svelte:head>

<svelte:window onkeydown={handleKeydown} />

<div class="h-screen bg-base text-content flex flex-col overflow-hidden">

	<!-- ── Top bar ──────────────────────────────────────────────────────────── -->
	<header class="shrink-0 flex items-center gap-base px-l py-sm border-b border-base-subtle">
		<a
			href="/roll/{rollId}"
			class="text-content-muted hover:text-content transition text-sm"
		>← Roll</a>

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
				       disabled:opacity-30 disabled:cursor-not-allowed transition"
			>←</button>
			<button
				onclick={() => navigateTo(frameIndex + 1)}
				disabled={!hasNext}
				aria-label="Next frame"
				class="w-8 h-8 flex items-center justify-center rounded
				       border border-base-subtle text-content-muted
				       hover:text-content hover:border-content-muted
				       disabled:opacity-30 disabled:cursor-not-allowed transition"
			>→</button>
		</div>
	</header>

	<!-- ── Loading / error states ───────────────────────────────────────────── -->
	{#if loading}
		<div class="flex-1 flex items-center justify-center text-content-muted">
			Loading…
		</div>

	{:else if gpuError}
		<div class="flex-1 flex flex-col items-center justify-center gap-base text-center px-l">
			<div class="text-5xl opacity-30">⚠</div>
			<h2 class="text-xl font-semibold text-content">WebGPU unavailable</h2>
			<p class="text-content-muted max-w-sm text-sm">{gpuError}</p>
			<a
				href="/roll/{rollId}"
				class="text-sm text-primary hover:underline"
			>← Back to roll</a>
		</div>

	{:else if !roll || !frame}
		<div class="flex-1 flex items-center justify-center text-content-muted">
			Frame not found.
		</div>

	{:else if renderError}
		<div class="flex-1 flex flex-col items-center justify-center gap-base text-center px-l">
			<div class="text-5xl opacity-30">⚠</div>
			<h2 class="text-xl font-semibold text-content">Preview unavailable</h2>
			<p class="text-content-muted max-w-sm text-sm">{renderError}</p>
			<a
				href="/roll/{rollId}"
				class="text-sm text-primary hover:underline"
			>← Back to roll</a>
		</div>

	{:else}
		<!-- ── Main editor layout ─────────────────────────────────────────────── -->
		<div class="flex-1 min-h-0 flex overflow-hidden">

			<!-- Canvas / preview area -->
			<div class="flex-1 min-w-0 flex items-center justify-center bg-base-muted overflow-hidden p-base">
				<canvas
					bind:this={canvasEl}
					class="max-w-full max-h-full object-contain rounded shadow-lg"
					style="display: block;"
				></canvas>
			</div>

			<!-- Edit panel sidebar -->
			<aside
				class="w-72 shrink-0 border-l border-base-subtle bg-base
				       overflow-y-auto flex flex-col"
			>
				<div class="flex flex-col gap-l p-l">

					<!-- Negative inversion toggle -->
					<section>
						<label class="flex items-center gap-sm cursor-pointer">
							<input
								type="checkbox"
								checked={roll.rollEdit.invert}
								onchange={(e) => saveRollEdit({ invert: e.currentTarget.checked })}
								class="w-4 h-4 accent-primary"
							/>
							<span class="text-sm text-content">Negative (invert)</span>
						</label>
					</section>

					<!-- Curves section -->
					<section>
						<h3 class="text-xs font-semibold text-content-subtle uppercase tracking-wider mb-sm">
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
						<h3 class="text-xs font-semibold text-content-subtle uppercase tracking-wider mb-sm">
							File
						</h3>
						<p class="text-xs text-content-muted font-mono break-all">{frame.filename}</p>
					</section>
				</div>
			</aside>
		</div>

		<!-- ── Keyboard hint bar ──────────────────────────────────────────────── -->
		<footer class="shrink-0 flex items-center justify-center gap-l px-l py-xs
		               border-t border-base-subtle bg-base-muted select-none">
			<span class="text-xs text-content-subtle flex items-center gap-xs">
				<kbd class="inline-flex items-center justify-center font-mono text-xs
				            px-[5px] py-[2px] min-w-[1.4rem]
				            rounded border border-base-subtle bg-base
				            shadow-[0_2px_0_0_var(--color-base-subtle)]
				            text-content-muted leading-none">←</kbd>
				<kbd class="inline-flex items-center justify-center font-mono text-xs
				            px-[5px] py-[2px] min-w-[1.4rem]
				            rounded border border-base-subtle bg-base
				            shadow-[0_2px_0_0_var(--color-base-subtle)]
				            text-content-muted leading-none">→</kbd>
				navigate frames
			</span>
			<span class="text-xs text-content-subtle flex items-center gap-xs">
				<kbd class="inline-flex items-center justify-center font-mono text-xs
				            px-[5px] py-[2px] min-w-[1.4rem]
				            rounded border border-base-subtle bg-base
				            shadow-[0_2px_0_0_var(--color-base-subtle)]
				            text-content-muted leading-none">Esc</kbd>
				back to roll
			</span>
		</footer>
	{/if}
</div>
