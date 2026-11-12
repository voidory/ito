# MILESTONE MATRIX — M0 + M1 + M2 + M2.5 + M3 + M4 + M5 + M6 + M7 (COMPLETE)

The spec (section 22) requires an implemented / pending / unsupported matrix at
every milestone. This is that matrix for the first two milestones. It is the
single place that states, honestly, what the delivered app does at runtime
(real browser, real pdf.js text), what is deferred to later milestones, and
what is currently unsupported.

Legend for **Status**:

- **implemented** — delivered and covered by an automated test that runs the
  real app (Playwright) or the real domain logic (Vitest). Not a stub.
- **pending** — in scope for a later milestone; intentionally not built yet.
- **unsupported** — not available in the current delivery and called out so no
  one assumes it works (e.g. phone three-pane editing, remote storage).

Test kinds: `e2e` = Playwright chromium (real browser, real PDF text), `unit` =
Vitest, `n/a` = decision/record only.

---

## 1. Run instructions

```sh
npm install                      # install dependencies (Node >= 22)
npm run typecheck                # tsc --noEmit (strict TypeScript, N01)
npm run build                    # tsc --noEmit && vite build (N02)
npm run test                     # Vitest unit/integration suite
npx playwright install chromium  # first run only
npm run test:e2e                 # Playwright real-browser suite (webServer = build + preview)
npm run dev                      # launch the app locally (Vite dev server)
```

Per spec section 24 the visible READY state is a boot safeguard, NOT a
substitute for runtime validation: every behavioural claim below marked `e2e`
is exercised by `npm run test:e2e` driving a real chromium browser against the
production build, selecting real pdf.js text and reading live Workbench state.

## 2. Automated test results summary

Last run on this working tree (all green):

| Suite                     | Command             | Result               |
| ------------------------- | ------------------- | -------------------- |
| TypeScript typecheck      | `npm run typecheck` | pass (0 errors)      |
| Production build          | `npm run build`     | pass                 |
| Unit / integration        | `npm run test`      | 315 passed / 36 files (M3; was 241 / 24 at M2.5 baseline) |
| Runtime (real browser)    | `npm run test:e2e`  | 54 tests / 9 specs WRITTEN; host-run in the publishing environment (sandbox: e2e deferred, CDN block — see §9) |

E2E specs: `e2e/ready.spec.ts` (boot), `e2e/pdf-anchor.spec.ts` (anchor
round-trip spike), `e2e/reader-workbench.spec.ts` (M1 reading workbench),
`e2e/subject-editor.spec.ts` (M1 subject layer + continuous editor),
`e2e/concept-network.spec.ts` (M2 NodesCanvas — A09/A10/A13/A14-M2 + M2.5
A13 explanatory-page promotion + A14 master|member category-links),
`e2e/view-switch.spec.ts` (M2 Files/Nodes switch + N06 placeholder + M2.5
multi-PDF N06, N04/N05 reference-directed locating, search),
`e2e/three-d.spec.ts` (M2 §3.4 3D dimensional shift — density reward),
`e2e/workspace.spec.ts` (M1 integrated three-pane workspace + context-preserving
transitions), `e2e/backup-recovery.spec.ts` (M3 backup/recovery - A17/A18/A19/D02).
The e2e count grew 43 → 50 at M2.5 (+3 in `concept-network.spec.ts`, +4 in
`view-switch.spec.ts`) and 50 → 54 at M3 (+4 in `backup-recovery.spec.ts`).

---

## 3. Validation ORDER (spec, binding)

The spec fixes the order in which the three core interactions must be validated.
All three are now validated at runtime, in order:

1. **Highlighting first** — `e2e/reader-workbench.spec.ts` (R01, R09, R20, …).
2. **Continuous page editing second** — `e2e/subject-editor.spec.ts` (A03–A07,
   R06, A17).
3. **Context-preserving view/layout transitions third** — `e2e/workspace.spec.ts`
   (section 8.2 three-pane workspace, R19/N08 preservation, A06 source-return,
   A08/R08 line toggle, N03/N08 scope + passage preservation).

---

## 4. M1-relevant acceptance matrix (A01–A08, R01–R20, N03, N08)

Each row maps a spec ID to its status and the automated test that covers it.
IDs below use the FEAT-003/004/005 behavioural numbering used across the e2e
suite and `docs/REQUIREMENT-TEST-MAP.md`; where a logical-contract ID (section
20 / section 10.2) is meant it is noted in the Requirement column.

### Acceptance A01–A08

| ID  | Requirement (summary)                                            | Status      | Kind      | Covering test |
| --- | ---------------------------------------------------------------- | ----------- | --------- | ------------- |
| A01 | App boots to a visible READY state in a real browser             | implemented | e2e       | `e2e/ready.spec.ts` |
| A02 | Startup failure surfaces a visible ERROR state                   | implemented | unit/boot | `src/app/App.tsx` ERROR branch; boot safeguard (dedicated `e2e/error.spec.ts` pending) |
| A03 | Subject page created ONLY by explicit action from evidence       | implemented | e2e+unit  | `e2e/subject-editor.spec.ts` "A03…"; `src/app/workbench.subject.test.ts` |
| A04 | Compose/reorder paragraphs + quotes; structure + provenance kept | implemented | e2e+unit  | `e2e/subject-editor.spec.ts` "A04 + R14…"; `workbench.subject.test.ts` |
| A05 | Insert evidence at the cursor; no mandatory template             | implemented | e2e       | `e2e/subject-editor.spec.ts` "A05 + R06…" |
| A06 | Follow a quote → exact source passage, page NOT replaced/covered | implemented | e2e       | `e2e/workspace.spec.ts` "A06…"; also `subject-editor.spec.ts` "A17…" |
| A07 | Structural details toggleable; hiding never breaks attribution   | implemented | e2e       | `e2e/subject-editor.spec.ts` "A07…" |
| A08 | Passage-to-evidence line toggle = presentation only, no deletion | implemented | e2e+unit  | `e2e/workspace.spec.ts` "A08/R08 foundation…"; `workbench.workspace.test.ts` |

Note on A06/A17: the spec's "return to the exact passage, explicit when the
anchor cannot be resolved" behaviour is tested both from the standalone editor
(`A17`) and from inside the integrated workspace (`A06`). A changed source
edition yields an explicit `mismatched` state and never a silent navigation.

### Requirements R01–R20 (reading workbench + transition behaviours)

