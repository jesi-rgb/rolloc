<script lang="ts">
	/**
	 * MiniCalendar — Compact calendar grid that highlights a specific date.
	 *
	 * Props:
	 * - date: Date | string — the date to highlight (ISO string or Date object)
	 *
	 * Displays:
	 * - Header: "MONTH YEAR" (e.g. "FEBRUARY 2026")
	 * - Grid of days with the specified date highlighted
	 */
	interface Props {
		date?: Date | string;
	}

	let { date }: Props = $props();

	const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

	const parsedDate = $derived(
		date ? (typeof date === "string" ? new Date(date) : date) : null,
	);

	// Derive calendar data
	const calendarData = $derived.by(() => {
		if (!parsedDate || isNaN(parsedDate.getTime())) {
			return null;
		}

		const year = parsedDate.getFullYear();
		const month = parsedDate.getMonth();
		const targetDay = parsedDate.getDate();

		// First day of the month
		const firstDay = new Date(year, month, 1);
		const startWeekday = firstDay.getDay(); // 0 = Sunday

		// Last day of the month
		const lastDay = new Date(year, month + 1, 0);
		const daysInMonth = lastDay.getDate();

		// Build the days array
		const days: (number | null)[] = [];

		// Leading empty cells (start week on Sunday)
		for (let i = 0; i < startWeekday; i++) {
			days.push(null);
		}

		// Days of the month
		for (let d = 1; d <= daysInMonth; d++) {
			days.push(d);
		}

		const monthName = parsedDate
			.toLocaleString("en-US", { month: "long" })
			.toUpperCase();

		return {
			monthName,
			year,
			days,
			targetDay,
		};
	});
</script>

{#snippet weekdayLabel(label: string)}
	<div
		class="text-center text-[0.625rem] font-medium size-5 text-content-muted"
	>
		{label}
	</div>
{/snippet}

{#if calendarData}
	<div class="text-xs leading-tight w-34">
		<!-- Header: MONTH YEAR -->
		<div
			class="text-[0.6875rem] text-center font-semibold mb-2 tracking-wide text-content-muted"
		>
			{calendarData.monthName}
			{calendarData.year}
		</div>

		<!-- Weekday labels and days -->
		<div class="grid grid-cols-7 place-items-center tabular-nums">
			{#each WEEKDAYS as day, i (i)}
				{@render weekdayLabel(day)}
			{/each}

			<!-- Days -->
			{#each calendarData.days as day, i (i)}
				{#if day === null}
					<div class="aspect-square invisible"></div>
				{:else}
					<div
						class="aspect-square size-5 flex items-center justify-center text-[0.6875rem] rounded-sm
					       {day === calendarData.targetDay
							? 'font-bold text-primary'
							: 'text-content'}"
					>
						{day}
					</div>
				{/if}
			{/each}
		</div>
	</div>
{:else}
	<p class="text-sm text-content-muted">—</p>
{/if}
