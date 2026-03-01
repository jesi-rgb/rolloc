<script lang="ts">
	/**
	 * AnalogClock — Compact analog clock that displays a specific time.
	 *
	 * Props:
	 * - date: Date | string — the time to display (ISO string or Date object)
	 *
	 * Displays:
	 * - Circular clock face with hour, minute, and second hands
	 * - Hour markers (12 dots)
	 * - Time text below (HH:MM:SS format)
	 */
	interface Props {
		date?: Date | string;
	}

	let { date }: Props = $props();

	const parsedDate = $derived(
		date ? (typeof date === "string" ? new Date(date) : date) : null,
	);

	const clockData = $derived.by(() => {
		if (!parsedDate || isNaN(parsedDate.getTime())) {
			return null;
		}

		const hours = parsedDate.getHours();
		const minutes = parsedDate.getMinutes();
		const seconds = parsedDate.getSeconds();

		// Calculate angles (0 degrees = 12 o'clock, clockwise)
		// Hour hand: 30° per hour + 0.5° per minute
		const hourAngle = (hours % 12) * 30 + minutes * 0.5;
		// Minute hand: 6° per minute
		const minuteAngle = minutes * 6;
		// Second hand: 6° per second
		const secondAngle = seconds * 6;

		// Format time string
		const timeString = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

		return {
			hourAngle,
			minuteAngle,
			secondAngle,
			timeString,
		};
	});

	const CLOCK_SIZE = 126; // Match MiniCalendar width (w-34 = 136px)
	const CENTER = CLOCK_SIZE / 2;
	const RADIUS = CENTER - 8;
	const HOUR_HAND_LENGTH = RADIUS * 0.5;
	const MINUTE_HAND_LENGTH = RADIUS * 0.7;
	const SECOND_HAND_LENGTH = RADIUS * 0.85;
</script>

{#if clockData}
	<div class="w-34 text-xs leading-tight">
		<!-- Clock face -->
		<svg
			width={CLOCK_SIZE}
			height={CLOCK_SIZE}
			viewBox="0 0 {CLOCK_SIZE} {CLOCK_SIZE}"
			class="overflow-visible"
		>
			<!-- Clock circle background -->
			<circle
				cx={CENTER}
				cy={CENTER}
				r={RADIUS}
				fill="none"
				stroke="currentColor"
				stroke-width="1.5"
				class="text-base-subtle"
			/>

			<!-- Hour markers (12 dots) -->
			{#each Array(12) as _, i (i)}
				{@const angle = i * 30}
				{@const rad = (angle - 90) * (Math.PI / 180)}
				{@const x = CENTER + (RADIUS - 6) * Math.cos(rad)}
				{@const y = CENTER + (RADIUS - 6) * Math.sin(rad)}
				<circle
					cx={x}
					cy={y}
					r={i % 3 === 0 ? 2 : 1.5}
					fill="currentColor"
					class="text-content-muted"
				/>
			{/each}

			<!-- Hour hand -->
			<line
				x1={CENTER}
				y1={CENTER}
				x2={CENTER +
					HOUR_HAND_LENGTH *
						Math.sin((clockData.hourAngle * Math.PI) / 180)}
				y2={CENTER -
					HOUR_HAND_LENGTH *
						Math.cos((clockData.hourAngle * Math.PI) / 180)}
				stroke="currentColor"
				stroke-width="3"
				stroke-linecap="round"
				class="text-content"
			/>

			<!-- Minute hand -->
			<line
				x1={CENTER}
				y1={CENTER}
				x2={CENTER +
					MINUTE_HAND_LENGTH *
						Math.sin((clockData.minuteAngle * Math.PI) / 180)}
				y2={CENTER -
					MINUTE_HAND_LENGTH *
						Math.cos((clockData.minuteAngle * Math.PI) / 180)}
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				class="text-content"
			/>

			<!-- Second hand -->
			<line
				x1={CENTER}
				y1={CENTER}
				x2={CENTER +
					SECOND_HAND_LENGTH *
						Math.sin((clockData.secondAngle * Math.PI) / 180)}
				y2={CENTER -
					SECOND_HAND_LENGTH *
						Math.cos((clockData.secondAngle * Math.PI) / 180)}
				stroke="currentColor"
				stroke-width="1"
				stroke-linecap="round"
				class="text-primary"
			/>

			<!-- Center dot -->
			<circle
				cx={CENTER}
				cy={CENTER}
				r="3"
				fill="currentColor"
				class="text-primary"
			/>
		</svg>
	</div>
{:else}
	<p class="text-sm text-content-muted">—</p>
{/if}
