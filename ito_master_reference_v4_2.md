# Consolidated Master Build Specification — Research Reader and Concept Network ("Ito")
## Version: 4.2 Complete End-to-End Master Reference (M0–M7 + Pass A Rulings Locked) | 10 November 2026
## Status: M0–M2.5 Verified (241 Tests), M3 In Progress, Pass A (M7 + M6) Rulings Locked, Pass B (M4 + M5) Staged

---

## 0. Authority, Taxonomy, and Reorganized Execution Roadmap
Single authoritative master specification consolidating:
1. **Master v2.0 (`doc.pdf`)**: Complete M0–M7 architecture, reading workbench, logical data contract, and acceptance suite (`A01–A24`, `R01–R20`, `N01–N08`, `H01–H07`, `D01–D22`).
2. **Master v3.0 (`master_build_specification_v3.md`)**: M2 procedural visual/topology amendments ("The Bump" lenses/stars, overlapping watercolor squircles, and the >=35-node 3D WebGL dimensional shift).
3. **M2.5 Completion (`ADR-0010`) & M3 User Rulings**: Category Master Pages, Multi-PDF N06 Placeholders, Full Connecting Pages, Disentangled Two-Lane PDF Pool, Targeted Backup Checklists, Offline-First Binary Eviction (`binary-offloaded`), Two-Mode Highlight Deletion, and Staging Override (`Try Import Anyway`).
4. **Pass A (`M7 + M6`) User Rulings (v4.2)**: 2-second idle coalescing & 20-revision checkpoint cadence (`D13`); Day-Grouped Timeline + Multi-Day/Month Range Filter + Cherry-Picked Revision Selection across days (`D14`, `H03`); Idempotent Zotero JSON/BetterBibTeX/RDF Importer (`D10`, `A24`); Mandatory URL + Dropped HTML/Snapshot File workflow rejecting URL-only submissions (`D11`, `A15`).

### Binding Execution Order (Dependency-Optimized)
To complete 100% of the local desktop data model, delta/checkpoint storage, and source types *before* building cloud WebDAV sync and mobile views, the post-M3 milestones are reorganized into two consolidated passes:
1. **Completed Baseline (`M0 -> M1 -> M2 -> M2.5`)**: Core PDF reader, ProseMirror subject editor, 3-pane workspace, 2D/3D procedural concept network, category master pages, connecting pages, search, and reference-directed locating (241 Vitest tests + 50 Playwright E2E specs).
2. **Current Pass (`M3` — Complete Backup, Offline Citations & Recovery)**: Two-lane `.ito.zip` / `PdfIngestionQueue`, Targeted Backup Checklist, `binary-offloaded` citations, two-mode highlight deletion with initial `Revision` snapshots, and staging validation (`Try Import Anyway`).
3. **Next Pass — Pass A (`M7 + M6` — Local Desktop Completion: Linked History, Multi-Span Reflection, Zotero & Snapshot Website Sources)**:
   * **Why First**: M3 introduces `BrainData.revisions` pre-mutation snapshots (`D02`). Building **M7** (`Revision`, `Checkpoint`, `ReflectionEntry` with multi-day/month cherry-picked spans, and economical delta storage `H01–H07`) and **M6** (Zotero deduplicated import `A24`, URL + Required HTML/Snapshot Website sources `A15`, extended PDF scope `D01`) immediately after M3 finalizes 100% of the local domain schema and delta-checkpoint engine before any remote network sync is written.
4. **Final Pass — Pass B (`M4 + M5` — Cloud & Mobile Completion: Koofr WebDAV Sync, Phone Reader & Mobile Captures)**:
   * **Why Last & Combined**: **M4** (downlink: safe snapshot/checkpoint publication to Koofr + responsive Phone Reader `A20–A21`) and **M5** (uplink: mobile thought captures + PC Desktop Processing Queue `A22–A23`) are two halves of the same cloud/mobile subsystem (`KoofrStorageAdapter` + `<760px` mobile shell + `BrainData.captures`). Building them after M7 + M6 ensures `KoofrStorageAdapter` syncs economical M7 checkpoints (`H06`: *"phone refresh does not require all history"*) and the Phone Reader natively renders M6 website snapshot sources.

### Binding Taxonomy
* **CONFIRMED**: Required behavior established by the user. Never silently narrow confirmed scope.
* **PROPOSED DEFAULT**: Actionable engineering suggestion; log in ADRs when adopted.
* **OPEN**: Unresolved policy or interaction; offer concrete options when it blocks a milestone.
* **LATER**: Retained overall scope, staged per the Binding Execution Order above.
* **RUNTIME VALIDATION**: Syntax checking and `tsc --noEmit` alone are not runtime validation. All features require deterministic Vitest unit/jsdom tests and real-browser Playwright Chromium E2E specs (`npx playwright test --list` when sandbox proxy blocks browser binary downloads).