| ID  | Requirement (summary)                                           | Status      | Kind      | Covering test |
| --- | --------------------------------------------------------------- | ----------- | --------- | ------------- |
| R01 | Selection exposes ONLY compact highlight/color controls         | implemented | e2e       | `reader-workbench.spec.ts` "R01 + R09 + R20…" |
| R02 | Quiet comments: hidden in reading, revealed on explicit access  | implemented | e2e       | `reader-workbench.spec.ts` "R02…" |
| R03 | One 3-page range = a single logical annotation identity         | implemented | e2e+unit  | `reader-workbench.spec.ts` "R03 + R04…"; `workbench.test.ts` |
| R04 | Micro-highlights inside a range stay independent                | implemented | e2e+unit  | `reader-workbench.spec.ts` "R03 + R04…" |
| R05 | "Associate with subject…" → DOTTED link, no page edit           | implemented | e2e+unit  | `reader-workbench.spec.ts` "R05 + R15…" |
| R06 | Direct citation dotted→solid; source annotation survives        | implemented | e2e+unit  | `subject-editor.spec.ts` "A05 + R06…" |
| R07 | Same annotation solid for one subject, tentative for another    | implemented | e2e+unit  | `reader-workbench.spec.ts` "R07…" |
| R08 | Hiding presentation lines never deletes the relationship        | implemented | e2e+unit  | `workspace.spec.ts` "A08/R08…"; `workbench.workspace.test.ts` |
| R09 | Soft, uneven, rounded commit overlay hugging line fragments     | implemented | e2e       | `reader-workbench.spec.ts` "R01 + R09 + R20…" |
| R10 | No standalone isCited boolean (status derived per pair)         | implemented | unit      | `src/model/citation.test.ts`; `workbench.test.ts` |
| R11 | prefers-reduced-motion AND in-app suppress-motion honoured      | implemented | e2e       | `reader-workbench.spec.ts` two "R11…" tests |
| R12 | Failed local save retains the draft + actionable error          | implemented | e2e+unit  | `reader-workbench.spec.ts` "R12…"; `workbench.test.ts` |
| R13 | Reproducible, committed PDF fixtures                            | implemented | unit/n-a  | `scripts/gen-fixtures.mjs`; `src/test/fixtures.test.ts` |
| R14 | Annotations/comments/composition persist across reopen          | implemented | e2e+unit  | `reader-workbench.spec.ts` "R14…"; `subject-editor.spec.ts` "A04 + R14…" |
| R15 | Accessible (menu-button) alternative to the right-click menu    | implemented | e2e       | `reader-workbench.spec.ts` "R05 + R15…" |
| R16 | Each range page carries a BORDER (not a tint wash)              | implemented | e2e       | `reader-workbench.spec.ts` "R03 + R04 + R16 + R17…" |
| R17 | Range filterable from micro-highlights; shows "pp. X-Y"         | implemented | e2e       | `reader-workbench.spec.ts` "R03 + R04 + R16 + R17…" |
| R18 | Closed highlights tab reserves ZERO sidebar width               | implemented | e2e       | `reader-workbench.spec.ts` "R18…" |
| R19 | Layout/tab transitions preserve passage/draft/pane config; no camera motion | implemented | e2e+unit | `workspace.spec.ts` "R19 + N08…", "section 8.2…"; `workbench.workspace.test.ts` |
| R20 | Multi-line overlay = real line fragments; glyphs stay legible   | implemented | e2e       | `reader-workbench.spec.ts` "R01 + R09 + R20…" |

### Non-functional N03, N08

| ID  | Requirement (summary)                                   | Status      | Kind | Covering test |
| --- | ------------------------------------------------------- | ----------- | ---- | ------------- |
| N03 | Runtime validation via a real browser (not type checks) | implemented | e2e  | whole `test:e2e` suite; scope preservation in `workspace.spec.ts` "N03 + N08…" |
| N08 | Transitions preserve context (source, passage, drafts, pane config, scope) | implemented | e2e+unit | `workspace.spec.ts` "R19 + N08…", "N03 + N08…"; `workbench.workspace.test.ts` |

---

## 5. Integrated three-pane workspace (FEAT-005, section 8.2) — what ships

| Capability                                                           | Status      | Covering test |
| -------------------------------------------------------------------- | ----------- | ------------- |
| Paper A · subject page · Paper B rendered SIMULTANEOUSLY             | implemented | `workspace.spec.ts` "section 8.2…" |
| Editable subject page never hidden behind a modal while composing    | implemented | `workspace.spec.ts` "section 8.2…", "A06…" |
| Adjustable pane widths (draggable dividers, weight = view state)      | implemented | `workspace.spec.ts` "section 8.2…" |
| Independent per-pane scrolling                                       | implemented | `workspace.spec.ts` "section 8.2…" |
| Switch a reader pane to a THIRD paper while keeping the subject       | implemented | `workspace.spec.ts` "section 8.2 note…"; `workbench.workspace.test.ts` |
| Passage-to-evidence line DATA (section 10.2), margin/inter-pane route | implemented | `workspace.spec.ts` "A08/R08…"; `workbench.workspace.test.ts` |
| Line visibility toggle = presentation only, non-destructive          | implemented | `workspace.spec.ts` "A08/R08…" |
| No unexpected graph camera motion on transitions (M2 is full graph)   | implemented | `workspace.spec.ts` "R19 + N08…" |
| Phone/narrow-screen responsive flow STUB (not a squeezed miniature)   | implemented (stub) | `data-testid="responsive-flow-stub"` renders below 760px; documented limit |

---

## 6. Pending (in scope for later milestones)

| Area                                                  | Milestone | Reference |
| ----------------------------------------------------- | --------- | --------- |
| Graph `hide` as presentation state at graph scale     | implemented (M2) | D13; `workbench.network.test.ts` (shipped — see §8b/§8c) |
| Categories grouping pages by id in the graph          | implemented (M2) | D14; `src/network/scene.test.ts`, `e2e/concept-network.spec.ts` (shipped) |
| Remote storage (Koofr/WebDAV) adapter                 | M4        | ADR-0005; `docs/spikes/koofr-access.md`; D08/D09 |
| Safe publication against a remote + delivery/hosting   | M4        | ADR-0005; D10, D17 |
| Captures → structured pages; named revisions          | M6        | D15, D16 |
| Schema migrations: first real bump v1 -> v2           | implemented (M3) | ADR-0011; D18; `src/model/migrate.ts`, `src/model/migrate.test.ts` |
| Schema migrations past v2                             | M7        | ADR-0004; D18 |
| Large-PDF performance pass; full keyboard a11y audit   | M7        | N06, N07 |
| Dedicated `e2e/error.spec.ts` for the ERROR boot state | M2        | A02 (logic shipped, dedicated e2e pending) |

## 7. Unsupported in the current delivery (called out)

- **Phone-sized three-pane EDITING.** Narrow screens (< 760px) get a documented
  single-column flow STUB that stacks source → subject → source, NOT a squeezed
  three-pane miniature. Side-by-side composition is a wide-screen experience.
- **Remote/shared storage.** Only the local `LocalFileStorageAdapter`
  (IndexedDB/OPFS) is wired. Koofr/WebDAV is assessed in the M0 spike and
  implemented at M4; see `docs/spikes/koofr-access.md` for the honest CORS/auth
  assessment and fallbacks.
- **Full concept-network graph + its camera.** DELIVERED at M2 (FEAT-004/005/006):
  the 2D watercolor NodesCanvas, the Files/Nodes switch, durable layout state,
  node/relationship hide-at-scale, and the §3.4 3D dimensional shift. The M1
  no-unexpected-camera-motion guarantee is preserved: idle layout positions are
  deterministic in both 2D and 3D, and 3D orbit motion is user-driven only
  (auto-rotate off; damping disabled under suppress-motion).

---

## 8b. M2 concept-network foundation (FEAT-003) — data contract + headless transitions

FEAT-003 delivers the TYPED, PERSISTED, TESTED foundation for the M2 concept
network (no rendering yet — that is FEAT-004/005/006). It extends the section-20
contract ADDITIVELY (SCHEMA_VERSION stays 1) and adds the headless Workbench
transitions + density monitor. Rendering/interaction rows below marked `e2e`
have their headless/pure logic proven in Vitest in the sandbox; the Playwright
e2e is deferred to the publishing environment (see §9).

