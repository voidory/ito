# Consolidated Master Build Specification — Research Reader and Concept Network ("Ito")
## Version: 4.0 Complete End-to-End Master Reference (M0–M7) | 10 November 2026
## Status: M0–M7 COMPLETE (100%). M0–M3 + M2.5 delivered; Pass A delivered M6 (Zotero/website/area) + M7 (linked history) + the section 3 interaction polish (ADR-0012); Pass B delivered M4 (Koofr delivery + pointer-last publication + resilient refresh) + M5 (idempotent mobile captures + phone reader shell + capture queue) + the section 3 mandatory visual audit fixes (ADR-0013). Every milestone is covered by Vitest unit/jsdom tests plus Playwright e2e specs discovered via `npx playwright test --list`.

---

## 0. Authority, Taxonomy, and Implementation Rules
Single authoritative master specification consolidating:
1. **Master v2.0 (`doc.pdf`)**: Complete M0–M7 architecture, reading workbench, logical data contract, and acceptance suite (`A01–A24`, `R01–R20`, `N01–N08`, `H01–H07`, `D01–D22`).
2. **Master v3.0 (`master_build_specification_v3.md`)**: M2 procedural visual/topology amendments ("The Bump" lenses/stars, overlapping watercolor squircles, and the >=35-node 3D WebGL dimensional shift).
3. **M2.5 & M3 User Rulings (v3.1/v4.0)**: Authoritative resolutions on Category Master Pages, Multi-PDF N06 Placeholders, Full Connecting Pages, Disentangled Two-Lane PDF Pool, Targeted Backup Checklists, Offline-First Binary Eviction (`binary-offloaded`), Two-Mode Highlight Deletion, and Staging Override (`Try Import Anyway`).

### Binding Taxonomy
* **CONFIRMED**: Required behavior established by the user. Never silently narrow confirmed scope.
* **PROPOSED DEFAULT**: Actionable engineering suggestion; log in ADRs when adopted.
* **OPEN**: Unresolved policy or interaction; offer concrete options when it blocks a milestone.
* **LATER**: Retained overall scope, deliberately staged after the current milestone.
* **RUNTIME VALIDATION**: Syntax checking and `tsc --noEmit` alone are not runtime validation. All features require deterministic Vitest unit/jsdom tests and real-browser Playwright Chromium E2E specs.

---

## 1. Product Thesis, Knowledge Model, and Core Invariants

### 1.1 Product Thesis & Canonical Workflow
One reading-centered application combining a real PDF reader, source-local annotation, deliberately developed subject pages, and an organic conceptual network:
`Reading` -> `annotate and comment locally` -> `notice recurring or interesting connections` -> `deliberately develop a subject with selected evidence` -> `write, question, and revise` -> `rediscover the subject through its conceptual neighborhood and sources` -> `extend it through later reading.`

**Success Condition**: A user reads without organizational obligations, develops ideas without losing source context, and later recovers both the idea and its meaningful connections without hunting through isolated notes one at a time.

### 1.2 Knowledge Model: No Notebooks (CONFIRMED)
* **No Notebook Ownership**: A `Page` (subject/synthesis/explainer) requires no parent folder, notebook, project, or category to exist.
* **Non-Siloed Sources**: Source PDFs do not isolate ideas into document-specific silos. One annotation can be cited across multiple subjects; one subject can weave evidence from many sources (including contradictory or qualifying evidence).
* **Non-Owning Categories**: Categories are filtered perspectives and visual squircle regions. Membership in multiple categories never duplicates a `Page`.
* **Overlapping Page Roles**: A `Page` can simultaneously act as a developed subject, an explanatory connection page ("The Bump"), a category master page, or an independently authored note.
* **Zero Auto-Population Anti-Pattern**: Importing PDFs, selecting text, highlighting, or writing long source comments must **never** automatically create graph nodes, subject pages, or categories.

---

## 2. Core Technical Stack & Logical Data Contract (Section 20 + M2/M3 Extensions)

