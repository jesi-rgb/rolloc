<script lang="ts">
  /**
   * Frame editor route — /roll/[id]/frame/[frameId]
   *
   * Full-screen lightbox + WebGPU inversion pipeline + edit controls.
   *
   * Keyboard shortcuts:
   *   ← / → (or j / k)  — navigate to prev / next frame
   *   Escape             — back to roll
   *   C                  — toggle crop mode
   *
   * Filmomat-style color controls (mirrors physical keyboard layout):
   *   Q / A  — +/− Cyan
   *   W / S  — +/− Magenta
   *   E / D  — +/− Yellow
   *   R / F  — +/− Grade (contrast)
   *   T / G  — +/− Density
   */
  import { onMount, onDestroy } from "svelte";
  import { fade, fly } from "svelte/transition";
  import { quintOut } from "svelte/easing";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { getRoll, getRollPath, updateRoll, putFrame } from "$lib/db/rolls";
  import { join } from "@tauri-apps/api/path";
  import { invoke } from "@tauri-apps/api/core";
  import { startExport } from "$lib/jobs.svelte";
  import { getFrame, getFrames } from "$lib/db/idb";
  import { readPreview, readThumb } from "$lib/fs/opfs";
  import {
    readPreview as readSidecarPreview,
    readThumb as readSidecarThumb,
    isTauriEnv,
  } from "$lib/fs/sidecar";
  import { ensurePreview } from "$lib/image/thumbgen";
  import {
    createPipeline,
    parseRawDecodeBuffer,
    parseDecodeImageRgbBuffer,
    PREVIEW_MAX_PX,
  } from "$lib/image/pipeline";
  import { focusDecodeWarm, startDecodeWarm } from "$lib/image/decode-warm";
  import {
    resolveEdit,
    DEFAULT_INVERSION_PARAMS,
    DEFAULT_CROP_QUAD,
    DEFAULT_TRANSFORM,
  } from "$lib/types";
  import { isRawExtension } from "$lib/fs/directory";
  import type { GpuPipeline } from "$lib/image/pipeline";
  import type {
    Roll,
    Frame,
    FrameEditOverrides,
    RollEditParams,
    CurvePoints,
    WhiteBalance,
    InversionParams,
    EffectiveEdit,
    CropQuad,
    TransformParams,
    CachedLogPercentiles,
    CropAspect,
  } from "$lib/types";
  import CurvesEditor from "$lib/components/CurvesEditor.svelte";
  import InversionControls from "$lib/components/InversionControls.svelte";
  import KeyboardHintBar from "$lib/components/KeyboardHintBar.svelte";
  import CropOverlay from "$lib/components/CropOverlay.svelte";
  import HorizonOverlay from "$lib/components/HorizonOverlay.svelte";
  import TransformControls from "$lib/components/TransformControls.svelte";
  import ExportControls from "$lib/components/ExportControls.svelte";
  import SidebarSection from "$lib/components/SidebarSection.svelte";
  import { detectHorizonCandidates } from "$lib/image/horizon-detect";
  import { rotationCoverZoom } from "$lib/image/geometry";
  import type { HorizonCandidate } from "$lib/image/horizon-detect";
  import {
    ArrowFatUpIcon,
    CommandIcon,
    ArrowUUpLeftIcon,
    ArrowUUpRightIcon,
    ArrowLeftIcon,
    CaretLeftIcon,
    CaretRightIcon,
    CircleNotchIcon,
    EyedropperSampleIcon,
    WarningIcon,
  } from "phosphor-svelte";

  /** Shared style for the compact header icon buttons. */
  const ICON_BTN =
    "p-1.5 rounded-md text-content-muted hover:text-content hover:bg-base-muted " +
    "transition-[color,background-color,transform] duration-150 ease-out active:scale-95 " +
    "disabled:opacity-30 disabled:pointer-events-none";

  // ─── Undo / redo history ──────────────────────────────────────────────────

  interface HistoryEntry {
    frameEdit: FrameEditOverrides;
    rollEdit: RollEditParams;
  }

  const HISTORY_MAX = 100;

  /** Ring of snapshots; index 0 = oldest retained entry. */
  let historyStack = $state<HistoryEntry[]>([]);
  /** Points at the entry that represents the *current* state. */
  let historyCursor = $state(-1);

  const canUndo = $derived(historyCursor > 0);
  const canRedo = $derived(historyCursor < historyStack.length - 1);

  // ─── Route params ──────────────────────────────────────────────────────────

  const rollId = $derived(page.params.id ?? "");
  const frameId = $derived(page.params.frameId ?? "");

  // ─── State ─────────────────────────────────────────────────────────────────

  let roll = $state<Roll | null>(null);
  let frame = $state<Frame | null>(null);
  let frames = $state<Frame[]>([]);
  let loading = $state(true);
  let gpuError = $state<string | null>(null);
  let renderError = $state<string | null>(null);

  /** Index of the current frame within the roll's frame list. */
  const frameIndex = $derived(frames.findIndex((f) => f.id === frameId));
  const hasPrev = $derived(frameIndex > 0);
  const hasNext = $derived(frameIndex < frames.length - 1);

  // ─── Canvas + pipeline refs ────────────────────────────────────────────────

  let canvasEl = $state<HTMLCanvasElement | null>(null);
  /** Preview area container — drives the swap chain display size. */
  let previewAreaEl = $state<HTMLDivElement | null>(null);
  let pipeline = $state<GpuPipeline | null>(null);
  let currentBitmap = $state<ImageBitmap | null>(null);
  /** Raw binary payload from `raw_decode`; non-null only for RAW frames. */
  let currentRawBuffer = $state<ArrayBuffer | null>(null);
  /** Decoded RGBA8 binary payload from `decode_image_rgba`; non-null only when editing non-RAW frames in Tauri. */
  let currentDecodedBuffer = $state<ArrayBuffer | null>(null);
  /** Original image dimensions (before any transforms). */
  let originalWidth = $state(1);
  let originalHeight = $state(1);
  /** Histogram data from the last render (for curves editor visualization). */
  let currentHistogram = $state<
    import("$lib/image/pipeline").ChannelHistograms | null
  >(null);
  /**
   * Id of the frame whose pixels are currently on the canvas. Lags `frameId`
   * during navigation: the previous frame stays visible (dimmed) until the new
   * one has decoded and painted, instead of flashing an empty overlay.
   */
  let paintedFrameId = $state<string | null>(null);
  const framePending = $derived(loading || paintedFrameId !== frameId);
  const showSpinner = $derived(
    framePending &&
      !gpuError &&
      !renderError &&
      (loading || (roll !== null && frame !== null)),
  );

  // ─── Pipeline init (once, on mount) ───────────────────────────────────────

  onMount(async () => {
    if (!navigator.gpu) {
      gpuError =
        "WebGPU is not supported in this browser. Try Chrome 113+ or Edge 113+.";
      return;
    }
  });

  onDestroy(() => {
    // Leave the sweep running — the roll grid picks it back up, and a decode
    // already paid for is worth keeping.
    pipeline?.destroy();
    currentBitmap?.close();
    currentRawBuffer = null;
    if (horizonNoticeTimer !== null) clearTimeout(horizonNoticeTimer);
  });

  // ─── Create pipeline once canvas is in the DOM ────────────────────────────

  $effect(() => {
    if (!canvasEl || pipeline || gpuError) return;

    createPipeline(canvasEl)
      .then((p) => {
        pipeline = p;
      })
      .catch((err: unknown) => {
        gpuError = err instanceof Error ? err.message : String(err);
      });
  });

  // ─── Keep the swap chain matched to the on-screen preview size ────────────
  // The canvas backing store is sized to fit this box rather than the full
  // image resolution. Letting the browser composite a full-res canvas down to
  // the viewport uses a single bilinear tap with no mip chain, which aliases
  // heavily on grainy scans and makes the preview look far harsher than the
  // exported file.

  $effect(() => {
    const el = previewAreaEl;
    const p = pipeline;
    if (!el || !p) return;

    const ro = new ResizeObserver((entries) => {
      // contentRect excludes padding, which is the space the canvas can use.
      const box = entries[0]?.contentRect;
      if (!box || box.width === 0 || box.height === 0) return;
      p.setDisplayBox(box.width, box.height);
      void renderFrame();
    });
    // ResizeObserver fires once on observe(), which seeds the initial size.
    ro.observe(el);

    return () => ro.disconnect();
  });

  // ─── History helpers ──────────────────────────────────────────────────────

  /**
   * Push the current frame/roll edit state onto the history stack.
   * Truncates any "future" entries if we're mid-stack (after undoing).
   * Clamps the stack to HISTORY_MAX entries.
   */
  function historyPush(
    frameEdit: FrameEditOverrides,
    rollEdit: RollEditParams,
  ): void {
    // Drop everything after the cursor (future history).
    const base = historyStack.slice(0, historyCursor + 1);
    const next = [...base, { frameEdit, rollEdit }];
    // Cap length — drop oldest entries from the front.
    const capped =
      next.length > HISTORY_MAX ? next.slice(next.length - HISTORY_MAX) : next;
    historyStack = capped;
    historyCursor = capped.length - 1;
  }

  /** Seed history with the initial loaded state (no undo past load). */
  function historyInit(
    frameEdit: FrameEditOverrides,
    rollEdit: RollEditParams,
  ): void {
    historyStack = [{ frameEdit, rollEdit }];
    historyCursor = 0;
  }

  async function applyHistoryEntry(entry: HistoryEntry): Promise<void> {
    if (!frame || !roll) return;
    const newFrame: Frame = {
      ...($state.snapshot(frame) as Frame),
      frameEdit: entry.frameEdit,
    };
    const newRoll: Roll = {
      ...($state.snapshot(roll) as Roll),
      rollEdit: entry.rollEdit,
    };
    frame = newFrame;
    roll = newRoll;
    await Promise.all([
      putFrame(structuredClone(newFrame)),
      updateRoll(structuredClone(newRoll)),
    ]);
    renderFrame();
  }

  async function undo(): Promise<void> {
    if (!canUndo) return;
    historyCursor -= 1;
    await applyHistoryEntry(historyStack[historyCursor]);
  }

  async function redo(): Promise<void> {
    if (!canRedo) return;
    historyCursor += 1;
    await applyHistoryEntry(historyStack[historyCursor]);
  }

  // ─── Load frame data + image whenever frameId changes ─────────────────────

  $effect(() => {
    // Capture reactive deps up front so the effect re-runs on navigation.
    const fid = frameId;
    const rid = rollId;
    if (!fid || !rid) return;

    loading = true;
    renderError = null;
    // Clear history on frame navigation — history is per-frame, in-memory only.
    historyStack = [];
    historyCursor = -1;
    // Horizon candidates belong to the previous frame's pixels.
    exitHorizonMode();

    async function load(): Promise<void> {
      const [r, f, allFrames] = await Promise.all([
        getRoll(rid),
        getFrame(fid),
        getFrames(rid),
      ]);

      roll = r ?? null;
      frame = f ?? null;
      // Sort frames by filename with natural/numeric-aware comparison
      // so navigation order matches the filmstrip grid.
      const collator = new Intl.Collator(undefined, {
        numeric: true,
        sensitivity: "base",
      });
      frames = allFrames
        .slice()
        .sort((a, b) => collator.compare(a.filename, b.filename));

      if (!roll || !frame) {
        loading = false;
        return;
      }

      // Seed undo history with the state loaded from the database.
      // Do this before any auto-matrix save so the initial state is index 0.
      historyInit(
        $state.snapshot(frame.frameEdit) as FrameEditOverrides,
        $state.snapshot(roll.rollEdit) as RollEditParams,
      );

      // ── Load full-res image ──────────────────────────────────────────
      // For RAW files: invoke raw_decode to get linear u16 pixel data.
      // For JPEG/TIFF: generate/load a JPEG preview blob, then createImageBitmap.

      const dirPath = await getRollPath(rid);

      // True once a decode that populates the on-disk cache has run for this
      // frame — the fallback preview-blob path does not, so the sweep must
      // still cover it.
      let cacheWarmed = false;

      if (frame && isRawExtension(frame.filename) && dirPath) {
        // RAW path — full linear decode via Tauri command.
        const absolutePath = await join(dirPath, frame.filename);
        let rawBuffer: ArrayBuffer;
        try {
          // Demosaic runs at full sensor resolution, then Rust box-averages
          // down to this cap. PREVIEW_MAX_PX keeps the interactive pass chain
          // affordable without the screen seeing any difference; the GPU limit
          // is the hard ceiling on top of it.
          const gpuLimit = pipeline?.maxTextureDimension ?? 8192;
          const maxPx = Math.min(gpuLimit, PREVIEW_MAX_PX);
          rawBuffer = await invoke<ArrayBuffer>("raw_decode", {
            path: absolutePath,
            maxPx,
            skipWb: roll.rollEdit.invert,
          });
          cacheWarmed = true;
        } catch (err) {
          renderError = `Failed to decode RAW file: ${err instanceof Error ? err.message : String(err)}`;
          loading = false;
          return;
        }

        currentBitmap?.close();
        currentBitmap = null;
        currentDecodedBuffer = null;
        currentRawBuffer = rawBuffer;

        // Track original dimensions for crop overlay coordinate transforms
        const { width: rawW, height: rawH } = parseRawDecodeBuffer(rawBuffer);
        originalWidth = rawW;
        originalHeight = rawH;

        // Parse the metadata to auto-populate cameraColorMatrix and ashotWBCoeffs
        // on first open.
        // Do this after setting currentRawBuffer so renderFrame() triggered
        // by saveRollEdit has it available.
        const isIdentity = (m: number[]): boolean =>
          m[0] === 1 &&
          m[1] === 0 &&
          m[2] === 0 &&
          m[3] === 0 &&
          m[4] === 1 &&
          m[5] === 0 &&
          m[6] === 0 &&
          m[7] === 0 &&
          m[8] === 1;
        const isNeutralWB = (wb: [number, number, number]): boolean =>
          wb[0] === 1 && wb[1] === 1 && wb[2] === 1;
        try {
          const { meta } = parseRawDecodeBuffer(rawBuffer);
          const wbCoeffs: [number, number, number] = [
            meta.wbCoeffs[0],
            meta.wbCoeffs[1],
            meta.wbCoeffs[2],
          ];
          const needsMatrix =
            isIdentity(roll.rollEdit.cameraColorMatrix) &&
            meta.colorMatrix.some((v: number) => v !== 0);
          const needsWB =
            isNeutralWB(roll.rollEdit.ashotWBCoeffs ?? [1, 1, 1]) &&
            wbCoeffs.some((v) => v !== 1);
          if (needsMatrix || needsWB) {
            loading = false;
            await saveRollEdit({
              ...(needsMatrix ? { cameraColorMatrix: meta.colorMatrix } : {}),
              ...(needsWB ? { ashotWBCoeffs: wbCoeffs } : {}),
            });
            return; // saveRollEdit calls renderFrame() — don't set loading=false again
          }
        } catch {
          // Non-fatal — continue without updating the matrix / WB.
        }

        loading = false;
      } else {
        // JPEG / TIFF path — render straight from the original file when
        // running under Tauri. This bypasses the lossy cached preview so the
        // editor shows the clearest possible image, capped only by the GPU
        // texture limit.
        let directBuffer: ArrayBuffer | null = null;
        let fallbackBitmap: ImageBitmap | null = null;

        if (dirPath && isTauriEnv()) {
          try {
            const absolutePath = await join(dirPath, frame.filename);
            const gpuLimit = pipeline?.maxTextureDimension ?? 8192;
            directBuffer = await invoke<ArrayBuffer>("decode_image_rgba", {
              path: absolutePath,
              maxPx: Math.min(gpuLimit, PREVIEW_MAX_PX),
            });
            cacheWarmed = true;
          } catch (err) {
            console.warn(
              "[frame] Direct decode failed, falling back to cached preview:",
              err,
            );
          }
        }

        if (directBuffer) {
          const { width: decW, height: decH } =
            parseDecodeImageRgbBuffer(directBuffer);
          currentBitmap?.close();
          currentBitmap = null;
          currentRawBuffer = null;
          currentDecodedBuffer = directBuffer;
          originalWidth = decW;
          originalHeight = decH;
        } else {
          // Fallback to cached preview blob → ImageBitmap (browser / missing file).
          let blob: Blob | null = null;

          if (dirPath) {
            try {
              const absolutePath = await join(dirPath, frame.filename);
              blob = await ensurePreview(
                frame.id,
                { absolutePath },
                undefined,
                dirPath,
              );
            } catch {
              // File missing — try sidecar/OPFS cache.
            }
          }

          if (!blob && dirPath && isTauriEnv())
            blob = await readSidecarPreview(dirPath, frame.id);
          if (!blob && dirPath && isTauriEnv())
            blob = await readSidecarThumb(dirPath, frame.id);
          if (!blob) blob = await readPreview(frame.id);
          if (!blob) blob = await readThumb(frame.id);

          if (!blob) {
            renderError =
              "No preview cached for this frame. Open the roll to generate thumbnails first.";
            loading = false;
            return;
          }

          fallbackBitmap = await createImageBitmap(blob);
          currentBitmap?.close();
          currentBitmap = fallbackBitmap;
          currentRawBuffer = null;
          currentDecodedBuffer = null;
          // Track original dimensions for crop overlay coordinate transforms
          originalWidth = fallbackBitmap.width;
          originalHeight = fallbackBitmap.height;
        }
      }

      loading = false;

      // The frame on screen is decoded (and therefore cached) by now — tell the
      // sweep so it moves on to the neighbours instead of redoing this one.
      focusDecodeWarm(fid, cacheWarmed);
      if (dirPath && frames.length > 1) {
        void startDecodeWarm({
          rollId: rid,
          dirPath,
          frames: frames.map((f) => ({ id: f.id, filename: f.filename })),
          invert: roll?.rollEdit.invert ?? false,
          maxPx: Math.min(pipeline?.maxTextureDimension ?? 8192, PREVIEW_MAX_PX),
        });
      }
    }

    load().catch((err: unknown) => {
      renderError = err instanceof Error ? err.message : String(err);
      loading = false;
    });
  });

  // ─── Re-render whenever pipeline + image are both ready ──────────────────

  $effect(() => {
    if (
      pipeline &&
      (currentBitmap || currentRawBuffer || currentDecodedBuffer) &&
      roll &&
      frame &&
      !loading
    ) {
      renderFrame();
    }
  });

  // ─── Re-render whenever the effective edit changes ────────────────────────

  /**
   * Render `editOverride`, or the committed edit. While horizon mode is
   * active the committed edit is shown in the horizon analysis view so that
   * resizes and slider tweaks keep the canvas aligned with the line overlay.
   * Resolves once the GPU work is submitted; never rejects (errors land in
   * `renderError`).
   */
  function renderFrame(editOverride?: EffectiveEdit): Promise<void> {
    if (!pipeline || !roll || !frame) return Promise.resolve();
    const edit =
      editOverride ??
      (horizonActive
        ? horizonViewEdit(resolveEdit(roll, frame), horizonPreviewAngle)
        : resolveEdit(roll, frame));
    const fid = frame.id;
    const p = pipeline;
    let job: Promise<void>;
    if (currentRawBuffer) {
      console.debug(
        "[frame] renderFrame: RAW path, byteLength =",
        currentRawBuffer.byteLength,
      );
      job = p.renderRaw(edit, currentRawBuffer);
    } else if (currentDecodedBuffer) {
      console.debug(
        "[frame] renderFrame: decoded RGBA path, byteLength =",
        currentDecodedBuffer.byteLength,
      );
      job = p.renderDecodedRgba(edit, currentDecodedBuffer);
    } else if (currentBitmap) {
      console.debug(
        "[frame] renderFrame: JPEG path, bitmap =",
        currentBitmap.width,
        "x",
        currentBitmap.height,
      );
      job = p.render(edit, currentBitmap);
    } else {
      console.warn("[frame] renderFrame called but no image data available");
      return Promise.resolve();
    }
    return job
      .then(() => {
        // Capture histogram from lastLogPerc after render completes
        currentHistogram = p.lastLogPerc?.histograms ?? null;
        paintedFrameId = fid;
        // Persist log percentiles so batch export can match this preview.
        persistLogPerc();
      })
      .catch((err: unknown) => {
        console.error("[frame] render error:", err);
        renderError = err instanceof Error ? err.message : String(err);
      });
  }

  /**
   * Persist the pipeline's current log percentiles onto the frame record so
   * batch export can reproduce the exact same normalization.  Only writes if
   * the values actually changed (avoids IDB churn on every render).
   */
  function persistLogPerc(): void {
    const lp = pipeline?.lastLogPerc;
    if (!lp || !frame) return;
    const cached: CachedLogPercentiles = {
      floors: lp.floors,
      ceils: lp.ceils,
      autoExposure: lp.autoExposure,
    };
    // Skip if unchanged.
    const prev = frame.cachedLogPerc;
    if (
      prev &&
      prev.floors[0] === cached.floors[0] &&
      prev.floors[1] === cached.floors[1] &&
      prev.floors[2] === cached.floors[2] &&
      prev.ceils[0] === cached.ceils[0] &&
      prev.ceils[1] === cached.ceils[1] &&
      prev.ceils[2] === cached.ceils[2] &&
      prev.autoExposure === cached.autoExposure
    ) {
      return;
    }
    frame.cachedLogPerc = cached;
    putFrame(structuredClone($state.snapshot(frame))).catch((err: unknown) => {
      console.error("[frame] persistLogPerc failed:", err);
    });
  }

  // ─── WB picker ────────────────────────────────────────────────────────────

  /** When true the canvas cursor changes to crosshair and the next click samples a pixel. */
  let wbPickerActive = $state(false);

  /**
   * CMY_MAX_DENSITY from pipeline.ts — the scale factor for CMY slider units to
   * log-density. Must stay in sync with the constant in pipeline.ts.
   */
  const CMY_MAX_DENSITY = 0.15;

  function toggleWbPicker(): void {
    wbPickerActive = !wbPickerActive;
  }

  function cancelWbPicker(): void {
    wbPickerActive = false;
  }

  // ─── Crop mode ────────────────────────────────────────────────────────────
  //
  // Non-destructive workflow:
  // - While in crop mode: show the FULL uncropped canvas, overlay shows crop region
  // - User drags handles to position the crop (only updates overlay, no saves)
  // - On exit: save the crop position AND apply it (resize canvas)
  // - Re-entering crop mode: show full canvas again for adjustment

  /** When true, the crop overlay is visible and editable. */
  let cropModeActive = $state(false);

  /** When true, the crop overlay is in perspective-correction mode. */
  let perspectiveActive = $state(false);

  /** When true, user is dragging the fine rotation slider — show denser alignment grid. */
  let fineRotating = $state(false);

  /** Local crop quad state while editing (not yet committed to frame). */
  let localCropQuad = $state<CropQuad | null>(null);

  /** Selected crop aspect-ratio lock while editing (null = free-form). */
  let cropAspect = $state<CropAspect>(null);

  /** Effective crop quad for the overlay: local state while editing, otherwise from frame. */
  const effectiveCropQuad = $derived.by(() => {
    if (localCropQuad) return localCropQuad;
    if (!frame || !roll) return DEFAULT_CROP_QUAD;
    return resolveEdit(roll, frame).cropQuad ?? DEFAULT_CROP_QUAD;
  });

  /**
   * Render the canvas without crop applied (for crop mode editing).
   * Keeps transforms (rotation/flip) active so user sees the final orientation
   * while editing the crop. The CropOverlay transforms coordinates to/from
   * original image space.
   *
   * The matting border is also disabled here: it grows the output around the
   * photo, so leaving it on would make the crop overlay (which maps 0–1 over
   * the whole canvas) appear to crop into the border. The committed border is
   * restored when crop mode exits and renderFrame() runs normally.
   */
  function renderUncropped(): void {
    if (!pipeline || !roll || !frame) return;
    const edit = resolveEdit(roll, frame);
    // Render with cropQuad = null but KEEP transforms.
    // Disable the border so the overlay aligns with the photo content.
    // The crop overlay will transform its coordinates to match.
    renderFrame({
      ...edit,
      cropQuad: null,
      inversionParams: { ...edit.inversionParams, borderWidth: 0 },
    });
  }

  function toggleCropMode(): void {
    if (cropModeActive) {
      // Exiting crop mode — commit and apply the crop
      commitCropAndExit();
    } else {
      // Entering crop mode — show full uncropped image
      cropModeActive = true;
      perspectiveActive = false;
      // Start each crop session free-form.
      cropAspect = null;
      // Initialize local quad from saved state (or default if none)
      if (frame && roll) {
        localCropQuad = resolveEdit(roll, frame).cropQuad ?? DEFAULT_CROP_QUAD;
      } else {
        localCropQuad = DEFAULT_CROP_QUAD;
      }
      renderUncropped();
    }
  }

  function togglePerspective(): void {
    perspectiveActive = !perspectiveActive;
  }

  /**
   * Commit the current crop position to IDB and exit crop mode.
   * This is the only place where crop is saved and applied.
   */
  function commitCropAndExit(): void {
    if (!frame || !roll) {
      cropModeActive = false;
      localCropQuad = null;
      return;
    }

    const quad = localCropQuad ?? DEFAULT_CROP_QUAD;

    // Check if the quad is effectively the identity (full image, no crop)
    const isIdentity =
      quad.tl.x === 0 &&
      quad.tl.y === 0 &&
      quad.tr.x === 1 &&
      quad.tr.y === 0 &&
      quad.br.x === 1 &&
      quad.br.y === 1 &&
      quad.bl.x === 0 &&
      quad.bl.y === 1;

    // Store null for identity crop to save space and indicate "no crop"
    const cropToStore = isIdentity ? null : quad;

    // Update frame state
    const snap = $state.snapshot(frame) as Frame;
    const updatedEdit: FrameEditOverrides = {
      ...snap.frameEdit,
      cropQuad: cropToStore,
    };
    frame = { ...snap, frameEdit: updatedEdit };

    // Exit crop mode
    cropModeActive = false;
    perspectiveActive = false;
    localCropQuad = null;

    // Re-render with the crop applied
    renderFrame();

    // Save to IDB + push history
    const s = $state.snapshot(frame) as Frame;
    historyPush(
      structuredClone(s.frameEdit) as FrameEditOverrides,
      $state.snapshot(roll).rollEdit as RollEditParams,
    );
    putFrame(structuredClone(s)).catch((err: unknown) => {
      console.error("[crop] putFrame failed:", err);
    });
  }

  /**
   * Live update while dragging a crop corner.
   * Only updates the overlay position — does NOT save or re-render.
   * The canvas stays showing the full uncropped image.
   */
  function onCropChange(quad: CropQuad): void {
    localCropQuad = quad;
  }

  /**
   * Cancel crop mode without saving changes.
   * Reverts to the previously saved crop and re-renders.
   */
  function cancelCrop(): void {
    cropModeActive = false;
    perspectiveActive = false;
    localCropQuad = null;
    // Re-render with the previously saved crop (not the local edits)
    renderFrame();
  }

  /**
   * Sample a pixel from the last rendered output via GPU readback, treat it as
   * the white/neutral point, and adjust the global CMY sliders accordingly.
   *
   * Uses pipeline.readPixels() which copies from the rgba8unorm output texture —
   * the only reliable readback path for WebGPU canvases in Tauri.
   */
  function handleWbPickerClick(e: MouseEvent): void {
    if (!wbPickerActive || !canvasEl || !pipeline) return;

    // Map pointer coords (CSS px) to readback-texture pixel coords.
    // The canvas backing store is sized to the display box, but readPixels()
    // reads the full-resolution readback texture, so scale against that.
    const rect = canvasEl.getBoundingClientRect();
    const readW = pipeline.lastOutputWidth;
    const readH = pipeline.lastOutputHeight;
    if (readW === 0 || readH === 0) return;
    const scaleX = readW / rect.width;
    const scaleY = readH / rect.height;
    const px = Math.round((e.clientX - rect.left) * scaleX);
    const py = Math.round((e.clientY - rect.top) * scaleY);

    wbPickerActive = false;

    // Capture frame/roll refs before entering async context.
    if (!frame || !roll) return;
    const currentFrame = frame;
    const currentRoll = roll;

    // Sample a 3×3 neighbourhood centred on the click to reduce noise.
    const sampleSize = 3;
    const half = Math.floor(sampleSize / 2);
    const x0 = Math.max(0, px - half);
    const y0 = Math.max(0, py - half);
    const w = Math.min(sampleSize, readW - x0);
    const h = Math.min(sampleSize, readH - y0);

    pipeline
      .readPixels(x0, y0, w, h)
      .then((pixels) => {
        if (!pixels) return;
        const n = w * h;

        let sumR = 0,
          sumG = 0,
          sumB = 0;
        for (let i = 0; i < n; i++) {
          sumR += pixels[i * 4];
          sumG += pixels[i * 4 + 1];
          sumB += pixels[i * 4 + 2];
        }

        const r = Math.max(sumR / n / 255, 1e-6);
        const g = Math.max(sumG / n / 255, 1e-6);
        const b = Math.max(sumB / n / 255, 1e-6);

        // Ignore near-black samples — not useful as a white reference.
        if (r < 1e-4 && g < 1e-4 && b < 1e-4) return;

        const current = resolveEdit(currentRoll, currentFrame).inversionParams;

        // Negpy algorithm (calculate_wb_shifts / _handle_wb_pick):
        //   Red is the anchor channel — cyan is always reset to 0.
        //   Magenta delta = log10(g/r) / CMY_MAX_DENSITY
        //   Yellow  delta = log10(b/r) / CMY_MAX_DENSITY
        //   A damping factor of 0.4 prevents overcorrection on the first click.
        const DAMPING = 0.4;
        const deltaMagenta = (Math.log10(g / r) / CMY_MAX_DENSITY) * DAMPING;
        const deltaYellow = (Math.log10(b / r) / CMY_MAX_DENSITY) * DAMPING;

        const clamp = (v: number): number => Math.max(-1, Math.min(1, v));

        saveEdit({
          inversionParams: {
            ...current,
            cmyCyan: 0,
            cmyMagenta: clamp(current.cmyMagenta + deltaMagenta),
            cmyYellow: clamp(current.cmyYellow + deltaYellow),
          },
        });
      })
      .catch((err: unknown) => {
        console.error("[wb-picker] readPixels failed:", err);
      });
  }

  // ─── Edit helpers ──────────────────────────────────────────────────────────

  async function saveEdit(patch: Partial<FrameEditOverrides>): Promise<void> {
    if (!frame || !roll) return;
    const snap = $state.snapshot(frame) as Frame;
    const updatedEdit: FrameEditOverrides = { ...snap.frameEdit, ...patch };
    const updated: Frame = { ...snap, frameEdit: updatedEdit };
    // Push the *new* state onto history before mutating reactive state.
    historyPush(
      structuredClone(updatedEdit),
      $state.snapshot(roll).rollEdit as RollEditParams,
    );
    frame = updated;
    await putFrame(structuredClone(updated));
    renderFrame();
  }

  async function saveRollEdit(patch: Partial<RollEditParams>): Promise<void> {
    if (!roll || !frame) return;
    const snap = $state.snapshot(roll) as Roll;
    const updatedRollEdit: RollEditParams = { ...snap.rollEdit, ...patch };
    const updatedRoll: Roll = { ...snap, rollEdit: updatedRollEdit };
    roll = updatedRoll;
    // Push the *new* state onto history before mutating reactive state.
    historyPush(
      $state.snapshot(frame).frameEdit as FrameEditOverrides,
      structuredClone(updatedRollEdit),
    );
    await updateRoll(structuredClone(updatedRoll));
    renderFrame();
  }

  function onWBChange(wb: WhiteBalance): void {
    saveEdit({ whiteBalance: wb });
  }

  /**
   * Live preview while dragging an inversion slider.
   * Renders the GPU canvas immediately with patched params — zero reactive
   * state mutations, zero IDB writes, zero Svelte re-renders.
   */
  function onInversionChange(params: InversionParams): void {
    if (!roll || !frame) return;
    const edit = resolveEdit(roll, frame);
    renderFrame({ ...edit, inversionParams: params });
  }

  /** 500ms debounce handle — coalesces rapid commits into one IDB write + history entry. */
  let inversionCommitTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Apply inversion params immediately (updates frame state + GPU render),
   * then debounce the IDB write + history push by 500ms so rapid changes
   * (key-hold, quick taps) coalesce into a single undo entry.
   */
  function onInversionCommit(params: InversionParams): void {
    if (!frame || !roll) return;
    // Apply immediately — update frame state so sliders and derived values
    // reflect the new value right away, without waiting for the IDB write.
    const snap = $state.snapshot(frame) as Frame;
    frame = {
      ...snap,
      frameEdit: { ...snap.frameEdit, inversionParams: params },
    };
    // Re-render from the now-updated frame state.
    renderFrame();
    // Debounce the expensive work: IDB write + history push.
    if (inversionCommitTimer !== null) clearTimeout(inversionCommitTimer);
    inversionCommitTimer = setTimeout(() => {
      inversionCommitTimer = null;
      if (!frame || !roll) return;
      const s = $state.snapshot(frame) as Frame;
      historyPush(
        structuredClone(s.frameEdit) as FrameEditOverrides,
        $state.snapshot(roll).rollEdit as RollEditParams,
      );
      putFrame(structuredClone(s)).catch((err: unknown) => {
        console.error("[inversion] putFrame failed:", err);
      });
    }, 500);
  }

  // ─── Transform handlers ───────────────────────────────────────────────────

  // ─── Fine-tune helpers (Filmomat keyboard layout) ─────────────────────────

  /**
   * Nudge a single inversion parameter by `delta`, clamped to [min, max].
   * When `shift` is true the delta is multiplied by 10 for quicker coarse iteration.
   * Applies immediately via onInversionCommit (instant frame state update +
   * GPU render) with debounced IDB persist.
   */
  function nudgeInversion(
    key: keyof InversionParams,
    delta: number,
    min: number,
    max: number,
    shift: boolean = false,
  ): void {
    if (!roll || !frame) return;
    // Always read from current frame state — it is updated immediately on
    // every nudge so successive taps accumulate correctly.
    const current = effectiveInversionParams;
    const raw = (current[key] as number) + delta * (shift ? 10 : 1);
    const clamped = Math.round(Math.min(max, Math.max(min, raw)) * 1000) / 1000;
    onInversionCommit({ ...current, [key]: clamped });
  }

  type Channel = "global" | "r" | "g" | "b";

  /**
   * Live preview while dragging a curve control point.
   * Renders the GPU canvas immediately with patched curves — zero reactive
   * state mutations, zero IDB writes, zero Svelte re-renders.
   */
  function onCurveChange(channel: Channel, curve: CurvePoints): void {
    if (!roll || !frame) return;
    const edit = resolveEdit(roll, frame);
    if (channel === "global") {
      renderFrame({ ...edit, toneCurve: curve });
    } else {
      const existing = edit.rgbCurves;
      const updated: [CurvePoints, CurvePoints, CurvePoints] = [
        existing[0],
        existing[1],
        existing[2],
      ];
      if (channel === "r") updated[0] = curve;
      else if (channel === "g") updated[1] = curve;
      else updated[2] = curve;
      renderFrame({ ...edit, rgbCurves: updated });
    }
  }

  /** 500ms debounce handle — coalesces rapid curve commits into one IDB write + history entry. */
  let curveCommitTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Commit a curve change: update frame state immediately so derived
   * values reflect the new curve, then debounce the IDB write + history push
   * so rapid add/remove/reset actions coalesce into a single undo entry.
   */
  function onCurveCommit(channel: Channel, curve: CurvePoints): void {
    if (!frame || !roll) return;
    const snap = $state.snapshot(frame) as Frame;

    let patch: Partial<FrameEditOverrides>;
    if (channel === "global") {
      patch = { toneCurve: curve };
    } else {
      const existing =
        snap.frameEdit.rgbCurves ??
        (roll ? [...roll.rollEdit.baseRGBCurves] : null);
      if (!existing) return;
      const updated: [CurvePoints, CurvePoints, CurvePoints] = [
        existing[0],
        existing[1],
        existing[2],
      ];
      if (channel === "r") updated[0] = curve;
      else if (channel === "g") updated[1] = curve;
      else updated[2] = curve;
      patch = { rgbCurves: updated };
    }

    // Apply immediately — update frame state so curves and derived values
    // reflect the new value right away, without waiting for the IDB write.
    const updatedEdit: FrameEditOverrides = { ...snap.frameEdit, ...patch };
    frame = { ...snap, frameEdit: updatedEdit };
    // Re-render from the now-updated frame state.
    renderFrame();

    // Debounce the expensive work: IDB write + history push.
    if (curveCommitTimer !== null) clearTimeout(curveCommitTimer);
    curveCommitTimer = setTimeout(() => {
      curveCommitTimer = null;
      if (!frame || !roll) return;
      const s = $state.snapshot(frame) as Frame;
      historyPush(
        structuredClone(s.frameEdit) as FrameEditOverrides,
        $state.snapshot(roll).rollEdit as RollEditParams,
      );
      putFrame(structuredClone(s)).catch((err: unknown) => {
        console.error("[curves] putFrame failed:", err);
      });
    }, 500);
  }

  // ─── Transform handlers ───────────────────────────────────────────────────

  /**
   * Live preview while adjusting transform (rotation, flip).
   * Renders the GPU canvas immediately with patched transform.
   */
  function onTransformChange(params: TransformParams): void {
    if (!roll || !frame) return;
    const edit = resolveEdit(roll, frame);
    renderFrame({ ...edit, transform: params });
  }

  /** 500ms debounce handle for transform commits. */
  let transformCommitTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Commit transform changes: update frame state immediately, then
   * debounce IDB write + history push.
   */
  function onTransformCommit(params: TransformParams): void {
    if (!frame || !roll) return;
    const snap = $state.snapshot(frame) as Frame;
    frame = {
      ...snap,
      frameEdit: { ...snap.frameEdit, transform: params },
    };
    renderFrame();

    if (transformCommitTimer !== null) clearTimeout(transformCommitTimer);
    transformCommitTimer = setTimeout(() => {
      transformCommitTimer = null;
      if (!frame || !roll) return;
      const s = $state.snapshot(frame) as Frame;
      historyPush(
        structuredClone(s.frameEdit) as FrameEditOverrides,
        $state.snapshot(roll).rollEdit as RollEditParams,
      );
      putFrame(structuredClone(s)).catch((err: unknown) => {
        console.error("[transform] putFrame failed:", err);
      });
    }, 500);
  }

  // ─── Horizon detection mode ───────────────────────────────────────────────
  //
  // Auto-straighten workflow:
  // 1. User clicks "Auto" in TransformControls.
  // 2. The frame is rendered in the analysis view — current 90° step only
  //    (fine rotation zeroed), no crop, no matte — and read back. Zeroing the
  //    fine rotation keeps clamped corner smear and the matte's straight edges
  //    out of the analysis and makes the detected angle absolute.
  // 3. Straight lines are detected (inside the saved crop, if any) and shown
  //    as an overlay; the best one is previewed by rotating the analysis view.
  // 4. Click / ←→ picks another line; Enter/Apply commits base + angle,
  //    Esc/Cancel restores the committed edit.

  /** Detection is running (Auto button spinner). */
  let detectingHorizon = $state(false);

  /** Horizon mode owns the canvas: from detection start until apply/cancel. */
  let horizonActive = $state(false);

  /** Detected horizon/vertical line candidates, best first. */
  let horizonCandidates = $state<HorizonCandidate[]>([]);

  /** Currently selected candidate index (previewed on the canvas). */
  let selectedHorizonIndex = $state<number | null>(null);

  /** Rotation the analysis view was rendered with: the committed 90° step. */
  let horizonBaseRotation = $state(0);

  /** Inline feedback when detection finds nothing usable. */
  let horizonNotice = $state<string | null>(null);
  let horizonNoticeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Whether the horizon overlay is showing candidates. */
  const horizonModeActive = $derived(horizonCandidates.length > 0);

  /** Rotation delta of the previewed candidate (0 while detecting). */
  const horizonPreviewAngle = $derived(
    selectedHorizonIndex === null
      ? 0
      : (horizonCandidates[selectedHorizonIndex]?.angle ?? 0),
  );

  /** Cover-zoom growth of the preview vs the (90°-step) analysis render. */
  const horizonPreviewScale = $derived(
    rotationCoverZoom(
      horizonBaseRotation + horizonPreviewAngle,
      originalWidth / originalHeight,
    ) / rotationCoverZoom(horizonBaseRotation, originalWidth / originalHeight),
  );

  /** The analysis view of `edit`, rotated `delta` degrees past the 90° base. */
  function horizonViewEdit(edit: EffectiveEdit, delta: number): EffectiveEdit {
    return {
      ...edit,
      cropQuad: null,
      inversionParams: { ...edit.inversionParams, borderWidth: 0 },
      transform: { ...edit.transform, rotation: horizonBaseRotation + delta },
    };
  }

  function exitHorizonMode(): void {
    horizonActive = false;
    horizonCandidates = [];
    selectedHorizonIndex = null;
  }

  function showHorizonNotice(message: string): void {
    horizonNotice = message;
    if (horizonNoticeTimer !== null) clearTimeout(horizonNoticeTimer);
    horizonNoticeTimer = setTimeout(() => {
      horizonNotice = null;
      horizonNoticeTimer = null;
    }, 2500);
  }

  /**
   * Render the analysis view, read it back and detect line candidates.
   */
  async function startHorizonDetection(): Promise<void> {
    if (!pipeline || !roll || !frame || horizonActive) return;
    if (cropModeActive) commitCropAndExit();
    wbPickerActive = false;
    horizonNotice = null;

    const p = pipeline;
    const fid = frame.id;
    const edit = resolveEdit(roll, frame);
    horizonBaseRotation = Math.round(edit.transform.rotation / 90) * 90;
    horizonCandidates = [];
    selectedHorizonIndex = null;
    horizonActive = true;
    detectingHorizon = true;

    try {
      await renderFrame();
      // Navigation or cancel while rendering invalidates this run.
      if (!horizonActive || frame?.id !== fid) return;

      const w = p.lastOutputWidth;
      const h = p.lastOutputHeight;
      const pixels = await p.readPixels(0, 0, w, h);
      if (!horizonActive || frame?.id !== fid) return;

      let candidates: HorizonCandidate[] = [];
      if (pixels) {
        // Analyse only what the saved crop keeps — this also leaves film
        // rebate and holder edges out when the frame has been cropped.
        const q = edit.cropQuad;
        const region = q
          ? {
              x: Math.min(q.tl.x, q.bl.x),
              y: Math.min(q.tl.y, q.tr.y),
              w: Math.max(q.tr.x, q.br.x) - Math.min(q.tl.x, q.bl.x),
              h: Math.max(q.bl.y, q.br.y) - Math.min(q.tl.y, q.tr.y),
            }
          : null;
        candidates = detectHorizonCandidates(
          { data: pixels, width: w, height: h },
          { region },
        );
      } else {
        console.error("[horizon] readPixels returned no data");
      }

      if (candidates.length === 0) {
        exitHorizonMode();
        showHorizonNotice("No straight horizon or vertical found");
        await renderFrame();
        return;
      }

      horizonCandidates = candidates;
      onHorizonSelect(0);
    } finally {
      detectingHorizon = false;
    }
  }

  /** Select a candidate and preview its rotation. */
  function onHorizonSelect(index: number): void {
    if (!horizonCandidates[index]) return;
    selectedHorizonIndex = index;
    void renderFrame();
  }

  /** Commit base + selected angle as the frame rotation. */
  function onHorizonApply(): void {
    const candidate =
      selectedHorizonIndex === null
        ? undefined
        : horizonCandidates[selectedHorizonIndex];
    if (!candidate) return;
    // Hundredths are well below what the fine slider (0.1° steps) can show.
    const rotation =
      Math.round((horizonBaseRotation + candidate.angle) * 100) / 100;
    exitHorizonMode();
    onTransformCommit({ ...effectiveTransform, rotation });
  }

  /** Leave horizon mode and restore the committed edit. */
  function onHorizonCancel(): void {
    exitHorizonMode();
    void renderFrame();
  }

  // ─── Export ────────────────────────────────────────────────────────────────

  /** Export scale factor: 0.25, 0.5, or 1 (default). */
  let exportScale = $state<0.25 | 0.5 | 1>(1);

  /**
   * Export the current frame as a full-quality JPEG.
   *
   * Hands off to the global background-jobs queue (same path as batch export
   * from the roll page): the file is written to `<rollDir>/exports/` at quality
   * 100, and progress/results surface in the app-wide BackgroundJobsDock rather
   * than inline here.  RAW frames go through `export_native`; JPEG/TIFF/PNG go
   * through `export_image_native` — both at full source resolution.
   *
   * Cached log percentiles (persisted after each preview render) are reused so
   * the export matches what the user sees in the editor.
   */
  async function exportFrame(): Promise<void> {
    if (!frame || !roll) return;

    const dirPath = await getRollPath(rollId);
    if (!dirPath) {
      console.error("[frame] export: roll source directory not found.");
      return;
    }

    startExport({
      rollId,
      rollLabel: roll.label,
      roll,
      frames: [frame],
      dirPath,
      scale: exportScale,
    });
  }

  // ─── Navigation ────────────────────────────────────────────────────────────

  function navigateTo(idx: number): void {
    const target = frames[idx];
    if (!target) return;
    goto(`/roll/${rollId}/frame/${target.id}`);
  }

  /** Throttle map: last timestamp each hotkey was processed (ms). */
  const keyLastFired = new Map<string, number>();
  const KEY_THROTTLE_MS = 150;

  async function handleKeydown(e: KeyboardEvent): Promise<void> {
    const el = e.target as HTMLElement | null;
    const tag = el?.tagName;
    if (tag === "TEXTAREA") return;
    if (tag === "INPUT") {
      const inputType = (el as HTMLInputElement).type;
      if (inputType !== "range") return;
      // For range inputs, block only the keys that move the slider vertically
      // or jump to endpoints — ArrowLeft/Right are reserved for frame navigation.
      const rangeNativeKeys = new Set([
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
        "PageUp",
        "PageDown",
      ]);
      if (rangeNativeKeys.has(e.key)) return;
    }

    // Horizon mode: Esc/Enter resolve it, arrows cycle candidates instead of
    // navigating frames.
    if (horizonModeActive) {
      const n = horizonCandidates.length;
      const step =
        e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "j"
          ? 1
          : e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "k"
            ? -1
            : 0;
      if (e.key === "Escape") {
        e.preventDefault();
        onHorizonCancel();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        onHorizonApply();
        return;
      }
      if (step !== 0) {
        e.preventDefault();
        onHorizonSelect(((selectedHorizonIndex ?? 0) + step + n) % n);
        return;
      }
    }

    // Undo / redo — intercept before other single-key shortcuts.
    if (e.key === "z" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (e.shiftKey) {
        await redo();
      } else {
        await undo();
      }
      return;
    }
    if (e.key === "y" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      await redo();
      return;
    }

    switch (e.key) {
      // ── Filmomat-style color controls ──────────────────────────────────
      // Top row (Q–Y) = positive nudges; bottom row (A–H) = negative nudges.
      // Q/A → Cyan  |  W/S → Magenta  |  E/D → Yellow
      // R/F → Grade  |  T/G → Density
      // Hold Shift for 10× step.
      case "q":
      case "Q":
      case "a":
      case "A":
      case "w":
      case "W":
      case "s":
      case "S":
      case "e":
      case "E":
      case "d":
      case "D":
      case "r":
      case "R":
      case "f":
      case "F":
      case "t":
      case "T":
      case "g":
      case "G": {
        // Ignore when system modifiers are held (e.g. ⌘Q should quit, not nudge).
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        // Throttle nudge keys to KEY_THROTTLE_MS to prevent runaway key-repeat.
        const k = e.key.toLowerCase();
        const now = performance.now();
        if (now - (keyLastFired.get(k) ?? 0) < KEY_THROTTLE_MS) return;
        keyLastFired.set(k, now);
        e.preventDefault();
        switch (k) {
          case "q":
            nudgeInversion("cmyCyan", +0.01, -1, 1, e.shiftKey);
            break;
          case "a":
            nudgeInversion("cmyCyan", -0.01, -1, 1, e.shiftKey);
            break;
          case "w":
            nudgeInversion("cmyMagenta", +0.01, -1, 1, e.shiftKey);
            break;
          case "s":
            nudgeInversion("cmyMagenta", -0.01, -1, 1, e.shiftKey);
            break;
          case "e":
            nudgeInversion("cmyYellow", +0.01, -1, 1, e.shiftKey);
            break;
          case "d":
            nudgeInversion("cmyYellow", -0.01, -1, 1, e.shiftKey);
            break;
          case "r":
            nudgeInversion("grade", +0.125, 0, 5, e.shiftKey);
            break;
          case "f":
            nudgeInversion("grade", -0.125, 0, 5, e.shiftKey);
            break;
          case "t":
            nudgeInversion("density", +0.05, -3, 5, e.shiftKey);
            break;
          case "g":
            nudgeInversion("density", -0.05, -3, 5, e.shiftKey);
            break;
        }
        break;
      }
      // ── Frame navigation ───────────────────────────────────────────────
      case "ArrowLeft":
      case "k":
        e.preventDefault();
        if (hasPrev) navigateTo(frameIndex - 1);
        break;
      case "ArrowRight":
      case "j":
        e.preventDefault();
        if (hasNext) navigateTo(frameIndex + 1);
        break;
      case "c":
      case "C":
        // Toggle crop mode (unless modifier keys are held)
        if (!e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          toggleCropMode();
        }
        break;
      case "Escape":
        e.preventDefault();
        if (cropModeActive) {
          cancelCrop();
        } else if (wbPickerActive) {
          cancelWbPicker();
        } else {
          goto(`/?roll=${encodeURIComponent(rollId)}`);
        }
        break;
      case "Enter":
        if (cropModeActive) {
          e.preventDefault();
          commitCropAndExit();
        }
        break;
    }
  }

  // ─── Derived edit values for controls ─────────────────────────────────────

  /** Effective WB for the controls (frame override or roll default). */
  const effectiveWB = $derived.by(() => {
    if (!frame || !roll) return { temperature: 5500, tint: 0 };
    return resolveEdit(roll, frame).whiteBalance;
  });

  const effectiveToneCurve = $derived.by(() => {
    if (!frame || !roll)
      return {
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
      };
    return resolveEdit(roll, frame).toneCurve;
  });

  const effectiveRGBCurves = $derived.by(() => {
    const identity = {
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
    };
    const fallback: [typeof identity, typeof identity, typeof identity] = [
      identity,
      identity,
      identity,
    ];
    if (!frame || !roll) return fallback;
    const curves = resolveEdit(roll, frame).rgbCurves;
    // Guard against old DB records or transient undo state where baseRGBCurves
    // may be undefined or a partial array.
    if (!Array.isArray(curves) || curves.length < 3) return fallback;
    return curves as [typeof identity, typeof identity, typeof identity];
  });

  const effectiveInversionParams = $derived.by(() => {
    if (!frame || !roll) return DEFAULT_INVERSION_PARAMS;
    return resolveEdit(roll, frame).inversionParams;
  });

  const effectiveTransform = $derived.by(() => {
    if (!frame || !roll) return DEFAULT_TRANSFORM;
    return resolveEdit(roll, frame).transform;
  });

  const frameLabel = $derived(frame ? `Frame ${frame.index}` : "Frame");
