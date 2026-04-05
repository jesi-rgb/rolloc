<script lang="ts">
	import type { InversionParams, FilmType } from "$lib/types";
	import { DEFAULT_INVERSION_PARAMS } from "$lib/types";
	import { untrack } from "svelte";
	import LabeledRange from "./LabeledRange.svelte";
	import ColorFilmButton from "./ColorFilmButton.svelte";
	import BlackWhiteFilmButton from "./BlackWhiteFilmButton.svelte";
	import SlideFilmButton from "./SlideFilmButton.svelte";

	interface Props {
		value: InversionParams;
		/** Called on every drag tick — for live GPU preview. No IDB write. */
		onChange: (p: InversionParams) => void;
		/**
		 * Called once when the user releases a slider (drag-end).
		 * Trigger IDB persist + history push here to avoid flooding the DB.
		 * Falls back to `onChange` if not provided (backwards-compatible).
		 */
		onCommit?: (p: InversionParams) => void;
	}

	let { value, onChange, onCommit }: Props = $props();

	// ─── Local reactive copies (untrack to avoid "only captures initial value" warning) ───

	let filmType = $state<FilmType>(untrack(() => value.filmType));
	let e6Normalize = $state(untrack(() => value.e6Normalize));
	let density = $state(untrack(() => value.density));
	let grade = $state(untrack(() => value.grade));
	let cmyCyan = $state(untrack(() => value.cmyCyan));
	let cmyMagenta = $state(untrack(() => value.cmyMagenta));
	let cmyYellow = $state(untrack(() => value.cmyYellow));
	let shadowCyan = $state(untrack(() => value.shadowCyan));
	let shadowMagenta = $state(untrack(() => value.shadowMagenta));
	let shadowYellow = $state(untrack(() => value.shadowYellow));
	let highlightCyan = $state(untrack(() => value.highlightCyan));
	let highlightMagenta = $state(untrack(() => value.highlightMagenta));
	let highlightYellow = $state(untrack(() => value.highlightYellow));
	let shadows = $state(untrack(() => value.shadows));
	let highlights = $state(untrack(() => value.highlights));
	let toe = $state(untrack(() => value.toe));
	let toeWidth = $state(untrack(() => value.toeWidth));
	let toeHardness = $state(untrack(() => value.toeHardness));
	let shoulder = $state(untrack(() => value.shoulder));
	let shoulderWidth = $state(untrack(() => value.shoulderWidth));
	let shoulderHardness = $state(untrack(() => value.shoulderHardness));
	let claheStrength = $state(untrack(() => value.claheStrength));

	// Re-sync when parent swaps to a different frame / roll
	$effect(() => {
		// Deliberately reading reactive `value` to react to prop changes,
		// then writing local copies — acceptable pattern per AGENTS.md.
		filmType = value.filmType;
		e6Normalize = value.e6Normalize;
		density = value.density;
		grade = value.grade;
		cmyCyan = value.cmyCyan;
		cmyMagenta = value.cmyMagenta;
		cmyYellow = value.cmyYellow;
		shadowCyan = value.shadowCyan;
		shadowMagenta = value.shadowMagenta;
		shadowYellow = value.shadowYellow;
		highlightCyan = value.highlightCyan;
		highlightMagenta = value.highlightMagenta;
		highlightYellow = value.highlightYellow;
		shadows = value.shadows;
		highlights = value.highlights;
		toe = value.toe;
		toeWidth = value.toeWidth;
		toeHardness = value.toeHardness;
		shoulder = value.shoulder;
		shoulderWidth = value.shoulderWidth;
		shoulderHardness = value.shoulderHardness;
		claheStrength = value.claheStrength;
	});

	/** Build the current params object. */
	function currentParams(): InversionParams {
		return {
			filmType,
			e6Normalize,
			density,
			grade,
			cmyCyan,
			cmyMagenta,
			cmyYellow,
			shadowCyan,
			shadowMagenta,
			shadowYellow,
			highlightCyan,
			highlightMagenta,
			highlightYellow,
			shadows,
			highlights,
			toe,
			toeWidth,
			toeHardness,
			shoulder,
			shoulderWidth,
			shoulderHardness,
			claheStrength,
		};
	}

	/** Called on every drag tick — live GPU preview, no IDB write. */
	function emit(): void {
		onChange(currentParams());
	}

	/** Called on slider drag-end — triggers IDB persist + history push. */
	function commit(): void {
		(onCommit ?? onChange)(currentParams());
	}

	function reset(): void {
		const d = DEFAULT_INVERSION_PARAMS;
		filmType = d.filmType;
		e6Normalize = d.e6Normalize;
		density = d.density;
		grade = d.grade;
		cmyCyan = d.cmyCyan;
		cmyMagenta = d.cmyMagenta;
		cmyYellow = d.cmyYellow;
		shadowCyan = d.shadowCyan;
		shadowMagenta = d.shadowMagenta;
		shadowYellow = d.shadowYellow;
		highlightCyan = d.highlightCyan;
		highlightMagenta = d.highlightMagenta;
		highlightYellow = d.highlightYellow;
		shadows = d.shadows;
		highlights = d.highlights;
		toe = d.toe;
		toeWidth = d.toeWidth;
		toeHardness = d.toeHardness;
		shoulder = d.shoulder;
		shoulderWidth = d.shoulderWidth;
		shoulderHardness = d.shoulderHardness;
		claheStrength = d.claheStrength;
		// Reset is a discrete action — commit immediately so it persists + adds to history.
		commit();
	}

	const isDefault = $derived(
		filmType === DEFAULT_INVERSION_PARAMS.filmType &&
			e6Normalize === DEFAULT_INVERSION_PARAMS.e6Normalize &&
			density === DEFAULT_INVERSION_PARAMS.density &&
			grade === DEFAULT_INVERSION_PARAMS.grade &&
			cmyCyan === DEFAULT_INVERSION_PARAMS.cmyCyan &&
			cmyMagenta === DEFAULT_INVERSION_PARAMS.cmyMagenta &&
			cmyYellow === DEFAULT_INVERSION_PARAMS.cmyYellow &&
			shadowCyan === DEFAULT_INVERSION_PARAMS.shadowCyan &&
			shadowMagenta === DEFAULT_INVERSION_PARAMS.shadowMagenta &&
			shadowYellow === DEFAULT_INVERSION_PARAMS.shadowYellow &&
			highlightCyan === DEFAULT_INVERSION_PARAMS.highlightCyan &&
			highlightMagenta === DEFAULT_INVERSION_PARAMS.highlightMagenta &&
			highlightYellow === DEFAULT_INVERSION_PARAMS.highlightYellow &&
			shadows === DEFAULT_INVERSION_PARAMS.shadows &&
			highlights === DEFAULT_INVERSION_PARAMS.highlights &&
			toe === DEFAULT_INVERSION_PARAMS.toe &&
			toeWidth === DEFAULT_INVERSION_PARAMS.toeWidth &&
			toeHardness === DEFAULT_INVERSION_PARAMS.toeHardness &&
			shoulder === DEFAULT_INVERSION_PARAMS.shoulder &&
			shoulderWidth === DEFAULT_INVERSION_PARAMS.shoulderWidth &&
			shoulderHardness === DEFAULT_INVERSION_PARAMS.shoulderHardness &&
			claheStrength === DEFAULT_INVERSION_PARAMS.claheStrength,
	);
