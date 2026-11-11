<script lang="ts">
	/**
	 * HorizonOverlay — Displays detected horizon/vertical line candidates.
	 *
	 * Shows detected segments over the canvas. Clicking one selects it; the
	 * parent previews the selection by rotating the canvas, and the overlay
	 * rotates its lines by the same `previewAngle` so they stay on the image
	 * features they were detected on (the selected one ends up level).
	 *
	 * Keyboard (←/→, Enter, Esc) is handled by the route page so it can take
	 * precedence over frame navigation.
	 *
	 * Positioning: Absolutely positioned over the canvas using offset metrics,
	 * similar to CropOverlay.
	 */
	import type { HorizonCandidate } from '$lib/image/horizon-detect';
	import { fade } from 'svelte/transition';

	interface Props {
		/** Detected line candidates (coords normalized to the unrotated analysis render). */
		candidates: HorizonCandidate[];
		/** Canvas element to overlay — used for sizing and coord conversion. */
		canvas: HTMLCanvasElement;
		/** Currently selected candidate index (null = none selected). */
		selectedIndex: number | null;
		/**
		 * Rotation (degrees, `TransformParams.rotation` units: positive =
		 * counter-clockwise) the canvas currently shows on top of the render
		 * the candidates were detected on.
		 */
		previewAngle: number;
		/**
		 * Zoom of the previewed render relative to the analysis render (the
		 * rotation cover zoom grows with the angle); lines scale about the centre.
		 */
		previewScale: number;
		/** CSS mirror flags applied to the canvas; the overlay mirrors to match. */
		flipH: boolean;
		flipV: boolean;
		/** Called when user clicks a line to select it. */
		onSelect: (index: number) => void;
		/** Called when user clicks Apply. */
		onApply: () => void;
		/** Called when user clicks Cancel. */
		onCancel: () => void;
	}

	let {
		candidates,
		canvas,
		selectedIndex,
		previewAngle,
		previewScale,
		flipH,
		flipV,
		onSelect,
		onApply,
		onCancel,
	}: Props = $props();

	// ─── Reactively track canvas size and position ────────────────────────────

	let canvasWidth = $state(0);
	let canvasHeight = $state(0);
	let canvasOffsetLeft = $state(0);
	let canvasOffsetTop = $state(0);

	$effect(() => {
		if (!canvas) return;

		const updateMetrics = () => {
			canvasWidth = canvas.offsetWidth;
			canvasHeight = canvas.offsetHeight;
			canvasOffsetLeft = canvas.offsetLeft;
			canvasOffsetTop = canvas.offsetTop;
		};
		updateMetrics();

		const ro = new ResizeObserver(updateMetrics);
		ro.observe(canvas);
		if (canvas.parentElement) {
			ro.observe(canvas.parentElement);
		}

		return () => ro.disconnect();
	});

	const hasMetrics = $derived(canvasWidth > 0 && canvasHeight > 0);

	// ─── Line rendering ───────────────────────────────────────────────────────

	interface LineDisplay {
		x1: number;
		y1: number;
		x2: number;
		y2: number;
		color: string;
		width: number;
		opacity: number;
		label: string;
		candidate: HorizonCandidate;
		index: number;
	}

	const lineDisplays = $derived.by(() => {
		// The GPU rotates and zooms about the canvas centre in square-pixel
		// space, so the same similarity in display px moves the lines with the
		// image. A source point q shows up at s·R(−θ)·q (y-down), i.e.
		// counter-clockwise for θ > 0.
		const a = (previewAngle * Math.PI) / 180;
		const cos = Math.cos(a) * previewScale;
		const sin = Math.sin(a) * previewScale;
		const cx = canvasWidth / 2;
		const cy = canvasHeight / 2;
		const toDisplay = (nx: number, ny: number): { x: number; y: number } => {
			const dx = nx * canvasWidth - cx;
			const dy = ny * canvasHeight - cy;
			const x = cx + dx * cos + dy * sin;
			const y = cy - dx * sin + dy * cos;
			return {
				x: flipH ? canvasWidth - x : x,
				y: flipV ? canvasHeight - y : y,
			};
		};

		return candidates.map((c, index): LineDisplay => {
			const isSelected = selectedIndex === index;
			const isHorizontal = c.type === 'horizontal';

			// Color coding: cyan for horizontal, magenta for vertical
			// Selected lines are brighter
			const baseColor = isHorizontal ? 'rgb(0, 255, 255)' : 'rgb(255, 0, 255)';
			const selectedColor = isHorizontal ? 'rgb(100, 255, 255)' : 'rgb(255, 100, 255)';

			// Label shows the rotation change applying this line would make.
			const angleStr = c.angle >= 0 ? `+${c.angle.toFixed(1)}°` : `${c.angle.toFixed(1)}°`;
			const p1 = toDisplay(c.line.x1, c.line.y1);
			const p2 = toDisplay(c.line.x2, c.line.y2);

			return {
				x1: p1.x,
				y1: p1.y,
				x2: p2.x,
				y2: p2.y,
				color: isSelected ? selectedColor : baseColor,
				width: isSelected ? 3 : 2,
				opacity: isSelected ? 1 : 0.5 + c.confidence * 0.3,
				label: `${isHorizontal ? 'H' : 'V'}: ${angleStr}`,
				candidate: c,
				index,
			};
		});
	});

	// ─── Line click handler ───────────────────────────────────────────────────

	function handleLineClick(index: number) {
		return (e: MouseEvent) => {
			e.stopPropagation();
			onSelect(index);
		};
	}

	// ─── Label positioning ────────────────────────────────────────────────────

	/** Get the position for a line's label (midpoint, offset above/below). */
	function getLabelPosition(line: LineDisplay): { x: number; y: number } {
		const midX = (line.x1 + line.x2) / 2;
		const midY = (line.y1 + line.y2) / 2;
		// Offset label away from center of image
		const offsetY = midY < canvasHeight / 2 ? 20 : -20;
		return { x: midX, y: midY + offsetY };
	}
