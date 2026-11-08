import { useCallback, useEffect, useRef, useState } from "react";
import {
  createAnchor,
  loadDocument,
  renderHighlightOverlay,
  renderPage,
  type RenderedPage,
} from "../pdf";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { AnnotationId, PageId, SourceId, TextAnchor } from "../model";
import {
  HIGHLIGHT_COLORS,
  type AnnotationStyle,
  type AnnotationView,
  type HighlightColor,
  type Workbench,
} from "./workbench";

/**
 * The reading workbench (spec section 6). Renders one or more open documents
 * with real selectable pdf.js text. When the highlights tab is closed the
 * reader is centred + expanded and the sidebar reserves ZERO width (R18).
 *
 * Selection exposes ONLY compact highlight/color controls — it never opens a
 * comment editor, node picker, category selector, or subject page (R01).
 */
export function Reader({
  wb,
  openSourceIds,
  suppressMotion,
  highlightsTabOpen,
  onToggleTab,
  onToggleMotion,
  onBackToLibrary,
  bump,
}: {
  wb: Workbench;
  openSourceIds: readonly SourceId[];
  suppressMotion: boolean;
  highlightsTabOpen: boolean;
  onToggleTab: (open: boolean) => void;
  onToggleMotion: (suppress: boolean) => void;
  onBackToLibrary: () => void;
  bump: () => void;
}): JSX.Element {
  const together = openSourceIds.length > 1;
  return (
    <div data-testid="reader" data-view="reader" style={styles.root}>
      <header style={styles.toolbar}>
        <button data-testid="back-to-library" onClick={onBackToLibrary}>
          ← Library
        </button>
        {together && (
          <span data-testid="open-together-indicator" style={{ color: "#555" }}>
            Shared workspace · no analysis
          </span>
        )}
        <span style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
          <label style={{ fontSize: "0.85rem", color: "#555" }}>
            <input
              type="checkbox"
              data-testid="suppress-motion"
              checked={suppressMotion}
              onChange={(e) => onToggleMotion(e.target.checked)}
            />{" "}
            Suppress motion
          </label>
          <button
            data-testid="toggle-highlights-tab"
            aria-pressed={highlightsTabOpen}
            onClick={() => onToggleTab(!highlightsTabOpen)}
          >
            {highlightsTabOpen ? "Hide highlights" : "Show highlights"}
          </button>
        </span>
      </header>

      <div
        data-testid="reader-body"
        data-tab-open={highlightsTabOpen ? "true" : "false"}
        style={styles.body}
      >
        <main
          data-testid="reader-main"
          data-together={together ? "true" : "false"}
          style={{
            ...styles.main,
            // Closed tab = centred + expanded reading column.
            maxWidth: highlightsTabOpen ? "none" : "60rem",
            margin: highlightsTabOpen ? "0" : "0 auto",
          }}
        >
          {openSourceIds.map((sourceId) => (
            <SourcePane
              key={sourceId}
              wb={wb}
              sourceId={sourceId}
              suppressMotion={suppressMotion}
              bump={bump}
            />
          ))}
        </main>

        {/* Closed tab reserves ZERO width: the aside is not rendered at all. */}
        {highlightsTabOpen && (
          <HighlightsTab wb={wb} openSourceIds={openSourceIds} bump={bump} />
        )}
      </div>
    </div>
  );
}

interface ToolbarState {
  readonly sourceId: SourceId;
  readonly anchor: TextAnchor;
  readonly x: number;
  readonly y: number;
}

interface MenuState {
  readonly annotationId: AnnotationId;
  readonly sourceId: SourceId;
  readonly x: number;
  readonly y: number;
}

