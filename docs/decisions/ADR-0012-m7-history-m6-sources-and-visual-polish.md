# ADR-0012: M7 linked history + M6 Zotero/website/area sources + interactive 2D canvas, tactile theme, and 3D contrast (H01-H07, D13, D14, A15, A24, D01, D10, D11, sections 3.1-3.5)

- Status: ACCEPTED (Pass A, FEAT-001..003)
- Spec references: M7 H01-H07 + D13 (checkpoints) + D14 (multi-span reflection);
  M6 A24 + D10 (Zotero importer), A15 + D11 (snapshot websites), D01 (extended
  PDF scope + area annotations); section 3.1 (highlight alignment + pageCount
  backfill), 3.2 (narrow-pane auto-fit), 3.3 (interactive 2D pan/zoom/node-drag),
  3.4 (tactile design system + micro-animations), 3.5 (3D contrast).
- Relationship to prior ADRs: ADR-0009 fixed the presentation persistence split
  (D19) that the interactive 2D canvas drag/zoom build on. ADR-0008 fixed the
  association/citation state the area annotation reuses for citation. ADR-0011
  brought SCHEMA_VERSION to 2 with a stepwise migration runner; this ADR keeps
  SCHEMA_VERSION at 2 (see below) because every addition here is additive and
  optional, so an ADR-0011 brain loads unchanged.

## Context

Pass A closes the last large feature gaps before polish: a full linked-history
engine (M7), the remaining source importers (M6 Zotero + snapshot websites +
area annotations), and the visual/interaction fixes that make the shell feel
like one coherent research tool rather than a collection of raw browser
controls. All three had to share the same migration-safe data contract so an
existing M3 brain keeps loading.

## Decision

### 1. SCHEMA_VERSION stays at 2 (additive, optional, migration-safe)

Every new durable field and collection introduced across FEAT-001..003 is
OPTIONAL and readonly, defaulted in `createEmptyBrainData` (src/model/brain.ts)
and in `fillDefaults` (src/model/migrate.ts). Because a pre-M7 brain has no
`checkpoints`, `reflections`, or `revisionComments`, and a pre-M6 source simply
lacks the new optional `url`/`availabilityStatus`/`externalId`/`type` fields, an
ADR-0011 v2 brain loads with no migration step. We therefore did NOT bump to
version 3: the existing tests assert `SCHEMA_VERSION === 2`, and keeping the
additive fields version-free keeps them green while remaining forward-safe.
`exactOptionalPropertyTypes` is ON in tsconfig, so optional fields are spread
conditionally rather than assigned `undefined`.

### 2. M7 linked history, checkpoints, and multi-span reflection (H01-H07, D13, D14)

The Workbench (src/app/workbench.ts) is the single mutation hub, so the history
engine lives there:

- Coalesced prose revisions (H01): same-Page prose typing within a 2000 ms idle
  window (`COALESCE_WINDOW_MS`) folds into one buffered revision; a different
  page, a structural action, or an explicit `flushPendingRevision()` commits the
  buffer. `flushPendingRevision` is public and deterministic (the coalescing
  compares `createdAt` timestamps, not a wall clock) so tests do not rely on
  timers.
- Immediate structural revisions (H02): quote insert/remove/reorder, annotation
  comments, range boundaries, tentative associations, categories, and
  relationships flush immediately as their own revision.
- Periodic checkpoints (H06, D13): every 20 revisions (`CHECKPOINT_INTERVAL`) a
  validated `Checkpoint` is written. Its `stateSnapshot` is a structured clone of
  BrainData with `revisions` and `checkpoints` EXCLUDED (no recursive history
  nesting) and carries no PDF binary bytes (sources hold asset ids, not bytes).
- Reconstruct / restore / overhead (H05, H07): `reconstructRevisionState(revId)`
  replays the page-prose deltas forward from the nearest prior checkpoint and
  returns either the reconstructed state or an explicit
  `{ status: "missing-segment", missingIds, fallbackState }` on a broken chain.
  `restoreRevision(revId)` restores the target state by recording a NEW FORWARD
  revision, so history only ever grows and the restore is itself reversible.
  `measureHistoryOverhead()` returns `{ revisionCount, checkpointCount,
  deltaBytes, checkpointBytes, replayDurationMs }`.
