# M0 spike: editor evidence serialization (JSON is source of truth)

- Status: **PASS** (executed under Vitest / jsdom)
- Feature: FEAT-002 · Spec: sections 9, 20, 22 (M0), 26 · ADR-0002, decision D04
- Code: `src/editor/schema.ts`, `src/editor/serialize.ts`
- Test: `src/editor/serialize.test.ts` (Vitest)

## Goal

Prove the spec invariant that **evidence serialization is independent of DOM
coordinates**: a composed subject-page document (prose interspersed with typed
evidence nodes) can be serialized to the structured JSON data model, the editor
discarded, and a fresh editor re-hydrated from the JSON ALONE, with composition
order, quote identities, provenance, and formatting surviving exactly.

## Method

1. `src/editor/schema.ts` defines a ProseMirror schema with `doc`, `paragraph`,
   `heading`, `text`, `strong`/`em` marks, and — the point of the spike — a
   typed **`evidence`** node. The evidence node is an inline `atom` whose attrs
   carry the `EvidenceInstance` provenance:
   `{ evidenceId, sourceId, annotationId, quotedText, anchor (portable, ADR-0003),
   mode: "live" | "copy" }`. It stores NO pixel/DOM offsets.
2. `src/editor/serialize.ts` provides `serializeState` (doc → plain JSON, i.e.
   `Page.documentJson`), `hydrateState` (JSON → fresh `EditorState`), plus
   `outline` and `collectEvidence` helpers that read logical content/provenance
   in document order (never DOM geometry).
3. `src/editor/serialize.test.ts` builds a composition — a heading, a paragraph
   mixing plain + **bold** + *italic* text with an inline evidence node, and a
   second paragraph with another evidence node (`mode: copy`) — serializes it,
   round-trips the JSON through `JSON.parse(JSON.stringify(...))`, **discards the
   original editor**, re-hydrates a fresh editor from the JSON only, and asserts
   fidelity.

## Executed result

`npm run test` — 3/3 editor-serialization tests pass. Assertions that held:

- **Composition order** is identical before/after. The re-hydrated outline is
  exactly:
  ```
  h2: On foxes and dogs
  As noted, strong(the author) argues ⟦evidence:evi_one⟧ and later em(qualifies it).
  Then the subject ⟦evidence:evi_two⟧ to close.
  ```
  Writing and evidence interleave in the same positions.
- **Quote identities + full provenance** survive exactly: `evidenceId`,
  `annotationId`, `sourceId`, `mode`, and `quotedText` all match the originals
  (`collectEvidence(before)` deep-equals `collectEvidence(after)`).
- **Portable anchor** survives intact and is DOM-independent — only normalized
  rects (0..1), prefix/suffix, page index; the JSON string contains no
  `clientX/clientY/offsetTop/offsetLeft/getBoundingClientRect/px` tokens.
- **Formatting** survives: `strong` and `em` marks re-hydrate on the same runs.
- **Stability**: re-serializing the re-hydrated doc yields byte-identical JSON.
- The evidence node is confirmed to be an inline `atom`, so its meaning lives in
  the JSON attrs, not in editable child text the DOM could diverge from.

Because the fresh editor is built from the serialized JSON alone (the old
`EditorState` is never read past serialization), this demonstrates the JSON —
not the editor HTML/DOM — is the durable source of truth (ADR-0002).

## Limitations

- **Formatting checklist is OPEN (decision D04 / ADR-0002).** The spike proves
  round-trip fidelity for the marks/nodes it uses (paragraph, heading,
  strong, em, evidence). The FULL formatting set (lists, blockquotes, links,
  code, nested structures) and the editor plugin set are not yet decided and are
  out of M0–M1 scope.
- Live-vs-copy *behaviour* (re-resolving a `live` evidence node against its
  source when the source changes) is only represented as a flag here; the
  resolution/sync logic is later-milestone work.
- Schema migrations across `schemaVersion` bumps are not exercised by this
  spike (handled at the storage layer).

## Conclusion

Evidence serialization through the structured JSON model is validated and is
DOM-coordinate independent. **This spike clears the editor risk gate for M1.**