---

## 1. Product Thesis, Knowledge Model, and Core Invariants

### 1.1 Product Thesis & Canonical Workflow
One reading-centered application combining a real PDF/snapshot reader, source-local annotation, deliberately developed subject pages, and an organic conceptual network:
`Reading` -> `annotate and comment locally` -> `notice recurring or interesting connections` -> `deliberately develop a subject with selected evidence` -> `write, question, and revise` -> `rediscover the subject through its conceptual neighborhood and sources` -> `extend it through later reading.`

**Success Condition**: A user reads without organizational obligations, develops ideas without losing source context, and later recovers both the idea and its meaningful connections without hunting through isolated notes one at a time.

### 1.2 Knowledge Model: No Notebooks (CONFIRMED)
* **No Notebook Ownership**: A `Page` (subject/synthesis/explainer) requires no parent folder, notebook, project, or category to exist.
* **Non-Siloed Sources**: Source documents (PDFs and Website Snapshots) do not isolate ideas into document-specific silos. One annotation can be cited across multiple subjects; one subject can weave evidence from many sources (including contradictory or qualifying evidence).
* **Non-Owning Categories**: Categories are filtered perspectives and visual squircle regions. Membership in multiple categories never duplicates a `Page`.
* **Overlapping Page Roles**: A `Page` can simultaneously act as a developed subject, an explanatory connection page ("The Bump"), a category master page, or an independently authored note.
* **Zero Auto-Population Anti-Pattern**: Importing PDFs/Websites/Zotero bundles, selecting text, highlighting, writing long source comments, or writing historical journal reflections must **never** automatically create graph nodes, subject pages, or categories.

---

## 2. Core Technical Stack & Logical Data Contract (Section 20 + M2–M7 Extensions)

