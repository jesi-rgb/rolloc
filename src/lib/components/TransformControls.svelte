<script lang="ts">
	import type { CropAspect, TransformParams } from "$lib/types";
	import { DEFAULT_TRANSFORM } from "$lib/types";
	import { untrack } from "svelte";
	import { slide } from "svelte/transition";
	import { cubicOut } from "svelte/easing";
	import LabeledRange from "./LabeledRange.svelte";
	import ToggleButton from "./ToggleButton.svelte";
	import {
		ArrowCounterClockwiseIcon,
		ArrowClockwiseIcon,
		SpinnerIcon,
		ArrowsClockwiseIcon,
		CropIcon,
	} from "phosphor-svelte";

	interface Props {
		value: TransformParams;
		/** Called on every change — for live preview. */
		onChange: (p: TransformParams) => void;
		/**
		 * Called when the user commits a change (e.g. releases a slider).
		 * Trigger IDB persist + history push here.
		 * Falls back to `onChange` if not provided.
		 */
		onCommit?: (p: TransformParams) => void;
		/** Called when fine rotation dragging starts/ends. Useful for showing alignment grid. */
		onFineRotateDrag?: (dragging: boolean) => void;
		/** Called when user clicks the Auto button to detect horizon lines. */
		onAutoStraighten?: () => void;
		/** Whether horizon detection is currently in progress. */
		detectingHorizon?: boolean;
		/** Called when the user clicks the Crop button to toggle crop mode. */
		onToggleCrop?: () => void;
		/** When true, the crop aspect-ratio selector is shown (crop mode active). */
		cropActive?: boolean;
		/** Currently selected crop aspect ratio (drives the active button state). */
		cropAspect?: CropAspect;
		/** Called when the user picks a crop aspect ratio. */
		onCropAspectChange?: (aspect: CropAspect) => void;
	}

	let {
		value,
		onChange,
		onCommit,
		onFineRotateDrag,
		onAutoStraighten,
		detectingHorizon = false,
		onToggleCrop,
		cropActive = false,
		cropAspect = null,
		onCropAspectChange,
	}: Props = $props();

	// ─── Local reactive copies ─────────────────────────────────────────────────

	let rotation = $state(untrack(() => value.rotation));
	let flipH = $state(untrack(() => value.flipH));
	let flipV = $state(untrack(() => value.flipV));
	let zoom = $state(untrack(() => value.zoom ?? 1));

	// Re-sync when parent swaps to a different frame
	$effect(() => {
		rotation = value.rotation;
		flipH = value.flipH;
		flipV = value.flipV;
		zoom = value.zoom ?? 1;
	});

	/** Build the current params object. */
	function currentParams(): TransformParams {
		return {
			rotation,
			flipH,
			flipV,
			zoom,
		};
	}

	/** Called on every change — live preview, no IDB write. */
	function emit(): void {
		onChange(currentParams());
	}

	/** Called on commit — triggers IDB persist + history push. */
	function commit(): void {
		(onCommit ?? onChange)(currentParams());
	}

	function rotateLeft(): void {
		rotation -= 90;
		emit();
		commit();
	}

	function rotateRight(): void {
		rotation += 90;
		emit();
		commit();
	}

	function toggleFlipH(): void {
		flipH = !flipH;
		emit();
		commit();
	}

	function toggleFlipV(): void {
		flipV = !flipV;
		emit();
		commit();
	}

	function reset(): void {
		const d = DEFAULT_TRANSFORM;
		rotation = d.rotation;
		flipH = d.flipH;
		flipV = d.flipV;
		zoom = d.zoom;
		commit();
	}

	/** Label showing the total rotation. */
	const rotationLabel = $derived.by(() => {
		// Normalize to -180 to +180 for display
		let displayRot = rotation % 360;
		if (displayRot > 180) displayRot -= 360;
		if (displayRot < -180) displayRot += 360;

		// Show integer if it's a clean multiple of 90, otherwise one decimal
		if (displayRot === Math.round(displayRot)) {
			return `${displayRot}°`;
		}
		return `${displayRot.toFixed(1)}°`;
	});

	const isDefault = $derived(
		rotation === DEFAULT_TRANSFORM.rotation &&
			flipH === DEFAULT_TRANSFORM.flipH &&
			flipV === DEFAULT_TRANSFORM.flipV &&
			zoom === DEFAULT_TRANSFORM.zoom,
	);

	/**
	 * Fine rotation slider value: the fractional part after removing 90° steps.
	 * E.g., rotation=95 → fine=5, rotation=-100 → fine=-10
	 */
	const fineValue = $derived.by(() => {
		// Find nearest 90° step
		const nearest90 = Math.round(rotation / 90) * 90;
		return rotation - nearest90;
	});

	/**
	 * Handle fine rotation slider change.
	 * Adjusts the total rotation while preserving the 90° base.
	 */
	function onFineChange(fine: number): void {
		const nearest90 = Math.round(rotation / 90) * 90;
		rotation = nearest90 + fine;
		emit();
	}

	/**
	 * Handle zoom slider change.
	 * Zoom crops in from center — values 1.0 (no zoom) to 3.0 (3x zoom).
	 */
	function onZoomChange(z: number): void {
		zoom = z;
		emit();
	}

	// ─── Crop aspect ratio ─────────────────────────────────────────────────────
	//
	// Ratios are stored in landscape form (width/height ≥ 1). The portrait toggle
	// emits the reciprocal. `cropAspect` (from the parent) is the source of truth.

	interface RatioOption {
		label: string;
		value: number;
	}

	const RATIOS: RatioOption[] = [
		{ label: "1:1", value: 1 },
		{ label: "3:2", value: 3 / 2 },
		{ label: "4:3", value: 4 / 3 },
		{ label: "16:9", value: 16 / 9 },
		{ label: "5:4", value: 5 / 4 },
	];

	/** True when the active ratio is portrait-oriented (reciprocal < 1). */
	const portrait = $derived(typeof cropAspect === "number" && cropAspect < 1);

	function approxEq(a: number, b: number): boolean {
		return Math.abs(a - b) < 1e-4;
	}

	/** Whether a given landscape ratio is the currently selected one. */
	function ratioActive(v: number): boolean {
		if (typeof cropAspect !== "number") return false;
		return approxEq(cropAspect, v) || approxEq(cropAspect, 1 / v);
	}

	function selectRatio(v: number): void {
		const out = portrait && v !== 1 ? 1 / v : v;
		onCropAspectChange?.(out);
	}

	function togglePortrait(): void {
		if (typeof cropAspect !== "number") return;
		onCropAspectChange?.(1 / cropAspect);
	}

