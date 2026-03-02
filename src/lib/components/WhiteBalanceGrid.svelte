<script lang="ts">
	/**
	 * White balance adjustment visualization component.
	 *
	 * Displays a grid of colored dots showing the white balance shift.
	 * Matches Fujifilm camera WB SHIFT interface:
	 * X-axis (horizontal, R): -9 green (left) to +9 red (right)
	 * Y-axis (vertical, B): -9 blue/cool (top) to +9 yellow/warm (bottom)
	 */

	interface Props {
		/** Warm/Cool adjustment value (B axis: -9 blue/cool to +9 yellow/warm) */
		warmCool: number;
		/** Red/Green adjustment value (R axis: -9 green to +9 red) */
		magentaGreen: number;
	}

	let { warmCool, magentaGreen }: Props = $props();

	/**
	 * Generate all grid points from -9 to +9 on both axes.
	 * Y-axis inverted: start from -9 (blue/cool at top) to +9 (yellow/warm at bottom)
	 */
	function getGridPoints() {
		const points = [];
		for (let y = -9; y <= 9; y++) {
			for (let x = -9; x <= 9; x++) {
				points.push({ x, y });
			}
		}
		return points;
	}

	/**
	 * Calculate the color for a grid point based on its position.
	 * To match Fujifilm camera interface:
	 * X-axis: -9 = green (left), 0 = neutral, +9 = red (right)
	 * Y-axis: -9 = blue/cool (top), 0 = neutral, +9 = yellow/warm (bottom)
	 */
	function getPointColor(x: number, y: number): string {
		// Normalize to 0-1 range
		const normX = (x + 9) / 18; // 0 = green (left), 1 = red (right)
		const normY = (y + 9) / 18; // 0 = blue/cool (top), 1 = yellow/warm (bottom)

		// Base color temperature (cool to warm)
		// Cool (top, normY=0) = blue, Warm (bottom, normY=1) = yellow
		const warmth = normY * 255; // More yellow as we go down
		const coolness = (1 - normY) * 180; // More blue as we go up

		// Tint (green to red)
		// Green (left, normX=0), Red (right, normX=1)
		const redness = normX * 200; // More red as we go right
		const greenness = (1 - normX) * 150; // More green as we go left

		// Combine channels
		const r = Math.round(warmth * 0.8 + redness);
		const g = Math.round(warmth * 0.7 + greenness);
		const b = Math.round(coolness + (1 - normX) * 80);

		return `rgb(${Math.min(r, 255)}, ${Math.min(g, 255)}, ${Math.min(b, 255)})`;
	}

	/**
	 * Check if a point is the selected white balance point.
	 * Note: Y-axis is inverted - positive B values (blue/cool) are at the top,
	 * negative B values (yellow/warm) are at the bottom.
	 */
	function isSelectedPoint(x: number, y: number): boolean {
		return Math.round(magentaGreen) === x && Math.round(-warmCool) === y;
	}

	/**
	 * Format the white balance values for display.
	 */
	function formatWB(wc: number, mg: number): string {
		const mgStr = mg > 0 ? `+${mg.toFixed(0)}` : `${mg.toFixed(0)}`;
		const wcStr = wc > 0 ? `+${wc.toFixed(0)}` : `${wc.toFixed(0)}`;
		return `R:${mgStr} B:${wcStr}`;
	}
</script>

<!-- Grid container (square aspect ratio) -->
<div class="flex flex-col gap-sm">
	<!-- Grid background -->
	<div class="relative inset-0 aspect-square size-30 bg-black rounded p-1">
		<!-- Grid of colored dots -->
		<div class="grid grid-cols-19 w-full h-full place-items-center">
			{#each getGridPoints() as point (`${point.x},${point.y}`)}
				<div
					class="aspect-square transition-all size-0.5"
					class:ring-2={isSelectedPoint(point.x, point.y)}
					class:ring-white={isSelectedPoint(point.x, point.y)}
					class:ring-offset-1={isSelectedPoint(point.x, point.y)}
					class:ring-offset-black={isSelectedPoint(point.x, point.y)}
					class:scale-125={isSelectedPoint(point.x, point.y)}
					style="background-color: {getPointColor(point.x, point.y)}"
					title={`MG: ${point.x}, WC: ${point.y}`}
				></div>
			{/each}
		</div>

		<!-- Center crosshair -->
		<div
			class="absolute inset-0 flex items-center justify-center pointer-events-none"
		>
			<div class="absolute w-full h-px bg-white/30"></div>
			<div class="absolute h-full w-px bg-white/30"></div>
		</div>
	</div>
	<!-- Current value label -->
	<div class="text-xs">
		{formatWB(warmCool, magentaGreen)}
	</div>
</div>
