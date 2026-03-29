<script lang="ts">
	import type { InversionParams } from '$lib/types';
	import { DEFAULT_INVERSION_PARAMS } from '$lib/types';
	import { untrack } from 'svelte';

	interface Props {
		value: InversionParams;
		onChange: (p: InversionParams) => void;
	}

	let { value, onChange }: Props = $props();

	// ─── Local reactive copies (untrack to avoid "only captures initial value" warning) ───

	let density          = $state(untrack(() => value.density));
	let grade            = $state(untrack(() => value.grade));
	let cmyCyan          = $state(untrack(() => value.cmyCyan));
	let cmyMagenta       = $state(untrack(() => value.cmyMagenta));
	let cmyYellow        = $state(untrack(() => value.cmyYellow));
	let shadowCyan       = $state(untrack(() => value.shadowCyan));
	let shadowMagenta    = $state(untrack(() => value.shadowMagenta));
	let shadowYellow     = $state(untrack(() => value.shadowYellow));
	let highlightCyan    = $state(untrack(() => value.highlightCyan));
	let highlightMagenta = $state(untrack(() => value.highlightMagenta));
	let highlightYellow  = $state(untrack(() => value.highlightYellow));
	let shadows          = $state(untrack(() => value.shadows));
	let highlights       = $state(untrack(() => value.highlights));
	let toe              = $state(untrack(() => value.toe));
	let toeWidth         = $state(untrack(() => value.toeWidth));
	let toeHardness      = $state(untrack(() => value.toeHardness));
	let shoulder         = $state(untrack(() => value.shoulder));
	let shoulderWidth    = $state(untrack(() => value.shoulderWidth));
	let shoulderHardness = $state(untrack(() => value.shoulderHardness));

	// Re-sync when parent swaps to a different frame / roll
	$effect(() => {
		// Deliberately reading reactive `value` to react to prop changes,
		// then writing local copies — acceptable pattern per AGENTS.md.
		density          = value.density;
		grade            = value.grade;
		cmyCyan          = value.cmyCyan;
		cmyMagenta       = value.cmyMagenta;
		cmyYellow        = value.cmyYellow;
		shadowCyan       = value.shadowCyan;
		shadowMagenta    = value.shadowMagenta;
		shadowYellow     = value.shadowYellow;
		highlightCyan    = value.highlightCyan;
		highlightMagenta = value.highlightMagenta;
		highlightYellow  = value.highlightYellow;
		shadows          = value.shadows;
		highlights       = value.highlights;
		toe              = value.toe;
		toeWidth         = value.toeWidth;
		toeHardness      = value.toeHardness;
		shoulder         = value.shoulder;
		shoulderWidth    = value.shoulderWidth;
		shoulderHardness = value.shoulderHardness;
	});

	function emit(): void {
		onChange({
			density, grade,
			cmyCyan, cmyMagenta, cmyYellow,
			shadowCyan, shadowMagenta, shadowYellow,
			highlightCyan, highlightMagenta, highlightYellow,
			shadows, highlights,
			toe, toeWidth, toeHardness,
			shoulder, shoulderWidth, shoulderHardness,
		});
	}

	function reset(): void {
		const d = DEFAULT_INVERSION_PARAMS;
		density          = d.density;
		grade            = d.grade;
		cmyCyan          = d.cmyCyan;
		cmyMagenta       = d.cmyMagenta;
		cmyYellow        = d.cmyYellow;
		shadowCyan       = d.shadowCyan;
		shadowMagenta    = d.shadowMagenta;
		shadowYellow     = d.shadowYellow;
		highlightCyan    = d.highlightCyan;
		highlightMagenta = d.highlightMagenta;
		highlightYellow  = d.highlightYellow;
		shadows          = d.shadows;
		highlights       = d.highlights;
		toe              = d.toe;
		toeWidth         = d.toeWidth;
		toeHardness      = d.toeHardness;
		shoulder         = d.shoulder;
		shoulderWidth    = d.shoulderWidth;
		shoulderHardness = d.shoulderHardness;
		emit();
	}

	function fmt(v: number): string {
		return v.toFixed(2);
	}
	function fmtSigned(v: number): string {
		return (v >= 0 ? '+' : '') + v.toFixed(2);
	}

	const isDefault = $derived(
		density          === DEFAULT_INVERSION_PARAMS.density          &&
		grade            === DEFAULT_INVERSION_PARAMS.grade            &&
		cmyCyan          === DEFAULT_INVERSION_PARAMS.cmyCyan          &&
		cmyMagenta       === DEFAULT_INVERSION_PARAMS.cmyMagenta       &&
		cmyYellow        === DEFAULT_INVERSION_PARAMS.cmyYellow        &&
		shadowCyan       === DEFAULT_INVERSION_PARAMS.shadowCyan       &&
		shadowMagenta    === DEFAULT_INVERSION_PARAMS.shadowMagenta    &&
		shadowYellow     === DEFAULT_INVERSION_PARAMS.shadowYellow     &&
		highlightCyan    === DEFAULT_INVERSION_PARAMS.highlightCyan    &&
		highlightMagenta === DEFAULT_INVERSION_PARAMS.highlightMagenta &&
		highlightYellow  === DEFAULT_INVERSION_PARAMS.highlightYellow  &&
		shadows          === DEFAULT_INVERSION_PARAMS.shadows          &&
		highlights       === DEFAULT_INVERSION_PARAMS.highlights       &&
		toe              === DEFAULT_INVERSION_PARAMS.toe              &&
		toeWidth         === DEFAULT_INVERSION_PARAMS.toeWidth         &&
		toeHardness      === DEFAULT_INVERSION_PARAMS.toeHardness      &&
		shoulder         === DEFAULT_INVERSION_PARAMS.shoulder         &&
		shoulderWidth    === DEFAULT_INVERSION_PARAMS.shoulderWidth    &&
		shoulderHardness === DEFAULT_INVERSION_PARAMS.shoulderHardness
	);
