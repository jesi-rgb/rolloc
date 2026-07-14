<script lang="ts">
	import { onMount } from "svelte";
	import { getRolls, deleteRoll, purgeRollFolderData } from "$lib/db/rolls";
	import { getLibraries, deleteLibrary } from "$lib/db/libraries";
	import { TrashIcon, FolderMinusIcon } from "phosphor-svelte";
	import NewRollDialog from "$lib/components/NewRollDialog.svelte";
	import NewLibraryDialog from "$lib/components/NewLibraryDialog.svelte";
	import KeyboardHintBar from "$lib/components/KeyboardHintBar.svelte";
	import RollThumbStrip from "$lib/components/RollThumbStrip.svelte";
	import LibraryThumbStrip from "$lib/components/LibraryThumbStrip.svelte";
	import type { Roll, Library } from "$lib/types";

	type Tab = "rolls" | "libraries";

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
	<!-- Top bar -->
	<header
		class="flex items-center justify-between px-l py-base border-b border-base-subtle"
	>
		<div class="flex items-center gap-sm">
			<span class="text-2xl font-bold tracking-tight text-primary-muted"
				>Rolloc</span
			>
			<span class="text-content-subtle text-sm hidden sm:inline"
				>Film Archive</span
			>
		</div>
		<div class="flex items-center gap-xs">
			{#if activeTab === "rolls"}
				<button
					onclick={() => (showNewRoll = true)}
					class="flex items-center gap-xs px-base py-sm rounded-lg bg-primary text-primary-content
					       text-sm font-medium hover:bg-primary-muted transition"
				>
					<span class="text-base leading-none">+</span> New Roll
				</button>
			{:else}
				<button
					onclick={() => (showNewLibrary = true)}
					class="flex items-center gap-xs px-base py-sm rounded-lg bg-primary text-primary-content
					       text-sm font-medium hover:bg-primary-muted transition"
				>
					<span class="text-base leading-none">+</span> New Library
				</button>
			{/if}
		</div>
	</header>

	<!-- Tab navigation -->
	<nav class="border-b border-base-subtle">
		<div class="px-l flex gap-base">
			<button
				onclick={() => (activeTab = "rolls")}
				class="relative px-sm py-base text-sm font-medium transition
				       {activeTab === 'rolls'
					? 'text-primary'
					: 'text-content-muted hover:text-content'}"
			>
				Rolls
				{#if activeTab === "rolls"}
					<span
						class="absolute bottom-0 left-0 right-0 h-0.5 bg-primary"
					></span>
				{/if}
			</button>
			<button
				onclick={() => (activeTab = "libraries")}
				class="relative px-sm py-base text-sm font-medium transition
				       {activeTab === 'libraries'
					? 'text-primary'
					: 'text-content-muted hover:text-content'}"
			>
				Libraries
				{#if activeTab === "libraries"}
					<span
						class="absolute bottom-0 left-0 right-0 h-0.5 bg-primary"
					></span>
				{/if}
			</button>
		</div>
	</nav>

	<main class="flex-1 min-h-0 overflow-y-auto w-full px-l py-xl max-w-5xl mx-auto">
		{#if loading}
			<p class="text-content-muted">Loading…</p>
		{:else if activeTab === "rolls"}
			<!-- Rolls tab -->
			{#if rolls.length === 0}
				<!-- Empty state -->
				<div
					class="flex flex-col items-center justify-center py-24 gap-base text-center"
				>
					<div class="text-6xl opacity-30">🎞️</div>
					<h2 class="text-xl font-semibold text-content">
						No rolls yet
					</h2>
					<p class="text-content-muted text-sm">
						Create your first roll by selecting a folder of film
						scans (JPEG or TIFF).
					</p>
					<button
						onclick={() => (showNewRoll = true)}
						class="mt-2 px-base py-sm rounded-lg bg-primary text-primary-content
						       text-sm font-medium hover:bg-primary-muted transition"
					>
						New Roll
					</button>
				</div>
			{:else}
				<h1
					class="text-sm font-medium text-content-muted uppercase tracking-widest mb-l"
				>
					{rolls.length} Roll{rolls.length !== 1 ? "s" : ""}
				</h1>

				<ul class="flex flex-col gap-base">
					{#each rolls as roll (roll.id)}
						<li
							class="group relative flex flex-col rounded-xl bg-base-muted border border-base-subtle
					           hover:border-content-subtle transition overflow-hidden"
						>
							<!-- Thumbnail strip (first 5 frames) -->
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
								class="flex flex-col flex-1 px-sm py-sm gap-xs"
							>
								<span
									class="font-semibold text-content truncate"
									>{roll.label}</span
								>
								{#if roll.filmStock}
									<span
										class="text-sm text-primary-muted/80 truncate"
										>{roll.filmStock}</span
									>
								{/if}
								{#if roll.camera}
									<span
										class="text-xs text-content-muted truncate"
										>{roll.camera}</span
									>
								{/if}
								<span
									class="text-xs text-content-subtle mt-auto pt-1"
									>{formatDate(roll.createdAt)}</span
								>
							</a>

							<!-- Purge folder cache button (shown on hover) -->
							<button
								onclick={() => confirmPurgeRollFolder(roll)}
								disabled={purging === roll.id}
								aria-label="Delete cached edits and thumbnails from folder"
								title="Permanently delete cached edits/thumbnails from this roll's folder"
								class="absolute bottom-3 right-11 opacity-0 group-hover:opacity-100 transition
							       p-1.5 rounded-md text-content-muted hover:text-danger hover:bg-base-subtle"
							>
								{#if purging === roll.id}
									<span class="text-xs">…</span>
								{:else}
									<FolderMinusIcon size={16} weight="bold" />
								{/if}
							</button>

							<!-- Delete button (shown on hover) -->
							<button
								onclick={() => confirmDeleteRoll(roll)}
								disabled={deleting === roll.id}
								aria-label="Delete roll"
								class="absolute bottom-3 right-3 opacity-0 group-hover:opacity-100 transition
							       p-1.5 rounded-md text-content-muted hover:text-danger hover:bg-base-subtle"
							>
								{#if deleting === roll.id}
									<span class="text-xs">…</span>
								{:else}
									<TrashIcon size={16} weight="bold" />
								{/if}
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		{:else}
			<!-- Libraries tab -->
			{#if libraries.length === 0}
				<!-- Empty state -->
				<div
					class="flex flex-col items-center justify-center py-24 gap-base text-center"
				>
					<div class="text-6xl opacity-30">📸</div>
					<h2 class="text-xl font-semibold text-content">
						No libraries yet
					</h2>
					<p class="text-content-muted text-sm">
						Create your first library by selecting a folder of
						images
					</p>
					<button
						onclick={() => (showNewLibrary = true)}
						class="mt-2 px-base py-sm rounded-lg bg-primary text-primary-content
						       text-sm font-medium hover:bg-primary-muted transition"
					>
						New Library
					</button>
				</div>
			{:else}
				<h1
					class="text-sm font-medium text-content-muted uppercase tracking-widest mb-l"
				>
					{libraries.length} Librar{libraries.length !== 1
						? "ies"
						: "y"}
				</h1>

				<ul class="flex flex-col gap-base">
					{#each libraries as library (library.id)}
						<li
							class="group relative flex flex-col rounded-xl bg-base-muted border border-base-subtle
					           hover:border-content-subtle transition overflow-hidden"
						>
							<!-- Thumbnail strip (first 5 images) -->
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
								class="flex flex-col flex-1 px-sm py-sm gap-xs"
							>
								<span
									class="font-semibold text-content truncate"
									>{library.label}</span
								>
								{#if library.notes}
									<span
										class="text-sm text-content-muted truncate"
										>{library.notes}</span
									>
								{/if}
								<span
									class="text-xs text-content-subtle mt-auto pt-1"
									>{formatDate(library.createdAt)}</span
								>
							</a>

							<!-- Delete button (shown on hover) -->
							<button
								onclick={() => confirmDeleteLibrary(library)}
								disabled={deleting === library.id}
								aria-label="Delete library"
								class="absolute bottom-3 right-3 opacity-0 group-hover:opacity-100 transition
							       p-1.5 rounded-md text-content-muted hover:text-danger hover:bg-base-subtle"
							>
								{#if deleting === library.id}
									<span class="text-xs">…</span>
								{:else}
									<TrashIcon size={16} weight="bold" />
								{/if}
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</main>
	<KeyboardHintBar hints={[]} />
</div>

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
