# ADR-0003: Portable anchor fields

- Status: PROPOSED DEFAULT
- Spec references: section 10.1 (portable anchors)

## Context

A highlight must survive re-rendering, zoom changes, and re-opening the same
source in a different edition. It therefore cannot store DOM or pixel
coordinates. It needs enough context to re-anchor if the text layer shifts.

## Decision

A portable text anchor stores exactly:

```
{
  docId: SourceId,
  sourceVersionHash: SourceVersionHash,
  pageIndex: number,
  rects: NormalizedRect[],   // all coordinates in [0, 1] relative to page box
  selectedText: string,
  prefix: string,            // short text immediately before the selection
  suffix: string             // short text immediately after the selection
}
```

See `src/model/types.ts` → `TextAnchor`. Multi-page scope uses `ScopeAnchor`.

## Consequences

- Anchors are DOM-independent and portable across renders/editions.
- Resolution against a loaded source is explicit via `AnchorResolution`
  (`resolved` | `unresolved` | `mismatched`); mismatches surface rather than
  silently dropping, satisfying the "unresolved anchors explicit" invariant.
- `sourceVersionHash` lets us detect edition drift and drive re-anchoring.

## OPEN

- The exact re-anchoring algorithm (prefix/suffix fuzzy match) and its
  thresholds (M1 spike / M2 implementation).
- Normalization reference box for rotated pages (tracked with the rotated
  fixture).
