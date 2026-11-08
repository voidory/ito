# BACKLOG — M2 through M7

Scope kept visible beyond the current milestone, mapped to spec milestones and
the decision log (D01–D18). Status: planned / later. Nothing here is in scope
for M0-M1; it is recorded so the long arc stays coherent.

## M2 — Reader + annotation

- Render PDF pages with real pdf.js text layer. (D01, ADR-0001)
- Create text highlights → portable anchors; multi-page scope anchors. (D02, D03, ADR-0003)
- Annotation comments (empty comment valid). (D05)
- Persist annotations via LocalFileStorageAdapter; reopen + re-resolve. (D09, ADR-0004)

## M3 — Subject pages + evidence composition

- ProseMirror editor with typed `evidence` node; document JSON source of truth. (D04, ADR-0002)
- Insert evidence from annotations; quoted-text snapshot. (D06)
- Derived citation status per (annotation, destination page) pair. (D07)

## M4 — Remote storage (Koofr/WebDAV) + delivery

- Koofr/WebDAV StorageAdapter behind the existing interface. (D08, D09, ADR-0004, ADR-0005)
- Safe publication against a remote (staged write, verify, pointer last). (D10)
- Hosting/delivery decision resolved from the FEAT-002 spike. (D08, ADR-0005)

## M5 — Concept network

- Pages, relationships, tentative associations as a graph. (D11, D12)
- Graph `hide` as presentation state only — never deletes content. (D13)
- Categories grouping pages by id — never duplicating pages. (D14)

## M6 — Capture, revisions, publication

- Captures → structured pages. (D15)
- Named revisions; publicationRevision advancement. (D16)
- Publication/export flow. (D17)

## M7 — Hardening

- Migrations for schema evolution past v1. (D18, ADR-0004)
- Performance on large PDFs; OPFS blob strategy.
- Accessibility + keyboard flows across the three-pane workspace.
