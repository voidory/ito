import { useState } from "react";
import type { SourceId } from "../../model";
import { type AnnotationView, type Workbench } from "../workbench";
import { AssociationMenu, ShowInNodes, styles, type MenuState } from "./AnnotationOverlays";

/**
 * M9 (FEAT-001) the reader right-panel annotations list, relocated out of
 * Reader.tsx. Lists annotations, distinguishes range annotations from
 * micro-highlights, and provides the ACCESSIBLE (non right-click) path to the
 * association actions via a menu-button (R15). Behaviour and testids are
 * preserved from m8 so the e2e reader/subject specs keep resolving; the richer
 * annotation-card polish is handoff FEAT-003 (a later unit).
 */
export function AnnotationSidebar({
  wb,
  openSourceIds,
  bump,
}: {
  wb: Workbench;
  openSourceIds: readonly SourceId[];
  bump: () => void;
}): JSX.Element {
  const [filter, setFilter] = useState<"all" | "range" | "micro">("all");
  const [menuFor, setMenuFor] = useState<MenuState | null>(null);

  const views = openSourceIds.flatMap((id) => wb.annotationsForSource(id));
  const filtered = views.filter((v) =>
    filter === "all" ? true : filter === "range" ? v.isRange : !v.isRange,
  );

  return (
    <aside data-testid="highlights-tab" aria-label="Highlights" style={styles.sidebar}>
      <h3 style={{ marginTop: 0 }}>Highlights</h3>
      <div data-testid="highlights-filter" style={{ marginBottom: "0.5rem" }}>
        {(["all", "range", "micro"] as const).map((f) => (
          <button
            key={f}
            data-testid={`filter-${f}`}
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
          >
            {f}
          </button>
        ))}
      </div>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {filtered.map((v) => (
          <HighlightRow
            key={v.annotation.id}
            wb={wb}
            view={v}
            bump={bump}
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
          <li data-testid="highlights-empty" style={{ color: "#888" }}>
            No highlights
          </li>
        )}
      </ul>
      {menuFor && (
        <AssociationMenu wb={wb} menu={menuFor} onClose={() => setMenuFor(null)} bump={bump} />
      )}
    </aside>
  );
}

function HighlightRow({
  wb,
  view,
  bump,
  onMenu,
}: {
  wb: Workbench;
  view: AnnotationView;
  bump: () => void;
  onMenu: (x: number, y: number) => void;
}): JSX.Element {
  const label = view.isRange
    ? view.rangeLabel
    : view.annotation.scope.kind === "text"
      ? view.annotation.scope.anchor.selectedText.slice(0, 40)
      : "";
  return (
    <li
      data-testid="highlight-row"
      data-annotation-id={view.annotation.id}
      data-range={view.isRange ? "true" : "false"}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.4rem",
        padding: "0.3rem 0",
        borderBottom: "1px solid #eee",
      }}
    >
      {view.isRange && (
        <span data-testid="range-badge" style={styles.rangeBadge}>
          range
        </span>
      )}
      {view.annotation.scope.kind === "area" && view.annotation.scope.anchor.imageDataUrl && (
        <img
          data-testid="area-figure-preview"
          src={view.annotation.scope.anchor.imageDataUrl}
          alt="Captured figure"
          style={{ width: 40, height: 40, objectFit: "cover", borderRadius: "4px", border: "1px solid #ddd" }}
        />
      )}
      <span style={{ flex: 1, fontSize: "0.85rem" }}>{label}</span>
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
      <ShowInNodes wb={wb} annotationId={view.annotation.id} bump={bump} />
      <button
        data-testid="row-actions"
        aria-haspopup="menu"
        aria-label="Annotation actions"
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          onMenu(r.left, r.bottom);
        }}
      >
        ⋯
      </button>
    </li>
  );
}
