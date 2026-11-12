# ADR-0013: M4 Koofr delivery/sync + M5 mobile captures, with the Pass B visual audit fixes (section 15, section 16.1-16.3, A20-A23, D08, D12, H06, and section 3 visual fixes)

- Status: ACCEPTED (Pass B, FEAT-001..003)
- Spec references: M4 section 15 + section 16.1 (Koofr delivery/hosting,
  pointer-last publication, resilient refresh), A20 (interrupted refresh retains
  local), A21 (phone reading shell), D08 + D12 (storage adapter + delivery), H06
  (economical asset upload); M5 section 16.2 + section 16.3 (mobile capture
  engine + desktop processing queue), A22 (idempotent-by-CaptureId
  incorporation), A23 (a capture creates no graph node); and the section 3
  mandatory visual audit fixes (highlight drift, nodes label overlap, narrow
  pane toolbars, full history layout, top-bar clipping + Restore button style).
- Relationship to prior ADRs: ADR-0004 chose the pluggable StorageAdapter and
  ADR-0005 chose Koofr/WebDAV as the delivery target; this ADR implements that
  remote as a dedicated `KoofrStorageAdapter` and the publication protocol over
  it. ADR-0012 restructured the PDF `.pdf-page` stage/overlay geometry; this ADR
  removes the one remaining `max-width: 100%` on the stage that still let the
  canvas and overlay disagree in a narrow pane. ADR-0011 brought SCHEMA_VERSION
  to 2; this ADR keeps it at 2 because every capture field is additive and
  optional.

## Context

Pass B closes the delivery and mobile gap. The PC is the authoring brain; a
phone is a lightweight reader plus a quick capture surface. The two must share a
remote (Koofr over WebDAV) WITHOUT a race that could leave a phone reading a
half-written publication, and WITHOUT a capture silently mutating the authored
concept graph. The same pass also absorbs a visual audit of the shell so the
reader, the concept canvas, the history view, and the top bar all read as one
coherent tool in narrow multi-pane layouts.

## Decision

### 1. SCHEMA_VERSION stays at 2 (additive, optional, migration-safe)

Every M5 capture addition is OPTIONAL and readonly: the `Capture` record gains
`originDevice?`, `anchor?`, `targetPageId?`, and `status?`, a new
`CaptureHandling` record is introduced, and `BrainData` gains an optional
`captureHandlings?` collection defaulted to `[]` in `createEmptyBrainData`
(src/model/brain.ts) and in `fillDefaults` (src/model/migrate.ts). The canonical
`Capture.sourceId: SourceId | null` is reused for the capture source rather than
redeclared, so TypeScript keeps the single assignable property. Because the
additions are optional, an ADR-0011/ADR-0012 v2 brain loads with no migration
step, and the existing `SCHEMA_VERSION === 2` tests stay green.
`exactOptionalPropertyTypes` is ON, so optional fields are spread conditionally
rather than assigned `undefined`.

### 2. KoofrStorageAdapter: WebDAV, injectable fetch, runtime-only credentials (section 15, D08, D12)

`src/storage/KoofrStorageAdapter.ts` is a focused WebDAV client for the remote
publication layout, NOT a full StorageAdapter: Koofr is the delivery/hosting
target the PC publishes to and a phone refreshes from. It exposes the four
WebDAV primitives (PUT, GET that returns null on 404, PROPFIND depth-1, and a
MKCOL that tolerates an already-existing collection) plus higher-level helpers
for the four remote object kinds:

- `snapshots/rev-<n>.json`   an immutable per-revision brain snapshot,
- `assets/<assetId>`         binary PDF / snapshot assets,
- `captures/<captureId>.json` individual mobile capture items,
- `current-revision.json`    the atomic revision pointer, written LAST.

Credentials are STRICTLY runtime/session provided through the constructor config
`{ baseUrl, username?, appPassword?, fetchImpl? }`; nothing is ever hardcoded. A
Basic auth header is built only when both username and appPassword are present.
The transport is injectable through `fetchImpl` (falling back to the global
fetch), so the adapter is unit-testable against a fake fetch and a packaged app
can thread an authenticated intermediary. Request and header shapes follow
scripts/koofr-probe.mjs (Authorization Basic, Depth header, Content-Type
application/xml for PROPFIND). The adapter is exported from the src/storage
barrel.

### 3. Pointer-last atomic publication and the A20 retain-local guarantee (section 15, section 16.1, A20, H06)

`Workbench.publishToRemote(remote)` implements a strictly ordered protocol so a
phone refreshing concurrently never reads a partial publication:

1. Economical asset upload (H06): probe which `assets/<id>` already exist on the
   remote and upload ONLY the new or missing binaries. An unchanged PDF or an
   already-published history archive is never re-sent, so a phone refresh stays
   lightweight.
