<script lang="ts">
	/**
	 * Free-text input with a dropdown of previously used values.
	 *
	 * Focusing shows recent entries; typing filters them. When the typed text
	 * matches no existing entry exactly, a "Create" row is offered so the new
	 * value can be confirmed from the keyboard. New values need no separate
	 * persistence — they are stored on the roll and resurface via `options`.
	 */
	interface Props {
		value:       string;
		/** Previously used values, most relevant first. */
		options:     string[];
		placeholder: string;
	}

	let { value = $bindable(), options, placeholder }: Props = $props();

	const MAX_SUGGESTIONS = 8;

	interface Suggestion {
		kind:  'existing' | 'create';
		label: string;
	}

	let open      = $state(false);
	let activeIdx = $state(-1);

	let suggestions = $derived.by((): Suggestion[] => {
		const typed = value.trim();
		const q     = typed.toLowerCase();
		const matches: Suggestion[] = options
			.filter((o) => o.toLowerCase().includes(q))
			.slice(0, MAX_SUGGESTIONS)
			.map((label) => ({ kind: 'existing', label }));
		const exact = options.some((o) => o.toLowerCase() === q);
		if (typed && !exact) matches.push({ kind: 'create', label: typed });
		return matches;
	});

	// Reset active index whenever the suggestion list changes.
	$effect(() => {
		suggestions; // track
		activeIdx = -1;
	});

	function pick(s: Suggestion) {
		value = s.label;
		open  = false;
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
			// Close only the dropdown, not the surrounding dialog.
			e.stopPropagation();
			open = false;
		}
	}

	function handleBlur() {
		// Delay so a mouse click on a suggestion registers before the dropdown closes.
		setTimeout(() => { open = false; }, 150);
	}
</script>

<div class="relative">
	<input
		bind:value
		type="text"
		{placeholder}
		autocomplete="off"
		spellcheck="false"
		oninput={() => { open = true; }}
		onfocus={() => { open = true; }}
		onkeydown={handleKeydown}
		onblur={handleBlur}
		class="mt-1 w-full rounded-lg bg-base border border-base-subtle px-sm py-sm text-sm
		       text-content placeholder-content-subtle
		       focus:outline-none focus:border-primary transition"
	/>

	{#if open && suggestions.length > 0}
		<ul
			role="listbox"
			class="absolute z-50 mt-1 w-full rounded-lg border border-base-subtle bg-surface
			       shadow-lg overflow-hidden"
		>
			{#each suggestions as s, i (`${s.kind}:${s.label}`)}
				<li
					role="option"
					aria-selected={activeIdx === i}
					class="px-sm py-sm text-sm cursor-pointer transition-colors select-none truncate
					       {activeIdx === i ? 'bg-primary/20 text-content' : 'text-content hover:bg-base-subtle'}"
					onmousedown={() => pick(s)}
				>
					{#if s.kind === 'create'}
						<span class="text-content-muted">+ Create</span>
						<span class="font-medium">“{s.label}”</span>
					{:else}
						{s.label}
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>
