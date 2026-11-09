# REQUIREMENT → TEST MAP

Maps spec acceptance IDs (A01–A24 acceptance, R01–R20 requirements, N01–N08
non-functional) to the milestone that delivers them and the test that covers
them. Status: implemented / planned / deferred.

Test kinds: `unit` (Vitest), `e2e` (Playwright chromium, real browser), `n/a`.

## Acceptance (A01–A24)

| ID  | Requirement (summary)                              | Milestone | Test kind | Test / location                          | Status      |
| --- | -------------------------------------------------- | --------- | --------- | ---------------------------------------- | ----------- |
| A01 | App boots to a visible READY state in a browser    | M0        | e2e       | `e2e/ready.spec.ts`                      | implemented |
| A02 | Startup failure surfaces a visible ERROR state     | M0        | e2e       | planned (`e2e/error.spec.ts`)            | planned     |
| A03 | Import a PDF source                                 | M1        | e2e       | `e2e/reader-workbench.spec.ts`           | implemented |
| A04 | Render PDF with a real selectable text layer       | M2        | e2e       | planned                                  | planned     |
| A05 | Select text and commit a highlight                 | M2        | e2e       | planned                                  | planned     |
| A06 | Highlight stored as a portable anchor (0..1 rects) | M2        | unit+e2e  | planned; anchor type `src/model`         | planned     |
| A07 | Add an annotation comment (empty comment valid)    | M2        | unit      | `src/test/model.test.ts` (type) + e2e    | planned     |
| A08 | Multi-page scope annotation                         | M2        | unit      | planned                                  | planned     |
| A09 | Save to local storage adapter                      | M1        | unit+e2e  | `workbench.test.ts` + reader-workbench   | implemented |
| A10 | Reopen and re-resolve anchors                       | M2        | unit+e2e  | planned                                  | planned     |
| A11 | Unresolved/mismatched anchor shown explicitly       | M2        | unit      | `AnchorResolution` + resolve hook         | planned     |
| A12 | Create a subject page                               | M3        | e2e       | planned                                  | planned     |
| A13 | Insert evidence from an annotation                  | M3        | e2e       | planned                                  | planned     |
| A14 | Evidence serialized independent of DOM coords       | M3        | unit      | ProseMirror doc JSON round-trip (planned) | planned     |
| A15 | Citation status derived per annotation-dest pair    | M3        | unit      | `src/test/model.test.ts`                 | implemented |
| A16 | Concept network graph of pages/relationships        | M2        | e2e+unit  | `e2e/concept-network.spec.ts`, `e2e/three-d.spec.ts`; `src/network/scene.test.ts`, `src/app/threeScene.map.test.ts` | implemented (M2; e2e deferred §9) |
| A17 | Graph `hide` never deletes content                  | M2        | e2e+unit  | `src/app/workbench.network.test.ts`; `e2e/three-d.spec.ts` (hidden nodes excluded) | implemented (M2) |
| A18 | Categories group pages without duplicating them     | M2        | unit+e2e  | `Category.memberPageIds`; `src/network/scene.test.ts`, `e2e/concept-network.spec.ts` (A10-M2) | implemented (M2) |
| A19 | Tentative associations distinct from relationships  | M5        | unit      | planned                                  | planned     |
| A20 | Safe publication (no partial published state)       | M4        | unit      | `src/test/storage.test.ts` (planned)     | planned     |
| A21 | Named revisions advance publicationRevision         | M6        | unit      | planned                                  | planned     |
| A22 | Koofr/WebDAV remote adapter                          | M4        | unit      | planned                                  | deferred    |
| A23 | Schema migration across versions                     | M7        | unit      | migration hook (planned)                 | planned     |
| A24 | Delivery/hosting resolved                            | M4        | n/a       | ADR-0005 / FEAT-002 spike                | deferred    |

## Requirements (R01–R20)

