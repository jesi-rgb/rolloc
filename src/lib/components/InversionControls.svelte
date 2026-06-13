<script lang="ts">
	import type {
		InversionParams,
		FilmType,
		TonePreset,
		BorderColor,
	} from "$lib/types";
	import { DEFAULT_INVERSION_PARAMS, TONE_PRESETS } from "$lib/types";
	import { untrack } from "svelte";
	import LabeledRange from "./LabeledRange.svelte";
	import JointSlider from "./JointSlider.svelte";
	import ColorFilmButton from "./ColorFilmButton.svelte";
	import BlackWhiteFilmButton from "./BlackWhiteFilmButton.svelte";
	import SlideFilmButton from "./SlideFilmButton.svelte";
	import ToggleButton from "./ToggleButton.svelte";
	import { EyedropperSampleIcon } from "phosphor-svelte";

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
		/** Whether the white-balance eyedropper picker is currently active. */
		wbPickerActive?: boolean;
		/** Toggles the white-balance eyedropper picker on the canvas. */
		onToggleWbPicker?: () => void;
	}

	let {
		value,
		onChange,
		onCommit,
		wbPickerActive = false,
		onToggleWbPicker,
	}: Props = $props();

	// ─── Local reactive copies (untrack to avoid "only captures initial value" warning) ───

	let filmType = $state<FilmType>(untrack(() => value.filmType));
	let tonePreset = $state<TonePreset>(untrack(() => value.tonePreset));
	let autoLevels = $state(untrack(() => value.autoLevels));
	let autoExposure = $state(untrack(() => value.autoExposure));
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
	let shoulder = $state(untrack(() => value.shoulder));
	let claheStrength = $state(untrack(() => value.claheStrength));
	let vibrance = $state(untrack(() => value.vibrance));
	let saturation = $state(untrack(() => value.saturation));
	let glow = $state(untrack(() => value.glow));
	let sharpen = $state(untrack(() => value.sharpen));
	let borderWidth = $state(untrack(() => value.borderWidth));
	let borderColor = $state<BorderColor>(untrack(() => value.borderColor));

	// Re-sync when parent swaps to a different frame / roll
	$effect(() => {
		// Deliberately reading reactive `value` to react to prop changes,
		// then writing local copies — acceptable pattern per AGENTS.md.
		filmType = value.filmType;
		tonePreset = value.tonePreset;
		autoLevels = value.autoLevels;
		autoExposure = value.autoExposure;
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
		shoulder = value.shoulder;
		claheStrength = value.claheStrength;
		vibrance = value.vibrance;
		saturation = value.saturation;
		glow = value.glow;
		sharpen = value.sharpen;
		borderWidth = value.borderWidth;
		borderColor = value.borderColor;
	});

	/** Build the current params object. */
	function currentParams(): InversionParams {
		return {
			filmType,
			tonePreset,
			autoLevels,
			autoExposure,
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
			toeWidth: DEFAULT_INVERSION_PARAMS.toeWidth,
			toeHardness: DEFAULT_INVERSION_PARAMS.toeHardness,
			shoulder,
			shoulderWidth: DEFAULT_INVERSION_PARAMS.shoulderWidth,
			shoulderHardness: DEFAULT_INVERSION_PARAMS.shoulderHardness,
			claheStrength,
			vibrance,
			saturation,
			sharpen,
			glow,
			borderWidth,
			borderColor,
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
		tonePreset = d.tonePreset;
		autoLevels = d.autoLevels;
		autoExposure = d.autoExposure;
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
		shoulder = d.shoulder;
		claheStrength = d.claheStrength;
		vibrance = d.vibrance;
		saturation = d.saturation;
		glow = d.glow;
		sharpen = d.sharpen;
		borderWidth = d.borderWidth;
		borderColor = d.borderColor;
		// Reset is a discrete action — commit immediately so it persists + adds to history.
		commit();
	}

	const isDefault = $derived(
		filmType === DEFAULT_INVERSION_PARAMS.filmType &&
			tonePreset === DEFAULT_INVERSION_PARAMS.tonePreset &&
			autoLevels === DEFAULT_INVERSION_PARAMS.autoLevels &&
			autoExposure === DEFAULT_INVERSION_PARAMS.autoExposure &&
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
			shoulder === DEFAULT_INVERSION_PARAMS.shoulder &&
			claheStrength === DEFAULT_INVERSION_PARAMS.claheStrength &&
			vibrance === DEFAULT_INVERSION_PARAMS.vibrance &&
			saturation === DEFAULT_INVERSION_PARAMS.saturation &&
			sharpen === DEFAULT_INVERSION_PARAMS.sharpen &&
			glow === DEFAULT_INVERSION_PARAMS.glow &&
			borderWidth === DEFAULT_INVERSION_PARAMS.borderWidth &&
			borderColor === DEFAULT_INVERSION_PARAMS.borderColor,
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
	</section>

	<!-- ── Tone Preset ────────────────────────────────────────────────────── -->
	<section>
		<h4
			class="text-xs font-semibold uppercase tracking-widest text-content-subtle mb-sm"
		>
			Tone
		</h4>
		<select
			class="w-full rounded border border-base-subtle bg-surface px-sm
			py-xs text-sm text-content-muted"
			value={tonePreset}
			onchange={(e) => {
				tonePreset = (e.currentTarget as HTMLSelectElement)
					.value as TonePreset;
				commit();
			}}
		>
			<option value="standard">Standard</option>
			<option value="soft">Soft</option>
			<option value="punch">Punch</option>
		</select>
	</section>

	<!-- ── Global CMY ──────────────────────────────────────────────────────── -->
	<section>
		<div class="flex items-center justify-between mb-sm">
			<h4
				class="text-xs font-semibold uppercase tracking-widest text-content-subtle"
			>
				Color timing
			</h4>
			{#if onToggleWbPicker}
				<ToggleButton
					active={wbPickerActive}
					onclick={onToggleWbPicker}
					title="Pick a neutral white or gray pixel on the image to auto-set color balance"
				>
					<EyedropperSampleIcon weight="duotone" size={18} />
					White Balance
				</ToggleButton>
			{/if}
		</div>
		<JointSlider
			min={-1}
			max={1}
			step={0.01}
			signed
			slots={[
				{
					id: "cyan",
					label: "C",
					value: cmyCyan,
					color: "#00bcd4",
					negativeColor: "#f44336",
					defaultValue: DEFAULT_INVERSION_PARAMS.cmyCyan,
				},
				{
					id: "magenta",
					label: "M",
					value: cmyMagenta,
					color: "#e91e63",
					negativeColor: "#4caf50",
					defaultValue: DEFAULT_INVERSION_PARAMS.cmyMagenta,
				},
				{
					id: "yellow",
					label: "Y",
					value: cmyYellow,
					color: "#ffeb3b",
					negativeColor: "#2196f3",
					defaultValue: DEFAULT_INVERSION_PARAMS.cmyYellow,
				},
			]}
			onChange={(id, v) => {
				if (id === "cyan") cmyCyan = v;
				else if (id === "magenta") cmyMagenta = v;
				else if (id === "yellow") cmyYellow = v;
				emit();
			}}
			onCommit={(id, v) => {
				if (id === "cyan") cmyCyan = v;
				else if (id === "magenta") cmyMagenta = v;
				else if (id === "yellow") cmyYellow = v;
				commit();
			}}
		/>
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
				min={-5}
				max={5}
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

			<!-- Shadow CMY tint -->
			<div class="flex flex-col gap-xs">
				<span class="text-xs text-content-subtle">Shadow tint</span>
				<JointSlider
					min={-1}
					max={1}
					step={0.01}
					height={30}
					signed
					slots={[
						{
							id: "cyan",
							label: "C",
							value: shadowCyan,
							color: "#00bcd4",
							negativeColor: "#f44336",
							defaultValue: DEFAULT_INVERSION_PARAMS.shadowCyan,
						},
						{
							id: "magenta",
							label: "M",
							value: shadowMagenta,
							color: "#e91e63",
							negativeColor: "#4caf50",
							defaultValue:
								DEFAULT_INVERSION_PARAMS.shadowMagenta,
						},
						{
							id: "yellow",
							label: "Y",
							value: shadowYellow,
							color: "#ffeb3b",
							negativeColor: "#2196f3",
							defaultValue: DEFAULT_INVERSION_PARAMS.shadowYellow,
						},
					]}
					onChange={(id, v) => {
						if (id === "cyan") shadowCyan = v;
						else if (id === "magenta") shadowMagenta = v;
						else if (id === "yellow") shadowYellow = v;
						emit();
					}}
					onCommit={(id, v) => {
						if (id === "cyan") shadowCyan = v;
						else if (id === "magenta") shadowMagenta = v;
						else if (id === "yellow") shadowYellow = v;
						commit();
					}}
				/>
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

			<!-- Highlight CMY tint -->
			<div class="flex flex-col gap-xs">
				<span class="text-xs text-content-subtle">Highlight tint</span>
				<JointSlider
					min={-1}
					max={1}
					step={0.01}
					height={30}
					signed
					slots={[
						{
							id: "cyan",
							label: "C",
							value: highlightCyan,
							color: "#00bcd4",
							negativeColor: "#f44336",
							defaultValue:
								DEFAULT_INVERSION_PARAMS.highlightCyan,
						},
						{
							id: "magenta",
							label: "M",
							value: highlightMagenta,
							color: "#e91e63",
							negativeColor: "#4caf50",
							defaultValue:
								DEFAULT_INVERSION_PARAMS.highlightMagenta,
						},
						{
							id: "yellow",
							label: "Y",
							value: highlightYellow,
							color: "#ffeb3b",
							negativeColor: "#2196f3",
							defaultValue:
								DEFAULT_INVERSION_PARAMS.highlightYellow,
						},
					]}
					onChange={(id, v) => {
						if (id === "cyan") highlightCyan = v;
						else if (id === "magenta") highlightMagenta = v;
						else if (id === "yellow") highlightYellow = v;
						emit();
					}}
					onCommit={(id, v) => {
						if (id === "cyan") highlightCyan = v;
						else if (id === "magenta") highlightMagenta = v;
						else if (id === "yellow") highlightYellow = v;
						commit();
					}}
				/>
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
				label="Clarity"
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

	<!-- ── Color (Vibrance & Saturation) ──────────────────────────────────── -->
	{#if filmType !== "BW"}
		<section>
			<h4
				class="text-xs font-semibold uppercase tracking-widest text-content-subtle mb-sm"
			>
				Color
			</h4>
			<div class="flex flex-col gap-sm">
				<LabeledRange
					id="inv-vibrance"
					label="Vibrance"
					min={-1}
					max={1}
					step={0.01}
					value={vibrance}
					defaultValue={DEFAULT_INVERSION_PARAMS.vibrance}
					onchange={(v) => {
						vibrance = v;
						emit();
					}}
					oncommit={commit}
					signed
				/>
				<LabeledRange
					id="inv-saturation"
					label="Saturation"
					min={-1}
					max={1}
					step={0.01}
					value={saturation}
					defaultValue={DEFAULT_INVERSION_PARAMS.saturation}
					onchange={(v) => {
						saturation = v;
						emit();
					}}
					oncommit={commit}
					signed
				/>
			</div>
		</section>
	{/if}

	<!-- ── Detail (Sharpening) ────────────────────────────────────────────── -->
	<section>
		<h4
			class="text-xs font-semibold uppercase tracking-widest text-content-subtle mb-sm"
		>
			Detail
		</h4>
		<div class="flex flex-col gap-sm">
			<LabeledRange
				id="inv-sharpen"
				label="Sharpen"
				min={0}
				max={1}
				step={0.01}
				value={sharpen}
				defaultValue={DEFAULT_INVERSION_PARAMS.sharpen}
				onchange={(v) => {
					sharpen = v;
					emit();
				}}
				oncommit={commit}
			/>
		</div>
	</section>

	<!-- ── Effects ─────────────────────────────────────────────────────────── -->
	<section>
		<h4
			class="text-xs font-semibold uppercase tracking-widest text-content-subtle mb-sm"
		>
			Effects
		</h4>
		<div class="flex flex-col gap-sm">
			<LabeledRange
				id="inv-glow"
				label="Glow"
				min={0}
				max={5}
				step={0.01}
				value={glow}
				defaultValue={DEFAULT_INVERSION_PARAMS.glow}
				onchange={(v) => {
					glow = v;
					emit();
				}}
				oncommit={commit}
			/>
		</div>
	</section>

	<!-- ── Export border (matting) ─────────────────────────────────────────── -->
	<section>
		<h4
			class="text-xs font-semibold uppercase tracking-widest text-content-subtle mb-sm"
		>
			Border
		</h4>
		<div class="flex gap-sm w-full">
			<!-- Black / white colour switch — disabled while width is 0 -->
			<div class="flex items-center justify-between gap-xs shrink">
				<span class="text-xs text-content-muted">Color</span>
				<button
					type="button"
					aria-label="Toggle border color between black and white"
					title={borderWidth === 0
						? "Set a border width to enable"
						: `Border: ${borderColor} — click to swap`}
					disabled={borderWidth === 0}
					onclick={() => {
						borderColor =
							borderColor === "black" ? "white" : "black";
						commit();
					}}
					class="h-3.5 min-w-xl shrink-0 rounded border border-base-subtle transition
					disabled:opacity-40 disabled:cursor-not-allowed
					hover:ring-2 hover:ring-primary"
					style:background-color={borderColor === "black"
						? "#000000"
						: "#ffffff"}
				></button>
			</div>

			<LabeledRange
				id="inv-border-width"
				layout="inline"
				min={0}
				max={25}
				step={0.5}
				value={borderWidth}
				defaultValue={DEFAULT_INVERSION_PARAMS.borderWidth}
				onchange={(v) => {
					borderWidth = v;
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
