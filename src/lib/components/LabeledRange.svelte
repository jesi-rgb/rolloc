<script lang="ts">
	interface Props {
		id: string;
		label: string;
		min: number;
		max: number;
		step: number;
		value: number;
		onchange: (v: number) => void;
		/**
		 * Called when the user releases the slider (pointer-up / native change
		 * event). Use this to trigger expensive side-effects like IDB writes
		 * that should not fire on every drag tick.
		 */
		oncommit?: (v: number) => void;
		/** Called when the user starts dragging the slider. */
		ondragstart?: () => void;
		/** Called when the user stops dragging the slider. */
		ondragend?: () => void;
		/** 'stacked' = label+value above, input below (default).
		 *  'inline'  = label | input | value in one row. */
		layout?: "stacked" | "inline";
		/** Extra class applied to the label element (e.g. a colour class). */
		labelClass?: string;
		/** Use fmtSigned (+0.00) instead of plain fmt (0.00). */
		signed?: boolean;
		/** Smaller text size — for sub-controls like Width/Hardness. */
		small?: boolean;
		/** Double-clicking the thumb resets to this value. */
		defaultValue?: number;
		/** Custom color for the thumb. */
		thumbColor?: string;
		/** Custom color for the track. */
		trackColor?: string;
	}

	let {
		id,
		label,
		min,
		max,
		step,
		value,
		onchange,
		oncommit,
		ondragstart,
		ondragend,
		layout = "stacked",
		labelClass = "text-content-muted",
		signed = false,
		small = false,
		defaultValue,
		thumbColor,
		trackColor,
	}: Props = $props();

	function fmt(v: number): string {
		return signed ? (v >= 0 ? "+" : "") + v.toFixed(2) : v.toFixed(2);
	}

	const textSize = $derived(small ? "text-[10px]" : "text-xs");

	function handleDblClick(): void {
		if (defaultValue !== undefined) {
			onchange(defaultValue);
			oncommit?.(defaultValue);
		}
	}
</script>

{#snippet rangeInput(extraClass: string)}
	<input
		{id}
		type="range"
		{min}
		{max}
		{step}
		{value}
		oninput={(e) =>
			onchange(parseFloat((e.currentTarget as HTMLInputElement).value))}
		onchange={(e) =>
			oncommit?.(parseFloat((e.currentTarget as HTMLInputElement).value))}
		onpointerdown={() => ondragstart?.()}
		onpointerup={() => ondragend?.()}
		onpointercancel={() => ondragend?.()}
		ondblclick={handleDblClick}
		class="range-track {extraClass}"
		style:--thumb-color={thumbColor}
		style:--track-color={trackColor}
	/>
{/snippet}

{#if layout === "stacked"}
	<div class="flex flex-col gap-xs">
		<div class="flex items-center justify-between">
			<label for={id} class="{textSize} font-medium {labelClass}"
				>{label}</label
			>
			<span class="{textSize} text-content font-mono tabular-nums"
				>{fmt(value)}</span
			>
		</div>
		{@render rangeInput("w-full")}
	</div>
{:else}
	<div class="flex items-center gap-sm">
		<label for={id} class="text-[10px] w-12 shrink-0 {labelClass}"
			>{label}</label
		>
		{@render rangeInput("flex-1")}
		<span
			class="text-[10px] text-content font-mono tabular-nums w-10 text-right"
			>{fmt(value)}</span
		>
	</div>
{/if}

<style>
	.range-track {
		cursor: pointer;
		appearance: none;
		border-radius: 9999px;
		accent-color: var(--primary);
		background-color: var(--base-subtle);
	}

	/* WebKit (Chrome, Safari, Edge) */
	.range-track::-webkit-slider-runnable-track {
		height: 0.5rem;
		border-radius: 9999px;
		background-color: var(--track-color, var(--base-subtle));
	}

	.range-track::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		/* Visual size - pill shape */
		width: 1.25rem;
		height: 0.5rem;
		border-radius: 9999px;
		background-color: var(--thumb-color, var(--primary));
		box-shadow: 0 3px 8px rgba(0, 0, 0, 0.5);
		/* Center thumb on track */
		margin-top: calc((0.5rem - 0.5rem) / 2);
		cursor: pointer;
		/* Smooth scale transitions */
		transition: transform 150ms ease-out;
		transform: scale(1);
	}

	.range-track:hover::-webkit-slider-thumb {
		transform: scale(1.15);
	}

	.range-track:active::-webkit-slider-thumb {
		transform: scale(0.95);
	}

	/* Firefox */
	.range-track::-moz-range-track {
		height: 0.5rem;
		border-radius: 9999px;
		background-color: var(--track-color, var(--base-subtle));
	}

	.range-track::-moz-range-thumb {
		/* Visual size - pill shape */
		width: 1.25rem;
		height: 0.5rem;
		border-radius: 9999px;
		background-color: var(--thumb-color, var(--primary));
		box-shadow: 0 3px 8px rgba(0, 0, 0, 0.5);
		border: none;
		cursor: pointer;
		/* Smooth scale transitions */
		transition: transform 150ms ease-out;
		transform: scale(1);
	}

	.range-track:hover::-moz-range-thumb {
		transform: scale(1.15);
	}

	.range-track:active::-moz-range-thumb {
		transform: scale(0.95);
	}
</style>
