<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import { initTheme, getTheme } from '$lib/theme.svelte';
	import { initUpdater } from '$lib/updater.svelte';

	let { children } = $props();

	// Initialise from localStorage / system preference, then keep <html>
	// class in sync with the reactive theme state.
	$effect(() => {
		initTheme();
	});

	$effect(() => {
		const theme = getTheme();
		document.documentElement.classList.toggle('dark', theme === 'dark');
		document.documentElement.classList.toggle('light', theme === 'light');
	});

	// Check for updates on startup (Tauri only, no-op in browser).
	$effect(() => {
		initUpdater();
	});
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>
{@render children()}
