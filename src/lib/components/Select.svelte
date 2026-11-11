<script lang="ts" generics="T extends string">
	import { CaretUpDownIcon, CheckIcon } from "phosphor-svelte";

	interface Option {
		value: T;
		label: string;
	}

	interface Props {
		value: T;
		options: Option[];
		onChange: (value: T) => void;
		id?: string;
		"aria-label"?: string;
		/** Extra classes for the trigger button. */
		class?: string;
	}

	let {
		value,
		options,
		onChange,
		id,
		"aria-label": ariaLabel,
		class: extraClass = "",
	}: Props = $props();

	let open = $state(false);
	let highlight = $state(0);
	let root = $state<HTMLDivElement | null>(null);
	let trigger = $state<HTMLButtonElement | null>(null);

	const current = $derived(options.find((o) => o.value === value));

	function show(): void {
		highlight = Math.max(0, options.findIndex((o) => o.value === value));
		open = true;
	}

	/** Close the menu and release focus so page shortcuts work again. */
	function close(): void {
		open = false;
		trigger?.blur();
	}

	function pick(opt: Option): void {
		if (opt.value !== value) onChange(opt.value);
		close();
	}

	function onKeyDown(e: KeyboardEvent): void {
		if (!open) {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				e.stopPropagation();
				show();
			}
			return;
		}
		// Keep menu keys away from the window-level shortcut handlers.
		e.stopPropagation();
		switch (e.key) {
			case "ArrowDown":
				e.preventDefault();
				highlight = (highlight + 1) % options.length;
				break;
			case "ArrowUp":
				e.preventDefault();
				highlight = (highlight - 1 + options.length) % options.length;
				break;
			case "Enter":
			case " ":
				e.preventDefault();
				if (options[highlight]) pick(options[highlight]);
				break;
			case "Escape":
			case "Tab":
				e.preventDefault();
				close();
				break;
		}
	}

	function onWindowPointerDown(e: PointerEvent): void {
		if (open && root && !root.contains(e.target as Node)) open = false;
	}
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<div bind:this={root} class="relative">
	<button
		bind:this={trigger}
		{id}
		type="button"
		aria-label={ariaLabel}
		aria-haspopup="listbox"
		aria-expanded={open}
		onclick={() => (open ? close() : show())}
		onkeydown={onKeyDown}
		class="w-full flex items-center justify-between gap-sm px-sm py-xs rounded-md
		       border text-sm text-content bg-base transition
		       {open
			? 'border-content-subtle'
			: 'border-base-subtle hover:border-content-subtle'}
		       {extraClass}"
	>
		<span class="truncate">{current?.label ?? ""}</span>
		<CaretUpDownIcon size={12} class="shrink-0 text-content-subtle" />
	</button>

	{#if open}
		<ul
			role="listbox"
			aria-label={ariaLabel}
			class="absolute z-30 left-0 right-0 mt-xs py-xs min-w-max rounded-md
			       border border-base-subtle bg-surface shadow-base animate-fadein"
		>
			{#each options as opt, i (opt.value)}
				<li
					role="option"
					aria-selected={opt.value === value}
					onpointerenter={() => (highlight = i)}
					onpointerdown={(e) => e.preventDefault()}
					onclick={() => pick(opt)}
					onkeydown={onKeyDown}
					tabindex="-1"
					class="flex items-center justify-between gap-sm mx-xs px-sm py-xs rounded
					       text-sm cursor-default select-none
					       {i === highlight ? 'bg-base-muted text-content' : 'text-content-muted'}"
				>
					{opt.label}
					{#if opt.value === value}
						<CheckIcon size={12} class="text-primary" />
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>
