<script lang="ts">
	/**
	 * Background jobs dock — persistent, app-wide overlay shown whenever
	 * there are running, queued, or recently-completed jobs in the global
	 * jobs store.
	 *
	 * Mounted once from `src/routes/+layout.svelte` so it survives every
	 * navigation: starting an export and walking off to another roll or to
	 * the library leaves the dock visible with live progress.
	 *
	 * Pure read-only consumer of `$lib/jobs.svelte` — every mutation goes
	 * through the store's exported functions.
	 */
	import { goto } from "$app/navigation";
	import { CheckIcon, XIcon, WarningIcon, FilmStripIcon } from "phosphor-svelte";
	import { fly } from "svelte/transition";
	import { cubicOut } from "svelte/easing";
	import {
		getJobs,
		cancelJob,
		dismissJob,
		clearFinished,
		isJobActive,
		isJobTerminal,
		type ExportJob,
	} from "$lib/jobs.svelte";

	// Reactive view of the store.  Re-read on every fine-grained $state change.
	const jobs = $derived(getJobs());

	const hasAny = $derived(jobs.length > 0);
	const hasTerminal = $derived(jobs.some((j) => isJobTerminal(j.status)));

	let collapsed = $state(false);

	function percentFor(job: ExportJob): number {
		if (job.progress.total === 0) return 0;
		return Math.round((job.progress.processed / job.progress.total) * 100);
	}

	function statusLabel(job: ExportJob): string {
		switch (job.status) {
			case "queued":     return "Queued";
			case "running":    return "Exporting…";
			case "cancelling": return "Cancelling…";
			case "cancelled":  return "Cancelled";
			case "done":       return "Done";
			case "error":      return "Failed";
		}
	}

	function openRoll(job: ExportJob): void {
		void goto(`/roll/${job.rollId}`);
	}
</script>

{#if hasAny}
	<div
		class="fixed bottom-base right-base z-30 w-80 max-w-[calc(100vw-2rem)]
		       rounded-lg border border-base-subtle bg-base/70 backdrop-blur-md
		       shadow-xl shadow-black/20 overflow-hidden"
		in:fly={{ y: 24, x: 12, duration: 280, easing: cubicOut }}
		out:fly={{ y: 24, x: 12, duration: 200, easing: cubicOut }}
	>
		<!-- Header ─────────────────────────────────────────────────── -->
		<div
			class="flex items-center gap-xs px-base py-xs border-b border-base-subtle"
		>
			<button
				type="button"
				onclick={() => (collapsed = !collapsed)}
				class="flex items-center gap-xs flex-1 text-left text-xs
				       font-semibold text-content-muted uppercase tracking-wider
				       hover:text-content transition"
				aria-expanded={!collapsed}
			>
				<span class="text-content">{jobs.length}</span>
				background job{jobs.length === 1 ? "" : "s"}
			</button>

			{#if hasTerminal}
				<button
					type="button"
					onclick={clearFinished}
					title="Dismiss all finished jobs"
					class="text-xs text-content-muted hover:text-content transition px-xs"
				>
					Clear
				</button>
			{/if}
		</div>

		<!-- Job rows ───────────────────────────────────────────────── -->
		{#if !collapsed}
			<div
				class="max-h-[60vh] overflow-y-auto divide-y divide-base-subtle"
			>
				{#each jobs as job (job.id)}
					<div
						class="px-base py-sm flex flex-col gap-xs"
						in:fly={{ y: 12, duration: 220, easing: cubicOut }}
						out:fly={{ x: 24, duration: 180, easing: cubicOut }}
					>
						<!-- Top line: roll label + close/cancel -->
						<div class="flex items-center gap-xs">
							<button
								type="button"
								onclick={() => openRoll(job)}
								class="flex items-center gap-xs flex-1 min-w-0 text-left
								       text-sm text-content hover:text-primary transition"
								title={`Open ${job.rollLabel}`}
							>
								<FilmStripIcon
									size={14}
									class="shrink-0 text-content-muted"
								/>
								<span class="truncate">{job.rollLabel}</span>
							</button>

							{#if isJobActive(job.status)}
								<button
									type="button"
									onclick={() => cancelJob(job.id)}
									disabled={job.status === "cancelling"}
									title={job.status === "cancelling"
										? "Cancelling…"
										: "Cancel this job"}
									class="text-xs text-content-muted hover:text-danger transition
									       px-xs py-0.5 rounded
									       disabled:opacity-40 disabled:cursor-not-allowed"
								>
									{job.status === "cancelling"
										? "…"
										: "Cancel"}
								</button>
							{:else}
								<button
									type="button"
									onclick={() => dismissJob(job.id)}
									aria-label="Dismiss job"
									class="p-0.5 rounded text-content-muted hover:text-content
									       hover:bg-base-subtle transition"
								>
									<XIcon size={12} />
								</button>
							{/if}
						</div>

						<!-- Status / progress line -->
						{#if job.status === "queued"}
							<div class="flex items-center gap-xs text-xs text-content-muted">
								<span>{statusLabel(job)}</span>
								<span class="tabular-nums">
									· {job.progress.total} frames
								</span>
							</div>
						{:else if job.status === "running" || job.status === "cancelling"}
							<div class="flex items-center gap-sm">
								<div
									class="flex-1 h-1.5 rounded-full bg-base-subtle overflow-hidden"
								>
									<div
										class="h-full bg-primary rounded-full transition-all duration-150
										       {job.status === 'cancelling'
											? 'opacity-50'
											: ''}"
										style="width: {percentFor(job)}%"
									></div>
								</div>
								<span class="text-xs text-content-subtle tabular-nums shrink-0">
									{job.progress.processed} / {job.progress.total}
								</span>
							</div>
							<div class="text-xs text-content-muted">
								{statusLabel(job)} · {job.scale}x
							</div>
						{:else}
							<!-- Terminal: done / cancelled / error -->
							<div class="flex items-center gap-base text-xs">
								{#if job.status === "done"}
									<span class="flex items-center gap-1 text-success">
										<CheckIcon size={12} />
										<span class="tabular-nums">
											{job.result?.exported ?? 0}
										</span>
										exported
									</span>
								{:else if job.status === "cancelled"}
									<span class="text-content-muted">
										Cancelled
										{#if (job.result?.exported ?? 0) > 0}
											· <span class="tabular-nums">
												{job.result?.exported}
											</span>
											written
										{/if}
									</span>
								{:else if job.status === "error"}
									<span class="flex items-center gap-1 text-danger">
										<WarningIcon size={12} />
										Failed
									</span>
								{/if}

								{#if (job.result?.skipped ?? 0) > 0}
									<span class="text-content-muted">
										<span class="tabular-nums">
											{job.result?.skipped}
										</span>
										skipped
									</span>
								{/if}
								{#if (job.result?.failed ?? 0) > 0}
									<span class="text-danger">
										<span class="tabular-nums">
											{job.result?.failed}
										</span>
										failed
									</span>
								{/if}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/if}
