# HANDOFF: ITO — ZOTERO-STYLE READER REWORK (M9)

Repo: `/projects/sandbox/ito`. Branch: create `m9-reader-rework` from `origin/m8-real-browser-ux-overhaul` (tip `7f22b51`). Baseline: `npx vitest run --no-file-parallelism` = 483 pass; `npm run typecheck`, `npm run build`, `npx playwright test --list` (71 tests) all clean. Verify before starting.

## 0. Rules (credit + sandbox)

1. **Max 3 `FEAT-XXX` units**, in order: FEAT-001 (foundations + chrome), FEAT-002 (annotation interaction), FEAT-003 (sidebars + polish). Do not add more.
2. **Behaviour must not change** in FEAT-001. It is a refactor plus restyle. Existing unit tests must still pass.
3. **`data-testid` renames ARE allowed.** Update the e2e specs and unit tests in the same commit. Do not keep dead controls just to preserve old ids.
4. **Do not touch** storage, sync, workbench data model, Subject editor, Nodes canvas, History, Captures, 3D. Only reader/UI files and CSS.
5. Run the live UI with `bash scripts/run-local-shot.sh` in ONE bash call (no background servers across calls, no Playwright MCP, no `npx playwright install`). The browser path is hardcoded in the script; read it from `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`, and make the script exit non-zero with a clear message if the binary is missing.
6. Use `src/test/fixtures/*.pdf` plus a generated 12-page two-column PDF with an embedded raster figure (extend `scripts/gen-fixtures.mjs`) for visual checks. Tiny one-page fixtures hide layout problems.
7. Keep `.agents` review passes to at most 2 per FEAT.

## 1. Product decisions (already made, do not re-litigate)

- **Right panel holds annotations only.** No Subject editor in the reader. Subject authoring lives in the Nodes/Subject views. "Insert quote into Subject" and "Show in Nodes" stay as actions in the annotation menu.
- **Tool-first interaction (Zotero model).** The user picks a tool (Highlight / Underline / Note / Area), then acts on the page. With no tool active, selecting text shows a small popup (colours + Highlight / Underline) as a fallback. The active tool persists until toggled off or `Esc`.
- Reader is a **single-document** view by default. Multi-paper "Open together" may remain as a split of two single-document viewers, each with its own toolbar. Drop the workspace-pane/evidence-lines layout from the reader's default path (keep code behind the split mode only if removing it breaks tests; otherwise delete).

## 2. Findings from live testing (what is wrong today)

1. Three stacked toolbars above the page (~125px): app header, reader bar, pane row. Sync/Backup/Restore/Mobile/Configure Sync sit above the document.
2. A second "+ Import PDF" sits in the reader bar.
3. After creating a highlight the selection toolbar stays on screen; clicking the highlight then opens the comment popover over it. They overlap and hide text.
4. Popovers, context menu and comment box render in the browser default serif font; context menu is a stack of centred outlined buttons.
5. Page is left of centre with dead gutters, has a "- Page 1" label, no fit-width, no page navigation, no find.
6. Highlights drawer: truncated text ("Sample Documen"), no colour/page/comment preview, filter names "all / range / micro" are meaningless to users.
7. `src/app/Reader.tsx` is 3,310 lines with ~50 inline `style={{}}` blocks; popovers, menus, toolbars all in one file.

## FEAT-001: Foundations + chrome

**A. Split `Reader.tsx`** into `src/app/reader/`: `Reader.tsx` (shell/state), `ReaderToolbar.tsx`, `PageCanvas.tsx`, `SelectionPopup.tsx`, `AnnotationPopover.tsx`, `ContextMenu.tsx`, `AnnotationSidebar.tsx`. Move logic as-is; no behaviour change. Keep `Reader.tsx` re-export so imports don't break.

**B. Small UI kit** `src/app/ui/`: `Button`, `IconButton` (aria-label + tooltip required), `Menu` (keyboard nav, icons, shortcut column), `Popover` (portaled to a fixed layer, z-index token, auto-flip, clamp to viewport, closes on outside click/`Esc`). CSS tokens in `theme.css` (font family inherited by ALL buttons/inputs/textarea — fix the serif bug globally with `button,input,textarea,select{font:inherit}`). Replace inline styles in reader files with classes. Target: zero `style={{` in `src/app/reader/` except dynamic positions.

**C. One reader toolbar** (height ≤ 44px), replacing the three bars:
`[☰ sidebar toggle] [← Library] | title (ellipsis) | [Highlight][Underline][Note][Area] | [−] [100%] [+] [Fit width] | [‹] [page n / N] [›] | [🔍 Find] | [⋯]`
- Icons (inline SVG), tooltips, `aria-pressed` on tool toggles.
- Zoom keeps the existing non-passive Ctrl/Cmd+wheel handler; add Fit width (default on open) and Fit page.
- Page input: type a number + Enter scrolls to the page; current page tracked via IntersectionObserver (not scroll-bump re-renders).
- Find: `Ctrl/Cmd+F` opens an inline find bar using pdf.js text search; highlight matches in the text layer; Enter/Shift+Enter next/prev.
- `⋯` menu holds: Suppress motion, Show source lines, Switch paper, Import PDF.
- Remove the duplicate "+ Import PDF" from the reader bar.

