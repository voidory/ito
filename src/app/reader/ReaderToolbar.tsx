import { useState } from "react";
import { IconButton, Menu, type MenuItem } from "../ui/primitives";
import { HIGHLIGHT_COLORS, type HighlightColor } from "../workbench";
import { swatch } from "./AnnotationOverlays";

/** The tool-first annotation tools (handoff FEAT-002 1). */
export type ActiveTool = null | "highlight" | "underline" | "note" | "area";

/* Inline SVG icons (16x16, currentColor). Presentation only. */
const Icons = {
  sidebar: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
      <line x1="6" y1="2.5" x2="6" y2="13.5" />
    </svg>
  ),
  back: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M9.5 3.5 5 8l4.5 4.5" />
    </svg>
  ),
  highlight: (
    <svg viewBox="0 0 16 16" fill="currentColor">
      <rect x="2" y="7" width="12" height="4" rx="1" opacity="0.9" />
    </svg>
  ),
  underline: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4 3v4a4 4 0 0 0 8 0V3" />
      <line x1="3" y1="13.5" x2="13" y2="13.5" />
    </svg>
  ),
  note: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2.5 2.5h11v8l-3 3h-8z" />
      <path d="M10.5 13.5v-3h3" />
    </svg>
  ),
  area: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2 1.5">
      <rect x="2.5" y="2.5" width="11" height="11" rx="1" />
    </svg>
  ),
  minus: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <line x1="3" y1="8" x2="13" y2="8" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <line x1="3" y1="8" x2="13" y2="8" />
      <line x1="8" y1="3" x2="8" y2="13" />
    </svg>
  ),
  prev: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M9.5 3.5 5 8l4.5 4.5" />
    </svg>
  ),
  next: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M6.5 3.5 11 8l-4.5 4.5" />
    </svg>
  ),
  find: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="7" cy="7" r="4.5" />
      <line x1="10.5" y1="10.5" x2="14" y2="14" />
    </svg>
  ),
  overflow: (
    <svg viewBox="0 0 16 16" fill="currentColor">
      <circle cx="3" cy="8" r="1.3" />
      <circle cx="8" cy="8" r="1.3" />
      <circle cx="13" cy="8" r="1.3" />
    </svg>
  ),
};

const TOOLS: { tool: Exclude<ActiveTool, null>; label: string; key: string; icon: JSX.Element }[] = [
  { tool: "highlight", label: "Highlight (H)", key: "H", icon: Icons.highlight },
  { tool: "underline", label: "Underline (U)", key: "U", icon: Icons.underline },
  { tool: "note", label: "Note (N)", key: "N", icon: Icons.note },
  { tool: "area", label: "Area (A)", key: "A", icon: Icons.area },
];

/**
 * M9 (FEAT-001 C) the SINGLE reader toolbar (height <= 44px) that replaces the
 * three stacked bars. Layout:
 *   [sidebar] [Library] | title | [H][U][N][A] | [-][100%][+][Fit] | [<][n/N][>] | [Find] | [overflow]
 * Icon buttons carry tooltips and aria-pressed on the tool toggles. Zoom and
 * paging are driven by callbacks owned by the Reader shell.
 */
