# HANDOFF: ITO — ZOTERO-STYLE READER REWORK (M9)

Repo: `/projects/sandbox/ito`. Branch: create `m9-reader-rework` from `origin/m8-real-browser-ux-overhaul` (tip `7f22b51`, or latest commit on `m8-real-browser-ux-overhaul` after `git fetch origin`). Baseline: `npx vitest run --no-file-parallelism` = 482+ pass; `npm run typecheck`, `npm run build`, `npx playwright test --list` (71 tests) all clean. Verify before starting.

## 0. Rules (credit + sandbox)

1. **Max 3 `FEAT-XXX` units**, in order: FEAT-001 (foundations + chrome), FEAT-002 (annotation interaction), FEAT-003 (sidebars + polish + live visual verification). Do not add more.
2. **Existing workbench/annotation semantics must not regress** in FEAT-001. It is a modular split (`src/app/reader/` + `src/app/ui/`) plus toolbar/header consolidation. Update colocated render tests in the same commit when consolidating controls.
3. **`data-testid` renames ARE allowed.** Update the e2e specs (`e2e/*.spec.ts`) and unit/render tests in the same commit. Do not keep dead duplicate controls in the header just to preserve old ids.
4. **Do not touch** storage adapters, sync logic, Subject editor internals, Nodes canvas graph logic, History, Captures, or 3D. Keep changes scoped to reader/UI components (`src/app/`), `scripts/`, `e2e/`, `docs/`, and CSS.
5. **Sandbox Browser Rules (CRITICAL):**
   - NEVER use the Playwright MCP server (`KAS_MCP_OFFLOAD` Squid proxy blocks `127.0.0.1`), NEVER run background dev servers across separate `execute_bash` calls (`bwrap --unshare-pid` kills them), and NEVER run `npx playwright install` or full Chromium (`crashpad_handler` fails with `SIGTRAP`).
   - Run the live UI **once in FEAT-003** via `bash scripts/run-local-shot.sh` in ONE `execute_bash` call.
   - Update `scripts/local-shot.mjs` so `EXECUTABLE_PATH` defaults to the actual sandbox binary:
     `/inner_container/opt/playwright/chromium_headless_shell-1232/chrome-headless-shell-linux64/chrome-headless-shell`
     (overridable via `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`), and make the script exit non-zero with a clear message if the binary is missing.
6. Use `src/test/fixtures/*.pdf` plus a generated 12-page two-column PDF with an embedded raster figure (extend `scripts/gen-fixtures.mjs`) for visual checks. Tiny one-page fixtures hide layout problems.
7. Keep `.agents` semantic review passes to at most 1–2 at the end of the task.

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
7. `src/app/Reader.tsx` is ~2,600+ lines with ~50 inline `style={{}}` blocks; popovers, menus, toolbars all in one file.

## FEAT-001: Foundations + chrome

**A. Split `Reader.tsx`** into `src/app/reader/`: `Reader.tsx` (shell/state), `ReaderToolbar.tsx`, `PageCanvas.tsx`, `SelectionPopup.tsx`, `AnnotationPopover.tsx`, `ContextMenu.tsx`, `AnnotationSidebar.tsx`. keep `src/app/Reader.tsx` re-exporting all public symbols so existing imports don't break.

**B. Small UI kit** `src/app/ui/`: `Button`, `IconButton` (aria-label + tooltip required), `Menu` (keyboard nav, icons, shortcut column), `Popover` (portaled to a fixed layer, z-index token, auto-flip, clamp to viewport, closes on outside click/`Esc`). CSS tokens in `theme.css` (font family inherited by ALL buttons/inputs/textarea — fix the serif bug globally with `button,input,textarea,select{font:inherit}`). Replace inline styles in reader files with classes. Target: zero `style={{` in `src/app/reader/` except dynamic coordinates/dimensions.

**C. One reader toolbar** (height ≤ 44px), replacing the three stacked bars:
`[☰ sidebar toggle] [← Library] | title (ellipsis) | [Highlight][Underline][Note][Area] | [−] [100%] [+] [Fit width] | [‹] [page n / N] [›] | [🔍 Find] | [⋯]`
- Icons (inline SVG), tooltips, `aria-pressed` on tool toggles.
- Zoom keeps the existing non-passive Ctrl/Cmd+wheel handler and `serializedRerender` mutex; add Fit width (default on open) and Fit page.
- Page input: type a number + Enter scrolls to the page; current page tracked via IntersectionObserver (not scroll-bump re-renders).
- Find: `Ctrl/Cmd+F` opens an inline find bar searching page text layers; highlight matches; Enter/Shift+Enter next/prev.
- `⋯` menu holds: Suppress motion, Show source lines, Switch paper, Import PDF.
- Remove the duplicate "+ Import PDF" and duplicate inline action buttons from the reader bar.

**D. App header while reading:** collapse to a ≤36px strip with view tabs and one **settings (`⚙`) menu** containing Configure Sync, Publish, Refresh, Backup, Restore, Mobile. Apply the same settings menu in Library/Nodes (one header design everywhere). Subjects launcher and search stay.

**E. Page canvas:** pages centred, fit-width by default, 12px gap, soft shadow, no "- Page N" caption (page number lives in the toolbar).

**Acceptance:** Vitest unit/render tests, `npm run typecheck`, `npm run build`, and `npx playwright test --list` all green.

