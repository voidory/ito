# HANDOFF: M13 — SPATIAL SUBJECT BASINS, GLAZED VENN OVERLAPS, TOP-2 SOURCE WORKSPACE ROUTING & READER SCROLL/RENDER FIXES

Repo: `/projects/sandbox/ito`

## 0. Branch Setup, Credit Cap & Sandbox Rules (MANDATORY)

1. **Auto-Detect Latest Base Branch (`m12*` / `m11*` / `fix-rotated*` / `m10*`) in 1 Bash Call:**
   ```bash
   git fetch origin --prune
   BASE_BRANCH=$(git for-each-ref --sort=-committerdate refs/remotes/origin --format="%(refname:lstrip=3)" | grep -E "^(m12|m11|fix-rotated|m10-structural-unification)" | head -n 1)
   if [ -z "$BASE_BRANCH" ]; then BASE_BRANCH="m10-structural-unification"; fi
   echo "Branching m13-spatial-ontology-basins from origin/$BASE_BRANCH"
   git checkout -B m13-spatial-ontology-basins "origin/$BASE_BRANCH"
   ```
2. **Strict 2-FEAT Cap & Zero Subagent Bloat:**
   - Do **NOT** create a separate `FEAT-000` setup subagent (only run `npm ci` inside `FEAT-001` if `node_modules` is missing).
   - Structure the work into **ONLY 2 `FEAT` units**:
     - **`FEAT-001` (Reader Stability: Canvas Render Serialization, Scroll-Following Selection Previews & Quote-to-Rect Re-Anchoring):** §1 below.
     - **`FEAT-002` (Spatial Ontology: Moveable Watercolour Subject Basins, Glazed Overlaps, 4-Tier Canvas Hit-Testing & Top-2 Source Workspace Routing):** §2 below.
   - Run **ONLY targeted Vitest files** during iteration (`npx vitest run <file> && npm run typecheck`). Run the full suite + single `chrome-headless-shell` verification **ONLY ONCE** at the end of `FEAT-002`.
   - Run `subagent_reviewer` at most once (or skip if all hard gates pass).
3. **Sandbox Browser Rules (CRITICAL):**
   - **NEVER** use the Playwright MCP server (`KAS_MCP_OFFLOAD` Squid proxy blocks `127.0.0.1`), **NEVER** run background dev servers across separate bash calls (`bwrap --unshare-pid`), and **NEVER** run full Chromium (`SIGTRAP`).
   - Run live verification once at the end of `FEAT-002` in a single `execute_bash` call using `/inner_container/opt/playwright/chromium_headless_shell-1232/chrome-headless-shell-linux64/chrome-headless-shell`.

---

## 1. `FEAT-001` — Reader Canvas Serialization, Scroll-Locked Selection Previews & Live Quote-to-Rect Re-Anchoring