### 2.1 Verified Stack
* **Frontend**: Vite 5 + React 18 + TypeScript (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
* **PDF & Snapshot Engine**: `pdfjs-dist` (v4 API) for real `<canvas>` + selectable DOM `TextLayer` (`--scale-factor` CSS sync) + sanitized local HTML/Markdown/Text snapshot renderer for Website sources (`D11`).
* **Rich Composition Editor**: ProseMirror (`prosemirror-state`, `prosemirror-view`, `prosemirror-model`, `prosemirror-keymap`, `prosemirror-commands`). Custom inline-atom `evidence` node. Structured ProseMirror JSON is the single source of truth, independent of DOM coordinates.
* **2D & 3D Network Rendering**: Procedural SVG (`src/network/`) with `feTurbulence`/`feDisplacementMap` watercolor filters + Three.js (`three`) WebGL space with `OrbitControls`.
* **Storage & Bundling**: Pluggable `StorageAdapter` + `LocalFileStorageAdapter` (IndexedDB via `idb`) + `.ito.zip` archive codec (`fflate`) + `KoofrStorageAdapter` (M4/M5). Implements write-then-verify, publish-pointer-last safe publication, and disentangled binary asset storage.

### 2.2 Complete Logical Data Contract (`src/model/types.ts`)
All fields are `readonly`. All IDs are branded opaque strings (`BrainId`, `SourceId`, `AnnotationId`, `PageId`, `EvidenceInstanceId`, `RelationshipId`, `CategoryId`, `CaptureId`, `RevisionId`, `CheckpointId`, `ReflectionId`).

| Entity / Record | Key Fields & M2–M7 Extensions | Core Invariants |
|:---|:---|:---|
| **`BrainManifest`** | `brainId`, `schemaVersion`, `publicationRevision`, `createdAt`, `updatedAt`, `assetIndex`, `backupMode?: "full" \| "targeted"`, `omissions?: readonly string[]`, `latestCheckpointId?: CheckpointId` | Tracks schema version, publication pointer, explicit backup omissions (`A18`), and latest checkpoint (`H05`). |
| **`Source`** | `id`, `type: "pdf" \| "website"`, `title`, `authors?`, `year?`, `category?`, `versionHash` (`sha256`), `pageCount`, `url?`, `snapshotFormat?: "html" \| "md" \| "txt"`, `availabilityStatus?: "snapshot-cached" \| "binary-offloaded" \| "unavailable"`, `externalId?` | Lightweight metadata (~200B). Website sources require a dropped HTML/text snapshot on creation (`D11`). Survives local binary/snapshot eviction (`binary-offloaded`). |
| **`Annotation`** | `id`, `sourceId`, `sourceVersionHash`, `kind: "highlight" \| "underline" \| "range" \| "area"`, `anchor: TextAnchor \| ScopeAnchor`, `comment`, `createdAt`, `updatedAt`, `externalId?` | Remains source-local. Supports text, multi-page range, and figure/area (`D01`) selections. Creating annotations creates zero graph records. |
| **`TextAnchor` / `ScopeAnchor`** | Text/Area: `docId`, `sourceVersionHash`, `pageIndex`, `rects: NormalizedRect[]` (`0..1`), `selectedText`, `prefix`, `suffix`. Scope: `startPageIndex`, `endPageIndex`, `displayLabel` (`"pp. 12–14"`). | Portable and DOM-independent. Resolves explicitly to `resolved`, `binary-offloaded`, `mismatched`, or `unresolved`. |
| **`SubjectAssociation`** | `id`, `annotationId`, `pageId`, `createdAt` | Tentative (`dotted`) link between an annotation and a subject page without inserting a quote. |
| **`Page`** | `id`, `title`, `documentJson` (ProseMirror JSON), `roleHints?: readonly PageRole[]`, `createdAt`, `updatedAt` | Single identity across categories. Holds continuous prose interspersed with inline `evidence` atoms. |
| **`EvidenceInstance`** | `id`, `annotationId`, `sourceId`, `destinationPageId`, `quotedText`, `copiedComment?`, `mode: "live" \| "copy"`, `anchor`, `createdAt` | Provenance-bearing citation (`solid` line). Citation status per `(annotationId, pageId)` is **derived** (`citation.ts`), never a stored boolean. |
| **`Category`** | `id`, `name`, `memberPageIds: readonly PageId[]`, `colorCode?: string`, `presentationOrder?: number`, `masterPageId?: PageId`, `createdAt` | Non-owning classification. `masterPageId` links the category's editable synthesis master page (`A14`). |
| **`Relationship`** | `id`, `fromPageId`, `toPageId`, `endpointPageIds?: readonly PageId[]`, `kind`, `label`, `hubPosition?: {x,y}`, `blendColor?: string`, `explanatoryPageId?: PageId`, `createdAt` | Reconciles $N=2$ directed edges with $N \ge 3$ star hubs via `relationshipEndpoints(rel)`. `explanatoryPageId` links to a full ProseMirror page (`A13`). |
| **`PresentationState`** | **Shared**: `nodePositions`, `dragOffsets`, `categoryBounds`, `hiddenPageIds`, `hiddenRelationshipIds`, `annotationStyles`. **Device-Local**: `paneWidths`, `zoom`, `active3D`, `suppressMotion`. | Hiding nodes/lines is presentation-only and never deletes domain records. Annotation styles live here (never in `captures`). |
| **`Revision` & `Checkpoint`** | Revision: `id`, `parentRevisionId?`, `checkpointId?`, `affectedObjectIds`, `timestamp`, `timezone`, `dateKey` (`YYYY-MM-DD`), `deltas` (`before`/`after` states), `summary?`. Checkpoint: `id`, `schemaVersion`, `coveredRevisionId`, `stateSnapshot`, `integrityHash`. | Coalesced intellectual history (`2000 ms` idle window; `Checkpoint` every `20` revisions, `D13`). `Checkpoint.stateSnapshot` strictly excludes `revisions` and `checkpoints` (`H06`). |
| **`ReflectionEntry` & `RevisionComment`** | Reflection: `id`, `dateKey`, `startDateKey`, `endDateKey`, `documentJson`, `linkedRevisionIds`, `linkedPageIds?`, `createdAt`. Comment: `id`, `revisionId`, `targetObjectId?`, `content`, `createdAt`. | Supports single-day AND multi-day/month cherry-picked revision analysis (`startDateKey..endDateKey`, `D14`, `H03`). Never auto-creates graph nodes (`H04`). |
| **`Capture` & `CaptureHandling`** | Capture: `id`, `originDevice`, `content`, `sourceId?`, `anchor?`, `targetPageId?`, `status: "local" \| "pending" \| "uploaded" \| "incorporated" \| "dismissed"`, `createdAt`. Handling: `captureId`, `disposition`, `destinationPageId?`, `incorporatedRevisionId?`. | Strictly for user thought captures (`M5`, `A22–A23`). Idempotent sync by stable `CaptureId`; source-free captures never auto-create graph nodes. |

---

## 3. Detailed Milestone Specifications (In Reorganized Execution Order)

### 3.1 Completed Baseline: M0, M1, M2, and M2.5 (COMPLETE — 241 Vitest / 50 E2E Specs)
* **M0 (Scaffold & Spikes)**: Vite + TS(strict) + React scaffold; `ADR-0001..0005`; IndexedDB `LocalFileStorageAdapter`; 3-page/multi-column/rotated PDF fixtures; verified PDF anchor round-trip spike, ProseMirror serialization spike, and Koofr CORS probe.
* **M1 (Local Real-PDF Vertical Slice)**:
  1. *Highlighting First (`R01–R04`, `R09–R17`, `R20`)*: Categorized library (`A01`), compact selection toolbar (`R01`), per-line rounded highlights (`R09`), quiet comments with save-failure draft retention (`R02`, `R10`, `R12`), and continuous multi-page border annotations (`R03`, `R16`, `R17`).
  2. *Continuous Subject Editing Second (`A03–A07`, `R05–R07`, `A11`, `A12`, `A17`)*: Right-click + accessible menu (`R15`), derived `dotted`/`solid` citation state machine (`ADR-0007`), ProseMirror `SubjectEditor` with inline `evidence` atoms, block reordering (`A04`), and non-replacing source-return (`A06`, `A17`).
  3. *Context-Preserving 3-Pane Workspace Third (`R08`, `R18`, `R19`, `N03`, `N08`)*: Simultaneous `Paper A | Subject Page | Paper B` panes, draggable dividers, third-paper swap (`switchReaderPane`), zero-width closed highlights tab (`R18`), and non-destructive inter-pane SVG passage-to-evidence lines (`A08`, `R08`).
* **M2 & M2.5 (Conceptual Network, View Navigation & Retrieval — `ADR-0008..0010`)**:
  1. *Procedural Hubs ("The Bump", `A13-M2`)*: $N=2$ translucent lens/spindle; $N \ge 3$ concave arched star with vertices pointing at connected nodes; `developRelationshipPage` promotes any hub into a full ProseMirror Connecting Page (`explanatoryPageId`) that can participate in further relationships (`M2-FIX-1`).
  2. *Overlapping Watercolor Squircles & Category Masters (`A09-M2`, `A10-M2`, `A14-M2`)*: Dotted-dashed superellipses with `mix-blend-mode: multiply` and `#watercolor-turbulent-edge`; seeded `mulberry32` force-directed layout settling multi-category nodes in overlapping intersections; `Category.masterPageId` + `connectCategoryMasters` rendering `data-link-kind="master" | "member"` boundary links (`Ruling 1`).
  3. *View Switching, Multi-PDF N06 & Reference Locating (`N01–N07`)*: Shared `categoryScope`; transient `"Not connected yet"` placeholders for all open unconnected PDFs with `"Return to Reader"` and zero DB writes (`Ruling 2`); `"Show in Nodes"` from cited annotations with direct focus (`N04`) or destination picker (`N05`) (`M2-FIX-3`).
  4. *Search, Neighbourhood & Style Migration (`D07`, `M2-FIX-2`, `M2-FIX-4`)*: Pure `src/network/search.ts` + shell `NetworkSearch` across titles, ProseMirror bodies, categories, and annotations, plus 1-hop `neighborhood(pageId)`; legacy `Capture` style sentinels migrated into `PresentationState.annotationStyles`.
  5. *Secret 3D Nodal Space (`§3.4`)*: Unlocks at $\ge 35$ active nodes into Three.js WebGL space (`ThreeScene.tsx` + `threeScene.map.ts` with 3D master/member link parity) and graceful 2D fallback.

---

### 3.2 Current Pass: Milestone M3 — Complete Backup, Disentangled PDF Pool & Resilient Recovery (IN PROGRESS)
1. **Two-Lane Disentangled Backup & Ingestion (`§17`, `§21`, `D09`)**:
   * **Lane 1 (`brain.ito.json` / `.ito.zip` core)**: Instant export/import of structured brain graph + `Source` metadata (`versionHash`, `pageCount`) + shared presentation state. Zero library size cap.
   * **Lane 2 (`PdfIngestionQueue`)**: Bundled `.ito.zip` (`fflate`) for small/medium libraries AND queued batch ingestion of raw `.pdf` files of arbitrary total size (concurrency = 2, `%PDF-` magic-byte check, `100 MB` default per-file guard, automatic SHA-256 matching to existing `Source` records, immediate RAM release).
2. **Interactive Targeted Backup Checklist (`§17`, `A18`)**:
   * Export modal (`data-testid="backup-export-modal"`) with checkboxes (all ticked by default = **`Full Archival Backup`**, `omissions: []`): Core Brain Graph *(locked on)*, Shared Presentation Layout, Pending Captures & Reflections, Revision History, and Include PDF Source Binaries.
   * Unticking any box switches `data-testid="backup-mode-badge"` to **`"Targeted Backup (Partial — not a complete archival backup)"`**, writes omitted keys to `manifest.omissions`, and surfaces them on restore.
3. **Offline-First Citations & Local PDF Binary Eviction (`§4.3`, `§17`, `A17`)**:
   * `StorageAdapter.deletePdfBinary(sourceId)` / `Workbench.offloadSourceBinary(sourceId)` via Library `"Offload PDF Binary"` (`data-testid="offload-pdf-binary"`) deletes only the raw IndexedDB PDF blob while keeping `Source` metadata, `Annotation`s, and `EvidenceInstance`s 100% intact.
   * Three resolution states: `resolved` (opens Reader to passage), `binary-offloaded` (graph/search work identically; clicking citation shows stored quote/comment/page popover + `"Attach PDF Binary"` verified by `versionHash`), and `unresolved` / `mismatched`.
4. **Two-Mode Highlight Deletion (`§4.3`, `§21`, `D02`)**:
   * `Delete Highlight Only` (`data-testid="delete-highlight-only"`): Deletes `Annotation`; quoting `EvidenceInstance`s survive in Subject Pages and transition to `unresolved` (`"Annotation removed"`).
   * `Delete Highlight & Quoted Evidence` (`data-testid="delete-highlight-and-quotes"`): Records a pre-mutation `Revision` snapshot of affected Subject Pages, deletes the `Annotation` and `EvidenceInstance`, and strips only the matching inline ProseMirror `evidence` atom while strictly preserving surrounding user prose.
5. **Staging Validator, Stepwise Migration & `"Try Import Anyway"` (`§17`, `§21`, `A19`)**:
   * Corrupted zip headers / unparseable JSON hard-abort in staging without touching active IndexedDB state.
   * Version/hash mismatches or missing optional arrays **pause and reject by default** (`data-testid="import-staging-report"`), offering a **`"Try Import Anyway"`** override (`data-testid="try-import-anyway"`) that runs a lenient coercion pass.
   * Stepwise schema migration runner (`src/model/migrate.ts`) verified across version bumps (`A19`), plus unified category-scope resolution across `Category.id` and `Category.name`.

---

### 3.3 Next Pass (Pass A): Milestones M7 + M6 — Local Desktop Completion (Linked History, Multi-Span Reflection, Zotero & Snapshot Website Sources)

#### Part 1: Milestone M7 — Linked History, Economical Delta/Checkpoint Storage & Multi-Span Reflection (`§18`, `H01–H07`, `D13`, `D14`)
1. **Coalesced Structured Revisions (`§18.1`, `H01`, `H02`, `D13`)**:
   * Extend the `Revision` pipeline initialized in M3 so meaningful saves record reconstructable before/after object deltas (`RevisionDelta`) for: Subject Page ProseMirror text/formatting, inline `evidence` quote insertion/removal/reordering (`H01`), annotation comments, page-range boundaries, tentative associations, category membership/masters, and relationship changes (`H02`).
   * **Coalescing Rule (`D13`)**: Coalesce rapid prose typing on the same `Page` over a **`2000 ms` (2-second) idle window** (with `Workbench.flushPendingRevision()` for deterministic testing). Structural actions flush immediately. Never record animation frames, cursor movement, or graph-drag frames.
2. **Economical Delta + Checkpoint Storage (`§18.3`, `§18.4`, `H05–H07`, `D13`)**:
   * Write a validated `Checkpoint` snapshot (`BrainData.checkpoints`) automatically every **`20 revisions`** (`CHECKPOINT_INTERVAL = 20`).
   * **Anti-Bloat Guard (`H06`)**: `Checkpoint.stateSnapshot` stores domain collections only and **strictly excludes** `revisions` and `checkpoints` (no recursive history nesting) and PDF binary blobs.
   * **Reconstruction & Forward Restore (`H05`, `§18.4`)**: `Workbench.reconstructRevisionState(revId)` replays deltas from the nearest prior `Checkpoint` (returning explicit `{ status: "missing-segment", missingIds, fallbackState }` if a segment is missing without corrupting current state). `Workbench.restoreRevision(revId)` creates a **new forward `Revision`** rather than erasing later history.
   * **Overhead Probe (`H07`)**: `Workbench.measureHistoryOverhead()` returns `{ revisionCount, checkpointCount, deltaBytes, checkpointBytes, replayDurationMs }`.
3. **Day-Grouped Timeline, Multi-Day/Month Range Filter & Cherry-Picked Reflection (`§18.2`, `H03`, `H04`, `D14`)**:
   * Provide a **History & Reflection Surface** (`src/app/HistoryReflectionPanel.tsx`, reachable via `data-testid="view-history"`):
     * **Day Grouping + Range Filter (`D14`)**: Group revisions by creation-local `dateKey` (`YYYY-MM-DD` from `Revision.timestamp` + `Revision.timezone`). Provide both a single-day picker (`data-testid="review-date-picker"`) and a **Date-Range filter (`data-testid="review-range-start"`, `data-testid="review-range-end"`)** to inspect week-wide or month-wide idea development.
     * **Cherry-Picked Activity Selection Across Days (`H03`, `D14`)**: Every revision item (`data-testid="revision-item"`) includes a selection checkbox (`data-testid="revision-select-checkbox"`). Users can select specific revisions across multiple days/weeks/months to analyze together in a `ReflectionEntry` (`data-testid="reflection-editor"`). The resulting `ReflectionEntry` records `linkedRevisionIds`, `startDateKey`, and `endDateKey`, rendering an explicit span badge when `startDateKey !== endDateKey` (`data-testid="reflection-date-span"`, e.g., `"2026-11-01 -> 2026-11-09"`).
     * Support per-change `RevisionComment` (`data-testid="revision-comment-input"`) and before/after diff inspection (`data-testid="revision-diff-view"`).
   * **Invariants (`H04`)**: Skipping reflection never disables automatic revision capture; reflections/comments never rewrite `Revision` records and **never** create `Page` or graph nodes.

#### Part 2: Milestone M6 — Zotero Interoperability, Snapshot Website Sources & Extended PDF Scope (`§12.3`, `§19`, `A15`, `A24`, `D01`, `D10`, `D11`)
1. **Idempotent Zotero Annotation & Item Importer (`§19`, `A24`, `D10`)**:
   * Pure parser (`src/storage/zotero.ts` + `Workbench.importZoteroBundle(rawJson)`) accepting **Zotero JSON / BetterBibTeX JSON** and **Zotero RDF/JSON annotation bundles**.
   * Preserves parent item metadata (`Source.externalId`) and highlight/underline/note annotations (`Annotation.externalId`, comments, page indices, normalized `0..1` rects) while keeping imported annotations strictly source-local (zero auto-created graph nodes).
   * **Idempotent Deduplication (`A24`)**: Repeated imports match on `externalId`, updating modified comments/titles in place with zero duplicate `Source` or `Annotation` records, while preserving native Ito range annotations and tentative associations.
2. **Website Sources Require URL + Dropped HTML/Snapshot File (`§12.3`, `A15`, `D11`)**:
   * Provide an **"Add Website Source"** modal (`data-testid="add-website-modal"`) in `Library.tsx` with a URL input (`data-testid="website-url-input"`) and a **drag-and-drop / file-picker HTML/Snapshot zone** (`data-testid="website-snapshot-dropzone"`, accepting `.html`, `.htm`, `.md`, `.txt`) directly underneath.
   * **URL-Only Rejection (`D11`)**: Submitting a URL without attaching/dropping a snapshot file is **rejected** with an explicit validation message (`data-testid="website-snapshot-required-error"`) explaining that a local HTML/text snapshot is required for offline highlighting and citation (establishing the contract for future browser-extension clippers).
   * **Website Reading & Availability Badges (`A15`)**: Stores the sanitized snapshot via `StorageAdapter`, sets `Source.type = "website"` and `availabilityStatus: "snapshot-cached"` (or `"binary-offloaded"` / `"unavailable"` if evicted), and renders the snapshot in `Reader.tsx` with full text selection, highlighting, quoting into Subject Pages, and `data-testid="website-availability-badge"`.
3. **Extended PDF Scope & Area Annotations (`§5`, `D01`)**:
   * Detect and display explicit status banners (`data-testid="pdf-scope-status"`) for scanned/zero-text-layer PDFs (`"Scanned PDF (no selectable text layer) — use page-range or area annotations"`) and encrypted PDFs (`"Encrypted PDF — password required"`).
   * Support rectangular **Area / Figure Region Annotations (`Annotation.kind = "area"`)** with normalized `0..1` region rects so figures, chemical structures, and scanned pages can be annotated and cited in Subject Pages.

---

### 3.4 Final Pass (Pass B): Milestones M4 + M5 — Cloud & Mobile Completion (Koofr WebDAV Sync, Phone Reader & Mobile Captures)

#### Part 1: Milestone M4 — Koofr/WebDAV Safe Publication & Responsive Phone Reading (`§15`, `§16.1`, `A20`, `A21`, `D08`, `D12`)
1. **Pluggable Koofr / WebDAV Transport (`src/storage/KoofrStorageAdapter.ts`, `D08`)**:
   * Building on the M0 CORS spike (`ADR-0005`), implement `KoofrStorageAdapter` supporting an authenticated WebDAV relay/proxy endpoint (or injectable fetch transport for testing/packaged builds) with credentials read strictly from runtime config/session (never committed to code).
   * **Safe Atomic Publication Protocol (`§15`, `A20`)**:
     1. Upload required new/changed assets and immutable brain/checkpoint snapshot under a unique `publicationRevision` ID (reusing M7 checkpoints so routine syncs never re-upload unchanged PDFs or full history archives, `H06`).
     2. Verify remote upload integrity and asset availability.
     3. Advance the remote `current-revision.json` pointer **only after** verification succeeds.
     4. On client/phone refresh, validate the remote snapshot in staging before activation; if a network drop or invalid snapshot occurs, **preserve the prior working copy** and display an explicit stale/offline status banner (`data-testid="sync-publication-status"`, `A20`).
2. **Responsive Phone Reading & Selective Offline Cache (`§16.1`, `A21`, `D12`)**:
   * Upgrade the `<760px` responsive stub into a full **Mobile / Phone Reading Flow** (`data-testid="mobile-reader-shell"`): `Library -> single-document Reader -> inspect related Subject Page writing via a selected passage sheet -> return to the exact same reading passage/zoom context` (`A21`), plus search/open a Subject Page and follow a quote into its PDF/Website snapshot.
   * Provide per-source mobile offline caching controls (`"Cache for Offline"` / `"Offload Local Binary"`) and honest download availability badges (`data-testid="source-binary-status"`).

#### Part 2: Milestone M5 — Mobile Thought Captures & Desktop Processing Queue (`§16.2`, `§16.3`, `A22`, `A23`, `D12`)
1. **Mobile Thought Capture Surface (`§16.2`, `A22`, `A23`)**:
   * Fast capture composer (`data-testid="mobile-capture-composer"`): write a thought with optional source/passage anchor and optional target-subject suggestion.
   * Source-free thought capture remains `pending` and **never** automatically creates a `Page` or graph node (`A23`).
   * Save locally before upload, distinguishing `status: "local"` (`"Saved on this device"`), `"pending"` (`"Pending upload"`), and `"uploaded"` (`"Uploaded to Koofr"`), keyed by stable `CaptureId` (`A22`).
2. **Idempotent Desktop Processing Queue (`§16.3`, `A22`)**:
   * Unsorted Capture Queue (`data-testid="capture-processing-queue"`) on PC deduplicating by `CaptureId` (`BrainData.captureHandlings`) so repeated downloads/retries incorporate each capture at most once (`A22`), supporting open-source, insert-at-cursor, create-subject, or leave-pending/dismiss dispositions.

---

## 4. Master Decision Log (`D01–D22` & `ADR-0001..0013`)

| Decision ID | Topic | Target Pass | Status & Authoritative Resolution |
|:---|:---|:---:|:---|
| **D01** | Additional annotation types & scanned PDFs | **Pass A (M6)** | **LOCKED**: Scanned/encrypted PDF status banners (`pdf-scope-status`) + rectangular figure/area annotations (`Annotation.kind = "area"`). |
| **D02** | Quote/comment copy/live & deletion policy | **M3** | **LOCKED**: Two-mode highlight delete (`Delete Highlight Only` -> `unresolved` badge vs. `Delete Highlight & Quoted Evidence` -> pre-mutation `Revision` snapshot + strip inline atom only). |
| **D03** | Explainer edge/node & category endpoints | **M2.5** | **RESOLVED (`ADR-0008`, `ADR-0010`)**: `Relationship` holds `endpointPageIds` ($N \ge 2$) + `explanatoryPageId?: PageId`. Categories hold `masterPageId?: PageId`. |
| **D04** | Editor framework & schema | **M0** | **RESOLVED (`ADR-0002`)**: ProseMirror with typed inline-atom `evidence` node and JSON source of truth. |
| **D05** | Graph positions, layout & squircle bounds | **M2** | **RESOLVED (`ADR-0008`, `ADR-0009`)**: Seeded `mulberry32` force-directed layout + superellipse squircles + multiply watercolor blend. |
| **D06** | Line endpoints & inter-pane routing | **M1** | **RESOLVED**: Inter-pane SVG margin routing + non-destructive visibility toggle. |
| **D07** | Search mechanisms & retrieval targets | **M2.5** | **RESOLVED (`ADR-0010`)**: Deterministic substring search across titles/bodies/categories/annotations + 1-hop graph neighbourhood API (`src/network/search.ts`). |
| **D08** | Delivery/hosting & Koofr CORS/auth | **Pass B (M4)** | **SPIKED (M0) / LOCKED FOR M4**: Static browser WebDAV blocked by missing CORS headers (`ADR-0005`); M4 implements `KoofrStorageAdapter` via configurable relay/transport + safe pointer-last publication. |
| **D09** | Bundle schema, disentangled PDFs & backup | **M3** | **LOCKED**: Two-lane architecture (`brain.ito.json` / `.ito.zip` via `fflate` + queued `PdfIngestionQueue`), Targeted Backup Checklist, and `"Try Import Anyway"` staging override. |
| **D10** | Zotero mechanism & deduplication | **Pass A (M6)** | **LOCKED**: Pure Zotero JSON / BetterBibTeX JSON / RDF annotation importer (`src/storage/zotero.ts`) matching idempotently on `externalId` with zero live Zotero SQLite mutation (`A24`). |
| **D11** | Website archival/clipping scope | **Pass A (M6)** | **LOCKED**: URL input + required HTML/MD/TXT snapshot dropzone (`website-snapshot-dropzone`). URL-only submissions rejected (`website-snapshot-required-error`); cached snapshots support full offline highlighting & citation (`A15`). |
| **D12** | Phone navigation, cache limits & captures | **Pass B (M4+M5)** | **LOCKED**: Responsive single-doc + bottom-sheet mobile reader (`A21`), per-source binary offload/cache controls, and idempotent `CaptureId` queue (`A22–A23`). |
| **D13** | Revision boundaries, coalescing & checkpoints | **Pass A (M7)** | **LOCKED**: `2000 ms` idle prose coalescing (immediate flush on structural ops) + validated `Checkpoint` every `20` revisions (excluding recursive history arrays, `H01–H07`). |
| **D14** | Timeline grouping, ranges & multi-day reflection | **Pass A (M7)** | **LOCKED**: Creation-timezone `dateKey` (`YYYY-MM-DD`) grouping + `startDate..endDate` range filter + multi-select checkboxes across revisions so `ReflectionEntry` analyzes single-day or multi-day/month spans (`startDateKey..endDateKey`, `H03–H04`). |
| **D15–D16** | Range gesture, last-citation revert & motion | **M1** | **RESOLVED (`ADR-0006`, `ADR-0007`)**: Continuous page-range selector, last-citation reverts to `tentative` iff association exists, `prefers-reduced-motion` + in-app toggle honored. |
| **D17–D18** | Unconnected PDF placeholder & scope | **M2.5** | **RESOLVED (`ADR-0010`)**: Transient `"Not connected yet"` placeholder for all open unconnected PDFs (`N06`) with `"Return to Reader"` and zero DB writes; shared `categoryScope`. |
| **D19** | Device-local vs. shared presentation state | **M2 / M3** | **LOCKED (`ADR-0009`)**: Shared = `nodePositions`, `dragOffsets`, `categoryBounds`, `hidden*`, `annotationStyles`; Device-Local = `paneWidths`, `zoom`, `active3D`, `suppressMotion`. |
| **D20** | High-density graph treatments | **M2 / M2.5** | **RESOLVED (`ADR-0008..0010`)**: $\ge 35$-node density monitor unlocks the Three.js 3D WebGL space with 3D master/member link parity. |
| **D21–D22** | Narrow-screen flow & third-paper pane swap | **M1 / M4** | **RESOLVED (M1) / EXPANDED (M4)**: `<760px` responsive stub in M1 upgraded to full Phone Reader in M4; `switchReaderPane` deduplicates open panes. |

---

## 5. Master Acceptance Checklist by Execution Pass

1. **Completed (`M0 -> M1 -> M2 -> M2.5`)**:
   * `A01–A14`, `A16`, `R01–R20`, `N01–N08` — **241 Vitest unit/jsdom tests passing + 50 Playwright E2E specs compiling**.
2. **Current Pass (`M3 — Complete Backup, Offline Citations & Recovery`)**:
   * `A17-M3` (`binary-offloaded` citations + re-attach), `A18-M3` (Targeted Backup Checklist + `manifest.omissions`), `A19-M3` (Staging Validator + `"Try Import Anyway"` + stepwise schema migration), `D02-M3` (Two-mode highlight deletion with pre-mutation `Revision` snapshot).
3. **Pass A (`M7 + M6 — Local Desktop Completion`)**:
   * **M7 (`H01–H07`, `D13`, `D14`)**: `H01` (2s-coalesced before/after page revision reconstruction), `H02` (annotation comment & relationship history), `H03` (Day-grouped + Date-Range timeline with multi-select revision checkboxes & `startDateKey..endDateKey` span on `ReflectionEntry`), `H04` (omit reflection without losing history; reflections create zero graph nodes), `H05` (20-revision checkpoint reconstruction & explicit missing-segment handling), `H06` (economical delta storage without duplicating PDFs/full brain), `H07` (measured storage/replay overhead probe).
   * **M6 (`A15`, `A24`, `D01`, `D10`, `D11`)**: `A15` (URL + required HTML/MD/TXT snapshot dropzone rejecting URL-only submissions, with full offline highlighting & availability badges), `A24` (repeat Zotero JSON/BetterBibTeX/RDF import preserves identities/comments/anchors with zero duplication), `D01` (explicit scanned/encrypted PDF status + rectangular area annotations).
4. **Pass B (`M4 + M5 — Cloud & Mobile Completion`)**:
   * **M4 (`A20`, `A21`, `D08`)**: `A20` (phone loads latest published Koofr snapshot while PC is off; interrupted/invalid update retains prior working copy + stale status), `A21` (phone PDF/snapshot <-> related-page round-trip preserves reading context + honest offline cache status).
   * **M5 (`A22`, `A23`, `D12`)**: `A22` (offline mobile capture uploads honestly with distinct local/pending/uploaded states; repeated download/import incorporates only once), `A23` (source-free capture remains pending in queue, never auto-creating a subject node).
