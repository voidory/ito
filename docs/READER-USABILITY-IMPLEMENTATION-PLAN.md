# Reader & app usability: implementation plan (binding spec)

Status: **active**. Created 2026-11-16 against code at `9b91ce3`
(docs commit `f297ae9`). This file supersedes the sequencing summary in
`docs/READER-USABILITY-ROADMAP.md`; the roadmap stays as the short overview.

LaTeX extraction work is paused and out of scope. Phone layout is out of scope
(see section 9).

---

## 0. Fidelity contract (read before implementing anything here)

This document exists so that implementers, including future sessions that have
none of the audit conversation, do not rebuild a lossy version of the plan.
Binding rules:

1. **Implement items as specified.** Each item has an ID (`RU-<phase>.<n>`),
   a verified root cause, a design, files/symbols, tests and acceptance
   criteria. Do not merge, skip or reorder items without recording a
   deviation (rule 2).
2. **Deviations are allowed but must be written down.** If reality differs from
   this plan (a symbol moved, a premise was wrong, a better design exists),
   change this file *in the same commit* under section 11 "Deviation log" with
   the reason. Silent divergence is the failure this file is meant to prevent.
3. **Line numbers drift; symbols do not.** References are given as
   `file` + symbol, with line numbers as of `9b91ce3` for orientation only.
   Locate by symbol (`grep -n`), never trust a stale line number.
4. **Anything marked UNVERIFIED must be checked before building on it.** The
   plan states what was measured and what was inferred. Do not promote an
   inference to a fact.
5. **Tests first.** Phase 0 creates `e2e/reader-usability.spec.ts` with each
   known defect as a `test.fixme`. An item is "done" when its fixme is turned
   into a passing `test`, plus the unit tests listed for the item.
6. **No scope creep.** Do not refactor unrelated code in these PRs. Do not touch
   `src/science/`, the storage adapters' wire format, or the synced data model
   unless an item says so (only RU-3.1 touches persistence, and it does so
   locally).
7. **Preserve `data-testid`s.** If one must change, update every spec and unit
   test in the same commit (ADR-0014 rule). Do not add new inline
   `style={{}}` blocks; use classes and the tokens in `theme.css`.
8. **Every item's definition of done** (section 3.4) applies. One commit per
   item, message prefixed with the ID, e.g. `[RU-1.2] Dismiss Subjects menu on
   Esc and outside click`.
9. **Update the tracker** (section 10) in the same commit that completes an item.

---

## 1. Verified facts about the current code

Everything in this section was observed on `9b91ce3`: either by running the app
in headless Chromium (marked **[run]**) or by reading code (marked **[read]**).

### 1.1 Health baseline
- `npm run typecheck`: clean. **[run]**
- `npx vitest run`: 118 files, 1024 tests, all pass, about 47 s. **[run]**
- Playwright e2e (22 specs) and the LaTeX browser benchmark: **not run** in the
  audit. Phase 0 records their baseline.

### 1.2 What already works (do not regress)
- Text selection, then Highlight/Underline from the selection toolbar, creates
  an annotation; the toolbar closes after commit. **[run]**
- Clicking a highlight opens the edit popover; `Esc` closes it. **[run]**
- The selection toolbar follows the selection when `.pane-scroll` scrolls (the
  bug described in `KIRO_HANDOFF_m13.md` section 1.2 appears fixed). **[run]**:
  toolbar y moved 826.7 -> 526.7 for a 300 px scroll.
- Tool keys `h`, `u`, `n`, `a` select tools; `Esc` clears the active tool.
  **[run]**
- Zoom +/-, Fit width, page input, thumbnail rail, annotations sidebar,
  right-click context menu all function. **[run]**
- Annotations persist across reload; the library "Annotations" count updates.
  **[run]**

### 1.3 Corrections to the earlier roadmap
- The shared `Popover` primitive **is** already used by the selection toolbar
  and the highlight edit popover (`AnnotationOverlays.tsx`: `SelectionToolbar`,
  `HighlightEditPopover`) and by `ReaderToolbar.tsx`. The roadmap's "check
  whether it is used" is resolved. The defect is inside the primitive
  (RU-1.1), not missing adoption.
- The Subjects launcher (`App.tsx`: `SubjectsLauncher`) and the settings menu
  (`App.tsx`: `SettingsMenu`) are **not** built on `Popover`; they are
  hand-rolled `position:absolute` blocks with no outside-click handling.

---

## 2. Audit finding index

| ID | Finding | Plan item(s) |
|---|---|---|
| F1 | Find only searches mounted pages; span-level counts | RU-2.x |
| F2 | Phone layout unusable | **Parked** (section 9) |
| F3 | Popovers not clamped to viewport; selection toolbar close button overlaps swatch | RU-1.1, RU-1.3 |
| F4 | Area drag leaves the page; blank sidebar preview | RU-4.x |
| F5 | Subjects menu ignores Esc / outside click | RU-1.2 |
| F6 | Permanent "Stale" badge with no remote | RU-3.2 |
| F7 | No way to search papers by title anywhere (top search does not index sources) | RU-5.1a/b/c |
| F8 | Reload loses the open paper, page, zoom | RU-3.1 |
| F9 | Sidebar not in page order | RU-5.2 |
| F10 | "Delete highlight" on underline | RU-1.4 |
| F11 | Test PDFs seeded for real users | RU-3.3 |
| F12 | Fit-width gives very wide pages | RU-5.3 |
| F13 | Bare empty states | RU-5.4 |
| F14 | `favicon.ico` 404 in console (noise) | RU-5.5 |
| F15 | Clicking the highlighted "Files" tab inside the reader does nothing; the only way back is an unlabelled icon | RU-3.4 |
| F16 | Reader overflow menu "Switch paper..." silently swaps to an arbitrary paper (`switchable[0]`); a persistent per-pane `<select>` duplicates it | RU-3.6 |

---

## 3. Global working method

