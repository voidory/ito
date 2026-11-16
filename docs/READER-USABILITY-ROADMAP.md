# Reader & app usability roadmap

> **Binding detail lives in `docs/READER-USABILITY-IMPLEMENTATION-PLAN.md`.**
> This file is the short overview only. Where they differ, the implementation
> plan wins (for example: the shared `Popover` primitive is already in use; the
> real defect is its vertical placement, see plan RU-1.1).

Source: the usability audit of 2026-11-16 (headless Chromium, 1440x900, 12-page
two-column fixture). Phone layout is out of scope for now (see "Parked").
LaTeX extraction work is paused; nothing here touches `src/science/`.

## Principles

- One theme per phase, one PR per phase (or per item where noted), so a
  regression is easy to bisect.
- Every fix lands with a regression test: a jsdom render test where the
  behaviour is DOM-only, a Playwright spec where it depends on layout, canvas
  or scroll (jsdom cannot see those).
- No phase widens the data model. Items 4, 8 touch persisted state and are
  marked.

## Phase 0 - Baseline and guard rails (half a day)

Do this before changing behaviour, so later phases can be judged.

- Run the full Playwright suite once on `main` and record pass/fail and
  duration here. If any spec is already red, fix or quarantine it first and
  say so in the PR.
- Add `paths:` filters to `.github/workflows/latex-benchmark.yml`
  (`src/science/**`, `src/pdf/tex*`, the benchmark scripts) so reader PRs do
  not pay for the 30-minute LaTeX benchmark. Note: `m17-playtest.yml` also
  runs on every push; check whether it needs the same.
- Turn the audit scripts into one committed e2e spec,
  `e2e/reader-usability.spec.ts`. It starts with the *current* failures
  written as `test.fixme(...)` and each phase flips its own to a real
  `test(...)`. This is the progress tracker.

Exit: baseline numbers recorded, CI path filter merged, spec skeleton merged.

## Phase 1 - Popover and menu foundation (items 3, 5, 10)  ~2-3 days

Why first: it is the most visible defect, and items 3 and 5 share one root
cause (popovers and menus are not on a common, viewport-aware primitive).
`src/app/ui/primitives.tsx` already exists and ADR-0014 specified a `Popover`
that portals, flips, clamps and closes on outside click / `Esc`. Check
whether it is used by the reader popovers or only declared.

1. **Popover primitive.** Make it (or confirm it already) portal to a fixed
   layer, flip above/below, clamp to the viewport, and close on outside
   pointerdown and `Esc`. Unit-test the placement maths as a pure function.
2. **Migrate, in this order:** highlight edit popover
   (`AnnotationMenus.tsx`), selection toolbar, Subjects launcher
   (`App.tsx:432`), settings menu, reader context menu. The Subjects launcher
   and settings menu fix item 5 for free.
3. **Selection toolbar placement.** Place it *beside or below* the selection
   end, not over the line above. Fix the close button overlapping the pink
   swatch. Decide: keep the close button at all? `Esc` and clicking away
   already dismiss.
4. **Wording (item 10).** "Delete highlight" becomes kind-aware (highlight /
   underline / note / area). One helper, used by both menus.

Tests: Playwright, highlight a line near the bottom of the viewport and
assert the popover's bounding box is inside the viewport (this is today's
failure); `Esc` and outside-click close the Subjects menu; only one menu open
at a time.

Exit: no popover can render outside the viewport; the two `fixme`s for items
3 and 5 are real tests.

## Phase 2 - Find (item 1)  ~3-4 days

Independent of Phase 1; can run in parallel if two people are working.

Current behaviour (`SourcePane.tsx:1300`): scans mounted text layers only,
per `<span>`. Fails for unrendered pages and for phrases that cross spans.

Design:
1. Build a per-source search index from pdf.js text content for *all* pages,
   once, in the background after open. `model/types.ts:221` and `pdfImport.ts`
   already note a cached `textShingles` / text set, so first check whether the
   page text is already persisted and reuse it rather than re-running
   `getTextContent()`.
2. Match on normalised page text (case-fold, collapse whitespace and
   hyphenation at line breaks), return `{page, startOffset, endOffset}`.
3. Navigate: scroll to the page, wait for its text layer to mount, then
   highlight the character range (not whole spans) with a `Range`-based
   overlay. Count = occurrences, not spans.
4. UX: show "n / total" immediately with a "indexing..." state for the first
   second on a large PDF; debounce typing; `Enter` / `Shift+Enter` cycle;
   `Esc` closes and clears marks.

