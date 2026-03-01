<script lang="ts">
	/**
	 * Frame metadata panel — image preview, rating (0–5 stars), pick/reject flags, notes.
	 * Emits updates via onUpdate; parent is responsible for persisting to IDB.
	 */
	import { untrack, onDestroy } from "svelte";
	import {
		StarIcon,
		ThumbsUpIcon,
		ThumbsDownIcon,
	} from "phosphor-svelte";
	import { putFrame } from "$lib/db/idb";
	import { getFile } from "$lib/fs/directory";
	import { getThumbURL, getPreviewURL } from "$lib/image/thumbgen";
	import type { Frame, FrameFlag } from "$lib/types";

	interface Props {
		frame: Frame;
		dirPath?: string | null;
		onUpdate?: (updated: Frame) => void;
	}

	let { frame, dirPath = null, onUpdate }: Props = $props();

	// Local editable copies — initialised without tracking the prop
	// so Svelte doesn't warn about capturing the initial value only.
	let rating = $state(untrack(() => frame.rating));
	let notes = $state(untrack(() => frame.notes));
	let flags = $state<FrameFlag[]>(untrack(() => [...frame.flags]));
	let saving = $state(false);
	let notesTimeout: ReturnType<typeof setTimeout> | null = null;

	// Image preview
	let previewUrl = $state<string | null>(null);
	let previewLoading = $state(false);

	// Re-sync local copies whenever the selected frame changes
	$effect(() => {
		rating = frame.rating;
		notes = frame.notes;
		flags = [...frame.flags];
	});

	// Stable primitives derived from the frame — these only change value when
	// a genuinely different frame is selected, not when its metadata is updated.
	const frameId = $derived(frame.id);
	const filename = $derived(frame.filename);

	// Load preview only when frame identity (id) or dirPath changes.
	// We derive stable primitives above so that rating/flag/notes updates on
	// the same frame (which swap in a new proxy object) don't retrigger this.
	$effect(() => {
		const id = frameId;
		const name = filename;
		const path = dirPath;

		// Revoke any previous URL
		const prevUrl = untrack(() => previewUrl);
		if (prevUrl) {
			URL.revokeObjectURL(prevUrl);
			previewUrl = null;
		}

		if (!path) return;

		previewLoading = true;

		let cancelled = false;

		getFile(path, name)
			.then(async (file) => {
				// Phase 1: show thumb immediately (almost always cached)
				const thumbUrl = await getThumbURL(id, file);
				if (cancelled) {
					URL.revokeObjectURL(thumbUrl);
					return;
				}
				const oldUrl = untrack(() => previewUrl);
				previewUrl = thumbUrl;
				if (oldUrl) URL.revokeObjectURL(oldUrl);

				// Phase 2: upgrade to full 1200px preview
				const fullUrl = await getPreviewURL(id, file);
				if (cancelled) {
					URL.revokeObjectURL(fullUrl);
					return;
				}
				const prevThumbUrl = untrack(() => previewUrl);
				previewUrl = fullUrl;
				if (prevThumbUrl)
					URL.revokeObjectURL(prevThumbUrl);
			})
			.catch((err) => {
				console.error(
					"FrameMetaPanel: failed to load preview",
					err,
				);
			})
			.finally(() => {
				if (!cancelled) previewLoading = false;
			});

		return () => {
			cancelled = true;
		};
	});

	onDestroy(() => {
		if (previewUrl) URL.revokeObjectURL(previewUrl);
	});

	function hasFlag(f: FrameFlag): boolean {
		return flags.includes(f);
	}

	async function persist(partial: Partial<Frame>): Promise<void> {
		const updated: Frame = {
			...$state.snapshot(frame),
			...partial,
			rating,
			notes,
			flags: $state.snapshot(flags),
		};
		saving = true;
		try {
			await putFrame(updated);
			onUpdate?.(updated);
		} finally {
			saving = false;
		}
	}

	async function setRating(r: number) {
		// Clicking the current star again clears to 0
		rating = r === rating ? 0 : r;
		await persist({ rating });
	}

	async function toggleFlag(f: FrameFlag) {
		flags = hasFlag(f)
			? flags.filter((x) => x !== f)
			: [...flags, f];
		await persist({ flags });
	}

	function onNotesInput() {
		if (notesTimeout) clearTimeout(notesTimeout);
		notesTimeout = setTimeout(() => persist({ notes }), 600);
	}