## FEAT-002: Tool-first annotation interaction

1. **Tool state** in `Reader`: `activeTool: null | "highlight" | "underline" | "note" | "area"`, plus `activeColor`. Keyboard: `1–4` colours, `H`/`U`/`N`/`A` tools (ignore when typing in an input/textarea), `Esc` clears tool and any popover.
2. **Highlight/Underline tool active:** on pointer-up with a non-collapsed selection inside the originating page, create the annotation immediately with `activeColor` (no popup) and clear the browser selection. Keep m8's page-locked selection (`user-select:none` on other pages) and anchor filtering.
3. **No tool active:** selecting text shows ONE small `SelectionPopup` (colour dots + Highlight + Underline). It closes immediately after any action, on `Esc`, or when the selection collapses. Opening `AnnotationPopover` or `ContextMenu` MUST close `SelectionPopup` (they must never coexist).
4. **Note tool:** click a page point → creates a point/pin note annotation (reuse `commitAreaAnnotation` with a small normalized pin rect `[nx, ny, 0.025, 0.025]` so storage/model types require zero breaking schema changes) and immediately opens `AnnotationPopover` with the comment field focused.
5. **Area tool:** crosshair, drag a rubber-band box (m8's cropper logic stays). Tool stays active until toggled off or `Esc`. Ensure any legacy hardcoded-rectangle "Mark area" path is completely removed.
6. **Annotation popover (click an existing highlight/area/note):** single `Popover` anchored at the click/highlight rect, containing: comment textarea (autosaves on blur + Save button), colour dots, Highlight/Underline toggle, area figure thumbnail (if present), and `⋯` menu (Insert quote into Subject, Associate with Subject, Show in Nodes, Delete highlight only, Delete highlight & quotes). Selecting a different highlight resets the draft.
7. **Context menu** via `Menu`: on an annotation: Edit comment, colours, Insert quote into Subject, Show in Nodes, Delete…; on the page: Comment on page range, Select area, Find, Zoom fit width. Icons + shortcut column; no centred outlined buttons.
8. Keep m8's coordinate hit-testing (clicks on highlights while `.textLayer` is on top) and its fixed-position clamping rules; add a geometry render test verifying that `SelectionPopup`, `AnnotationPopover`, and `ContextMenu` are mutually exclusive (never coexist) and clamp inside the viewport.

**Acceptance:** Render tests cover: pick Highlight tool → select text → highlight created immediately, no popup; no tool → select → popup → Highlight → popup closes; click highlight → popover opens & selection popup is closed; area tool drag → figure thumbnail saved; `Esc` clears active tool/popover. Update `e2e/*.spec.ts` for any renamed testids. All vitest/typecheck/build/`playwright --list` green.

## FEAT-003: Annotation sidebar, thumbnails, Library polish & live verification

1. **Right panel = Annotations only** (collapsible, replaces the old Highlights drawer). Cards: colour bar, page number, quoted text (2-line clamp), editable comment preview, area thumbnail where present, `⋯` menu (same actions as popover). Filters: colour chips, text search, "This page / All pages". Click a card → scroll to page, flash the highlight, select it. Replace old "all / range / micro" filter labels with clear user-facing labels.
2. **Left sidebar** (toggle with `☰`): tabs **Thumbnails** (lazy-render at ~120px via IntersectionObserver, current page outlined, click to jump) and **Outline** (pdf.js `getOutline`; hide/disable if none).
3. **Library** as a clean table: Title, Authors, Year, Pages, Annotations count, Date added; sortable headers; collection tree on the left (reuse existing categories). Keep Import PDF button + full-window drag-drop. Keep "Open together" as a multi-select action.
4. **Nodes toolbar** restyled with the same `IconButton`/`Menu` components (no behaviour change, preserve `nodes-create-*` testids).
5. Delete dead code paths made obsolete by FEAT-001..003.
6. **Live Headless-Shell Verification (single bash call):**
   - Extend `scripts/gen-fixtures.mjs` to generate a 12-page two-column PDF fixture with an embedded raster figure.
   - Update `scripts/local-shot.mjs` to use `/inner_container/opt/playwright/chromium_headless_shell-1232/chrome-headless-shell-linux64/chrome-headless-shell` and capture Library, Reader (at 1024, 1280, and 1440 widths with left+right sidebars open and an annotation popover open), and Nodes views, asserting in `ui-verification-report.json` that:
     - `button, input, textarea` computed `fontFamily` is sans-serif (not `serif` / `Times`),
     - page top is ≤ 90px from viewport top (combined app strip + reader toolbar ≤ 80px),
     - page stage is horizontally centred between the open sidebars,
     - no two floating surfaces (`SelectionPopup`, `AnnotationPopover`, `ContextMenu`) coexist.
   - Run `bash scripts/run-local-shot.sh` in ONE `execute_bash` call and inspect the resulting PNGs and JSON report.
   - Update `docs/` milestone matrix with M9, and write one ADR (`docs/decisions/`) recording: tool-first model, annotations-only right panel, UI kit introduction.

**Final Verification Gates:**
- `npx vitest run --no-file-parallelism`, `npm run typecheck`, `npm run build`, `npx playwright test --list`, and `bash scripts/run-local-shot.sh` all green with 0 errors.
- Push `m9-reader-rework` to `origin` and open a PR into `m8-real-browser-ux-overhaul` (or `main` if `m8` is already merged).