</script>

<svelte:head>
  <title>{frameLabel} — {roll?.label ?? "Roll"} — Rolloc</title>
</svelte:head>

<svelte:window onkeydown={handleKeydown} />

{#snippet errorState(title: string, message: string)}
  <div
    class="absolute inset-0 flex flex-col items-center justify-center gap-sm text-center px-l
           bg-base-muted animate-fadein"
  >
    <WarningIcon size={40} weight="thin" class="mb-xs text-content-subtle" />
    <h2 class="text-l font-semibold text-content">{title}</h2>
    <p class="max-w-96 text-sm text-content-muted text-balance wrap-break-word">{message}</p>
    <a
      href="/?roll={encodeURIComponent(rollId)}"
      class="mt-sm flex items-center gap-xs px-sm py-xs rounded-md text-sm text-content-muted
             hover:text-content hover:bg-base transition-[color,background-color,transform]
             duration-150 ease-out active:scale-[0.97]"
    >
      <ArrowLeftIcon size={14} />
      Back to roll
    </a>
  </div>
{/snippet}

<div class="h-screen bg-base text-content flex flex-col overflow-hidden">
  <!-- ── Top bar ──────────────────────────────────────────────────────────── -->
  <header
    class="shrink-0 flex items-center gap-sm px-l h-12 border-b border-base-subtle"
  >
    <a
      href="/?roll={encodeURIComponent(rollId)}"
      class="-ml-xs flex items-center gap-xs min-w-0 max-w-64 px-xs py-xs rounded-md text-sm
             text-content-muted hover:text-content hover:bg-base-muted
             transition-[color,background-color,transform] duration-150 ease-out
             active:scale-[0.97]"
    >
      <ArrowLeftIcon size={16} class="shrink-0" />
      <span class="truncate">{roll?.label ?? "Roll"}</span>
    </a>

    {#if frame}
      <span class="shrink-0 text-content-subtle">/</span>
      <span class="min-w-0 text-sm text-content font-medium truncate" title={frame.filename}>
        {frame.filename}
      </span>
    {/if}

    <div class="ml-auto flex items-center gap-xs">
      <!-- Undo / redo -->
      <button
        onclick={undo}
        disabled={!canUndo}
        title="Undo (Ctrl+Z)"
        aria-label="Undo"
        class={ICON_BTN}
      >
        <ArrowUUpLeftIcon size={16} />
      </button>
      <button
        onclick={redo}
        disabled={!canRedo}
        title="Redo (Ctrl+Shift+Z)"
        aria-label="Redo"
        class={ICON_BTN}
      >
        <ArrowUUpRightIcon size={16} />
      </button>

      <span class="w-px h-4 mx-xs bg-base-subtle"></span>

      <!-- Frame navigation -->
      <button
        onclick={() => navigateTo(frameIndex - 1)}
        disabled={!hasPrev}
        title="Previous frame (←)"
        aria-label="Previous frame"
        class={ICON_BTN}
      >
        <CaretLeftIcon size={16} />
      </button>
      {#if frames.length > 0 && frameIndex >= 0}
        <span class="text-xs text-content-subtle tabular-nums min-w-12 text-center">
          {frameIndex + 1} / {frames.length}
        </span>
      {/if}
      <button
        onclick={() => navigateTo(frameIndex + 1)}
        disabled={!hasNext}
        title="Next frame (→)"
        aria-label="Next frame"
        class={ICON_BTN}
      >
        <CaretRightIcon size={16} />
      </button>
    </div>
  </header>

  <!-- ── Main editor layout (always mounted so canvas persists) ──────────── -->
  <div class="flex-1 min-h-0 flex overflow-hidden relative">
    <!-- Canvas / preview area — always in DOM so the pipeline stays alive -->
    <div
      bind:this={previewAreaEl}
      class="flex-1 min-w-0 flex items-center justify-center bg-base-muted overflow-hidden p-base relative"
    >
      <!-- Canvas container: flip transforms applied via CSS, rotation via GPU UV remapping.
			     w-full h-full + max-w-fit max-h-fit ensures the wrapper takes the full available
			     space while shrinking to fit the canvas, allowing max-w-full/max-h-full on the
			     canvas to reference the actual container dimensions. -->
      <div
        class="relative w-full h-full max-w-fit max-h-fit flex items-center justify-center"
      >
        <!-- Hidden until the first paint (avoids a blank 300×150 ghost with a
             shadow); dimmed after a short delay while the next frame decodes so
             fast navigations never flicker, and restored quickly once painted. -->
        <canvas
          bind:this={canvasEl}
          onclick={handleWbPickerClick}
          class="block max-w-full max-h-full object-contain rounded shadow-lg
                 transition-opacity ease-out
                 {paintedFrameId === null
            ? 'opacity-0 duration-200'
            : framePending
              ? 'opacity-50 duration-200 delay-200'
              : 'opacity-100 duration-150'}"
          style:cursor={wbPickerActive || cropModeActive ? "crosshair" : "default"}
          style:transform={effectiveTransform.flipH || effectiveTransform.flipV
            ? `scale(${effectiveTransform.flipH ? -1 : 1}, ${effectiveTransform.flipV ? -1 : 1})`
            : undefined}
        ></canvas>

        <!-- Crop overlay (inside transform wrapper so it rotates with canvas) -->
        {#if cropModeActive && canvasEl}
          <CropOverlay
            canvas={canvasEl}
            value={effectiveCropQuad}
            onChange={onCropChange}
            aspectRatio={cropAspect}
            {fineRotating}
            perspective={perspectiveActive}
            onTogglePerspective={togglePerspective}
          />
        {/if}

        <!-- Horizon detection overlay -->
        {#if horizonModeActive && canvasEl}
          <HorizonOverlay
            canvas={canvasEl}
            candidates={horizonCandidates}
            selectedIndex={selectedHorizonIndex}
            previewAngle={horizonPreviewAngle}
            previewScale={horizonPreviewScale}
            flipH={effectiveTransform.flipH}
            flipV={effectiveTransform.flipV}
            onSelect={onHorizonSelect}
            onApply={onHorizonApply}
            onCancel={onHorizonCancel}
          />
        {/if}
      </div>

      <!-- WB picker hint overlay -->
      {#if wbPickerActive}
        <div
          class="absolute bottom-base left-1/2 -translate-x-1/2 flex items-center gap-sm
                 pl-sm pr-xs py-xs rounded-full border border-base-subtle bg-surface/90
                 backdrop-blur-sm text-xs text-content shadow-base pointer-events-none"
          in:fly={{ y: 8, duration: 200, easing: quintOut }}
          out:fade={{ duration: 120 }}
        >
          <EyedropperSampleIcon size={14} weight="duotone" class="shrink-0 text-primary" />
          Click a neutral white or gray area to set color balance
          <button
            class="pointer-events-auto px-sm py-0.5 rounded-full text-content-muted
                   hover:text-content hover:bg-base-subtle
                   transition-[color,background-color,transform] duration-150 ease-out
                   active:scale-95"
            onclick={cancelWbPicker}
            aria-label="Cancel WB picker">Cancel</button
          >
        </div>
      {/if}

      <!-- Auto-straighten found nothing -->
      {#if horizonNotice}
        <div
          role="status"
          class="absolute bottom-base left-1/2 -translate-x-1/2 flex items-center gap-xs
                 px-sm py-xs rounded-full border border-base-subtle bg-surface/90
                 backdrop-blur-sm text-xs text-content shadow-base pointer-events-none"
          in:fly={{ y: 8, duration: 200, easing: quintOut }}
          out:fade={{ duration: 120 }}
        >
          <WarningIcon size={14} class="shrink-0 text-content-muted" />
          {horizonNotice}
        </div>
      {/if}

      <!-- Decode indicator — delayed so cached/fast decodes never show it -->
      {#if showSpinner}
        <div class="absolute inset-0 grid place-items-center pointer-events-none">
          <div
            role="status"
            class="flex items-center gap-xs px-sm py-xs rounded-full border border-base-subtle
                   bg-surface/80 backdrop-blur-sm text-xs text-content-muted shadow-base
                   animate-[fadein_200ms_ease-out_250ms_both]"
          >
            <CircleNotchIcon size={14} class="animate-spin [animation-duration:700ms]" />
            Loading…
          </div>
        </div>
      {/if}

      <!-- Blocking states: GPU missing > render/decode failure > missing frame -->
      {#if gpuError}
        {@render errorState("WebGPU unavailable", gpuError)}
      {:else if renderError}
        {@render errorState("Preview unavailable", renderError)}
      {:else if !loading && (!roll || !frame)}
        {@render errorState("Frame not found", "This frame is no longer part of the roll.")}
      {/if}
    </div>

    <!-- Edit panel sidebar -->
    <aside
      class="w-75 shrink-0 border-l border-base-subtle bg-base
			       overflow-y-auto flex flex-col"
    >
      {#if roll && frame}
        <!-- Export -->
        <SidebarSection>
          <ExportControls
            {exportScale}
            disabled={loading || !pipeline}
            onExport={exportFrame}
            onScaleChange={(s) => (exportScale = s)}
          />
        </SidebarSection>

        <!-- Transform controls (rotation, flip, crop) -->
        <SidebarSection>
          <TransformControls
            value={effectiveTransform}
            onChange={onTransformChange}
            onCommit={onTransformCommit}
            onFineRotateDrag={(dragging) => (fineRotating = dragging)}
            onAutoStraighten={startHorizonDetection}
            {detectingHorizon}
            onToggleCrop={toggleCropMode}
            cropActive={cropModeActive}
            {cropAspect}
            onCropAspectChange={(a) => (cropAspect = a)}
            onTogglePerspective={togglePerspective}
            perspective={perspectiveActive}
          />
        </SidebarSection>

        <!-- NegPy inversion controls (only when invert = true) -->
        <SidebarSection>
          <InversionControls
            value={effectiveInversionParams}
            onChange={onInversionChange}
            onCommit={onInversionCommit}
            {wbPickerActive}
            onToggleWbPicker={toggleWbPicker}
          />
        </SidebarSection>

        <!-- Curves section -->
        <SidebarSection>
          <h3
            class="text-xs font-semibold text-content-muted uppercase tracking-wider mb-sm"
          >
            Curves
          </h3>
          <CurvesEditor
            global={effectiveToneCurve}
            r={effectiveRGBCurves[0]}
            g={effectiveRGBCurves[1]}
            b={effectiveRGBCurves[2]}
            onChange={onCurveChange}
            onCommit={onCurveCommit}
            histogram={currentHistogram}
          />
        </SidebarSection>
      {/if}
    </aside>
  </div>

  <!-- ── Keyboard hint bar ──────────────────────────────────────────────── -->
  <KeyboardHintBar
    hints={[
      { keys: ["←", "→"], label: "navigate" },
      { keys: ["C"], label: "crop" },
      { keys: ["Q–E", "A–D"], label: "+/− CMY" },
      { keys: ["R", "F"], label: "+/− contrast" },
      { keys: ["T", "G"], label: "−/+ brightness" },
      {
        keys: [{ icon: ArrowFatUpIcon, eventKey: "Shift" }],
        label: "10× step",
      },
      {
        keys: [{ icon: CommandIcon, eventKey: ["Meta", "Control"] }, "Z"],
        label: "undo",
      },
      { keys: ["Esc"], label: "back" },
    ]}
  />
</div>
