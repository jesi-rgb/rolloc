<script lang="ts">
	/**
	 * SVG-based Bezier tone curve editor with histogram visualization.
	 *
	 * Renders up to 4 channels: global (white), R, G, B.
	 * Control points are draggable within the unit square.
	 * Emits onChange with the updated CurvePoints on every drag commit.
	 * 
	 * When histogram data is provided, renders a per-channel histogram
	 * behind the curve, showing the distribution of pixel values.
	 */
	import type { CurvePoints, CurvePoint } from '$lib/types';
	import type { ChannelHistograms } from '$lib/image/pipeline';
	import { buildLUT } from '$lib/image/curves';
	import { untrack } from 'svelte';

	type Channel = 'global' | 'r' | 'g' | 'b';

	interface Props {
		global: CurvePoints;
		r: CurvePoints;
		g: CurvePoints;
		b: CurvePoints;
		/** Called on every drag tick — for live GPU preview. No IDB write. */
		onChange: (channel: Channel, curve: CurvePoints) => void;
		/**
		 * Called once when the user releases a control point (drag-end) or
		 * after adding/removing/resetting a point.
		 * Trigger IDB persist + history push here to avoid flooding the DB.
		 * Falls back to `onChange` if not provided (backwards-compatible).
		 */
		onCommit?: (channel: Channel, curve: CurvePoints) => void;
		/**
		 * Optional histogram data for visualization.
		 * When provided, renders per-channel histograms behind the curve.
		 */
		histogram?: ChannelHistograms | null;
	}

	let { global: globalCurve, r, g, b, onChange, onCommit, histogram = null }: Props = $props();

	/** Emit a commit (drag-end or discrete edit). Falls back to onChange if onCommit not set. */
	function commit(channel: Channel, curve: CurvePoints): void {
		(onCommit ?? onChange)(channel, curve);
	}

	const SIZE = 200; // SVG viewport size in px
	const PT_R = 5;   // control-point hit radius

	// Active channel tab
	let activeChannel = $state<Channel>('global');

	// Local editable copies — re-synced when props change
	let curves = $state<Record<Channel, CurvePoints>>(
		untrack(() => ({
			global: globalCurve,
			r,
			g,
			b,
		}))
	);

	$effect(() => {
		curves = { global: globalCurve, r, g, b };
	});

	// Curve being displayed
	const current = $derived(curves[activeChannel]);

	// Build the SVG path for the current channel by sampling the LUT
	const svgPath = $derived.by(() => {
		const lut = buildLUT(current);
		let d = '';
		for (let i = 0; i < lut.length; i++) {
			const x = (i / (lut.length - 1)) * SIZE;
			const y = (1 - lut[i]) * SIZE;
			d += i === 0 ? `M${x.toFixed(1)},${y.toFixed(1)}` : ` L${x.toFixed(1)},${y.toFixed(1)}`;
		}
		return d;
	});

	// Dragging state
	let dragging = $state<number | null>(null); // index of dragged point
	let svgEl = $state<SVGSVGElement | null>(null);

	function svgPoint(e: MouseEvent): CurvePoint | null {
		if (!svgEl) return null;
		const rect = svgEl.getBoundingClientRect();
		const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
		const y = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
		return { x, y };
	}

	function onPointerDown(e: PointerEvent, idx: number): void {
		(e.currentTarget as Element).setPointerCapture(e.pointerId);
		dragging = idx;
	}

	function onPointerMove(e: PointerEvent): void {
		if (dragging === null) return;
		const pt = svgPoint(e);
		if (!pt) return;

		const pts = [...current.points];
		// Clamp x so the point cannot cross its neighbours
		const lo = dragging > 0 ? pts[dragging - 1].x + 0.01 : 0;
		const hi = dragging < pts.length - 1 ? pts[dragging + 1].x - 0.01 : 1;
		pts[dragging] = { x: Math.max(lo, Math.min(hi, pt.x)), y: pt.y };

		const updated: CurvePoints = { points: pts };
		curves = { ...curves, [activeChannel]: updated };
		onChange(activeChannel, updated);
	}

	function onPointerUp(): void {
		if (dragging !== null) {
			// Drag ended — commit the current curve state for IDB persist + history.
			commit(activeChannel, curves[activeChannel]);
		}
		dragging = null;
	}

	function addPoint(e: MouseEvent): void {
		// Only add if clicking the SVG background (not an existing point)
		// SVGElement extends Element but does have dataset; cast via HTMLOrSVGElement union.
		if ((e.target as HTMLElement).dataset['pt'] !== undefined) return;
		const pt = svgPoint(e);
		if (!pt) return;

		const pts = [...current.points, pt].sort((a, b) => a.x - b.x);
		const updated: CurvePoints = { points: pts };
		curves = { ...curves, [activeChannel]: updated };
		onChange(activeChannel, updated);
		// Adding a point is a discrete action — commit immediately.
		commit(activeChannel, updated);
	}

	function removePoint(idx: number): void {
		// Keep at least 2 points (endpoints)
		if (current.points.length <= 2) return;
		const pts = current.points.filter((_, i) => i !== idx);
		const updated: CurvePoints = { points: pts };
		curves = { ...curves, [activeChannel]: updated };
		onChange(activeChannel, updated);
		// Removing a point is a discrete action — commit immediately.
		commit(activeChannel, updated);
	}

	function resetCurve(): void {
		const identity: CurvePoints = { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] };
		curves = { ...curves, [activeChannel]: identity };
		onChange(activeChannel, identity);
		// Reset is a discrete action — commit immediately.
		commit(activeChannel, identity);
	}

	// Channel colours for tabs and curves
	const CHANNEL_COLORS: Record<Channel, string> = {
		global: 'var(--color-content)',
		r: '#f87171',
		g: '#4ade80',
		b: '#60a5fa',
	};

	const TABS: { key: Channel; label: string }[] = [
		{ key: 'global', label: 'All' },
		{ key: 'r',      label: 'R'   },
		{ key: 'g',      label: 'G'   },
		{ key: 'b',      label: 'B'   },
	];

	/**
	 * Build an SVG path for the histogram of the current channel.
	 * Returns a filled area path from bottom-left, up through the histogram bars, to bottom-right.
	 */
	const histogramPath = $derived.by(() => {
		if (!histogram) return '';
		
		// Select the appropriate histogram data for the active channel
		let data: Float32Array | undefined;
		switch (activeChannel) {
			case 'r': data = histogram.r; break;
			case 'g': data = histogram.g; break;
			case 'b': data = histogram.b; break;
			case 'global': data = histogram.luma; break;
		}
		
		if (!data || data.length === 0) return '';
		
		const binCount = data.length;
		const binWidth = SIZE / binCount;
		
		// Start at bottom-left
		let d = `M0,${SIZE}`;
		
		// Draw histogram bars as a continuous area
		for (let i = 0; i < binCount; i++) {
			const x = (i / binCount) * SIZE;
			const height = data[i] * SIZE * 0.8; // Scale to 80% of height max
			const y = SIZE - height;
			d += ` L${x.toFixed(1)},${y.toFixed(1)}`;
		}
		
		// Close path at bottom-right
		d += ` L${SIZE},${SIZE} Z`;
		
		return d;
	});
