# Architecture proposal: one brain, one session, shared services

Status: **PROPOSED**, not accepted. Written 2026-11-16 against `9b91ce3`.
When accepted, split into ADRs (ADR-0015 onwards) and update
`docs/READER-USABILITY-IMPLEMENTATION-PLAN.md` (see section 8).

Method: first state what the programme is for (section 1), keep what already
fits (section 2), then propose only the changes that earn their cost
(sections 3 to 5), and record what was considered and rejected (section 6) so
nobody re-litigates it. Facts are **[read]** (from code), **[run]** (observed in
the running app) or **[est]** (my arithmetic, unmeasured).

---

## 1. The needs that should drive the architecture

These come from `docs/MASTER_SPEC_V4.md` (sections 1 and 2) and the ADRs, not from
taste.

| # | Need | Consequence for architecture |
|---|---|---|
| N1 | **Provenance is the product.** Every quote traces to an annotation, to an anchor, to an exact passage in an immutable source version, and keeps working after binary eviction, version drift or deletion (citation status is *derived*). | Immutable sources; content-hash identity; anchors independent of DOM; derived (not stored) status. |
| N2 | **Local-first, one writer per snapshot.** Offline; PC publishes snapshots pointer-last; phone reads and uploads captures as separate items. No concurrent multi-writer editing (spec section 15, D08). | No CRDT/OT needed. The capture inbox is already the right shape (append-only items). |
| N3 | **Reading and writing at once.** Papers, a page being written, and the evidence between them need co-visibility (evidence lines, quote-insert, "return to the passage"). | A *layout* concept, not only tabs. Fast, lossless "go to the source and come back". |
| N4 | **A deliberately built graph, personal scale.** Nodes never auto-created; the 3D mode unlocks at 35 nodes. Realistic scale is hundreds of pages, low thousands of annotations, tens to a few hundred papers. | In-memory structures are enough. Do not design for millions of nodes. |
| N5 | **Reconstructable history.** Revisions with before/after, delta storage, reflection (M7). | A single place every mutation passes through. |
| N6 | **Large immutable blobs plus many derived artefacts** (page text, text layout, thumbnails, find index, recognition output). | Content-addressed derived cache, never mixed into the synced payload. |
| N7 | **One person, many sittings.** Resume where you were; many papers open over a day. | Local, per-device session state; cheap paper switching. |

---

## 2. Keep as is (do not reinvent)

- React 18 + TypeScript strict, Vite, pdf.js, ProseMirror with the `evidence`
  atom and JSON as source of truth, `idb`, Three.js for the 3D mode.
- `StorageAdapter` boundary and **pointer-last safe publication** (ADR-0004,
  ADR-0005). Right for N2.
- Portable anchors and **derived citation status** (ADR-0003, ADR-0007). Right for N1.
- Pure domain modules: `src/network/{search,hub,layout,blend}.ts`, `citation`,
  anchor resolution. They are testable and already the cleanest part of the code.
- Branded ids; immutable `BrainData` replaced (not mutated) on each change.
  This immutability is what makes the cheap fixes below possible.
- The spec-first, test-per-requirement discipline.

---

## 3. The five moves that earn their cost

Ranked by payoff over cost. Each is independently shippable.

### Move 1. Make "where state lives" explicit: Brain / Session / Services

**Problem [read].** `Workbench` (`workbench.ts`, about 5.7k lines) holds three
kinds of state in one class: durable shared domain data (`data`), and
ephemeral or device-local UI state (`openSourceIds`, `openSubjectPageId`,
`view`, `focusedPage`, `workspaceLayout`, `activeCategoryScope`, sidebar flags,
pane widths). D19 in the spec already says shared vs device-local must be
separate; the code did not carry it through. The result is that navigation is
tangled into the domain object (this is why "Library vs Reader" is decided by
`openSourceIds.length`).

**Proposal.** Three homes, each with its own persistence rule:

| Class of state | Examples | Home | Persisted | Synced |
|---|---|---|---|---|
| Shared durable | pages, annotations, evidence, relationships, categories, sources (metadata), captures, revisions | **Brain service** (domain mutators, persistence, history) | StorageAdapter | yes |
| Device-local durable | settings, reading position, open tabs/layout, pane widths, zoom | **Session store** | `localStorage` (small, typed, versioned) | no |
| Derived, recomputable | page text, text layout, shingles, thumbnails, find index, recognition output | **Derived cache** behind **Services** | IndexedDB, keyed by source `contentHash` | no |
| Ephemeral | selection, popovers, drag state | component state | no | no |

