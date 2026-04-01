<script lang="ts">
	/**
	 * CropOverlay — Lightroom-style rectangular crop overlay.
	 *
	 * Renders an SVG overlay on top of the canvas with:
	 * - Four draggable corner handles (constrained to axis-aligned rectangle)
	 * - Lines connecting the corners
	 * - Semi-transparent darkening outside the crop region
	 * - Rule-of-thirds grid inside the crop area
	 *
	 * The crop is stored as a CropQuad for compatibility, but this component
	 * constrains it to always be an axis-aligned rectangle (90° corners).
	 *
	 * COORDINATE SYSTEMS:
	 * - Crop values are stored in ORIGINAL image space (before rotation)
	 * - Canvas displays the ROTATED image
	 * - This component transforms coordinates between spaces for display and interaction
	 *
	 * POSITIONING: The SVG is positioned absolutely using the canvas's offset
	 * within its parent container. We track both the canvas size and its position
	 * relative to the parent to ensure the overlay lines up exactly.
	 */
	import type { CropQuad, Point2D, TransformParams } from '$lib/types';
	import { DEFAULT_CROP_QUAD, DEFAULT_TRANSFORM } from '$lib/types';

	interface Props {
		/** Current crop quad in normalized coords (0–1) in ORIGINAL image space. */
		value: CropQuad;
		/** Canvas element to overlay — used for sizing and coord conversion. */
		canvas: HTMLCanvasElement;
		/** Current transform params — needed to transform crop coords to/from display space. */
		transform?: TransformParams;
		/** Original image width (before rotation). */
		originalWidth?: number;
		/** Original image height (before rotation). */
		originalHeight?: number;
		/** Called during drag with updated quad (in original image space). */
		onChange?: (quad: CropQuad) => void;
	}

	let {
		value,
		canvas,
		transform = DEFAULT_TRANSFORM,
		originalWidth = 1,
		originalHeight = 1,
		onChange,
	}: Props = $props();

	// ─── Reactively track canvas size and position ────────────────────────────

	/** Canvas dimensions (CSS pixels, not canvas buffer pixels). */
	let canvasWidth = $state(0);
	let canvasHeight = $state(0);
	/** Canvas offset from its parent container's top-left. */
	let canvasOffsetLeft = $state(0);
	let canvasOffsetTop = $state(0);

	$effect(() => {
		if (!canvas) return;

		const updateMetrics = () => {
			// Get the canvas's rendered size in CSS pixels
			const rect = canvas.getBoundingClientRect();
			canvasWidth = rect.width;
			canvasHeight = rect.height;

			// Get the canvas's offset within its parent (the flex container)
			// offsetLeft/offsetTop give position relative to offsetParent
			canvasOffsetLeft = canvas.offsetLeft;
			canvasOffsetTop = canvas.offsetTop;
		};
		updateMetrics();

		const ro = new ResizeObserver(updateMetrics);
		ro.observe(canvas);
		// Also observe the parent in case padding/layout changes
		if (canvas.parentElement) {
			ro.observe(canvas.parentElement);
		}

		return () => ro.disconnect();
	});

	const hasMetrics = $derived(canvasWidth > 0 && canvasHeight > 0);

	// ─── Rectangle representation ─────────────────────────────────────────────
	// We work with a simple rect internally (left, top, right, bottom) and
	// convert to/from CropQuad for the external interface.

	interface Rect {
		left: number;
		top: number;
		right: number;
		bottom: number;
	}

	/** Extract axis-aligned bounding box from a CropQuad. */
	function quadToRect(q: CropQuad): Rect {
		return {
			left: Math.min(q.tl.x, q.bl.x),
			top: Math.min(q.tl.y, q.tr.y),
			right: Math.max(q.tr.x, q.br.x),
			bottom: Math.max(q.bl.y, q.br.y),
		};
	}

	/** Convert an axis-aligned Rect to a CropQuad. */
	function rectToQuad(r: Rect): CropQuad {
		return {
			tl: { x: r.left, y: r.top },
			tr: { x: r.right, y: r.top },
			br: { x: r.right, y: r.bottom },
			bl: { x: r.left, y: r.bottom },
		};
	}

	// ─── Coordinate conversion ────────────────────────────────────────────────

	/**
	 * Transform a point from ORIGINAL image space to DISPLAY (rotated) space.
	 * This is used for rendering the crop overlay on the rotated canvas.
	 *
	 * Based on NegPy's map_coords_to_geometry approach:
	 * 1. Convert to pixel coords in original space
	 * 2. Apply rotation transform
	 * 3. Convert to normalized coords in rotated space
	 */
	function originalToDisplay(nx: number, ny: number): Point2D {
		const rotation90 = transform.rotation90 as 0 | 1 | 2 | 3;
		if (rotation90 === 0) return { x: nx, y: ny };

		// Convert to pixel coords in original space
		let px = nx * originalWidth;
		let py = ny * originalHeight;
		let w = originalWidth;
		let h = originalHeight;

		// Apply rotation
		switch (rotation90) {
			case 1: {
				// 90° CW: (px, py) → (py, w - px), then swap dims
				const newPx = py;
				const newPy = w - px;
				px = newPx;
				py = newPy;
				const tmp = w; w = h; h = tmp;
				break;
			}
			case 2: {
				// 180°: (px, py) → (w - px, h - py)
				px = w - px;
				py = h - py;
				break;
			}
			case 3: {
				// 270° CW: (px, py) → (h - py, px), then swap dims
				const newPx = h - py;
				const newPy = px;
				px = newPx;
				py = newPy;
				const tmp = w; w = h; h = tmp;
				break;
			}
		}

		// Convert back to normalized in rotated space
		return {
			x: Math.max(0, Math.min(1, px / Math.max(w, 1))),
			y: Math.max(0, Math.min(1, py / Math.max(h, 1))),
		};
	}

	/**
	 * Transform a point from DISPLAY (rotated) space to ORIGINAL image space.
	 * This is the inverse of originalToDisplay, used for user interactions.
	 */
	function displayToOriginal(nx: number, ny: number): Point2D {
		const rotation90 = transform.rotation90 as 0 | 1 | 2 | 3;
		if (rotation90 === 0) return { x: nx, y: ny };

		// Rotated dimensions
		let rotW = originalWidth;
		let rotH = originalHeight;
		if (rotation90 === 1 || rotation90 === 3) {
			rotW = originalHeight;
			rotH = originalWidth;
		}

		// Convert to pixel coords in rotated space
		let px = nx * rotW;
		let py = ny * rotH;

		// Apply INVERSE rotation to get back to original space
		switch (rotation90) {
			case 1: {
				// Inverse of 90° CW is 270° CW: (px, py) → (rotH - py, px)
				// But we need to map back to original dims
				const newPx = rotH - py;
				const newPy = px;
				px = newPx;
				py = newPy;
				break;
			}
			case 2: {
				// Inverse of 180° is 180°
				px = rotW - px;
				py = rotH - py;
				break;
			}
			case 3: {
				// Inverse of 270° CW is 90° CW: (px, py) → (py, rotW - px)
				const newPx = py;
				const newPy = rotW - px;
				px = newPx;
				py = newPy;
				break;
			}
		}

		// Convert back to normalized in original space
		return {
			x: Math.max(0, Math.min(1, px / Math.max(originalWidth, 1))),
			y: Math.max(0, Math.min(1, py / Math.max(originalHeight, 1))),
		};
	}

	/** Convert normalized (0–1) DISPLAY coords to pixel coords relative to SVG origin. */
	function toPixel(p: Point2D): { x: number; y: number } {
		return {
			x: p.x * canvasWidth,
			y: p.y * canvasHeight,
		};
	}

	/** Convert pixel coords (relative to SVG) to normalized DISPLAY coords (0–1), clamped. */
	function toNormalizedDisplay(px: number, py: number): Point2D {
		if (canvasWidth === 0 || canvasHeight === 0) return { x: 0, y: 0 };
		return {
			x: Math.max(0, Math.min(1, px / canvasWidth)),
			y: Math.max(0, Math.min(1, py / canvasHeight)),
		};
	}

	// ─── Derived rectangle and pixel positions ────────────────────────────────

	/** The crop rect in ORIGINAL image space (from props). */
	const rect = $derived(quadToRect(value));

	/**
	 * Transform the rect corners from original to display space, then to pixels.
	 * This accounts for rotation when displaying the crop overlay.
	 */
	const tlDisplay = $derived(originalToDisplay(rect.left, rect.top));
	const trDisplay = $derived(originalToDisplay(rect.right, rect.top));
	const brDisplay = $derived(originalToDisplay(rect.right, rect.bottom));
	const blDisplay = $derived(originalToDisplay(rect.left, rect.bottom));

	const tlPx = $derived(toPixel(tlDisplay));
	const trPx = $derived(toPixel(trDisplay));
	const brPx = $derived(toPixel(brDisplay));
	const blPx = $derived(toPixel(blDisplay));

	// ─── Drag state ───────────────────────────────────────────────────────────

	type Corner = 'tl' | 'tr' | 'br' | 'bl';
	let dragging = $state<Corner | null>(null);

	/** Minimum crop size in normalized coords (prevents zero-size crops). */
	const MIN_SIZE = 0.02;

	function startDrag(corner: Corner) {
		return (e: PointerEvent) => {
			e.preventDefault();
			(e.target as HTMLElement).setPointerCapture(e.pointerId);
			dragging = corner;
		};
	}

	/**
	 * Map a display-space corner to the corresponding original-space corner.
	 * When the image is rotated, the corners shift:
	 * - 90° CW:  display TL = original BL, display TR = original TL, etc.
	 * - 180°:    display TL = original BR, etc.
	 * - 270° CW: display TL = original TR, etc.
	 */
	function displayCornerToOriginal(displayCorner: Corner): Corner {
		const rotation90 = transform.rotation90 as 0 | 1 | 2 | 3;
		// Mapping: which original corner appears at each display position
		const mapping: Record<0 | 1 | 2 | 3, Record<Corner, Corner>> = {
			0: { tl: 'tl', tr: 'tr', br: 'br', bl: 'bl' },
			1: { tl: 'bl', tr: 'tl', br: 'tr', bl: 'br' },  // 90° CW
			2: { tl: 'br', tr: 'bl', br: 'tl', bl: 'tr' },  // 180°
			3: { tl: 'tr', tr: 'br', br: 'bl', bl: 'tl' },  // 270° CW
		};
		return mapping[rotation90][displayCorner];
	}

	function handlePointerMove(e: PointerEvent) {
		if (!dragging) return;

		// Get position relative to the SVG element (in display space).
		const svg = e.currentTarget as SVGSVGElement;
		const svgRect = svg.getBoundingClientRect();
		const px = e.clientX - svgRect.left;
		const py = e.clientY - svgRect.top;
		const displayPos = toNormalizedDisplay(px, py);

		// Transform to original image space
		const pos = displayToOriginal(displayPos.x, displayPos.y);

		// Map the display corner to the original corner
		const originalCorner = displayCornerToOriginal(dragging);

		// Update the rectangle based on which ORIGINAL corner is being controlled.
		// Each corner controls two edges of the rectangle.
		let newRect: Rect;
		switch (originalCorner) {
			case 'tl':
				newRect = {
					left: Math.min(pos.x, rect.right - MIN_SIZE),
					top: Math.min(pos.y, rect.bottom - MIN_SIZE),
					right: rect.right,
					bottom: rect.bottom,
				};
				break;
			case 'tr':
				newRect = {
					left: rect.left,
					top: Math.min(pos.y, rect.bottom - MIN_SIZE),
					right: Math.max(pos.x, rect.left + MIN_SIZE),
					bottom: rect.bottom,
				};
				break;
			case 'br':
				newRect = {
					left: rect.left,
					top: rect.top,
					right: Math.max(pos.x, rect.left + MIN_SIZE),
					bottom: Math.max(pos.y, rect.top + MIN_SIZE),
				};
				break;
			case 'bl':
				newRect = {
					left: Math.min(pos.x, rect.right - MIN_SIZE),
					top: rect.top,
					right: rect.right,
					bottom: Math.max(pos.y, rect.top + MIN_SIZE),
				};
				break;
		}

		onChange?.(rectToQuad(newRect));
	}

	function handlePointerUp(e: PointerEvent) {
		if (!dragging) return;
		(e.target as HTMLElement).releasePointerCapture(e.pointerId);
		dragging = null;
		// No commit here — crop is only committed when exiting crop mode
	}

	// ─── Reset to full frame ──────────────────────────────────────────────────

	function resetCrop() {
		onChange?.(DEFAULT_CROP_QUAD);
	}

	// ─── SVG path for the crop rectangle ──────────────────────────────────────

	const cropPath = $derived(
		`M ${tlPx.x},${tlPx.y} L ${trPx.x},${trPx.y} L ${brPx.x},${brPx.y} L ${blPx.x},${blPx.y} Z`
	);

	// ─── Rule of thirds grid lines ────────────────────────────────────────────

	const gridLines = $derived.by(() => {
		const lines: { x1: number; y1: number; x2: number; y2: number }[] = [];

		// Horizontal thirds
		for (const t of [1 / 3, 2 / 3]) {
			const y = tlPx.y + (blPx.y - tlPx.y) * t;
			lines.push({ x1: tlPx.x, y1: y, x2: trPx.x, y2: y });
		}

		// Vertical thirds
		for (const t of [1 / 3, 2 / 3]) {
			const x = tlPx.x + (trPx.x - tlPx.x) * t;
			lines.push({ x1: x, y1: tlPx.y, x2: x, y2: blPx.y });
		}

		return lines;
	});

	// ─── Handle radius (responsive to canvas size) ────────────────────────────

	const handleRadius = $derived(Math.max(8, Math.min(12, canvasWidth / 60)));
