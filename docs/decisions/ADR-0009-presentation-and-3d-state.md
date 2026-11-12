# ADR-0009: Presentation state expansion + 3D density reward (D19)

- Status: ACCEPTED (M2, FEAT-003)
- Spec references: §3.4 (density-reward 3D presentation); acceptance A09-M2
  ("no unexpected camera snaps" / non-destructive hide), A14-M2; decision D19
  (persistence scope of layout/view state). Extends `PresentationState` from the
  section-20 contract.
- Relationship to ADR-0008: ADR-0008 fixes the relationship DATA shape; this
  ADR fixes the CANVAS + 3D view state the concept-network rendering reads.

## Context

M1 `PresentationState` held only `hiddenPageIds`, `hiddenRelationshipIds` and a
simple `positions` map. The M2 concept-network canvas needs more view state:
laid-out / hand-dragged 2D coordinates, a zoom scale, category squircle
boundaries, the §3.4 3D-mode flag, and per-node user drag offsets. D19
(MILESTONE-MATRIX §8) asks which of these are DURABLE (persist into
`BrainData.presentation` across reloads) versus session-only.

The binding invariant is unchanged: hiding a node or relationship is a VIEW
operation and NEVER deletes the underlying `Page`/`Relationship` (A09-M2 and the
M1 non-destructive guarantee). The density-monitor and all layout writes respect
this — `activeNodeCount()` counts non-hidden pages but the records remain.

## Decision

### 1. Fields added to `PresentationState` (all OPTIONAL, readonly)

| Field            | Shape                                            | Purpose                                             |
| ---------------- | ------------------------------------------------ | --------------------------------------------------- |
| `nodePositions`  | `Record<pageId, {x,y}>`                          | M2 canvas 2D coords (laid-out / dragged)            |
| `zoom`           | `number`                                         | canvas zoom scale (1 = default)                     |
| `categoryBounds` | `Record<categoryId, {cx,cy,rx,ry}>`              | squircle boundary ellipse per category              |
| `active3D`       | `boolean`                                        | §3.4 density-reward: 3D presentation opted-in       |
| `dragOffsets`    | `Record<pageId, {x,y}>`                          | per-node user nudge relative to the engine layout   |

`nodePositions` relates to the existing `positions` as follows: `positions` is
the M1 name and is kept for back-compat; `nodePositions` is the M2 name the
network canvas reads/writes and carries the SAME `{x,y}` shape.
`Workbench.conceptGraph()` reads `nodePositions ?? positions` so either source
resolves. New writes go to `nodePositions`.

### 2. D19 — persistence scope: these graph fields ARE durable

D19's earlier default (MILESTONE-MATRIX §8) kept M1 pane widths / line
visibility / category scope as SESSION-only view state, precisely because they
were reader-workbench chrome that should not resurrect a stale layout on reload.
We RESOLVE D19 for the new concept-network fields the OTHER way:

- `nodePositions`, `dragOffsets`, `categoryBounds`, `zoom`, `active3D` are
  **DURABLE** in `BrainData.presentation`. A hand-arranged concept map is
  content-adjacent intellectual work: losing a reader's node placement, manual
  nudges, framing zoom, or their 3D opt-in on reload would be a data-loss-like
  surprise, not a convenience reset. These persist through the adapter.
- The M1 reader-workbench view state (`paneWidths`, `linesVisible`,
  `categoryScope`) stays SESSION-only on the `Workbench` instance, unchanged by
  this ADR. The two scopes are deliberately different because their stakes
  differ: pane chrome is cheap to re-establish; a laid-out graph is not.

Because hiding stays presentation state, a durable `nodePositions` map never
causes an "unexpected camera snap": positions are restored exactly as saved, and
hide/show only toggles membership of the hidden sets (A09-M2).

### 3. §3.4 density reward (3D) — threshold + flag

The density monitor lives on the headless `Workbench`:

- `activeNodeCount()` — count of NON-hidden pages participating in the network.
- `is3DUnlocked()` — true once `activeNodeCount() >= THREE_D_UNLOCK_THRESHOLD`,
  a named constant `= 35`.
- `setActive3D(on)` / `active3D()` — write/read the durable `active3D` flag.

The threshold is a single named constant so the §3.4 rule has one source of
truth (test asserts the exact 34→locked / 35→unlocked boundary). The view only
surfaces the 3D toggle when `is3DUnlocked()` is true; the flag persists the
user's choice so re-opening a dense brain restores the 3D presentation. Hiding
nodes legitimately lowers `activeNodeCount()` back below the threshold (view
state) without deleting any `Page`.

## Why this needs no migration

Every added field is OPTIONAL and readonly, so a persisted v1
`PresentationState` (the original three fields) is a legal value of the expanded
type and reads with no code touching a missing field. `createEmptyBrainData()`
seeds sane empty defaults (`nodePositions: {}`, `zoom: 1`, `categoryBounds: {}`,
`active3D: false`, `dragOffsets: {}`) in the ONE place a BrainData is assembled
(`src/model/brain.ts`). SCHEMA_VERSION remains `1`; real migrations are M7
(ADR-0004).

## Consequences

- A reader's concept-map arrangement, zoom, category framing and 3D opt-in
  survive reloads; reader-workbench chrome does not (deliberate split).
- The non-destructive hide invariant is preserved end to end; the density
  monitor is a pure derivation over live records.
- All additions are back-compatible (verified: full Vitest suite + typecheck +
  build green).

## OPEN

- Whether `categoryBounds` should be fully derived from members on every read
  (dropping the cache) once the squircle layout engine stabilises is an M5
  tuning question.
- A per-device vs per-brain split for `zoom`/`active3D` (so the same brain can
  open flat on a phone and 3D on a desktop) is deferred to M7 responsive work.
