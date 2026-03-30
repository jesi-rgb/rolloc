<script lang="ts">
	import type { Component } from "svelte";

	type Key = string | Component;

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
</script>

<footer
	class="flex items-baseline gap-base px-l py-xs
	       border-t border-base-subtle bg-base-muted select-none"
>
	{#each hints as hint (hint.label)}
		<span class="text-xs text-content-subtle flex items-baseline gap-xs">
			{#each hint.keys as key (key)}
				<kbd
					class="inline-flex items-center justify-center font-mono text-xs
					       px-xs py-xs min-w-sm
					       rounded border border-base-subtle bg-base
					       shadow-[0_2px_0_0_var(--color-base-subtle)]
					       text-content-muted leading-none"
				>
					{#if typeof key === "string"}
						{key}
					{:else}
						{@const IconComponent = key}
						<IconComponent size={12} />
					{/if}
				</kbd>
			{/each}
			{hint.label}
		</span>
	{/each}
	{#if progress}
		<span class="ml-auto text-xs text-content-subtle">{progress}</span>
	{/if}
</footer>