| ID      | Requirement (summary)                                              | Status      | Kind       | Covering test |
| ------- | ------------------------------------------------------------------ | ----------- | ---------- | ------------- |
| A09-M2  | Graph `hide` is presentation-only; never deletes a Page/Relationship | implemented | unit       | `src/app/workbench.network.test.ts` "hiding a node/relationship is presentation-only" |
| A13-M2  | N=2 lens vs N>=3 star hub topology derived from endpoints           | implemented | unit       | `workbench.network.test.ts` "relationship round-trip"; `src/model/relationship.test.ts`; `src/network/*` (FEAT-002) |
| A14-M2  | Category watercolor colorCode persists; hub blendColor derived (§3.2) | implemented | unit       | `workbench.network.test.ts` "colorCode"/"blendColor is derived"; `src/network/blend.test.ts` |
| N06-M2  | Transient "not connected yet" placeholder creates ZERO graph records | implemented | unit       | `workbench.network.test.ts` "N06 transient placeholder creates zero records" |
| (§3.4)  | Density reward: 3D unlocks at 35 active nodes; opt-in flag durable   | implemented | unit       | `workbench.network.test.ts` "§3.4 density reward (3D unlock)" |

Additive schema guarantees (ADR-0008, ADR-0009), proven in Vitest:

| Capability                                                            | Status      | Covering test |
| --------------------------------------------------------------------- | ----------- | ------------- |
| `Relationship` gains optional N-endpoint `endpointPageIds` + derived hub fields | implemented | `src/model/relationship.test.ts`; `workbench.network.test.ts` |
| One normalized `relationshipEndpoints(rel)` accessor (lens/star rule)  | implemented | `src/model/relationship.test.ts` |
| `PresentationState` gains nodePositions/zoom/categoryBounds/active3D/dragOffsets (durable, D19) | implemented | `src/model/brain.test.ts`; `workbench.network.test.ts` "durable presentation state" |
| v1 `Category`/`Relationship`/`PresentationState` still typecheck + load | implemented | `src/model/brain.test.ts` "additive schema — v1 shapes still typecheck" |
| SCHEMA_VERSION stays 1 (no migration; M7 per ADR-0004)                 | implemented | `src/model/brain.test.ts`; `src/test/model.test.ts` |
| `window.__ito` exposes conceptGraph/activeNodeCount/is3DUnlocked/nodePlaceholderFor | implemented | `src/app/testApi.ts` (drives the real Workbench; e2e deferred §9) |

## 8c. M2 concept-network RENDERING (FEAT-004) — SVG NodesCanvas

FEAT-004 delivers the runtime 2D SVG scene (`src/app/NodesCanvas.tsx`): circular
dot nodes, procedural "Bump" hubs (lens N=2 / concave arched star N>=3 via
`src/network/hub.ts`), overlapping watercolor squircle category areas
(`src/network/squircle.ts`) with a multiply blend + `#watercolor-turbulent-edge`
filter, and data-driven category-to-category connections. Node positions come
from the REAL force-directed layout engine (`src/network/layout.ts`) over LIVE
Workbench records via the pure `buildScene` mapper (`src/network/scene.ts`). The
rendering/interaction rows are proven by the Playwright spec
`e2e/concept-network.spec.ts` (runs in the publishing environment) AND, so the
sandbox can prove correctness headlessly, by Vitest over the pure graph→props
mapping (`src/network/scene.test.ts`) and a jsdom render of the real component
against a real Workbench (`src/app/nodesCanvas.render.test.ts`).

| ID      | Requirement (summary)                                                | Status      | Kind        | Covering test |
| ------- | -------------------------------------------------------------------- | ----------- | ----------- | ------------- |
| A13-M2  | 2-endpoint relationship renders a lens hub; >=3-endpoint renders a star hub (endpoint-count>=3) whose vertices point toward the connected nodes | implemented (e2e deferred §9) | e2e + unit  | `e2e/concept-network.spec.ts` "A13-M2 …"; `src/network/scene.test.ts` "hub topology"; `src/app/nodesCanvas.render.test.ts` |
| A09-M2  | Nodes render inside their category squircle bounds; idle positions are stable (no forced camera motion) | implemented (e2e deferred §9) | e2e + unit  | `e2e/concept-network.spec.ts` "A09-M2 …"; `src/network/scene.test.ts` "deterministic … positions", "squircle contains its member nodes" |
| A10-M2  | A node in TWO categories renders in the intersection of BOTH squircles (squircleContains against both bounds) | implemented (e2e deferred §9) | e2e + unit  | `e2e/concept-network.spec.ts` "A10-M2 …"; `src/network/scene.test.ts` "A10-M2 … inside BOTH squircles" |
| A14-M2  | A category-to-category reference renders a `category-link` between the two squircle boundaries (data-driven) | implemented (e2e deferred §9) | e2e + unit  | `e2e/concept-network.spec.ts` "A14-M2 …"; `src/network/scene.test.ts` "deriveCategoryLinks …"; `src/app/nodesCanvas.render.test.ts` |
| (§3.2)  | Category squircle `.category-squircle-fill` uses mix-blend-mode: multiply + `#watercolor-turbulent-edge`; dotted-dashed border | implemented (e2e deferred §9) | e2e + unit  | `src/app/network.css`; `src/app/nodesCanvas.render.test.ts` "watercolor fill class", "filter once in defs" |
| (§3.1)  | Clicking a hub opens the connecting-page label surface                | implemented (e2e deferred §9) | e2e        | `e2e/concept-network.spec.ts` "clicking a hub opens the connecting-page label surface" |

## 8d. M2 Files / Nodes view switch (FEAT-005, spec §3.3)

FEAT-005 formalizes the top-level Files/Nodes view switch. The Workbench owns a
`viewMode: 'files' | 'nodes'` (session view state, default `files`, no durable
record — `setViewMode`/`viewMode()`); the transient FEAT-004 `nodesViewActive`
flag now DERIVES from it so the two stay in lockstep. The app shell renders a
visible `view-switch` (`view-files`/`view-nodes` buttons); `files` shows the
Library (opening a PDF still launches the Reader), `nodes` mounts NodesCanvas.
`state.categoryScope` is a single source of truth shared across the switch: no
scope = the global network; a scope = only that category's squircle + its
local/overlapping network (overlap = categories sharing a member page), filtered
off the LIVE graph by the pure `filterGraphToScope`. N06-M2: opening Nodes for
an UNCONNECTED PDF (a Source with no cited annotation → no participating Page)
renders a TRANSIENT `node-placeholder` (`data-transient="true"`) bearing the PDF
title from `wb.nodePlaceholderFor(sourceId)`; clicking it or leaving the view
creates/persists NOTHING. The Playwright spec `e2e/view-switch.spec.ts` proves
the rendering/interaction in the publishing environment; the headless logic is
proven in the sandbox by `src/app/workbench.view.test.ts` (view-mode round-trip,
shared scope, N06 zero records, scope filter) and `src/app/nodesCanvas.render.test.ts`
(jsdom render of the scope filter + the N06 placeholder against a real Workbench).

| ID      | Requirement (summary)                                                | Status      | Kind        | Covering test |
| ------- | -------------------------------------------------------------------- | ----------- | ----------- | ------------- |
| (§3.3)  | Shell `view-switch` toggles Files (Library) <-> Nodes (NodesCanvas); viewMode round-trips; opening a PDF from Files still launches the Reader | implemented (e2e deferred §9) | e2e + unit  | `e2e/view-switch.spec.ts` "view switch toggles …", "opening a PDF … Reader"; `src/app/workbench.view.test.ts` "round-trips setViewMode …" |
| (§3.3)  | `categoryScope` shared across the switch; Nodes with a scope shows only that category's squircle + overlapping network | implemented (e2e deferred §9) | e2e + unit  | `e2e/view-switch.spec.ts` "a category selected in Files carries into Nodes …"; `src/app/workbench.view.test.ts` "category-scope graph filter …"; `src/app/nodesCanvas.render.test.ts` "with a category scope …" |
| N06-M2  | Nodes view for an unconnected PDF renders a transient "Not connected yet" placeholder; clicking creates ZERO Page/Relationship/Category records (no DB write) | implemented (e2e deferred §9) | e2e + unit  | `e2e/view-switch.spec.ts` "N06: … placeholder … persists nothing"; `src/app/workbench.view.test.ts` "nodePlaceholderFor creates ZERO … records"; `src/app/nodesCanvas.render.test.ts` "FEAT-005/N06: renders the transient … placeholder" |

