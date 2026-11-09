import { useMemo, useState } from "react";
import type { AnnotationId, SourceId } from "../../model";
import {
  HIGHLIGHT_COLORS,
  type AnnotationView,
  type HighlightColor,
  type Workbench,
} from "../workbench";
import { AssociationMenu, ShowInNodes, styles, swatch, type MenuState } from "./AnnotationOverlays";

/**
 * M9 (FEAT-002 1) the reader right-panel: an ANNOTATIONS-ONLY, collapsible
 * list of cards. Each card shows a colour bar, its page number, the quoted text
 * (2-line clamp), an editable comment, an area thumbnail where present, and an
 * overflow menu carrying the SAME actions as the annotation popover (Insert
 * quote into Subject, Show in Nodes, Delete highlight only, Delete highlight &
 * quotes).
 *
 * Filters are user-facing (no more "all / range / micro" jargon): colour chips,
 * a free-text search, and a "This page / All" scope toggle. Clicking a card
 * scrolls the reader to that page, flashes the highlight, and selects it via
 * {@link onSelectAnnotation}.
 */

/** The 1-based page number an annotation lives on (first page for a range). */
function annotationPage(view: AnnotationView): number {
  const scope = view.annotation.scope;
  if (scope.kind === "text" || scope.kind === "area") return scope.anchor.pageIndex + 1;
  return scope.anchor.startPageIndex + 1;
}

/** The quoted/selected text of an annotation (empty for a pure area capture). */
function annotationQuote(view: AnnotationView): string {
  const scope = view.annotation.scope;
  if (scope.kind === "text") return scope.anchor.selectedText;
  if (view.isRange) return view.rangeLabel ?? "";
  return "";
}