</script>

<!--
	InversionControls
	Exposes all NegPy inversion parameters as labelled sliders.
	Mirrors the layout of the reference NegPy UI (Density, Grade, CMY timing,
	Shadows/Highlights, Toe, Shoulder).
-->

<div class="flex flex-col gap-l">

	<!-- ── Global CMY ──────────────────────────────────────────────────────── -->
	<section>
		<h4 class="text-[10px] font-semibold uppercase tracking-widest text-content-subtle mb-sm">
			Color timing
		</h4>
		<div class="flex flex-col gap-sm">

			{#snippet cmySlider(
				id: string,
				label: string,
				colorClass: string,
				val: number,
				onInput: (v: number) => void,
			)}
				<div class="flex flex-col gap-xs">
					<div class="flex items-center justify-between">
						<label for={id} class="text-xs font-medium {colorClass}">{label}</label>
						<span class="text-xs text-content font-mono tabular-nums">{fmtSigned(val)}</span>
					</div>
					<input
						{id}
						type="range" min="-1" max="1" step="0.01"
						value={val}
						oninput={(e) => { onInput(parseFloat((e.currentTarget as HTMLInputElement).value)); emit(); }}
						class="w-full h-1 rounded-full appearance-none cursor-pointer accent-primary"
					/>
				</div>
			{/snippet}

			{@render cmySlider('inv-cyan',    'Cyan',    'text-[#00bcd4]', cmyCyan,    (v) => { cmyCyan    = v; })}
			{@render cmySlider('inv-magenta', 'Magenta', 'text-[#e91e63]', cmyMagenta, (v) => { cmyMagenta = v; })}
			{@render cmySlider('inv-yellow',  'Yellow',  'text-[#ffeb3b]', cmyYellow,  (v) => { cmyYellow  = v; })}
		</div>
	</section>

	<!-- ── Density + Grade ─────────────────────────────────────────────────── -->
	<section>
		<h4 class="text-[10px] font-semibold uppercase tracking-widest text-content-subtle mb-sm">
			Print
		</h4>
		<div class="flex flex-col gap-sm">

			<div class="flex flex-col gap-xs">
				<div class="flex items-center justify-between">
					<label for="inv-density" class="text-xs font-medium text-content-muted">Density</label>
					<span class="text-xs text-content font-mono tabular-nums">{fmt(density)}</span>
				</div>
				<input
					id="inv-density"
					type="range" min="0" max="1" step="0.01"
					bind:value={density}
					oninput={emit}
					class="w-full h-1 rounded-full appearance-none cursor-pointer accent-primary"
				/>
			</div>

			<div class="flex flex-col gap-xs">
				<div class="flex items-center justify-between">
					<label for="inv-grade" class="text-xs font-medium text-content-muted">Grade</label>
					<span class="text-xs text-content font-mono tabular-nums">{fmt(grade)}</span>
				</div>
				<input
					id="inv-grade"
					type="range" min="0.5" max="5" step="0.1"
					bind:value={grade}
					oninput={emit}
					class="w-full h-1 rounded-full appearance-none cursor-pointer accent-primary"
				/>
			</div>
		</div>
	</section>

	<!-- ── Shadows ─────────────────────────────────────────────────────────── -->
	<section>
		<h4 class="text-[10px] font-semibold uppercase tracking-widest text-content-subtle mb-sm">
			Shadows
		</h4>
		<div class="flex flex-col gap-sm">

			<div class="flex flex-col gap-xs">
				<div class="flex items-center justify-between">
					<label for="inv-shadows" class="text-xs font-medium text-content-muted">Shadows</label>
					<span class="text-xs text-content font-mono tabular-nums">{fmtSigned(shadows)}</span>
				</div>
				<input
					id="inv-shadows"
					type="range" min="-1" max="1" step="0.01"
					bind:value={shadows}
					oninput={emit}
					class="w-full h-1 rounded-full appearance-none cursor-pointer accent-primary"
				/>
			</div>

			<!-- Toe -->
			<div class="flex flex-col gap-xs">
				<div class="flex items-center justify-between">
					<label for="inv-toe" class="text-xs font-medium text-content-muted">Toe</label>
					<span class="text-xs text-content font-mono tabular-nums">{fmtSigned(toe)}</span>
				</div>
				<input
					id="inv-toe"
					type="range" min="-1" max="1" step="0.01"
					bind:value={toe}
					oninput={emit}
					class="w-full h-1 rounded-full appearance-none cursor-pointer accent-primary"
				/>
			</div>

			<!-- Toe Width + Hardness side by side -->
			<div class="grid grid-cols-2 gap-sm">
				<div class="flex flex-col gap-xs">
					<div class="flex items-center justify-between">
						<label for="inv-toe-width" class="text-[10px] text-content-subtle">Width</label>
						<span class="text-[10px] text-content font-mono tabular-nums">{fmt(toeWidth)}</span>
					</div>
					<input
						id="inv-toe-width"
						type="range" min="0.5" max="8" step="0.1"
						bind:value={toeWidth}
						oninput={emit}
						class="w-full h-1 rounded-full appearance-none cursor-pointer accent-primary"
					/>
				</div>
				<div class="flex flex-col gap-xs">
					<div class="flex items-center justify-between">
						<label for="inv-toe-hardness" class="text-[10px] text-content-subtle">Hardness</label>
						<span class="text-[10px] text-content font-mono tabular-nums">{fmt(toeHardness)}</span>
					</div>
					<input
						id="inv-toe-hardness"
						type="range" min="0.1" max="4" step="0.1"
						bind:value={toeHardness}
						oninput={emit}
						class="w-full h-1 rounded-full appearance-none cursor-pointer accent-primary"
					/>
				</div>
			</div>

			<!-- Shadow CMY -->
			<div class="flex flex-col gap-xs">
				<span class="text-[10px] text-content-subtle">Shadow color</span>
				<div class="flex flex-col gap-xs pl-xs border-l border-base-subtle">
					{#snippet sCmyRow(id: string, label: string, colorClass: string, val: number, onInput: (v: number) => void)}
						<div class="flex items-center gap-sm">
							<label for={id} class="text-[10px] w-12 shrink-0 {colorClass}">{label}</label>
							<input
								{id}
								type="range" min="-1" max="1" step="0.01"
								value={val}
								oninput={(e) => { onInput(parseFloat((e.currentTarget as HTMLInputElement).value)); emit(); }}
								class="flex-1 h-1 rounded-full appearance-none cursor-pointer accent-primary"
							/>
							<span class="text-[10px] text-content font-mono tabular-nums w-10 text-right">{fmtSigned(val)}</span>
						</div>
					{/snippet}
					{@render sCmyRow('inv-s-cyan',    'Cyan',    'text-[#00bcd4]', shadowCyan,    (v) => { shadowCyan    = v; })}
					{@render sCmyRow('inv-s-magenta', 'Magenta', 'text-[#e91e63]', shadowMagenta, (v) => { shadowMagenta = v; })}
					{@render sCmyRow('inv-s-yellow',  'Yellow',  'text-[#ffeb3b]', shadowYellow,  (v) => { shadowYellow  = v; })}
				</div>
			</div>
		</div>
	</section>

	<!-- ── Highlights ──────────────────────────────────────────────────────── -->
	<section>
		<h4 class="text-[10px] font-semibold uppercase tracking-widest text-content-subtle mb-sm">
			Highlights
		</h4>
		<div class="flex flex-col gap-sm">

			<div class="flex flex-col gap-xs">
				<div class="flex items-center justify-between">
					<label for="inv-highlights" class="text-xs font-medium text-content-muted">Highlights</label>
					<span class="text-xs text-content font-mono tabular-nums">{fmtSigned(highlights)}</span>
				</div>
				<input
					id="inv-highlights"
					type="range" min="-1" max="1" step="0.01"
					bind:value={highlights}
					oninput={emit}
					class="w-full h-1 rounded-full appearance-none cursor-pointer accent-primary"
				/>
			</div>

			<!-- Shoulder -->
			<div class="flex flex-col gap-xs">
				<div class="flex items-center justify-between">
					<label for="inv-shoulder" class="text-xs font-medium text-content-muted">Shoulder</label>
					<span class="text-xs text-content font-mono tabular-nums">{fmtSigned(shoulder)}</span>
				</div>
				<input
					id="inv-shoulder"
					type="range" min="-1" max="1" step="0.01"
					bind:value={shoulder}
					oninput={emit}
					class="w-full h-1 rounded-full appearance-none cursor-pointer accent-primary"
				/>
			</div>

			<!-- Shoulder Width + Hardness -->
			<div class="grid grid-cols-2 gap-sm">
				<div class="flex flex-col gap-xs">
					<div class="flex items-center justify-between">
						<label for="inv-sh-width" class="text-[10px] text-content-subtle">Width</label>
						<span class="text-[10px] text-content font-mono tabular-nums">{fmt(shoulderWidth)}</span>
					</div>
					<input
						id="inv-sh-width"
						type="range" min="0.5" max="8" step="0.1"
						bind:value={shoulderWidth}
						oninput={emit}
						class="w-full h-1 rounded-full appearance-none cursor-pointer accent-primary"
					/>
				</div>
				<div class="flex flex-col gap-xs">
					<div class="flex items-center justify-between">
						<label for="inv-sh-hardness" class="text-[10px] text-content-subtle">Hardness</label>
						<span class="text-[10px] text-content font-mono tabular-nums">{fmt(shoulderHardness)}</span>
					</div>
					<input
						id="inv-sh-hardness"
						type="range" min="0.1" max="4" step="0.1"
						bind:value={shoulderHardness}
						oninput={emit}
						class="w-full h-1 rounded-full appearance-none cursor-pointer accent-primary"
					/>
				</div>
			</div>

			<!-- Highlight CMY -->
			<div class="flex flex-col gap-xs">
				<span class="text-[10px] text-content-subtle">Highlight color</span>
				<div class="flex flex-col gap-xs pl-xs border-l border-base-subtle">
					{#snippet hCmyRow(id: string, label: string, colorClass: string, val: number, onInput: (v: number) => void)}
						<div class="flex items-center gap-sm">
							<label for={id} class="text-[10px] w-12 shrink-0 {colorClass}">{label}</label>
							<input
								{id}
								type="range" min="-1" max="1" step="0.01"
								value={val}
								oninput={(e) => { onInput(parseFloat((e.currentTarget as HTMLInputElement).value)); emit(); }}
								class="flex-1 h-1 rounded-full appearance-none cursor-pointer accent-primary"
							/>
							<span class="text-[10px] text-content font-mono tabular-nums w-10 text-right">{fmtSigned(val)}</span>
						</div>
					{/snippet}
					{@render hCmyRow('inv-h-cyan',    'Cyan',    'text-[#00bcd4]', highlightCyan,    (v) => { highlightCyan    = v; })}
					{@render hCmyRow('inv-h-magenta', 'Magenta', 'text-[#e91e63]', highlightMagenta, (v) => { highlightMagenta = v; })}
					{@render hCmyRow('inv-h-yellow',  'Yellow',  'text-[#ffeb3b]', highlightYellow,  (v) => { highlightYellow  = v; })}
				</div>
			</div>
		</div>
	</section>

	<!-- ── Reset ───────────────────────────────────────────────────────────── -->
	{#if !isDefault}
		<button
			onclick={reset}
			class="self-start text-xs text-content-subtle hover:text-content transition"
		>
			Reset inversion
		</button>
	{/if}

</div>
