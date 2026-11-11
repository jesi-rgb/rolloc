<script lang="ts">
	import { onMount } from "svelte";
	import { getRolls, deleteRoll, purgeRollFolderData } from "$lib/db/rolls";
	import { getLibraries, deleteLibrary } from "$lib/db/libraries";
	import {
		TrashIcon,
		FolderMinusIcon,
		FilmStripIcon,
		ImagesIcon,
		PlusIcon,
	} from "phosphor-svelte";
	import NewRollDialog from "$lib/components/NewRollDialog.svelte";
	import NewLibraryDialog from "$lib/components/NewLibraryDialog.svelte";
	import KeyboardHintBar from "$lib/components/KeyboardHintBar.svelte";
	import RollThumbStrip from "$lib/components/RollThumbStrip.svelte";
	import LibraryThumbStrip from "$lib/components/LibraryThumbStrip.svelte";
	import type { Component } from "svelte";
	import type { Roll, Library } from "$lib/types";

	type Tab = "rolls" | "libraries";

	const TABS: { id: Tab; label: string }[] = [
		{ id: "rolls", label: "Rolls" },
		{ id: "libraries", label: "Libraries" },
	];

	let rolls = $state<Roll[]>([]);
	let libraries = $state<Library[]>([]);
	let activeTab = $state<Tab>("rolls");
	let loading = $state(true);
	let showNewRoll = $state(false);
	let showNewLibrary = $state(false);
	let deleting = $state<string | null>(null);
	let purging = $state<string | null>(null);

	onMount(async () => {
		const [r, l] = await Promise.all([getRolls(), getLibraries()]);
		// Newest first by creation time.
		rolls = r.sort((a, b) => b.createdAt - a.createdAt);
		libraries = l.sort((a, b) => b.createdAt - a.createdAt);
		loading = false;
	});

	function onRollCreated(roll: Roll) {
		rolls = [roll, ...rolls].sort((a, b) => b.createdAt - a.createdAt);
		showNewRoll = false;
	}

	function onLibraryCreated(library: Library) {
		libraries = [library, ...libraries].sort(
			(a, b) => b.createdAt - a.createdAt,
		);
		showNewLibrary = false;
	}

	async function confirmDeleteRoll(roll: Roll) {
		if (!confirm(`Delete roll "${roll.label}"? This cannot be undone.`))
			return;
		deleting = roll.id;
		await deleteRoll(roll.id);
		rolls = rolls.filter((r) => r.id !== roll.id);
		deleting = null;
	}

	/**
	 * Permanently deletes the roll's `.rolloc-meta` sidecar folder (cached
	 * edits + thumbnails) from disk, without removing the roll from the UI.
	 * A separate, more deliberate action from "Delete roll" above — the
	 * original image files are never touched by either action.
	 */
	async function confirmPurgeRollFolder(roll: Roll) {
		if (
			!confirm(
				`Permanently delete cached edits and thumbnails for "${roll.label}" from its folder (.rolloc-meta)? ` +
					`The original photos are never touched, but this cannot be undone.`,
			)
		)
			return;
		purging = roll.id;
		try {
			await purgeRollFolderData(roll.id);
		} finally {
			purging = null;
		}
	}

	async function confirmDeleteLibrary(library: Library) {
		if (
			!confirm(
				`Delete library "${library.label}"? This cannot be undone.`,
			)
		)
			return;
		deleting = library.id;
		await deleteLibrary(library.id);
		libraries = libraries.filter((lib) => lib.id !== library.id);
		deleting = null;
	}

	function formatDate(ms: number): string {
		return new Date(ms).toLocaleDateString(undefined, {
			year: "numeric",
			month: "short",
			day: "numeric",
		});
	}
</script>

<svelte:head><title>Rolloc — Film Archive</title></svelte:head>