function SourcePane({
  wb,
  sourceId,
  suppressMotion,
  bump,
}: {
  wb: Workbench;
  sourceId: SourceId;
  suppressMotion: boolean;
  bump: () => void;
}): JSX.Element {
  const mountRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<RenderedPage[]>([]);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const [ready, setReady] = useState(false);
  const [toolbar, setToolbar] = useState<ToolbarState | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [rangeMode, setRangeMode] = useState(false);
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(0);
  const [openComment, setOpenComment] = useState<AnnotationId | null>(null);

  const source = wb.rawData().sources.find((s) => s.id === sourceId);

  const redrawOverlays = useCallback(() => {
    const views = wb.annotationsForSource(sourceId);
    for (const page of pagesRef.current) {
      page.textLayer
        .querySelectorAll(".ito-highlight")
        .forEach((el) => el.remove());
    }
    for (const view of views) {
      drawAnnotation(view, pagesRef.current, suppressMotion, false);
    }
  }, [wb, sourceId, suppressMotion]);

  // Render the document pages once.
  useEffect(() => {
    let cancelled = false;
    const mount = mountRef.current;
    if (!mount) return;
    (async () => {
      const bytes = await wb.readSourceBytes(sourceId);
      if (!bytes || cancelled) return;
      const doc = await loadDocument(bytes);
      docRef.current = doc;
      mount.replaceChildren();
      const pages: RenderedPage[] = [];
      for (let p = 1; p <= doc.numPages; p++) {
        const rp = await renderPage(doc, p, mount, 1.3);
        rp.container.dataset.pageIndex = String(p - 1);
        pages.push(rp);
      }
      if (cancelled) return;
      pagesRef.current = pages;
      setRangeEnd(doc.numPages - 1);
      setReady(true);
    })().catch((err) => console.error("render failed", err));
    return () => {
      cancelled = true;
    };
  }, [wb, sourceId]);

  // Draw overlays whenever annotations change / pages become ready.
  useEffect(() => {
    if (ready) redrawOverlays();
  }, [ready, redrawOverlays]);

  // Capture a text selection inside this pane's text layers → portable anchor.
  const onMouseUp = useCallback(() => {
    if (rangeMode) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setToolbar(null);
      return;
    }
    const range = selection.getRangeAt(0);
    // Find which rendered page contains the selection.
    const page = pagesRef.current.find((p) =>
      p.textLayer.contains(range.commonAncestorContainer),
    );
    if (!page || !source) {
      setToolbar(null);
      return;
    }
    const pageIndex = Number(page.container.dataset.pageIndex ?? "0");
    try {
      const anchor = createAnchor({
        docId: sourceId,
        sourceVersionHash: source.versionHash,
        pageIndex,
        selection,
        pageBox: page.pageBox(),
        pageText: page.pageText,
      });
      const rect = range.getBoundingClientRect();
      setToolbar({ sourceId, anchor, x: rect.left, y: rect.bottom });
    } catch {
      setToolbar(null);
    }
  }, [rangeMode, source, sourceId]);

  const commitHighlight = useCallback(
    async (style: AnnotationStyle) => {
      if (!toolbar) return;
      await wb.commitTextAnnotation({ sourceId, anchor: toolbar.anchor, style });
      window.getSelection()?.removeAllRanges();
      setToolbar(null);
      redrawOverlays();
      bump();
    },
    [toolbar, wb, sourceId, redrawOverlays, bump],
  );

  const commitRange = useCallback(async () => {
    await wb.commitRangeAnnotation({
      sourceId,
      startPageIndex: Math.min(rangeStart, rangeEnd),
      endPageIndex: Math.max(rangeStart, rangeEnd),
    });
    setRangeMode(false);
    redrawOverlays();
    bump();
  }, [wb, sourceId, rangeStart, rangeEnd, redrawOverlays, bump]);

  // Reveal a comment when an annotation overlay is clicked (quiet-by-default).
  useEffect(() => {
    if (!ready) return;
    const mount = mountRef.current;
    if (!mount) return;
    const handler = (ev: Event) => {
      const el = (ev.target as HTMLElement).closest(".ito-highlight") as HTMLElement | null;
      if (!el) return;
      const id = el.dataset.annotationId as AnnotationId | undefined;
      if (id) setOpenComment(id);
    };
    const ctxHandler = (ev: MouseEvent) => {
      const el = (ev.target as HTMLElement).closest(".ito-highlight") as HTMLElement | null;
      if (!el) return;
      ev.preventDefault();
      const id = el.dataset.annotationId as AnnotationId | undefined;
      if (id) setMenu({ annotationId: id, sourceId, x: ev.clientX, y: ev.clientY });
    };
    mount.addEventListener("click", handler);
    mount.addEventListener("contextmenu", ctxHandler);
    return () => {
      mount.removeEventListener("click", handler);
      mount.removeEventListener("contextmenu", ctxHandler);
    };
  }, [ready, sourceId]);

  return (
    <div data-testid="source-pane" data-source-id={sourceId} data-ready={ready ? "true" : "false"}>
      <div style={styles.paneHeader}>
        <strong>{source?.title ?? "…"}</strong>
        <button
          data-testid="start-range"
          onClick={() => setRangeMode((v) => !v)}
          aria-pressed={rangeMode}
        >
          Comment on page range
        </button>
      </div>

      {rangeMode && source && (
        <div data-testid="range-selector" style={styles.rangeSelector}>
          <label>
            Start page{" "}
            <select
              data-testid="range-start"
              value={rangeStart}
              onChange={(e) => setRangeStart(Number(e.target.value))}
            >
              {Array.from({ length: source.pageCount }, (_, i) => (
                <option key={i} value={i}>
                  {i + 1}
                </option>
              ))}
            </select>
          </label>
          <label>
            End page{" "}
            <select
              data-testid="range-end"
              value={rangeEnd}
              onChange={(e) => setRangeEnd(Number(e.target.value))}
            >
              {Array.from({ length: source.pageCount }, (_, i) => (
                <option key={i} value={i}>
                  {i + 1}
                </option>
              ))}
            </select>
          </label>
          <button data-testid="commit-range" onClick={commitRange}>
            Create range annotation
          </button>
        </div>
      )}

      <div
        ref={mountRef}
        data-testid="pdf-mount"
        style={styles.mount}
        onMouseUp={onMouseUp}
      />

      {toolbar && (
        <SelectionToolbar
          toolbar={toolbar}
          onCommit={commitHighlight}
          onDismiss={() => setToolbar(null)}
        />
      )}

      {openComment && (
        <CommentSurface
          wb={wb}
          annotationId={openComment}
          onClose={() => setOpenComment(null)}
          bump={bump}
        />
      )}

      {menu && (
        <AssociationMenu
          wb={wb}
          menu={menu}
          onClose={() => setMenu(null)}
          bump={bump}
        />
      )}
    </div>
  );
}

