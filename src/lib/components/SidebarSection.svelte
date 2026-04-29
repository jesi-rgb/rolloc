<script lang="ts">
	import type { Snippet } from "svelte";

	interface Props {
		/** Whether this section uses the alternate (slightly darker) background. */
		alternate?: boolean;
		children: Snippet;
	}

	let { alternate = false, children }: Props = $props();
</script>

<section
	class="px-l py-base {alternate ? 'border-y border-base-subtle' : ''}"
	style={alternate ? 'background-color: var(--sidebar-section-alt);' : ''}
>
	{@render children()}
</section>
