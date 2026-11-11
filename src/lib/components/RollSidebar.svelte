<script lang="ts">
	/**
	 * Left-hand roll switcher for the roll browser.  One row per roll — label
	 * and date, then film stock and camera — with the active roll highlighted.
	 * Navigation only; roll actions live in the roll toolbar.
	 */
	import type { Roll } from "$lib/types";

	interface Props {
		rolls: Roll[];
		activeId: string;
	}

	let { rolls, activeId }: Props = $props();

	function formatDate(ms: number): string {
		return new Date(ms).toLocaleDateString(undefined, {
			year: "numeric",
			month: "short",
			day: "numeric",
		});
	}
</script>

<nav
	aria-label="Rolls"
	class="h-full overflow-y-auto p-sm"
>
	<ul class="flex flex-col gap-px">
		{#each rolls as roll (roll.id)}
			{@const active = roll.id === activeId}
			<li>
				<a
					href="/?roll={encodeURIComponent(roll.id)}"
					aria-current={active ? "page" : undefined}
					class="flex flex-col gap-0.5 rounded-md px-sm py-sm transition-colors
					       {active
						? 'bg-base-muted text-content'
						: 'text-content-muted hover:bg-base-muted/60 hover:text-content'}"
				>
					<span class="flex items-baseline gap-sm min-w-0">
						<!-- Explicit length: plain `text-base` also matches the `base`
						     colour token and would paint the label in the background colour. -->
						<span class="flex-1 min-w-0 text-(length:--text-base) font-medium truncate">
							{roll.label}
						</span>
						<span class="shrink-0 text-sm text-content-subtle tabular-nums">
							{formatDate(roll.createdAt)}
						</span>
					</span>
					<!-- Stock left, camera right.  Always rendered (min-h-[1lh] = one
					     line) so rows missing both keep the same height. -->
					<span class="flex justify-between gap-sm min-h-[1lh] text-sm text-content-subtle">
						<span class="min-w-0 truncate text-primary-muted/80">{roll.filmStock}</span>
						<span class="min-w-0 truncate text-right">{roll.camera ?? ""}</span>
					</span>
				</a>
			</li>
		{/each}
	</ul>
</nav>