/**
 * Compact selection controls (R01). ONLY highlight/underline + color — no
 * comment editor, node picker, category selector, or subject page.
 */
function SelectionToolbar({
  toolbar,
  onCommit,
  onDismiss,
}: {
  toolbar: ToolbarState;
  onCommit: (style: AnnotationStyle) => void;
  onDismiss: () => void;
}): JSX.Element {
  const [color, setColor] = useState<HighlightColor>("yellow");
  return (
    <div
      data-testid="selection-toolbar"
      role="toolbar"
      aria-label="Highlight controls"
      style={{
        ...styles.floating,
        left: Math.max(8, toolbar.x),
        top: toolbar.y + window.scrollY + 6,
      }}
    >
      <button
        data-testid="commit-highlight"
        onClick={() => onCommit({ kind: "highlight", color })}
      >
        Highlight
      </button>
      <button
        data-testid="commit-underline"
        onClick={() => onCommit({ kind: "underline", color })}
      >
        Underline
      </button>
      <div data-testid="color-controls" style={{ display: "flex", gap: "0.25rem" }}>
        {HIGHLIGHT_COLORS.map((c) => (
          <button
            key={c}
            data-testid={`color-${c}`}
            aria-label={`Color ${c}`}
            aria-pressed={color === c}
            onClick={() => setColor(c)}
            style={{
              width: 18,
              height: 18,
              borderRadius: "50%",
              border: color === c ? "2px solid #333" : "1px solid #bbb",
              background: swatch(c),
            }}
          />
        ))}
      </div>
      <button data-testid="dismiss-toolbar" aria-label="Dismiss" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}

/**
 * Quiet comment surface (R02, R10). Comments are hidden in normal reading and
 * revealed here only on explicit access. It is an anchored temporary surface
 * that leaves no persistent obstruction: closing it returns focus toward the
 * passage. On a failed save the draft is retained and an error is shown (R12).
 */
function CommentSurface({
  wb,
  annotationId,
  onClose,
  bump,
}: {
  wb: Workbench;
  annotationId: AnnotationId;
  onClose: () => void;
  bump: () => void;
}): JSX.Element {
  const view = wb.viewFor(annotationId);
  const [draft, setDraft] = useState(view?.annotation.comment ?? "");
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    try {
      await wb.setComment(annotationId, draft);
      setError(null);
      bump();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      bump();
    }
  };

  return (
    <div
      data-testid="comment-surface"
      data-annotation-id={annotationId}
      role="dialog"
      aria-label="Annotation comment"
      style={styles.commentSurface}
    >
      {view?.rangeLabel && (
        <div data-testid="range-label" style={{ fontWeight: 600 }}>
          {view.rangeLabel}
        </div>
      )}
      <textarea
        data-testid="comment-input"
        value={draft}
        placeholder="Add a quiet comment (optional)"
        onChange={(e) => setDraft(e.target.value)}
        style={{ width: "100%", minHeight: "4rem" }}
      />
      {error && (
        <p data-testid="comment-error" role="alert" style={{ color: "#c5221f" }}>
          Could not save: {error}. Your draft is kept.
        </p>
      )}
      <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
        <button data-testid="comment-cancel" onClick={onClose}>
          Close
        </button>
        <button data-testid="comment-save" onClick={save}>
          Save
        </button>
      </div>
    </div>
  );
}