</script>

<!--
	InversionControls
	Exposes all NegPy inversion parameters as labelled sliders.
	Mirrors the layout of the reference NegPy UI (Density, Grade, CMY timing,
	Shadows/Highlights, Toe, Shoulder).
-->

<div class="flex flex-col gap-l">
	<!-- ── Film Type ───────────────────────────────────────────────────────── -->
	<section>
		<h4
			class="text-xs font-semibold uppercase tracking-widest text-content-subtle mb-sm"
		>
			Film type
		</h4>
		<div class="flex gap-sm">
			<ColorFilmButton
				selected={filmType === "C41"}
				onclick={() => {
					filmType = "C41";
					commit();
				}}
			/>
			<BlackWhiteFilmButton
				selected={filmType === "BW"}
				onclick={() => {
					filmType = "BW";
					commit();
				}}
			/>
			<SlideFilmButton
				selected={filmType === "E6"}
				onclick={() => {
					filmType = "E6";
					commit();
				}}
			/>
		</div>
		{#if filmType === "E6"}
			<label
				class="flex items-center gap-xs mt-sm text-xs text-content-subtle cursor-pointer"
			>
				<input
					type="checkbox"
					checked={e6Normalize}
					onchange={(e) => {
						e6Normalize = e.currentTarget.checked;
						commit();
					}}
					class="accent-accent"
				/>
				Auto-normalize (percentile stretch)
			</label>
		{/if}
	</section>

	<!-- ── Global CMY ──────────────────────────────────────────────────────── -->
	<section>
		<h4
			class="text-xs font-semibold uppercase tracking-widest text-content-subtle mb-sm"
		>
			Color timing
		</h4>
		<div class="flex flex-col gap-sm">
			<LabeledRange
				id="inv-cyan"
				label="Cyan"
				min={-1}
				max={1}
				step={0.01}
				value={cmyCyan}
				defaultValue={DEFAULT_INVERSION_PARAMS.cmyCyan}
				onchange={(v) => {
					cmyCyan = v;
					emit();
				}}
				oncommit={commit}
				signed
				labelClass="text-[#00bcd4]"
				thumbColor="#00bcd4"
				trackColor="#00bcd413"
			/>
			<LabeledRange
				id="inv-magenta"
				label="Magenta"
				min={-1}
				max={1}
				step={0.01}
				value={cmyMagenta}
				defaultValue={DEFAULT_INVERSION_PARAMS.cmyMagenta}
				onchange={(v) => {
					cmyMagenta = v;
					emit();
				}}
				oncommit={commit}
				signed
				labelClass="text-[#e91e63]"
				thumbColor="#e91e63"
				trackColor="#e91e6313"
			/>
			<LabeledRange
				id="inv-yellow"
				label="Yellow"
				min={-1}
				max={1}
				step={0.01}
				value={cmyYellow}
				defaultValue={DEFAULT_INVERSION_PARAMS.cmyYellow}
				onchange={(v) => {
					cmyYellow = v;
					emit();
				}}
				oncommit={commit}
				signed
				labelClass="text-[#ffeb3b]"
				thumbColor="#ffeb3b"
				trackColor="#ffeb3b13"
			/>
		</div>
	</section>

	<!-- ── Density + Grade ─────────────────────────────────────────────────── -->
	<section>
		<h4
			class="text-xs font-semibold uppercase tracking-widest text-content-subtle mb-sm"
		>
			Print
		</h4>
		<div class="flex flex-col gap-sm">
			<LabeledRange
				id="inv-density"
				label="Density"
				min={0}
				max={10}
				step={0.01}
				value={density}
				defaultValue={DEFAULT_INVERSION_PARAMS.density}
				onchange={(v) => {
					density = v;
					emit();
				}}
				oncommit={commit}
			/>
			<LabeledRange
				id="inv-grade"
				label="Grade"
				min={0}
				max={10}
				step={0.1}
				value={grade}
				defaultValue={DEFAULT_INVERSION_PARAMS.grade}
				onchange={(v) => {
					grade = v;
					emit();
				}}
				oncommit={commit}
			/>
		</div>
	</section>

	<!-- ── Shadows ─────────────────────────────────────────────────────────── -->
	<section>
		<h4
			class="text-xs font-semibold uppercase tracking-widest text-content-subtle mb-sm"
		>
			Shadows
		</h4>
		<div class="flex flex-col gap-sm">
			<LabeledRange
				id="inv-shadows"
				label="Shadows"
				min={-10}
				max={10}
				step={0.01}
				value={shadows}
				defaultValue={DEFAULT_INVERSION_PARAMS.shadows}
				onchange={(v) => {
					shadows = v;
					emit();
				}}
				oncommit={commit}
				signed
			/>
			<LabeledRange
				id="inv-toe"
				label="Toe"
				min={-1}
				max={1}
				step={0.01}
				value={toe}
				defaultValue={DEFAULT_INVERSION_PARAMS.toe}
				onchange={(v) => {
					toe = v;
					emit();
				}}
				oncommit={commit}
				signed
			/>

			<!-- Toe Width + Hardness side by side -->
			<div class="grid grid-cols-2 gap-sm">
				<LabeledRange
					id="inv-toe-width"
					label="Width"
					min={0.5}
					max={8}
					step={0.1}
					value={toeWidth}
					defaultValue={DEFAULT_INVERSION_PARAMS.toeWidth}
					onchange={(v) => {
						toeWidth = v;
						emit();
					}}
					oncommit={commit}
					small
				/>
				<LabeledRange
					id="inv-toe-hardness"
					label="Hardness"
					min={0.1}
					max={4}
					step={0.1}
					value={toeHardness}
					defaultValue={DEFAULT_INVERSION_PARAMS.toeHardness}
					onchange={(v) => {
						toeHardness = v;
						emit();
					}}
					oncommit={commit}
					small
				/>
			</div>

			<!-- Shadow CMY -->
			<div class="flex flex-col gap-xs">
				<span class="text-xs text-content-subtle">Shadow color</span>
				<div
					class="flex flex-col gap-xs pl-xs border-l border-base-subtle"
				>
					<LabeledRange
						id="inv-s-cyan"
						label="Cyan"
						layout="inline"
						min={-1}
						max={1}
						step={0.01}
						value={shadowCyan}
						defaultValue={DEFAULT_INVERSION_PARAMS.shadowCyan}
						onchange={(v) => {
							shadowCyan = v;
							emit();
						}}
						oncommit={commit}
						signed
						labelClass="text-[#00bcd4]"
						thumbColor="#00bcd4"
						trackColor="#00bcd418"
					/>
					<LabeledRange
						id="inv-s-magenta"
						label="Magenta"
						layout="inline"
						min={-1}
						max={1}
						step={0.01}
						value={shadowMagenta}
						defaultValue={DEFAULT_INVERSION_PARAMS.shadowMagenta}
						onchange={(v) => {
							shadowMagenta = v;
							emit();
						}}
						oncommit={commit}
						signed
						labelClass="text-[#e91e63]"
						thumbColor="#e91e63"
						trackColor="#e91e6333"
					/>
					<LabeledRange
						id="inv-s-yellow"
						label="Yellow"
						layout="inline"
						min={-1}
						max={1}
						step={0.01}
						value={shadowYellow}
						defaultValue={DEFAULT_INVERSION_PARAMS.shadowYellow}
						onchange={(v) => {
							shadowYellow = v;
							emit();
						}}
						oncommit={commit}
						signed
						labelClass="text-[#ffeb3b]"
						thumbColor="#ffeb3b"
						trackColor="#ffeb3b33"
					/>
				</div>
			</div>
		</div>
	</section>

	<!-- ── Highlights ──────────────────────────────────────────────────────── -->
	<section>
		<h4
			class="text-xs font-semibold uppercase tracking-widest text-content-subtle mb-sm"
		>
			Highlights
		</h4>
		<div class="flex flex-col gap-sm">
			<LabeledRange
				id="inv-highlights"
				label="Highlights"
				min={-1}
				max={1}
				step={0.01}
				value={highlights}
				defaultValue={DEFAULT_INVERSION_PARAMS.highlights}
				onchange={(v) => {
					highlights = v;
					emit();
				}}
				oncommit={commit}
				signed
			/>
			<LabeledRange
				id="inv-shoulder"
				label="Shoulder"
				min={-1}
				max={1}
				step={0.01}
				value={shoulder}
				defaultValue={DEFAULT_INVERSION_PARAMS.shoulder}
				onchange={(v) => {
					shoulder = v;
					emit();
				}}
				oncommit={commit}
				signed
			/>

			<!-- Shoulder Width + Hardness -->
			<div class="grid grid-cols-2 gap-sm">
				<LabeledRange
					id="inv-sh-width"
					label="Width"
					min={0.5}
					max={8}
					step={0.1}
					value={shoulderWidth}
					defaultValue={DEFAULT_INVERSION_PARAMS.shoulderWidth}
					onchange={(v) => {
						shoulderWidth = v;
						emit();
					}}
					oncommit={commit}
					small
				/>
				<LabeledRange
					id="inv-sh-hardness"
					label="Hardness"
					min={0.1}
					max={4}
					step={0.1}
					value={shoulderHardness}
					defaultValue={DEFAULT_INVERSION_PARAMS.shoulderHardness}
					onchange={(v) => {
						shoulderHardness = v;
						emit();
					}}
					oncommit={commit}
					small
				/>
			</div>

			<!-- Highlight CMY -->
			<div class="flex flex-col gap-xs">
				<span class="text-xs text-content-subtle">Highlight color</span>
				<div
					class="flex flex-col gap-xs pl-xs border-l border-base-subtle"
				>
					<LabeledRange
						id="inv-h-cyan"
						label="Cyan"
						layout="inline"
						min={-1}
						max={1}
						step={0.01}
						value={highlightCyan}
						defaultValue={DEFAULT_INVERSION_PARAMS.highlightCyan}
						onchange={(v) => {
							highlightCyan = v;
							emit();
						}}
						oncommit={commit}
						signed
						labelClass="text-[#00bcd4]"
						thumbColor="#00bcd4"
						trackColor="#00bcd418"
					/>
					<LabeledRange
						id="inv-h-magenta"
						label="Magenta"
						layout="inline"
						min={-1}
						max={1}
						step={0.01}
						value={highlightMagenta}
						defaultValue={DEFAULT_INVERSION_PARAMS.highlightMagenta}
						onchange={(v) => {
							highlightMagenta = v;
							emit();
						}}
						oncommit={commit}
						signed
						labelClass="text-[#e91e63]"
						thumbColor="#e91e63"
						trackColor="#e91e6333"
					/>
					<LabeledRange
						id="inv-h-yellow"
						label="Yellow"
						layout="inline"
						min={-1}
						max={1}
						step={0.01}
						value={highlightYellow}
						defaultValue={DEFAULT_INVERSION_PARAMS.highlightYellow}
						onchange={(v) => {
							highlightYellow = v;
							emit();
						}}
						oncommit={commit}
						signed
						labelClass="text-[#ffeb3b]"
						thumbColor="#ffeb3b"
						trackColor="#ffeb3b33"
					/>
				</div>
			</div>
		</div>
	</section>

	<!-- ── Local Contrast (CLAHE) ─────────────────────────────────────────── -->
	<section>
		<h4
			class="text-xs font-semibold uppercase tracking-widest text-content-subtle mb-sm"
		>
			Local contrast
		</h4>
		<div class="flex flex-col gap-sm">
			<LabeledRange
				id="inv-clahe"
				label="CLAHE"
				min={0}
				max={1}
				step={0.01}
				value={claheStrength}
				defaultValue={DEFAULT_INVERSION_PARAMS.claheStrength}
				onchange={(v) => {
					claheStrength = v;
					emit();
				}}
				oncommit={commit}
			/>
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
