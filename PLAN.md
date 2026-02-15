# Roloc — Film Negative Inversion App

## Stack
- SvelteKit 2 + Svelte 5 (runes mode) + TypeScript strict
- Tailwind CSS v4 with semantic `@theme` design tokens
- WebGPU 3-pass shader pipeline (WebGL fallback: not planned)
- IndexedDB + OPFS + File System Access API
- libraw compiled to WASM (Phase 5)
- Local-first, no login, no cloud
- Runtime deps intentionally minimal: `paneforge` (split panes), `phosphor-svelte` (icons)

## Data Model

### Roll
- `id`, `label`, `filmStock`, `camera`, `notes`, `createdAt`
- `directoryHandle` — stored separately in the `handles` IDB store (not embedded in `Roll`)
- `rollEdit: RollEditParams` — roll-level edit defaults

### RollEditParams
- `rebateRegion: Rect` — normalised 0–1 rectangle for black/white point sampling
- `cameraColorMatrix: Matrix3x3` — 3×3 row-major camera RGB → linear sRGB
- `lightSourceTemp: number` — reference illuminant (K)
- `baseToneCurve: CurvePoints`
- `baseRGBCurves: [CurvePoints, CurvePoints, CurvePoints]` — R, G, B
- `invert: boolean` — toggle between negative inversion and positive passthrough

### Frame
- `id`, `rollId`, `filename` (relative path), `index` (1-based), `rating` (0–5)
- `flags: FrameFlag[]` — `'pick' | 'reject' | 'edited'`
- `notes`, `capturedAt` (unix ms from EXIF, or null)
- `frameEdit: FrameEditOverrides` — per-frame overrides; `null` on any field means "inherit from roll"

### FrameEditOverrides
- `exposureCompensation: number | null`
- `whiteBalance: WhiteBalance | null` — `{ temperature, tint }`
- `toneCurve: CurvePoints | null`
- `rgbCurves: [CurvePoints, CurvePoints, CurvePoints] | null`
- `rebateRegion: Rect | null`

### Edit Resolution
`resolveEdit(roll, frame): EffectiveEdit` — merges roll defaults with frame overrides (frame wins).
Only overrides are stored; `null` means "use roll default". Resolved at render time.

### Storage
- IDB stores: `rolls`, `frames`, `handles`
- OPFS: `/thumbs/{frameId}.jpg` (160px), `/previews/{frameId}.jpg` (1200px)

## Key Decisions
- Originals are never written — read-only `FileSystemDirectoryHandle` only
- Frame edits inherit from roll defaults; only overrides are stored per frame
- User files stay on their filesystem; only the `FileSystemDirectoryHandle` is held in IDB
- No undo stack in DB — undo is in-memory only during an edit session
- No login, no cloud sync, fully local-first
- No npm runtime dependencies for logic — Web Crypto for ID generation, Web APIs throughout

## Build Phases

### Phase 1: Scaffold + Data Layer — COMPLETE
- [x] SvelteKit project with TypeScript (`strict: true`)
- [x] IndexedDB schema (`rolls`, `frames`, `handles` stores) — `src/lib/db/idb.ts`
- [x] File System Access API: pick directory, persist handle, enumerate files — `src/lib/fs/directory.ts`
- [x] OPFS setup for preview/thumb cache — `src/lib/fs/opfs.ts`
- [x] Roll and frame CRUD (data layer only) — `src/lib/db/idb.ts` + `src/lib/db/rolls.ts`
- [x] Browser tests for all IDB operations (22 test cases, real Chromium via Playwright)

### Phase 2: Library UI — COMPLETE
- [x] Roll list view (`/` — grid of roll cards with filmstrip previews)
- [x] Filmstrip / grid view within a roll (`/roll/[id]`)
- [x] Frame metadata panel (rating 0–5, pick/reject flags, notes) — `FrameMetaPanel`
- [x] Thumbnail generation from JPEG/TIFF via `OffscreenCanvas` → OPFS — `thumbgen.ts`
- [x] Lazy thumbnail loading via `IntersectionObserver` (200px root margin)
- [x] Two-phase preview loading (thumb → 1200px upgrade in background)
- [x] Navigation and keyboard shortcuts (← → j k, 0–5 rating, p pick, x reject, e/Enter to edit)
- [x] Resizable filmstrip / metadata split pane (paneforge)
- [x] Light/dark theme with system preference detection and localStorage persistence

### Phase 3: Edit UI + WebGPU Pipeline — SUBSTANTIALLY COMPLETE
- [x] Lightbox / editor view layout (`/roll/[id]/frame/[frameId]`)
- [x] WebGPU 3-pass shader pipeline — `src/lib/image/pipeline.ts`
  - [x] Texture upload (`copyExternalImageToTexture`, full-screen-triangle trick)
  - [x] Pass 1 — normalise + invert (per-channel exposure) — `invert.wgsl`
  - [x] Pass 2 — colour matrix (camera RGB → linear sRGB) — `colormatrix.wgsl`
  - [x] Pass 3 — tone curve + RGB curves LUT + gamma encode — `tonecurve.wgsl`
  - [x] Display output to canvas
- [x] Monotone cubic spline → 256-entry LUT (`curves.ts`, Fritsch-Carlson)
- [x] Curves editor component (SVG, draggable control points, add/remove/reset) — `CurvesEditor`
- [x] White balance controls (temperature/tint sliders + named presets) — `WhiteBalanceControls`
- [x] Edit params → shader uniforms, real-time feedback via `resolveEdit()`
- [x] Roll-level `invert` toggle (negative vs positive passthrough)
- [ ] Rebate region sampler (click-drag rectangle) — black/white points currently hardcoded 0/1
- [ ] White balance actually wired to shader uniforms (UI + IDB save exists; GPU path passes identity `[1,1,1,1]`)
- [ ] `WhiteBalanceControls` rendered in editor sidebar (component exists but not yet placed in layout)
- [ ] Roll defaults vs frame overrides UI (partially done — invert is roll-level; curves/WB are frame-level)

### Phase 4: Export — NOT STARTED
- [ ] Full-resolution offscreen render (re-run pipeline at source resolution)
- [ ] Download as TIFF or JPEG with quality control
- [ ] Sidecar JSON export of edit parameters

### Phase 5: libraw WASM — NOT STARTED
- [ ] Compile or source libraw WASM build
- [ ] Swap JPEG/TIFF texture source for RAW decode (`.cr2`, `.nef`, `.arw`, `.dng`, etc.)
- [ ] Pull camera colour matrix from libraw metadata
- [ ] Populate `capturedAt` from EXIF (`Frame.capturedAt` is typed but always `null` currently)
- [ ] Linear-light pipeline correct end-to-end

## Known Gaps / Tech Debt
- `package.json` contains dead scripts from the `sv` scaffolding template (`db:start`, `db:push`,
  `db:generate`, `db:migrate`, `db:studio`, `auth:schema`) — Drizzle ORM and Better Auth are not
  installed and not used; these should be removed.
- `Frame.capturedAt` is typed as `number | null` but EXIF parsing is not yet implemented — always `null`.
- `FrameFlag` includes `'edited'` but no UI sets this flag automatically on save.
- `temperatureToMultipliers()` is implemented in `pipeline.ts` but the WB uniform is hardcoded to
  `[1, 1, 1, 1]` — the function is ready but not wired.
- No tests for `rolls.ts`, `curves.ts`, `pipeline.ts`, or any Svelte components.