/**
 * Right-click / keyboard-menu equivalent (R15). Offers "Associate with
 * subject..." (tentative dotted) and a separate "Insert into subject page...".
 */
function AssociationMenu({
  wb,
  menu,
  onClose,
  bump,
}: {
  wb: Workbench;
  menu: MenuState;
  onClose: () => void;
  bump: () => void;
}): JSX.Element {
  const [picking, setPicking] = useState<null | "associate" | "insert">(null);
  const [query, setQuery] = useState("");
  const pages = wb.rawData().pages.filter((p) => p.kind === "subject");
  const matches = pages.filter((p) =>
    p.title.toLowerCase().includes(query.toLowerCase()),
  );

  const doAssociate = async (pageId: PageId): Promise<void> => {
    await wb.associateWithSubject(menu.annotationId, pageId);
    bump();
    onClose();
  };
  const doInsert = async (pageId: PageId): Promise<void> => {
    const view = wb.viewFor(menu.annotationId);
    const quote =
      view?.annotation.scope.kind === "text"
        ? view.annotation.scope.anchor.selectedText
        : (view?.rangeLabel ?? "range");
    await wb.insertEvidence(menu.annotationId, pageId, quote);
    bump();
    onClose();
  };

  return (
    <div
      data-testid="association-menu"
      role="menu"
      aria-label="Annotation actions"
      style={{ ...styles.floating, left: menu.x, top: menu.y + window.scrollY }}
    >
      {!picking && (
        <>
          <button
            data-testid="menu-associate"
            role="menuitem"
            onClick={() => setPicking("associate")}
          >
            Associate with subject…
          </button>
          <button
            data-testid="menu-insert"
            role="menuitem"
            onClick={() => setPicking("insert")}
          >
            Insert into subject page…
          </button>
          <button data-testid="menu-close" role="menuitem" onClick={onClose}>
            Cancel
          </button>
        </>
      )}
      {picking && (
        <div data-testid="subject-picker">
          <input
            data-testid="subject-search"
            autoFocus
            placeholder="Search subjects…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search subjects"
          />
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {matches.map((p) => (
              <li key={p.id}>
                <button
                  data-testid="subject-option"
                  data-page-id={p.id}
                  onClick={() => (picking === "associate" ? doAssociate(p.id) : doInsert(p.id))}
                >
                  {p.title}
                </button>
              </li>
            ))}
            {matches.length === 0 && (
              <li data-testid="subject-empty" style={{ color: "#888" }}>
                No subjects
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * The highlights tab (sidebar). Lists annotations, distinguishes range
 * annotations from micro-highlights, and provides the ACCESSIBLE (non
 * right-click) path to the association actions via a menu-button (R15).
 */
function HighlightsTab({
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
    <aside
      data-testid="highlights-tab"
      aria-label="Highlights"
      style={styles.sidebar}
    >
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
            view={v}
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
        <AssociationMenu
          wb={wb}
          menu={menuFor}
          onClose={() => setMenuFor(null)}
          bump={bump}
        />
      )}
    </aside>
  );
}

function HighlightRow({
  view,
  onMenu,
}: {
  view: AnnotationView;
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

/** Draw one annotation's overlay(s) across the rendered pages. */
export function drawAnnotation(
  view: AnnotationView,
  pages: readonly RenderedPage[],
  suppressMotion: boolean,
  animate: boolean,
): void {
  if (view.annotation.scope.kind === "text") {
    const anchor = view.annotation.scope.anchor;
    const page = pages.find(
      (p) => Number(p.container.dataset.pageIndex ?? "-1") === anchor.pageIndex,
    );
    if (!page) return;
    renderHighlightOverlay(page.textLayer, {
      kind: view.style.kind,
      color: view.style.color,
      rects: anchor.rects,
      animate,
      suppressMotion,
      annotationId: view.annotation.id,
    });
  } else {
    const { startPageIndex, endPageIndex } = view.annotation.scope.anchor;
    for (let pi = startPageIndex; pi <= endPageIndex; pi++) {
      const page = pages.find(
        (p) => Number(p.container.dataset.pageIndex ?? "-1") === pi,
      );
      if (!page) continue;
      renderHighlightOverlay(page.textLayer, {
        kind: view.style.kind,
        color: view.style.color,
        rects: [],
        animate: false,
        suppressMotion,
        annotationId: view.annotation.id,
        pageBorder: true,
      });
    }
  }
}

function swatch(c: HighlightColor): string {
  return { yellow: "#ffdd57", green: "#82dc96", blue: "#82beff", pink: "#ff96c8" }[c];
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", height: "100vh" },
  toolbar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "1rem",
    padding: "0.5rem 1rem",
    borderBottom: "1px solid #ddd",
    background: "#fafafa",
  },
  body: { display: "flex", flex: 1, overflow: "hidden" },
  main: { flex: 1, overflow: "auto", padding: "1rem", display: "flex", gap: "1.5rem", flexWrap: "wrap" },
  paneHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "1rem",
    marginBottom: "0.5rem",
  },
  rangeSelector: {
    display: "flex",
    gap: "0.75rem",
    alignItems: "center",
    padding: "0.5rem",
    background: "#eef4ff",
    borderRadius: "6px",
    marginBottom: "0.5rem",
  },
  mount: { position: "relative" },
  sidebar: {
    width: "20rem",
    minWidth: "20rem",
    borderLeft: "1px solid #ddd",
    padding: "1rem",
    overflow: "auto",
    background: "#fcfcfc",
  },
  floating: {
    position: "absolute",
    zIndex: 1000,
    display: "flex",
    gap: "0.4rem",
    alignItems: "center",
    padding: "0.35rem 0.5rem",
    background: "#fff",
    border: "1px solid #ccc",
    borderRadius: "8px",
    boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
    flexWrap: "wrap",
  },
  commentSurface: {
    position: "absolute",
    zIndex: 1001,
    top: "20%",
    left: "50%",
    transform: "translateX(-50%)",
    width: "22rem",
    padding: "0.75rem",
    background: "#fff",
    border: "1px solid #ccc",
    borderRadius: "8px",
    boxShadow: "0 6px 24px rgba(0,0,0,0.2)",
  },
  rangeBadge: {
    fontSize: "0.65rem",
    background: "#1a56db",
    color: "#fff",
    borderRadius: "4px",
    padding: "0 0.3rem",
  },
};
