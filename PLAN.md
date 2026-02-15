# Roloc — Film Negative Inversion App

## Stack
- SvelteKit + TypeScript
- WebGPU (WebGL fallback)
- IndexedDB + OPFS + File System Access API
- libraw compiled to WASM (Phase 5)
- Local-first, no login, no cloud

## Data Model

### Roll
- id, label, filmStock, camera, notes, createdAt
- directoryHandle (FileSystemDirectoryHandle, stored separately in IndexedDB)
- rollEdit: RollEditParams (rebateRegion, cameraColorMatrix, lightSourceTemp, baseToneCurve, baseRGBCurves)

### Frame
- id, rollId, filename, index, rating, flags, notes, capturedAt
- frameEdit: FrameEditOverrides (exposureCompensation, whiteBalance, toneCurve, rgbCurves, rebateRegion — all nullable, inherit from roll when null)

### Storage
- IndexedDB stores: `rolls`, `frames`, `handles`
- OPFS: `/previews/{frameId}.jpg`, `/thumbs/{frameId}.jpg`

### Edit Resolution
Frame effective edit = roll.rollEdit merged with frame.frameEdit (frame overrides win).
Only overrides are stored; null means "use roll default".

## Key Decisions
- Edit parameters are always non-destructive — originals never touched
- Frame edits inherit from roll defaults; only overrides are stored per frame
- User's files stay on their filesystem; app only holds FileSystemDirectoryHandle
- No undo stack in DB — undo is in-memory only during an edit session
- No login, no cloud sync, fully local-first

## Build Phases

### Phase 1: Scaffold + Data Layer
- [ ] SvelteKit project with TypeScript
- [ ] IndexedDB schema (rolls, frames, handles stores)
- [ ] File System Access API: pick directory, persist handle, enumerate files
- [ ] OPFS setup for preview/thumb cache
- [ ] Roll and frame CRUD (data layer only, no UI)

### Phase 2: Library UI
- [x] Roll list view
- [x] Filmstrip / grid view within a roll
- [x] Frame metadata panel (rating, flags, notes)
- [x] Thumbnail generation from JPEG/TIFF via canvas → OPFS
- [x] Navigation and keyboard shortcuts

### Phase 3: Edit UI + WebGPU Pipeline
- [ ] Lightbox / editor view layout
- [ ] WebGPU shader pipeline
  - [ ] Texture upload
  - [ ] Pass 1: normalize + invert (per-channel black/white point)
  - [ ] Pass 2: color matrix (camera RGB → linear sRGB)
  - [ ] Pass 3: tone curve + white balance
  - [ ] Display output
- [ ] Curves editor component (global + per-channel, Bezier)
- [ ] White balance controls
- [ ] Rebate region sampler (click-drag rectangle)
- [ ] Edit params → shader uniforms, real-time feedback
- [ ] Roll defaults vs frame overrides UI

### Phase 4: Export
- [ ] Full-resolution offscreen render
- [ ] Download as TIFF or JPEG with quality control
- [ ] Sidecar JSON export of edit parameters

### Phase 5: libraw WASM
- [ ] Compile or source libraw WASM build
- [ ] Swap JPEG/TIFF texture source for RAW decode
- [ ] Pull camera color matrix from libraw metadata
- [ ] Linear light pipeline correct end-to-end