2. Write `snapshots/rev-<publicationRevision>.json`, then read it back and verify
   its integrity with a sha256Hex comparison (src/storage/hash.ts) before trusting
   it.
3. Pointer LAST: update `current-revision.json` ONLY after steps 1 and 2 succeed
   and verify.

If any step before the pointer throws, the prior remote `current-revision.json`
is left untouched and the failure is surfaced through `syncStatus()`. The
backing state is a small record `{ state, lastSyncedRevision, reason? }` where
`state` is `"stale" | "up-to-date" | "offline" | "publishing"`; publish moves it
to `publishing` during the attempt and to `up-to-date` on success.

`Workbench.refreshFromRemote(remote)` reads the pointer, fetches the target
snapshot and required assets, and runs the payload through the existing
`stageImport` validator and an integrity check BEFORE replacing active state.
The A20 guarantee is explicit: on a dropped fetch, a corrupted snapshot, or a
failed asset verification, `this.data` is NOT mutated and `syncStatus()` is set
to a stale/offline state with a human-readable reason. The local working copy is
retained intact.

### 4. Idempotent-by-CaptureId capture engine and the A23 no-auto-graph-node rule (section 16.2, section 16.3, A22, A23)

`Workbench.createMobileCapture({ content, sourceId?, anchor?, targetPageId?,
originDevice?, queueForUpload? })` creates a `Capture` via `newCaptureId()` saved
locally immediately with `status: "local"` (or `"pending"` when queued for
upload), mapping `content` into the existing `text` field. A23 is enforced
structurally: creating a capture, with or without a source, adds ONLY to
`this.data.captures` and NEVER creates a Page, Category, or Relationship.

`uploadPendingCaptures(remote)` writes each local/pending capture as an
INDEPENDENT `captures/<captureId>.json` item (never overwriting the published PC
brain snapshot) and transitions it to `"uploaded"`; on an offline/error for a
capture its status is kept `"pending"` with an honest error, and the capture is
never discarded.

`pullRemoteCaptures(remote)` lists `captures/`, fetches each, and dedupes by
CaptureId against BOTH `this.data.captures` AND `this.data.captureHandlings`, so
repeated and out-of-order pulls incorporate each capture at most once (A22).
`handleCapture(captureId, action)` processes a capture with one of three
dispositions: `"insert-into-page"` inserts the thought/quote into the target
Page and records a `CaptureHandling` with disposition `"incorporated-quote"`;
`"create-subject"` deliberately creates a new Page from the capture (disposition
`"created-subject"`) ONLY on this explicit user action, which is the one A23-safe
place a capture may become durable structure; `"dismiss"` records disposition
`"dismissed"`. In all cases the original Capture record is preserved with an
updated `status`, a `CaptureHandling` is appended, and the operation is
idempotent if the capture is already handled.

### 5. M4/M5 React surfaces (section 16.1, A21, section 16.3)

The shell renders a sync banner (`sync-publication-status` plus
`publish-remote-btn` and `refresh-remote-btn`) next to Backup/Restore so sync is
always reachable. The remote adapter is wired at runtime once Koofr credentials
exist; the banner still shows status and disables the action buttons when none
is present. A deterministic Phone Reading toggle (`toggle-mobile-mode`) mounts a
responsive `MobileReaderSheet`: tapping a cited passage opens a slide-up
related-writing sheet, and "Back to Reading" closes it while PRESERVING the exact
PDF source, scroll position, and zoom (the Reader body is never remounted).
Per-source offline cache controls (`offload-pdf-binary` / `attach-pdf-binary` /
`source-binary-status`) reuse the existing binary-offload engine. A mobile
capture composer and a desktop capture processing queue (a new `"captures"`
ViewMode) surface the four dispositions, and a visible Import Zotero button opens
the modal that calls the existing `importZoteroBundle`.

### 6. The Pass B visual audit fixes (section 3)

- FIX-HORIZONTAL-HIGHLIGHT-DRIFT (section 3.1): the one remaining
  `max-width: 100%` on `.pdf-page-stage` (editor.css) is removed. The canvas, the
  `.textLayer`, and the highlight overlay stay locked at 1:1 pixel dimensions
  inside the stage; narrow-pane auto-fit is applied by re-rendering each page at
  a pane-fitted scale so all three shrink together, and anchor geometry is
  normalized strictly against `stage.getBoundingClientRect()`. A unit test
  (src/pdf/anchorScale.test.ts) proves `createAnchor` + `renderHighlightOverlay`
  produce byte-identical normalized left/width at 1.0x and at a 0.6x narrow-pane
  stage scale.
