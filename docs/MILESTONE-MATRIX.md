# MILESTONE MATRIX — M0 + M1

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
| Unit / integration        | `npm run test`      | 141 passed / 17 files |
| Runtime (real browser)    | `npm run test:e2e`  | 29 passed / 5 specs + `concept-network.spec.ts` written (6 tests, sandbox: e2e deferred, see §9) |

E2E specs: `e2e/ready.spec.ts` (boot), `e2e/pdf-anchor.spec.ts` (anchor
round-trip spike), `e2e/reader-workbench.spec.ts` (M1 reading workbench),
`e2e/subject-editor.spec.ts` (M1 subject layer + continuous editor),
`e2e/concept-network.spec.ts` (M2 NodesCanvas — A09/A10/A13/A14-M2),
`e2e/workspace.spec.ts` (M1 integrated three-pane workspace + context-preserving
transitions).

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
| Full concept-network graph (nodes/edges, camera)      | M5        | BACKLOG M5; D11–D13 |
| Graph `hide` as presentation state at graph scale     | M5        | D13 (foundation shipped here for lines) |
| Categories grouping pages by id in the graph          | M5        | D14 |
| Remote storage (Koofr/WebDAV) adapter                 | M4        | ADR-0005; `docs/spikes/koofr-access.md`; D08/D09 |
| Safe publication against a remote + delivery/hosting   | M4        | ADR-0005; D10, D17 |
| Captures → structured pages; named revisions          | M6        | D15, D16 |
| Schema migrations past v1                             | M7        | ADR-0004; D18 |
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
- **Full concept-network graph + its camera.** M1 only guarantees NO unexpected
  camera motion during transitions and a non-destructive line toggle; the graph
  itself, its layout persistence, and node/edge hide-at-scale are M5.

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

## 9. Sandbox verification note (M2)

The Playwright Chromium binary CANNOT be downloaded in the build sandbox (the
proxy returns HTTP 403 on the Playwright CDN), so `npm run test:e2e` cannot run
here and its result above is the last recorded run from the publishing
environment. FEAT-003 contains NO rendering and is fully verifiable headlessly.
FEAT-004 DOES render, so its Playwright spec `e2e/concept-network.spec.ts` is
written (it runs in the publishing environment) but its non-trivial glue —
graph→props mapping, layout-driven node positions, hub topology/path, squircle
bounds + A10 intersection, A14 category-link derivation, blend pass-through — is
ALSO proven headlessly in the sandbox by `src/network/scene.test.ts` (pure) and
`src/app/nodesCanvas.render.test.ts` (jsdom render of the real component against
a real Workbench). The gates `npm run typecheck`, `npm run test` (Vitest) and
`npm run build` are all green in the sandbox. Every behaviour a later e2e spec
will cover (hub topology, blend, hide, density threshold, N06 zero-record
guarantee, squircle containment, category-link) has Vitest coverage of its
headless/pure logic so correctness is proven without a browser.

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
- **D20 — Passage-to-evidence line routing at scale. ADDRESSED (M2, ADR-0008).**
  The N-endpoint "Connecting Page" draws ONE hub glyph with N legs instead of
  N·(N−1)/2 pairwise lines, reducing clutter structurally; ADR-0008 fixes the
  DATA shape. The M1 inter-pane passage lines keep their simple always-on margin
  routing; detailed density treatments (bundling, fade, hover-reveal) remain a
  FEAT-005/006 rendering concern under D20. (relates A08, section 10.2, §3.1)
- **D21 — Narrow-screen flow beyond the stub.** The responsive stub is a
  documented placeholder. Decide the real mobile composition flow (tabbed panes,
  bottom-sheet editor, or deferred to a packaged app) at M7 hardening. (relates
  section 8.2, N07)
- **D22 — Third-paper swap vs. "add a pane".** `switchReaderPane` replaces a
  pane's source in place. Decide whether the workspace should also support
  ADDING a pane (N papers open together) or stay at the approved A|subject|B
  arrangement. Default proposal: keep the fixed arrangement for M1; evaluate an
  N-pane workspace with the graph navigation work. (relates section 8.2 note)