</script>

<div class="flex flex-col gap-sm">
	<!-- Channel tabs -->
	<div class="flex gap-xs">
		{#each TABS as tab (tab.key)}
			<button
				onclick={() => { activeChannel = tab.key; }}
				class="text-xs px-sm py-[3px] rounded transition
				       {activeChannel === tab.key
				         ? 'bg-base-subtle text-content font-medium'
				         : 'text-content-muted hover:text-content'}"
				style="color: {activeChannel === tab.key ? CHANNEL_COLORS[tab.key] : ''}"
			>
				{tab.label}
			</button>
		{/each}
		<button
			onclick={resetCurve}
			class="ml-auto text-xs text-content-subtle hover:text-content transition"
		>
			Reset
		</button>
	</div>

	<!-- SVG curve editor -->
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_no_static_element_interactions -->
	<svg
		bind:this={svgEl}
		role="application"
		aria-label="Tone curve editor"
		viewBox="0 0 {SIZE} {SIZE}"
		width="100%"
		style="aspect-ratio:1; touch-action:none; user-select:none;"
		class="rounded border border-base-subtle bg-base-muted cursor-crosshair"
		onpointermove={onPointerMove}
		onpointerup={onPointerUp}
		onpointerleave={onPointerUp}
		onclick={addPoint}
		onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') addPoint(e as unknown as MouseEvent); }}
	>
		<!-- Grid lines -->
		{#each [0.25, 0.5, 0.75] as t (t)}
			<line
				x1={t * SIZE} y1="0" x2={t * SIZE} y2={SIZE}
				stroke="currentColor" stroke-width="0.5" class="text-base-subtle" opacity="0.5"
			/>
			<line
				x1="0" y1={t * SIZE} x2={SIZE} y2={t * SIZE}
				stroke="currentColor" stroke-width="0.5" class="text-base-subtle" opacity="0.5"
			/>
		{/each}

		<!-- Histogram (rendered behind the curve) -->
		{#if histogramPath}
			<path
				d={histogramPath}
				fill={CHANNEL_COLORS[activeChannel]}
				fill-opacity="0.15"
				stroke="none"
			/>
		{/if}

		<!-- Identity diagonal -->
		<line x1="0" y1={SIZE} x2={SIZE} y2="0"
			stroke="currentColor" stroke-width="0.5" class="text-base-subtle" opacity="0.4"
			stroke-dasharray="4 4"
		/>

		<!-- Curve path -->
		<path
			d={svgPath}
			fill="none"
			stroke={CHANNEL_COLORS[activeChannel]}
			stroke-width="1.5"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>

		<!-- Control points -->
		{#each current.points as pt, i (i)}
			<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions a11y_interactive_supports_focus -->
			<circle
				role="button"
				aria-label="Control point {i + 1}"
				tabindex={i}
				cx={pt.x * SIZE}
				cy={(1 - pt.y) * SIZE}
				r={PT_R}
				fill={CHANNEL_COLORS[activeChannel]}
				stroke="var(--color-base)"
				stroke-width="1.5"
				class="cursor-grab active:cursor-grabbing"
				data-pt={i}
				onpointerdown={(e) => onPointerDown(e, i)}
				ondblclick={() => removePoint(i)}
			/>
		{/each}
	</svg>

	<p class="text-[10px] text-content-subtle">
		Click to add point · Double-click to remove
	</p>
</div>
