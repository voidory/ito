# ADR-0011: M3 backup, offline-first citations, and two-mode deletion (A17, A18, A19, D02, D09, D19)

- Status: ACCEPTED (M3, FEAT-001..003)
- Spec references: section 8.2 + A17 (offline-first citations; following a quote
  returns to the exact source and never silently navigates); section 20 + A18
  (Targeted Backup Checklist with manifest omission stamping); A19 (isolated
  staging validator + Try Import Anyway + stepwise migration); D02 (two-mode
  highlight deletion); D09 (two-lane disentangled backup + batch PDF ingestion);
  D19 (shared vs device-local presentation split).
- Relationship to prior ADRs: ADR-0004 scoped the pluggable StorageAdapter and
  deferred real migrations to a later milestone; this ADR brings the FIRST real
  schema bump (SCHEMA_VERSION 1 -> 2) forward because M3 is the backup/recovery
  milestone and recovery is meaningless without a migration runner. ADR-0007
  fixed the association/citation state (EvidenceInstance vs SubjectAssociation),
  which the two-mode deletion below operates on. ADR-0010 cleaned
  `BrainData.captures` of the M1 style sentinel so the whole-brain export is not
  polluted; this ADR consumes that clean shape.

## Context

M3 is Complete Backup, Recovery, and Validation. Four capabilities had to land
together and share the same data contract:

1. A17 offline-first citations. A citation must keep FUNCTIONING when its PDF
   binary has been evicted locally to reclaim space. The reader side stores
   enough metadata (quote, comment, page, source title, version hash) that a
   citation resolves and renders its provenance without the bytes present.
2. A18 Targeted Backup Checklist. A backup is not all-or-nothing: the user
   chooses which optional sections to include, and the resulting manifest must
   record exactly what was left out so a restore can reason about completeness.
3. A19 staged recovery. An incoming backup must be validated in ISOLATION
   before it can touch the live store, with a default-reject posture for
   suspicious payloads and an explicit "Try Import Anyway" override.
4. D02 two-mode highlight deletion. Deleting a highlight must distinguish
   "remove the highlight but keep the quotes I already composed" from "remove
   the highlight and the quotes with it", the latter being reversible.

## Decision

### 1. Two-lane disentangled backup codec (D09, A18, D19)

Backup is split into two lanes so the heavy PDF binaries never entangle the
graph payload:

- LANE 1 (core brain graph): a single `brain.ito.json` text payload built by
  `exportCoreBrainJson` in `src/storage/backup.ts`. It always carries the core
  graph (manifest + sources metadata + annotations + subjectAssociations +
  pages + evidenceInstances + categories + relationships + tentativeAssociations)
  and the OPTIONAL sections (captures, revisions, shared presentation) gated by
  the checklist.
- LANE 2 (bundled archive): a `.ito.zip` built by `exportBundleZip` containing
  `manifest.json`, `brain.json` (the Lane-1 json), and, when source binaries are
  ticked, one `assets/<sourceId>-<versionHash>.pdf` per source whose bytes are
  available. `parseBundleZip` is the inverse.

The Targeted Backup Checklist has five items. The core brain graph is always on
and is not a toggle. The four optional keys are `presentation`, `captures`,
`revisions`, and `sourceBinaries`. Unticking any box stamps its omission token
on the manifest: `manifest.backupMode` becomes `targeted` with a stable,
checklist-ordered `manifest.omissions` array; all boxes ticked stamps `full`
with `omissions: []`. The omission tokens are the exact strings
`presentation`, `captures`, `revisions`, `sourceBinaries`, centralized in
`OMISSION_TOKENS` so the export, the staging validator, and the e2e spec cannot
drift.

D19 device-local vs shared presentation split: only the SHARED presentation
fields cross a backup (`nodePositions`, `dragOffsets`, `categoryBounds`,
`hiddenPageIds`, `hiddenRelationshipIds`, `annotationStyles`). The device-local
fields (pane widths, zoom, active-3D, suppress-motion) are never exported, so a
restore on another device never imports another machine's window geometry.

### 2. fflate vs a pure deterministic codec

The `.ito.zip` lane needs a real zip codec. The decision is to USE
`fflate@^0.8.3`: it installed successfully against the registry in the build
sandbox and `zipSync`/`unzipSync` round-trip the manifest, brain json, and PDF
bytes byte-for-byte (PDF entries are stored at level 0 so already-compressed PDF
streams are not re-compressed and stay byte-identical). A pure, dependency-free
deterministic codec was the documented FALLBACK had the install failed (the
sandbox proxy could have blocked the registry); because the install succeeded
there is no pure-codec fallback in the shipped code, and this ADR records that
contingency so the choice is auditable.

### 3. Binary-offloaded resolution state + offload/attach flow (A17)

`AnchorResolution` gains a first-class `binary-offloaded` kind alongside
`resolved`, `mismatched`, and `unresolved`. The Workbench carries a sync-readable
`offloadedAssetIds` cache (rebuilt from the adapter at `open`) so
`sourceBinaryStatus` and `resolveEvidenceSource` stay synchronous:

- `offloadSourceBinary(sourceId)` deletes ONLY the stored asset bytes via the
  new `StorageAdapter.deletePdfBinary`; the Source and every Annotation +
  EvidenceInstance survive, and the status flips to `binary-offloaded`.