**D. App header while reading:** collapse to a ≤36px strip with view tabs and one **settings (⚙) menu** containing Configure Sync, Publish, Refresh, Backup, Restore, Mobile. Apply the same settings menu in Library/Nodes (one header design everywhere). Subjects launcher and search stay.

**E. Page canvas:** pages centred, fit-width by default, 12px gap, soft shadow, no "- Page N" caption (page number lives in the toolbar).

**Acceptance:** page top ≤ 48px below the toolbar; page centred at 1024/1280/1440 widths; vitest/typecheck/build green; screenshots of Library and Reader at 3 widths attached to the task notes.

## FEAT-002: Tool-first annotation interaction

1. **Tool state** in `Reader`: `activeTool: null | "highlight" | "underline" | "note" | "area"`, plus `activeColor`. Keyboard: `1–4` colours, `H`/`U`/`N`/`A` tools (ignore when typing in an input), `Esc` clears tool and any popover.
2. **Highlight/Underline tool active:** on pointer-up with a non-collapsed selection inside the originating page, create the annotation immediately with `activeColor` (no popup). Keep m8's page-locked selection (`user-select:none` on other pages) and anchor filtering.
3. **No tool active:** selecting text shows ONE small popup (colour dots + Highlight + Underline). It closes after any action, on `Esc`, or when the selection collapses. It must never coexist with the annotation popover.
4. **Note tool:** click a page point → creates a note annotation with an inline comment field open. (Reuse the existing annotation type if one exists; else store as a point annotation with `kind:"note"` via a small, tested model addition.)
5. **Area tool:** crosshair, drag a rubber-band box (m8's cropper logic stays). Tool stays active until toggled off. The previous "Mark area"/hardcoded-rectangle code path must be gone.
6. **Annotation popover (click an existing highlight):** single `Popover` anchored at the click/highlight rect, containing: comment textarea (autosaves on blur), colour dots, Highlight/Underline toggle, `⋯` menu (Insert quote into Subject, Show in Nodes, Delete highlight only, Delete highlight & quotes). Selecting a different highlight resets the draft (keep m8's keyed-draft fix).
7. **Context menu** via `Menu`: on an annotation: Edit comment, colours, Insert quote into Subject, Show in Nodes, Delete…; on the page: Comment on page range, Select area, Find, Zoom fit width. Icons + shortcut column; no centred outlined buttons.
8. Keep m8's coordinate hit-testing (clicks on highlights while `.textLayer` is on top) and its fixed-position clamping rules; add a geometry test: selection popup, annotation popover and context menu never overlap each other and are fully inside the viewport.

**Acceptance:** e2e covers: pick Highlight tool → drag text → highlight exists, no popup; no tool → select → popup → Highlight; click highlight → popover, selection popup gone; area tool drag → figure thumbnail saved; `Esc` behaviour. All unit/e2e/typecheck/build green.

## FEAT-003: Annotation sidebar, thumbnails, Library polish

1. **Right panel = Annotations only** (collapsible, replaces the "Show highlights" drawer). Cards: colour bar, page number, quoted text (2-line clamp), editable comment, area thumbnail where present, `⋯` menu (same actions as popover). Filters: colour chips, text search, "this page / all". Click a card → scroll to page, flash the highlight, select it. Rename the old "all / range / micro" filters to user-facing labels or remove them if they have no user meaning.
2. **Left sidebar** (toggle with `☰`): tabs **Thumbnails** (lazy-render at ~120px via IntersectionObserver, current page outlined, click to jump) and **Outline** (pdf.js `getOutline`; hide the tab if none).
3. **Library** as a table: Title, Authors, Year, Pages, Annotations count, Date added; sortable headers; collection tree on the left (reuse existing categories). Keep Import PDF button + drag-drop. Keep "Open together" as a multi-select action.
4. **Nodes toolbar** restyled with the same `IconButton`/`Menu` components (no behaviour change).
5. Delete dead code paths and unused testids made obsolete by FEAT-001..003.

**Acceptance:** screenshots at 1024/1280/1440 for Library, Reader (with left+right panels open, a highlight selected and a popover open), Nodes; all tests green.

## Final verification (once, at the end)

- `npx vitest run --no-file-parallelism`, `npm run typecheck`, `npm run build`, `npx playwright test --list`.
- `bash scripts/run-local-shot.sh` in one call; look at the PNGs (library / reader / reader-with-popover / nodes), not only the JSON report. State in the PR description what you visually checked.
- Update `docs/` milestone matrix with M9, and write one ADR (`docs/decisions/`) recording: tool-first model, annotations-only right panel, UI kit introduction.
- Open a PR into `m8-real-browser-ux-overhaul`'s base or the repo's active integration branch (ask which if unclear; do not guess).
