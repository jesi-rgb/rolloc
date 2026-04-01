<script lang="ts">
	import type { TransformParams } from "$lib/types";
	import { DEFAULT_TRANSFORM } from "$lib/types";
	import { untrack } from "svelte";
	import LabeledRange from "./LabeledRange.svelte";

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
	}

	let { value, onChange, onCommit }: Props = $props();

	// ─── Local reactive copies ─────────────────────────────────────────────────

	let rotation90 = $state(untrack(() => value.rotation90));
	let fineRotation = $state(untrack(() => value.fineRotation));
	let flipH = $state(untrack(() => value.flipH));
	let flipV = $state(untrack(() => value.flipV));

	// Re-sync when parent swaps to a different frame
	$effect(() => {
		rotation90 = value.rotation90;
		fineRotation = value.fineRotation;
		flipH = value.flipH;
		flipV = value.flipV;
	});

	/** Build the current params object. */
	function currentParams(): TransformParams {
		return {
			rotation90,
			fineRotation,
			flipH,
			flipV,
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
		rotation90 = ((rotation90 - 1 + 4) % 4) as 0 | 1 | 2 | 3;
		emit();
		commit();
	}

	function rotateRight(): void {
		rotation90 = ((rotation90 + 1) % 4) as 0 | 1 | 2 | 3;
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
		rotation90 = d.rotation90;
		fineRotation = d.fineRotation;
		flipH = d.flipH;
		flipV = d.flipV;
		commit();
	}

	/** Label showing the total rotation (90° steps + fine adjustment). */
	const rotationLabel = $derived.by(() => {
		const base = rotation90 * 90;
		if (fineRotation === 0) {
			return `${base}°`;
		}
		const sign = fineRotation > 0 ? "+" : "";
		return `${base}° ${sign}${fineRotation.toFixed(1)}°`;
	});

	const isDefault = $derived(
		rotation90 === DEFAULT_TRANSFORM.rotation90 &&
			fineRotation === DEFAULT_TRANSFORM.fineRotation &&
			flipH === DEFAULT_TRANSFORM.flipH &&
			flipV === DEFAULT_TRANSFORM.flipV,
	);
</script>

<!--
	TransformControls
	Rotation (90° steps + fine adjustment) and flip controls.
-->

<div class="flex flex-col gap-sm">
	<!-- ── 90° rotation buttons ─────────────────────────────────────────────── -->
	<div class="flex items-center gap-sm">
		<span class="text-xs text-content-muted w-16">Rotate</span>
		<div class="flex items-center gap-xs flex-1">
			<button
				onclick={rotateLeft}
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
				onclick={rotateRight}
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
	<LabeledRange
		id="transform-fine-rotation"
		label="Fine"
		min={-45}
		max={45}
		step={0.1}
		value={fineRotation}
		defaultValue={DEFAULT_TRANSFORM.fineRotation}
		onchange={(v) => {
			fineRotation = v;
			emit();
		}}
		oncommit={commit}
		signed
	/>

	<!-- ── Flip buttons ─────────────────────────────────────────────────────── -->
	<div class="flex items-center gap-sm">
		<span class="text-xs text-content-muted w-16">Flip</span>
		<div class="flex items-center gap-xs flex-1">
			<button
				onclick={toggleFlipH}
				title="Flip horizontal"
				aria-label="Flip horizontal"
				class="flex-1 flex items-center justify-center gap-xs
				       px-sm py-xs rounded border text-xs transition
				       {flipH
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
					<path
						d="M8 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h3M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3M12 20v2M12 14v2M12 8v2M12 2v2"
					/>
				</svg>
				H
			</button>
			<button
				onclick={toggleFlipV}
				title="Flip vertical"
				aria-label="Flip vertical"
				class="flex-1 flex items-center justify-center gap-xs
				       px-sm py-xs rounded border text-xs transition
				       {flipV
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
					<path
						d="M3 8V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3M20 12h2M14 12h2M8 12h2M2 12h2"
					/>
				</svg>
				V
			</button>
		</div>
	</div>

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
