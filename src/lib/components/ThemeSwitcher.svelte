<script lang="ts">
	import { MoonIcon, SunIcon } from "phosphor-svelte";
	import { getTheme, toggleTheme } from "$lib/theme.svelte";

	const theme = $derived(getTheme());
</script>

<button
	onclick={toggleTheme}
	aria-label="Switch to {theme === 'dark' ? 'light' : 'dark'} theme"
	title="Switch to {theme === 'dark' ? 'light' : 'dark'} theme"
	class="p-sm rounded-lg text-content-muted hover:text-content hover:bg-base-subtle
	       transition-colors"
>
	{#if theme === "dark"}
		<MoonIcon size={18} />
	{:else}
		<SunIcon size={18} />
	{/if}
</button>
