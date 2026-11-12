# ADR-0008: Connecting-hub topology — reconciling the 2-page edge with the N-endpoint star (D20)

- Status: ACCEPTED (M2, FEAT-003)
- Spec references: §3.1 ("The Bump" hub glyph), §3.2 (watercolor multiply),
  §3.4; acceptance A13-M2; decision D20 (line routing at scale). Builds on the
  pure geometry shipped in FEAT-002 (`src/network/hub.ts`, `src/network/blend.ts`).
- Supersedes nothing; it is ADDITIVE over the M1 `Relationship` contract.

## Context

M1 modelled a relationship in the concept network as a DIRECTED 2-page edge:
`Relationship { id, fromPageId, toPageId, kind, label, createdAt }`. M2
introduces the "Connecting Page" — a single relationship that can connect N
pages at once, rendered as the hub glyph (§3.1):

- **N = 2** → a smooth double-pointed translucent **lens** centred on the
  midpoint of the two endpoints.
- **N >= 3** → a multi-pointed arched **star**, one outer vertex pointing toward
  each endpoint node, concave between points (A13-M2). The geometry already
  exists and is unit-tested in `src/network/hub.ts` (`hubPath` returns
  `kind: "lens" | "star"`).

We must reconcile the persisted 2-page `Relationship` with the N-endpoint hub
WITHOUT a schema migration (SCHEMA_VERSION stays 1; real migrations are M7 per
ADR-0004 and MILESTONE-MATRIX §6), so existing v1 brains keep loading.

## Decision

### 1. Keep `Relationship` as the record; add an OPTIONAL N-endpoint list

`Relationship` remains the single record type for a Connecting Page. We add an
OPTIONAL, readonly `endpointPageIds?: readonly PageId[]` alongside the existing
`fromPageId`/`toPageId`. The 2-page edge is the **degenerate case**:

- When `endpointPageIds` is present it is authoritative (N can be 2 or more).
- When it is absent, the endpoints are exactly `[fromPageId, toPageId]`.

For every relationship we also keep `fromPageId`/`toPageId` populated (for an
N-endpoint hub, `from` = first endpoint, `to` = last) so any v1 reader or query
that only knows the 2-page shape still sees a valid edge. `kind` and `label`
are unchanged.

### 2. ONE normalized accessor: `relationshipEndpoints(rel)`

The rest of the app NEVER branches on whether `endpointPageIds` is present. It
reads endpoints through a single exported normalizer in `src/model/relationship.ts`:

```ts
relationshipEndpoints(rel) === rel.endpointPageIds ?? [rel.fromPageId, rel.toPageId]
```

`isStarHub(rel)` derives the lens-vs-star rule from the normalized count
(`length >= 3`), so the topology mapping to §3.1 / A13-M2 lives in exactly one
place. The headless `Workbench.conceptGraph()` tags each link `topology: "lens"
| "star"` using this accessor; the view (FEAT-004/005/006) feeds those endpoints
straight into `hubPath`.

### 3. Derived, cached hub fields (`hubPosition`, `blendColor`) are OPTIONAL

Two derived hints are added as OPTIONAL fields:

- `hubPosition?: { x; y }` — the hub centroid in 2D canvas coords, recomputable
  from the endpoints' laid-out positions (so it is a CACHE, not a source of
  truth).
- `blendColor?: string` — the watercolor MULTIPLY (§3.2) of the DISTINCT
  category colors the endpoints belong to, via `deriveHubBlendColor`
  (`src/network/blend.ts`). The Workbench derives and stores it on create; the
  graph re-derives it on read if absent. It is never a hand-picked value, so
  overlaps stay visually consistent and order-independent.

### 4. Line routing at scale (D20)

D20 (MILESTONE-MATRIX §8) asks for the policy on many overlapping connections.
The hub model is the answer in the making: an N-endpoint Connecting Page draws
ONE hub glyph with N short legs instead of N·(N−1)/2 pairwise lines, which
reduces clutter structurally. Detailed density treatments (bundling, fade,
hover-reveal) remain D20's rendering concern for FEAT-005/006; this ADR fixes
the DATA shape those treatments consume. The §3.4 density reward (3D) is
governed separately by ADR-0009.

## Why this needs no migration

Every added field (`endpointPageIds`, `hubPosition`, `blendColor`) is OPTIONAL
and readonly. A persisted v1 `Relationship` (from/to only) is a legal value of
the new type and `relationshipEndpoints` yields its 2-page endpoints with no
code path reading a missing field. `Category.colorCode` is likewise optional
with a documented default (`DEFAULT_CATEGORY_COLOR`), so a v1 category still
blends (as the default pigment) rather than throwing. Because nothing required
changed, SCHEMA_VERSION remains `1`; version bumps + migrations are deferred to
M7 (ADR-0004).

## Consequences

- One record type, one accessor: the lens/star distinction is derived, never
  stored as a flag, so it cannot drift.
- `blendColor` is reproducible from category colors; storing it is an
  optimisation the graph can always recompute.
- Back-compat is structural: v1 data and all M1 tests load and pass unchanged
  (verified: full Vitest suite + typecheck + build green).

## OPEN

- Whether a Connecting Page should itself be promotable to a full subject Page
  (so a hub can carry its own document) is an M5 graph question, out of scope.
- Directionality for N >= 3 (is a star ever directed?) is deferred; `kind`
  carries the semantic and `from`/`to` stay as the degenerate ordering.