`Workbench` becomes the Brain service. Navigation and layout state moves to the
Session store. The tab/layout work in the usability plan (Appendix A/B) is the
first inhabitant of the Session store, so this move costs nothing extra if tabs
go ahead.

### Move 2. Replace `bump()` with subscribable slice selectors

**Problem [read].** `useWorkbench` exposes `bump()`, which refreshes a whole
state snapshot and re-renders `App`. There is no `React.memo` anywhere in
`src/app`. The reader also calls `setNav` on every scroll/zoom tick.
Three visible panes plus an editor will make that the first jank source
(unmeasured).

**Proposal.** No new library. Give the Brain service
`subscribe(listener)` and use React's `useSyncExternalStore` with *slice
selectors*: `useBrain(b => b.annotationsForSource(id))`. Because `data` is
replaced immutably and unchanged slices keep their identity, a selector returns
the same reference until its slice actually changes, so only affected components
re-render. Migrate incrementally: keep `bump()` as a shim that triggers
`notify()`, convert the hot components first (reader nav, annotation sidebar,
library table). Throttle `setNav` to animation frames.

### Move 3. Derived data never lives in the synced brain: documents and text as services

**Problem [read].**
- Each `SourcePane` reads the bytes and calls `loadDocument(bytes)` itself; the
  left sidebar borrows the document through `paneCommandsRef.getDoc()`; the
  planned find index would be a third consumer. Tab switches would re-read and
  re-parse.
- `Source.cachedPages` and `pageTexts` are stored **on the source record**, i.e.
  inside the synced brain payload that is rewritten on every save and published
  to Koofr. A text-dense page has hundreds of spans; **[est]** on the order of
  tens of kilobytes per page, so low megabytes per paper, hundreds of megabytes
  for a large library. The sample fixtures are text-light (whole brain 14.7 KB
  with four fixture PDFs **[run]**) so they hide this. An M18 store designed for
  exactly this (`pdfAnalysisStore.ts`: per-page records keyed by document) already
  exists.

**Proposal.**
1. **Document service**: `getDocument(sourceId)` returns a ref-counted
   `PDFDocumentProxy` from a small LRU; panes, thumbnails, outline and find all
   share it. Tab switches stop re-parsing.
2. **Text service** over the existing analysis store: per-page normalised text
   and text layout keyed by `contentHash`, produced once, never synced. It feeds
   (a) find in document (RU-2), (b) library-wide search of paper text (today
   nothing searches paper text at all; F7), (c) revised-draft matching
   (`textShingles` already exist), (d) future related-passage lookup.
3. **Rule**: if it can be recomputed from an immutable blob, it is a cache and
   never enters the brain payload. Migrate `cachedPages`/`pageTexts` off `Source`
   using the existing stepwise migration runner (`src/model/migrate.ts`).
4. **Search engine choice [est]**: at personal scale (say 200 papers x 30 pages x
   3 KB = 18 MB of normalised text) a plain scan with `indexOf` over cached text
   costs tens of milliseconds, so a naive scan is enough. Add MiniSearch or similar
   only if ranking or fuzzy matching is wanted or measurement says otherwise.

### Move 4. One navigation model: documents -> tabs (with history) -> layout (with recipes)

**Problem [read].** "Go somewhere and come back" is the core loop of the product
(write, follow a quote to its source, read, return), and it is implemented four
separate ways: `Reader`'s `returnTarget`/`followSource`, the Nodes "dive" and
`returnToMap`, the N06 "Return to Reader" button, and the mobile reader's
bottom-sheet round trip. Each remembers one level. Meanwhile "what is open" is
two unrelated fields (`openSourceIds`, `openSubjectPageId`), and "Open together"
is a special entry path rather than a layout.

**Proposal** (standard, familiar parts; the novelty is only in unifying them):
- **Documents** are things you can open: a paper or website, a page (subject,
  note, connector explanation page). The Library and, later, the Map are tab
  kinds too (open enum).
- **Tabs**: each has its own **history stack of loci** (browser model, so
  Back/Forward and `Alt+Left/Right` are expected behaviour). A *locus* is
  `source @ page/anchor`, `page @ block/evidence`, `map @ scope/focus`, or
  `revision`. `followSource`, "Show in Nodes", "Return to Map/Reader" and the
  mobile round trip all become `navigate(locus)` plus `back()`.
