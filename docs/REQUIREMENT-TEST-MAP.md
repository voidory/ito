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
| A20 | Safe publication (no partial published state)       | M4        | unit+e2e  | `src/app/workbench.koofr.test.ts`; `e2e/koofr-mobile-sync.spec.ts` (pointer-last + retain-local) | implemented |
| A21 | Named revisions advance publicationRevision         | M6        | unit      | `src/app/workbench.koofr.test.ts` (publicationRevision)    | implemented |
| A22 | Koofr/WebDAV remote adapter                          | M4        | unit+e2e  | `src/storage/koofrStorageAdapter.test.ts`; `e2e/koofr-mobile-sync.spec.ts` | implemented |
| A23 | Schema migration across versions                     | M7        | unit      | `src/model/migrate.test.ts`              | implemented |
| A24 | Delivery/hosting resolved                            | M4        | n/a       | ADR-0005 / ADR-0013 (KoofrStorageAdapter) | implemented |

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

## M2.5 completion + M3 preparation pass (FEAT-001..006, ADR-0010)

The M2.5 pass resolves the two M2 rulings and the omitted M2
retrieval/navigation requirements, and clears the M1 annotation-style schema
debt. The acceptance IDs below use the Master Build Spec v2.0 §12/§13/§7
letters as named in the M2.5 handoff (A10 search/retrieval §13; A13 full
connecting pages §12.1; A14 category master pages §12.2; N04/N05/N07
reference-directed locating §7.1/§7.2; N06 open-together placeholders §7.2; D07
no unexpected camera jumps / A09-M2 preserved). All are ADDITIVE and v1-safe
(ADR-0010; SCHEMA_VERSION stays 1). Each row names the REAL covering Vitest
cases (sandbox-provable) and the Playwright e2e cases added in FEAT-006 (host-run
in the publishing environment — see `docs/MILESTONE-MATRIX.md` §9; the specs are
proven to COMPILE here via `npx playwright test --list`).

| ID  | Behaviour                                                             | Test kind  | Test / location | Status |
| --- | --------------------------------------------------------------------- | ---------- | --------------- | ------ |
| A10 | Search across Page titles + body text, Category names, Annotation anchor + comment; category + 1-hop neighbourhood filters; shell search surface opens the match | e2e + unit | `e2e/view-switch.spec.ts` "search: …"; `src/network/search.test.ts`; `src/app/workbench.search.test.ts`; `src/app/networkSearch.render.test.ts` | implemented (e2e deferred §9) |
| A13 | "The Bump" develops into a real Connecting Page (`explanatoryPageId`), opened in SubjectEditor, usable as a further relationship endpoint; idempotent | e2e + unit | `e2e/concept-network.spec.ts` "A13-M2: developing a relationship's connection promotes it to a real Connecting Page …"; `src/app/workbench.network.test.ts` "M2-FIX-1 (A13-M2, §12.1) — developRelationshipPage"; `src/app/nodesCanvas.render.test.ts` "A13-M2: … open-connecting-page …" | implemented (e2e deferred §9) |
| A14 | Each category has one master `Page` (`masterPageId`) that may connect another category's boundary; `deriveCategoryLinks` emits `data-link-kind="master"|"member"` (master wins dedupe); 2D + 3D parity | e2e + unit | `e2e/concept-network.spec.ts` "A14-M2: connecting two category master pages … master", "… member-bridging … member"; `src/network/scene.test.ts` "deriveCategoryLinks — master vs member boundary links"; `src/app/workbench.network.test.ts` "Ruling 1 (A14-M2, §12.2) — category master pages"; `src/app/nodesCanvas.render.test.ts` "renders a 'master' category-link …" | implemented (e2e deferred §9) |
| N04 | Annotation cited into EXACTLY 1 subject page: Show-in-Nodes switches to Nodes with that node `data-focused="true"` | e2e + unit | `e2e/view-switch.spec.ts` "N04: …"; `src/app/workbench.view.test.ts` "N04: … locate sets viewMode + focusedPageId"; `src/app/nodesCanvas.render.test.ts` "N04/N05: with focusedPageId set … data-focused='true'" | implemented (e2e deferred §9) |
| N05 | Annotation cited into >1 subject pages: a `nodes-destination-picker` lists them; choosing one focuses that node | e2e + unit | `e2e/view-switch.spec.ts` "N05: …"; `src/app/workbench.view.test.ts` "N05: … returns BOTH (picker precondition)" | implemented (e2e deferred §9) |
| N06 | On open-together, a transient placeholder renders for EVERY open unconnected source (`data-source-id`, `data-transient="true"`, `placeholder-return-reader`); returning creates ZERO durable records | e2e + unit | `e2e/view-switch.spec.ts` "N06 (open-together): …"; `src/app/workbench.view.test.ts` "Ruling 2 (N06, §7.2) — a placeholder per open UNCONNECTED source"; `src/app/nodesCanvas.render.test.ts` "Ruling 2/N06: … one placeholder group per open unconnected source …" | implemented (e2e deferred §9) |
| N07 | Show-in-Nodes affordance appears ONLY when the annotation is cited into >= 1 subject page (absent at zero) | e2e + unit | `src/app/workbench.view.test.ts` "N07: … ZERO subject pages has no locate target"; `e2e/view-switch.spec.ts` N04/N05 (`data-cited-count`) | implemented (e2e deferred §9) |
| D07 | Reference-directed locate is an explicit user action; ordinary editing never changes the focus target (A09-M2 preserved, no unexpected camera jumps) | unit | `src/app/workbench.view.test.ts` "A09-M2 guard: ordinary editing transitions NEVER change focusedPageId", "setFocusedPageId(null) clears … without writing a record" | implemented |
| §14 | Annotation styles move to `presentation.annotationStyles`; load migration strips legacy sentinel `Capture` records so `captures` is clean for M3 backup validation | unit | `src/app/workbench.styles.test.ts` "annotation styles live in presentation.annotationStyles" (incl. "strips a legacy sentinel Capture on load") | implemented |