- `resolveEvidenceSource` reports `binary-offloaded` (carrying the stored quote,
  comment, page, and version hash) rather than pretending the citation resolved
  or silently navigating elsewhere.
- `attachSourceBinary(sourceId, bytes)` computes the sha256 of the supplied
  bytes and writes them ONLY when the digest matches the stored
  `Source.versionHash`; a mismatched file writes nothing and returns a reason,
  so a drifted edition can never masquerade as the original.

The UI surfaces this as the Library `offload-pdf-binary` control + a
`source-binary-status` badge (`cached`|`binary-offloaded`), and a Reader
`binary-offloaded-popover` (carrying `data-return-resolution="binary-offloaded"`)
that shows the stored quote/comment/page/title and an `attach-pdf-binary` action
to re-hydrate.

### 4. Two-mode highlight deletion with pre-mutation Revision snapshots (D02)

Two Workbench methods implement the two modes:

- `deleteAnnotationOnly(id)` removes the Annotation record (and its style +
  SubjectAssociations, which are reader-side intent that cannot outlive the
  annotation) but PRESERVES every EvidenceInstance and the inline evidence atoms
  in subject pages. The composed quote text lives on; the (annotation,
  destination) pair then derives as `unresolved` purely because the annotation
  record is gone.
- `deleteAnnotationAndQuotes(id)` is the destructive variant. It FIRST records a
  reconstructable `Revision` snapshot of every affected subject page's
  `documentJson` (the `beforeSnapshot` + `affectedObjectIds` fields) so the
  removal is reviewable/revertible, THEN deletes the annotation + style +
  matching EvidenceInstance records and strips ONLY the matching inline evidence
  atoms via the existing `removeEvidenceNode` helper, leaving surrounding prose
  and any other quotes on the page exactly intact.

### 5. Isolated staging validator + Try Import Anyway (A19)

`src/storage/staging.ts` validates an incoming backup WITHOUT touching the live
store and returns a discriminated outcome:

- `hard-reject`: corrupt zip headers, a bundled asset failing the `%PDF-` magic
  check, or unparseable JSON. Nothing is committable; the UI shows the abort
  reason and offers no override.
- `needs-confirmation` (default reject): a schemaVersion mismatch, a bundled PDF
  checksum mismatch, or a missing optional array. The staging report lists the
  findings and offers `Try Import Anyway`, which commits leniently.
- `ready`: a clean bundle that commits normally.

The lenient commit coerces the payload: it runs `migrateBrainData` (filling
missing optional collections with canonical empty defaults), marks sources whose
bundled binary checksum MISMATCHED as `mismatched` and sources whose binary is
ABSENT as `binary-offloaded`, then verifies referential integrity before
swapping the in-memory BrainData (write-then-swap retains the prior data on any
write failure, the R12 discipline). The Workbench holds the staged candidate in
memory between `stageImport` and `commitStagedImport` so the UI can inspect it.

### 6. SCHEMA_VERSION bump to 2 with a stepwise migrate.ts runner (A19)

`SCHEMA_VERSION` is bumped 1 -> 2 and `src/model/migrate.ts` provides a pure,
stepwise `migrateBrainData(raw)` runner. Steps are keyed by their FROM version
in a registry that matches the existing `StorageAdapter.Migration` shape, so the
SAME registry serves both the adapter's load-time migration and the pure runner
used by staging. The v0 -> v1 and v1 -> v2 steps are near-identity version bumps
because every M3 contract change is ADDITIVE and OPTIONAL (the `binary-offloaded`
resolution, `manifest.backupMode`/`omissions`, and the Revision snapshot
fields); a `fillDefaults` pass guarantees a migrated brain has every collection.
A payload whose version is NEWER than this build raises `FutureSchemaError`
rather than being silently downgraded.

## Consequences

- Citations are durable against local space pressure: a user can offload PDF
  binaries and keep composing/reading from provenance metadata, re-attaching the
  verified original on demand.
- A backup self-describes its completeness via `manifest.backupMode` +
  `omissions`, so a restore (and the staging report) can reason about what a
  targeted backup intentionally left out.
- Deleting a highlight no longer forces a choice between losing composed work and
  keeping a dangling highlight; the destructive mode is reversible via a
  Revision snapshot.
- An incoming backup can never corrupt the live store: validation is isolated,
  default-reject, and only an explicit lenient override commits a suspicious
  payload, always through a migration that fills defaults.
- The first real migration path exists, so future schema changes have a tested
  stepwise runner to extend rather than an ad-hoc upgrade.
- All additions are back-compatible and verified: full Vitest suite + typecheck
  + build are green and the e2e specs (including the new
  `backup-recovery.spec.ts`) enumerate/compile via `playwright test --list`.

## OPEN

- Whether an offloaded binary should be re-fetchable from its original import
  source (a remembered path/URL) rather than requiring the user to hand it back
  is deferred; today re-attachment is an explicit sha256-verified file action.
- Whether targeted-backup omissions should drive a restore-time prompt ("this
  backup omitted revisions; keep your current ones?") vs the current silent
  coercion is an M-later UX question; today the omission tokens are recorded and
  the lenient path fills defaults.
- Whether the staging validator should attempt partial recovery of a
  hard-rejected bundle (salvaging the parseable records) is out of scope; today a
  hard reject is terminal.