### 1.1 Fix Blank White `<canvas>` Race on Fit-Width / Zoom (`src/pdf/render.ts` & `src/app/reader/SourcePane.tsx`)
- **Root Cause:** In `src/pdf/render.ts`, `renderPage()` starts an initial `draw()` (`page.render({ canvasContext, viewport }).promise`), and immediately afterward `SourcePane.tsx`'s `ResizeObserver` / fit-width effect invokes `serializedRerender(page, scale)`. Because `serializedRerender` only serializes *rerender* calls against each other—without awaiting or cancelling the initial `renderPage()` in-flight `RenderTask`—`pdf.js` throws `"Cannot use the same canvas during multiple render() operations"` and clears Page 2's canvas to blank white (especially visible at `260%` Fit-width on `Rotated Fixture`).
- **Mandatory Implementation:**
  1. Inside `renderPage()` in `src/pdf/render.ts`, maintain a per-page internal promise queue (or track `let activeRenderTask: RenderTask | null = null` and call `activeRenderTask.cancel()` catching `RenderingCancelledException` before starting the next `page.render()`) so the initial `draw()` and any subsequent `rerender(newScale)` can **NEVER** execute concurrently on the same `<canvas>`.
  2. Ensure every `.pdf-page-stage` container's CSS `width` and `height` strictly match its own page's rendered `<canvas>` CSS dimensions (especially on `Rotated Fixture` where Page 2's rotated aspect ratio differs from Page 1).

### 1.2 Fix `LiveSelectionPreview` & `SelectionToolbar` Drifting Outside the Page on Scroll (`SourcePane.tsx` & `AnnotationOverlays.tsx`)
- **Root Cause:** `LiveSelectionPreview` renders with `position: fixed` using viewport `DOMRect`s (`livePreviewRects`) captured only on `selectionchange`. When the user scrolls `.pane-scroll`, `selectionchange` does not fire, so the yellow preview pill stays frozen at stale viewport coordinates (floating off the white page onto the beige desk) and `SelectionToolbar` stays frozen on screen.
- **Mandatory Implementation:**
  1. In `SourcePane.tsx`'s `rAF` scroll coalescer (`onPaneScroll`, alongside `redrawOverlays()`), whenever a non-collapsed browser selection or `toolbar` state is active, recompute `livePreviewRects` and `toolbar.anchor` from the current `window.getSelection()?.getRangeAt(0).getBoundingClientRect()` / `getClientRects()` clipped to the originating `.pdf-page-stage`!
  2. When a highlight is committed (`commitSelection`) or dismissed, immediately clear `livePreviewRects` (`setLivePreviewRects([])`). If scrolling moves the selection's anchor rect completely outside `.pane-scroll`'s visible viewport, hide/clip `LiveSelectionPreview` and `SelectionToolbar`.

### 1.3 Live Quote-to-Rect Re-Anchoring When Revised PDFs Shift Paragraph Coordinates (`src/pdf/highlight.ts` & `SourcePane.tsx`)
- **Root Cause:** In M12 (`reconcileOrAttachSource`), when a revised draft (`Lab1_draft` $\rightarrow$ `Lab1_final`) moves a paragraph to a new vertical position or new page, `pageIndex` is updated, but the annotation's stored `anchor.rects` still hold the old `[x, y, w, h]` coordinates from the previous draft.
- **Mandatory Implementation:**
  1. In `src/pdf/highlight.ts` (`resolveAnchor` / `recomputeRectsFromQuote(pageStageEl, quote)`), add a pure DOM helper that locates `quote` (whitespace-normalized substring match) across the `.textLayer` text nodes of `pageStageEl`, constructs a DOM `Range` spanning those characters, and converts `range.getClientRects()` into normalized `[x, y, width, height]` (`0..1`) rects relative to `pageStageEl`. (In `jsdom` where `getClientRects()` returns `0x0`, fall back to the matched `.textLayer span`'s bounding/style box or existing `anchor.rects`).
  2. When `reconcileOrAttachSource` in `workbench.ts` detects that `contentHash` / `versionHash` changed on an existing `Source`, mark its text annotations with `rectsStale?: boolean` (or when `SourcePane.tsx` renders a page whose text annotation's stored `rects` do not match the live `.textLayer` text position), run `recomputeRectsFromQuote` once on page render and persist the updated `rects`!
  3. Add a unit test in `src/app/workbench.rehydrate.test.ts` (or `src/pdf/highlight.test.ts`) proving that when a paragraph's vertical position shifts on a revised page, `recomputeRectsFromQuote` updates the highlight's normalized `[x, y, w, h]` to the new span coordinates.

---

## 2. `FEAT-002` — The 4-Tier Spatial Epistemology: Subject Basins, Glazed Overlaps, Node Intersections & Top-2 Source Workspace Routing

### 2.1 Formal Ontology & Backward-Compatible Model Upgrades (`src/model/types.ts` & `src/app/workbench.ts`)
Enforce Ito's 4-tier epistemology across the model and UI (while keeping all existing 516+ unit tests passing via backward-compatible defaults/aliases):
1. **Memories (`Annotation`: Highlight / Underline / Area Figure / Note):**
   - Live inside the PDF Reader first. Never auto-clutter the Nodes Canvas unless actively promoted/inserted.
   - Add a `"Promote Note / Highlight to Observation Node"` action (`wb.promoteAnnotationToNode(annotationId, opts?)`, `data-testid="promote-to-node-btn"`) in `HighlightEditPopover` and `ReaderContextMenu` so any Note or Highlight that grows into an idea of its own can be escalated into an Observation Node on the canvas.
2. **Subjects = Moveable Watercolour Basins / Territories (`Category` / Subject Space — NEVER a Point-Node!):**
   - A **Subject** is the coloured watercolour territory/basin on the canvas in which Observation Nodes rest—and each Subject has its own overarching **Subject Page** (`subjectPageId?: SubjectPageId` on `Category` / Subject basin record, auto-created or linked on demand via `wb.getOrCreateSubjectBasinPage(categoryId)`).
   - Add explicit spatial basin geometry to each Subject/Category (`basin?: { readonly x: number; readonly y: number; readonly rx: number; readonly ry: number }` with deterministic default layout so existing categories even with `0` Nodes render a visible watercolour basin on the canvas, and can be dragged/resized to overlap with other Subject basins!).
3. **Bidirectional Spatial Coincidence = Subject Membership (`NodesCanvas.tsx` & `workbench.ts`):**
   - An **Observation Node** resting on the canvas belongs to whatever Subject basin(s) geometrically contain its `[x, y]` position (`pointInSubjectBasin(nodePos, basin)`):
     - Dragging an Observation Node **into** Subject A's watercolour basin automatically adds it to Subject A.
     - Dragging an Observation Node into the **overlapping Venn zone ($A \cap B$)** where Subject A and Subject B's basins cross automatically assigns it to **BOTH** Subject A and Subject B!
     - Dragging an Observation Node **out** of a Subject basin onto the bare paper desk automatically **removes** it from that Subject!
     - Conversely, assigning a Node to Subject(s) programmatically or via table/menu places its `[x, y]` inside the target Subject basin (or inside the geometric centroid of the $A \cap B$ overlap zone).
4. **True Subtractive Glazed Watercolour Overlaps (`src/app/WatercolorLayer.tsx`):**
   - Do **NOT** replace overlapping Subject colours with a single averaged/interpolated mud blob!
   - Render each Subject basin as a continuous, organic translucent watercolour wash (`globalCompositeOperation = "multiply"`, interior fill alpha `~0.26`) with a **distinct darker wet-edge pigment ring (`stroke` alpha `~0.55`)** along its entire perimeter.
   - When Subject A and Subject B overlap, the user must clearly see **both** continuous Subject perimeters crossing each other AND the optically glazed `multiply` intersection lens between them (`data-testid="watercolor-overlap-zone"` / inspectable in canvas state).

### 2.2 Unified 4-Tier Canvas Hit-Testing & Multi-Pane Comparison Workspace Routing (`NodesCanvas.tsx`, `Reader.tsx`, `workbench.ts`)
Implement strict distance-priority hit-testing on `NodesCanvas.tsx` (on clean click where pointer drag distance `<= 5px`) so clicking any spatial entity or overlap opens its exact comparison workspace:

| Priority | Canvas Target Clicked | What Opens in the Workspace (`App.tsx` / `Reader.tsx` / `SubjectEditor.tsx`) |
| :--- | :--- | :--- |
| **Priority 1** | **Observation Node** (`<= 24px` radius) | Opens the **Node's Page** side-by-side with the **Top 2 Most-Populated Cited PDFs** (ranked by citation/highlight count in that Node `DESC`, jumped directly to the first cited highlight with live SVG `EvidenceLines` active), PLUS a **Source Switcher Pill** (`data-testid="workspace-source-switcher"`) listing all cited sources (`Paper A (5) · Paper B (3) · Swap to: Paper C (1)`) to toggle in any 3rd+ PDF on demand! |
| **Priority 2** | **Node-to-Node Intersection / Hub** (`<= 24px` of hub or connector line) | Lazily creates/opens the **Node Intersection's own Page** (`wb.getOrCreateRelationshipPage(relationshipId)`, `data-testid="intersection-page-editor"`) where the user writes about how those specific Nodes connect, alongside the **Top 2 Most-Populated Cited PDFs** aggregated across the connected Nodes + the **Source Switcher Pill** (`workspace-source-switcher`) and quick-jump pills for the member Nodes! |
| **Priority 3** | **Overlapping Subject Watercolour Zone ($A \cap B \dots$)** (`> 24px` from any Node/Hub, inside $\ge 2$ Subject basins) | Regardless of how many Subjects overlap at that point ($2, 3, \dots, N$), opens **ONE unified Subject Intersection Page** (`wb.getOrCreateSubjectIntersectionPage(sortedSubjectIds)`, `data-testid="subject-intersection-page"`). At the top of this page, render an **Intersection Aspect Selector Bar** (`data-testid="subject-intersection-aspect-bar"`) with pills for the core overlap (`A ∩ B ∩ C`) and each pairwise sub-overlap (`A ∩ B`, `B ∩ C`, `A ∩ C`) plus a relationship-kind selector (`relates` / `bridges` / `contrasts` / `synthesizes`) and a live list of Observation Nodes currently sitting inside that overlap! |
| **Priority 4** | **Single Subject Watercolour Basin ($A \setminus B$)** (`> 24px` from any Node/Hub, inside exactly 1 Subject basin) | Clicking anywhere inside Subject A's empty watercolour wash opens **Subject A's overarching Subject Page** (`wb.getOrCreateSubjectBasinPage(subjectId)`, `data-testid="subject-basin-page"`), displaying the user's macro thoughts on Subject A and a live list of the Observation Nodes resting inside Subject A. |

---

## 3. Hard Verification Gates (`src/app/m13SpatialOntology.test.ts` + Single Live Browser Run)

1. **Unit & Render Tests (`src/app/m13SpatialOntology.test.ts`):**
   Write deterministic tests covering all 6 M13 invariants:
   - **Test 1 (Canvas Render Serialization):** Calling `rerender()` while `renderPage()`'s initial `draw()` is in flight never triggers concurrent `page.render()` on the same `<canvas>`.
   - **Test 2 (Quote-to-Rect Re-Anchoring):** Re-resolving a quote after paragraph vertical shift updates the annotation's normalized `rects`.
   - **Test 3 (Bidirectional Spatial Basin Membership):** Moving a Node's `[x, y]` into Basin A assigns `[A]`; moving it into the $A \cap B$ overlap zone assigns `[A, B]`; moving it outside all basins clears its basin membership `[]`.
   - **Test 4 (Single Subject Basin Click vs. Overlap Click):** Clicking inside Basin A alone (`> 24px` from nodes) opens Subject A's Page (`subject-basin-page`); clicking inside the $A \cap B \cap C$ overlap zone opens **one** unified `subject-intersection-page` with aspect selector pills (`A ∩ B ∩ C`, `A ∩ B`, `B ∩ C`, `A ∩ C`).
   - **Test 5 (Node & Hub Top-2 Source Ranking + Switcher):** Clicking a Node or Node-Intersection Hub that cites highlights from 3 PDFs (`Paper A`: 4 highlights, `Paper B`: 2 highlights, `Paper C`: 1 highlight) opens the Node/Hub Page alongside `Paper A` and `Paper B` (the top 2), and renders `workspace-source-switcher` allowing the user to swap in `Paper C`.
   - **Test 6 (Promote Note/Highlight to Node):** Calling `wb.promoteAnnotationToNode(annotationId)` creates an Observation Node citing that annotation.
2. **Single Live `chrome-headless-shell` Verification:**
   - Run `bash scripts/run-local-shot.sh` once at the end, verifying `0` `pageErrors`, confirming Page 2 of `Rotated Fixture` renders non-blank at Fit-width, and confirming the Nodes canvas renders glazed overlapping Subject basins.
3. **Final Gate & Publish:**
   - Run `npx vitest run --no-file-parallelism && npm run typecheck && npm run build && npx playwright test --list`.
   - Commit on `m13-spatial-ontology-basins`, push to `origin`, and open a PR targeting `$BASE_BRANCH`.