ADR-0010 documents these three additive, v1-safe refinements
(`explanatoryPageId` / `masterPageId` / `annotationStyles`) and cross-references
ADR-0008 (hub topology) and ADR-0009 (presentation/3D state).

## M3 backup, recovery, and validation (FEAT-001..003, ADR-0011)

M3 is Complete Backup, Recovery, and Validation. The acceptance IDs below use
the Master Build Spec v4.0 letters as named in the M3 handoff: A17 offline-first
citations + binary-offloaded + re-attach; A18 Targeted Backup Checklist +
`manifest.omissions` stamping; A19 staging reject + Try Import Anyway + stepwise
migration; D02 two-mode highlight deletion; D09 two-lane backup + PdfIngestionQueue.
(These M3 letters are distinct from the M2-era A17/A18 rows in the Acceptance
table above, exactly as the M2.5 section reuses its own spec letters.) The first
REAL schema bump lands here (SCHEMA_VERSION 1 -> 2) with a pure stepwise
migration runner; all new fields are additive + optional + v1-safe. Each row
names the REAL covering Vitest cases (sandbox-provable) and the
`e2e/backup-recovery.spec.ts` cases (host-run in the publishing environment - see
`docs/MILESTONE-MATRIX.md` §9; the spec is proven to COMPILE + be DISCOVERED here
via `npx playwright test --list`, which lists the A17/A18/A19/D02 cases).

| ID  | Behaviour                                                             | Test kind  | Test / location | Status |
| --- | --------------------------------------------------------------------- | ---------- | --------------- | ------ |
| A17 | Offline-first citations: offload evicts ONLY the PDF bytes (Source + annotations + citations survive); status flips to `binary-offloaded`; a followed quote resolves `binary-offloaded` carrying the stored quote/comment/page; sha256-verified re-attach returns it to cached/resolved; a mismatched file is rejected and writes nothing | e2e + unit | `e2e/backup-recovery.spec.ts` "A17: offloading a PDF binary keeps the source + citations and flips the availability badge"; `src/app/workbench.backup.test.ts`; `src/app/library.offload.render.test.ts`; `src/app/reader.m3.render.test.ts` | implemented (e2e deferred §9) |
| A18 | Targeted Backup Checklist: Full Archival Backup by default; unticking any optional box downgrades the `backup-mode-badge` to "Targeted Backup (Partial - not a complete archival backup)" and stamps `manifest.backupMode='targeted'` + the ordered `manifest.omissions` tokens (presentation/captures/revisions/sourceBinaries) | e2e + unit | `e2e/backup-recovery.spec.ts` "A18: the Targeted Backup Checklist drives the mode badge and omission stamping"; `src/app/workbench.backup-engine.test.ts`; `src/app/backupExportModal.render.test.ts` | implemented (e2e deferred §9) |
| A19 | Isolated staging validator: hard-reject / needs-confirmation (default reject) / ready; `import-staging-report` lists findings; `try-import-anyway` commits leniently via the stepwise migration; the live store is never mutated before commit | e2e + unit | `e2e/backup-recovery.spec.ts` "A19: a schema-mismatched bundle is staged (default reject) and Try Import Anyway commits leniently"; `src/storage/staging.test.ts`; `src/model/migrate.test.ts`; `src/app/importStagingReport.render.test.ts` | implemented (e2e deferred §9) |
| D02 | Two-mode highlight deletion: `delete-highlight-only` removes the annotation but keeps every quote (pair derives `unresolved`); `delete-highlight-and-quotes` records a pre-mutation Revision snapshot then strips the inline quote while preserving surrounding prose | e2e + unit | `e2e/backup-recovery.spec.ts` "D02: delete-highlight-only keeps the quote; delete-highlight-and-quotes removes the inline quote"; `src/app/workbench.deletion.test.ts`; `src/app/reader.m3.render.test.ts` | implemented (e2e deferred §9) |
| D09 | Two-lane disentangled backup (Lane 1 `brain.ito.json`; Lane 2 `.ito.zip` via fflate with manifest.json + brain.json + assets stored byte-identical) and a batch PdfIngestionQueue (bounded concurrency, %PDF- + size guard, hydrate-existing vs create-new) | unit | `src/storage/backup.test.ts`; `src/app/workbench.backup-engine.test.ts`; `src/app/workbench.ingest.test.ts` | implemented |
| SV2 | SCHEMA_VERSION bumped 1 -> 2 with a pure stepwise `migrateBrainData(raw)` runner (v0->v1->v2 near-identity steps + fillDefaults; `FutureSchemaError` on a newer payload; registry shared with the StorageAdapter); new fields (`binary-offloaded` resolution, `manifest.backupMode`/`omissions`, Revision `beforeSnapshot`/`affectedObjectIds`) are additive + optional + v1-safe | unit | `src/model/migrate.test.ts`; `src/test/model.test.ts` | implemented |

