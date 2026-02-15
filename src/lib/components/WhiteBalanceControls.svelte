<script lang="ts">
	import type { WhiteBalance } from '$lib/types';
	import { untrack } from 'svelte';

	interface Props {
		value: WhiteBalance;
		onChange: (wb: WhiteBalance) => void;
	}

	let { value, onChange }: Props = $props();

	let temperature = $state(untrack(() => value.temperature));
	let tint        = $state(untrack(() => value.tint));

	// Re-sync when the parent swaps to a different frame
	$effect(() => {
		// Deliberately reading reactive `value` to react to prop changes,
		// then writing local copies — acceptable pattern per AGENTS.md.
		temperature = value.temperature;
		tint        = value.tint;
	});

	function emit(): void {
		onChange({ temperature, tint });
	}

	// Named Kelvin presets
	const PRESETS: { label: string; temp: number }[] = [
		{ label: 'Tungsten',   temp: 2800 },
		{ label: 'Fluorescent',temp: 4000 },
		{ label: 'Daylight',   temp: 5500 },
		{ label: 'Cloudy',     temp: 6500 },
		{ label: 'Shade',      temp: 7500 },
	];
</script>

<div class="flex flex-col gap-sm">
	<!-- Temperature -->
	<div class="flex flex-col gap-xs">
		<div class="flex items-center justify-between">
			<label for="wb-temperature" class="text-xs font-medium text-content-muted uppercase tracking-wide">
				Temperature
			</label>
			<span class="text-xs text-content font-mono tabular-nums">{temperature}K</span>
		</div>
		<input
			id="wb-temperature"
			type="range"
			min="1000"
			max="12000"
			step="50"
			bind:value={temperature}
			oninput={emit}
			class="w-full h-1.5 rounded-full appearance-none cursor-pointer
			       bg-gradient-to-r from-[#a8c4ff] via-[#fff8e7] to-[#ffa53d]
			       accent-primary"
		/>
		<!-- Presets -->
		<div class="flex gap-xs flex-wrap">
			{#each PRESETS as p (p.label)}
				<button
					onclick={() => { temperature = p.temp; emit(); }}
					class="text-[10px] px-[6px] py-[2px] rounded border transition
					       {temperature === p.temp
					         ? 'border-primary bg-primary/10 text-primary'
					         : 'border-base-subtle text-content-muted hover:border-content-muted'}"
				>
					{p.label}
				</button>
			{/each}
		</div>
	</div>

	<!-- Tint -->
	<div class="flex flex-col gap-xs">
		<div class="flex items-center justify-between">
			<label for="wb-tint" class="text-xs font-medium text-content-muted uppercase tracking-wide">
				Tint
			</label>
			<span class="text-xs text-content font-mono tabular-nums">
				{tint > 0 ? `+${tint}` : tint}
			</span>
		</div>
		<input
			id="wb-tint"
			type="range"
			min="-100"
			max="100"
			step="1"
			bind:value={tint}
			oninput={emit}
			class="w-full h-1.5 rounded-full appearance-none cursor-pointer
			       bg-gradient-to-r from-[#c84b8a] via-[#e8e8e8] to-[#4bbc6a]
			       accent-primary"
		/>
	</div>

	<!-- Reset -->
	{#if temperature !== 5500 || tint !== 0}
		<button
			onclick={() => { temperature = 5500; tint = 0; emit(); }}
			class="self-start text-xs text-content-subtle hover:text-content transition"
		>
			Reset
		</button>
	{/if}
</div>