export function ReaderToolbar({
  title,
  sidebarOpen,
  onToggleSidebar,
  onBackToLibrary,
  activeTool,
  onToggleTool,
  activeColor,
  onSetColor,
  zoom,
  onZoomOut,
  onZoomIn,
  onResetZoom,
  onFitWidth,
  page,
  pageCount,
  onGoToPage,
  onPrevPage,
  onNextPage,
  onOpenFind,
  suppressMotion,
  linesVisible,
  onToggleMotion,
  onToggleLines,
  onSwitchPaper,
  onImportPdf,
}: {
  title: string;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onBackToLibrary: () => void;
  activeTool: ActiveTool;
  onToggleTool: (t: Exclude<ActiveTool, null>) => void;
  activeColor: HighlightColor;
  onSetColor: (c: HighlightColor) => void;
  zoom: number;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onResetZoom: () => void;
  onFitWidth: () => void;
  page: number;
  pageCount: number;
  onGoToPage: (pageNumber: number) => void;
  onPrevPage: () => void;
  onNextPage: () => void;
  onOpenFind: () => void;
  suppressMotion: boolean;
  linesVisible: boolean;
  onToggleMotion: () => void;
  onToggleLines: () => void;
  onSwitchPaper?: (() => void) | undefined;
  onImportPdf: () => void;
}): JSX.Element {
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [pageDraft, setPageDraft] = useState("");

  const overflowItems: MenuItem[] = [
    {
      id: "suppress-motion",
      label: suppressMotion ? "Show motion" : "Suppress motion",
      onSelect: onToggleMotion,
      testId: "overflow-suppress-motion",
    },
    {
      id: "toggle-lines",
      label: linesVisible ? "Hide source lines" : "Show source lines",
      onSelect: onToggleLines,
      testId: "overflow-toggle-lines",
    },
    ...(onSwitchPaper
      ? [{ id: "switch-paper", label: "Switch paper…", onSelect: onSwitchPaper, testId: "overflow-switch-paper" }]
      : []),
    { id: "import-pdf", label: "Import PDF…", onSelect: onImportPdf, testId: "overflow-import-pdf" },
  ];

  return (
    <header data-testid="reader-toolbar" className="ito-reader-toolbar" role="toolbar" aria-label="Reader toolbar">
      <IconButton
        label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
        data-testid="toggle-highlights-tab"
        aria-pressed={sidebarOpen}
        onClick={onToggleSidebar}
      >
        {Icons.sidebar}
      </IconButton>
      <IconButton label="Back to Library" data-testid="back-to-library" onClick={onBackToLibrary}>
        {Icons.back}
      </IconButton>

      <span className="ito-toolbar-sep" aria-hidden="true" />

      <span className="ito-toolbar-title" data-testid="reader-title" title={title}>
        {title}
      </span>

      <span className="ito-toolbar-sep" aria-hidden="true" />

      {/* Tool toggles. */}
      <span className="ito-toolbar-group" data-testid="reader-tools">
        {TOOLS.map((t) => (
          <IconButton
            key={t.tool}
            label={t.label}
            data-testid={`tool-${t.tool}`}
            pressed={activeTool === t.tool}
            onClick={() => onToggleTool(t.tool)}
          >
            {t.icon}
          </IconButton>
        ))}
        {/* Active colour dots (1-4). */}
        <span className="ito-toolbar-group" data-testid="tool-colors" role="group" aria-label="Annotation colour">
          {HIGHLIGHT_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              data-testid={`tool-color-${c}`}
              aria-label={`Colour ${c}`}
              aria-pressed={activeColor === c}
              className="ito-color-dot"
              data-selected={activeColor === c ? "true" : undefined}
              style={{ background: swatch(c) }}
              onClick={() => onSetColor(c)}
            />
          ))}
        </span>
      </span>

      <span className="ito-toolbar-sep" aria-hidden="true" />

      {/* Zoom controls. */}
      <span className="ito-toolbar-group" data-testid="zoom-controls">
        <IconButton label="Zoom out" data-testid="pdf-zoom-out" onClick={onZoomOut}>
          {Icons.minus}
        </IconButton>
        <button type="button" data-testid="pdf-zoom-reset" aria-label="Reset zoom" onClick={onResetZoom}>
          {Math.round(zoom * 100)}%
        </button>
        <IconButton label="Zoom in" data-testid="pdf-zoom-in" onClick={onZoomIn}>
          {Icons.plus}
        </IconButton>
        <button type="button" data-testid="fit-width" aria-label="Fit width" onClick={onFitWidth}>
          Fit width
        </button>
      </span>

      <span className="ito-toolbar-sep" aria-hidden="true" />

      {/* Page navigation. */}
      <span className="ito-toolbar-group" data-testid="page-nav">
        <IconButton
          label="Previous page"
          data-testid="prev-page"
          disabled={page <= 1}
          onClick={onPrevPage}
        >
          {Icons.prev}
        </IconButton>
        <form
          style={{ display: "inline-flex", alignItems: "center", gap: "2px" }}
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(pageDraft);
            if (Number.isFinite(n) && n >= 1 && n <= pageCount) onGoToPage(n);
            setPageDraft("");
          }}
        >
          <input
            data-testid="page-input"
            className="ito-page-input"
            aria-label="Go to page"
            inputMode="numeric"
            placeholder={String(page)}
            value={pageDraft}
            onChange={(e) => setPageDraft(e.target.value.replace(/[^0-9]/g, ""))}
          />
          <span data-testid="page-indicator" style={{ fontSize: "0.82rem", whiteSpace: "nowrap" }}>
            / {pageCount}
          </span>
        </form>
        <IconButton
          label="Next page"
          data-testid="next-page"
          disabled={page >= pageCount}
          onClick={onNextPage}
        >
          {Icons.next}
        </IconButton>
      </span>

      <span className="ito-toolbar-sep" aria-hidden="true" />

      <IconButton label="Find in document" data-testid="open-find" onClick={onOpenFind}>
        {Icons.find}
      </IconButton>

      <span style={{ position: "relative", display: "inline-flex" }}>
        <IconButton
          label="More actions"
          data-testid="pane-overflow-menu-btn"
          aria-haspopup="menu"
          aria-expanded={overflowOpen}
          onClick={() => setOverflowOpen((v) => !v)}
        >
          {Icons.overflow}
        </IconButton>
        {overflowOpen && (
          <div style={{ position: "absolute", top: "100%", right: 0, zIndex: 1004 }}>
            <Menu
              items={overflowItems}
              ariaLabel="Reader actions"
              testId="pane-overflow-menu"
              onClose={() => setOverflowOpen(false)}
            />
          </div>
        )}
      </span>
    </header>
  );
}
