<script lang="ts">
  interface Props {
    exportScale: 0.25 | 0.5 | 1;
    disabled: boolean;
    onExport: () => void;
    onScaleChange: (scale: 0.25 | 0.5 | 1) => void;
  }

  let { exportScale, disabled, onExport, onScaleChange }: Props = $props();
</script>

<section>
  <h3
    class="text-xs font-semibold text-content-subtle uppercase tracking-wider mb-sm"
  >
    Export
  </h3>

  <!-- Scale selector + export button (joined group) -->
  <div class="flex flex-col" role="radiogroup" aria-label="Export scale">
    <div class="flex">
      <button
        type="button"
        onclick={() => onScaleChange(0.25)}
        aria-pressed={exportScale === 0.25}
        class="flex-1 px-sm py-xs text-xs font-medium transition
                 border border-r-0 border-b-0 rounded-tl
                 {exportScale === 0.25
          ? 'bg-primary/15 border-primary text-primary'
          : 'border-base-subtle text-content-muted hover:border-content-muted hover:text-content'}"
      >
        0.25x
      </button>
      <button
        type="button"
        onclick={() => onScaleChange(0.5)}
        aria-pressed={exportScale === 0.5}
        class="flex-1 px-sm py-xs text-xs font-medium transition
                 border border-r-0 border-b-0
                 {exportScale === 0.5
          ? 'bg-primary/15 border-primary text-primary'
          : 'border-base-subtle text-content-muted hover:border-content-muted hover:text-content'}"
      >
        0.5x
      </button>
      <button
        type="button"
        onclick={() => onScaleChange(1)}
        aria-pressed={exportScale === 1}
        class="flex-1 px-sm py-xs text-xs font-medium transition
                 border border-b-0 rounded-tr
                 {exportScale === 1
          ? 'bg-primary/15 border-primary text-primary'
          : 'border-base-subtle text-content-muted hover:border-content-muted hover:text-content'}"
      >
        1x
      </button>
    </div>

    <button
      onclick={onExport}
      {disabled}
      class="w-full flex items-center justify-center gap-sm
                   px-sm py-xs rounded-b border text-sm transition
                   border-primary text-primary hover:bg-primary/10
                   disabled:opacity-40 disabled:cursor-not-allowed"
    >
      Export to JPEG
    </button>
  </div>
</section>
