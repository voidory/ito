# ADR-0002: Editor = ProseMirror with a typed `evidence` node

- Status: PROPOSED DEFAULT
- Spec references: section 9 (composition & evidence), decision D04

## Context

Subject pages compose prose with embedded evidence (quotes from sources). We
need the composed content to be the durable source of truth, independent of
rendered HTML/DOM coordinates, and to carry evidence as a first-class, typed
construct rather than styled text.

## Decision

Use ProseMirror. Define a typed `evidence` node in the schema whose attributes
reference an `EvidenceInstance` (annotation id + quoted-text snapshot). The
ProseMirror **document JSON** is the source of truth and is what we persist
(`Page.documentJson`). We never derive meaning from the editor's HTML/DOM.

## Consequences

- Evidence serialization is independent of DOM coordinates (a spec invariant):
  an EvidenceInstance stores the annotation id + text snapshot, never pixel
  offsets.
- Document JSON round-trips across renders and app versions.
- We maintain a ProseMirror schema and node spec (M2 work); M0 only records the
  decision and the model types that back it.

## OPEN

- Full schema (marks, lists, headings) and the editor plugin set.
- Collaborative editing / history granularity (out of M0-M1 scope).