export function AnnotationSidebar({
  wb,
  openSourceIds,
  bump,
  currentPage,
  selectedAnnotationId,
  onSelectAnnotation,
}: {
  wb: Workbench;
  openSourceIds: readonly SourceId[];
  bump: () => void;
  /** 1-based current page of the primary pane (drives the "This page" filter). */
  currentPage?: number;
  /** The currently selected annotation (highlighted card). */
  selectedAnnotationId?: AnnotationId | null;
  /** Scroll the reader to the annotation's page, flash it, and select it. */
  onSelectAnnotation?: (annotationId: AnnotationId, pageNumber: number) => void;
}): JSX.Element {
  const [colorFilter, setColorFilter] = useState<HighlightColor | "all">("all");
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<"all" | "page">("all");
  const [menuFor, setMenuFor] = useState<MenuState | null>(null);

  const views = useMemo(
    () => openSourceIds.flatMap((id) => wb.annotationsForSource(id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wb, openSourceIds, wb.rawData()],
  );

  const needle = search.trim().toLowerCase();
  const filtered = views.filter((v) => {
    if (colorFilter !== "all" && v.style.color !== colorFilter) return false;
    if (scope === "page" && currentPage != null && annotationPage(v) !== currentPage)
      return false;
    if (needle) {
      const hay = `${annotationQuote(v)} ${v.annotation.comment ?? ""}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  return (
    <aside
      data-testid="highlights-tab"
      aria-label="Annotations"
      className="ito-annotation-sidebar"
      style={styles.sidebar}
    >
      <h3 className="ito-annotation-sidebar-title">Annotations</h3>

      <div data-testid="highlights-filter" className="ito-annotation-filters">
        {/* Colour chips (R-colour). "All" clears the colour filter. */}
        <div className="ito-annotation-color-chips" role="group" aria-label="Filter by colour">
          <button
            type="button"
            data-testid="filter-color-all"
            aria-pressed={colorFilter === "all"}
            className="ito-annotation-chip"
            data-selected={colorFilter === "all" ? "true" : undefined}
            onClick={() => setColorFilter("all")}
          >
            All
          </button>
          {HIGHLIGHT_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              data-testid={`filter-color-${c}`}
              aria-label={`Filter ${c}`}
              aria-pressed={colorFilter === c}
              className="ito-color-dot"
              data-selected={colorFilter === c ? "true" : undefined}
              style={{ background: swatch(c) }}
              onClick={() => setColorFilter((cur) => (cur === c ? "all" : c))}
            />
          ))}
        </div>

        {/* Free-text search over the quote + comment. */}
        <input
          data-testid="annotation-search"
          className="ito-annotation-search"
          type="search"
          placeholder="Search annotations…"
          aria-label="Search annotations"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        {/* Scope toggle: this page vs all. */}
        <div className="ito-annotation-scope" role="group" aria-label="Annotation scope">
          <button
            type="button"
            data-testid="filter-scope-all"
            aria-pressed={scope === "all"}
            data-selected={scope === "all" ? "true" : undefined}
            onClick={() => setScope("all")}
          >
            All pages
          </button>
          <button
            type="button"
            data-testid="filter-scope-page"
            aria-pressed={scope === "page"}
            data-selected={scope === "page" ? "true" : undefined}
            disabled={currentPage == null}
            onClick={() => setScope("page")}
          >
            This page
          </button>
        </div>
      </div>

      <ul className="ito-annotation-list">
        {filtered.map((v) => (
          <AnnotationCard
            key={v.annotation.id}
            wb={wb}
            view={v}
            bump={bump}
            selected={selectedAnnotationId === v.annotation.id}
            onSelect={() => onSelectAnnotation?.(v.annotation.id, annotationPage(v))}
            onMenu={(x, y) =>
              setMenuFor({
                annotationId: v.annotation.id,
                sourceId: v.annotation.sourceId,
                x,
                y,
              })
            }
          />
        ))}
        {filtered.length === 0 && (
          <li data-testid="highlights-empty" className="ito-annotation-empty">
            No annotations
          </li>
        )}
      </ul>
      {menuFor && (
        <AssociationMenu wb={wb} menu={menuFor} onClose={() => setMenuFor(null)} bump={bump} />
      )}
    </aside>
  );
}

function AnnotationCard({
  wb,
  view,
  bump,
  selected,
  onSelect,
  onMenu,
}: {
  wb: Workbench;
  view: AnnotationView;
  bump: () => void;
  selected: boolean;
  onSelect: () => void;
  onMenu: (x: number, y: number) => void;
}): JSX.Element {
  const [comment, setComment] = useState(view.annotation.comment ?? "");
  const page = annotationPage(view);
  const quote = annotationQuote(view);
  const imageDataUrl =
    view.annotation.scope.kind === "area" ? view.annotation.scope.anchor.imageDataUrl : undefined;

  const saveComment = async (): Promise<void> => {
    if (comment === (view.annotation.comment ?? "")) return;
    await wb.setComment(view.annotation.id, comment);
    bump();
  };

  return (
    <li
      data-testid="highlight-row"
      data-annotation-id={view.annotation.id}
      data-range={view.isRange ? "true" : "false"}
      data-selected={selected ? "true" : undefined}
      className="ito-annotation-card"
      aria-current={selected ? "true" : undefined}
    >
      {/* The colour bar reflects the annotation style colour. */}
      <span
        className="ito-annotation-color-bar"
        data-testid="annotation-color-bar"
        style={{ background: swatch(view.style.color) }}
        aria-hidden="true"
      />
      <div className="ito-annotation-card-body">
        <div className="ito-annotation-card-head">
          <button
            type="button"
            data-testid="annotation-goto"
            className="ito-annotation-page"
            onClick={onSelect}
            title="Scroll to this annotation"
          >
            p. {page}
          </button>
          {view.isRange && (
            <span data-testid="range-badge" className="ito-annotation-range-badge">
              {view.rangeLabel ?? "range"}
            </span>
          )}
          {view.references.some((r) => r.status === "tentative") && (
            <span data-testid="dotted-indicator" title="Tentative association">
              ┄
            </span>
          )}
          {view.references.some((r) => r.status === "cited") && (
            <span data-testid="solid-indicator" title="Cited">
              ━
            </span>
          )}
          <span className="ito-annotation-card-spacer" />
          <ShowInNodes wb={wb} annotationId={view.annotation.id} bump={bump} />
          <button
            data-testid="row-actions"
            aria-haspopup="menu"
            aria-label="Annotation actions"
            className="ito-annotation-actions"
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              onMenu(r.left, r.bottom);
            }}
          >
            ⋯
          </button>
        </div>

        {imageDataUrl && (
          <img
            data-testid="area-figure-preview"
            src={imageDataUrl}
            alt="Captured figure"
            className="ito-annotation-thumb"
          />
        )}

        {quote && (
          <button
            type="button"
            data-testid="annotation-quote"
            className="ito-annotation-quote"
            onClick={onSelect}
            title={quote}
          >
            {quote}
          </button>
        )}

        <textarea
          data-testid="annotation-comment"
          className="ito-annotation-comment"
          placeholder="Add a comment…"
          value={comment}
          aria-label="Annotation comment"
          onChange={(e) => setComment(e.target.value)}
          onBlur={() => void saveComment()}
        />
      </div>
    </li>
  );
}
