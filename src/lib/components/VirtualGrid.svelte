<script lang="ts" generics="T">
	/**
	 * VirtualGrid — row-based virtual scroller for fixed-aspect-ratio grids.
	 *
	 * All items are assumed to share the same aspect ratio (default 3:2).
	 * Column count is derived from container width and a set of responsive
	 * breakpoints matching Tailwind's sm/md/lg/xl/2xl scale.
	 */
	import { createVirtualizer } from "@tanstack/svelte-virtual";
	import type { Readable } from "svelte/store";
	import { get } from "svelte/store";
	import type { SvelteVirtualizer } from "@tanstack/svelte-virtual";
	import type { Snippet } from "svelte";

	interface Props<T> {
		/** Full item array. */
		items: T[];
		/** Item aspect ratio (width / height). Default 3/2. */
		aspectRatio?: number;
		/** Gap between items in pixels. */
		gap?: number;
		/** Number of extra rows to render above/below viewport. */
		overscan?: number;
		/** Snippet rendered for each item. Receives the item and its flat index. */
		item: Snippet<[T, number]>;
		/** Bindable ref to the scroll container element. */
		scrollEl?: HTMLDivElement | null;
	}

	let {
		items,
		aspectRatio = 3 / 2,
		gap = 8,
		overscan = 3,
		item: itemSnippet,
		scrollEl = $bindable(null),
	}: Props<T> = $props();

	// ─── Responsive column breakpoints ───────────────────────────────────────────

	/** Matches Tailwind: grid-cols-2 sm:3 md:4 lg:5 xl:6 */
	function columnsForWidth(w: number): number {
		if (w >= 1280) return 6;
		if (w >= 1024) return 5;
		if (w >= 768) return 4;
		if (w >= 640) return 3;
		return 2;
	}

	// ─── State ────────────────────────────────────────────────────────────────────

	let containerWidth = $state(800); // reasonable default before first measurement

	const cols = $derived(columnsForWidth(containerWidth));
	const itemWidth = $derived((containerWidth - gap * (cols - 1)) / cols);
	const itemHeight = $derived(Math.round(itemWidth / aspectRatio));
	const rowHeight = $derived(itemHeight + gap);
	const rows = $derived(Math.ceil(items.length / cols));

	// ─── ResizeObserver to measure container width ────────────────────────────────

	$effect(() => {
		const el = scrollEl;
		if (!el) return;

		// Capture initial width immediately
		const initial = el.getBoundingClientRect().width;
		if (initial > 0) containerWidth = initial;

		const ro = new ResizeObserver((entries) => {
			const w = entries[0]?.contentRect.width;
			if (w && w > 0) containerWidth = w;
		});
		ro.observe(el);

		return () => ro.disconnect();
	});

	// ─── Virtualizer ──────────────────────────────────────────────────────────────

	// The tanstack/svelte-virtual library uses Svelte 4 stores internally.
	// We store the current virtualizer state in a plain $state variable by
	// subscribing to the store in an $effect.
	//
	// virtualInst tracks the current Virtualizer instance from the store.
	// We re-create the virtualizer only when scrollEl changes.

	let virtualStore: Readable<
		SvelteVirtualizer<HTMLDivElement, HTMLDivElement>
	> | null = null;
	let virtualInst = $state<SvelteVirtualizer<
		HTMLDivElement,
		HTMLDivElement
	> | null>(null);

	$effect(() => {
		const el = scrollEl;
		if (!el) {
			virtualInst = null;
			return;
		}

		// Create the virtualizer bound to this scroll element
		const store = createVirtualizer<HTMLDivElement, HTMLDivElement>({
			count: rows,
			getScrollElement: () => el,
			estimateSize: () => rowHeight,
			overscan,
			gap,
		});
		virtualStore = store;

		// Subscribe: every time the store updates, sync into $state
		const unsub = store.subscribe((v) => {
			virtualInst = v;
		});

		return () => {
			unsub();
			virtualStore = null;
			virtualInst = null;
		};
	});

	// Keep virtualizer options fresh when rows/rowHeight change.
	// Reading rows and rowHeight establishes reactive dependency.
	$effect(() => {
		const store = virtualStore;
		if (!store) return;
		const _rows = rows;
		const _rowHeight = rowHeight;
		const _gap = gap;
		const _overscan = overscan;
		get(store).setOptions({
			count: _rows,
			estimateSize: () => _rowHeight,
			gap: _gap,
			overscan: _overscan,
		});
	});

	// ─── Derived fallback height ──────────────────────────────────────────────────

	const totalHeightFallback = $derived(rows * rowHeight);
</script>

<!--
	Outer div: the scrollable viewport. The parent must constrain its height.
-->
<div bind:this={scrollEl} class="overflow-y-auto h-full w-full">
	{#if virtualInst}
		<div
			style="height: {virtualInst.getTotalSize()}px; position: relative; width: 100%;"
		>
			{#each virtualInst.getVirtualItems() as vRow (vRow.key)}
				{@const rowStart = vRow.index * cols}
				<div
					class="p-sm"
					style="
						position: absolute;
						top: 0;
						left: 0;
						right: 0;
						transform: translateY({vRow.start}px);
						display: grid;
						grid-template-columns: repeat({cols}, 1fr);
						gap: {gap}px;
					"
				>
					{#each { length: cols } as _, colIdx (colIdx)}
						{@const flatIdx = rowStart + colIdx}
						{#if flatIdx < items.length}
							{@const it = items[flatIdx]}
							{@render itemSnippet(it, flatIdx)}
						{:else}
							<!-- Empty cell to maintain grid alignment -->
							<div></div>
						{/if}
					{/each}
				</div>
			{/each}
		</div>
	{:else}
		<!-- Placeholder before virtualizer mounts -->
		<div style="height: {totalHeightFallback}px;"></div>
	{/if}
</div>