| ID  | Requirement (summary)                              | Milestone | Test kind | Status      |
| --- | -------------------------------------------------- | --------- | --------- | ----------- |
| R01 | Durable unique string IDs on every record          | M0        | unit      | implemented |
| R02 | pdfjs-dist, not iframe + fake-HTML layer            | M0        | n/a       | implemented (ADR-0001) |
| R03 | Portable anchor field set                          | M0        | unit      | implemented (type) |
| R04 | ProseMirror doc JSON is source of truth            | M0        | n/a       | implemented (ADR-0002) |
| R05 | StorageAdapter boundary; app never touches IDB      | M0        | unit      | implemented |
| R06 | schemaVersion on BrainManifest                     | M0        | unit      | implemented |
| R07 | Migration hook                                     | M0        | unit      | implemented (hook) |
| R08 | Write-then-verify, publish pointer last            | M1        | unit      | implemented (adapter) |
| R09 | Annotation vs evidence are distinct records        | M0        | unit      | implemented (types) |
| R10 | No standalone isCited boolean                       | M0        | unit      | implemented |
| R11 | Empty annotation comment valid                     | M0        | unit      | implemented (type) |
| R12 | Real PDF fixtures (3+ pages, multi-col, rotated)   | M0        | unit      | implemented |
| R13 | Reproducible fixture generation script             | M0        | n/a       | implemented |
| R14 | Vitest harness                                     | M0        | unit      | implemented |
| R15 | Playwright real-browser harness                    | M0        | e2e       | implemented |
| R16 | Highlighting validated first (order binding)        | M1        | e2e       | implemented (`reader-workbench.spec.ts`) |
| R17 | Continuous page editing validated second            | M1        | e2e       | implemented (`subject-editor.spec.ts`) |
| R18 | Context-preserving view transitions validated third | M1        | e2e       | implemented (`workspace.spec.ts`) |
| R19 | Making annotations never auto-creates nodes/pages   | M1        | e2e       | implemented (`reader-workbench.spec.ts`) |
| R20 | Categories never duplicate pages                    | M2        | unit+e2e  | implemented (`Category.memberPageIds` reference-by-id; `src/network/scene.test.ts`, `src/app/workbench.network.test.ts`) |

## M1 reading-workbench behaviours (FEAT-003, spec section 6)

These are the behavioural requirements validated for the M1 reading workbench.
Every row is covered by a REAL-browser Playwright test in
`e2e/reader-workbench.spec.ts` (real pdf.js text, real selection, real
persistence) unless noted; the derived citation state machine is additionally
unit-tested in `src/model/citation.test.ts` and `src/app/workbench.test.ts`.

| ID  | Behaviour                                                        | Test kind | Status      |
| --- | --------------------------------------------------------------- | --------- | ----------- |
| R01 | Selection exposes ONLY compact highlight/color controls         | e2e       | implemented |
| R02 | Quiet comments: hidden in reading, revealed on explicit access  | e2e       | implemented |
| R03 | One 3-page range = a single logical annotation identity         | e2e+unit  | implemented |
| R04 | Micro-highlights inside a range stay independent                | e2e+unit  | implemented |
| R05 | "Associate with subject…" → DOTTED link, no page edit           | e2e+unit  | implemented |
| R07 | Same annotation solid for one subject, tentative for another    | e2e+unit  | implemented |
| R09 | Soft, uneven, rounded commit overlay hugging line fragments     | e2e       | implemented |
| R11 | prefers-reduced-motion AND in-app suppress-motion honoured      | e2e       | implemented |
| R12 | Failed local save retains draft + actionable error              | e2e+unit  | implemented |
| R14 | Annotations + comments + range + links persist across reopen    | e2e+unit  | implemented |
| R15 | Accessible (menu-button) alternative to the right-click menu    | e2e       | implemented |
| R16 | Each range page carries a BORDER (not a tint wash)              | e2e       | implemented |
| R17 | Range filterable from micro-highlights; shows "pp. X-Y"         | e2e       | implemented |
| R18 | Closed highlights tab reserves ZERO sidebar width               | e2e       | implemented |
| R20 | Multi-line overlay = real line fragments, glyphs stay legible   | e2e       | implemented |
| INV | Annotating creates ZERO Page/Relationship/Category records      | e2e+unit  | implemented |

D15 decisions recorded before claiming the interactions complete:
`docs/decisions/ADR-0006-range-annotation-interactions.md` (range gesture
granularity, whole-page border styling/hit area, range-citation representation)
and `docs/decisions/ADR-0007-association-citation-state.md` (last-citation
deletion policy, accessible association control).

