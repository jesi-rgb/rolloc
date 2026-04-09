<script lang="ts">
	/**
	 * HorizonOverlay — Displays detected horizon/vertical line candidates.
	 *
	 * Shows detected lines as colored overlays on top of the canvas.
	 * User can click a line to select it, then apply to straighten the image.
	 *
	 * Positioning: Absolutely positioned over the canvas using offset metrics,
	 * similar to CropOverlay.
	 */
	import type { HorizonCandidate } from '$lib/image/horizon-detect';
	import { fade } from 'svelte/transition';

	interface Props {
		/** Detected line candidates. */
		candidates: HorizonCandidate[];
		/** Canvas element to overlay — used for sizing and coord conversion. */
		canvas: HTMLCanvasElement;
		/** Currently selected candidate index (null = none selected). */
		selectedIndex: number | null;
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
		const displays: LineDisplay[] = [];

		candidates.forEach((c, index) => {
			const isSelected = selectedIndex === index;
			const isHorizontal = c.type === 'horizontal';

			// Color coding: cyan for horizontal, magenta for vertical
			// Selected lines are brighter
			const baseColor = isHorizontal ? 'rgb(0, 255, 255)' : 'rgb(255, 0, 255)';
			const selectedColor = isHorizontal ? 'rgb(100, 255, 255)' : 'rgb(255, 100, 255)';

			const color = isSelected ? selectedColor : baseColor;
			const width = isSelected ? 3 : 2;
			const opacity = isSelected ? 1 : 0.5 + c.confidence * 0.3;

			// Format angle label
			const angleStr = c.angle >= 0 ? `+${c.angle.toFixed(1)}°` : `${c.angle.toFixed(1)}°`;
			const typeStr = isHorizontal ? 'H' : 'V';
			const label = `${typeStr}: ${angleStr}`;

			displays.push({
				x1: c.line.x1 * canvasWidth,
				y1: c.line.y1 * canvasHeight,
				x2: c.line.x2 * canvasWidth,
				y2: c.line.y2 * canvasHeight,
				color,
				width,
				opacity,
				label,
				candidate: c,
				index,
			});
		});

		return displays;
	});

	// ─── Keyboard handling ────────────────────────────────────────────────────

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			onCancel();
		} else if (e.key === 'Enter' && selectedIndex !== null) {
			onApply();
		} else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
			// Select previous candidate
			if (candidates.length > 0) {
				const newIndex = selectedIndex === null
					? 0
					: (selectedIndex - 1 + candidates.length) % candidates.length;
				onSelect(newIndex);
			}
		} else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
			// Select next candidate
			if (candidates.length > 0) {
				const newIndex = selectedIndex === null
					? 0
					: (selectedIndex + 1) % candidates.length;
				onSelect(newIndex);
			}
		}
	}

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

<svelte:window onkeydown={handleKeydown} />

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
				? 'bg-primary text-white hover:bg-primary/90'
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
		Click a line to select, then Apply to straighten
	</div>
{/if}
