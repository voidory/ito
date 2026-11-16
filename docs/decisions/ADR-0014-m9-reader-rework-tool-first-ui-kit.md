# ADR-0014: M9 reader rework — tool-first annotation model, annotations-only right panel, and the shared UI kit (primitives.tsx)

- Status: ACCEPTED (M9, FEAT-001 + FEAT-002)
- Spec references: the Zotero-style reader rework captured in
  `docs/archive/KIRO_HANDOFF_reader_rework.md` (reader chrome consolidation, tool-first
  annotation interaction, left/right sidebars, Library table, Nodes toolbar
  restyle) under the user's STRICT 2-FEAT plan.
- Relationship to prior ADRs: ADR-0006 established the range/annotation
  interaction surfaces and ADR-0012 the PDF stage/overlay geometry. This ADR
  reworks the INTERACTION layer on top of those primitives without changing the
  data model (`src/model/types.ts` and the storage schema are untouched) or the
  on-disk `SCHEMA_VERSION`. The Note tool reuses the existing
  `wb.commitAreaAnnotation` path rather than adding a new annotation kind.

## Context

The reader had accreted three stacked toolbars, a "Show highlights" drawer whose
filter chips (`all / range / micro`) exposed internal jargon, duplicated header
controls, and a serif-font bug in popovers/menus. Each annotation surface had
its own ad-hoc floating markup. The handoff asked for a Zotero-style, tool-first
reader with a single toolbar, dedicated left (navigation) and right
(annotation) sidebars, a sortable Library, and a consistent control kit.

## Decision

### 1. A shared UI kit in one file — `src/app/ui/primitives.tsx`

`Button`, `IconButton` (requires an `aria-label`, renders a title tooltip,
supports `aria-pressed`), `Menu` (arrow-key / Enter / Esc navigation, icon
gutter + shortcut column, never centred outlined buttons), and `Popover`
(portaled onto a fixed z-index layer, auto-flip + clamp-to-viewport via the
shared `clampFixedAnchor`, closes on Esc / outside click) all live in a single
file. Collapsing the kit into one module keeps the restyle a low-churn change
and gives the reader chrome, the app-header settings menu, the Nodes toolbar,
and the sidebars one consistent, accessible control surface. The global
`button,input,textarea,select{font:inherit}` rule in `theme.css` fixes the
serif regression kit-wide.

### 2. Tool-first annotation interaction

The reader shell owns `activeTool` (`null | highlight | underline | note |
area`) and `activeColor`. Keyboard: `1-4` pick colours, `H/U/N/A` pick tools
(ignored while typing), `Esc` clears the tool and any open popover.

- With a Highlight/Underline tool active, releasing a non-collapsed selection
  commits immediately with the active colour and NO popup.
- With no tool active, selecting text shows exactly ONE small selection popup
  (colour dots + Highlight + Underline). It never coexists with the annotation
  popover.
- The Note tool reuses `wb.commitAreaAnnotation(sourceId, pageIndex, [nx, ny,
  0.025, 0.025])` to drop a small pin and immediately opens the annotation
  popover focused on the comment input — NO model/schema change.
- The Area tool drags a rubber-band crop and persists an `imageDataUrl`
  thumbnail; it stays active until toggled off.

Clicking an existing highlight opens a single annotation popover (comment
textarea autosaving on blur, colour dots, Highlight/Underline toggle, and an
overflow menu: Insert quote into Subject, Show in Nodes, Delete highlight only,
Delete highlight & quotes).

### 3. Annotations-only right panel + navigation left sidebar

The right panel is now ANNOTATIONS ONLY and collapsible. Each card shows a
colour bar, page number, a 2-line-clamped quote, an editable comment, an area
thumbnail where present, and an overflow menu mirroring the popover actions.
Filters are user-facing: colour chips, a free-text search, and a
"This page / All" scope toggle — the meaningless `all / range / micro` labels
are gone. Clicking a card scrolls to the page, flashes the highlight overlay,
and selects it.

A separate left sidebar (its own toolbar toggle) carries two tabs built from the
kit: Thumbnails (lazily rendered ~120px via `IntersectionObserver`, current page
outlined, click to jump) and Outline (from pdf.js `getOutline`; the tab is
hidden entirely when the document has no outline).

### 4. Library as a sortable table + Nodes toolbar restyle

`Library.tsx` renders a sortable table (Title, Authors, Year, Pages,
Annotations, Date added) with a collection tree reusing the existing categories,
keeping Import PDF + drag-drop and the "Open together" multi-select. Authors /
Year are derived best-effort (the Source model is unchanged). The Nodes toolbar
is restyled with the shared `IconButton` / `Button` primitives with no
behaviour change.

## Consequences

- No `src/model` or storage-schema changes; existing brains load unchanged.
- `Reader.tsx` stays the shell + state owner and re-exports the moved symbols
  (`src/app/reader/*`) so existing imports, tests, and `testApi.ts` resolve
  unchanged.
- `data-testid` renames (and the new filter model) are reflected in the
  colocated render tests and the affected Playwright specs in the same change.
- A new committed fixture `src/test/fixtures/sample-12page-figure.pdf` (12-page
  two-column PDF with an embedded raster figure) exercises the figure thumbnail
  and the thumbnail/outline sidebar; the screenshot harness
  (`scripts/local-shot.mjs`) now captures library / reader / reader-with-popover
  / nodes at 1024/1280/1440 in a single pass.
