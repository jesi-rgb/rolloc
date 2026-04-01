/**
 * Theme store — persists 'light' | 'dark' to localStorage.
 * Uses a .svelte.ts module so $state is available as a reactive singleton.
 *
 * Import { theme, toggleTheme } wherever needed.
 * The +layout.svelte applies the class to <html>; nothing else needs to.
 */

type Theme = 'light' | 'dark';

const STORAGE_KEY = 'rolloc-theme';

function getInitialTheme(): Theme {
	if (typeof localStorage === 'undefined') return 'dark';
	const stored = localStorage.getItem(STORAGE_KEY);
	if (stored === 'light' || stored === 'dark') return stored;
	// Fall back to system preference
	return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// Module-level reactive state — shared across all importers
let _theme = $state<Theme>('dark');

export function initTheme(): void {
	_theme = getInitialTheme();
}

export function toggleTheme(): void {
	_theme = _theme === 'dark' ? 'light' : 'dark';
	localStorage.setItem(STORAGE_KEY, _theme);
}

export function getTheme(): Theme {
	return _theme;
}