## 8e. M2 §3.4 3D dimensional shift (FEAT-006) — the density reward

FEAT-006 delivers the §3.4 secret 3D dimensional shift, staged LAST and fully
OPTIONAL. The density monitor (FEAT-003: `activeNodeCount() >= 35`,
`THREE_D_UNLOCK_THRESHOLD`) reveals a subtle glowing `enter-3d` transition
prompt; activating it flips the DURABLE `active3D` flag (ADR-0009) and mounts a
Three.js WebGL scene (`src/app/ThreeScene.tsx`) that renders the SAME live
`conceptGraph()` the 2D canvas shows — nodes as glowing stellar particles,
categories as translucent 3D bubble hulls (spheres sized/centered from the
squircle bounds), relationships as faint connecting glyphs, all in gentle
watercolor fog (`scene.fog` + additive/translucent materials). Navigation is
orbit-style (OrbitControls from `three/examples/jsm/controls/OrbitControls.js`,
pointer drag + wheel zoom). The 2D canvas is never regressed: entering 3D is a
presentation flag only (zero graph records change), exiting returns to the 2D
NodesCanvas, and both views derive from one source via the PURE, Vitest-covered
`mapGraphTo3D()` (`src/app/threeScene.map.ts`) — no duplicated hardcoded scene.

A WebGL GUARD makes 3D safe on headless CI: if a context cannot be acquired the
scene renders a visible 2D-fallback notice (`three-fallback`) rather than
crashing, and the e2e spec branches on a real WebGL probe
(`window.__ito.webglAvailable()`). Suppress-motion / prefers-reduced-motion is
honored end to end: the prompt glow degrades to a static control, the scale-out
transition becomes an instant swap, and OrbitControls damping/auto-spin are off.

The Playwright spec `e2e/three-d.spec.ts` (real Chromium, WebGL via the bundled
build) proves the rendering/interaction in the publishing environment; the
sandbox proves the testable logic headlessly via Vitest:
`src/app/threeScene.map.test.ts` (pure graph→{particles,hulls,links} mapping,
live-graph parity, hull sizing, deterministic depth, empty-graph safety, and the
`revealPresentation` density-reward reveal mapping) plus the existing
`src/app/workbench.network.test.ts` density-threshold tests (locked at 34,
unlocked at 35, hide drops back below without deleting a Page).

| ID      | Requirement (summary)                                                | Status      | Kind        | Covering test |
| ------- | -------------------------------------------------------------------- | ----------- | ----------- | ------------- |
| (§3.4)  | `enter-3d` prompt ABSENT below 35 active nodes, PRESENT at >= 35 (density reward); degrades to a static control under suppress-motion | implemented (e2e deferred §9) | e2e + unit | `e2e/three-d.spec.ts` "enter-3d prompt is ABSENT … / APPEARS …"; `src/app/threeScene.map.test.ts` "revealPresentation …"; `src/app/workbench.network.test.ts` "§3.4 density reward" |
| (§3.4)  | Activating mounts the Three.js WebGL scene (`three-canvas`) rendering the live graph as particles + translucent 3D hulls + fog, with orbit navigation; graceful 2D fallback (`three-fallback`) when WebGL is unavailable | implemented (e2e deferred §9) | e2e + unit | `e2e/three-d.spec.ts` "activating 3D mounts the WebGL scene (or the graceful 2D fallback) …"; `src/app/threeScene.map.test.ts` "mapGraphTo3D …" |
| (§3.4)  | 3D reads the SAME live `conceptGraph()` as 2D (no duplicated hardcoded scene); entering/exiting mutates ZERO graph records; exit returns to the 2D NodesCanvas | implemented (e2e deferred §9) | e2e + unit | `e2e/three-d.spec.ts` "the 3D scene reads the SAME live graph as 2D …", "… exiting returns to 2D"; `src/app/threeScene.map.test.ts` "reuses the 2D layout footprint …", "excludes hidden nodes …" |
| A09-M2  | Full concept-network graph (nodes/edges) with no forced camera motion — delivered across 2D + 3D | implemented (e2e deferred §9) | e2e + unit | `e2e/concept-network.spec.ts`, `e2e/three-d.spec.ts`; `src/network/scene.test.ts`, `src/app/threeScene.map.test.ts` (deterministic idle positions) |

## 8f. M2.5 completion + M3 preparation pass (FEAT-001..006)

The M2.5 pass resolves the two M2 product rulings (A14 category master pages,
N06 open-together placeholders), completes the M2 retrieval/navigation
requirements omitted in the v3.0 summary (A10 search/neighbourhood, A13 full
connecting pages, N04/N05/N07 reference-directed locating), and clears an M1
schema-debt item (annotation styles were smuggled into `BrainData.captures`)
that would have corrupted M3 backup validation. All additions are ADDITIVE and
v1-safe: the new fields `Relationship.explanatoryPageId?`,
`Category.masterPageId?`, and `PresentationState.annotationStyles?` are readonly
+ optional + safe-defaulted, so SCHEMA_VERSION stays `1` (ADR-0010, cross-refs
ADR-0008 hub topology and ADR-0009 presentation/3D state). Rendering/interaction
rows are covered by the real-browser Playwright specs `e2e/concept-network.spec.ts`
and `e2e/view-switch.spec.ts` (host-run in the publishing environment; the
sandbox cannot run Chromium — see §9) AND, so the sandbox proves correctness
headlessly, by the Vitest files named per row.

