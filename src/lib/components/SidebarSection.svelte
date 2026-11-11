<script lang="ts">
	import type { Snippet } from "svelte";

	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();
</script>

<section class="px-l py-base border-b border-base-subtle last:border-b-0">
	{@render children()}
</section>
