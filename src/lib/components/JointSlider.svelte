<script lang="ts">
	interface Slot {
		id: string;
		label: string;
		value: number;
		/** Channel color used for fill + thumb line (positive direction). */
		color: string;
		/**
		 * Optional complementary color shown at the negative end of the track
		 * background gradient. e.g. for Cyan slider, this would be Red.
		 * If omitted, the track uses a flat neutral background.
		 */
		negativeColor?: string;
		defaultValue?: number;
	}

	interface Props {
		slots: Slot[];
		min: number;
		max: number;
		step: number;
		/** Live drag — fires on every tick. No IDB. */
		onChange: (id: string, v: number) => void;
		/** Drag-end — IDB persist + history. */
		onCommit?: (id: string, v: number) => void;
		/** Use signed formatting (+0.00). */
		signed?: boolean;
	/** Pixel height of the vertical track. */
	height?: number;
		/** Label rendered above the module. */
		title?: string;
	}

	let {
		slots,
		min,
		max,
		step,
		onChange,
		onCommit,
		signed = false,
		height = 60,
		title,
	}: Props = $props();

	/**
	 * Build the track background. When the slot has a `negativeColor`,
	 * we paint a vertical gradient: positive color at the top, neutral
	 * in the middle, complementary color at the bottom — keyed off the
	 * actual zero baseline so it always lines up with the center line.
	 */
	function trackBackground(slot: Slot): string {
		if (!slot.negativeColor) return "var(--color-base)";
		const z = (zeroFrac * 100).toFixed(2);
		// top portion: slot.color -> base at zero
		// bottom portion: base at zero -> slot.negativeColor at the bottom
		// CSS gradient origin is "to top": 0% = bottom, 100% = top.
		return (
			`linear-gradient(to top, ` +
			`${slot.negativeColor}1a 0%, ` +
			`var(--color-base) ${z}%, ` +
			`${slot.color}1a 100%)`
		);
	}

	/** Map a value in [min,max] to a 0..1 fraction (0 = bottom, 1 = top). */
	function valueToFrac(v: number): number {
		return (v - min) / (max - min);
	}

	/** Fraction of the track corresponding to the zero baseline.
	 *  Clamped — when min/max don't straddle zero, fill grows from min. */
	const zeroFrac = $derived(
		Math.max(0, Math.min(1, valueToFrac(0))),
	);

	function snap(v: number): number {
		const stepped = Math.round((v - min) / step) * step + min;
		return Math.max(min, Math.min(max, parseFloat(stepped.toFixed(6))));
	}

	function clientYToValue(track: HTMLElement, clientY: number): number {
		const rect = track.getBoundingClientRect();
		// Top of rect = max, bottom = min (positive up).
		const frac = 1 - (clientY - rect.top) / rect.height;
		const clamped = Math.max(0, Math.min(1, frac));
		return snap(min + clamped * (max - min));
	}

	let dragId = $state<string | null>(null);

	function onPointerDown(e: PointerEvent, slot: Slot): void {
		const track = e.currentTarget as HTMLElement;
		track.setPointerCapture(e.pointerId);
		dragId = slot.id;
		const v = clientYToValue(track, e.clientY);
		onChange(slot.id, v);
	}

	function onPointerMove(e: PointerEvent, slot: Slot): void {
		if (dragId !== slot.id) return;
		const track = e.currentTarget as HTMLElement;
		const v = clientYToValue(track, e.clientY);
		onChange(slot.id, v);
	}

	function onPointerUp(e: PointerEvent, slot: Slot): void {
		if (dragId !== slot.id) return;
		const track = e.currentTarget as HTMLElement;
		const v = clientYToValue(track, e.clientY);
		dragId = null;
		(onCommit ?? onChange)(slot.id, v);
	}

	function onDblClick(slot: Slot): void {
		if (slot.defaultValue === undefined) return;
		onChange(slot.id, slot.defaultValue);
		onCommit?.(slot.id, slot.defaultValue);
	}

	function onKeyDown(e: KeyboardEvent, slot: Slot): void {
		const big = (max - min) / 10;
		let next = slot.value;
		switch (e.key) {
			case "ArrowUp":
			case "ArrowRight":
				next = snap(slot.value + step);
				break;
			case "ArrowDown":
			case "ArrowLeft":
				next = snap(slot.value - step);
				break;
			case "PageUp":
				next = snap(slot.value + big);
				break;
			case "PageDown":
				next = snap(slot.value - big);
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
		onChange(slot.id, next);
		onCommit?.(slot.id, next);
	}
</script>

<div class="flex flex-col gap-xs">
	{#if title}
		<span class="text-xs text-content-subtle">{title}</span>
	{/if}

	<div class="joint" role="group">
		{#each slots as slot, i (slot.id)}
			{@const frac = valueToFrac(slot.value)}
			{@const fillBottom = Math.min(frac, zeroFrac)}
			{@const fillTop = Math.max(frac, zeroFrac)}
			{@const isFirst = i === 0}
			{@const isLast = i === slots.length - 1}
			<div class="slot">
				<div
					class="track"
					class:first={isFirst}
					class:last={isLast}
					class:middle={!isFirst && !isLast}
					style:height="{height}px"
					style:background={trackBackground(slot)}
					role="slider"
					tabindex="0"
					aria-label={slot.label}
					aria-valuemin={min}
					aria-valuemax={max}
					aria-valuenow={slot.value}
					aria-orientation="vertical"
					onpointerdown={(e) => onPointerDown(e, slot)}
					onpointermove={(e) => onPointerMove(e, slot)}
					onpointerup={(e) => onPointerUp(e, slot)}
					onpointercancel={(e) => onPointerUp(e, slot)}
					ondblclick={() => onDblClick(slot)}
					onkeydown={(e) => onKeyDown(e, slot)}
				>
					<!-- center baseline -->
					<div
						class="baseline"
						style:bottom="calc({zeroFrac * 100}% - 0.5px)"
					></div>

					<!-- fill from zero toward thumb -->
					<div
						class="fill"
						style:bottom="{fillBottom * 100}%"
						style:height="{(fillTop - fillBottom) * 100}%"
						style:background-color={slot.color}
					></div>

					<!-- horizontal line thumb -->
					<div
						class="thumb"
						style:bottom="calc({frac * 100}% - 1px)"
						style:background-color={slot.color}
					></div>

					<!-- letter overlay (stroke behind, fill on top) -->
					<span class="letter" style:color={slot.color}
						>{slot.label}</span
					>
				</div>
			</div>
		{/each}
	</div>
</div>

<style>
	.joint {
		display: flex;
		align-items: stretch;
		width: 100%;
		border: 1px solid var(--color-base-subtle);
		border-radius: 0.3125rem;
		overflow: hidden;
	}

	.slot {
		flex: 1 1 0;
		min-width: 0;
		display: flex;
		flex-direction: column;
		align-items: stretch;
	}

	.slot + .slot > .track {
		border-left: 1px solid var(--color-base-subtle);
	}

	.letter {
		position: absolute;
		left: 0;
		right: 0;
		top: 25%;
		transform: translateY(-50%);
		text-align: center;
		font-size: 11px;
		font-weight: 700;
		line-height: 1;
		pointer-events: none;
		user-select: none;
		-webkit-text-stroke: 3px var(--color-base);
		paint-order: stroke fill;
	}

	.track {
		position: relative;
		width: 100%;
		background-color: var(--color-base);
		cursor: ns-resize;
		touch-action: none;
		overflow: hidden;
	}

	.track.first {
		border-top-left-radius: 0.25rem;
		border-bottom-left-radius: 0.25rem;
	}

	.track.last {
		border-top-right-radius: 0.25rem;
		border-bottom-right-radius: 0.25rem;
	}

	.track:focus-visible {
		outline: 2px solid var(--color-primary);
		outline-offset: 2px;
	}

	.baseline {
		position: absolute;
		left: 0;
		right: 0;
		height: 1px;
		background-color: var(--color-base-subtle);
		pointer-events: none;
	}

	.fill {
		position: absolute;
		left: 0;
		right: 0;
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
		left: -2px;
		right: -2px;
		height: 2px;
		border-radius: 1px;
		pointer-events: none;
		transition: transform 120ms ease-out;
	}

	.track:hover .thumb,
	.track:active .thumb {
		transform: scaleY(1.5);
	}
</style>
