<script lang="ts">
	import { FILM_STOCKS, FILM_TYPE_LABEL, type FilmStock } from '$lib/data/film-stocks';

	interface Props {
		value:    string;
		onSelect: (stock: FilmStock) => void;
	}

	let { value = $bindable(), onSelect }: Props = $props();

	let open       = $state(false);
	let activeIdx  = $state(-1);

	/** Filtered list shown in the dropdown. */
	let suggestions = $derived(
		value.trim().length === 0
			? []
			: (() => {
				const q = value.trim().toLowerCase();
				return FILM_STOCKS
					.filter(s => `${s.brand} ${s.model}`.toLowerCase().includes(q))
					.slice(0, 8);
			})(),
	);

	// Reset active index whenever the suggestion list changes.
	$effect(() => {
		suggestions; // track
		activeIdx = -1;
	});

	function handleInput() {
		open = true;
	}

	function pick(stock: FilmStock) {
		value = `${stock.brand} ${stock.model}`;
		open  = false;
		onSelect(stock);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (!open || suggestions.length === 0) return;

		if (e.key === 'ArrowDown') {
			e.preventDefault();
			activeIdx = (activeIdx + 1) % suggestions.length;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			activeIdx = (activeIdx - 1 + suggestions.length) % suggestions.length;
		} else if (e.key === 'Enter') {
			if (activeIdx >= 0 && activeIdx < suggestions.length) {
				e.preventDefault();
				pick(suggestions[activeIdx]);
			}
		} else if (e.key === 'Escape') {
			open = false;
		}
	}

	function handleBlur() {
		// Delay so a mouse click on a suggestion registers before the dropdown closes.
		setTimeout(() => { open = false; }, 150);
	}

	function handleFocus() {
		if (suggestions.length > 0) open = true;
	}

	const TYPE_PILL: Record<string, string> = {
		C41: 'bg-amber-500/20 text-amber-300',
		BW:  'bg-content-subtle/20 text-content-subtle',
		E6:  'bg-emerald-500/20 text-emerald-300',
	};
</script>

<div class="relative">
	<input
		bind:value
		type="text"
		placeholder="e.g. Kodak Portra 400"
		autocomplete="off"
		spellcheck="false"
		oninput={handleInput}
		onkeydown={handleKeydown}
		onblur={handleBlur}
		onfocus={handleFocus}
		class="mt-1 w-full rounded-lg bg-base border border-base-subtle px-sm py-sm text-sm
		       text-content placeholder-content-subtle
		       focus:outline-none focus:border-primary transition"
	/>

	{#if open && suggestions.length > 0}
		<ul
			role="listbox"
			class="absolute z-50 mt-1 w-full rounded-lg border border-base-subtle bg-base-muted
			       shadow-lg overflow-hidden"
		>
			{#each suggestions as stock, i (stock.brand + stock.model)}
				<li
					role="option"
					aria-selected={activeIdx === i}
					class="flex items-center justify-between gap-2 px-sm py-sm text-sm cursor-pointer
					       transition-colors select-none
					       {activeIdx === i ? 'bg-primary/20 text-content' : 'text-content hover:bg-base-subtle'}"
					onmousedown={() => pick(stock)}
				>
					<span>
						<span class="font-medium">{stock.brand}</span>
						<span class="text-content-muted"> {stock.model}</span>
					</span>
					<span class="flex items-center gap-1 shrink-0">
						<span class="rounded px-1 py-px text-xs font-medium {TYPE_PILL[stock.type] ?? ''}">
							{FILM_TYPE_LABEL[stock.type] ?? stock.type}
						</span>
						<span class="text-xs text-content-subtle">ISO {stock.iso}</span>
					</span>
				</li>
			{/each}
		</ul>
	{/if}
</div>