- **Layout**: 1 to 3 visible slots with a focused slot (fixes the existing
  "only the first pane has working toolbar/find" limitation). Evidence lines
  draw from the focused page to the visible papers.
- **Recipes**: pure functions from a target to a set of tabs and a layout:
  *reading* (one paper), *write-from-source* (paper | page), *compare*
  (paper | paper), *connector* (endpoint A | connector page | endpoint B, with
  cited sources reachable via the lines). Opening a hub for editing is
  `openRecipe("connector", relationshipId)`. This is the "ready for writing and
  thinking" experience without a new concept: the recipe registry is the only
  new piece, and new workspaces are one function each.
- A later recipe worth having: **page | map-neighbourhood** (the 1-hop
  `neighborhood()` API already exists), so the map is visible while writing.

### Move 5. Make persistence safe and cheap

**Problems [read]:**
1. **No multi-window guard.** There is no `BroadcastChannel` or Web Locks use
   anywhere. Each window holds its own in-memory `data` and writes the **whole
   brain**, so with two browser windows the last writer silently erases the
   other's changes. Likely to be hit as soon as tabs make "open in a new window"
   natural.
2. **Every save does two full copies plus GC.** `LocalFileStorageAdapter.writeBrain`
   puts the full brain, then **reads the full payload back** to compare two
   fields, then writes the pointer, then deletes superseded payloads. Cost scales
   with brain size on every mutation-save.
3. `publicationRevision` is incremented on every local save
   (`persistNow`), so it is really a local save counter that "stale" detection
   compares against. Works, but the name misleads; the real publication revision
   concept (ADR-0005) is on the remote.

**Proposal:**
- A **single-writer lock** per brain via the Web Locks API (`navigator.locks`),
  and a `BroadcastChannel` notice. A second window opens read-only with a clear
  banner ("Open in another window") and can take over explicitly. A few hours of
  work; prevents silent data loss.
- Replace the full read-back with a cheap integrity check (`getKey` plus a small
  header record with revision and brainId, or a checksum). IndexedDB's
  transaction completion already guarantees durability locally; keep the strong
  read-back verification for the **remote** Koofr write, where it matters.
- Coalesce writes (debounce bursts such as typing) and, once Move 3 has removed
  derived data, the payload stays small enough that whole-brain snapshots remain
  fine for years at this scale. Do not split the brain into per-collection
  records unless measurement says so.
- One **`commit(op)` choke point** in the Brain service that every mutator uses:
  apply the immutable update, notify subscribers, append a small record to the
  history log (what M7 needs), and schedule the coalesced write. This gives
  history, undo hooks and a future sync log **without** event-sourcing the whole
  app.

---

## 4. How the five moves fit together

```
              +--------------------------- React UI ----------------------------+
              |  Tab strip | Layout (1-3 slots) | Reader | Page editor | Map    |
              +---------------+------------------------------+-----------------+
                              |                              |
                 useSession(selector)                useBrain(selector)
                              |                              |
   +--------------------------v----+     +-------------------v----------------+
   | Session store (device-local)  |     | Brain service (shared durable)     |
   | tabs, loci history, layout,   |     | pages, annotations, evidence,      |
   | settings, reading position    |     | relationships, categories, sources |
   | -> localStorage               |     | commit(op) -> history + coalesced  |
   +-------------------------------+     | write -> StorageAdapter -> Koofr   |
                                         +-------------------+----------------+
                                                             |
                  +------------------------------------------v--------------+
                  | Services (derived, never synced)                         |
                  | Document service (PDF LRU) | Text service | Search       |
                  | -> IndexedDB analysis store keyed by source contentHash  |
                  +----------------------------------------------------------+
```

Dependencies point one way (UI -> stores -> services -> storage). Domain-pure
modules (`src/network/*`, citation, anchors) sit beside the Brain service and
have no knowledge of any store.

---

## 5. Inefficiencies: now, later, and the trigger to act

