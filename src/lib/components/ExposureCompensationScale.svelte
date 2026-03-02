<script lang="ts">
	/**
	 * Exposure compensation visual scale component.
	 *
	 * Displays a -2 to +2 EV scale with 1/3 stop increments and
	 * an indicator showing the current exposure compensation value.
	 */

	interface Props {
		/** Exposure compensation value in EV stops */
		value: number;
	}

	let { value }: Props = $props();

	/**
	 * Calculate position (0-100%) for exposure compensation value on the -2 to +2 scale.
	 */
	function calculateEVPosition(ev: number): number {
		// Map -2 to +2 range to 0-100%
		const normalized = (ev + 2) / 4;
		return Math.max(0, Math.min(100, normalized * 100));
	}

	/**
	 * Generate tick marks for -2 to +2 in 1/3 stop increments.
	 * Major ticks at whole stops, minor ticks at 1/3 stops.
	 */
	function getEVTicks() {
		const ticks = [];
		for (let ev = -2; ev <= 2; ev += 1 / 3) {
			const rounded = Math.round(ev * 3) / 3; // Avoid floating point errors
			const isWhole = Math.abs(rounded - Math.round(rounded)) < 0.01;
			const position = calculateEVPosition(rounded);
			ticks.push({
				value: rounded,
				position,
				isWhole,
				label: isWhole
					? rounded > 0
						? `+${rounded}`
						: `${rounded}`
					: null,
			});
		}
		return ticks;
	}

	function formatEV(ev: number): string {
		const sign = ev > 0 ? "+" : "";
		return `${sign}${ev.toFixed(1)} EV`;
	}
</script>

<div class="relative px-2">
	<!-- EV scale line -->
	<div class="relative h-6 flex items-center">
		<!-- Background line -->
		<div class="absolute inset-x-0 h-px bg-base-subtle"></div>

		<!-- Tick marks -->
		{#each getEVTicks() as tick (tick.value)}
			<div
				class="absolute transform -translate-x-1/2"
				style="left: {tick.position}%"
			>
				<!-- Tick mark -->
				<div
					class="w-px bg-content-muted"
					class:h-2.5={tick.isWhole}
					class:h-1={!tick.isWhole}
					style="margin: 0 auto;"
				></div>
				<!-- Label for whole stops -->
				{#if tick.label !== null}
					<div
						class="text-xs text-content-muted mt-0.5 absolute left-1/2 transform -translate-x-1/2 whitespace-nowrap"
					>
						{tick.label}
					</div>
				{/if}
			</div>
		{/each}

		<!-- Current value indicator -->
		<div
			class="absolute top-0 transform -translate-x-1/2 -translate-y-0.5
			h-full"
			style="left: {calculateEVPosition(value)}%"
		>
			<div
				class="bg-content size-1.5 border rounded-full"
				title={formatEV(value)}
			></div>
		</div>
	</div>

	<!-- Current value label -->
	<div class="text-center text-xs mt-5">
		{formatEV(value)}
	</div>
</div>