- Multi-span reflection (H03, H04, D14): revisions group by creation-timezone day
  key (`Workbench.dateKeyOf`, `YYYY-MM-DD`). `createReflection(input)` stores a
  `ReflectionEntry` with `linkedRevisionIds` + `startDateKey` + `endDateKey`
  computed from the linked revisions' day keys; a reflection NEVER rewrites a
  revision and NEVER creates a graph node. `addRevisionComment(revId, text)`
  persists a per-change note.

The UI is `src/app/HistoryReflectionPanel.tsx`, reachable from the shell view
switch via `data-testid="view-history"` (FEAT-003 extended `ViewMode` to
`"files" | "nodes" | "history"` and wired the toggle in App.tsx). It groups
revisions by day, offers a single-day picker plus a date-RANGE filter, lets the
user cherry-pick revisions across days into a reflection (rendering a date-span
badge when the span is multi-day), and supports per-change comments and a
before/after diff view.

### 3. M6 Zotero importer, snapshot websites, and area annotations (A24, D10, A15, D11, D01)

- Zotero importer (A24, D10): `src/storage/zotero.ts` is a pure parser accepting
  native Zotero JSON, BetterBibTeX JSON, and RDF-as-JSON bundles; parent items
  map to Sources (externalId) and highlights/notes to source-local Annotations
  (externalId). `Workbench.importZoteroBundle(rawJson)` applies the parse result
  IDEMPOTENTLY: it matches existing records on `externalId` and updates them in
  place, so re-importing produces zero duplicate Source/Annotation records and
  zero auto-created graph nodes.
- Snapshot websites (A15, D11): `Workbench.importWebsiteSource(params)` REQUIRES
  both a URL and a snapshot file, sanitizes the snapshot bytes (strips
  script/style/inline-handlers/javascript: URLs) before storing them via the
  StorageAdapter, and tags the Source `kind`/`type = "website"` with
  `availabilityStatus = "snapshot-cached"`. The Library `add-website-modal`
  enforces URL + snapshot and rejects a URL-only submit with
  `website-snapshot-required-error`; the Reader renders the sanitized snapshot
  with a `website-availability-badge`.
- Area annotations (D01): modeled as a THIRD `AnnotationScope` variant
  `{ kind: "area"; anchor: AreaAnchor }` rather than a separate `Annotation.kind`
  discriminator. This keeps the discriminated-union exhaustiveness the existing
  citation/evidence/anchor code relies on while satisfying the spec's
  `Annotation.kind = "area"` semantics via `scope.kind`.
  `Workbench.commitAreaAnnotation(sourceId, pageIndex, normRect, comment?)`
  creates the annotation and it cites into Subject Pages through the ordinary
  evidence path. The Reader renders `pdf-scope-status` banners for scanned (no
  selectable text) and encrypted PDFs.

### 4. PDF stage/overlay restructuring, pane auto-fit, and pageCount backfill (sections 3.1-3.2)

`src/pdf/render.ts` now builds `.pdf-page` as a header (`pdf-page-header`,
" - Page N", plain hyphen) plus a separate inner stage (`pdf-page-stage`,
`position: relative`, exact viewport width/height) that holds the canvas, the
`.textLayer`, and the highlight overlay layer. `pageBox()` returns the STAGE
rect, so `createAnchor`/`resolveAnchor`/`renderHighlightOverlay` measure relative
to the stage and overlays sit over the glyphs rather than floating under the
header. The pdfjs v4 `.textLayer` CSS lives in the always-loaded editor.css so
spans align 1:1 across normal, multi-column, and rotated pages. SourcePane adds a
ResizeObserver fit-to-pane scale (synchronized `--scale-factor` + `max-width:
100%`) so pages never clip horizontally in 2-pane/3-pane layouts.
`Workbench.updateSourcePageCount(sourceId, pageCount)` backfills a stored
`pageCount === 0` once when `doc.numPages` loads (the M3 batch-ingest note).

### 5. Interactive 2D canvas: persistent node drag + pan + wheel zoom (section 3.3)

`src/network/scene.ts` `buildScene` gained optional `dragOffsets` and
`nodePositions` options. Offsets are applied on TOP of the deterministic force
layout BEFORE hubs and squircle bounds are computed, so a dragged node drags its
hubs and category squircles with it; an absolute `nodePositions` override wins
outright. Determinism (A09-M2) is preserved: a graph with NO offsets yields
output byte-identical to the un-offset layout, so the existing scene.test.ts
stays green. scene.ts remains PURE (offsets are plain data in, no DOM).