## M1 integrated-workspace behaviours (FEAT-005, spec sections 7.3, 8.2, 10.2)

The THIRD item in the binding validation order: context-preserving view/layout
transitions. Every row is covered by a REAL-browser Playwright test in
`e2e/workspace.spec.ts` (real pdf.js text, real selection, real ProseMirror,
real persistence); the presentation-only view-state invariants are additionally
unit-tested in `src/app/workbench.workspace.test.ts`. The full M0+M1
implemented/pending/unsupported matrix lives in `docs/MILESTONE-MATRIX.md`.

| ID  | Behaviour                                                          | Test kind | Status      |
| --- | ----------------------------------------------------------------- | --------- | ----------- |
| 8.2 | Paper A · subject · Paper B simultaneous, editor never behind modal | e2e     | implemented |
| 8.2 | Adjustable pane widths + independent per-pane scrolling            | e2e      | implemented |
| 8.2 | Switch a reader pane to a THIRD paper, keep the subject             | e2e+unit | implemented |
| 8.2 | Narrow-screen responsive flow STUB (not a squeezed miniature)      | e2e      | implemented (stub) |
| R19 | Tab/layout transitions preserve passage + draft + pane config      | e2e+unit | implemented |
| R19 | No forced camera motion / changed passage on transition            | e2e      | implemented |
| A06 | Follow a quote in the workspace → exact source, page not replaced  | e2e      | implemented |
| A08 | Passage-to-evidence line DATA (section 10.2) relates source↔evidence | e2e+unit | implemented |
| R08 | Line visibility toggle = presentation only, never deletes links    | e2e+unit | implemented |
| N03 | Library→Reader→workspace transitions preserve category scope        | e2e+unit | implemented |
| N08 | Transitions preserve source identity + a meaningful passage         | e2e+unit | implemented |

D-items proposed from FEAT-005 (D19–D22) are recorded in
`docs/MILESTONE-MATRIX.md` section 8.

## M2 concept-network foundation (FEAT-003, spec section 5 data contract + §3.1/§3.2/§3.4)

FEAT-003 delivers the additive data-contract extensions, the hub-topology and
presentation/3D-state decisions (ADR-0008, ADR-0009), and the headless Workbench
concept-network transitions. There is NO rendering here (FEAT-004/005/006), so
every behaviour below is covered by REAL Vitest tests of the headless/pure logic
(the Playwright e2e the later features add runs in the publishing environment;
it cannot run in the sandbox — see `docs/MILESTONE-MATRIX.md` §9). "N06-M2"
denotes the M2 transient-placeholder behaviour and is distinct from the N06
non-functional large-PDF row below.

| ID     | Behaviour                                                           | Test kind | Test / location | Status      |
| ------ | ------------------------------------------------------------------- | --------- | --------------- | ----------- |
| A09-M2 | Graph `hide` presentation-only; never deletes a Page/Relationship   | unit      | `src/app/workbench.network.test.ts` | implemented |
| A13-M2 | N=2 lens vs N>=3 star hub topology derived from endpoints            | unit      | `workbench.network.test.ts`; `src/model/relationship.test.ts`; `src/network/hub` | implemented |
| A14-M2 | Category colorCode persists; hub blendColor derived (§3.2 multiply)  | unit      | `workbench.network.test.ts`; `src/network/blend.test.ts` | implemented |
| N06-M2 | Transient "not connected yet" placeholder creates ZERO graph records | unit      | `workbench.network.test.ts` | implemented |
| §3.4   | Density reward: 3D unlocks at 35 active nodes; opt-in flag durable   | unit      | `workbench.network.test.ts` | implemented |
| ADD    | Additive schema: v1 Category/Relationship/PresentationState load; SCHEMA_VERSION=1 | unit | `src/model/brain.test.ts`; `src/test/model.test.ts` | implemented |
| NORM   | One `relationshipEndpoints(rel)` accessor reconciles 2-page + N-endpoint | unit  | `src/model/relationship.test.ts` | implemented |