Decision: `docs/decisions/ADR-0011-m3-backup-offline-citations-and-deletion.md`
records the two-lane architecture, the fflate-vs-pure-codec decision (fflate
installed and USED; pure codec was the documented fallback), the Targeted Backup
Checklist + omission stamping + D19 device-local/shared presentation split, the
binary-offloaded resolution + offload/attach flow, the two-mode deletion with
pre-mutation Revision snapshots, the staging validator + Try Import Anyway, and
the SCHEMA_VERSION bump to 2. Cross-references D02, D09, D19 and
ADR-0004/0007/0010.

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

## Pass A - M7 history + M6 sources + section 3 polish (ADR-0012)

Spec-milestone IDs for Pass A (distinct from the legacy A01-A24 acceptance list
above). Runtime behavior is proven in Vitest; the two new e2e specs
(`e2e/history-reflection.spec.ts`, `e2e/zotero-website.spec.ts`) are proven to
COMPILE + be DISCOVERED via `npx playwright test --list`.

| ID       | Behaviour                                                                 | Test kind  | Test / location | Status |
| -------- | ------------------------------------------------------------------------- | ---------- | --------------- | ------ |
| H01      | Coalesced 2000 ms prose revisions; `flushPendingRevision` deterministic   | unit + e2e | `src/app/workbench.history.test.ts`; `e2e/history-reflection.spec.ts` | implemented |
| H02      | Structural actions flush immediately as their own revision                | unit       | `src/app/workbench.history.test.ts` | implemented |
| H03      | Day-grouped timeline + single-day picker + date-range filter              | unit + e2e | `src/app/historyReflectionPanel.render.test.ts`; `e2e/history-reflection.spec.ts` | implemented |
| H04, D14 | Multi-day reflection (linkedRevisionIds + start/end keys, date-span badge), per-change comments, zero graph nodes | unit + e2e | `src/app/workbench.history.test.ts`; `src/app/historyReflectionPanel.render.test.ts`; `e2e/history-reflection.spec.ts` | implemented |
| H05      | reconstruct (ok / missing-segment) + forward-only restore                 | unit + e2e | `src/app/workbench.history.test.ts`; `e2e/history-reflection.spec.ts` | implemented |
| H06, D13 | Checkpoint every 20 revisions; snapshot excludes revisions/checkpoints, no PDF bytes | unit | `src/app/workbench.history.test.ts` | implemented |
| H07      | `measureHistoryOverhead` field shape                                      | unit + e2e | `src/app/workbench.history.test.ts`; `e2e/history-reflection.spec.ts` | implemented |
| A24, D10 | Idempotent Zotero import (zero duplicates, zero graph nodes)              | unit + e2e | `src/storage/zotero.test.ts`; `src/app/workbench.sources.test.ts`; `e2e/zotero-website.spec.ts` | implemented |
| A15, D11 | Website URL + required snapshot; required-error; kind `website` + `snapshot-cached` | unit + e2e | `src/app/workbench.sources.test.ts`; `src/app/library.website.render.test.ts`; `e2e/zotero-website.spec.ts` | implemented |
| D01      | Scanned/encrypted scope banners + citable area annotations                | unit + e2e | `src/app/workbench.sources.test.ts`; `e2e/zotero-website.spec.ts` | implemented |
| FIX-3.1  | PDF header/stage split, textLayer CSS, overlay measurement, pageCount backfill | unit | `src/pdf/highlight.test.ts`; `src/app/workbench.sources.test.ts` | implemented |
| FIX-3.2  | Narrow-pane auto-fit (ResizeObserver, `--scale-factor`, `max-width:100%`) | unit | `src/app/reader.m3.render.test.ts` | implemented |
| FIX-3.3  | Interactive 2D pan/zoom/node-drag + deterministic offset layout           | unit | `src/network/scene.test.ts`; `src/app/nodesCanvas.render.test.ts` | implemented |
| FIX-3.4  | Tactile theme tokens + 160 ms micro-animations + strict motion gate       | unit | `src/app/theme.render.test.ts` | implemented |
| FIX-3.5  | 3D `#141824` backdrop, glowing nodes, hull opacity 0.28 + rim, visible lines | unit | `src/app/threeScene.map.test.ts` | implemented |