Risks: large PDFs (index memory and time; measure on a 300-page paper before
committing to eager indexing, else index lazily by chunk); RTL / ligature
text (normalise with NFKC and accept misses).

Tests: unit tests for the matcher (cross-span, cross-line, hyphen, case);
Playwright: search "Page 9" from page 1 finds 1 hit and scrolls to page 9;
count equals true occurrence count on the 12-page fixture.

Exit: find works on every page regardless of what is rendered.

## Phase 3 - Reader state and first-run cleanliness (items 8, 6, 11)  ~2 days

Small items, grouped because they all concern "what the user sees on
launch".

- **8. Restore reading position.** Persist `{sourceId, page, zoomMode/zoom}`
  per source (and which source was open last). *Persisted state:* put it in
  the local adapter under a new key, not in the shared/synced model, or sync
  will propagate a scroll position between devices. Restore on reload; fall
  back to the Library if the source no longer exists. Throttle writes
  (on scroll end, not per frame).
- **6. "Stale" badge.** Render nothing, or "Local only", when no remote is
  configured. Show "Stale" only when a remote exists. Tooltip must say what is
  stale and what to do. This is a one-component change in `SyncBanner.tsx`.
- **11. Fixture seeding.** `App.tsx:121` seeds three test PDFs on first run.
  Gate behind `import.meta.env.DEV` or an explicit `?seed=fixtures` /
  `localStorage` flag. Many e2e specs probably depend on the seed, so give
  the test harness the flag first and run the whole suite before and after.
  Replace the empty Library with a proper empty state ("Import a PDF or drop
  one here").

Exit: reload returns you to the same page of the same paper; a fresh install
shows no test data and no meaningless badge.

## Phase 4 - Area annotation edge cases (item 4)  ~1-2 days

Root cause is visible in `SourcePane.tsx:1006-1040`: the drag records the
start page, but the end point can leave that page.

- Clamp the pointer to the start page's stage during the drag (Zotero-style),
  and render the live rectangle clipped to that stage.
- Verify the saved rect is in the start page's normalised 0..1 space, and
  that no secondary annotation is created on the page the pointer left into.
- Fix the blank sidebar preview: find out whether the thumbnail is blank
  because the clipped rect had zero area on the rendered page, or because the
  crop is lazily rendered and never triggered.

Tests: Playwright, drag from page 7 into page 8, assert exactly one area, on
page 7, within bounds; sidebar preview has non-zero pixels.

## Phase 5 - Smaller polish (items 7, 9, 12, 13)  as capacity allows

Each independent; do not let them block a release.

- **7. Library search.** Decide the semantics first (this is a product
  decision, not a bug): either the global box also filters the library table
  when the Files view is active, or add a table filter above the list. The
  second is less surprising; the global box stays "search everything".
- **9. Sidebar order.** Sort by page then y position (with a toggle for
  "creation order"). Make sure the sort is stable and does not move cards
  under the cursor mid-edit: re-sort only on add/remove, not on every
  keystroke.
- **12. Page width.** Cap the fit-width page at a comfortable max (about
  900-1000 CSS px) and centre it. Check that overlays and the thumbnail rail
  still align.
- **13. Empty states.** One sentence and one button each for Nodes, History
  and Captures.

## Parked (decided not now)

- **Phone layout (audit item 2).** Not a priority, and phone use implies
  different functionality. One cheap exception worth doing whenever convenient:
  replace the user-visible "Narrow screen... see docs/MILESTONE-MATRIX.md"
  banner with plain wording, since it currently leaks a developer doc path.
- Cross-page text selection, multi-paper "Open together", rotated pages,
  keyboard-only / a11y paths and real-world (non-fixture) PDFs were not
  exercised by the audit. Schedule a second audit after Phase 3 against 5-10
  real papers, including a scan and a figure-heavy one.

## Order and dependencies

```
Phase 0 -> Phase 1 -> Phase 3 -> Phase 4 -> Phase 5
              \-> Phase 2 (parallel, independent)
```

Phase 3 depends on Phase 1 only in that the Library empty state reuses the
shared button/menu styling; it can start earlier if needed.

## Rough effort

About 9-12 working days of focused work in total. The estimate is the main
uncertainty: Phase 2 (find) depends on whether page text is already cached,
and Phase 3's seed removal depends on how many e2e specs rely on the fixtures.

## Update 2026-11-16

Scope grew after the audit review; see the implementation plan for details:
Phase 3 now also holds navigation (RU-3.4), a settings store and dialog
(RU-3.5) and the multi-paper swap change (RU-3.6); paper search (RU-5.1a) is
built early because RU-3.4 and RU-3.6 depend on it; find folds accents by
default with an Advanced setting.
