<script lang="ts">
	interface Hint {
		keys: string[];
		label: string;
	}

	interface Props {
		hints: Hint[];
	}

	let { hints }: Props = $props();
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
					       text-content-muted leading-none">{key}</kbd
				>
			{/each}
			{hint.label}
		</span>
	{/each}
</footer>