Decision: `docs/decisions/ADR-0012-m7-history-m6-sources-and-visual-polish.md`.

## Pass B - M4 Koofr sync + M5 mobile captures + section 3 visual fixes (ADR-0013)

Spec-milestone IDs for Pass B (the Pass B A20-A23 are the M4/M5 acceptance IDs
from the spec's section 15/16, distinct from the legacy A01-A24 list above).
Runtime behaviour is proven in Vitest; the two new e2e specs
(`e2e/koofr-mobile-sync.spec.ts`, `e2e/mobile-captures.spec.ts`) are proven to
COMPILE + be DISCOVERED via `npx playwright test --list` (total 71 / 13 specs).

| ID       | Behaviour                                                                 | Test kind  | Test / location | Status |
| -------- | ------------------------------------------------------------------------- | ---------- | --------------- | ------ |
| §15, D08 | KoofrStorageAdapter WebDAV (PUT/GET-404->null/PROPFIND/MKCOL); injectable fetch; runtime-only Basic auth; publication-layout helpers | unit | `src/storage/koofrStorageAdapter.test.ts` | implemented |
| §15, §16.1, H06 | Pointer-last publication: only-missing-asset upload (H06), write+verify snapshot (sha256), `current-revision.json` LAST; fault-before-pointer keeps prior pointer | unit + e2e | `src/app/workbench.koofr.test.ts`; `e2e/koofr-mobile-sync.spec.ts` | implemented |
| A20      | Interrupted/corrupted refresh retains the local copy; `syncStatus` stale/offline + reason | unit + e2e | `src/app/workbench.koofr.test.ts`; `e2e/koofr-mobile-sync.spec.ts` | implemented |
| A21      | Phone reading shell: related-writing sheet + return preserves source/scroll/zoom; offline cache controls | unit + e2e | `src/app/mobileReaderShell.render.test.ts`; `e2e/koofr-mobile-sync.spec.ts` | implemented |
| A22      | Captures idempotent by CaptureId across repeated + out-of-order pulls; `handleCapture` idempotent | unit + e2e | `src/app/workbench.captures.test.ts`; `e2e/mobile-captures.spec.ts` | implemented |
| A23      | `createMobileCapture` creates zero Page/Category/Relationship; create-subject only on explicit disposition | unit + e2e | `src/app/workbench.captures.test.ts`; `src/app/mobileCaptureComposer.render.test.ts`; `e2e/mobile-captures.spec.ts` | implemented |
| D12      | Sync banner + publish/refresh + Import Zotero modal surfaced in the shell | unit | `src/app/syncBanner.render.test.ts`; `src/app/library.zotero.render.test.ts` | implemented |
| FIX-3.1  | FIX-HORIZONTAL-HIGHLIGHT-DRIFT: canvas/textLayer/overlay locked 1:1; identical normalized left/width at 0.6x narrow-pane scale | unit | `src/pdf/anchorScale.test.ts`; `src/pdf/highlight.test.ts` | implemented |
| FIX-3.2  | FIX-NODES-LABEL-OVERLAP: pill hidden until hub hover/select; category label at top arch with a halo | unit | `src/app/nodesCanvas.render.test.ts` | implemented |
| FIX-3.3  | FIX-NARROW-PANE-TOOLBARS: single-row Reader + SubjectEditor headers | unit | `src/app/reader.m3.render.test.ts`; theme.css `.ito-pane-*` | implemented |
| FIX-3.4  | FIX-HISTORY-FULL-LAYOUT: two-column `daily-review-panel` grid + empty state | unit | `src/app/historyReflectionPanel.render.test.ts`; theme.css | implemented |
| FIX-3.5  | FIX-TOP-BAR-CLIPPING + Restore button style: flex-column app shell; Restore matches Backup | unit | `src/app/theme.render.test.ts`; theme.css `.app-shell`/`.shell-header`/`.view-body` | implemented |

Decision: `docs/decisions/ADR-0013-m4-koofr-sync-and-m5-mobile-captures.md`.
With Pass B merged, **all milestones M0 through M7 are complete.**