</script>

{#if hasMetrics && candidates.length > 0}
	<!-- Main overlay SVG -->
	<svg
		class="absolute pointer-events-none"
		style="left: {canvasOffsetLeft}px; top: {canvasOffsetTop}px;"
		width={canvasWidth}
		height={canvasHeight}
		transition:fade={{ duration: 150 }}
	>
		<!-- Detected lines -->
		{#each lineDisplays as line (line.index)}
			<!-- Shadow for visibility -->
			<line
				x1={line.x1}
				y1={line.y1}
				x2={line.x2}
				y2={line.y2}
				stroke="rgba(0,0,0,0.5)"
				stroke-width={line.width + 2}
				stroke-linecap="round"
			/>
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- Clickable hit area (wider, invisible) -->
			<line
				x1={line.x1}
				y1={line.y1}
				x2={line.x2}
				y2={line.y2}
				stroke="transparent"
				stroke-width="20"
				stroke-linecap="round"
				class="pointer-events-auto cursor-pointer"
				onclick={handleLineClick(line.index)}
			/>
			<!-- Visible line -->
			<line
				x1={line.x1}
				y1={line.y1}
				x2={line.x2}
				y2={line.y2}
				stroke={line.color}
				stroke-width={line.width}
				stroke-linecap="round"
				opacity={line.opacity}
				class="pointer-events-none"
			/>
			<!-- Label -->
			{@const labelPos = getLabelPosition(line)}
			<text
				x={labelPos.x}
				y={labelPos.y}
				text-anchor="middle"
				dominant-baseline="middle"
				fill={line.color}
				font-size="12"
				font-family="monospace"
				font-weight={selectedIndex === line.index ? 'bold' : 'normal'}
				opacity={line.opacity}
				class="pointer-events-none select-none"
				style="text-shadow: 0 0 3px rgba(0,0,0,0.8), 0 0 6px rgba(0,0,0,0.5);"
			>
				{line.label}
			</text>
		{/each}
	</svg>

	<!-- Control buttons -->
	<div
		class="absolute flex gap-2"
		style="left: {canvasOffsetLeft + 8}px; top: {canvasOffsetTop + 8}px;"
		transition:fade={{ duration: 150 }}
	>
		<button
			onclick={onCancel}
			class="px-3 py-1.5 text-xs bg-base/90 border border-base-subtle
			       text-content-muted hover:text-content hover:bg-base rounded transition"
		>
			Cancel
		</button>
		<button
			onclick={onApply}
			disabled={selectedIndex === null}
			class="px-3 py-1.5 text-xs rounded transition
			       {selectedIndex !== null
				? 'bg-primary text-primary-content hover:bg-primary-muted'
				: 'bg-base/50 text-content-muted border border-base-subtle cursor-not-allowed'}"
		>
			Apply
		</button>
	</div>

	<!-- Instructions -->
	<div
		class="absolute text-xs text-content-muted bg-base/80 px-2 py-1 rounded"
		style="left: {canvasOffsetLeft + canvasWidth / 2}px; 
		       top: {canvasOffsetTop + canvasHeight - 30}px;
		       transform: translateX(-50%);"
		transition:fade={{ duration: 150 }}
	>
		Click a line or use ←/→ to choose · Enter applies · Esc cancels
	</div>
{/if}