- FIX-NODES-LABEL-OVERLAP (section 3.2): the "Open connecting page" action pill
  is hidden until a hub is hovered or actively selected/editing
  (`hoveredHub === hub.relationshipId || editingHub === hub.relationshipId`), so
  pills no longer render permanently on every hub. Category squircle labels sit
  at the top arch of the squircle (`y = sq.bounds.cy - sq.bounds.ry - 8`) with a
  readable halo (`paint-order: stroke fill; stroke: #f8f5ee; stroke-width: 4px;
  stroke-linejoin: round`) so node dots never overdraw category names.
- FIX-NARROW-PANE-TOOLBARS (section 3.3): the Reader document header and the
  SubjectEditor toolbar are single-row bars (`display: flex; flex-wrap: nowrap;
  gap: 6px; overflow-x: auto`); the title ellipsizes (`flex: 1; min-width: 0;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis`); the action
  buttons stay compact (`white-space: nowrap; padding: 3px 8px; font-size: 12px;
  flex-shrink: 0`); and the close button is pinned right (`margin-left: auto`).
- FIX-HISTORY-FULL-LAYOUT (section 3.4): `[data-testid="daily-review-panel"]` is
  a full-width two-column workspace (`max-width: 1140px; margin: 20px auto;
  display: grid; grid-template-columns: minmax(320px, 1fr) minmax(380px, 1.25fr)`)
  with a helpful empty-state message when no revisions exist yet.
- FIX-TOP-BAR-CLIPPING + RESTORE BUTTON STYLE (section 3.5): the app shell is a
  strict flex column (`.app-shell { height: 100vh; display: flex;
  flex-direction: column; overflow: hidden }`) with a non-clipped header
  (`.shell-header { flex-shrink: 0; position: relative; z-index: 30 }`) and a
  view body that takes the rest (`.view-body { flex: 1; min-height: 0;
  position: relative }`). The previous `position: fixed; inset: 0; top: 3rem`
  view containers are replaced by this flex body so the Nodes and 3D canvases no
  longer overdraw the header's bottom edge. The Restore `<label>` carries
  `data-testid="open-restore-input"` and is styled identically to `.ito-btn` /
  `button` in theme.css so "Restore" matches "Backup".

### 7. Two Pass-A engine refinements folded in

`reconstructRevisionState` now also replays `restore` revisions (whose
`afterSnapshot` is an array of `{ pageId, documentJson }`), so a revision
recorded after a mid-segment restore reconstructs the restored content.
`Reader.sanitizeSnapshotHtml` was widened to a single regex that strips UNQUOTED
inline event-handler attribute values in addition to quoted ones, while
preserving the preceding whitespace so adjacent attributes are not glued
together.

### 8. Test API + e2e sync

`src/app/testApi.ts` and `e2e/ito-globals.d.ts` expose the SAME eight new methods
(kept in exact sync): `publishToRemote`, `refreshFromRemote`, `syncStatus`,
`createMobileCapture`, `uploadPendingCaptures`, `pullRemoteCaptures`,
`handleCapture`, and `captures`. The remote-backed methods build an internal
deterministic in-memory Koofr adapter (an in-memory store plus a fake fetch) so a
publish/refresh or an upload/pull round-trip hits the same store without any real
network; a `corrupt` flag drives the A20 retain-local path. All methods return
serializable shapes following the existing serializeStaged / conceptGraph style.

## Consequences

- The PC can publish its brain to Koofr safely: a phone never reads a partial
  publication because the pointer is written last and only after a verified
  snapshot, and an interrupted refresh always retains the local copy.
- A phone can read a single document, inspect related writing, and return to the
  exact source and scroll/zoom, and can jot captures that sync without ever
  touching the authored concept graph.
- Captures are strictly idempotent by CaptureId across repeated and out-of-order
  pulls, and only become durable structure through an explicit disposition.
- The reader highlights sit over their glyphs even in a 0.6x narrow pane, the
  concept canvas no longer buries category names under node dots, the pane
  toolbars stay on one row, the history view is a full two-column workspace, and
  the top bar is never clipped by a canvas.
- Every addition is back-compatible: the full Vitest suite + typecheck + build
  are green, and the two new e2e specs (`koofr-mobile-sync.spec.ts`,
  `mobile-captures.spec.ts`) compile and are discovered via
  `npx playwright test --list`. M0 through M7 are complete.

## OPEN

- Whether a phone should pull only a delta since its last known revision (rather
  than the latest full snapshot plus missing assets) is deferred to a bandwidth
  milestone.
- Whether capture conflict resolution should offer a merge UI when the same
  CaptureId is edited on two devices is deferred; today the first-seen handling
  wins idempotently.
- Whether Koofr credentials should be stored (encrypted) for an unattended
  background publish, versus the current session-only runtime provisioning, is a
  security question deferred to a connectivity milestone.
