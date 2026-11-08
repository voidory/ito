# ADR-0004: Storage-adapter boundary + schema/version strategy

- Status: PROPOSED DEFAULT
- Spec references: sections 14, 15, 20; decision D09

## Context

The spec requires strict data/app separation behind a pluggable storage layer,
with safe publication (no partial/corrupt published state) and a path to a
Koofr/WebDAV back-end later. Schema evolution must be supported without
breaking existing brains.

## Decision

- Define a `StorageAdapter` interface (`src/storage/StorageAdapter.ts`) covering
  read/list/write of structured brain records and binary assets, a
  schema-version check, and a migration hook.
- Implement `LocalFileStorageAdapter` for M1, backed by IndexedDB (via `idb`)
  for structured records and binary blobs (PDF bytes). OPFS may be substituted
  for large blobs later behind the same interface.
- Store `schemaVersion` on `BrainManifest`. Reading data with a newer version
  than the build supports throws `SchemaVersionError`; older versions run
  through registered stepwise migrations.
- Writes use the section-15 safe-publication shape even locally: write to a
  staged key, read-back-and-verify (`WriteVerificationError` on mismatch), then
  advance the published pointer LAST in a separate transaction.
- Koofr/WebDAV adapter is DEFERRED to M4; the M0 spike only assesses access
  (see ADR-0005 / FEAT-002).

## Consequences

- The app never touches IndexedDB/OPFS/WebDAV directly; back-ends are swappable.
- A crash mid-write leaves the previous published pointer intact.
- Unresolved/mismatched anchors are surfaced via explicit resolution hooks
  (`resolveAnnotationAgainstSource`).

## OPEN

- OPFS vs IndexedDB blob thresholds and quota handling.
- Concrete migration functions as the schema evolves past v1.
- Conflict handling for the eventual remote (Koofr) adapter.