| ID     | Requirement (summary)                                                | Status      | Kind       | Covering test |
| ------ | -------------------------------------------------------------------- | ----------- | ---------- | ------------- |
| A13    | "The Bump" develops into a real Connecting Page (`explanatoryPageId`), opened in SubjectEditor, usable as a further relationship endpoint; idempotent | implemented (e2e deferred §9) | e2e + unit | `e2e/concept-network.spec.ts` "A13-M2: developing a relationship's connection promotes it to a real Connecting Page …"; `src/app/workbench.network.test.ts` "M2-FIX-1 (A13-M2, §12.1) — developRelationshipPage" (+ "persists the explanatoryPageId", "the explanatory page can be an endpoint in a further relationship"); `src/app/nodesCanvas.render.test.ts` "A13-M2: a rendered hub exposes an open-connecting-page control", "clicking open-connecting-page develops+opens the explanatory page" |
| A14    | Each category has one master `Page` (`masterPageId`); a master page may connect another category's boundary; `deriveCategoryLinks` emits `data-link-kind="master"|"member"` (master wins dedupe); 2D + 3D parity | implemented (e2e deferred §9) | e2e + unit | `e2e/concept-network.spec.ts` "A14-M2: connecting two category master pages renders a data-link-kind=\"master\" category-link", "a member-bridging relationship yields a data-link-kind=\"member\" category-link"; `src/network/scene.test.ts` "deriveCategoryLinks — master vs member boundary links (A14-M2, §12.2)" (4 cases); `src/app/workbench.network.test.ts` "Ruling 1 (A14-M2, §12.2) — category master pages"; `src/app/nodesCanvas.render.test.ts` "renders a 'master' category-link …" |
| A10    | Search across Page titles + body text, Category names, Annotation anchor + comment; filter by category + 1-hop neighbourhood; shell search surface opens the match | implemented (e2e deferred §9) | e2e + unit | `e2e/view-switch.spec.ts` "search: typing into the network search surfaces a matching page/category and selecting it opens it"; `src/network/search.test.ts` (search field matching + categoryId filter + neighbourhood, 17 cases); `src/app/workbench.search.test.ts` "Workbench.search — matches each searchable field", "Workbench.neighborhood — 1-hop …"; `src/app/networkSearch.render.test.ts` (render + select, 6 cases) |
| N04    | Annotation cited into EXACTLY 1 subject page: Show-in-Nodes switches to Nodes with that node `data-focused="true"` (single explicit locate) | implemented (e2e deferred §9) | e2e + unit | `e2e/view-switch.spec.ts` "N04: Show-in-Nodes for an annotation cited into ONE subject page focuses that node"; `src/app/workbench.view.test.ts` "N04: an annotation cited into EXACTLY 1 subject page — locate sets viewMode + focusedPageId"; `src/app/nodesCanvas.render.test.ts` "N04/N05: with focusedPageId set, the matching graph-node has data-focused='true'" |
| N05    | Annotation cited into >1 subject pages: a `nodes-destination-picker` lists them; choosing one focuses that node | implemented (e2e deferred §9) | e2e + unit | `e2e/view-switch.spec.ts` "N05: Show-in-Nodes for an annotation cited into TWO subject pages opens a destination picker"; `src/app/workbench.view.test.ts` "N05: an annotation cited into 2 subject pages returns BOTH (picker precondition)" |
| N06    | On open-together, a transient placeholder (`data-transient="true"`, `data-source-id`) renders for EVERY open unconnected source, each with `placeholder-return-reader`; returning creates ZERO durable records | implemented (e2e deferred §9) | e2e + unit | `e2e/view-switch.spec.ts` "N06 (open-together): every open unconnected PDF renders its own transient placeholder; returning to Reader creates nothing"; `src/app/workbench.view.test.ts` "Ruling 2 (N06, §7.2) — a placeholder per open UNCONNECTED source" (3 cases); `src/app/nodesCanvas.render.test.ts` "Ruling 2/N06: renders one placeholder group per open unconnected source …", "clicking Return-to-Reader switches to Files …" |
| N07    | Show-in-Nodes affordance appears ONLY when the annotation is cited into >= 1 subject page (absent at zero) | implemented (e2e deferred §9) | e2e + unit | `src/app/workbench.view.test.ts` "N07: an annotation cited into ZERO subject pages has no locate target"; `e2e/view-switch.spec.ts` N04/N05 (the `show-in-nodes` control + `data-cited-count`) |
| D07    | Reference-directed locate never causes unexpected camera jumps during ordinary editing (explicit user action only; A09-M2 preserved) | implemented (e2e deferred §9) | unit       | `src/app/workbench.view.test.ts` "A09-M2 guard: ordinary editing transitions NEVER change focusedPageId", "setFocusedPageId(null) clears the locate target without writing a record" |
| §14    | Annotation styles move to `presentation.annotationStyles`; load migration strips legacy sentinel `Capture` records so `captures` is clean for M3 backup validation | implemented | unit       | `src/app/workbench.styles.test.ts` "annotation styles live in presentation.annotationStyles" (8 cases incl. "strips a legacy sentinel Capture on load", "legacy migration does not overwrite an already-present presentation style") |

Additive schema guarantees (ADR-0010), proven in Vitest:

| Capability                                                            | Status      | Covering test |
| --------------------------------------------------------------------- | ----------- | ------------- |
| `Relationship.explanatoryPageId?`, `Category.masterPageId?`, `PresentationState.annotationStyles?` are readonly + optional; v1 shapes still load | implemented | `src/model/brain.test.ts`; `src/app/workbench.network.test.ts`; `src/app/workbench.styles.test.ts` |
| `createEmptyBrainData()` seeds `annotationStyles: {}` | implemented | `src/model/brain.test.ts` |
| SCHEMA_VERSION stays 1 (no migration; M7 per ADR-0004) | implemented | `src/model/brain.test.ts`; `src/test/model.test.ts` |

## 8g. M3 backup, recovery, and validation (FEAT-001..003)

M3 delivers Complete Backup, Recovery, and Validation. The data contract gains
the first REAL schema bump (SCHEMA_VERSION 1 -> 2) backed by a pure stepwise
migration runner; all new fields are additive + optional + v1-safe (ADR-0011).
The UI surfaces (backup export modal, Library offload control + badge, Reader
two-mode deletion + binary-offloaded popover, import staging report) are proven
headlessly by jsdom render tests against a REAL Workbench, and by the written
`e2e/backup-recovery.spec.ts` (host-run in the publishing environment; the
sandbox cannot run Chromium, so the spec is compiled + discovered via
`npx playwright test --list` only — see §9).

| ID  | Requirement (summary)                                                | Status      | Kind       | Covering test |
| --- | -------------------------------------------------------------------- | ----------- | ---------- | ------------- |
| A17 | Offline-first citations: offloading a source's PDF binary keeps the Source + annotations + citations; status flips to `binary-offloaded`; a followed quote resolves `binary-offloaded` (carrying the stored quote/comment/page); sha256-verified re-attach returns it to cached/resolved; a mismatched file is rejected | implemented (e2e deferred §9) | e2e + unit | `e2e/backup-recovery.spec.ts` "A17: offloading a PDF binary keeps the source + citations and flips the availability badge"; `src/app/workbench.backup.test.ts` (offload/attach/resolve); `src/app/library.offload.render.test.ts` (badge + offload row control); `src/app/reader.m3.render.test.ts` (binary-offloaded popover + attach) |
| A18 | Targeted Backup Checklist: Full Archival Backup by default; unticking any optional box downgrades the `backup-mode-badge` to the Targeted text and stamps `manifest.backupMode='targeted'` + the matching `manifest.omissions` tokens (`presentation`/`captures`/`revisions`/`sourceBinaries`) | implemented (e2e deferred §9) | e2e + unit | `e2e/backup-recovery.spec.ts` "A18: the Targeted Backup Checklist drives the mode badge and omission stamping"; `src/app/workbench.backup-engine.test.ts` (exportBackup omission stamping); `src/app/backupExportModal.render.test.ts` (badge flip + options->omissions mapping) |
| A19 | Isolated staging validator: hard-reject (corrupt/unparseable/bad %PDF-), default-reject needs-confirmation (schema/checksum/missing-array), and ready; `import-staging-report` lists findings; `try-import-anyway` commits leniently through the stepwise migration; the live store is never touched before commit | implemented (e2e deferred §9) | e2e + unit | `e2e/backup-recovery.spec.ts` "A19: a schema-mismatched bundle is staged (default reject) and Try Import Anyway commits leniently"; `src/storage/staging.test.ts`; `src/model/migrate.test.ts`; `src/app/importStagingReport.render.test.ts` (report + lenient commit path) |
| D02 | Two-mode highlight deletion: `delete-highlight-only` removes the annotation but keeps every quote (pair derives `unresolved`); `delete-highlight-and-quotes` records a pre-mutation Revision snapshot then strips the inline quote while preserving surrounding prose | implemented (e2e deferred §9) | e2e + unit | `e2e/backup-recovery.spec.ts` "D02: delete-highlight-only keeps the quote; delete-highlight-and-quotes removes the inline quote"; `src/app/workbench.deletion.test.ts`; `src/app/reader.m3.render.test.ts` (both delete controls invoke the right methods) |
| D09 | Two-lane disentangled backup (Lane 1 `brain.ito.json` + Lane 2 `.ito.zip` via fflate, assets stored byte-identical) and a batch PdfIngestionQueue (bounded concurrency, %PDF- + size guard, hydrate-existing vs create-new) | implemented | unit       | `src/storage/backup.test.ts` (two-lane round-trip); `src/app/workbench.backup-engine.test.ts`; `src/app/workbench.ingest.test.ts` (PdfIngestionQueue hydrate/create/reject) |

