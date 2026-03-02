<script lang="ts">
	/**
	 * EXIF data panel component.
	 *
	 * Displays camera metadata including standard EXIF fields and
	 * Fujifilm-specific MakerNote settings (film simulation, grain, etc.).
	 */
	import MiniCalendar from "$lib/components/MiniCalendar.svelte";
	import AnalogClock from "$lib/components/AnalogClock.svelte";
	import ExposureCompensationScale from "$lib/components/ExposureCompensationScale.svelte";
	import { getFilmSimIcon } from "$lib/image/film-sim-icons";
	import type { ExifData } from "$lib/components/exif-types";

	interface Props {
		exif: ExifData | null;
	}

	let { exif }: Props = $props();

	function formatExposureTime(time: number | undefined): string {
		if (!time) return "—";
		if (time >= 1) return `${time.toFixed(1)}s`;
		return `1/${Math.round(1 / time)}s`;
	}

	function formatAperture(f: number | undefined): string {
		if (!f) return "—";
		return `f/${f.toFixed(1)}`;
	}

	function formatFocalLength(fl: number | undefined): string {
		if (!fl) return "—";
		return `${Math.round(fl)}mm`;
	}


</script>

<aside
	class="w-80 border-l border-base-subtle bg-base-muted overflow-y-auto p-base"
>
	<h2
		class="text-sm font-medium text-center text-content-muted uppercase tracking-wide mb-base"
	>
		EXIF Data
	</h2>

	{#if exif}
		{#if exif.dateTime}
			<div class="mb-base">
				<dd class="text-content font-medium">
					<div class="flex flex-row gap-base items-start">
						<MiniCalendar date={exif.dateTime} />
						<AnalogClock date={exif.dateTime} />
					</div>
				</dd>
			</div>
		{/if}
		<dl class="grid grid-cols-2 gap-base text-sm">
			{#if exif.make || exif.model}
				<div>
					<dt class="text-content-muted">Camera</dt>
					<dd class="text-content font-medium">
						{exif.make || ""}
						{exif.model || ""}
					</dd>
				</div>
			{/if}

			{#if exif.lensModel}
				<div>
					<dt class="text-content-muted">Lens</dt>
					<dd class="text-content font-medium">
						{exif.lensModel}
					</dd>
				</div>
			{/if}

			{#if exif.iso}
				<div>
					<dt class="text-content-muted">ISO</dt>
					<dd class="text-content font-medium">
						{exif.iso}
					</dd>
				</div>
			{/if}

			{#if exif.fNumber}
				<div>
					<dt class="text-content-muted">Aperture</dt>
					<dd class="text-content font-medium">
						{formatAperture(exif.fNumber)}
					</dd>
				</div>
			{/if}

			{#if exif.exposureTime}
				<div>
					<dt class="text-content-muted">Shutter Speed</dt>
					<dd class="text-content font-medium">
						{formatExposureTime(exif.exposureTime)}
					</dd>
				</div>
			{/if}

			{#if exif.focalLength}
				<div>
					<dt class="text-content-muted">Focal Length</dt>
					<dd class="text-content font-medium">
						{formatFocalLength(exif.focalLength)}
					</dd>
				</div>
			{/if}

		{#if exif.exposureCompensation !== undefined && exif.exposureCompensation !== null}
			<div class="col-span-2">
				<dt class="text-content-muted mb-sm">Exposure Compensation</dt>
				<dd class="text-content font-medium">
					<ExposureCompensationScale value={exif.exposureCompensation} />
				</dd>
			</div>
		{/if}

			{#if exif.fuji}
				{#if exif.fuji.filmMode}
					{@const icon = getFilmSimIcon(exif.fuji.filmMode)}
					<div>
						<dt class="text-content-muted">Film Simulation</dt>
						<dd class="text-content font-medium flex items-baseline gap-sm">
							{#if icon}
								<span
									class="inline-block leading-none"
									style="font-family: '{icon.font}'; font-size: 1.25rem;"
									aria-hidden="true"
								>
									{icon.char}
								</span>
							{/if}
							<span>{exif.fuji.filmMode}</span>
						</dd>
					</div>
				{/if}

				{#if exif.fuji.grainEffect && exif.fuji.grainEffect !== "Off"}
					<div>
						<dt class="text-content-muted">Grain Effect</dt>
						<dd class="text-content font-medium">
							{exif.fuji.grainEffect}
						</dd>
					</div>
				{/if}

				{#if exif.fuji.colorChromeEffect && exif.fuji.colorChromeEffect !== "Off"}
					<div>
						<dt class="text-content-muted">Color Chrome</dt>
						<dd class="text-content font-medium">
							{exif.fuji.colorChromeEffect}
						</dd>
					</div>
				{/if}

				{#if exif.fuji.colorChromeFXBlue && exif.fuji.colorChromeFXBlue !== "Off"}
					<div>
						<dt class="text-content-muted">Color Chrome FX Blue</dt>
						<dd class="text-content font-medium">
							{exif.fuji.colorChromeFXBlue}
						</dd>
					</div>
				{/if}

				{#if exif.fuji.clarity && exif.fuji.clarity !== "0 (Normal)"}
					<div>
						<dt class="text-content-muted">Clarity</dt>
						<dd class="text-content font-medium">
							{exif.fuji.clarity}
						</dd>
					</div>
				{/if}

				{#if exif.fuji.dynamicRange}
					<div>
						<dt class="text-content-muted">Dynamic Range</dt>
						<dd class="text-content font-medium">
							{exif.fuji.dynamicRange}
						</dd>
					</div>
				{/if}
			{/if}
		</dl>
	{:else}
		<p class="text-sm text-content-muted">No EXIF data available</p>
	{/if}
</aside>
