<script lang="ts">
	import type { Component } from "svelte";
	import { getTheme, toggleTheme } from "$lib/theme.svelte";
	import {
		getAvailableUpdate,
		isDownloading,
		installUpdate,
		checkForUpdate,
		isChecking,
		getError,
		clearError,
		updaterAvailable,
	} from "$lib/updater.svelte";
	import {
		SunIcon,
		MoonIcon,
		DownloadSimpleIcon,
		ArrowClockwiseIcon,
		WarningIcon,
		CommandIcon,
		ArrowFatUpIcon,
	} from "phosphor-svelte";

	/** An icon key bound to one or more KeyboardEvent.key values. */
	interface IconKey {
		icon: Component;
		eventKey: string | string[];
	}

	type Key = string | Component | IconKey;

	interface Hint {
		keys: Key[];
		label: string;
	}

	interface Props {
		hints: Hint[];
		/** Optional progress text shown on the right (e.g. "thumbnails: 12/100"). */
		progress?: string;
	}

	let { hints, progress }: Props = $props();

	const theme = $derived(getTheme());
	const update = $derived(getAvailableUpdate());
	const downloading = $derived(isDownloading());
	const checking = $derived(isChecking());
	const updateError = $derived(getError());
	const canCheck = $derived(updaterAvailable());

	/** Type guard: is the key an IconKey object (not a bare Component)? */
	function isIconKey(key: Key): key is IconKey {
		return typeof key === "object" && key !== null && "icon" in key && "eventKey" in key;
	}

	/**
	 * Map display label → KeyboardEvent.key values that should activate it.
	 * A single display key can match multiple physical keys (e.g. "←" matches "ArrowLeft").
	 *
	 * For range-like labels (Q–E, A–D) we deliberately list only the keyboard-row
	 * neighbours the user actually controls: Q/W/E and A/S/D.
	 */
	const DISPLAY_TO_KEYS: Record<string, string[]> = {
		"←": ["ArrowLeft"],
		"→": ["ArrowRight"],
		"↑": ["ArrowUp"],
		"↓": ["ArrowDown"],
		Esc: ["Escape"],
		"⌫": ["Backspace"],
		"⏎": ["Enter"],
		" ": [" "],
		"Q–E": ["q", "Q", "w", "W", "e", "E"],
		"A–D": ["a", "A", "s", "S", "d", "D"],
	};

	/** Resolve a display key string to the set of KeyboardEvent.key values it represents. */
	function eventKeysFor(display: string): string[] {
		if (DISPLAY_TO_KEYS[display]) return DISPLAY_TO_KEYS[display];

		// Single-character keys — match both cases.
		if (display.length === 1) {
			return [display, display.toLowerCase(), display.toUpperCase()];
		}

		return [display];
	}

	/**
	 * Stable identity string for a Key — used as the reactive lookup key
	 * in pressedKeys and as the {#each} keyed-id for icon keys.
	 */
	function keyId(key: Key): string {
		if (typeof key === "string") return key;
		if (isIconKey(key)) return `__icon_${Array.isArray(key.eventKey) ? key.eventKey.join(",") : key.eventKey}`;
		// Bare Component — no event binding, use object identity via toString.
		return `__comp_${String(key)}`;
	}

	/**
	 * Build a map from KeyboardEvent.key → set of Key identity strings.
	 * Covers both string keys and IconKey objects.
	 */
	function collectAllEventKeys(h: Hint[]): Map<string, Set<string>> {
		const map = new Map<string, Set<string>>();

		function register(eventKey: string, id: string): void {
			if (!map.has(eventKey)) map.set(eventKey, new Set());
			map.get(eventKey)!.add(id);
		}

		for (const hint of h) {
			for (const key of hint.keys) {
				if (typeof key === "string") {
					const id = key;
					for (const ek of eventKeysFor(key)) register(ek, id);
				} else if (isIconKey(key)) {
					const id = keyId(key);
					const evKeys = Array.isArray(key.eventKey) ? key.eventKey : [key.eventKey];
					for (const ek of evKeys) register(ek, id);
				}
				// Bare Components without eventKey are display-only — skip.
			}
		}
		return map;
	}

	let eventKeyToDisplay = $derived(collectAllEventKeys(hints));

	/** The set of key identity strings currently pressed. */
	let pressedKeys: Set<string> = $state(new Set());

	function onKeyDown(e: KeyboardEvent): void {
		const displays = eventKeyToDisplay.get(e.key);
		if (!displays) return;
		pressedKeys = new Set([...pressedKeys, ...displays]);
	}

	function onKeyUp(e: KeyboardEvent): void {
		const displays = eventKeyToDisplay.get(e.key);
		if (!displays) return;
		const next = new Set(pressedKeys);
		for (const d of displays) next.delete(d);
		pressedKeys = next;
	}

	/** Clear all pressed keys when the window loses focus. */
	function onBlur(): void {
		if (pressedKeys.size > 0) pressedKeys = new Set();
	}
