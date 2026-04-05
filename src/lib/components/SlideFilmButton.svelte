<!--
	SlideFilmButton — Ektachrome inspired E-6 film type button.
	30% yellow top (#FEC431), 70% electric blue bottom (#1E429B).
-->
<script lang="ts">
	interface Props {
		selected?: boolean;
		onclick: () => void;
	}

	let { selected = false, onclick }: Props = $props();
</script>

<button
	type="button"
	{onclick}
	class="flex-1 h-12 text-sm font-bold rounded overflow-hidden transition-all
		{selected
		? 'ring-2 ring-white ring-offset-2 ring-offset-base-muted scale-105'
		: 'opacity-60 hover:opacity-100'}"
	style="background: linear-gradient(to bottom, #FEC431 30%, #1E429B 30%);"
>
	<span class="drop-shadow-[0_1px_1px_rgba(0,0,0,0.5)] text-white">E-6</span>
</button>