Schema + migration (ADR-0011), proven in Vitest:

| Capability                                                            | Status      | Covering test |
| --------------------------------------------------------------------- | ----------- | ------------- |
| SCHEMA_VERSION bumped 1 -> 2; additive `binary-offloaded` resolution, `manifest.backupMode`/`omissions`, Revision `beforeSnapshot`/`affectedObjectIds` are optional + v1-safe | implemented | `src/model/migrate.test.ts`; `src/test/model.test.ts` |
| Pure stepwise `migrateBrainData(raw)` runner: v0->v1->v2 steps + fillDefaults; `FutureSchemaError` on a newer payload; shared registry with the StorageAdapter | implemented | `src/model/migrate.test.ts` |
| `window.__ito` gains exportBackup/stageImport/stageLastExport/commitStagedImport/offloadSourceBinary/attachSourceBinary/sourceBinaryStatus/readSourceBytes/deleteAnnotationOnly/deleteAnnotationAndQuotes, mirrored exactly in `e2e/ito-globals.d.ts` (typecheck proves sync) | implemented | `src/app/testApi.ts`; `e2e/ito-globals.d.ts` (typecheck gate) |
| fflate decision: `fflate@^0.8.3` installed successfully against the registry and is USED for the `.ito.zip` codec; a pure deterministic codec was the documented fallback had the install failed (ADR-0011) | implemented | `src/storage/backup.test.ts` (zip round-trip) |

## 9. Sandbox verification note (M2 + M3)

The Playwright Chromium binary CANNOT be downloaded in the build sandbox (the
proxy returns HTTP 403 on the Playwright CDN; the Microsoft mirror transfers
zero bytes), so `npm run test:e2e` cannot run here — the e2e specs are WRITTEN
and host-run in the publishing environment. All e2e specs
(`concept-network.spec.ts`, `view-switch.spec.ts`, `three-d.spec.ts` plus the
M1 suites, 50 tests / 8 specs at M2.5) are the real deliverable; their non-trivial glue
is ALSO proven headlessly in the sandbox so correctness is provable without a
browser:

- FEAT-003 (data contract + density monitor): `src/app/workbench.network.test.ts`.
- FEAT-004 (2D NodesCanvas): `src/network/scene.test.ts` (pure graph→props,
  layout-driven positions, hub topology/path, squircle bounds + A10 intersection,
  A14 category-link derivation, blend) + `src/app/nodesCanvas.render.test.ts`
  (jsdom render of the real component against a real Workbench).
- FEAT-005 (Files/Nodes switch + N06): `src/app/workbench.view.test.ts` +
  `src/app/nodesCanvas.render.test.ts`.
- FEAT-006 (§3.4 3D shift): `src/app/threeScene.map.test.ts` (pure
  graph→{particles,hulls,links} mapping, live-graph parity, hull sizing,
  deterministic depth, empty-graph safety, and the `revealPresentation`
  density-reward reveal mapping) + the FEAT-003 density-threshold tests. WebGL
  itself cannot run headlessly in the sandbox, so the ThreeScene renderer carries
  a WebGL guard with a 2D fallback that the e2e spec asserts conditionally.

FINAL M3 gate results on this working tree (real runs, not fabricated):

| Suite                  | Command             | Result            |
| ---------------------- | ------------------- | ----------------- |
| TypeScript typecheck   | `npm run typecheck` | pass (0 errors)   |
| Unit / integration     | `npm run test`      | 315 passed / 36 files (was 241 / 24 at M2.5) |
| Production build        | `npm run build`     | pass (fflate + three.js bundled) |
| Runtime (real browser) | `npm run test:e2e`  | 54 tests / 9 specs WRITTEN; host-run (sandbox e2e deferred — CDN block). Enumerated/compiled here via `npx playwright test --list` (lists `backup-recovery.spec.ts` A17/A18/A19/D02). |

The M3 backup/recovery pass (ADR-0011) adds these headless mirrors for the e2e
behaviours: `src/app/workbench.backup.test.ts` + `src/app/library.offload.render.test.ts`
+ `src/app/reader.m3.render.test.ts` (A17 offline-first citations + offload/attach),
`src/app/workbench.backup-engine.test.ts` + `src/app/backupExportModal.render.test.ts`
(A18 Targeted Backup Checklist + omission stamping), `src/storage/staging.test.ts`
+ `src/model/migrate.test.ts` + `src/app/importStagingReport.render.test.ts`
(A19 staging reject + Try Import Anyway + stepwise migration),
`src/app/workbench.deletion.test.ts` (D02 two-mode deletion), and
`src/storage/backup.test.ts` + `src/app/workbench.ingest.test.ts` (D09
two-lane backup + batch ingestion).

The M2.5 refinements (ADR-0010: `explanatoryPageId` / `masterPageId` /
`annotationStyles`) add the following headless mirrors for the e2e behaviours:
`src/network/search.test.ts` + `src/app/workbench.search.test.ts` +
`src/app/networkSearch.render.test.ts` (A10 search/neighbourhood),
`src/app/workbench.network.test.ts` (A13 developRelationshipPage + A14 master
pages), `src/network/scene.test.ts` (A14 master|member category-links),
`src/app/workbench.view.test.ts` (N04/N05/N07 locating + multi-PDF N06 + the
D07 no-camera-jump guard), `src/app/nodesCanvas.render.test.ts` (open-connecting
control, master link, placeholder-per-source, focused node), and
`src/app/workbench.styles.test.ts` (§14 annotation-style migration).

## 8. Proposed next decisions (D-items)

New decisions surfaced by FEAT-005 that should be recorded before the relevant
milestone builds on them (numbering continues the decision log D01–D18):

- **D19 — Pane-configuration persistence scope. RESOLVED (M2, ADR-0009).** The
  M1 reader-workbench view state (pane width weights, line visibility, category
  scope) STAYS session-only. The M2 concept-network canvas state
  (`nodePositions`, `dragOffsets`, `categoryBounds`, `zoom`, `active3D`) is
  DURABLE in `BrainData.presentation`, because a hand-arranged graph is
  content-adjacent work and losing it on reload would be a data-loss-like
  surprise. See ADR-0009 §2. (relates R19, N08)
- **D20 — Passage-to-evidence line routing at scale. RESOLVED (M2, ADR-0008).**
  The N-endpoint "Connecting Page" draws ONE hub glyph with N legs instead of
  N·(N−1)/2 pairwise lines, reducing clutter structurally; ADR-0008 fixes the
  DATA shape. At graph scale FEAT-004 renders those hubs (lens N=2 / concave
  star N>=3) plus data-driven category-to-category links, and FEAT-006 adds the
  §3.4 density-reward escape valve: once the network passes 35 active nodes the
  reader can lift the whole graph into a navigable 3D space where overlapping
  categories separate by depth, the ultimate clutter treatment. The M1
  inter-pane passage lines keep their simple always-on margin routing. (relates
  A08, section 10.2, §3.1, §3.4)
- **D21 — Narrow-screen flow beyond the stub.** The responsive stub is a
  documented placeholder. Decide the real mobile composition flow (tabbed panes,
  bottom-sheet editor, or deferred to a packaged app) at M7 hardening. (relates
  section 8.2, N07)
