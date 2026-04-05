<!--
	ColorFilmButton — Kodak Gold inspired C-41 film type button.
	1/3 yellow top (#FEC431), 2/3 magenta bottom (#DE5BD2).
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
	style="background: linear-gradient(to bottom, #FEC431 33.33%, #DE5BD2 33.33%);"
>
	<span class="drop-shadow-[0_1px_1px_rgba(0,0,0,0.5)] text-white">C-41</span>
</button>