Decisions recorded: `docs/decisions/ADR-0008-connecting-hub-topology.md`
(reconciling the 2-page edge with the N-endpoint star; addresses D20) and
`docs/decisions/ADR-0009-presentation-and-3d-state.md` (PresentationState
expansion + §3.4 3D reward; resolves D19).

## M2 concept-network RENDERING (FEAT-004, spec §3 — SVG NodesCanvas)

FEAT-004 adds the runtime 2D scene (`src/app/NodesCanvas.tsx`) driven by the
real force-directed layout over LIVE Workbench records (pure mapper
`src/network/scene.ts`). The rendering/interaction rows below are covered by the
real-browser Playwright spec `e2e/concept-network.spec.ts` (runs in the
publishing environment; the sandbox cannot run Chromium — see
`docs/MILESTONE-MATRIX.md` §9) AND, so the sandbox proves correctness headlessly,
by `src/network/scene.test.ts` (pure graph→props mapping) and
`src/app/nodesCanvas.render.test.ts` (jsdom render of the real component against
a real Workbench).

| ID     | Behaviour                                                             | Test kind  | Test / location | Status |
| ------ | --------------------------------------------------------------------- | ---------- | --------------- | ------ |
| A13-M2 | 2-endpoint → lens hub; >=3-endpoint → star hub (count>=3), vertices point toward nodes | e2e + unit | `e2e/concept-network.spec.ts`; `src/network/scene.test.ts`; `src/app/nodesCanvas.render.test.ts` | implemented (e2e deferred §9) |
| A09-M2 | Nodes render inside their category squircle bounds; idle positions stable (no forced camera motion) | e2e + unit | `e2e/concept-network.spec.ts`; `src/network/scene.test.ts` | implemented (e2e deferred §9) |
| A10-M2 | A node in two categories renders in the intersection of BOTH squircles | e2e + unit | `e2e/concept-network.spec.ts`; `src/network/scene.test.ts` | implemented (e2e deferred §9) |
| A14-M2 | A category-to-category reference renders a `category-link` between boundaries (data-driven) | e2e + unit | `e2e/concept-network.spec.ts`; `src/network/scene.test.ts`; `src/app/nodesCanvas.render.test.ts` | implemented (e2e deferred §9) |
| §3.2   | `.category-squircle-fill` multiply blend + `#watercolor-turbulent-edge` filter; dotted-dashed border | e2e + unit | `src/app/network.css`; `src/app/nodesCanvas.render.test.ts` | implemented (e2e deferred §9) |
| §3.1   | Clicking a hub opens the connecting-page label surface                | e2e        | `e2e/concept-network.spec.ts` | implemented (e2e deferred §9) |

## M2 Files / Nodes view switch (FEAT-005, spec §3.3)

FEAT-005 adds the top-level Files/Nodes switch. The Workbench owns a session
`viewMode` (default `files`, no durable record); the shell renders a visible
`view-switch`; `categoryScope` is shared across the switch and filters the Nodes
canvas (no scope = global network; a scope = that category's squircle + its
overlapping network, via the pure `filterGraphToScope`). N06-M2: the Nodes view
for an UNCONNECTED PDF shows a transient `node-placeholder` that persists
nothing. Rows are covered by the real-browser `e2e/view-switch.spec.ts` (runs in
the publishing environment; sandbox cannot run Chromium — see
`docs/MILESTONE-MATRIX.md` §9) AND, for headless proof, by
`src/app/workbench.view.test.ts` and `src/app/nodesCanvas.render.test.ts`.

| ID     | Behaviour                                                             | Test kind  | Test / location | Status |
| ------ | --------------------------------------------------------------------- | ---------- | --------------- | ------ |
| §3.3   | `view-switch` toggles Files (Library) <-> Nodes (canvas); viewMode round-trips; opening a PDF from Files still launches the Reader | e2e + unit | `e2e/view-switch.spec.ts`; `src/app/workbench.view.test.ts` | implemented (e2e deferred §9) |
| §3.3   | `categoryScope` shared across the switch; Nodes with a scope shows only that category's squircle + overlapping network | e2e + unit | `e2e/view-switch.spec.ts`; `src/app/workbench.view.test.ts`; `src/app/nodesCanvas.render.test.ts` | implemented (e2e deferred §9) |
| N06-M2 | Nodes view for an unconnected PDF renders a transient "Not connected yet" placeholder; clicking creates ZERO graph records (no DB write) | e2e + unit | `e2e/view-switch.spec.ts`; `src/app/workbench.view.test.ts`; `src/app/nodesCanvas.render.test.ts` | implemented (e2e deferred §9) |