### 3.1 Running the app and e2e in the cloud sandbox
- The repo pins a Playwright whose browser build is **not installed** here
  (it expects `chromium_headless_shell-1254`; the sandbox ships
  `/opt/pw-browsers/chromium`). Do **not** run `npx playwright install`.
  Launch with `executablePath: '/opt/pw-browsers/chromium'` and
  `args: ['--no-sandbox']`. RU-0.2 makes `playwright.config.ts` honour
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` so specs run unmodified.
- Dev server: `npx vite --host 127.0.0.1 --port 5173 --strictPort` (kill it
  afterwards: `pkill -f "vite --host"`). The e2e config instead builds and
  serves `vite preview` on 4173.
- Fixtures: `src/test/fixtures/{sample-3page,sample-multicol,sample-rotated,
  sample-12page-figure,sample-math}.pdf`. Import in a spec with
  `page.setInputFiles('[data-testid="import-pdf-input"]', path)`.
- A fresh browser context starts with an empty store except for the seeded
  fixtures (until RU-3.3 removes the seed). Import explicitly in every spec so
  specs survive RU-3.3.
- Screenshots: viewport 1440x900 for desktop checks. Look at them; do not
  rely on DOM assertions alone for layout items.

### 3.2 Commands that must stay green on every item
```
npm run typecheck
npx vitest run                      # baseline 118 files / 1024 tests
npx playwright test e2e/reader-usability.spec.ts   # the tracker spec
npx playwright test <any spec touching the area you changed>
```
Phase boundaries additionally run the whole e2e suite.

### 3.3 Testing rules
- jsdom render tests cannot see layout, scroll or canvas. Anything about
  position, overlap, clipping or scrolling needs a Playwright assertion on real
  bounding boxes.
- Prefer asserting geometry over screenshots: e.g. "popover bounding box lies
  within the viewport" rather than pixel diffs.
- Pure logic (placement maths, text matching, sort order, persistence
  serialisation) gets plain Vitest unit tests with no DOM.

### 3.4 Definition of done (every item)
- [ ] Behaviour matches the item's acceptance criteria.
- [ ] Item's unit tests added; its `test.fixme` (if any) is now a real `test`.
- [ ] `typecheck`, full `vitest`, tracker spec and touched specs are green.
- [ ] No new inline `style={{}}` beyond dynamic positions; no removed or
      renamed `data-testid` without updated tests.
- [ ] Section 10 tracker updated; section 11 updated if anything deviated.
- [ ] Commit message starts with `[RU-x.y]`.

---

## 4. Phase 0: baseline and guard rails

Goal: make later phases measurable and stop unrelated CI cost.

### RU-0.1 Record the e2e baseline
- Run `npm run test:e2e` (after RU-0.2) on a clean checkout of `main`.
- Record in section 10: pass/fail counts, wall time, any spec that is already
  red or flaky, and whether it needs the Koofr network (many `koofr*` specs
  likely use an in-memory fake; confirm).
- A red spec found here is **not** silently fixed: either fix it in its own
  commit labelled `[RU-0.1]`, or mark it `test.fixme` with a note in the
  tracker. Phases must start from a known state.

### RU-0.2 Make Playwright use a provided browser
- File: `playwright.config.ts`, `playwright.benchmark.config.ts`.
- Add, only when `process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` is set:
  `use: { launchOptions: { executablePath: <env>, args: ["--no-sandbox"] } }`.
- Default behaviour (env unset) must be unchanged so GitHub CI still works.
- Acceptance: `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/opt/pw-browsers/chromium
  npx playwright test e2e/ready.spec.ts` passes in the sandbox.

### RU-0.3 Stop the LaTeX benchmark running on reader PRs
- File: `.github/workflows/latex-benchmark.yml` (push and pull_request on
  `main`, 30 min timeout, installs Chromium).
- Add `paths:` filters to both triggers covering at least `src/science/**`,
  `src/pdf/**` (the extractor consumes pdf.js geometry), `scripts/**`
  related to the corpus, `playwright.benchmark.config.ts`,
  `e2e/latex-*`, `package.json`, `package-lock.json`, and the workflow itself.
  Keep `workflow_dispatch` as is.
- **Check before merging:** if the workflow is a *required* status check in
  branch protection, a path-filtered skipped workflow leaves the check
  "pending" and blocks merges. Verify the repo's branch protection first; if
  it is required, instead keep the trigger and add an early "changed paths"
  step that exits successfully (so the check reports green) when nothing
  relevant changed.
- `m17-playtest.yml` triggers on every push/PR to `main` and `release/v1.0`:
  read it and decide if it needs the same treatment; record the decision.
- Acceptance: a PR touching only `src/app/reader/*` does not start the
  benchmark job (or it exits in seconds).

### RU-0.4 Create the tracker spec
- New file `e2e/reader-usability.spec.ts`.
- One `test.describe` per phase; one `test.fixme` per finding F1, F3, F4, F5,
  F6, F8, F9, F10, F11, F13 with a one-line comment giving the finding ID and
  the observed behaviour. Each fixme body should already contain the real
  steps and assertions where practical, so flipping it is trivial.
- Shared helper `openFixture(page, "sample-12page-figure.pdf")`: goto `/`,
  import via `import-pdf-input`, click the library row, wait for
  `.pdf-page-stage`, wait for 12 canvases.
- Acceptance: file typechecks; fixme tests are skipped in a normal run and
  listed by `--list`.

Phase 0 exit: RU-0.1 numbers recorded; RU-0.2 to RU-0.4 merged.

---

## 5. Phase 1: popover and menu foundation (F3, F5, F10)

### RU-1.1 Surface placement that knows the surface's height

**Evidence [run]:** with the 12-page fixture at 1440x900, a highlight on the
third visible line (y about 888) opened the edit popover at y about 828 with its
comment textarea cut off at the viewport bottom and the popover covering the
highlight itself (`21-popover.png`). The selection toolbar was fine vertically
but overlapped neighbouring text by design.

**Root cause [read]:** `clampFixedAnchor` in `src/app/ui/primitives.tsx`
clamps only horizontally. Vertically it is
`top = rect.top > 64 ? rect.top - 48 : rect.bottom + 12`: it assumes a surface
about 48 px tall that sits above the anchor. A ~300 px tall popover placed at
`rect.top - 48` extends below the viewport and over its own anchor. `Popover`
(same file) calls `clampFixedAnchor(anchor, width)` and never measures its
own height.

**Constraint [read]:** `clampFixedAnchor` is pinned by existing tests
(`src/app/reader.feat002.render.test.ts` "clampFixedAnchor centres over the
anchor and clamps 12px from each edge"; `src/app/ui/primitives.render.test.ts`).
**Do not change its behaviour.** Add a new function and migrate `Popover` to it.

**Design:**
1. New pure function in `primitives.tsx` (or a new `src/app/ui/placement.ts`
   re-exported from it):
   ```ts
   placeSurface(
     anchor: AnchorRect,
     size: { width: number; height: number },
     viewport: { width: number; height: number },
     opts?: { margin?: number; gap?: number; prefer?: "above" | "below" }
   ): { left: number; top: number; placement: "above" | "below"; maxHeight: number }
   ```
   - Horizontal: same centring and 12 px margin clamp as today.
   - Vertical: compute `spaceAbove = anchor.top - margin`,
     `spaceBelow = viewport.height - anchor.bottom - margin`. If the surface
     fits on the preferred side (`size.height + gap <= space`), use it. Else if
     it fits on the other side, use that. Else use the side with more room and
     set `maxHeight = thatSpace - gap` (the surface scrolls internally).
     The surface must **never** overlap the anchor when either side fits.
   - Final clamp: `top` within `[margin, viewport.height - size.height - margin]`.
   - Default `prefer`: `"above"` for compact toolbars (selection toolbar),
     `"below"` for tall popovers (edit popover), passed by the caller.
2. `Popover` measures its own height with `useLayoutEffect` plus a
   `ResizeObserver` on `surfaceRef` (the edit popover changes height when a
   submenu opens), and recomputes on scroll/resize via its existing anchor
   prop updates. Until the first measurement, render `visibility: hidden` to
   avoid a one-frame flash at a wrong position.
3. `Popover` gains optional `prefer` prop; sets `style.maxHeight` and
   `overflow-y: auto` through a class (`.ito-ui-popover`, see
   `theme.css`) rather than inline where possible; `left/top/width` stay
   inline because they are dynamic.
4. `HighlightEditPopover` passes `prefer="below"`; `SelectionToolbar` keeps
   `"above"`.
5. Leave the `mouseup`-outside-click dismissal as is: its comment documents
   that it deliberately runs after the textarea blur-autosave (commit
   `4e29b1a`). Do not switch it to `mousedown`.

**Tests:**
- Unit (`primitives.render.test.ts` or new `placement.test.ts`): table-driven
  `placeSurface` cases: fits above; fits below only; fits neither (maxHeight
  set); anchor near right/left edge; anchor taller than viewport; surface taller
  than viewport; `prefer` honoured when both fit; never overlaps anchor when a
  side fits.
- Playwright (flip F3 fixme): in `sample-12page-figure`, select and highlight a
  line that renders within 200 px of the viewport bottom, click it, assert
  `highlight-edit-popover` bounding box is fully inside the viewport and does
  not intersect the highlight fragment's bounding box. Repeat with the
  highlight near the viewport top and near the right edge.

**Acceptance:** no popover rendered by `Popover` can extend outside the
viewport, and none covers its own anchor when space exists.

**Risks:** flicker on first paint (hence `visibility:hidden` until measured);
scroll-follow behaviour in `HighlightEditPopover` (it recomputes `anchor` on
scroll with `resolveAnchor`) must keep working: re-run the existing popover
unit tests.

### RU-1.2 Dismiss non-Popover menus on Esc and outside click (F5)

**Evidence [run]:** the Subjects menu stayed open after `Esc` and across view
switches; the settings menu and the Subjects menu were open simultaneously.

**Root cause [read]:** `SubjectsLauncher` toggles `open` only from its button;
no `Esc` or outside handling. `SettingsMenu` renders `Menu` (which handles
`Esc` only when focus is inside the menu element) and has no outside-click
handling.

**Design:**
1. New hook `useDismiss(ref, { onDismiss, enabled })` in `src/app/ui/`:
   document-level `keydown` (`Escape`) and `pointerdown` outside `ref.current`.
   The `ref` must be the **whole launcher root** (button + menu) so that
   clicking the toggle button while open is "inside" and is handled by the
   button's own `onClick` (otherwise: outside pointerdown closes, then click
   reopens, a classic bug).
2. Apply to `SubjectsLauncher` and `SettingsMenu` (and the
   `settings-sync-popover` block in the same component).
3. Opening one menu closes the other implicitly: clicking the second's button
   is outside the first's root. No global state needed.
4. Replace the hardcoded `background: "#fff"`, `border: "1px solid #ddd"` in
   `SubjectsLauncher` with the tokens already used by `settings-sync-popover`
   (`var(--ito-bg-elevated)`, `var(--ito-border)`, `var(--ito-shadow-lg)`).
   Do not restructure its markup: keep `subjects-launcher`,
   `subjects-launcher-toggle`, `subjects-launcher-menu`,
   `create-standalone-subject`, `subjects-launcher-item` (with `data-page-id`),
   `subjects-launcher-empty`.

**Tests:** unit test for `useDismiss` (Esc; outside; inside does not dismiss;
disabled). Playwright (flip F5): open Subjects, press `Esc`, menu gone; open
Subjects, click empty page area, menu gone; open Subjects then click settings,
exactly one menu visible. Run the two specs that reference these testids
(`grep -l "subjects-launcher\|settings-menu" e2e/`).

### RU-1.3 Selection toolbar internal layout (F3, part 2)

**Evidence [run]:** in `11-selection.png` the small "x" dismiss button
overlaps the pink swatch.

**Work:** inspect `.ito-selection-toolbar` and `.ito-color-controls`
(`theme.css` about line 1145) and the `dismiss-toolbar` button
(`AnnotationOverlays.tsx`, `SelectionToolbar`). The fixed `TOOLBAR_WIDTH = 260`
is likely too narrow for four buttons plus four swatches plus the dismiss
button, or the dismiss button is absolutely positioned. Fix with CSS
(flex, no overlap, adequate gap); if the content cannot fit 260 px, raise the
width constant and the matching placement width.

**Decision recorded:** keep the dismiss button. (`Esc` and click-away already
dismiss, so it is redundant; but removing it is a UX change outside this
audit's scope. Revisit only if it cannot be laid out cleanly.)

**Test:** Playwright asserts no pairwise intersection among the bounding boxes
of the toolbar's direct controls (`commit-highlight`, `commit-underline`,
each `color-*`, `dismiss-toolbar`).

### RU-1.4 Kind-aware delete labels (F10)

**Evidence [run]:** the underline's popover shows "Delete highlight" /
"Delete highlight and quotes".

**Locations [read]:** `AnnotationMenus.tsx` (labels "Delete highlight",
"Delete highlight and quotes", "Delete highlight only"), `AnnotationSidebar.tsx`,
`AnnotationOverlays.tsx` (all three files contain "Delete highlight").

**Design:** one helper `annotationNoun(view): "highlight" | "underline" |
"note" | "area"` derived from the annotation view (style kind and scope kind;
read `AnnotationStyle` and scope types in `src/model/types.ts` to enumerate the
real kinds; do not guess). Use it in all three files. Capitalise at the call
site. Keep the `data-testid`s.

**Tests:** unit test of the helper over every kind; existing render tests that
assert the old strings (`grep -rn "Delete highlight" src e2e`) updated in the
same commit.

Phase 1 exit: F3, F5, F10 fixmes are real tests; full suite green.

---

## 6. Phase 2: find across the whole document (F1)

Independent of Phase 1; may run in parallel.

### Verified facts
- **[run]** From page 1 of the 12-page fixture, searching "Page 9" returned
  `0/0` although page 9's heading is "Two-Column Study - Page 9". Searching
  "Section 3" returned 2 hits where the document has at least 3 pages
  containing it.
- **[read]** `SourcePane.tsx` `runFind` iterates `pagesRef.current` and
  `page.textLayer.querySelectorAll("span")`, testing
  `span.textContent.toLowerCase().includes(q)`. Pages are virtualised
  (`rp.isRendered()`), so unrendered pages have no spans. Counting is per span,
  not per occurrence; a phrase split across spans or lines never matches.
- **[read]** `source.pageTexts` exists but is capped to the first 60 pages
  (`extractPageTexts`) and is only extracted when identity is needed.
  `source.cachedPages` only covers pages that were rendered. **Neither is a
  complete text source. Do not build find on them.**

### Design

**RU-2.1 Pure matcher (`src/pdf/findIndex.ts`, new, no DOM, no pdf.js import).**
- Input: per page, an array of text items `{ str: string; hasEOL?: boolean }`
  as returned by pdf.js `getTextContent().items`.
- `buildPageIndex(items)` returns `{ text: string; map: Array<{ item: number;
  offset: number }> }` where `text` is the normalised concatenation and `map`
  lets any `[start, end)` range in `text` be mapped back to item indices.
- Normalisation, applied identically to the page text and the query:
  NFKC (turns the ligature U+FB01 into "fi"), lower-case, curly quotes to
  straight, collapse all whitespace runs (including line breaks) to one space,
  and join a hyphen at end-of-line with the next item (`exam-` + `ple` =>
  `example`) while keeping the offset map correct.
- `findAll(pageIndex, query)` returns non-overlapping occurrences as
  `{ start, end }` over `text`; `toItemRanges(...)` maps them to item indices.
- Diacritic folding (decision D7): when the setting `find.ignoreAccents` is on
  (default **on**, see RU-3.5), additionally strip combining marks after NFD
  decomposition (query and page text alike) so "cafe" matches "caf\u00e9". The
  offset map must stay correct when characters are removed (same mechanism as
  the hyphen join). The setting is read when the find index is built or the
  query is run; changing it clears the cache. Known limit: LaTeX PDFs often
  extract an accent as a separate mark before the letter ("Scho\u00a8dinger");
  folding does not repair that and it is out of scope.
  **Ordering:** Phase 2 precedes RU-3.5, so `findAll`/`buildPageIndex` take an
  explicit `ignoreAccents` option (default `true`); RU-3.5 wires it to the
  setting. Do not read `localStorage` from the pure matcher.

**RU-2.2 Document index (in `SourcePane.tsx` or a new hook
`useDocumentFindIndex`).**
- Source of text: `docRef.current` (the `PDFDocumentProxy`),
  `getPage(n).getTextContent()` for **all** pages, not the 60-page cache.
- Built **lazily on first open of the find bar**, not on document open, so
  reading a book you never search costs nothing. Process pages sequentially
  with `await` between pages (keeps the UI responsive); cache the result in a
  ref keyed by the source's content hash; invalidate when the source changes.
- Expose progress `{ done, total }`. The find bar shows "indexing 37/300"
  until complete; results found so far are usable immediately.
- Cancellation token: starting a new index or closing the bar cancels the old
  loop.
- Before committing to eager full-document indexing, measure on a ~300-page
  real paper/book: wall time and memory. If > ~3 s or > ~50 MB, index in
  chunks around the current page first. Record the measurement in section 11.

**RU-2.3 Result model and navigation.**
- State: `{ hits: Array<{ page: number; itemRanges: ... }>, active: number }`.
  `find-count` shows `active+1 / hits.length` where `hits` counts
  **occurrences** (not spans).
- Typing: debounce about 150 ms; reset the active hit to the first hit at or
  after the page currently in view (not always hit 0).
- `Enter` / `Shift+Enter` cycle with wrap-around; same behaviour for
  `find-next` / `find-prev` buttons.
- Moving to a hit on a page that is not rendered: scroll the page container
  into view (existing `goToPage`), then wait until that page's text layer is
  mounted. **UNVERIFIED:** find the real "page rendered" signal in the
  virtualisation code (`isRendered`, the render/rerender path in
  `src/pdf/render.ts`, the observer in `SourcePane.tsx`). If there is no
  event, poll via `requestAnimationFrame` for at most ~2 s and then give up
  with the count still correct.
- Marking: map the hit's item ranges to text-layer spans and add
  `ito-find-match` (all) / `ito-find-active` (current). **UNVERIFIED:** whether
  text-layer `<span>` elements map 1:1 to non-empty `items` (pdf.js text layers
  can contain `.markedContent` wrappers and skip empty items). Step 0 of this
  item is a spike asserting, on `sample-12page-figure` and `sample-multicol`,
  that span *i* corresponds to non-empty item *i*; if it does not, match by
  cumulative text length instead. v1 marks whole spans a hit overlaps;
  character-level highlighting (CSS Custom Highlight API with span fallback)
  is optional and not required.
- Re-apply marks when a page is (re)rendered after the user scrolls away and
  back, and clear them all on close, on `Esc` in the input, and when the query
  becomes empty (current code already clears on these).

**RU-2.4 Keep the existing contract.** Preserve testids and classes:
`find-bar`, `find-input`, `find-count`, `find-prev`, `find-next`, `find-close`,
`.ito-find-match`, `.ito-find-active`. Keep the window-level `Ctrl/Cmd+F`
handler (only for the primary pane). `grep -rn "find-\|ito-find" src e2e` for
existing tests before changing behaviour.

### Tests
- Unit (`src/pdf/findIndex.test.ts`): same-span hit; hit spanning two items;
  hit spanning a line break; end-of-line hyphenation; ligature (page text containing U+FB01 matches the query "fi"); case-insensitivity; overlapping occurrences of
  "aa" in "aaaa" (decide and document: non-overlapping, count 2); empty query;
  query longer than page; item-range mapping correctness.
- Playwright (flip F1): "Page 9" from page 1 reports `1/1` and the viewport
  ends up on page 9 with `ito-find-active` visible; "Section 3" reports the
  true occurrence count of the fixture (compute it from the PDF text in the
  test, do not hardcode a guess); `Enter` cycles through pages in order and
  wraps; closing clears all marks.

### Acceptance
Find returns identical results regardless of which pages are currently
rendered, counts occurrences, matches phrases across spans and line breaks,
and scrolls to hits on unrendered pages.

### Risks
Large PDFs (index time/memory; see RU-2.2 measurement); scanned PDFs have no
text: show "No text layer on this document" rather than `0/0`; RTL and CJK
text: accept misses in v1 and record them.

---

## 7. Phase 3: state on launch (F6, F8, F11)

### RU-3.1 Restore the reading position (F8)

**Evidence [run]:** after `reload`, the app returns to the Library
(`reader?` 0, `library?` 1); open paper, page and zoom are lost.

**Facts [read]:** `Workbench.openSourceIds` is a private in-memory field
(`workbench.ts`, `openSource()` sets it); it is not persisted. The user zoom
multiplier is local React state in `SourcePane` (`zoom`, with a separately
computed `fitScale`); the current page is reported via `onNavChange`. The
synced "brain" payload goes through `StorageAdapter` and is published to Koofr:
**do not put reading position there**, or sync would push scroll position
between devices. The project already keeps local-only data in IndexedDB
(`src/storage/pdfAnalysisStore.ts`), but that store's header documents
`localStorage` as unsuitable for *large* data; a reading position is tiny.

**Design:**
1. New module `src/app/readerSession.ts` with a small interface
   `ReaderSessionStore { load(): Session; save(patch): void; clear(): void }`
   and a `localStorage` implementation under key `ito.reader.session.v1`, every
   access wrapped in try/catch (storage can throw or be blocked). Plus an
   in-memory implementation for tests.
2. Shape:
   ```ts
   interface Session {
     version: 1;
     lastSourceId: string | null;          // null when the user is in the Library
     perSource: Record<string, {
       page: number;        // 1-based
       pageOffset: number;  // 0..1 fraction down that page's stage
       zoom: number;        // the user multiplier (not absolute scale)
       updatedAt: number;
     }>;                    // keep at most 200 entries, evict by oldest updatedAt
   }
   ```
3. Write path: on scroll-end (debounce about 300 ms) and zoom change, from
   `SourcePane` where `onNavChange` already fires; set `lastSourceId` when a
   source opens; set it to `null` when the user clicks `back-to-library`
   (so an intentional exit is remembered).
4. Read path: on app start, after the workbench is ready, if `lastSourceId`
   exists in `wb.rawData().sources` call `wb.openSource(id)` and pass an
   `initialPosition` prop into `SourcePane`; after pages mount (the `ready`
   state), apply zoom then scroll to `page` + `pageOffset`. If the source no
   longer exists (deleted), drop the entry and show the Library.
5. Honour `reader.restoreLastSession` (RU-3.5): when off, never auto-open on
   start (the session is still recorded so "Recent" in RU-3.4 works).
6. Scope: only the reader session. Do not restore Nodes/History/Captures view
   mode or multi-paper workspaces (decision D2).

**Tests:** unit tests for the store (round trip; corrupt JSON returns empty;
`localStorage` throwing; LRU eviction at 201 entries; clear). Playwright (flip
F8): open page 7 at a changed zoom, reload, assert reader visible, page input
shows 7 (+-1 for offset rounding), zoom within 1 %; click back to library,
reload, assert Library. Run **all** specs that `reload` (e.g.
`backup-recovery.spec.ts`): they may assume the Library after reload; fresh
contexts have no session, so they should be unaffected. **UNVERIFIED**, check.

### RU-3.2 Honest sync status badge (F6)

**Evidence [run]:** header badge reads "Stale", tooltip "Stale", in a fresh
local-only install.

**Facts [read]:** `Workbench.syncState` is initialised to `"stale"`
(`workbench.ts`, `private syncState`). `SyncBanner.tsx` maps states to labels
("Up to date", "Publishing...", "Stale", "Offline") and sets
`title={status.reason ?? label}`.

**Design:** do **not** change `SyncStatus` semantics or the workbench default
(existing tests pin them). In the header badge component, compute
`local = !remote`; when local render a muted "Local only" with the title
"Not synced. Use Settings > Configure Sync to back up to Koofr." and keep
`data-testid="sync-publication-status"` with `data-state` unchanged (add
`data-local="true"`). When a remote exists, keep today's labels, and make the
"Stale" title say what is stale ("Local changes not yet published").
`grep -rn "sync-publication-status\|Stale" src e2e` first; update any test
asserting the old text in the same commit.

**Test:** Playwright/RTL: no remote => text "Local only"; configure the demo
remote (`configureDemo` in `SyncBanner.tsx`) => state-dependent labels return.

### RU-3.3 Stop seeding test documents (F11)

**Evidence [run]:** a brand-new profile already lists "Multi-Column Fixture",
"Rotated Fixture" and "Sample Document (3 pages)".

**Facts [read]:** `App.tsx` effect "Seed the library with the two real
fixtures on first run" calls `importFixture(...)` three times. Static
`?url` imports of the three PDFs at the top of `App.tsx` mean they are
bundled even if unused. `e2e/annotation-popover.spec.ts`, `selection.spec.ts`
and `workspace.spec.ts` reference the seeded titles (`workspace.spec.ts` line
about 218 relies on a third paper existing for "switch paper").

**Design:**
1. Build-time flag `VITE_ITO_SEED_FIXTURES`. Seed only when it equals `"1"`.
2. Make the fixture imports **dynamic and inside the guarded branch**
   (`await import("../test/fixtures/sample-3page.pdf?url")`), so Vite
   eliminates them from production builds. Acceptance check: after
   `npm run build`, `dist/` contains no `sample-*.pdf`.
3. Set the flag where it is needed: `.env.development` (`=1`, keeps dev
   ergonomics) and in `playwright.config.ts`'s `webServer.command`
   (`VITE_ITO_SEED_FIXTURES=1 npm run build && npm run preview`) so existing
   e2e specs need no edits.
4. Replace the empty library message (`Library.tsx`, `library-empty`,
   currently "No documents yet.") with a real empty state: one sentence plus a
   primary "Import PDF" button that triggers the same file input as
   `import-pdf-btn`, and mention drag-and-drop (a `library-pdf-dropzone`
   already exists, verify it is visible when empty).

**Tests:** unit/RTL: with flag off the library is empty and shows the empty
state; Playwright run with the flag on passes unchanged. Build check as above.
Run the **whole** e2e suite for this item; failures from specs that implicitly
depended on the seed are fixed by importing explicitly in those specs.

### RU-3.4 Seamless navigation between papers and the Library (F15)

Depends on RU-5.1a (shared source search). Decisions D11 and D12 apply.

**Evidence [run]:** inside the reader the top-level "Files" tab stays
highlighted, but clicking it leaves the reader open (`reader` 1, `library` 0).
The only route back is the unlabelled `<` icon (`back-to-library`) at the far
left of the reader toolbar. Searching a paper's title anywhere finds nothing
(F7).

**Design:**
1. **Files tab works from the reader.** Clicking `view-files` while a reader is
   open returns to the Library (clears the open source; also records
   `lastSourceId = null`, RU-3.1). Fix this regardless of anything else below.
2. **Title becomes a paper switcher.** In `ReaderToolbar.tsx` the
   `reader-title` element becomes a button (chevron affordance, tooltip "Switch
   paper or go to Library") opening a `Popover` (RU-1.1) containing: a search
   field (autofocus, uses RU-5.1a `searchSources`), a "Recent" list (the last 8
   papers by `updatedAt` from the reader session store, RU-3.1, excluding the
   current one), search results when the field is non-empty, and a fixed last
   row "All papers (Library)". Keyboard: arrows move, Enter opens, Esc closes.
   Selecting a paper replaces the current reading session (single-paper mode:
   `wb.openSource`), restoring that paper's saved position if any.
3. **Back control labelled.** Keep `back-to-library`, but give it a visible
   text label ("Library") next to the icon at toolbar widths >= 900 px; icon
   only below that.
4. **Remove** the persistent per-pane `switch-paper` `<select>` and the toolbar
   overflow item "Switch paper..." (see RU-3.6 for what replaces them in
   multi-paper mode). Keep `Import PDF...` in the overflow menu.
5. Multi-paper mode: the title switcher is hidden when two or more papers are
   open (the panes' roles are meaningful there); RU-3.6 covers swapping.

6. **Single funnel (tab-readiness, cheap).** Route every UI entry point that
   opens a paper (library open, search result, annotation "open source", the
   switcher, resume on start) through one function
   `navigateToPaper(sourceId, opts?)` in the app layer instead of calling
   `wb.openSource` at each site (7 non-test call sites at `9b91ce3`). Behaviour
   is unchanged now; it is the single seam where tabs would later plug in
   (Appendix A).

**Tests:** Playwright: Files tab from reader returns to Library; title popover
lists recents, filters by typed text ("Rotated" finds "Rotated Fixture"),
Enter opens it and the previous paper appears in Recent; "All papers" returns
to Library; Esc closes; no `switch-paper` select exists in the DOM.

### RU-3.5 Settings store and dialog (new; user request 2026-11-16)

The user wants an Advanced settings area and expects a settings revamp. This
item is the **minimum foundation**, not the whole revamp (see Q6).

**Facts [read]:** the gear (`SettingsMenu` in `App.tsx`) is a menu of Configure
Sync, Publish, Refresh, Backup, Restore, Mobile. There is no preferences store;
`localStorage` is not used by application code.

**Design:**
1. `src/app/settings.ts`: a typed, versioned, **device-local** store
   (`localStorage` key `ito.settings.v1`, try/catch on every access, in-memory
   implementation for tests, defaults merged over stored values, unknown keys
   dropped, values validated). Local-only for the same reason as D3: these are
   per-device preferences and must not enter the synced payload.
2. Initial settings:
   - `find.ignoreAccents: boolean`, default `true` (RU-2.1, D7).
   - `reader.restoreLastSession: boolean`, default `true` (RU-3.1, D10).
   - `reader.defaultPageWidth: "comfortable" | "fit"`, default `"comfortable"`
     (RU-5.3).
3. **A screen, not a dropdown or a flat dialog (D16).** "Settings..." (top of
   the gear menu) opens a settings screen laid out for growth: a left
   section list and a content pane, large enough for long sections (a
   full-height modal or a dedicated view; match `BackupExportModal.tsx` only
   for the open/close mechanics). Sections come from a **declarative
   registry**, `SETTINGS_SECTIONS: Array<{ id; title; order; render }>` in
   `src/app/settings/sections.tsx`, so adding a section later is one registry
   entry plus one component, with no change to the shell. A row primitive
   (`SettingRow`: label, description, control, optional "requires reload"
   badge) keeps sections uniform. Initial sections: **General**
   (`reader.restoreLastSession`), **Reader** (`reader.defaultPageWidth`),
   **Advanced** (`find.ignoreAccents`). Reserved, not built here: Sync,
   Backup & Restore, Appearance. Each control writes through the store
   immediately and takes effect without reload where feasible; a "Reset
   section" action per section. Deep-linkable: `openSettings("advanced")`.
4. Do **not** move Sync/Backup/Restore/Mobile into the screen in this item
   (user, 2026-11-16: "for now only what I said"). The structure above exists
   so that moving them later is additive.
5. React access via a small `useSetting(key)` hook backed by
   `useSyncExternalStore` so SourcePane and the find code see changes live.

**Tests:** unit: defaults; corrupt JSON; storage throwing; unknown key
dropped; invalid value falls back to default. Playwright: toggle accent folding
off, then "cafe" no longer matches "caf\u00e9" (use a fixture containing an
accented word; add one to `scripts/gen-fixtures.mjs` if none exists); settings
persist across reload.

### RU-3.6 "Swap this paper" in multi-paper mode (F16; user decision D12)

**Context:** "Open together" exists for editing a link between nodes (user,
2026-11-16). Changing one pane to a different paper is rare, so it should be
hidden, not a persistent control.

**Evidence [read]:** two controls do this today, and one is wrong:
- `SourcePane.tsx`: a `<select data-testid="switch-paper">` in the pane header
  (listing unopened sources; calls `wb.switchReaderPane(sourceId, to)`).
- `Reader.tsx` `onSwitchPaper` (toolbar overflow "Switch paper..."): swaps the
  **first** open source for `switchable[0]`, the first unopened source in
  library order, with **no choice offered**. It is a silent swap to an arbitrary
  paper. **UNVERIFIED**: also check what the page context menu's
  `onPageAction("switch")` (`AnnotationMenus.tsx`, testid `ctx-switch-paper`)
  does.

**Design:**
1. Remove the persistent `switch-paper` `<select>` and the overflow item.
2. In the page right-click menu (`AnnotationMenus.tsx`, `ctx-switch-paper`),
   relabel to "Swap this paper..." and show it **only when two or more papers
   are open**. It opens a small picker (a `Popover`, RU-1.1) with the RU-5.1a
   search field and the list of unopened papers; choosing one calls
   `wb.switchReaderPane(<the right-clicked pane's sourceId>, chosen)`. It must
   target the pane that was right-clicked, not `openSourceIds[0]`.
3. Single-paper mode: the item is not shown (RU-3.4's title switcher covers
   it).
4. Preserve the invariants the existing e2e asserts: the other pane and the
   open Subject page are untouched.

**Tests:** update `e2e/workspace.spec.ts` (the block around "Switch paper..."
that selects an option from `switch-paper`) to right-click a pane, choose "Swap
this paper...", pick a paper, and assert the same invariants; update
`reader.feat002.render.test.ts` (expects `ctx-switch-paper`; keep the testid,
update the label expectation and add the "hidden with one paper" case).

Phase 3 exit: F6, F8, F11, F15, F16 fixmes are real tests; full e2e suite green.

---

## 8. Phases 4 and 5

### Phase 4: area annotation drag (F4)

**Verified [read]:** `SourcePane.tsx` `onAreaPointerMove` and
`onAreaPointerUp` take the start page (`areaDragRef.current.pageIndex`) and
compute `nx = (clientX - box.left) / box.width`,
`ny = (clientY - box.top) / box.height` against **that page's stage box, with
no clamping to `[0,1]`**. A drag that continues into the next page therefore
yields a rect with `y + height > 1`, which is drawn across the page gap and
cropped from outside the page.

**[run]:** dragging from page 7 into page 8 produced an area on page 7 drawn
over the grey gap, and the sidebar card for it showed a tall blank preview.
**UNVERIFIED:** I also saw a small "Area"-labelled box on page 8 near the
heading. In the same script I had just created a note on page 8 with the note
tool, so that box may be the note marker, not a second area. RU-4.1 step 0
settles this.

**RU-4.1 Reproduce separately (step 0, mandatory).** Two Playwright cases:
(a) note tool click on page 8 alone: record what the marker looks like and its
label; (b) area drag from page 7 across the boundary alone: count annotations
created and their pages. Write down the result in section 11. If (a) shows the
marker is labelled "Area", that is a separate labelling bug to fix under this
phase.

**RU-4.2 Clamp and harden the drag.**
- Clamp `nx`, `ny` to `[0,1]` in both `onAreaPointerMove` and
  `onAreaPointerUp`.
- Use `setPointerCapture` on `pointerdown` so the drag ends correctly even if
  the pointer leaves the pane or window; handle `pointercancel`.
- `Esc` during a drag cancels it (clears `areaDrag` and `areaDragRef`).
- The live rubber-band rect is drawn on the start page only.

**RU-4.3 Blank sidebar preview.** After 4.2, re-test. If the preview is still
blank, inspect `commitAreaFromDrag` (the crop that produces
`anchor.imageDataUrl`) and the sidebar card's image; likely cause is a crop
region partly outside the page producing an empty canvas or a not-yet-rendered
page. Fix the cause; do not add a placeholder that hides it.

**Tests (flip F4):** Playwright: drag from page 7 into page 8 yields exactly
one area annotation, on page 7, with `y + height <= 1` and `x + width <= 1`;
its sidebar thumbnail has non-trivial pixel variance (draw the `<img>` to a
canvas and check that not all pixels are equal); `Esc` mid-drag creates
nothing. Unit test for the clamp helper if extracted.

### Phase 5: smaller polish

**RU-5.1 Paper search (F7), decided: A now, B after (D13).** Re-checked
2026-11-16 **[run]**: searching the title "Rotated" in the top box returns 0
results of any kind: `wb.search` does not index source titles. Verified by
reading: `Workbench.buildSearchIndex` (`workbench.ts`) builds `docs` (pages),
`categories` and `annotations` only; `src/network/search.ts` defines
`SearchResult` as page | category | annotation. The seam is clean and pure.

- **RU-5.1a Shared source search (build first; RU-3.4 and RU-3.6 depend on
  it).** In `src/network/search.ts` add `SearchSource { sourceId; title;
  authors; year }` and a pure `searchSources(query, sources, limit?)`:
  case-insensitive, accent-folded (same normaliser as find where practical),
  token-AND match over title, authors and year, ranked title-prefix >
  title-word > authors > year, stable order on ties. Unit tests in
  `src/network/search.test.ts` (existing search tests live in
  `src/app/workbench.search.test.ts`; do not break them).
- **RU-5.1b Library filter (option A).** Filter input above the library table
  (`data-testid="library-filter"`, `Library.tsx`), using `searchSources`; local
  state; clears with Esc; shows "No papers match" empty state; works together
  with the existing column sort and selection (selection must not silently
  retain hidden rows for "Open together"/"Delete selected": either clear
  hidden selections or label the counts; decide and record).
- **RU-5.1c Global search returns papers (option B).** Add a `"source"` variant
  to `SearchResult` and index sources in `buildSearchIndex`; in
  `NetworkSearch.tsx` render a "Paper" kind label and, on select, call
  `wb.openSource(id)` (the annotation branch already does). The union change
  makes `NetworkSearch`'s `kind` branches and any exhaustive switches fail the
  typecheck: fix every one. Estimate 0.5 to 1 day; ~0.25 to 0.5 day for 5.1a
  and 5.1b together. Note `buildSearchIndex` rebuilds the whole index (including
  `pageBodyText`) on every keystroke; measure with ~500 papers and ~5000
  annotations and cache the index keyed by a data revision if > ~50 ms.

**RU-5.2 Sidebar order (F9).** `AnnotationSidebar.tsx` builds `views` by
flat-mapping `annotationsForSource` over `openSourceIds` and renders them in
that order. Add a derived sort: source order, then page (`annotationPage`),
then vertical position of the first rect, then `createdAt`. A small toggle
"Page order / Newest" (default page order). Because the sort is derived from
data each render and edits to comments do not change the sort key, cards do
not jump while typing. **UNVERIFIED:** the model's rect and range scope shapes
(area, range scopes spanning pages); read the types and handle every scope
kind.

**RU-5.3 Comfortable page width (F12), design question first (Q2).** The
stage must remain 1:1 with its canvas: `editor.css` forbids `max-width` on
`.pdf-page-stage` because it causes horizontal highlight drift. So the cap
must be applied by limiting the fitted **scale** in the fit computation
(`setFitScale` in `SourcePane.tsx`), not by CSS. Proposed: default on open =
`min(fit-to-pane, comfortable width)` centred; the explicit **Fit width**
button still fills the pane. This needs a notion of zoom mode (fit-comfortable
vs fit-width vs manual). Decided (D9, D14): cap = **960 CSS px** of page
width, `reader.defaultPageWidth` setting (RU-3.5) switches the open-time
default between "comfortable" and "fit". Re-verify 960 against a real
Letter/A4 paper at 1440x900 and 1920x1080 before finalising; adjust and record
in the deviation log if it reads badly.

**RU-5.4 Empty states (F13).** One sentence plus one action each:
Nodes (`NodesCanvas`, currently "No concept nodes yet"): "Create a Subject or
Category to start mapping ideas." with the existing `+ Subject` action
emphasised; History and Captures likewise (Captures currently "No captures
awaiting review."): explain how items arrive (mobile capture / import).
Copy is a proposal; keep it short.

**RU-5.5 Console noise (F14).** Add `<link rel="icon" href="data:,">` or a
real favicon to `index.html` so the `favicon.ico` 404 stops polluting test
console logs.

---

## 9. Parked (explicitly not now)

- **Phone layout (F2).** Out of scope by decision (D1). Known issues, for the
  future: reader toolbar controls clip off-screen at 390 px, header clips
  "Subjects (0)", tap targets are 30x30 (swatches 18x18), and a
  user-visible banner says "see docs/MILESTONE-MATRIX.md". The only
  recommended drive-by is rewording that banner when convenient.
- **Not exercised by the audit, schedule as RU-6 after Phase 3:** cross-page
  text selection (my script was flawed, result unknown); multi-paper "Open
  together" and "Switch paper"; rotated pages; keyboard-only and a11y flows;
  real-world PDFs (scanned, figure-heavy, very long) versus the clean synthetic
  fixtures; Koofr sync paths; Nodes, History and Captures beyond their empty
  states. RU-6 = repeat the audit on 5 to 10 real papers and write the
  findings into this file as new `F` entries.

---

- **BL-1 Deleted papers (trash).** User wants deleted papers in a "Deleted
  papers" tab. **[read]** today `Workbench.deleteSource` is a **hard delete**:
  it deletes the PDF binary first, then removes the source, its annotations and
  its subject associations from the data model, and detaches captures. There is
  no `deletedAt`, no recoverable state. A trash therefore means: a soft-delete
  flag on `Source` (a change to the synced data model, with schema-version
  migration and sync/tombstone semantics for Koofr), keeping the PDF binary
  and annotations until "Empty trash", a Deleted view, Restore, and
  "Delete permanently". This is a feature with data-model risk, not a polish
  item: write its own ADR before building. Until then, "Recent" in RU-3.4
  simply never lists deleted papers, which is already true because the source
  no longer exists.

## 10. Progress tracker

Update in the same commit as the work. Status: `todo` / `doing` / `done` /
`dropped (reason)`.

| Item | Finding | Status | Commit | Notes |
|---|---|---|---|---|
| RU-0.1 e2e baseline | | todo | | record counts here |
| RU-0.2 Playwright browser env | | todo | | |
| RU-0.3 CI path filter | | todo | | check required-check status first |
| RU-0.4 Tracker spec | | todo | | |
| RU-1.1 placeSurface | F3 | todo | | |
| RU-1.2 useDismiss | F5 | todo | | |
| RU-1.3 Toolbar layout | F3 | todo | | |
| RU-1.4 Kind labels | F10 | todo | | |
| RU-2.1 Matcher | F1 | todo | | |
| RU-2.2 Doc index | F1 | todo | | measure large PDF |
| RU-2.3 Navigation | F1 | todo | | spike span mapping first |
| RU-2.4 Contract kept | F1 | todo | | |
| RU-3.1 Reading position | F8 | todo | | |
| RU-3.2 Sync badge | F6 | todo | | |
| RU-3.3 No seed | F11 | todo | | run whole e2e |
| RU-3.4 Library navigation + title switcher | F15 | todo | | depends on RU-5.1a, RU-3.1 |
| RU-3.5 Settings store + dialog | | todo | | before RU-2.1 finishes (accent flag) or stub flag |
| RU-3.6 Swap this paper (right-click) | F16 | todo | | update workspace.spec.ts |
| RU-4.1 Repro | F4 | todo | | |
| RU-4.2 Clamp drag | F4 | todo | | |
| RU-4.3 Blank preview | F4 | todo | | |
| RU-5.1a searchSources | F7 | todo | | pure fn; build before RU-3.4 |
| RU-5.1b Library filter | F7 | todo | | |
| RU-5.1c Global search incl. papers | F7 | todo | | |
| RU-5.2 Sidebar order | F9 | todo | | |
| RU-5.3 Page width | F12 | todo | | cap 960, setting in RU-3.5 |
| RU-5.4 Empty states | F13 | todo | | |
| RU-5.5 Favicon | F14 | todo | | |
| RU-6 Second audit | | todo | | after Phase 3 |

Baseline numbers (fill in at RU-0.1): e2e passed ___ / failed ___ / skipped
___ in ___ s. Vitest at `9b91ce3`: 1024 passed in about 47 s.

## 11. Decision log, open questions, deviations

### Decisions
- **D1** Phone layout is out of scope (user, 2026-11-16).
- **D2** Session restore covers only the reader (open source, page, offset,
  zoom). Not view mode, not multi-paper workspaces.
- **D3** Reading position is local-only (`localStorage`), never in the synced
  payload.
- **D4** `clampFixedAnchor` is frozen; new placement logic lives in
  `placeSurface`.
- **D5** Popover outside-click stays on `mouseup` (blur-autosave ordering).
- **D6** Find indexes the whole document lazily on first use from pdf.js text
  content, not from `pageTexts` or `cachedPages`.
- **D7** (revised 2026-11-16, user) Diacritics ARE folded in find by default,
  with an Advanced setting to disable (RU-3.5, `find.ignoreAccents`).
- **D8** Fixture seeding becomes a build-time flag with dynamic imports.
- **D9** (user, 2026-11-16) RU-5.3: yes, cap the default page width; the "Fit width" button still fills the pane. Cap value still to be chosen (proposed 900 to 1000 CSS px).

- **D10** (user) Reload auto-resumes the last paper (position and zoom),
  unless the user left via the Library; togglable via `reader.restoreLastSession`.
- **D11** (user) The user's "menu" means the Library (Files view).
- **D12** (user) "Open together" stays; it is for editing a link between
  nodes. Swapping a pane's paper is rare and lives only in the right-click menu
  as "Swap this paper..." (RU-3.6); no persistent control.
- **D13** (user, "go with recommendations") Paper search: filter first
  (RU-5.1b), global search including papers after (RU-5.1c), both on a shared
  pure `searchSources` (RU-5.1a).
- **D14** Default page-width cap 960 CSS px (recommendation accepted).
- **D15** (recommendation accepted) Reader navigation: working Files tab,
  labelled back control, and a title-click paper switcher (RU-3.4).

- **D16** (user) Settings is a screen designed to grow (section list + registry),
  not a dropdown. Only the three initial settings are in scope now.
- **D17** (user) "Recent papers" excludes deleted papers. Deleted papers
  belong in a future "Deleted papers" tab (BL-1); today deletion is a hard
  delete (see section 9).

### Open questions (answer before the dependent item)
- **Q6, Q7** ANSWERED (D16, D17).
- **Q8 (Appendix A)** Does the user want multi-tab started now? Assessment is
  in Appendix A; no decision yet. Phase 0 to 2 are unaffected either way.
- **Q9 (Appendix B.1)** Adopt the unified "documents -> tabs -> layout" model
  (Open together stops being its own category; opening a connector opens its
  tabs in a layout)? Direction proposed by the user 2026-11-16 and assessed
  favourably in Appendix B. If yes: D2 and D12 are superseded and RU-3.6 is
  dropped. Also needs an answer to: does the connector workspace open the two
  *papers*, the two *endpoint pages*, or both (Appendix B.1)?

### Deviation log
(Empty. Append `date, item, what changed, why` here when reality differs from
this plan.)


---

## Appendix A: assessment of starting multi-tab (Zotero-style) now vs later

Requested by the user 2026-11-16 ("how hard would it be to introduce the start
of multi-tab functionality"). This is an **assessment, not a commitment**
(Q8). Estimates are mine and unmeasured; treat as +-40 %.

### A.1 Facts about the current architecture [read]
- The shell picks the Files-view body from one number: if
  `state.openSourceIds.length === 0` it renders the Library, else the Reader
  (`App.tsx`). That is why the "Files" tab cannot leave the reader (F15), and
  why there is no notion of "a paper open in the background".
- `Workbench.openSourceIds` is a private in-memory list with replace
  semantics (`openSource` sets `[id]`; `openTogether` sets many;
  `ensureSourceOpen` appends; `closeWorkspace` clears). It doubles as the
  "workspace": 1 source = reader, 2+ = Open together, plus an optional open
  Subject page. References at `9b91ce3`: `openSourceIds` 57 non-test source
  references and 16 test files; `.openSource(` 7; `openTogether(` 4;
  `switchReaderPane(` 7; `window.__ito.openSourceIds` used by 10 e2e lines.
- `SourcePane` owns the pdf.js document (`docRef`), the page DOM,
  virtualisation observers and per-pane UI state, all keyed by `sourceId`;
  switching sources tears it down and rebuilds. The primary pane registers its
  zoom/page/find commands into a single `paneCommandsRef` in `Reader`, which the
  single toolbar drives.
- `Reader` owns tool, colour, selection and sidebar state for one workspace.

### A.2 Recommended shape of a tab MVP
1. **Tab kinds.** `library` (pinned, first, not closable) and `paper`
   (one source). The existing multi-paper/subject workspace is NOT split
   into tabs: it remains one tab of a third kind, `workspace`, rendered by the
   unchanged `Reader` path. Rationale: Zotero has no equivalent of "Open
   together to edit a link between nodes" (D12), so forcing it into
   one-paper-per-tab would destroy its meaning.
2. **State lives above the workbench.** A small `ReaderTabs` store in the app
   layer (local-only, persisted next to the RU-3.1 session store, never in the
   synced payload) holds `{ tabs: [{ id, kind, sourceId? }], activeId }`. The
   active tab is *projected* into the workbench by calling the existing
   `wb.openSource`/`wb.closeWorkspace`. The workbench's single-workspace
   invariants and its 57 references stay untouched. This is the point of the
   RU-3.4 "single funnel".
3. **Inactive tabs are unmounted, not hidden.** Keeping several `SourcePane`s
   mounted with `display:none` would break measurement-driven code (fit-scale
   `ResizeObserver`s, `IntersectionObserver` virtualisation, text-layer
   geometry) and hold several PDFs' canvases in memory. Instead persist each
   tab's `{page, pageOffset, zoom}` (RU-3.1 already builds exactly this) and
   restore on activation. M17's `cachedPages` text-layer hydration was built for
   fast reopen. **UNVERIFIED:** actual reopen latency on a 50-page and a
   300-page paper; measure in the first spike. If it is > ~400 ms, add a small
   LRU of warm documents (keep the `PDFDocumentProxy`, not the DOM).
4. **State split.** Global across tabs (like Zotero): active tool, active
   colour, annotations-sidebar open/closed. Per tab: page, zoom, left-sidebar
   state, selected annotation, find query.
5. **Tab strip placement.** Do not add a fourth stacked bar (M9 complained about
   exactly this). Put the strip in the reader toolbar row, replacing
   `reader-title` and the `back-to-library` icon: the Library tab *is* the way
   back, and the paper title lives on its tab. The top-level Files/Nodes/
   History/Captures switch stays as is; switching to Nodes and back preserves
   tabs because they live above view mode.
6. **Behaviour.** Open from Library = new tab (or focus if already open;
   Ctrl/middle-click forces new tab, plain click in a paper tab's switcher
   replaces nothing). Close: `x`, middle-click, `Ctrl/Cmd+W`; closing the active
   tab activates its neighbour; closing the last returns to Library.
   `Ctrl+Tab`/`Ctrl+Shift+Tab` and `Ctrl+1..9`. Overflow: horizontal scroll with
   fade + a tab-list menu. Roles: `tablist`/`tab`/`tabpanel`, roving tabindex.
   Persist and restore tabs on reload (RU-3.1 "auto-resume" becomes "restore
   tabs"). Drag-reorder and tab groups: later.
7. **What it supersedes.** RU-3.4's title-click switcher becomes unnecessary
   (tabs + Library tab); keep its "Files tab works" and its search field idea
   as a quick-switcher (`Ctrl+K`) later. RU-3.6 "Swap this paper" is unchanged
   (it concerns the workspace tab).

### A.3 Effort for the MVP (library + paper tabs, workspace untouched)
| Piece | Days |
|---|---|
| `ReaderTabs` store, persistence, projection to workbench, `navigateToPaper` funnel | 1 to 1.5 |
| Tab strip UI, a11y, keyboard shortcuts, overflow | 1.5 to 2 |
| Shell integration: Library as pinned tab, Files-tab semantics, search/annotation "open source" entry points, resume | 1 to 1.5 |
| Interplay with Open together, Subject pages, Nodes "dive" and source-return (`ensureSourceOpen`) | 1 to 2 (the main uncertainty) |
| Tests: new tab specs; rework of specs asserting `openSourceIds` length; manual pass | 1 to 1.5 |
| **Total** | **about 5 to 8 working days** |

Main risks: (a) the N06 effect in `App.tsx` that iterates "every currently open
source" for subject association (what does "open" mean when a source is open in
a background tab? decide: only the active tab's sources); (b) source-return
adding a source "alongside" the subject must not create a stray tab; (c)
mobile mode (`mobileMode && openSourceIds.length === 1`) assumes the old model;
out of scope but must not break; (d) the 10 e2e lines using
`__ito.openSourceIds()`.

### A.4 Now vs later
- **Cost of waiting rises**, but slowly: every new feature that reads
  `openSourceIds` adds a migration site, and RU-3.1/3.4/3.6 all edit the same
  open/switch/session code. Building tabs *after* those would mean rewriting
  them.
- **Therefore the sequence that wastes least:** Phases 0 to 2 (independent of
  navigation) -> decide Q8 -> if yes, build tabs as the navigation layer and
  fold RU-3.1 (session store, per-tab position), RU-3.4 (Files tab, funnel) and
  RU-3.6 into it; if no, proceed with RU-3.x as written. The RU-3.4 funnel and
  the RU-3.1 per-source position store are tab-ready either way at near-zero
  extra cost.
- **Not recommended:** starting tabs before Phase 1. The popover/menu
  foundation is needed by the tab overflow menu and context menus anyway.


---

## Appendix B: architecture review (2026-11-16)

Written after the user proposed dissolving "Open together" into tabs. Scope:
(1) is that better for the architecture, (2) contradictions inside this plan,
(3) decisions to make now to avoid rework, (4) efficiency risks now and later.
Facts are **[read]** unless marked.

### B.1 Dissolving "Open together": yes, with one correction to the idea

**What the code does today.** One structure carries three ideas:
`Workbench.openSourceIds` (a replace-only list) plus a single
`openSubjectPageId`, rendered by `Reader` as a row of "pane slots"
(`paneSlots`: sources and the subject editor), with `PassageEvidenceLines`
drawn between the panes. "Open together" is just *how the list got >1 entry*.
There is already a half-tab concept in the code: below
`WORKSPACE_3PANE_MIN_WIDTH` (1360 px) Paper B is hidden and offered as a "1-click
quick-swap tab".

**The correction.** Tabs alone cannot replace the workspace, because the
workspace's value is *co-visibility*: evidence lines, quote-insert, "write
while reading" need the papers and the page on screen at once, and a
background tab is unmounted (Appendix A, point 3). So split the concept in two:

- **Documents and tabs**: what is open (paper, website, page).
- **Layout**: which tabs are visible side by side, in which slots, and which
  slot has focus.

"Open together" then disappears as a category: it becomes "open these tabs and
apply a 2- or 3-slot layout". Single-paper reading is a layout of one. The
existing responsive collapse (3 slots -> 2 slots + background tab) is the same
rule expressed as layout, not a special case. Keep the layout **a row of 1 to 3
slots plus presets**; do not build nested splits or arbitrary docking (YAGNI).

**Check against the data model, because it changes what "2 tabs" means.**
A connecting hub (`Relationship`, ADR-0008) joins *pages* (nodes), N >= 2, and
may own an explanatory `Page` (`explanatoryPageId`). Papers enter only through
the evidence/quotes inside those pages. So a connector workspace is
properly: **endpoint page A, connector page, endpoint page B**, with their cited
papers reachable beside them, not literally "two papers". Today's layout is
Paper A | subject page | Paper B; for connector editing the more useful
default is probably *page A | connector page | page B* with a "show cited
sources" affordance. That is a product decision (Q9); the architecture
supports either once page-kind tabs exist.

**What is currently in the way (real work, not free):**
1. **Single "primary" pane.** Only `slot.sourceId === openSourceIds[0]`
   registers zoom/page/find commands and nav state with the toolbar, and find's
   `Ctrl+F` handler is gated by `isPrimary`. In today's 3-pane layout Paper B has
   no working toolbar zoom/page/find. A layout needs a **focused slot**
   concept that the toolbar, find, sidebar and shortcuts target. This is the
   largest prerequisite and it fixes an existing limitation.
2. **One open page.** `openSubjectPageId` is a single value, `openSubjectPage`
   replaces, and `PassageEvidenceLines`, `followSource` / `returnTarget` and the
   N06 subject-association effect (`App.tsx`) assume exactly one subject.
   Connector editing needs several pages open: make it a list, and define
   pairing rules (evidence lines are drawn from the *focused page* to the
   visible source panes only).
3. **Page-kind tabs.** A tab for a Page (subject, note, connector page). The
   `SubjectEditor` is already a pane component, so this is mostly state and
   chrome.
4. **Source-return** (follow a quote into a source) must become: activate the
   tab if open, else open it in the focused-adjacent slot or as a background
   tab; never replace the page the user is writing.

**Effort on top of the tab MVP in Appendix A (rough, +-40 %):** focused-slot
refactor 1 to 1.5 days; multi-page open + pairing/N06/source-return 2 to 3;
connector-open command, layout presets and "visible slots" marking in the tab
strip 1.5 to 2; rework `workspace.spec.ts` and friends 1 to 2. About **5 to 8
days**, so the full tabs-plus-layout effort is about **10 to 16 days** in total.
Staging: ship the tab MVP first (library + paper tabs, workspace path
untouched), then migrate the workspace onto layout; each stage is shippable.

**Verdict:** better for the architecture *if* adopted as documents -> tabs ->
layout. It removes a special-case category, fixes the primary-pane limitation,
and matches the already-present quick-swap-tab idea. Worse if done as "tabs
only": it would lose evidence lines and write-while-reading.

### B.2 Contradictions and conflicts inside this plan

1. **D12 / RU-3.6 vs Q9.** If the unified model is adopted, "Open together" is
   not a persistent category and "Swap this paper" is just "pick a different
   tab for this slot". RU-3.6 becomes redundant; drop it then.
2. **D2 vs Q9.** D2 says session restore excludes multi-paper workspaces. Under
   the unified model the restored state is `{tabs, activeId, layout}`.
3. **RU-3.4's title-click switcher vs Appendix A.** If tabs are built, the
   switcher is mostly superseded. Already conditional on Q8; just do not start
   Phase 3 before Q8/Q9 are answered.
4. **RU-2.2 caches the find index "in a ref".** With tabs, `SourcePane`
   unmounts on every tab switch, so a component-local ref throws the index away.
   Change: cache at module level (LRU keyed by source content hash), owned by a
   document service (B.3.1). Edit RU-2.2 accordingly when implementing.
5. **RU-3.1's session store shape.** `{lastSourceId, perSource}` would need a
   v2 migration for tabs. Cheap fix now: version 1 should already be
   `{ tabs: [{id, kind, ref}], activeId, layout, perDoc: {...} }`, with the
   single-paper case being one tab and a layout of one. Zero extra UI cost.
6. **Two sources of truth.** After the tab store exists (Appendix A.2),
   `Workbench.openSourceIds` / `openSubjectPageId` remain and are read by
   `NodesView`, `testApi`, the N06 effect and mobile mode. Rule: the tab/layout
   store is the **only writer**; the workbench fields are a derived projection
   set through one function. Anything writing them elsewhere is a bug. Add a
   test that greps/forbids new direct writes outside that function.
7. **Q7 / D17 and BL-1.** Consistent (recents show only existing sources); but
   once a Deleted view exists, tabs open on a paper that is then deleted must
   close or show a tombstone. Specify when BL-1 is designed.
8. **Settings (RU-3.5) vs RU-3.1/5.3.** `reader.defaultPageWidth` interacts with
   per-paper saved zoom: saved zoom wins when present; the default applies only
   to papers with no saved position. State this rule in RU-3.1/RU-5.3.

### B.3 Architectural decisions worth making now (candidate ADRs)

1. **A PDF document service.** Today each `SourcePane` reads the bytes and calls
   `loadDocument(bytes)` itself (`SourcePane.tsx`), the left sidebar borrows the
   doc through `paneCommandsRef.getDoc()`, and RU-2 would add a third consumer
   (text index). Introduce one service: `getDocument(sourceId)` returns a
   ref-counted `PDFDocumentProxy` from a small LRU, plus the text-content cache
   and find index. Benefits: tab switches do not re-parse, thumbnails/outline/
   find/panes share one document, memory is bounded. Do this **before** RU-2.2
   and before tabs; it is the cheapest high-leverage step in this document.
2. **Persistence rule for local data.** Three mechanisms already coexist (synced
   brain via `StorageAdapter`; local IndexedDB stores such as
   `pdfAnalysisStore`; and, after this plan, `localStorage` for settings and
   session). Write the rule down: *synced, durable user content* -> adapter;
   *large or structured local caches* -> IndexedDB; *small per-device
   preferences and navigation state* -> `localStorage` behind typed stores with
   defaults and try/catch. Multi-window caveat: two browser windows of the app
   share `localStorage` and would overwrite each other's session; either scope
   the session key per window (`sessionStorage` id) or listen to `storage`
   events. Decide before RU-3.1.
3. **Navigation is not workbench state.** Keep tabs/layout in the app layer
   (Appendix A.2); keep `workbench.ts` (5.7k lines) from growing further. Put
   the new code under `src/app/nav/` with its own tests.
4. **Focused-slot as a first-class concept** (B.1 item 1), not a flag on slot 0.

### B.4 Efficiency risks (measure before optimising; none are verified)

- **Global re-render.** `useWorkbench` exposes `bump()`, which refreshes a state
  snapshot and re-renders the whole `App`; there is no `React.memo` anywhere in
  `src/app`. `Reader` calls `setNav` from the primary pane on scroll/zoom, which
  re-renders the reader tree including panes and sidebars. With 3 visible slots
  plus an editor this is the likely first jank source. Measure with the React
  profiler on the 12-page fixture and a 300-page paper before and after the
  layout work; if needed, memoise `SourcePane`/`SubjectEditor` and throttle
  `setNav`.
- **`AnnotationSidebar`** recomputes `views` with `wb.rawData()` in its memo deps;
  `rawData()` returns the live object, so the memo's dependency changes on any
  data mutation. Fine today; revisit at thousands of annotations.
- **`buildSearchIndex`** rebuilds docs, categories and annotations on every
  keystroke (RU-5.1c notes it; measure, then cache by data revision).
- **Per-open PDF cost.** Each reader open reads bytes and parses the PDF again;
  M17's `cachedPages` makes the text layer instant but canvas render still
  repeats. The document service (B.3.1) and, if needed, a warm-document LRU
  address this. Measure reopen latency first (Appendix A.2 item 3).
- **Find on very large PDFs**: indexing is lazy and chunked (RU-2.2) but runs on
  the main thread; a Web Worker is the later option, not now.
- **Storage growth**: `Source.cachedPages` and `pageTexts` are stored on the
  source record, i.e. inside the synced brain payload that is rewritten on save.
  Large papers inflate every save and every Koofr publish. **UNVERIFIED** size
  in practice; measure a 300-page paper's `cachedPages` JSON. If large, move to
  the IndexedDB analysis store (which was designed for this, see
  `pdfAnalysisStore.ts` header) before sync work depends on it.
