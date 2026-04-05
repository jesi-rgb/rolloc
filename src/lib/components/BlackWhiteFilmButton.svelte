<!--
	BlackWhiteFilmButton — Ilford inspired B&W film type button.
	80% white top, 20% black bottom, green text (#08A242).
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
	style="background: linear-gradient(to bottom, #ffffff 80%, #000000 80%);"
>
	<span style="color: #08A242;" class="drop-shadow-[0_1px_0px_rgba(255,255,255,0.3)]">B&W</span>
</button>