## M2 §3.4 3D dimensional shift (FEAT-006, spec §3.4 — the density reward)

FEAT-006 adds the §3.4 secret 3D dimensional shift, staged last and optional.
At `activeNodeCount() >= 35` (`THREE_D_UNLOCK_THRESHOLD`, FEAT-003) a subtle
glowing `enter-3d` prompt is revealed; activating it flips the DURABLE `active3D`
flag (ADR-0009) and mounts a Three.js WebGL scene (`src/app/ThreeScene.tsx`)
rendering the SAME live `conceptGraph()` as the 2D canvas — nodes as glowing
stellar particles, categories as translucent 3D bubble hulls, relationships as
faint glyphs, in watercolor fog, with orbit navigation. A WebGL guard falls back
to a visible 2D notice rather than crashing. The graph→3D mapping is the pure,
Vitest-covered `mapGraphTo3D` (`src/app/threeScene.map.ts`) so 2D and 3D stay in
parity with no duplicated hardcoded scene. Rows are covered by the real-browser
`e2e/three-d.spec.ts` (host-run in the publishing environment; the sandbox
cannot run Chromium/WebGL — see `docs/MILESTONE-MATRIX.md` §9) AND, for headless
proof, by `src/app/threeScene.map.test.ts` plus the FEAT-003 density tests in
`src/app/workbench.network.test.ts`.

| ID     | Behaviour                                                             | Test kind  | Test / location | Status |
| ------ | --------------------------------------------------------------------- | ---------- | --------------- | ------ |
| §3.4   | `enter-3d` prompt ABSENT below 35 active nodes, PRESENT at >= 35 (density reward); degrades to a static control under suppress-motion | e2e + unit | `e2e/three-d.spec.ts`; `src/app/threeScene.map.test.ts` (revealPresentation); `src/app/workbench.network.test.ts` | implemented (e2e deferred §9) |
| §3.4   | Activating mounts the Three.js WebGL scene (`three-canvas`) rendering the live graph as particles + translucent 3D hulls + watercolor fog, with orbit navigation; graceful 2D fallback (`three-fallback`) when WebGL unavailable | e2e + unit | `e2e/three-d.spec.ts`; `src/app/threeScene.map.test.ts` (mapGraphTo3D) | implemented (e2e deferred §9) |
| §3.4   | 3D reads the SAME live `conceptGraph()` as 2D; entering/exiting mutates ZERO graph records; exit returns to the 2D NodesCanvas | e2e + unit | `e2e/three-d.spec.ts`; `src/app/threeScene.map.test.ts` (footprint parity, hidden-node exclusion) | implemented (e2e deferred §9) |
| A16    | Full concept-network graph of pages/relationships delivered across 2D + 3D | e2e + unit | `e2e/concept-network.spec.ts`, `e2e/three-d.spec.ts`; `src/network/scene.test.ts`, `src/app/threeScene.map.test.ts` | implemented (M2; e2e deferred §9) |

Decisions: ADR-0009 (PresentationState + §3.4 3D reward; resolves D19) and
ADR-0008 (hub topology; addresses D20) back this feature; both are RESOLVED in
`docs/MILESTONE-MATRIX.md` §8 D-items.

## Non-functional (N01–N08)

| ID  | Requirement (summary)                        | Milestone | Status      |
| --- | -------------------------------------------- | --------- | ----------- |
| N01 | Strict TypeScript, no type errors            | M0        | implemented |
| N02 | Build passes (tsc + vite build)              | M0        | implemented |
| N03 | Runtime validation via real browser          | M0        | implemented |
| N04 | Data/app separation                          | M0        | implemented |
| N05 | Recoverable writes (crash safety)            | M1        | implemented (local) |
| N06 | Large-PDF performance                        | M7        | planned     |
| N07 | Accessibility / keyboard                     | M7        | planned     |
| N08 | Reproducible, committed fixtures             | M0        | implemented |