`src/app/NodesCanvas.tsx` wires pointer-drag handlers on each `graph-node`:
dragging updates a live offset and commits `wb.setDragOffset(pageId, dx, dy)` on
pointer-up so the arrangement persists (D19). A background pointer-pan folds a
`data-pan-x` / `data-pan-y` offset into the viewBox, and wheel + button zoom
(`canvas-zoom-in` / `canvas-zoom-out` / `canvas-zoom-reset`) drive
`wb.setZoom(scale)`, also folded into the viewBox. Pan/zoom/drag record NO
history revision (FEAT-001 already excludes drag/zoom frames), and a drag that
moved suppresses the node's click-to-open so the two gestures never conflict.

### 6. Warm Archival Research tactile theme + micro-animations (section 3.4)

`src/app/theme.css` (imported first in src/main.tsx) defines the design tokens
as CSS custom properties (`--ito-bg-paper #f8f5ee`, `--ito-bg-elevated #ffffff`,
`--ito-ink #1e232a`, `--ito-accent #2c4a6f`, `--ito-border #dcd6c8`, plus radii
and shadow tokens) and styles buttons, segmented view-switch pills, inputs,
selects, checkboxes, cards, and modals app-wide. Micro-animations use a single
crisp 160 ms `cubic-bezier(0.22, 1, 0.36, 1)` curve: a button `:active`
`scale(0.97)` press, hover elevation, a modal fade-and-slide (`@keyframes
ito-pop-in`), a highlight creation pulse, and node/hub selection ring
transitions. A STRICT motion gate (R19, A09-M2) disables ALL transitions and
keyframes under `[data-suppress-motion="true"]` (propagated to the shell root in
App.tsx) and under `prefers-reduced-motion: reduce`; the graph camera is never
animated unprompted.

### 7. 3D contrast upgrade (section 3.5)

The hardcoded 3D colors move into exported pure descriptors
(`THREE_D_STYLE` in src/app/threeScene.map.ts) so the high-contrast look is
provable in Vitest without a WebGL render. The 3D scene now uses a deep
twilight-ink backdrop and fog (`#141824`), bright glowing stellar node particles
(`#eaf2ff`), clearly visible translucent category bubble hulls (opacity 0.28)
with a subtle rim wireframe, and visible connecting lines. The
`isWebGLAvailable()` guard and the `three-fallback` notice are kept intact for
the headless sandbox.

### 8. Test API + e2e sync

`src/app/testApi.ts` and `e2e/ito-globals.d.ts` expose the SAME new method
surface (kept in exact sync): `flushPendingRevision`, `revisions`, `checkpoints`,
`reconstructRevisionState`, `restoreRevision`, `measureHistoryOverhead`,
`createReflection`, `addRevisionComment`, `importZoteroBundle`,
`importWebsiteSource`, `commitAreaAnnotation`, and `setDragOffset`. All return
serializable shapes following the existing serializeStaged / conceptGraph style.

## Consequences

- A user can review their editing history grouped by day, filter by day or
  range, cherry-pick changes across weeks into a reflection, comment on
  individual changes, and restore an earlier state without ever losing history.
- The remaining import paths (Zotero, snapshot websites) and area annotations
  close the M6 source model while staying idempotent and node-free.
- PDF highlights sit over their glyphs, pages fit narrow panes, and batch-ingest
  pageCount is backfilled, removing the M3 review findings.
- The concept canvas is directly manipulable (drag, pan, zoom) while un-dragged
  graphs stay deterministic, and the whole shell shares one tactile identity with
  a strict motion gate that honors reduced-motion.
- Every addition is back-compatible: the full Vitest suite + typecheck + build
  are green and both new e2e specs (`history-reflection.spec.ts`,
  `zotero-website.spec.ts`) compile and are discovered via
  `npx playwright test --list`.

## OPEN

- Whether absolute `nodePositions` should replace `dragOffsets` entirely (a
  single durable-position model) rather than layering offsets over the engine
  layout is deferred; today both are supported, with an absolute position
  winning per node.
- Whether a reflection should be able to pin a reconstructed state snapshot for
  fast re-opening (vs replaying on demand) is an M-later performance question.
- Whether website snapshots should re-fetch/refresh from their URL rather than
  staying a frozen cached snapshot is deferred to a connectivity milestone.