### 2.1 Verified Stack
* **Frontend**: Vite 5 + React 18 + TypeScript (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
* **PDF Engine**: `pdfjs-dist` (v4 API). Real `<canvas>` rendering + genuine selectable DOM `TextLayer` with `--scale-factor` CSS synchronization. No iframes or fake HTML stand-ins.
* **Rich Composition Editor**: ProseMirror (`prosemirror-state`, `prosemirror-view`, `prosemirror-model`, `prosemirror-keymap`, `prosemirror-commands`). Custom inline-atom `evidence` node. Structured ProseMirror JSON is the single source of truth, independent of DOM coordinates.
* **2D & 3D Network Rendering**: Procedural SVG (`src/network/`) with `feTurbulence`/`feDisplacementMap` watercolor filters + Three.js (`three`) WebGL space with `OrbitControls`.
* **Storage**: Pluggable `StorageAdapter` + `LocalFileStorageAdapter` (IndexedDB via `idb`) implementing write-then-verify, publish-pointer-last safe publication, and disentangled binary PDF storage.

### 2.2 Complete Logical Data Contract (`src/model/types.ts`)
All fields are `readonly`. All IDs are branded opaque strings (`BrainId`, `SourceId`, `AnnotationId`, `PageId`, `EvidenceInstanceId`, `RelationshipId`, `CategoryId`, `CaptureId`, `RevisionId`).

| Entity / Record | Key Fields & M2–M3 Extensions | Core Invariants |
|:---|:---|:---|
| **`BrainManifest`** | `brainId`, `schemaVersion`, `publicationRevision`, `createdAt`, `updatedAt`, `assetIndex`, `backupMode?: "full" \| "targeted"`, `omissions?: readonly string[]` | Tracks schema version, publication pointer, and explicit backup omissions (`A18`). |
| **`Source`** | `id`, `type: "pdf" \| "website"`, `title`, `authors?`, `year?`, `category?`, `versionHash` (`sha256`), `pageCount`, `url?`, `externalId?` | Lightweight metadata (~200B). Survives local PDF binary eviction (`binary-offloaded`) so graph and citations stay alive offline. |
| **`Annotation`** | `id`, `sourceId`, `sourceVersionHash`, `kind: "highlight" \| "underline" \| "range"`, `anchor: TextAnchor \| ScopeAnchor`, `comment`, `createdAt`, `updatedAt`, `externalId?` | Remains source-local. Creating annotations creates zero `Page`, `Category`, or `Relationship` records. |
| **`TextAnchor` / `ScopeAnchor`** | Text: `docId`, `sourceVersionHash`, `pageIndex`, `rects: NormalizedRect[]` (`0..1`), `selectedText`, `prefix`, `suffix`. Scope: `startPageIndex`, `endPageIndex`, `displayLabel` (`"pp. 12–14"`). | Portable and DOM-independent. Resolves explicitly to `resolved`, `binary-offloaded`, `mismatched`, or `unresolved`. |
| **`SubjectAssociation`** | `id`, `annotationId`, `pageId`, `createdAt` | Tentative (`dotted`) link between an annotation and a subject page without inserting a quote. |
| **`Page`** | `id`, `title`, `documentJson` (ProseMirror JSON), `roleHints?: readonly PageRole[]`, `createdAt`, `updatedAt` | Single identity across categories. Holds continuous prose interspersed with inline `evidence` atoms. |
| **`EvidenceInstance`** | `id`, `annotationId`, `sourceId`, `destinationPageId`, `quotedText`, `copiedComment?`, `mode: "live" \| "copy"`, `anchor`, `createdAt` | Provenance-bearing citation (`solid` line). Citation status per `(annotationId, pageId)` is **derived** (`citation.ts`), never a stored boolean. |
| **`Category`** | `id`, `name`, `memberPageIds: readonly PageId[]`, `colorCode?: string`, `presentationOrder?: number`, `masterPageId?: PageId`, `createdAt` | Non-owning classification. `masterPageId` links the category's editable synthesis master page (`A14`). |
| **`Relationship`** | `id`, `fromPageId`, `toPageId`, `endpointPageIds?: readonly PageId[]`, `kind`, `label`, `hubPosition?: {x,y}`, `blendColor?: string`, `explanatoryPageId?: PageId`, `createdAt` | Reconciles $N=2$ directed edges with $N \ge 3$ star hubs via `relationshipEndpoints(rel)`. `explanatoryPageId` links to a full ProseMirror page (`A13`). |
| **`PresentationState`** | **Shared**: `nodePositions`, `dragOffsets`, `categoryBounds`, `hiddenPageIds`, `hiddenRelationshipIds`, `annotationStyles`. **Device-Local**: `paneWidths`, `zoom`, `active3D`, `suppressMotion`. | Hiding nodes/lines is presentation-only and never deletes domain records. Annotation styles live here (never in `captures`). |
| **`Capture` & `CaptureHandling`** | `id`, `originDevice`, `content`, `sourceId?`, `anchor?`, `targetPageId?`, `status: "local" \| "pending" \| "uploaded" \| "incorporated" \| "dismissed"`, `createdAt` | Strictly for user thought captures (M5). Source-free captures never auto-create graph nodes (`A23`). |
| **`Revision` & `ReflectionEntry`** | `id`, `parentRevisionId?`, `affectedObjectIds`, `timestamp`, `timezone`, `beforeSnapshot`, `afterSnapshot`, `summary?` | Reconstructable state transitions (`M3`/`M7`). Pre-mutation snapshots recorded before destructive quote removal (`D02`). |

---

## 3. Detailed Milestone Specifications & Status (M0–M7)

### Milestone M0 — Scaffold, Data Contract, and Risk Spikes (COMPLETE)
* **Deliverables**: Vite + TS(strict) + React scaffold; `ADR-0001..0005`; `StorageAdapter` + IndexedDB `LocalFileStorageAdapter`; reproducible 3-page, multi-column, and rotated PDF fixtures (`scripts/gen-fixtures.mjs`).
* **Verified Risk Spikes**:
  1. *PDF Anchor Round-Trip (`src/pdf/`) PASS*: Real `pdf.js` selection + normalized `0..1` rect anchoring across reload, zoom (`2.5x`), and resize (`1.0x`) with `--scale-factor` CSS sync.
  2. *Editor Serialization (`src/editor/`) PASS*: ProseMirror `evidence` inline-atom node with byte-identical JSON hydrate/serialize round-trips.
  3. *Koofr Access Probe (`scripts/koofr-probe.mjs`) PASS (Honest Outcome C)*: Unauthenticated `OPTIONS` preflight returned no `Access-Control-Allow-*` headers, proving static-only browser WebDAV is blocked by CORS and documenting M4 fallbacks (proxy/packaged app/manual import).

### Milestone M1 — Local Real-PDF Vertical Slice (COMPLETE)
Implemented and verified in the binding validation order:
1. **Highlighting First (`§6`, `R01–R04`, `R09–R17`, `R20`)**:
   * Library is default entry (`A01`); double-click or `"Open together"` opens real PDFs with zero auto-analysis.
   * Selection exposes only compact highlight/underline/color controls (`R01`).
   * Multi-line highlights hug actual line fragments with soft, lightly uneven rounded corners—no literal ribbon curl (`R09`, `R20`).
   * Quiet comments save empty by default, stay hidden during reading, and return smoothly to the passage on close (`R02`, `R10`). Failed local saves retain the draft and show an actionable error (`R12`).
   * Multi-page scope annotations (`"Comment on page range"`, e.g. `pp. 1–3`) draw a non-washing page border on each included page with one shared comment (`R03`, `R16`, `R17`), coexisting cleanly with micro-highlights (`R04`).
2. **Continuous Subject Editing Second (`§4.2`, `§9`, `A03–A07`, `R05–R07`, `A11`, `A12`, `A17`)**:
   * Right-click AND accessible menu-button (`R15`) offer `"Associate with subject..."` (`dotted` tentative link, `R05`), `"Insert into subject page..."` (`solid` derived citation at cursor, `R06`), and `"Create new subject from this..."` (`A03`).
   * Removing one quote when another citation of the same annotation remains in that page never demotes the solid relationship; removing the last quote reverts to `tentative` if a `SubjectAssociation` exists, else `none` (`ADR-0007`).
   * Following a quote in `SubjectEditor` scrolls the live `SourcePane` to the exact resolved passage without closing/replacing the subject page (`A06`), or surfaces an explicit `mismatched` / `unresolved` banner (`A17`).
3. **Context-Preserving 3-Pane Workspace Third (`§7.3`, `§8.2`, `§10.2`, `R08`, `R18`, `R19`, `N03`, `N08`)**:
   * Simultaneous `Paper A | Subject Page | Paper B` layout with draggable pane resizers, independent scrolling, and third-paper pane swapping (`switchReaderPane`).
   * Closed highlights tab reserves zero width (`R18`); opening/closing it gently pushes the reader aside while preserving scroll passage, drafts, and camera state (`R19`).
   * Inter-pane SVG passage-to-evidence lines update on scroll/zoom/resize and toggle non-destructively (`A08`, `R08`).

### Milestone M2 & M2.5 — Conceptual Network, View Navigation, and Retrieval (M2 COMPLETE / M2.5 IN PROGRESS)
1. **Procedural Geometry of the Connecting Hub ("The Bump", `§3.1`, `A13-M2`)**:
   * Subject nodes render as compact circular dots with minimal labels.
   * $N = 2$ links render a centered, double-pointed translucent **lens/spindle** (`data-hub-kind="lens"`).
   * $N \ge 3$ clusters morph procedurally into a concave, arched **multi-pointed star** (`data-hub-kind="star"`) whose outer vertices point via `atan2` directly at the $N$ connected nodes.
   * **M2.5 Upgrade (`M2-FIX-1`)**: Clicking a hub allows inline label editing OR lazily developing the hub into a full ProseMirror `Page` (`explanatoryPageId` via `developRelationshipPage`), which can itself connect to further nodes (`§12.1`, `A13`).
2. **Overlapping Watercolor Squircles & Physics (`§3.2`, `A09-M2`, `A10-M2`, `A14-M2`)**:
   * Categories are bounded by dotted-dashed superellipses (`squirclePath`, $n \approx 4$) filled with an organic palette (Indigo, Sage Green, Ochre, Terracotta, Teal) using `mix-blend-mode: multiply`, `opacity: 0.15`, and `url(#watercolor-turbulent-edge)`.
   * Deterministic seeded (`mulberry32`) force-directed layout engine (`src/network/layout.ts`) applies node repulsion, link springs, damping (`A09-M2`), and per-category centroid attraction so multi-category nodes naturally settle in the darker, color-blended intersection zones (`A10-M2`).
   * **M2.5 Ruling 1 (`A14-M2`)**: Categories hold `masterPageId?: PageId` (`doc.pdf` §12.2, §20). Category-to-category boundary links (`data-testid="category-link"`) render when a category's master page references another category's master page/boundary.
3. **Files / Nodes View Switch, Multi-PDF N06 Placeholders & Reference Locating (`§7`, `N01–N07`)**:
   * Shell toggle (`Files | Nodes`) shares `categoryScope`. Global network renders when no category is scoped; scoped view renders that category's squircle plus overlapping categories (`N02`).
   * **M2.5 Ruling 2 (`N06-M2`)**: When $\ge 1$ unconnected PDFs are open (single or open-together) and the user switches to `Nodes`, the canvas renders a transient `"Not connected yet"` placeholder (`data-testid="node-placeholder"`, `data-transient="true"`) for **every** unconnected open source, with a `"Return to Reader"` button and **zero** durable records created.
   * **M2.5 Upgrade (`M2-FIX-3`, `N04`, `N05`, `N07`)**: Reader annotations cited in $\ge 1$ Subject Page expose `"Show in Nodes"` (`data-testid="show-in-nodes"`), centering the camera directly on the subject node if 1 destination exists (`N04`) or opening a destination picker (`data-testid="nodes-destination-picker"`) if $>1$ exist (`N05`).
4. **Search & Neighbourhood Retrieval (`M2-FIX-2`, `§13`, `A10`, `D07`)**:
   * Pure search module (`src/network/search.ts`) performing case-insensitive substring matching across `Page` titles/bodies, `Category` names, and `Annotation` quotes/comments, plus 1-hop graph neighbourhood retrieval (`workbench.neighborhood(pageId)`).
5. **M1 Schema Debt Cleanup (`M2-FIX-4`)**:
   * Annotation highlight styles moved out of `BrainData.captures` (`sourceId: null` sentinel) into `PresentationState.annotationStyles`, with automatic bootstrap migration so `captures` is pure before M3.
6. **Secret 3D Nodal Space Transition (`§3.4` Density Reward)**:
   * At $\ge 35$ active nodes (`THREE_D_UNLOCK_THRESHOLD = 35`), `data-testid="enter-3d"` reveals a transition into a Three.js WebGL scene (`ThreeScene.tsx`: additive stellar particles, translucent 3D bubble hulls sized from squircle bounds, `FogExp2` watercolor fog, `OrbitControls`) with graceful 2D fallback (`three-fallback`) when WebGL is unavailable.

### Milestone M3 — Complete Backup, Disentangled PDF Pool & Resilient Recovery (NEXT UP — RULINGS LOCKED)
1. **Two-Lane Disentangled Backup & Ingestion (`§17`, `§21`, `D09`)**:
   * **Lane 1 (`brain.ito.json` / `.ito.zip` core)**: Instant export/import of structured brain graph + `Source` metadata (`sha256`, `pageCount`) + shared presentation state. Zero library size cap.
   * **Lane 2 (`PdfIngestionQueue`)**: Supports bundled `.ito.zip` (`fflate`) for small/medium libraries AND queued batch ingestion of raw `.pdf` files of arbitrary total size (concurrency = 2, `%PDF-` magic-byte check, `100 MB` default per-file guard, automatic `sha256` matching to existing `Source` records, immediate RAM release).
2. **Interactive Targeted Backup Checklist (`§17`, `A18`)**:
   * Export modal with checkboxes (all ticked by default = **`Full Archival Backup`**, `omissions: []`):
     * `[x] Core Brain Graph` *(Required)*
     * `[x] Shared Presentation Layout` (`nodePositions`, `dragOffsets`, `categoryBounds`, `hiddenPageIds`, `hiddenRelationshipIds`, `annotationStyles`)
     * `[x] Pending Captures & Reflections`
     * `[x] Revision History`
     * `[x] Include PDF Source Binaries`
   * Unticking any optional box switches the badge to **`Targeted Backup (Partial — not a complete archival backup)`** and records exact omitted keys in `manifest.omissions`.
3. **Offline-First Citations & Local PDF Binary Eviction (`§4.3`, `§17`, `A17`)**:
   * Offloading or omitting a PDF binary (`StorageAdapter.deletePdf(sourceId)` via Library `"Offload PDF Binary (Keep Notes & Citations)"`) never deletes `Source` metadata, `Annotation` records, or `EvidenceInstance` citations.
   * Three distinct resolution states:
     * `resolved`: `Source` metadata + local PDF binary present -> opens Reader to passage.
     * `binary-offloaded`: `Source` metadata + `Annotation` quote/comment intact, PDF binary absent locally -> node map, categories, and search work identically; clicking citation shows stored quote/comment/page popover + `"Attach PDF Binary"` (`sha256`-verified).
     * `unresolved` / `mismatched`: `Source` or `Annotation` record deleted, or `versionHash` drifted.
4. **Two-Mode Highlight Deletion (`§4.3`, `§21`, `D02`)**:
   * Reader annotation right-click menu offers:
     1. `Delete Highlight Only` (`data-testid="delete-highlight-only"`): Deletes `Annotation`; any quoting `EvidenceInstance` survives in Subject Pages and transitions to `unresolved` (`"Annotation removed"` badge).
     2. `Delete Highlight & Quoted Evidence` (`data-testid="delete-highlight-and-quotes"`): Records a pre-mutation `Revision` snapshot of affected Subject Pages, deletes the `Annotation` and `EvidenceInstance`, and strips only the inline `evidence` atom from ProseMirror JSON while strictly preserving surrounding user prose.
5. **Staging Validator, Stepwise Migration & `"Try Import Anyway"` (`§17`, `§21`, `A19`)**:
   * Unparseable JSON / corrupted zip headers hard-abort in staging without touching active IndexedDB state.
   * Schema version mismatches, checksum mismatches, or missing optional arrays **pause and reject by default** with a diagnostic report, offering a **`"Try Import Anyway"`** override (`data-testid="try-import-anyway"`) that runs a lenient coercion pass.
   * Stepwise schema migration runner (`src/model/migrate.ts`) verified across version bumps (`A19`).

### Milestone M4 — Remote Publishing (Koofr/WebDAV) & Phone Reading (`§15`, `§16.1`, `A20`, `A21`)
* **Koofr / WebDAV Transport (`D08`)**: Implement `KoofrStorageAdapter` using the M0 spike findings (supporting an authenticated lightweight proxy/relay or packaged desktop/mobile bridge where direct browser CORS is blocked). Credentials never committed to code/repos.
* **Safe Snapshot Publication (`§15`)**:
  1. Write required assets and immutable brain snapshot under unique revision IDs.
  2. Verify upload integrity and asset availability.
  3. Publish the current-revision pointer last.
  4. Phone validates snapshot before activation; interrupted or invalid updates retain the prior working copy and display an explicit stale status (`A20`).
* **Phone Reading Flow (`§16.1`, `A21`)**: Responsive mobile navigation (`Library -> one-document reader -> related writing via selected passage -> back to same reading context`), plus explicit offline cache indicators (`resolved` vs. `binary-offloaded`).

### Milestone M5 — Mobile Captures & Desktop Processing Queue (`§16.2`, `§16.3`, `A22`, `A23`, `D12`)
* **Mobile Thought Capture (`§16.2`)**: Quick capture of a thought with optional source/passage anchor and optional target-subject suggestion. Clearly distinguishes `saved on this phone`, `pending upload`, and `uploaded to Koofr`.
* **Idempotent Sync (`A22`, `A23`)**: Each capture uses a unique durable `CaptureId` stored as a separate item (never overwriting the published PC brain). Retries and repeated downloads never duplicate captures; source-free captures never auto-create graph nodes (`A23`).
* **Desktop Processing Queue (`§16.3`)**: Unsorted capture queue on PC allowing the user to open the source, insert the thought/quote at a cursor position in a Subject Page, create a new subject when justified, leave pending, or dismiss. Original captures are preserved until safe handling is acknowledged.

### Milestone M6 — Zotero Interoperability, Website Sources & Extended Annotations (`§12.3`, `§19`, `A15`, `A24`, `D01`, `D10`, `D11`)
* **Zotero Import Contract (`§19`, `A24`)**: Explicit selected import of Zotero annotations/notes preserving source comments, external identities (`externalId`), and anchors with strict deduplication on repeated imports (`A24`). Custom multi-page range annotations and tentative associations are preserved in Ito's native format without false claims of Zotero write-back parity. Never mutate a live Zotero SQLite database directly.
* **Website-Linked Sources (`§12.3`, `A15`)**: Support `Source` records with `type: "website"`, stable URL identity, attached Subject Pages, and honest availability indicators (`A15`).
* **Extended Annotation Scope (`D01`)**: Explicit handling and scope declarations for scanned/OCR PDFs, image/area selections, rotated/multi-column layouts, and password-protected files (actionable status, never silent failure).

### Milestone M7 — Linked History, Economical Storage & Daily Reflection (`§18`, `H01–H07`, `D13`, `D14`)
* **Reconstructable Structured Revisions (`§18.1`, `H01`, `H02`)**: Coalesce edits into meaningful saved revisions recording before/after states for ProseMirror formatting, quote insertion/removal/reordering, annotation comments, range boundaries, tentative associations, and relationships. Never record animation frames or raw cursor movement as intellectual history.
* **Economical Delta/Checkpoint Storage (`§18.3`, `H05–H07`)**: Store object-level changes plus periodic validated checkpoints (`Checkpoint` records) so routine edits never duplicate unchanged PDFs or the entire brain (`H06`). Measure and report storage/replay overhead (`H07`).
* **Daily Review & Reflection (`§18.2`, `H03`, `H04`)**: Select a date/period -> inspect grouped changes -> open exact before/after comparisons -> optionally author a `ReflectionEntry` or `RevisionComment` linked to specific revisions. Skipping reflection never disables automatic history; reflection entries never auto-create graph nodes (`H04`).

---

## 4. Master Decision Log (`D01–D22` & `ADR-0001..0010`)

| Decision ID | Topic | Status & Authoritative Resolution |
|:---|:---|:---|
| **D01** | Additional annotation types & scanned PDFs | Baseline selectable text + page-range borders in M1 (`ADR-0006`); area/OCR expansion in M6. |
| **D02** | Quote/comment copy/live & deletion policy | **LOCKED (M3)**: Two-mode highlight delete (`Delete Highlight Only` -> `unresolved` badge vs. `Delete Highlight & Quoted Evidence` -> pre-mutation `Revision` snapshot + strip inline atom only). |
| **D03** | Explainer edge/node & category endpoints | **LOCKED (M2.5)**: `Relationship` holds `endpointPageIds` ($N \ge 2$) + `explanatoryPageId?: PageId` (`ADR-0008`, `ADR-0010`). Categories hold `masterPageId?: PageId`. |
| **D04** | Editor framework & schema | **RESOLVED (M0)**: ProseMirror with typed inline-atom `evidence` node and JSON source of truth (`ADR-0002`). |
| **D05** | Graph positions, layout & squircle bounds | **RESOLVED (M2)**: Seeded `mulberry32` force-directed layout + superellipse squircles + multiply watercolor blend (`ADR-0008`, `ADR-0009`). |
| **D06** | Line endpoints & inter-pane routing | **RESOLVED (M1)**: Inter-pane SVG margin routing + non-destructive visibility toggle. |
| **D07** | Search mechanisms & retrieval targets | **LOCKED (M2.5)**: Deterministic substring search across titles/bodies/categories/annotations + 1-hop graph neighbourhood API (`src/network/search.ts`). |
| **D08** | Delivery/hosting & Koofr CORS/auth | **SPIKED (M0) / M4**: Static browser WebDAV blocked by missing CORS headers (`ADR-0005`); M4 uses proxy/bridge + fallback import. |
| **D09** | Bundle schema, disentangled PDFs & backup | **LOCKED (M3)**: Two-lane architecture (`brain.ito.json` / `.ito.zip` via `fflate` + queued `PdfIngestionQueue`), Targeted Backup Checklist, and `"Try Import Anyway"` staging override. |
| **D10–D14** | Zotero, websites, phone cache, revisions | Scoped to M4 (`D12`), M6 (`D10`, `D11`), and M7 (`D13`, `D14`). |
| **D15–D16** | Range gesture, last-citation revert & motion | **RESOLVED (M1)**: Continuous page-range selector (`ADR-0006`), last-citation reverts to `tentative` iff association exists (`ADR-0007`), `prefers-reduced-motion` + in-app toggle honored. |
| **D17–D18** | Unconnected PDF placeholder & multi-category scope | **LOCKED (M2/M2.5)**: Transient `"Not connected yet"` placeholder for all open unconnected PDFs (`N06`) with `"Return to Reader"` and zero DB writes; shared `categoryScope`. |
| **D19** | Device-local vs. shared presentation state | **LOCKED (M2/M3)**: Shared = `nodePositions`, `dragOffsets`, `categoryBounds`, `hidden*`, `annotationStyles`; Device-Local = `paneWidths`, `zoom`, `active3D`, `suppressMotion` (`ADR-0009`). |
| **D20** | High-density graph treatments | **RESOLVED (M2)**: $\ge 35$-node density monitor unlocks the Three.js 3D WebGL space (`ADR-0008`, `ADR-0009`). |
| **D21–D22** | Narrow-screen flow & third-paper pane swap | **RESOLVED (M1)**: `<760px` responsive flow stub (full phone reading in M4); `switchReaderPane` deduplicates open panes. |

---

## 5. Master Acceptance Checklist (`A01–A24`, `R01–R20`, `N01–N08`, `H01–H07`)

* **M0–M1 Reading & Workspace (`A01–A08`, `A11`, `A12`, `A16`, `R01–R20`, `N01`, `N03`, `N08`)**: Verified by 63 Vitest unit tests + 29 Playwright Chromium tests.
* **M2–M2.5 Network, Navigation & Retrieval (`A09-M2`, `A10-M2`, `A13-M2`, `A14-M2`, `N02`, `N04`, `N05`, `N06-M2`, `N07`)**: Verified by 163+ Vitest unit/jsdom tests + Playwright specs (`concept-network.spec.ts`, `view-switch.spec.ts`, `three-d.spec.ts`).
* **M3 Backup, Offline Citations & Recovery (`A17-M3`, `A18-M3`, `A19-M3`, `D02-M3`)**: Ready for implementation immediately upon M2.5 completion.
* **M4–M7 Remote, Captures, Zotero & History (`A15`, `A20–A24`, `H01–H07`)**: Staged in backlog with extension hooks preserved in `src/model/types.ts`.
