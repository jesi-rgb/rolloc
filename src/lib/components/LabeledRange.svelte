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
		 * Called when the user releases the slider (pointer-up). Use this to
		 * trigger expensive side-effects like IDB writes that should not fire
		 * on every drag tick.
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
		/** Custom color for the thumb + fill (positive direction). */
		thumbColor?: string;
		/** Custom color for the track background. */
		trackColor?: string;
		/**
		 * Optional complementary color shown at the negative end of the track
		 * background gradient. If omitted, the track uses a flat background.
		 */
		negativeColor?: string;
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
		negativeColor,
	}: Props = $props();

	function fmt(v: number): string {
		return signed ? (v >= 0 ? "+" : "") + v.toFixed(2) : v.toFixed(2);
	}

	const textSize = $derived(small ? "text-[10px]" : "text-xs");

	/** Map a value in [min,max] to a 0..1 fraction (0 = left, 1 = right). */
	function valueToFrac(v: number): number {
		return (v - min) / (max - min);
	}

	/** Fraction of the track corresponding to the zero baseline.
	 *  Clamped — when min/max don't straddle zero, fill grows from min. */
	const zeroFrac = $derived(Math.max(0, Math.min(1, valueToFrac(0))));

	const frac = $derived(
		Math.max(0, Math.min(1, valueToFrac(value))),
	);
	const fillLeft = $derived(Math.min(frac, zeroFrac));
	const fillRight = $derived(Math.max(frac, zeroFrac));

	/** Build the track background. */
	const trackBg = $derived.by(() => {
		if (trackColor) return trackColor;
		if (negativeColor && thumbColor) {
			const z = (zeroFrac * 100).toFixed(2);
			return (
				`linear-gradient(to right, ` +
				`${negativeColor}1a 0%, ` +
				`var(--color-base) ${z}%, ` +
				`${thumbColor}1a 100%)`
			);
		}
		return "var(--color-base)";
	});

	function snap(v: number): number {
		const stepped = Math.round((v - min) / step) * step + min;
		return Math.max(min, Math.min(max, parseFloat(stepped.toFixed(6))));
	}

	function clientXToValue(track: HTMLElement, clientX: number): number {
		const rect = track.getBoundingClientRect();
		const f = (clientX - rect.left) / rect.width;
		const clamped = Math.max(0, Math.min(1, f));
		return snap(min + clamped * (max - min));
	}

	let dragging = $state(false);

	function onPointerDown(e: PointerEvent): void {
		const track = e.currentTarget as HTMLElement;
		track.setPointerCapture(e.pointerId);
		dragging = true;
		ondragstart?.();
		const v = clientXToValue(track, e.clientX);
		onchange(v);
	}

	function onPointerMove(e: PointerEvent): void {
		if (!dragging) return;
		const track = e.currentTarget as HTMLElement;
		const v = clientXToValue(track, e.clientX);
		onchange(v);
	}

	function onPointerUp(e: PointerEvent): void {
		if (!dragging) return;
		const track = e.currentTarget as HTMLElement;
		const v = clientXToValue(track, e.clientX);
		dragging = false;
		oncommit?.(v);
		ondragend?.();
	}

	function onDblClick(): void {
		if (defaultValue === undefined) return;
		onchange(defaultValue);
		oncommit?.(defaultValue);
	}

	function onKeyDown(e: KeyboardEvent): void {
		const big = (max - min) / 10;
		let next = value;
		switch (e.key) {
			case "ArrowRight":
			case "ArrowUp":
				next = snap(value + step);
				break;
			case "ArrowLeft":
			case "ArrowDown":
				next = snap(value - step);
				break;
			case "PageUp":
				next = snap(value + big);
				break;
			case "PageDown":
				next = snap(value - big);
				break;
			case "Home":
				next = min;
				break;
			case "End":
				next = max;
				break;
			default:
				return;
		}
		e.preventDefault();
		onchange(next);
		oncommit?.(next);
	}
</script>

{#snippet rangeInput(extraClass: string)}
	<div
		{id}
		class="track {extraClass}"
		role="slider"
		tabindex="0"
		aria-label={label}
		aria-valuemin={min}
		aria-valuemax={max}
		aria-valuenow={value}
		aria-orientation="horizontal"
		style:background={trackBg}
		onpointerdown={onPointerDown}
		onpointermove={onPointerMove}
		onpointerup={onPointerUp}
		onpointercancel={onPointerUp}
		ondblclick={onDblClick}
		onkeydown={onKeyDown}
	>
		<!-- center baseline (only meaningful when zero is inside the range) -->
		{#if zeroFrac > 0 && zeroFrac < 1}
			<div
				class="baseline"
				style:left="calc({zeroFrac * 100}% - 0.5px)"
			></div>
		{/if}

		<!-- fill from zero toward thumb -->
		<div
			class="fill"
			style:left="{fillLeft * 100}%"
			style:width="{(fillRight - fillLeft) * 100}%"
			style:background-color={thumbColor ?? "var(--color-primary)"}
		></div>

		<!-- vertical line thumb -->
		<div
			class="thumb"
			style:left="calc({frac * 100}% - 1px)"
			style:background-color={thumbColor ?? "var(--color-primary)"}
		></div>
	</div>
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
	.track {
		position: relative;
		height: 0.875rem; /* fatter than the previous 0.5rem */
		border-radius: 0.3125rem;
		border: 1px solid var(--color-base-subtle);
		background-color: var(--color-base);
		cursor: ew-resize;
		touch-action: none;
		overflow: hidden;
	}

	.track:focus-visible {
		outline: 2px solid var(--color-primary);
		outline-offset: 2px;
	}

	.baseline {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 1px;
		background-color: var(--color-base-subtle);
		pointer-events: none;
	}

	.fill {
		position: absolute;
		top: 0;
		bottom: 0;
		opacity: 0.35;
		pointer-events: none;
		transition: opacity 120ms ease-out;
	}

	.track:hover .fill,
	.track:active .fill {
		opacity: 0.5;
	}

	.thumb {
		position: absolute;
		top: -2px;
		bottom: -2px;
		width: 2px;
		border-radius: 1px;
		pointer-events: none;
		transition: transform 120ms ease-out;
	}

	.track:hover .thumb,
	.track:active .thumb {
		transform: scaleX(1.5);
	}
</style>
