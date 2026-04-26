<script lang="ts">
	import type { TransformParams } from "$lib/types";
	import { DEFAULT_TRANSFORM } from "$lib/types";
	import { untrack } from "svelte";
	import LabeledRange from "./LabeledRange.svelte";
	import ToggleButton from "./ToggleButton.svelte";

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
	}

	let { value, onChange, onCommit, onFineRotateDrag, onAutoStraighten, detectingHorizon = false }: Props = $props();

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
</script>

<!--
	TransformControls
	Rotation (90° buttons + fine slider), flip, and zoom controls.
-->

<div class="flex flex-col gap-sm">
	<!-- ── 90° rotation buttons ─────────────────────────────────────────────── -->
	<div class="flex items-center gap-sm">
		<span class="text-xs text-content-muted w-16">Rotate</span>
		<div class="flex items-center gap-xs flex-1">
			<button
				onclick={rotateRight}
				title="Rotate 90° counter-clockwise"
				aria-label="Rotate left"
				class="flex-1 flex items-center justify-center gap-xs
				       px-sm py-xs rounded border text-xs transition
				       border-base-subtle text-content-muted
				       hover:border-content-muted hover:text-content"
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
					<path d="M2.5 2v6h6M2.66 15.57a10 10 0 1 0 .57-8.38" />
				</svg>
			</button>
			<span
				class="text-xs text-content font-mono tabular-nums w-16 text-center"
			>
				{rotationLabel}
			</span>
			<button
				onclick={rotateLeft}
				title="Rotate 90° clockwise"
				aria-label="Rotate right"
				class="flex-1 flex items-center justify-center gap-xs
				       px-sm py-xs rounded border text-xs transition
				       border-base-subtle text-content-muted
				       hover:border-content-muted hover:text-content"
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
					<path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38" />
				</svg>
			</button>
		</div>
	</div>

	<!-- ── Fine rotation slider ─────────────────────────────────────────────── -->
	<div class="flex items-center gap-xs">
		<div class="flex-1">
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
			/>
		</div>
		{#if onAutoStraighten}
			<button
				onclick={onAutoStraighten}
				disabled={detectingHorizon}
				title="Detect horizon/vertical lines for auto-straighten"
				aria-label="Auto straighten"
				class="px-2 py-1 rounded border text-xs transition shrink-0
				       border-base-subtle text-content-muted
				       hover:border-content-muted hover:text-content
				       disabled:opacity-50 disabled:cursor-wait"
			>
				{#if detectingHorizon}
					<svg
						class="animate-spin"
						xmlns="http://www.w3.org/2000/svg"
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						aria-hidden="true"
					>
						<path d="M21 12a9 9 0 1 1-6.219-8.56" />
					</svg>
				{:else}
					Auto
				{/if}
			</button>
		{/if}
	</div>

	<!-- ── Flip buttons ─────────────────────────────────────────────────────── -->
	<div class="flex items-center gap-sm">
		<span class="text-xs text-content-muted w-16">Flip</span>
		<div class="flex items-center gap-xs flex-1">
			<ToggleButton
				active={flipH}
				onclick={toggleFlipH}
				title="Flip horizontal"
				aria-label="Flip horizontal"
				fill
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

	<!-- ── Reset ────────────────────────────────────────────────────────────── -->
	{#if !isDefault}
		<button
			onclick={reset}
			class="self-start text-xs text-content-subtle hover:text-content transition"
		>
			Reset transform
		</button>
	{/if}
</div>