</script>

<!--
	TransformControls
	Rotation (90° buttons + fine slider), flip, and zoom controls.
-->

<div class="flex flex-col gap-base">
	<!-- ── Header: section title + inline reset ─────────────────────────────── -->
	<div class="flex items-center justify-between">
		<h3
			class="text-xs font-semibold text-content-subtle uppercase tracking-wider"
		>
			Transform
		</h3>
		{#if !isDefault}
			<button
				onclick={reset}
				class="text-xs text-content-subtle hover:text-content transition"
			>
				Reset
			</button>
		{/if}
	</div>

	<!-- ── Crop toggle button ────────────────────────────────────────────────── -->
	{#if onToggleCrop}
		<ToggleButton
			active={cropActive}
			onclick={onToggleCrop}
			title="Toggle crop mode (C)"
			block
		>
			<CropIcon size={14} />
			{cropActive ? "Exit Crop" : "Crop"}
		</ToggleButton>
	{/if}

	<!-- ── Crop aspect ratio (only in crop mode) ────────────────────────────── -->
	{#if cropActive}
		<div
			class="flex flex-col gap-xs"
			transition:slide={{ duration: 200, easing: cubicOut }}
		>
			<div class="flex items-center justify-between">
				<span class="text-xs text-content-subtle">Aspect ratio</span>
				<button
					onclick={togglePortrait}
					disabled={typeof cropAspect !== "number" || cropAspect === 1}
					title="Swap orientation (portrait / landscape)"
					aria-label="Swap orientation"
					class="flex items-center gap-xs text-xs transition
					       text-content-subtle hover:text-content
					       disabled:opacity-30 disabled:cursor-not-allowed"
				>
					<ArrowsClockwiseIcon size={12} />
					{portrait ? "Portrait" : "Landscape"}
				</button>
			</div>
			<div class="grid grid-cols-4 gap-xs">
				<ToggleButton
					active={cropAspect == null}
					onclick={() => onCropAspectChange?.(null)}
					title="Free-form crop"
					block
				>
					Free
				</ToggleButton>
				<ToggleButton
					active={cropAspect === "original"}
					onclick={() => onCropAspectChange?.("original")}
					title="Lock to the image's native aspect ratio"
					block
				>
					Orig
				</ToggleButton>
				{#each RATIOS as ratio (ratio.label)}
					<ToggleButton
						active={ratioActive(ratio.value)}
						onclick={() => selectRatio(ratio.value)}
						title="Lock to {ratio.label}"
						block
					>
						{ratio.label}
					</ToggleButton>
				{/each}
			</div>
		</div>
	{/if}

	<!-- ── Rotation group (buttons + fine slider) ───────────────────────────── -->
	<div class="flex flex-col gap-xs">
		<!-- 90° rotation + auto buttons -->
		<div class="flex items-center gap-xs">
		<button
			onclick={rotateRight}
			title="Rotate 90° counter-clockwise"
			aria-label="Rotate left"
			class="flex-1 flex items-center justify-center gap-xs
			       px-sm py-xs rounded border text-xs transition
			       border-base-subtle text-content-muted
			       hover:border-content-muted hover:text-content"
		>
			<ArrowCounterClockwiseIcon size={14} />
		</button>
		{#if onAutoStraighten}
			<button
				onclick={onAutoStraighten}
				disabled={detectingHorizon}
				title="Detect horizon/vertical lines for auto-straighten"
				aria-label="Auto straighten"
				class="flex-1 flex items-center justify-center gap-xs
				       px-sm py-xs rounded border text-xs transition
				       border-base-subtle text-content-muted
				       hover:border-content-muted hover:text-content
				       disabled:opacity-50 disabled:cursor-wait"
			>
				{#if detectingHorizon}
					<SpinnerIcon size={14} class="animate-spin" />
				{:else}
					Auto
				{/if}
			</button>
		{/if}
		<button
			onclick={rotateLeft}
			title="Rotate 90° clockwise"
			aria-label="Rotate right"
			class="flex-1 flex items-center justify-center gap-xs
			       px-sm py-xs rounded border text-xs transition
			       border-base-subtle text-content-muted
			       hover:border-content-muted hover:text-content"
		>
			<ArrowClockwiseIcon size={14} />
		</button>
	</div>

	<!-- ── Fine rotation slider ─────────────────────────────────────────────── -->
	<LabeledRange
		id="transform-fine-rotation"
		label="Fine"
		min={-45}
		max={45}
		step={0.1}
		value={fineValue}
		defaultValue={0}
		onchange={onFineChange}
		oncommit={commit}
		ondragstart={() => onFineRotateDrag?.(true)}
		ondragend={() => onFineRotateDrag?.(false)}
		signed
		hideHeader
	/>
	</div>

	<!-- ── Flip buttons ─────────────────────────────────────────────────────── -->
	<div class="flex items-center gap-xs">
		<ToggleButton
			active={flipH}
			onclick={toggleFlipH}
			title="Flip horizontal"
			aria-label="Flip horizontal"
			fill
			block
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
				<path
					d="M8 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h3M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3M12 20v2M12 14v2M12 8v2M12 2v2"
				/>
			</svg>
			H
		</ToggleButton>
		<ToggleButton
			active={flipV}
			onclick={toggleFlipV}
			title="Flip vertical"
			aria-label="Flip vertical"
			fill
			block
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
				<path
					d="M3 8V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3M20 12h2M14 12h2M8 12h2M2 12h2"
				/>
			</svg>
			V
		</ToggleButton>
	</div>

	<!-- ── Zoom slider ──────────────────────────────────────────────────────── -->
	<LabeledRange
		id="transform-zoom"
		label="Zoom"
		min={1}
		max={3}
		step={0.01}
		value={zoom}
		defaultValue={1}
		onchange={onZoomChange}
		oncommit={commit}
	/>

</div>
