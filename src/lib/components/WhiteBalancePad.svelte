<script lang="ts">
	/**
	 * Interactive temperature / tint pad.
	 * X axis = tint: green (left) to magenta (right).
	 * Y axis = temperature: blue/cool (top) to yellow/warm (bottom).
	 */

	interface Props {
		/** Temperature, -1 (cool) to +1 (warm). */
		temperature: number;
		/** Tint, -1 (green) to +1 (magenta). */
		tint: number;
		/** Fired on every drag tick — live preview. */
		onChange: (temperature: number, tint: number) => void;
		/** Fired on drag end — persist + history. */
		onCommit: (temperature: number, tint: number) => void;
		/** Pad size in pixels. */
		size?: number;
	}

	let {
		temperature,
		tint,
		onChange,
		onCommit,
		size = 140,
	}: Props = $props();

	let pad = $state<HTMLDivElement | null>(null);
	let dragging = $state(false);

	const clamp = (v: number) => Math.max(-1, Math.min(1, v));

	/** Handle position as a percentage of the pad. */
	const left = $derived(((tint + 1) / 2) * 100);
	const top = $derived(((temperature + 1) / 2) * 100);

	/** Map a pointer position to temperature / tint values. */
	function valuesFromEvent(e: PointerEvent): [number, number] {
		if (!pad) return [temperature, tint];
		const r = pad.getBoundingClientRect();
		const t = clamp(((e.clientY - r.top) / r.height) * 2 - 1);
		const g = clamp(((e.clientX - r.left) / r.width) * 2 - 1);
		return [t, g];
	}

	function onPointerDown(e: PointerEvent) {
		dragging = true;
		pad?.setPointerCapture(e.pointerId);
		const [t, g] = valuesFromEvent(e);
		onChange(t, g);
	}

	function onPointerMove(e: PointerEvent) {
		if (!dragging) return;
		const [t, g] = valuesFromEvent(e);
		onChange(t, g);
	}

	function onPointerUp(e: PointerEvent) {
		if (!dragging) return;
		dragging = false;
		pad?.releasePointerCapture(e.pointerId);
		const [t, g] = valuesFromEvent(e);
		onCommit(t, g);
	}

	/** Move the point with the arrow keys. Shift gives a coarse step. */
	function onKeyDown(e: KeyboardEvent) {
		const step = e.shiftKey ? 0.1 : 0.02;
		let t = temperature;
		let g = tint;
		if (e.key === "ArrowUp") t = clamp(t - step);
		else if (e.key === "ArrowDown") t = clamp(t + step);
		else if (e.key === "ArrowLeft") g = clamp(g - step);
		else if (e.key === "ArrowRight") g = clamp(g + step);
		else return;
		e.preventDefault();
		onCommit(t, g);
	}

	/** Double click returns the point to neutral. */
	function onDoubleClick() {
		onCommit(0, 0);
	}

	/** Cool-to-warm vertical wash blended over a green-to-magenta wash. */
	const GRADIENT =
		"linear-gradient(to bottom, #2196f3, rgba(0,0,0,0) 50%, #ffeb3b), " +
		"linear-gradient(to right, #4caf50, rgba(0,0,0,0) 50%, #e91e63)";

	function fmt(v: number): string {
		const n = Math.round(v * 100);
		return n > 0 ? `+${n}` : `${n}`;
	}
</script>

<div class="flex flex-col gap-xs">
	<div
		bind:this={pad}
		role="slider"
		tabindex="0"
		aria-label="Temperature and tint"
		aria-valuetext={`Temperature ${fmt(temperature)}, tint ${fmt(tint)}`}
		aria-valuemin={-100}
		aria-valuemax={100}
		aria-valuenow={Math.round(temperature * 100)}
		class="relative rounded border border-base-subtle cursor-crosshair
		touch-none focus:outline-none focus:ring-2 focus:ring-primary"
		style:width={`${size}px`}
		style:height={`${size}px`}
		style:background-image={GRADIENT}
		style:background-blend-mode="screen"
		onpointerdown={onPointerDown}
		onpointermove={onPointerMove}
		onpointerup={onPointerUp}
		onpointercancel={onPointerUp}
		onkeydown={onKeyDown}
		ondblclick={onDoubleClick}
	>
		<!-- Center crosshair -->
		<div class="absolute inset-0 pointer-events-none">
			<div class="absolute top-1/2 w-full h-px bg-white/25"></div>
			<div class="absolute left-1/2 h-full w-px bg-white/25"></div>
		</div>

		<!-- Draggable handle -->
		<div
			class="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full
			border-2 border-white shadow ring-1 ring-black/50 pointer-events-none"
			class:scale-125={dragging}
			style:left={`${left}%`}
			style:top={`${top}%`}
		></div>
	</div>

	<div class="text-xs text-content-subtle tabular-nums">
		Temp {fmt(temperature)} · Tint {fmt(tint)}
	</div>
</div>
