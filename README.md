# Roloc

A local-first web app for inverting and managing film negative scans.
All data stays on your filesystem — no backend, no login, no cloud.

## What it does

- Point the app at a directory of JPEG/TIFF scans; it creates a **Roll** and generates thumbnails
- Browse frames in a filmstrip grid, add ratings (0–5), pick/reject flags, and notes
- Edit frames with a real-time **WebGPU** render pipeline:
  - Pass 1 — normalise + invert negative (per-channel exposure compensation)
  - Pass 2 — 3×3 camera-to-sRGB colour matrix
  - Pass 3 — tone curve + per-channel RGB curves + gamma encode
- Roll-level edit defaults with per-frame overrides (non-destructive, originals never touched)
- Curves edited via a drag-to-edit SVG control-point editor with monotone cubic spline interpolation

## Stack

- **SvelteKit 2** + **Svelte 5** (runes mode) + **TypeScript** (`strict: true`)
- **Tailwind CSS v4** with semantic `@theme` design tokens (automatic light/dark)
- **WebGPU** shader pipeline (WGSL)
- **IndexedDB** for roll/frame metadata + edit parameters
- **OPFS** for cached thumbnails and previews
- **File System Access API** for read-only access to your scan directory
- No server-side routes — entirely client-side SPA

## Development

```sh
bun install
bun run dev          # dev server on :5173
```

Requires a browser with WebGPU support (Chrome 113+, Edge 113+, Safari 18+).

## Commands

```sh
bun run dev          # Vite dev server
bun run build        # production build
bun run preview      # preview production build

bun run check        # svelte-check + tsc (authoritative — 0 errors required)
bun run check:watch  # watch mode

bun run test         # run all tests (browser + server projects)
bun run test:unit    # vitest interactive mode
```

### Running specific tests

```sh
# single file
bunx vitest run src/lib/db/idb.test.ts

# by name (substring match)
bunx vitest run --reporter=verbose -t "createRoll"

# server project only (pure TS/JS, Node)
bunx vitest run --project server

# browser project only (requires Playwright / Chromium)
bunx vitest run --project client
```

## Project structure

```
src/
  lib/
    types.ts                  # all domain types + resolveEdit()
    db/
      idb.ts                  # low-level IndexedDB wrapper
      rolls.ts                # high-level roll operations
    fs/
      directory.ts            # File System Access API
      opfs.ts                 # OPFS thumb/preview cache
    image/
      pipeline.ts             # WebGPU 3-pass render pipeline
      thumbgen.ts             # OffscreenCanvas → JPEG → OPFS
      curves.ts               # monotone cubic spline → 256-entry LUT
      shaders/
        invert.wgsl
        colormatrix.wgsl
        tonecurve.wgsl
    components/
      CurvesEditor.svelte
      FrameMetaPanel.svelte
      FrameThumb.svelte
      WhiteBalanceControls.svelte
      ...
  routes/
    +page.svelte              # / — roll library
    roll/[id]/
      +page.svelte            # filmstrip grid + metadata panel
      frame/[frameId]/
        +page.svelte          # WebGPU editor
```

See `PLAN.md` for the full phased build plan and current implementation status.

## Type checking note

The in-editor LSP reports stale false-positive errors (known cache artefact).
Always use `bun run check` as the ground truth — if it reports 0 errors the code is correct.
