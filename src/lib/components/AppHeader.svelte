<script lang="ts" module>
	export type AppTab = "rolls" | "libraries";
</script>

<script lang="ts">
	/**
	 * App-level top bar: brand, Rolls / Libraries tabs and the primary
	 * "New …" action.  Tab hrefs come from the page so they can carry state
	 * (the selected roll) across tab switches.
	 */
	import { PlusIcon } from "phosphor-svelte";

	interface Props {
		active: AppTab;
		rollsHref: string;
		librariesHref: string;
		actionLabel: string;
		onAction: () => void;
	}

	let { active, rollsHref, librariesHref, actionLabel, onAction }: Props = $props();

	const tabs = $derived<{ id: AppTab; label: string; href: string }[]>([
		{ id: "rolls", label: "Rolls", href: rollsHref },
		{ id: "libraries", label: "Libraries", href: librariesHref },
	]);
</script>

<header
	class="flex items-center gap-l px-l h-14 shrink-0 border-b border-base-subtle"
>
	<span class="text-xl font-bold tracking-tight text-primary-muted">Rolloc</span>

	<nav class="flex items-center gap-xs" aria-label="Collections">
		{#each tabs as tab (tab.id)}
			<a
				href={tab.href}
				aria-current={active === tab.id ? "page" : undefined}
				class="px-sm py-xs rounded-md text-sm font-medium transition-colors
				       {active === tab.id
					? 'bg-base-muted text-content'
					: 'text-content-muted hover:text-content'}"
			>
				{tab.label}
			</a>
		{/each}
	</nav>

	<button
		type="button"
		onclick={onAction}
		class="ml-auto flex items-center gap-xs px-sm py-xs rounded-md bg-primary
		       text-primary-content text-sm font-medium hover:bg-primary-muted
		       transition-[background-color,transform] duration-150 ease-out active:scale-[0.97]"
	>
		<PlusIcon size={14} weight="bold" />
		{actionLabel}
	</button>
</header>
