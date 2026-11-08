# PLAN — M0 / M1

Concise plan for the first two milestones. Taxonomy per spec section 0:
CONFIRMED / PROPOSED DEFAULT / OPEN / LATER.

## Proposed technologies (PROPOSED DEFAULT unless noted)

| Concern        | Choice                                   | ADR      |
| -------------- | ---------------------------------------- | -------- |
| Build/dev      | Vite + TypeScript (strict) + React       | —        |
| PDF engine     | pdfjs-dist (real text layer)             | ADR-0001 |
| Editor         | ProseMirror, typed `evidence` node       | ADR-0002 |
| Anchors        | portable {docId, versionHash, pageIndex, rects 0..1, text, prefix, suffix} | ADR-0003 |
| Storage        | StorageAdapter + LocalFileStorageAdapter (IndexedDB/OPFS) | ADR-0004 |
| Unit tests     | Vitest (jsdom)                           | —        |
| Runtime tests  | Playwright (chromium, real browser)      | —        |
| Delivery/Koofr | OPEN — spike in FEAT-002, impl M4         | ADR-0005 |

## M0 — scaffold (this milestone, FEAT-001)

Runnable dev app with a visible READY/ERROR state; decision log (ADR-0001..0005);
section-20 data-contract types + durable ids; storage-adapter boundary with
schema version + migration hook + safe-publication write; real PDF fixtures via
`scripts/gen-fixtures.mjs`; dual test harness (Vitest + Playwright) each with a
passing baseline. Per spec section 24 the READY state is a safeguard, not a
substitute for runtime tests.

## M0 — spikes (FEAT-002..005)

- PDF anchor create/resolve against real pdf.js geometry.
- Editor serialization round-trip (ProseMirror doc JSON ↔ evidence).
- Koofr access spike (auth + CORS from a browser) — honest report (ADR-0005).

## M1 — first vertical slice

Import a PDF → render with selectable text → create a text highlight (portable
anchor) → add a comment (empty comment valid) → save to the local adapter →
reopen and re-resolve the anchor. Three-pane workspace shell.

## Critical risks

- pdf.js text-layer geometry stability across zoom/rotation (rotated fixture
  exists to pin this).
- Anchor re-resolution after source edition drift (`mismatched` state).
- Koofr/WebDAV CORS + auth feasibility from a browser (blocking for delivery).
- IndexedDB/OPFS quota + durability for large PDFs.

## Decisions required now

- Confirm the PROPOSED DEFAULT stack (ADRs 0001–0004) or override.
- Accept OPEN status of delivery/hosting (ADR-0005) pending the Koofr spike.
