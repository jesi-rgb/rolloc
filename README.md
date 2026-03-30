# Rolloc

A local-first desktop app for managing and inverting film negative scans.
Built with Tauri + SvelteKit. All data stays on your machine — no backend, no login, no cloud.

## What it does

- Point the app at a directory of scans; it builds a **Roll** with auto-generated thumbnails (via a native Rust/Tauri worker pool)
- Browse frames in a filmstrip grid with virtual scrolling; prefetches neighbours to eliminate flicker
- Inspect EXIF metadata (aperture, shutter, ISO, film simulation, etc.) in a collapsible panel
- RGB histogram per frame
- **Inversion** (NegPy-backed pipeline): normalise → invert → colour matrix → tone/RGB curves → gamma encode
  - Real-time curves editor (drag control points, monotone cubic spline interpolation)
  - White balance controls
  - Per-channel exposure compensation
  - Roll-level defaults with per-frame overrides; originals never written
  - Undo / redo
  - Keyboard shortcuts for common controls
- Export developed frames
- Light / dark theme

## Stack

- **Tauri 2** (Rust backend) + **SvelteKit 2** + **Svelte 5** (runes mode) + **TypeScript** (`strict: true`)
- **Tailwind CSS v4** with semantic `@theme` design tokens
- **IndexedDB** for roll/frame metadata + edit parameters
- **OPFS** for cached thumbnails and previews
- **File System Access API** for read-only access to scan directories
- Native Rust thumbnail generation (image crate, opt-level 3 in debug)

## Development

```sh
bun install
bun run dev          # Vite dev server on :5173 (browser-only mode)
```

For the full Tauri desktop app, install the [Tauri prerequisites](https://tauri.app/start/prerequisites/) then:

```sh
bunx tauri dev
```

## Commands

```sh
bun run dev          # Vite dev server
bun run build        # production web build
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
src-tauri/          # Rust/Tauri backend (thumbnail generation, file I/O)
src/
  lib/
    types.ts        # domain types + resolveEdit()
    db/
      idb.ts        # low-level IndexedDB wrapper
      rolls.ts      # high-level roll operations
    fs/
      directory.ts  # File System Access API
      opfs.ts       # OPFS thumb/preview cache
    image/
      pipeline.ts   # inversion render pipeline
      thumbgen.ts   # OffscreenCanvas → JPEG → OPFS
      thumb-queue.ts / thumb.worker.ts  # worker pool
      curves.ts     # monotone cubic spline → 256-entry LUT
    components/
      CurvesEditor.svelte
      RgbHistogram.svelte
      ExifPanel.svelte
      InversionControls.svelte
      WhiteBalanceControls.svelte
      FrameThumb.svelte / FrameMetaPanel.svelte
      VirtualGrid.svelte
      ...
  routes/
    +page.svelte            # / — roll library
    library/                # library view
    roll/[id]/
      +page.svelte          # filmstrip grid + metadata panel
    raw/                    # raw/inversion editor
```

## Type checking note

The in-editor LSP may report stale false-positive errors (known cache artefact).
Always use `bun run check` as the ground truth — if it reports 0 errors the code is correct.
