<script lang="ts">
	/**
	 * Frame metadata panel — rating (0–5 stars), pick/reject flags, notes.
	 * Emits updates via onUpdate; parent is responsible for persisting to IDB.
	 */
	import { untrack } from "svelte";
	import {
		StarIcon,
		ThumbsUpIcon,
		ThumbsDownIcon,
	} from "phosphor-svelte";
	import { putFrame } from "$lib/db/idb";
	import type { Frame, FrameFlag } from "$lib/types";

	interface Props {
		frame: Frame;
		onUpdate?: (updated: Frame) => void;
	}

	let { frame, onUpdate }: Props = $props();

	// Local editable copies — initialised without tracking the prop
	// so Svelte doesn't warn about capturing the initial value only.
	let rating = $state(untrack(() => frame.rating));
	let notes = $state(untrack(() => frame.notes));
	let flags = $state<FrameFlag[]>(untrack(() => [...frame.flags]));
	let saving = $state(false);
	let notesTimeout: ReturnType<typeof setTimeout> | null = null;

	// Re-sync local copies whenever the selected frame changes
	$effect(() => {
		rating = frame.rating;
		notes = frame.notes;
		flags = [...frame.flags];
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
	class="flex flex-col gap-base p-base border-l border-base-subtle bg-base
              min-w-[220px] max-w-xs w-64 shrink-0"
>
	<!-- Header -->
	<div>
		<p
			class="text-xs text-content-muted font-medium uppercase tracking-wide"
		>
			Frame {frame.index}
		</p>
		<p class="text-xs font-mono truncate mt-0.5">
			{frame.filename}
		</p>
	</div>

	<!-- Rating -->
	<div>
		<p
			class="text-xs text-content-muted font-medium uppercase tracking-wide mb-2"
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
			class="text-xs text-content-muted font-medium uppercase tracking-wide mb-2"
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
			class="text-xs text-content-muted font-medium uppercase tracking-wide mb-2"
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
