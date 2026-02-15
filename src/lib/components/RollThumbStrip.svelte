<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { getFrames } from '$lib/db/idb';
	import { getRollHandle } from '$lib/db/rolls';
	import { thumbURL } from '$lib/fs/opfs';
	import { getThumbURL } from '$lib/image/thumbgen';
	import { getFile } from '$lib/fs/directory';
	import type { Frame } from '$lib/types';

	interface Props {
		rollId: string;
	}

	let { rollId }: Props = $props();

	const PREVIEW_COUNT = 5;

	interface ThumbEntry {
		frame: Frame;
		url: string | null;
	}

	let entries = $state<ThumbEntry[]>([]);
	const revokeUrls: string[] = [];

	onMount(async () => {
		const frames = (await getFrames(rollId)).slice(0, PREVIEW_COUNT);
		if (frames.length === 0) return;

		// Populate with placeholders so skeleton shows immediately
		entries = frames.map((frame) => ({ frame, url: null }));

		let handle: FileSystemDirectoryHandle | null = null;

		for (let i = 0; i < frames.length; i++) {
			const frame = frames[i];

			// Try OPFS cache first (no handle needed)
			let url = await thumbURL(frame.id);

			if (!url) {
				// Lazily acquire the directory handle
				if (!handle) handle = await getRollHandle(rollId);
				if (handle) {
					try {
						const file = await getFile(handle, frame.filename);
						url = await getThumbURL(frame.id, file);
					} catch {
						// leave null — thumbnail stays as skeleton
					}
				}
			}

			if (url) {
				revokeUrls.push(url);
				entries[i] = { frame, url };
			}
		}
	});

	onDestroy(() => {
		for (const url of revokeUrls) URL.revokeObjectURL(url);
	});
</script>

<!--
	Compact filmstrip of the first ~5 thumbnails for a roll card.
	Shows animated skeletons while loading, falls back to a plain gradient
	if the roll has no frames yet.
-->
<div class="flex gap-px w-full overflow-hidden" style="height: 80px;">
	{#if entries.length === 0}
		<!-- No frames yet: show the accent gradient bar -->
		<div class="w-full h-full bg-gradient-to-r from-primary to-orange-600 opacity-70"></div>
	{:else}
		{#each entries as entry (entry.frame.id)}
			<div class="flex-1 min-w-0 overflow-hidden bg-base-subtle relative">
				{#if entry.url}
					<img
						src={entry.url}
						alt="Frame {entry.frame.index}"
						class="w-full h-full object-cover"
					/>
				{:else}
					<div class="w-full h-full animate-pulse bg-base-muted"></div>
				{/if}
			</div>
		{/each}
	{/if}
</div>