</script>

{#if hasMetrics}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<svg
		class="absolute pointer-events-auto"
		style="left: {canvasOffsetLeft}px; top: {canvasOffsetTop}px; cursor: {dragging ? 'grabbing' : 'default'};"
		width={canvasWidth}
		height={canvasHeight}
		onpointermove={handlePointerMove}
		onpointerup={handlePointerUp}
		onpointercancel={handlePointerUp}
	>
		<!-- Dimmed area outside crop (using mask subtraction) -->
		<defs>
			<mask id="crop-mask">
				<rect width="100%" height="100%" fill="white" />
				<path d={cropPath} fill="black" />
			</mask>
		</defs>

		<!-- Dark overlay outside crop region -->
		<rect
			width="100%"
			height="100%"
			fill="rgba(0,0,0,0.5)"
			mask="url(#crop-mask)"
			class="pointer-events-none"
		/>

		<!-- Crop boundary lines (white with dark shadow for visibility) -->
		<path
			d={cropPath}
			fill="none"
			stroke="white"
			stroke-width="2"
			class="pointer-events-none"
		/>
		<path
			d={cropPath}
			fill="none"
			stroke="rgba(0,0,0,0.5)"
			stroke-width="1"
			class="pointer-events-none"
		/>

		<!-- Rule of thirds grid -->
		{#each gridLines as line, i (i)}
			<line
				x1={line.x1}
				y1={line.y1}
				x2={line.x2}
				y2={line.y2}
				stroke="rgba(255,255,255,0.4)"
				stroke-width="1"
				class="pointer-events-none"
			/>
		{/each}

		<!-- Corner handles -->
		{#each [
			{ corner: 'tl' as Corner, pos: tlPx },
			{ corner: 'tr' as Corner, pos: trPx },
			{ corner: 'br' as Corner, pos: brPx },
			{ corner: 'bl' as Corner, pos: blPx },
		] as { corner, pos } (corner)}
			<circle
				cx={pos.x}
				cy={pos.y}
				r={handleRadius}
				fill="white"
				stroke="rgba(0,0,0,0.8)"
				stroke-width="2"
				class="cursor-grab hover:fill-primary transition-colors"
				style="cursor: {dragging === corner ? 'grabbing' : 'grab'};"
				onpointerdown={startDrag(corner)}
			/>
		{/each}
	</svg>

	<!-- Reset button (positioned relative to canvas) -->
	<button
		onclick={resetCrop}
		style="left: {canvasOffsetLeft + canvasWidth - 80}px; top: {canvasOffsetTop + 8}px;"
		class="absolute px-2 py-1 text-xs bg-base/80 border border-base-subtle
		       text-content-muted hover:text-content hover:bg-base rounded transition"
	>
		Reset Crop
	</button>
{/if}