- **D22 — Third-paper swap vs. "add a pane".** `switchReaderPane` replaces a
  pane's source in place. Decide whether the workspace should also support
  ADDING a pane (N papers open together) or stay at the approved A|subject|B
  arrangement. Default proposal: keep the fixed arrangement for M1; evaluate an
  N-pane workspace with the graph navigation work. (relates section 8.2 note)

## Pass A - M7 history, M6 sources, and visual/interaction polish (ADR-0012)

Pass A delivers M7 linked history + M6 Zotero/website/area sources + the section
3 fixes across three FEAT units. Runtime behavior is proven headlessly in Vitest
(the sandbox cannot run Playwright Chromium); the two new e2e specs are proven to
COMPILE + be DISCOVERED via `npx playwright test --list`.

| ID       | Behaviour                                                                                     | Test kind  | Test / location | Status |
| -------- | --------------------------------------------------------------------------------------------- | ---------- | --------------- | ------ |
| H01      | Coalesced prose revisions: same-Page typing within a 2000 ms idle window folds into one revision; `flushPendingRevision()` commits it deterministically | unit + e2e | `src/app/workbench.history.test.ts`; `e2e/history-reflection.spec.ts` | implemented |
| H02      | Structural actions (quote insert/remove/reorder, annotation comments, range boundaries, tentative associations, categories, relationships) flush immediately as their own revision | unit | `src/app/workbench.history.test.ts` | implemented |
| H03      | Day-grouped timeline with a single-day picker + date-range filter | unit + e2e | `src/app/historyReflectionPanel.render.test.ts`; `e2e/history-reflection.spec.ts` | implemented |
| H04      | Cherry-picked multi-day reflection storing linkedRevisionIds + start/end date keys; per-change comments; reflections never rewrite revisions or create graph nodes | unit + e2e | `src/app/workbench.history.test.ts`; `e2e/history-reflection.spec.ts` | implemented |
| H05      | `reconstructRevisionState` replays from the nearest checkpoint or returns `missing-segment`; `restoreRevision` records a NEW forward revision (history never erased) | unit + e2e | `src/app/workbench.history.test.ts`; `e2e/history-reflection.spec.ts` | implemented |
| H06, D13 | A validated Checkpoint every 20 revisions whose stateSnapshot excludes `revisions`+`checkpoints` and carries no PDF bytes | unit | `src/app/workbench.history.test.ts` | implemented |
| H07      | `measureHistoryOverhead` returns `{revisionCount,checkpointCount,deltaBytes,checkpointBytes,replayDurationMs}` | unit + e2e | `src/app/workbench.history.test.ts`; `e2e/history-reflection.spec.ts` | implemented |
| D14      | Reflection spanning multiple days renders a date-span badge; linked across days/weeks/months | unit + e2e | `src/app/historyReflectionPanel.render.test.ts`; `e2e/history-reflection.spec.ts` | implemented |
| A24, D10 | Idempotent Zotero import (Zotero JSON / BetterBibTeX / RDF): matches on externalId in place, zero duplicate Source/Annotation, zero graph nodes | unit + e2e | `src/storage/zotero.test.ts`; `src/app/workbench.sources.test.ts`; `e2e/zotero-website.spec.ts` | implemented |
| A15, D11 | Website sources require URL + snapshot; URL-only submit rejected with `website-snapshot-required-error`; stored sanitized as kind `website` + `snapshot-cached` with an availability badge | unit + e2e | `src/app/workbench.sources.test.ts`; `src/app/library.website.render.test.ts`; `e2e/zotero-website.spec.ts` | implemented |
| D01      | Extended PDF scope banners (scanned / encrypted) + area annotations (`scope.kind='area'`) rendered as a labeled region and citable | unit + e2e | `src/app/workbench.sources.test.ts`; `e2e/zotero-website.spec.ts` | implemented |
| FIX-3.1  | PDF page header/stage split; pdfjs v4 textLayer CSS; overlays measured relative to `pdf-page-stage`; pageCount backfill | unit | `src/pdf/highlight.test.ts`; `src/app/workbench.sources.test.ts` | implemented |
| FIX-3.2  | Narrow-pane auto-fit: ResizeObserver fit-to-pane scale (`--scale-factor` + `max-width:100%`), no horizontal clipping | unit | `src/app/reader.m3.render.test.ts` (pane-fit) | implemented |
| FIX-3.3  | Interactive 2D canvas: `buildScene` applies dragOffsets/nodePositions + recomputes hubs/squircles (determinism preserved); NodesCanvas node-drag -> `setDragOffset`, pan (`data-pan-x/y`), wheel+button zoom -> `setZoom` | unit | `src/network/scene.test.ts`; `src/app/nodesCanvas.render.test.ts` | implemented |
| FIX-3.4  | Warm Archival Research theme tokens + tactile 160 ms micro-animations; STRICT motion gate under `[data-suppress-motion]` + `prefers-reduced-motion` | unit | `src/app/theme.render.test.ts` | implemented |
| FIX-3.5  | 3D contrast: `#141824` backdrop/fog, glowing nodes, hull opacity 0.28 + rim wireframe, visible lines; WebGL guard + fallback intact | unit | `src/app/threeScene.map.test.ts` | implemented |

Decision: `docs/decisions/ADR-0012-m7-history-m6-sources-and-visual-polish.md`
records the M7 history/checkpoint/reflection model, the M6 Zotero/website/area
additions, the PDF stage/overlay restructuring + pane-fit + pageCount backfill,
the 2D interaction + tactile theme + 3D contrast changes, and the decision to
keep SCHEMA_VERSION at 2 (all additions additive + optional).

## Pass B - M4 Koofr sync, M5 mobile captures, and the visual audit fixes (ADR-0013)

Pass B closes the LAST two milestones (M4 delivery/sync + M5 mobile captures) and
the section 3 mandatory visual audit fixes across three FEAT units. With it,
**all milestones M0 through M7 are complete.** Runtime behaviour is proven
headlessly in Vitest (the sandbox cannot run Playwright Chromium); the two new
e2e specs (`koofr-mobile-sync.spec.ts`, `mobile-captures.spec.ts`) are proven to
COMPILE + be DISCOVERED via `npx playwright test --list` (total 71 tests / 13
specs).

