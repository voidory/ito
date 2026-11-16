# ito — Core Architecture Reference

> **Living document.** This is the canonical map of how ito is built. It is meant
> to be *read before* and *updated with* every change that touches the shape of
> the system.
>
> **Maintenance contract (update on every merge):** if your change alters any of
> the following, update the relevant section in the SAME PR:
> - a module's responsibility or a new top-level `src/` area;
> - the data contract (`src/model/types.ts`) or `SCHEMA_VERSION`;
> - the `StorageAdapter` interface or a storage back-end;
> - the Workbench ↔ React state/re-render contract;
> - how persistence, sync, or the test API are wired;
> - a cross-cutting invariant or a "gotcha" future work should know.
>
> Keep it concise and current — a stale architecture doc is worse than none.
> Last reviewed: 2026-11-12 (PR #19, audit fixes P0–P6/P8).

---

## 1. What ito is

A browser single-page app: a research PDF reader with source-local annotation,
deliberate "subject" pages, and a concept network. There is **no server** — the
app runs entirely in the browser and persists to **IndexedDB**. A remote sync
target (WebDAV/Koofr) is optional and user-configured.

Stack: **React 18 + TypeScript + Vite**. PDF rendering via **pdf.js**
(`pdfjs-dist`); rich text via **ProseMirror**; 3D concept view via **three.js**;
zip/backup via **fflate**; IndexedDB via **idb**. Tests: **Vitest** (unit/jsdom)
+ **Playwright** (real-browser e2e).

## 2. The golden rule: strict data/app separation

The app NEVER talks to a persistence mechanism directly. Everything goes through
two layers:

```
React components (src/app/*.tsx)
        │  read snapshot / call methods
        ▼
   Workbench  (src/app/workbench.ts)         ← headless domain + state owner
        │  StorageAdapter interface
        ▼
 StorageAdapter impls (src/storage/*)         ← IndexedDB (default), WebDAV (remote)
```

Pure domain logic (`src/model`, `src/network`, `src/editor`, `src/pdf`) is
DOM-free and independently testable. Keep it that way: new persistence or I/O
belongs behind an adapter, not inline in a component.

## 3. Directory map (`src/`)

| Dir | Responsibility |
| --- | --- |
| `model/` | The durable data contract: `types.ts` (BrainData + records), `ids.ts` (branded ids), `migrate.ts` (+ `SCHEMA_VERSION`), `annotationIndex.ts` (derived O(1) indexes), `citation.ts`, `relationship.ts`, `brain.ts`. Pure, DOM-free. |
| `storage/` | `StorageAdapter.ts` (the interface), `IndexedDbStorageAdapter.ts` (default, local), `KoofrStorageAdapter.ts` (WebDAV remote), `syncConfigStore.ts` (persisted sync endpoint), `backup.ts`/`staging.ts`/`zotero.ts` (import/export), `pdfAnalysisStore.ts`, `hash.ts`. |
| `app/` | React shell + the **Workbench** (`workbench.ts`) and its React binding (`useWorkbench.ts`). Views: `App.tsx`, `Library.tsx`, `Reader.tsx` (+ `reader/*`), `NodesCanvas.tsx`, `ThreeScene.tsx`, `SubjectEditor.tsx`, `SyncBanner.tsx`, etc. Shared UI kit in `app/ui/`. Theme tokens in `app/theme.css`. |
| `editor/` | ProseMirror schema/compose/serialize for subject-page prose + evidence. Pure. |
| `network/` | Concept-network geometry: `scene`, `layout`, `hub`, `basin`, `blend`, `hitTest`, `palette`. Pure; the canvas renders from these. |
| `pdf/` | pdf.js lifecycle, `anchor`/`fingerprint`/`glyphMap`/`highlight` (portable anchoring), `ingestPipeline`, `analysisCache`, DEV-only `instrumentation`. |
| `science/` | Scientific recognition (equations/molecules) layered over the reader. |
| `test/` | Test-only helpers incl. `InMemoryStorageAdapter`. |

## 4. The Workbench (state core)

`src/app/workbench.ts` (~5.8k LOC) is a single headless class that owns ALL
app state: the durable `BrainData` plus transient session/view state (open
sources, open subject page, view mode, category scope, workspace layout, sync
status, save errors). Every mutation is a method on it.

**Two kinds of state:**
- **Durable** (`this.data: BrainData`) — persisted. Mutations replace arrays
  immutably (`this.data = { ...this.data, annotations }`) and funnel through
  `persist()`.
- **Transient** (view/session fields) — never persisted; changed by synchronous
  setters (`setViewMode`, `openSource`, `setCategoryScope`, …).

### 4.1 Observable store ↔ React (the re-render contract) — IMPORTANT

The Workbench is an **observable store**. Do not reintroduce manual re-render
plumbing.

- `subscribe(listener)` / `snapshot()` are bound arrow-properties. `snapshot()`
  returns a **cached, reference-stable** `WorkbenchState`; it is rebuilt only
  after `notify()` invalidates the cache. (Reference stability is REQUIRED by
  `useSyncExternalStore` — returning a fresh object each call loops forever.)
- `notify()` invalidates the cache and fires subscribers. **Every state change
  must reach `notify()`:**
  - durable mutations do so via `persist()` (which notifies immediately after the
    in-memory change AND again once the async write settles, for `saveError` /
    revision);
  - transient setters call `this.notify()` directly;
  - any path that swaps `this.data` WITHOUT `persist()` (e.g.
    `commitStagedImport`, `refreshFromRemote` success) must call `notify()` AFTER
    the swap.
- `useWorkbench()` (`src/app/useWorkbench.ts`) binds via
  `useSyncExternalStore(wb.subscribe, wb.snapshot)`. It also returns `bump()` — a
  backward-compatible `() => wb.notify()` shim kept so the many existing
  `bump()` call sites keep working. It is NOT the source of truth anymore; new
  code should rely on the store, not on remembering to call `bump()`.

> **Gotcha:** when you add a method that changes what `snapshot()` would return,
> make sure it notifies (directly, or via `persist()`). Regression-guard it in
> `workbench.observable.test.ts`.

### 4.2 Persistence & save ordering

`persist()` serializes every write through a single promise chain
(`saveQueue`) so rapid mutations apply in call order; `persistNow()` re-reads
the latest `this.data` at execution time so concurrent edits compose instead of
racing. On write failure the in-memory draft is retained and a `saveError` is
recorded (surfaced by the save-error banner with Retry). A fresh workbench is
opened ONCE per page load and shared (module singleton in `useWorkbench.ts`) to
survive React StrictMode's double-effect without persisting two empty brains.

## 5. Storage & the adapter boundary

`StorageAdapter` (`src/storage/StorageAdapter.ts`) is the pluggable persistence
interface: `readBrain`/`writeBrain`, `readAsset`/`writeAsset`/`deleteAsset`,
`listBrains`, migration registration.

- **`IndexedDbStorageAdapter`** (default, local): pure IndexedDB via `idb`
  (stores: `payloads`, `pointers`, `assets`). Implements safe publication even
  locally — write to a STAGED key, read-back-verify, then advance the published
  pointer LAST, so a crash never leaves a brain on a partial payload. GCs
  superseded staged payloads. *(Formerly misnamed `LocalFileStorageAdapter` —
  it has never touched OPFS/the filesystem.)*
- **`KoofrStorageAdapter`** (remote): a real WebDAV client (PUT/GET/PROPFIND/
  MKCOL, Basic auth from runtime-supplied creds, injectable `fetchImpl`). It is
  NOT a full StorageAdapter; it is the remote delivery target the PC publishes
  to and a phone refreshes from (`snapshots/rev-<n>.json`, `assets/`, `captures/`,
  `current-revision.json` pointer written LAST). `publishToRemote` /
  `refreshFromRemote` live on the Workbench and swap `this.data` only after
  integrity + staging validation (local copy retained on any failure).
- If `indexedDB` is absent, startup throws an honest error — there is **no**
  in-memory fallback adapter in the shipped app (`InMemoryStorageAdapter` is
  test-only).

## 6. The data contract

`src/model/types.ts` defines `BrainData` (sources, pages, annotations,
evidence instances, relationships, categories, captures, presentation, …) and
`BrainManifest`. Ids are **branded** (`SourceId`, `PageId`, `AnnotationId`, …)
so they don't mix. `SCHEMA_VERSION` (currently **2**) lives in
`src/model/index.ts`; schema changes require a migration step in
`src/model/migrate.ts` (the SAME registry the adapter uses on read). Derived
views (e.g. annotation indexes) are memoized off array identity, never a second
source of truth.

## 7. Sync configuration (P5)

The configured WebDAV endpoint persists in `localStorage` via
`src/storage/syncConfigStore.ts` (only the serializable `KoofrConfig` — never
the `fetchImpl`). `App` restores a real remote at boot; `SyncBanner` offers
Connect / Disconnect and clearly labels the in-memory **demo remote** as
ephemeral (never persisted). Boot does not auto-publish/refresh.

## 8. The test API (`window.__ito`) — production hygiene

`src/app/testApi.ts` exposes a large imperative API the Playwright suite drives.
It is **gated**: `App.tsx` installs it only when `testApiEnabled()` is true
(`import.meta.env.DEV` or `VITE_ITO_TEST_API=1`) and loads it via **dynamic
`import()`** so Vite code-splits it into a chunk a normal `npm run build` never
fetches. The e2e webServer builds with `VITE_ITO_TEST_API=1`. **Do not import
`testApi` statically from app code** — that would pull it back into the main
bundle.

## 9. Styling

Design tokens are CSS custom properties in `src/app/theme.css`
(`--ito-*`: palette, radii, shadows, motion, annotation colours, and semantic
status colours `--ito-danger/success/warning/info-*`). Prefer `var(--ito-*)`
over hardcoded hex in component styles. A strict motion gate disables all
transitions under `[data-suppress-motion="true"]` / reduced-motion.

## 10. Build, test, CI

- Scripts: `npm run dev`, `npm run build` (= `tsc --noEmit && vite build`),
  `npm run typecheck`, `npm test` (Vitest once), `npm run test:e2e` (Playwright).
- Tests: ~170 unit specs (`src/**/*.test.ts`, jsdom, nothing mocked — they drive
  the REAL Workbench + `InMemoryStorageAdapter`) and 18 Playwright e2e specs
  (`e2e/*.spec.ts`, real Chromium against the production build).
- CI (`.github/workflows/ci.yml`): a `unit` job (typecheck + full Vitest + build)
  and an `e2e` job (Playwright chromium). Both must pass on PRs to `main`.

> **e2e gotcha:** the library starts EMPTY (no auto-seed). Specs that need
> documents must seed via `seedSampleLibrary(page)` in `e2e/helpers.ts` (clicks
> the "Load Sample Workspace" CTA; idempotent).

## 11. Known debt / in-flight

- **`workbench.ts` is a ~5.8k-line monolith** and several components are
  oversized (`App.tsx`, `NodesCanvas.tsx`, `Library.tsx`). Decomposition is the
  open audit item **P7** (see `docs/UI_AUDIT.md`) — intended as its own PR.
- Milestone tags (M1…M21) are baked into comments throughout; prune
  opportunistically during refactors.
- See `docs/UI_AUDIT.md` for the full audit and the P0–P8 status.