</script>

<aside
	class="flex flex-col gap-base p-base border-base-subtle bg-base
              h-full w-full overflow-y-auto"
>
	<!-- Image preview -->
	<div
		class="w-full rounded-lg overflow-hidden bg-base-muted aspect-3/2 relative"
	>
		{#if previewUrl}
			<img
				src={previewUrl}
				alt="Frame {frame.index}"
				class="w-full h-full object-contain"
			/>
		{:else if previewLoading}
			<div
				class="w-full h-full animate-pulse bg-base-subtle"
			></div>
		{:else if !dirPath}
			<div
				class="w-full h-full flex items-center justify-center text-xs text-content-subtle"
			>
				No access
			</div>
		{/if}
	</div>

	<!-- Header -->
	<div>
		<p
			class="text-xs text-content-muted font-medium uppercase tracking-wide"
		>
			Frame {frame.index}
		</p>
		<p class="text-xs font-mono truncate mt-xs">
			{frame.filename}
		</p>
	</div>

	<!-- Rating -->
	<div>
		<p
			class="text-xs text-content-muted font-medium uppercase
			tracking-wide mb-xs"
		>
			Rating
		</p>
		<div class="flex gap-xs" role="group" aria-label="Star rating">
			{#each [1, 2, 3, 4, 5] as star (star)}
				<button
					onclick={() => setRating(star)}
					aria-label="{star} star{star !== 1
						? 's'
						: ''}"
					aria-pressed={rating >= star}
					class="leading-none transition
				       {rating >= star
						? 'text-primary-muted'
						: 'text-base-subtle hover:text-content-subtle'}"
				>
					<StarIcon
						size={20}
						weight={rating >= star
							? "fill"
							: "regular"}
					/>
				</button>
			{/each}
		</div>
	</div>

	<!-- Flags -->
	<div>
		<p
			class="text-xs text-content-muted font-medium uppercase
			tracking-wide mb-xs"
		>
			Flags
		</p>
		<div class="flex gap-sm flex-wrap">
			<button
				onclick={() => toggleFlag("pick")}
				aria-pressed={hasFlag("pick")}
				class="flex items-center gap-1.5 px-sm py-xs rounded-full text-xs font-medium border transition
				       {hasFlag('pick')
					? 'bg-success-subtle border-success text-success'
					: 'bg-transparent border-base-subtle text-content-subtle hover:border-content-subtle'}"
			>
				<ThumbsUpIcon
					size={14}
					weight={hasFlag("pick")
						? "fill"
						: "regular"}
				/> Pick
			</button>
			<button
				onclick={() => toggleFlag("reject")}
				aria-pressed={hasFlag("reject")}
				class="flex items-center gap-1.5 px-sm py-xs rounded-full text-xs font-medium border transition
				       {hasFlag('reject')
					? 'bg-danger-subtle border-danger text-danger'
					: 'bg-transparent border-base-subtle text-content-subtle hover:border-content-subtle'}"
			>
				<ThumbsDownIcon
					size={14}
					weight={hasFlag("reject")
						? "fill"
						: "regular"}
				/> Reject
			</button>
		</div>
	</div>

	<!-- Notes -->
	<div class="flex flex-col">
		<p
			class="text-xs text-content-muted font-medium uppercase
			tracking-wide mb-xs"
		>
			Notes
		</p>
		<textarea
			bind:value={notes}
			oninput={onNotesInput}
			rows={4}
			placeholder="Notes for this frame…"
			class="flex-1 bg-base-muted border border-base-subtle rounded-lg px-sm py-sm text-sm
			       text-content placeholder-content-subtle resize-none
			       focus:outline-none focus:border-primary transition"
		></textarea>
	</div>

	{#if saving}
		<p class="text-xs text-content-subtle">Saving…</p>
	{/if}
</aside>