<div class="h-screen bg-base text-content flex flex-col overflow-hidden">
	<!-- Top bar: brand, tabs and primary action -->
	<header
		class="flex items-center gap-l px-l h-14 shrink-0 border-b border-base-subtle"
	>
		<span class="text-xl font-bold tracking-tight text-primary-muted">Rolloc</span>

		<nav class="flex items-center gap-xs" aria-label="Collections">
			{#each TABS as tab (tab.id)}
				<button
					onclick={() => (activeTab = tab.id)}
					aria-current={activeTab === tab.id ? "page" : undefined}
					class="px-sm py-xs rounded-md text-sm font-medium transition
					       {activeTab === tab.id
						? 'bg-base-muted text-content'
						: 'text-content-muted hover:text-content'}"
				>
					{tab.label}
				</button>
			{/each}
		</nav>

		<button
			onclick={() =>
				activeTab === "rolls" ? (showNewRoll = true) : (showNewLibrary = true)}
			class="ml-auto flex items-center gap-xs px-sm py-xs rounded-md bg-primary
			       text-primary-content text-sm font-medium hover:bg-primary-muted transition"
		>
			<PlusIcon size={14} weight="bold" />
			{activeTab === "rolls" ? "New Roll" : "New Library"}
		</button>
	</header>

	<main class="flex-1 min-h-0 overflow-y-auto w-full px-l py-xl max-w-5xl mx-auto">
		{#if loading}
			<p class="text-sm text-content-muted">Loading…</p>
		{:else if activeTab === "rolls"}
			<!-- Rolls tab -->
			{#if rolls.length === 0}
				{@render emptyState(
					FilmStripIcon,
					"No rolls yet",
					"Select a folder of film scans to create your first roll.",
					"New Roll",
					() => (showNewRoll = true),
				)}
			{:else}
				<ul class="flex flex-col gap-base">
					{#each rolls as roll (roll.id)}
						<li
							class="group relative flex flex-col rounded-lg bg-base-muted border border-base-subtle
							       hover:border-content-subtle transition overflow-hidden"
						>
							<!-- Thumbnail strip (first frames) -->
							<a
								href="/roll/{roll.id}"
								class="block overflow-hidden"
								tabindex="-1"
								aria-hidden="true"
							>
								<RollThumbStrip rollId={roll.id} />
							</a>

							<!-- Metadata -->
							<a
								href="/roll/{roll.id}"
								class="flex flex-col gap-0.5 px-base py-sm pr-20"
							>
								<span class="flex items-baseline gap-sm min-w-0">
									<span class="font-semibold text-content truncate"
										>{roll.label}</span
									>
									<span class="text-xs text-content-subtle shrink-0"
										>{formatDate(roll.createdAt)}</span
									>
								</span>
								{#if roll.filmStock || roll.camera}
									<span class="text-xs text-content-muted truncate">
										{#if roll.filmStock}
											<span class="text-primary-muted/80">{roll.filmStock}</span>
										{/if}
										{#if roll.filmStock && roll.camera}
											<span class="text-content-subtle">·</span>
										{/if}
										{roll.camera ?? ""}
									</span>
								{/if}
							</a>

							<!-- Hover actions -->
							<div
								class="absolute bottom-sm right-sm flex items-center gap-xs
								       opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition"
							>
								<button
									onclick={() => confirmPurgeRollFolder(roll)}
									disabled={purging === roll.id}
									aria-label="Delete cached edits and thumbnails from folder"
									title="Permanently delete cached edits/thumbnails from this roll's folder"
									class="p-1.5 rounded-md text-content-muted hover:text-danger hover:bg-base-subtle transition disabled:opacity-40"
								>
									<FolderMinusIcon size={16} />
								</button>
								<button
									onclick={() => confirmDeleteRoll(roll)}
									disabled={deleting === roll.id}
									aria-label="Delete roll"
									title="Delete roll"
									class="p-1.5 rounded-md text-content-muted hover:text-danger hover:bg-base-subtle transition disabled:opacity-40"
								>
									<TrashIcon size={16} />
								</button>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		{:else}
			<!-- Libraries tab -->
			{#if libraries.length === 0}
				{@render emptyState(
					ImagesIcon,
					"No libraries yet",
					"Select a folder of images to create your first library.",
					"New Library",
					() => (showNewLibrary = true),
				)}
			{:else}
				<ul class="flex flex-col gap-base">
					{#each libraries as library (library.id)}
						<li
							class="group relative flex flex-col rounded-lg bg-base-muted border border-base-subtle
							       hover:border-content-subtle transition overflow-hidden"
						>
							<!-- Thumbnail strip (first images) -->
							<a
								href="/library/{library.id}"
								class="block overflow-hidden"
								tabindex="-1"
								aria-hidden="true"
							>
								<LibraryThumbStrip libraryId={library.id} />
							</a>

							<!-- Metadata -->
							<a
								href="/library/{library.id}"
								class="flex flex-col gap-0.5 px-base py-sm pr-12"
							>
								<span class="flex items-baseline gap-sm min-w-0">
									<span class="font-semibold text-content truncate"
										>{library.label}</span
									>
									<span class="text-xs text-content-subtle shrink-0"
										>{formatDate(library.createdAt)}</span
									>
								</span>
								{#if library.notes}
									<span class="text-xs text-content-muted truncate"
										>{library.notes}</span
									>
								{/if}
							</a>

							<!-- Hover actions -->
							<div
								class="absolute bottom-sm right-sm flex items-center gap-xs
								       opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition"
							>
								<button
									onclick={() => confirmDeleteLibrary(library)}
									disabled={deleting === library.id}
									aria-label="Delete library"
									title="Delete library"
									class="p-1.5 rounded-md text-content-muted hover:text-danger hover:bg-base-subtle transition disabled:opacity-40"
								>
									<TrashIcon size={16} />
								</button>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</main>
	<KeyboardHintBar hints={[]} />
</div>

{#snippet emptyState(
	Icon: Component,
	title: string,
	body: string,
	action: string,
	onAction: () => void,
)}
	<div class="flex flex-col items-center justify-center py-24 gap-sm text-center">
		<Icon size={48} weight="thin" class="text-content-subtle" />
		<h2 class="text-l font-semibold text-content mt-sm">{title}</h2>
		<p class="text-content-muted text-sm max-w-80">{body}</p>
		<button
			onclick={onAction}
			class="mt-sm flex items-center gap-xs px-sm py-xs rounded-md bg-primary
			       text-primary-content text-sm font-medium hover:bg-primary-muted transition"
		>
			<PlusIcon size={14} weight="bold" />
			{action}
		</button>
	</div>
{/snippet}

{#if showNewRoll}
	<NewRollDialog
		onCreated={onRollCreated}
		onClose={() => (showNewRoll = false)}
	/>
{/if}

{#if showNewLibrary}
	<NewLibraryDialog
		onCreated={onLibraryCreated}
		onClose={() => (showNewLibrary = false)}
	/>
{/if}