</script>

<svelte:window onkeydown={onKeyDown} onkeyup={onKeyUp} onblur={onBlur} />

<footer
	class="flex items-center gap-base px-l py-xs
	       border-t border-base-subtle bg-base-muted select-none"
>
	{#each hints as hint (hint.label)}
		<span class="text-xs text-content-subtle flex items-baseline gap-xs">
			{#each hint.keys as key (keyId(key))}
				{@const pressed = pressedKeys.has(keyId(key))}
				<kbd
					class="inline-flex items-center justify-center font-mono text-xs
					       px-xs py-xs min-w-sm
					       rounded border border-base-subtle bg-base text-content-muted
					       leading-none transition-[transform,box-shadow] duration-75
					       {pressed
						? 'translate-y-[2px] shadow-none'
						: 'translate-y-0 shadow-[0_2px_0_0_var(--color-base-subtle)]'}"
				>
					{#if typeof key === "string"}
						{key}
					{:else if isIconKey(key)}
						{@const IconComponent = key.icon}
						<IconComponent size={10} />
					{:else}
						{@const IconComponent = key}
						<IconComponent size={10} />
					{/if}
				</kbd>
			{/each}
			{hint.label}
		</span>
	{/each}
	{#if progress}
		<span class="ml-auto text-xs text-content-subtle">{progress}</span>
	{/if}

	<!-- Update available indicator -->
	{#if update}
		<button
			onclick={installUpdate}
			disabled={downloading}
			aria-label={downloading ? "Installing update..." : `Update to ${update.version}`}
			title={downloading ? "Installing update..." : `Update to ${update.version}`}
			class="flex items-center gap-xs px-xs py-0.5 rounded text-xs
			       {downloading
				? 'text-content-muted cursor-wait'
				: 'text-accent hover:bg-accent/10 transition-colors'}
			       {progress ? '' : 'ml-auto'}"
		>
			<DownloadSimpleIcon size={14} class={downloading ? 'animate-bounce' : ''} />
			<span>{downloading ? 'Installing...' : `v${update.version}`}</span>
		</button>
	{:else if updateError}
		<button
			onclick={() => { clearError(); checkForUpdate(); }}
			aria-label="Update check failed: {updateError}. Click to retry."
			title="Update check failed: {updateError}. Click to retry."
			class="flex items-center gap-xs px-xs py-0.5 rounded text-xs
			       text-red-500 hover:bg-red-500/10 transition-colors
			       {progress ? '' : 'ml-auto'}"
		>
			<WarningIcon size={14} />
			<span>update check failed</span>
		</button>
	{/if}

	<!-- Manual "check for updates" button (Tauri only) -->
	{#if canCheck && !update}
		<button
			onclick={() => checkForUpdate()}
			disabled={checking}
			aria-label={checking ? "Checking for updates..." : "Check for updates"}
			title={checking ? "Checking for updates..." : "Check for updates"}
			class="p-0.5 rounded text-content-muted hover:text-content transition-colors
			       {checking ? 'cursor-wait' : ''}
			       {progress || updateError ? '' : 'ml-auto'}"
		>
			<ArrowClockwiseIcon size={14} class={checking ? 'animate-spin' : ''} />
		</button>
	{/if}

	<!-- Theme toggle (sun/moon) -->
	<button
		onclick={toggleTheme}
		aria-label="Switch to {theme === 'dark' ? 'light' : 'dark'} theme"
		title="Switch to {theme === 'dark' ? 'light' : 'dark'} theme"
		class="p-0.5 rounded text-content-muted hover:text-content transition-colors {progress || update || updateError || canCheck ? '' : 'ml-auto'}"
	>
		{#if theme === "dark"}
			<SunIcon size={14} />
		{:else}
			<MoonIcon size={14} />
		{/if}
	</button>
</footer>