| Item | Now [read/run/est] | Trigger to act | Planned fix |
|---|---|---|---|
| Whole-brain write plus full read-back per save | present; cost scales with brain size | brain payload > ~5 MB or visible typing lag in the page editor | Move 5 (cheap verify, coalesce); Move 3 removes the big payload |
| Derived text in the synced brain | present on `Source` | any real library (megabytes per paper **[est]**) | Move 3 |
| Global re-render via `bump()` | present; no memoisation | profiler shows > 16 ms commits while scrolling with 2+ panes | Move 2 |
| PDF re-read and re-parse on every open/switch | present | reopen > ~400 ms on a 300-page paper (unmeasured) | Move 3 document service; warm LRU |
| Search index rebuilt per keystroke (`buildSearchIndex`) | present; fine small | > ~50 ms per query at ~500 papers / ~5k annotations | cache by data revision |
| Silent last-writer-wins across windows | present | any second window | Move 5 lock |
| Main-thread find indexing | planned (RU-2) | indexing a 300-page paper > ~3 s | chunking; worker later |
| SVG watercolour filters on the map | unmeasured | frame rate with 35+ nodes | the 3D mode and a reduced-filter fallback already exist; profile before touching |

---

## 6. Considered and rejected (and when to revisit)

- **Full event sourcing / operation log as the source of truth.** Would unify
  history, sync and undo, but means rewriting about 5.7k lines of mutators and
  carries schema-evolution and compaction costs for a single-user, single-writer
  app. The `commit(op)` choke point keeps the door open. Revisit if multi-device
  desktop editing becomes a requirement.
- **CRDT / OT.** N2 says one writer. Revisit with the point above.
- **SQLite-wasm on OPFS.** Real queries, incremental writes and FTS, but a large
  dependency and a storage rewrite for a problem that Moves 3 and 5 remove.
  Revisit if the brain exceeds about 50 MB or ranked full-text search over
  more than ~1,000 papers is wanted.
- **Live PDF readers embedded inside the concept canvas (spatial hypertext).**
  Costly (virtualised canvases and hit-testing under a transformed space) and it
  makes both views worse: the map is for overview, the reader for focus. The
  cheap alternative serves the same need: fast, lossless jumps between them
  (loci + back) and a neighbourhood-map tab beside the page being written.
- **Redux / MobX / Zustand.** `useSyncExternalStore` over an immutable store gives
  slice subscriptions without a dependency.
- **Server component, plugin system, micro-frontends.** Not needed (D08, N2, N4).
- **A custom diff/merge engine for sync.** Pointer-last whole snapshots plus an
  append-only capture inbox already fit N2.

---

## 7. Effort and order (rough, +-40 %, unmeasured)

| Move | Effort | Notes |
|---|---|---|
| 5a Single-writer lock plus banner | 0.5 to 1 day | independent; do first, prevents data loss |
| 5b Cheap local verify, coalescing | 0.5 to 1 day | |
| 3a Document service | 1.5 to 2 days | prerequisite for find and tabs |
| 2 Slice store plus hot-component migration | 2 to 3 days | incremental |
| 3b Text service plus move `cachedPages`/`pageTexts` off `Source` (with migration) | 2 to 3 days | needs a migration test over old brains |
| 1 Brain/Session split | 4 to 6 days | wide but mechanical; the tab work populates Session |
| 4 Tabs, history of loci, layout, recipes | 10 to 16 days (tabs and layout) plus 2 to 3 (loci) | see the usability plan, Appendix A and B |
| 5c `commit(op)` choke point | 2 to 3 days | |

Order that wastes least: 5a, 3a, then the usability plan Phases 0 to 2
(find consumes the Text service), then 2, 3b, then decide the tab/layout work and
build Moves 1 and 4 together, then 5c.

---

## 8. Effect on the usability plan if accepted

- RU-2.2: the find index lives in the Text service, not a component ref.
- RU-3.1: the session store is the Session store of Move 1, shaped
  `{ tabs, activeId, layout, perDoc }` from version 1.
- RU-5.1a: `searchSources` and the library-wide text search share the Text
  service's normaliser.
- RU-3.4 / RU-3.6: superseded by Move 4 if tabs and layout are adopted.
- Add a Phase 0b with 5a (writer lock) and 3a (document service).

## 9. Open decisions

- **AD1** Writer-lock policy: second window read-only with takeover (proposed),
  or refuse to open?
- **AD2** Is the Map a tab kind now or later? (Proposed: later, but keep tab kinds
  an open enum.) History and Captures stay top-level views for now.
- **AD3** Are loci histories persisted across reload? (Proposed: the active
  locus per tab yes, the back stack no.)
- **AD4** Rename `publicationRevision`'s local meaning, or leave it? (Proposed: add
  a clearly named `localSaveCounter` only if confusion costs something.)
- **AD5** Where do recipes live, and are they user-extensible? (Proposed: a plain
  registry module; not user-extensible.)
