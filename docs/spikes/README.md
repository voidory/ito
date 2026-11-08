# M0 risk spikes — summary

The three M0 risk spikes (spec sections 22 M0 / 26, FEAT-002) each produced BOTH
a written report and an automated runtime test, not a concept description. All
"pass" claims below are backed by executed browser/runtime tests.

| Spike                  | Report                                         | Test (runtime)                         | Outcome            | Gates M1? |
| ---------------------- | ---------------------------------------------- | -------------------------------------- | ------------------ | --------- |
| PDF anchor round-trip  | [pdf-anchor.md](./pdf-anchor.md)               | `e2e/pdf-anchor.spec.ts` (chromium)    | **PASS**           | Yes ✅    |
| Editor serialization   | [editor-serialization.md](./editor-serialization.md) | `src/editor/serialize.test.ts` (Vitest) | **PASS**           | Yes ✅    |
| Koofr access           | [koofr-access.md](./koofr-access.md)           | `scripts/koofr-probe.mjs` (`npm run koofr-probe`) | **UNTESTABLE (c)** | No        |

## How to reproduce

```bash
npm run test       # Vitest — includes the editor-serialization round-trip
npm run test:e2e   # Playwright/chromium — includes the pdf-anchor round-trip
npm run koofr-probe # real network probe (reads creds from env; none required)
```

## Outcomes in brief

1. **PDF anchor round-trip — PASS.** A real pdf.js text layer over the committed
   3-page fixture; a portable ADR-0003 anchor created from a real selection
   resolves back to the same glyphs after reload (exact), zoom 2.5× (x stable to
   < 1e-4, y to ~7e-4), and a resize/re-render at 1.0× (x stable; y drifts ~2%
   from glyph-box rounding, still the same text). Version-hash mismatch surfaces
   explicitly. Limitations: scanned/OCR PDFs and cross-edition reflow are out of
   scope; fuzzy re-anchor thresholds remain OPEN (M2).

2. **Editor serialization — PASS.** A ProseMirror composition (prose + typed
   `evidence` nodes) serialized to the structured JSON model, the editor
   discarded, and a fresh editor re-hydrated from JSON alone, with composition
   order, quote identities, full provenance (incl. portable anchor), and
   formatting preserved exactly — proving the JSON, not the editor HTML/DOM, is
   the source of truth. Limitation: the full formatting checklist is OPEN (D04).

3. **Koofr access — UNTESTABLE (outcome c), honestly reported.** No Koofr
   credentials exist in the sandbox, so authenticated list/read/write could not
   be exercised. The endpoint is reachable (HTTP 401, not a network error) but
   the unauthenticated CORS preflight returned **no `access-control-*`
   headers** — concrete evidence against seamless static-only browser access. We
   make no verified/working claim. Fallbacks (manual import; authenticated
   intermediary/proxy; packaged app) and consequences are documented, and the
   result is recorded as the D08 / ADR-0005 decision input.

## M1 gating decision

- The **PDF** and **editor** spikes GATE M1 and both **PASS** → the two hardest
  technical risks are retired with runtime evidence.
- The **Koofr** spike does **not** gate M1 (Koofr implementation is M4); its
  untestable-with-negative-CORS-signal result is recorded against ADR-0005.

**M1 is CLEARED to proceed.**
