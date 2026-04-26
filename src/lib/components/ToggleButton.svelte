<script lang="ts">
	import type { Snippet } from "svelte";

	interface Props {
		/** Whether the button is in the "active/selected" state. */
		active?: boolean;
		/** Click handler. */
		onclick?: (e: MouseEvent) => void;
		/** Native tooltip (also used as accessible name fallback). */
		title?: string;
		/** Accessible label. */
		"aria-label"?: string;
		/** When true, the button stretches to fill its flex parent. */
		fill?: boolean;
		/** When true, the button takes the full width of its (block) parent. */
		block?: boolean;
		/** Disable the button. */
		disabled?: boolean;
		/** Button content (icon + label). */
		children: Snippet;
	}

	let {
		active = false,
		onclick,
		title,
		"aria-label": ariaLabel,
		fill = false,
		block = false,
		disabled = false,
		children,
	}: Props = $props();
</script>

<!--
	ToggleButton
	Compact pill-style toggle/action button matching the design of the
	"White Balance" picker button: bordered, with a subtle primary-tinted
	active state and a muted inactive state that brightens on hover.
-->

<button
	type="button"
	{onclick}
	{title}
	{disabled}
	aria-label={ariaLabel}
	aria-pressed={active}
	class="flex items-center gap-xs group text-xs px-sm py-xs rounded border transition
	       disabled:opacity-50 disabled:cursor-not-allowed
	       {fill ? 'flex-1 justify-center' : ''}
	       {block ? 'w-full justify-center' : ''}
	       {active
		? 'border-primary bg-primary-subtle/10 text-primary'
		: 'border-base-subtle text-content-muted hover:border-content-muted hover:text-content'}"
>
	{@render children()}
</button>
