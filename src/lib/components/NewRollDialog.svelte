<script lang="ts">
	import { pickDirectory } from '$lib/fs/directory';
	import { createRoll } from '$lib/db/rolls';
	import type { Roll } from '$lib/types';

	interface Props {
		onCreated: (roll: Roll) => void;
		onClose: () => void;
	}

	let { onCreated, onClose }: Props = $props();

	let label     = $state('');
	let filmStock = $state('');
	let camera    = $state('');
	let notes     = $state('');
	let handle    = $state<FileSystemDirectoryHandle | null>(null);
	let dirName   = $state('');
	let busy      = $state(false);
	let error     = $state('');

	async function pickDir() {
		error = '';
		const h = await pickDirectory();
		if (h) {
			handle  = h;
			dirName = h.name;
			if (!label) label = h.name;
		}
	}

	async function submit() {
		if (!handle) { error = 'Please select a directory.'; return; }
		if (!label.trim()) { error = 'Label is required.'; return; }

		busy  = true;
		error = '';
		try {
			const roll = await createRoll({ label: label.trim(), filmStock, camera, notes, handle });
			onCreated(roll);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	function keydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onClose();
	}
</script>

<svelte:window onkeydown={keydown} />

<!-- Backdrop -->
<div
	class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
	role="dialog"
	aria-modal="true"
	aria-labelledby="dialog-title"
>
	<div class="w-full max-w-md rounded-xl bg-base-muted border border-base-subtle
	            shadow-lg p-l space-y-base">
		<div class="flex items-center justify-between">
			<h2 id="dialog-title" class="text-l font-semibold text-content">New Roll</h2>
			<button
				onclick={onClose}
				class="text-content-muted hover:text-content transition-colors"
				aria-label="Close"
			>✕</button>
		</div>

		<!-- Directory picker -->
		<div>
			<button
				onclick={pickDir}
				class="w-full rounded-lg border border-base-subtle bg-base px-base py-sm text-sm text-left
				       text-content hover:border-content-subtle hover:bg-base-muted transition"
			>
				{#if dirName}
					<span class="text-content font-medium">{dirName}</span>
					<span class="text-content-subtle ml-1">— click to change</span>
				{:else}
					<span class="text-content-subtle">Select image directory…</span>
				{/if}
			</button>
		</div>

		<!-- Fields -->
		<div class="space-y-sm">
			<label class="block">
				<span class="text-xs font-medium text-content-muted uppercase tracking-wide">Label *</span>
				<input
					bind:value={label}
					type="text"
					placeholder="e.g. Kodak Gold 200 — Paris"
					class="mt-1 w-full rounded-lg bg-base border border-base-subtle px-sm py-sm text-sm
					       text-content placeholder-content-subtle
					       focus:outline-none focus:border-primary transition"
				/>
			</label>
			<label class="block">
				<span class="text-xs font-medium text-content-muted uppercase tracking-wide">Film stock</span>
				<input
					bind:value={filmStock}
					type="text"
					placeholder="e.g. Kodak Portra 400"
					class="mt-1 w-full rounded-lg bg-base border border-base-subtle px-sm py-sm text-sm
					       text-content placeholder-content-subtle
					       focus:outline-none focus:border-primary transition"
				/>
			</label>
			<label class="block">
				<span class="text-xs font-medium text-content-muted uppercase tracking-wide">Camera</span>
				<input
					bind:value={camera}
					type="text"
					placeholder="e.g. Nikon FM2"
					class="mt-1 w-full rounded-lg bg-base border border-base-subtle px-sm py-sm text-sm
					       text-content placeholder-content-subtle
					       focus:outline-none focus:border-primary transition"
				/>
			</label>
			<label class="block">
				<span class="text-xs font-medium text-content-muted uppercase tracking-wide">Notes</span>
				<textarea
					bind:value={notes}
					rows={2}
					placeholder="Optional notes…"
					class="mt-1 w-full rounded-lg bg-base border border-base-subtle px-sm py-sm text-sm
					       text-content placeholder-content-subtle
					       focus:outline-none focus:border-primary transition resize-none"
				></textarea>
			</label>
		</div>

		{#if error}
			<p class="text-sm text-danger">{error}</p>
		{/if}

		<div class="flex gap-sm justify-end pt-1">
			<button
				onclick={onClose}
				class="px-base py-sm text-sm rounded-lg text-content-muted
				       hover:text-content hover:bg-base-subtle transition"
			>Cancel</button>
			<button
				onclick={submit}
				disabled={busy}
				class="px-base py-sm text-sm font-medium rounded-lg bg-primary text-primary-content
				       hover:bg-primary-muted disabled:opacity-50 disabled:cursor-not-allowed transition"
			>
				{busy ? 'Creating…' : 'Create Roll'}
			</button>
		</div>
	</div>
</div>