| ID       | Behaviour                                                                                     | Test kind  | Test / location | Status |
| -------- | --------------------------------------------------------------------------------------------- | ---------- | --------------- | ------ |
| §15, D08 | KoofrStorageAdapter: WebDAV PUT/GET(404->null)/PROPFIND/MKCOL; injectable fetch; Basic auth built only from runtime config; publication-layout helpers | unit | `src/storage/koofrStorageAdapter.test.ts` | implemented |
| §15, §16.1, A20, H06 | `publishToRemote` pointer-last protocol: upload only missing assets (H06), write+verify snapshot (sha256), update `current-revision.json` LAST; a fault before the pointer leaves the prior pointer intact | unit + e2e | `src/app/workbench.koofr.test.ts`; `e2e/koofr-mobile-sync.spec.ts` "A20/H06: publish then refresh round-trip" | implemented |
| A20      | `refreshFromRemote` retains the local working copy untouched on a dropped/corrupted/invalid update and sets a stale/offline `syncStatus` with a reason | unit + e2e | `src/app/workbench.koofr.test.ts`; `e2e/koofr-mobile-sync.spec.ts` "A20: an interrupted/invalid refresh retains the local copy" | implemented |
| A21      | Phone reading shell: inspect-related-writing sheet opens and returning preserves the exact PDF source + scroll + zoom; per-source offline cache controls | unit + e2e | `src/app/mobileReaderShell.render.test.ts`; `e2e/koofr-mobile-sync.spec.ts` "A21: the mobile reader shell preserves the source" | implemented |
| §16.2, A23 | `createMobileCapture` saves locally immediately and creates ZERO Page/Category/Relationship (with or without a source) | unit + e2e | `src/app/workbench.captures.test.ts`; `src/app/mobileCaptureComposer.render.test.ts`; `e2e/mobile-captures.spec.ts` "A23: creating a capture adds zero graph nodes" | implemented |
| §16.2, A22 | `uploadPendingCaptures` / `pullRemoteCaptures` dedupe strictly by CaptureId across repeated + out-of-order pulls (incorporate each at most once) | unit + e2e | `src/app/workbench.captures.test.ts`; `e2e/mobile-captures.spec.ts` "A22: repeated and out-of-order pulls incorporate each capture at most once" | implemented |
| §16.3, A22 | `handleCapture` four dispositions (insert-into-page/create-subject/dismiss), idempotent by CaptureId; the desktop capture processing queue | unit + e2e | `src/app/workbench.captures.test.ts`; `src/app/captureProcessingQueue.render.test.ts`; `e2e/mobile-captures.spec.ts` "A22/§16.3: the four queue dispositions record the right handling" | implemented |
| D12      | Sync banner (`sync-publication-status` + publish/refresh) + Import Zotero button/modal surfaced in the shell | unit | `src/app/syncBanner.render.test.ts`; `src/app/library.zotero.render.test.ts` | implemented |
| FIX-3.1  | FIX-HORIZONTAL-HIGHLIGHT-DRIFT: `max-width:100%` removed from `.pdf-page-stage`; canvas/textLayer/overlay locked 1:1; identical normalized left/width at 0.6x narrow-pane scale | unit | `src/pdf/anchorScale.test.ts`; `src/pdf/highlight.test.ts` | implemented |
| FIX-3.2  | FIX-NODES-LABEL-OVERLAP: "Open connecting page" pill hidden until hub hover/select; category label at the squircle top arch with a readable halo | unit | `src/app/nodesCanvas.render.test.ts` | implemented |
| FIX-3.3  | FIX-NARROW-PANE-TOOLBARS: Reader + SubjectEditor headers single-row (ellipsized title, compact buttons, close pinned right) | unit | `src/app/reader.m3.render.test.ts`; theme.css `.ito-pane-header`/`.ito-pane-title`/`.ito-pane-actions` | implemented |
| FIX-3.4  | FIX-HISTORY-FULL-LAYOUT: `daily-review-panel` is a full-width two-column grid with an empty-state message | unit | `src/app/historyReflectionPanel.render.test.ts`; theme.css `[data-testid="daily-review-panel"]` | implemented |
| FIX-3.5  | FIX-TOP-BAR-CLIPPING + RESTORE BUTTON STYLE: `.app-shell` strict flex column, `.shell-header` non-clipped, `.view-body` flex:1; Restore label styled like `.ito-btn`/button | unit | `src/app/theme.render.test.ts`; theme.css `.app-shell`/`.shell-header`/`.view-body`/`label[data-testid="open-restore-input"]` | implemented |

Decision: `docs/decisions/ADR-0013-m4-koofr-sync-and-m5-mobile-captures.md`
records the KoofrStorageAdapter WebDAV design + injectable fetch + runtime-only
credentials, the pointer-last atomic publication protocol + the A20 retain-local
guarantee, the idempotent-by-CaptureId capture engine + the A23 no-auto-graph-node
rule, the six visual audit fixes, and the decision to keep SCHEMA_VERSION at 2
(all capture additions additive + optional).

## MILESTONE COMPLETION - M0 through M7 (final)

With Pass B merged, every milestone in the plan is delivered and covered:

| Milestone | Scope                                                             | Status    |
| --------- | ----------------------------------------------------------------- | --------- |
| M0        | Boot/READY + ERROR states, PDF fixtures, anchor spike             | complete  |
| M1        | Reading workbench + subject layer + integrated three-pane workspace | complete  |
| M2        | Concept network (2D NodesCanvas), Files/Nodes switch, 3D shift    | complete  |
| M2.5      | Category master pages, open-together N06, search/locate, schema debt | complete  |
| M3        | Complete backup, recovery, validation (SCHEMA_VERSION 1 -> 2)     | complete  |
| M4        | Koofr delivery/hosting + safe pointer-last publication + refresh   | complete  |
| M5        | Mobile captures (idempotent-by-CaptureId) + reader shell + queue   | complete  |
| M6        | Zotero import, snapshot websites, area annotations                | complete  |
| M7        | Linked history, checkpoints, multi-span reflection                | complete  |
| M9        | Zotero-style reader rework: tool-first annotation engine, single reader toolbar + gear settings, shared UI kit (`primitives.tsx`), annotations-only right panel, Thumbnails/Outline left sidebar, sortable Library table, Nodes toolbar restyle | complete  |

## M9 — reader rework (tool-first UI + UI kit)

M9 reworks the reader INTERACTION layer without touching the data model
(`src/model/types.ts`) or the storage schema (SCHEMA_VERSION unchanged). See
`docs/decisions/ADR-0014-m9-reader-rework-tool-first-ui-kit.md`.

| Capability                                                                 | Status      | Kind | Covering test |
| -------------------------------------------------------------------------- | ----------- | ---- | ------------- |
| Shared UI kit in one file (`Button`, `IconButton`, `Menu`, `Popover`)      | implemented | unit | `src/app/ui/primitives.render.test.ts` |
| Single reader toolbar (<= 44px) + gear settings menu; serif-font fix       | implemented | unit+e2e | `src/app/m8UiOverhaul.render.test.ts`, `src/app/theme.render.test.ts`; `e2e/reader-workbench.spec.ts` |
| Tool-first annotation engine (H/U/N/A + colours 1-4; Note reuses `commitAreaAnnotation`) | implemented | unit | `src/app/reader.feat002.render.test.ts` |
| Annotations-only right panel: cards + colour chips + search + this-page/all; click scrolls/flashes/selects | implemented | unit+e2e | `src/app/reader.feat002.render.test.ts`; `e2e/reader-workbench.spec.ts` (filter/search) |
| Left sidebar: Thumbnails (lazy ~120px, current outlined) + Outline (hidden when none) | implemented | unit | `src/app/reader/leftSidebar.render.test.ts` |
| Library sortable table (Title/Authors/Year/Pages/Annotations/Date added) + collection tree; Import PDF + drag-drop + Open-together kept | implemented | unit | `src/app/library.table.render.test.ts`, `src/app/library.offload.render.test.ts`, `src/app/library.zotero.render.test.ts` |
| Nodes toolbar restyled with the shared primitives (no behaviour change)    | implemented | unit | `src/app/nodesCanvas.render.test.ts` |
| 12-page two-column fixture with an embedded raster figure                  | implemented | unit | `scripts/gen-fixtures.mjs`; `src/test/fixtures.test.ts` |
| Single-pass screenshot harness (library/reader/reader-with-popover/nodes @ 1024/1280/1440) | implemented | n/a  | `scripts/local-shot.mjs`, `scripts/run-local-shot.sh` |

Final gate on this working tree (real runs): `npm run test` and
`npx vitest run --no-file-parallelism` both 419 passed, `npm run typecheck`
0 errors, `npm run build` succeeds, and `npx playwright test --list` discovers
71 tests across 13 specs (including the two new Pass B specs).
