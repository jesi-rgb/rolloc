<script lang="ts">
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
		<!-- Sun icon -->
		<vg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
		</svg>
	{:else}
		<!-- Moon icon -->
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<circle cx="12" cy="12" r="4" />
			<path
				d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
			/>
		</svg>
	{/if}
</button>
