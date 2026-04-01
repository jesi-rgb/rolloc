# Rolloc — Agent Guidelines

Reference for agentic coding agents working in this repository.

---

## Project Overview

Rolloc is a **local-first, web-based film negative inversion and photo management app**.
Stack: SvelteKit 2 + Svelte 5 + TypeScript, Tailwind CSS v4, Vitest, WebGPU (Phase 3+).
No backend, no auth, no cloud. All user data stays on the local filesystem.
See `PLAN.md` for the full phased build plan — it is the source of truth for scope.

---

## Commands

```bash
# Development
bun run dev            # Vite dev server on :5173

# Type checking (authoritative — always run this, not the LSP)
bun run check          # svelte-check + tsc; must report 0 errors, 0 warnings
bun run check:watch    # watch mode

# Tests — two projects: "client" (browser/Playwright) and "server" (Node)
bun run test           # run all tests once (both projects)
bun run test:unit      # vitest interactive mode

# Run a single test file
bunx vitest run src/lib/db/idb.test.ts

# Run a single test by name (substring match)
bunx vitest run --reporter=verbose -t "createRoll"

# Run only the server project
bunx vitest run --project server

# Run only the browser project (requires Playwright / Chromium)
bunx vitest run --project client

# Build
bun run build
bun run preview
```

### Test file conventions
- Server-side (pure TS/JS logic): `src/**/*.{test,spec}.{ts,js}` — NOT ending in `.svelte.test.ts`
- Browser/component tests: `src/**/*.svelte.{test,spec}.{ts,js}`

---

## Type Checking vs LSP

The in-editor LSP in this repo reports **stale false-positive errors** (e.g. `onclick` not
assignable, `$state` used before declaration). These are a known cache artefact from stripping
the original starter template.

**Always use `bun run check` as the ground truth.** If `svelte-check` reports 0 errors, the
code is correct regardless of LSP squiggles.

---

## Code Style

### TypeScript
- **`strict: true`** is enabled. No implicit `any`, no non-null assertions (`!`) except where
  the null case is structurally impossible and noted in a comment.
- Prefer `interface` over `type` for object shapes; use `type` for unions, aliases, and
  mapped types.
- All public function parameters and return types must be explicitly typed.
- Use `import type` for type-only imports — the compiler enforces this with `verbatimModuleSyntax`
  semantics.
- No `any`. Use `unknown` + narrowing, or a concrete union.

### Svelte 5 (runes mode — always)
- All components use **Svelte 5 runes**: `$state`, `$derived`, `$effect`, `$props`.
  Never use Svelte 4 `$:`, `export let`, `createEventDispatcher`, or `on:event`.
- Component props via `interface Props { … }` + `let { … }: Props = $props()`.
- Callback props are plain functions (e.g. `onSelect?: (frame: Frame) => void`), not
  dispatched events.
- Use `untrack(() => …)` when initialising writable `$state` from a prop to avoid the
  "only captures initial value" warning.
- Assign `$effect` to side effects only (DOM, observers, timers). Do not assign reactive
  state inside `$effect` unless syncing a writable local copy from props — document why.
- `{#each}` blocks **must** have a key: `{#each items as item (item.id)}`.
- `bind:this` is acceptable for canvas/element refs; prefer the pattern used in `FrameThumb`.

### Svelte Autofixer
When writing or modifying `.svelte` files, run `mcp_svelte_svelte-autofixer` before
finalising. Fix all reported **issues**; evaluate **suggestions** but only apply them when
they genuinely improve correctness (the malpractice warning about `$effect` assignments is
expected when syncing writable local copies from props).

### Naming
- Files: `kebab-case.ts` for TS modules, `PascalCase.svelte` for components.
- Variables/functions: `camelCase`.
- Types/interfaces: `PascalCase`.
- Constants: `SCREAMING_SNAKE_CASE` for module-level compile-time constants
  (e.g. `DB_NAME`, `THUMB_SIZE`).
- Boolean state variables: prefix with a noun, not `is`/`has` unless it reads naturally
  (e.g. `permError`, `loading`, `saving`).

### Imports
- Use the `$lib/` alias for everything under `src/lib/`.
- Group imports: (1) Svelte/SvelteKit internals, (2) `$lib/` modules, (3) types (`import type`).
- No barrel `index.ts` files — import directly from the source module.
- No external runtime dependencies unless absolutely necessary (zero `dependencies` in
  `package.json` is intentional). Use Web APIs instead.

### Formatting
- Tabs for indentation (enforced by Prettier defaults for Svelte).
- Trailing commas in multi-line arrays/objects.
- Align related assignments with spaces where it aids readability (see `idb.ts`).
- Single quotes in `.ts` files; template literals when interpolating.
- Max line length ~100 chars; wrap HTML attributes onto new lines beyond that.

### Error Handling
- `async` functions that may fail wrap in `try/finally` (not bare `catch`) when cleanup
  is needed (e.g. resetting a `saving` flag). Catch errors explicitly where recovery is
  possible; let unhandled promise rejections surface in dev.
- User-facing errors are stored in a `$state` string and rendered inline, not `alert()`.
- Never swallow errors silently; at minimum `console.error` before continuing.

---

## Architecture Rules

### Local-first invariants
- **Originals are never written.** Read-only `FileSystemDirectoryHandle` only.
- The `handles` IDB store holds `FileSystemDirectoryHandle` objects (structured-cloneable).
  `Roll` records are plain JSON — no handle embedded in the Roll type.
- OPFS (`navigator.storage.getDirectory()`) is the only place the app writes derived data
  (thumbnails, previews). Paths: `/thumbs/{frameId}.jpg`, `/previews/{frameId}.jpg`.
- Edit parameters are serialisable plain objects in IndexedDB. No undo stack in the DB;
  undo is in-memory only during an edit session.

### Data layer (`src/lib/db/`)
- `idb.ts` — low-level IDB wrapper. Functions accept/return typed domain objects.
- `rolls.ts` — high-level operations combining IDB + File System API.
- Never call `openDB()` from UI components; go through `rolls.ts` or `idb.ts` functions.

### File system (`src/lib/fs/`)
- `directory.ts` — File System Access API (picker, enumeration, permission).
- `opfs.ts` — OPFS read/write for cached thumbnails/previews.

### Image processing (`src/lib/image/`)
- `thumbgen.ts` — canvas/OffscreenCanvas resize to JPEG blob, with OPFS caching.
- Phase 3 will add WebGPU pipeline modules here.

### UI (`src/lib/components/`, `src/routes/`)
- Components are stateless or locally stateful — they do not import from `$app/stores`
  directly (except route pages).
- Route pages (`+page.svelte`) orchestrate data loading and pass data down to components.

---

## What Not to Do
- Do not add server-side routes, `+page.server.ts`, or `+server.ts` files — the app is
  entirely client-side.
- Do not introduce `localStorage` for user data — IndexedDB is the persistence layer.
- Do not add npm runtime dependencies without discussion.
- Do not commit `.env` files or any secrets.
- Do not use `alert()` or `confirm()` except for destructive confirmations already present
  (roll deletion). Prefer inline UI affordances.
