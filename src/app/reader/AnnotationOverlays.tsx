import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icons } from "../ui/icons";
import { renderHighlightOverlay, type RenderedPage } from "../../pdf";
import type { AnnotationId, PageId, SourceId, TextAnchor } from "../../model";
import {
  HIGHLIGHT_COLORS,
  type AnnotationStyle,
  type AnnotationView,
  type HighlightColor,
  type Workbench,
} from "../workbench";

/**
 * M9 (FEAT-001) reader annotation OVERLAYS, consolidated into one file:
 *  - {@link SelectionPopup} / {@link SelectionToolbar} - the no-tool fallback
 *    popup (colour dots + Highlight + Underline).
 *  - {@link AnnotationPopover} / {@link HighlightEditPopover} - the 1-click edit
 *    popover anchored at a highlight.
 *  - {@link ContextMenu} / {@link ReaderContextMenu} - the right-click menu.
 *  - {@link CommentSurface}, {@link AssociationMenu}, {@link BinaryOffloadedPopover},
 *    {@link LiveSelectionPreview}.
 *
 * It also owns the shared presentation helpers/types the reader shell and the
 * sidebar import ({@link styles}, {@link swatch}, {@link clampFixedAnchor},
 * {@link anchorRectFrom}, {@link drawAnnotation}, {@link serializedRerender},
 * {@link clampZoom}, {@link sanitizeSnapshotHtml}, and the anchor/menu state
 * interfaces). Everything is re-exported from Reader.tsx so existing imports
 * (tests + testApi) keep resolving.
 */

/* --------------------------------------------------------------------- */
/* Shared types                                                          */
/* --------------------------------------------------------------------- */

export interface OffloadedPopover {
  readonly evidenceId: string;
  readonly sourceId: SourceId;
  readonly sourceTitle: string;
  readonly quotedText: string;
  readonly comment: string;
  readonly pageNumber: number;
  readonly reason: string;
}

export interface ToolbarState {
  readonly sourceId: SourceId;
  readonly anchor: TextAnchor;
  readonly rect: AnchorRect;
}

export interface MenuState {
  readonly annotationId: AnnotationId;
  readonly sourceId: SourceId;
  readonly x: number;
  readonly y: number;
}

/**
 * A viewport-space rectangle used to anchor the fixed-position selection
 * toolbar and highlight edit popover. When a real getBoundingClientRect is
 * unavailable (jsdom returns width 0) the caller falls back to the pointer
 * clientX/clientY, which still yields a sensible anchor.
 */
export interface AnchorRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
}

export interface EditPopoverState {
  readonly annotationId: AnnotationId;
  readonly sourceId: SourceId;
  readonly rect: AnchorRect;
}

export type ContextMenuState =
  | {
      readonly variant: "annotation";
      readonly annotationId: AnnotationId;
      readonly sourceId: SourceId;
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly variant: "page";
      readonly sourceId: SourceId;
      readonly x: number;
      readonly y: number;
    };

/* --------------------------------------------------------------------- */
/* Shared helpers                                                        */
/* --------------------------------------------------------------------- */

/**
 * Clamp an anchor rect into viewport-space fixed coordinates for a floating
 * surface of a given width. The surface is centred over the anchor and clamped
 * 12px from each viewport edge, and sits above the anchor when there is room
 * (anchorTop > 64) otherwise just below it.
 */
export function clampFixedAnchor(
  rect: AnchorRect,
  surfaceWidth: number,
): { left: number; top: number } {
  const viewportWidth = (typeof window !== "undefined" && window.innerWidth) || 1024;
  const anchorCenterX = rect.left + rect.width / 2;
  const left = Math.max(
    12,
    Math.min(anchorCenterX - surfaceWidth / 2, viewportWidth - surfaceWidth - 12),
  );
  const top = rect.top > 64 ? rect.top - 48 : rect.bottom + 12;
  return { left, top };
}

/**
 * Derive an AnchorRect from a DOMRect, falling back to the pointer position
 * when the rect has zero width (jsdom's getBoundingClientRect commonly returns
 * zeros).
 */
export function anchorRectFrom(
  rect: DOMRect | null,
  pointerX: number,
  pointerY: number,
): AnchorRect {
  if (rect && rect.width > 0) {
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
    };
  }
  return {
    left: pointerX,
    top: pointerY,
    right: pointerX,
    bottom: pointerY,
    width: 0,
  };
}

export function swatch(c: HighlightColor): string {
  return { yellow: "#ffdd57", green: "#82dc96", blue: "#82beff", pink: "#ff96c8" }[c];
}

/** Escape an annotation id for use in a CSS attribute selector. */
export function cssEscapeId(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
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
    renderHighlightOverlay(page.stage, {
      kind: view.style.kind,
      color: view.style.color,
      rects: anchor.rects,
      animate,
      suppressMotion,
      annotationId: view.annotation.id,
    });
  } else if (view.annotation.scope.kind === "area") {
    const anchor = view.annotation.scope.anchor;
    const page = pages.find(
      (p) => Number(p.container.dataset.pageIndex ?? "-1") === anchor.pageIndex,
    );
    if (!page) return;
    renderHighlightOverlay(page.stage, {
      kind: view.style.kind,
      color: view.style.color,
      rects: [anchor.rect],
      animate: false,
      suppressMotion,
      annotationId: view.annotation.id,
      areaBox: true,
      areaLabel: view.annotation.comment || "Area",
    });
  } else {
    const { startPageIndex, endPageIndex } = view.annotation.scope.anchor;
    for (let pi = startPageIndex; pi <= endPageIndex; pi++) {
      const page = pages.find((p) => Number(p.container.dataset.pageIndex ?? "-1") === pi);
      if (!page) continue;
      renderHighlightOverlay(page.stage, {
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

/**
 * Per-page rerender serializer. At most one rerender runs at a time; if newer
 * requests arrive while one is in flight only the LATEST target scale is
 * rendered next (intermediate targets are dropped).
 */
type RerenderState = { running: Promise<void> | null; pending: number | null };
const rerenderStates = new WeakMap<RenderedPage, RerenderState>();

export function serializedRerender(page: RenderedPage, scale: number): Promise<void> {
  let state = rerenderStates.get(page);
  if (!state) {
    state = { running: null, pending: null };
    rerenderStates.set(page, state);
  }
  if (state.running) {
    state.pending = scale;
    return state.running;
  }
  const run = (target: number): Promise<void> =>
    page.rerender(target).then(() => {
      const next = state!.pending;
      state!.pending = null;
      if (next !== null && next !== target) return run(next);
      state!.running = null;
      return undefined;
    });
  const started = run(scale);
  state.running = started;
  return started;
}

/** FEAT-002 (2.5) zoom bounds: step the PDF scale between 50% and 300%. */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
export function clampZoom(z: number): number {
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
  return next;
}

/**
 * Minimal defense-in-depth sanitizer for a stored website snapshot (A15, D11).
 * Strips <script>/<style> blocks, inline event handlers (quoted or unquoted),
 * and javascript: URLs so a snapshot can never execute script in the reader.
 */
export function sanitizeSnapshotHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/(\s)on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "$1")
    .replace(/javascript:/gi, "");
}

/* --------------------------------------------------------------------- */
/* Overlay components                                                    */
/* --------------------------------------------------------------------- */

/**
 * Compact selection controls (R01). ONLY highlight/underline + colour - no
 * comment editor, node picker, category selector, or subject page. This is the
 * no-tool fallback popup; it is exported as both SelectionToolbar (legacy name
 * kept for tests) and SelectionPopup (the M9 name).
 */
export function SelectionToolbar({
  toolbar,
  onCommit,
  onDismiss,
}: {
  toolbar: ToolbarState;
  onCommit: (style: AnnotationStyle) => void;
  onDismiss: () => void;
}): JSX.Element {
  const [color, setColor] = useState<HighlightColor>("yellow");
  const TOOLBAR_WIDTH = 260;
  const { left, top: rawTop } = clampFixedAnchor(toolbar.rect, TOOLBAR_WIDTH);
  // Keep the popup on screen vertically too (a selection scrolled partly out of
  // view must never strand its controls off-screen).
  const vh = (typeof window !== "undefined" && window.innerHeight) || 768;
  const top = Math.min(Math.max(8, rawTop), vh - 56);
  return (
    <div
      data-testid="selection-toolbar"
      role="toolbar"
      aria-label="Highlight controls"
      style={{ ...styles.fixedFloating, left, top }}
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
            className="ito-color-dot"
            data-selected={color === c ? "true" : undefined}
            style={{ background: swatch(c) }}
          />
        ))}
      </div>
      <button data-testid="dismiss-toolbar" aria-label="Dismiss" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}

/** M9 name for the no-tool fallback popup. */
export const SelectionPopup = SelectionToolbar;

/**
 * The live watercolor selection preview: soft-rounded translucent pills
 * mirrored over the current selection's client rects. Presentation only.
 */
export function LiveSelectionPreview({
  preview,
}: {
  preview: { color: string; rects: AnchorRect[] };
}): JSX.Element {
  return (
    <div data-testid="live-selection-preview" aria-hidden="true">
      {preview.rects.map((r, i) => (
        <div
          key={i}
          className="ito-selection-live-preview"
          style={{
            position: "fixed",
            left: r.left,
            top: r.top,
            width: r.width,
            height: r.bottom - r.top,
            background: preview.color,
            opacity: 0.35,
            borderRadius: "6px",
            pointerEvents: "none",
            zIndex: 999,
          }}
        />
      ))}
    </div>
  );
}

/**
 * The anchored 1-click highlight EDIT popover. Embeds the CommentSurface plus
 * colour swatches, a highlight/underline toggle, Associate / Insert into
 * Subject, Show in Nodes, and both Delete options. Exported as both
 * HighlightEditPopover (legacy) and AnnotationPopover (M9 name).
 */
export function HighlightEditPopover({
  wb,
  popover,
  onClose,
  bump,
}: {
  wb: Workbench;
  popover: EditPopoverState;
  onClose: () => void;
  bump: () => void;
}): JSX.Element {
  const POPOVER_WIDTH = 300;
  const { left } = clampFixedAnchor(popover.rect, POPOVER_WIDTH);
  const popRef = useRef<HTMLDivElement>(null);
  // Sit just below the anchored highlight; flip above when there is no room.
  // Measured after mount because the popover's height varies (figure, comment).
  const [top, setTop] = useState<number>(popover.rect.bottom + 8);
  useLayoutEffect(() => {
    const el = popRef.current;
    if (!el || typeof window === "undefined") return;
    const h = el.offsetHeight;
    const vh = window.innerHeight;
    const below = popover.rect.bottom + 8;
    let next = below;
    if (below + h > vh - 8) {
      const above = popover.rect.top - h - 8;
      next = above >= 8 ? above : Math.max(8, vh - h - 8);
    }
    setTop((t) => (t === next ? t : next));
  });
  const view = wb.viewFor(popover.annotationId);
  const imageDataUrl =
    view && view.annotation.scope.kind === "area"
      ? view.annotation.scope.anchor.imageDataUrl
      : undefined;
  const [menuMode, setMenuMode] = useState<null | "associate" | "insert">(null);

  const setColor = async (color: HighlightColor): Promise<void> => {
    const kind = view?.style.kind ?? "highlight";
    await wb.setAnnotationStyle(popover.annotationId, { kind, color });
    bump();
  };
  const toggleStyle = async (): Promise<void> => {
    const kind = view?.style.kind === "underline" ? "highlight" : "underline";
    const color = view?.style.color ?? "yellow";
    await wb.setAnnotationStyle(popover.annotationId, { kind, color });
    bump();
  };

  return (
    <div
      data-testid="highlight-edit-popover"
      data-annotation-id={popover.annotationId}
      role="dialog"
      aria-label="Edit highlight"
      ref={popRef}
      className="ito-annot-popover"
      style={{
        ...styles.fixedFloating,
        left,
        top,
        width: POPOVER_WIDTH,
        display: "block",
        alignItems: "stretch",
        boxSizing: "border-box",
      }}
    >
      <div className="ito-annot-popover-head">
        <div data-testid="color-controls" className="ito-annot-popover-colors">
          {HIGHLIGHT_COLORS.map((c) => (
            <button
              key={c}
              data-testid={`color-${c}`}
              aria-label={`Color ${c}`}
              onClick={() => void setColor(c)}
              className="ito-color-dot"
              data-selected={view?.style.color === c ? "true" : undefined}
              style={{ background: swatch(c) }}
            />
          ))}
        </div>
        <button
          data-testid="toggle-style-kind"
          className="ito-annot-popover-kind"
          title="Switch between highlight and underline"
          onClick={() => void toggleStyle()}
        >
          {view?.style.kind === "underline" ? "Underline" : "Highlight"}
        </button>
        <button
          data-testid="popover-close"
          aria-label="Close"
          title="Close"
          className="ito-annot-popover-x"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {imageDataUrl && (
        <img
          data-testid="area-figure-preview"
          src={imageDataUrl}
          alt="Captured figure"
          style={styles.figurePreview}
        />
      )}
      <CommentSurface
        wb={wb}
        annotationId={popover.annotationId}
        onClose={onClose}
        bump={bump}
        embedded
      />
      {!menuMode && (
        <div className="ito-annot-popover-actions">
          <button
            data-testid="popover-associate-insert"
            className="ito-ctx-item"
            onClick={() => setMenuMode("associate")}
          >
            <span className="ito-ctx-item-icon" aria-hidden="true">
              {Icons.link}
            </span>
            <span className="ito-ctx-item-label">Associate / insert into Subject…</span>
          </button>
          <ShowInNodes wb={wb} annotationId={popover.annotationId} bump={bump} asMenuRow />
        </div>
      )}
      {menuMode && (
        <AssociationMenu
          wb={wb}
          menu={{ annotationId: popover.annotationId, sourceId: popover.sourceId, x: 0, y: 0 }}
          embedded
          onClose={() => {
            setMenuMode(null);
            onClose();
          }}
          bump={bump}
        />
      )}
      <div className="ito-annot-popover-foot">
        <button
          data-testid="delete-highlight-only"
          className="ito-annot-danger"
          onClick={async () => {
            await wb.deleteAnnotationOnly(popover.annotationId);
            bump();
            onClose();
          }}
        >
          Delete highlight
        </button>
        <button
          data-testid="delete-highlight-and-quotes"
          className="ito-annot-danger"
          onClick={async () => {
            await wb.deleteAnnotationAndQuotes(popover.annotationId);
            bump();
            onClose();
          }}
        >
          Delete highlight and quotes
        </button>
      </div>
    </div>
  );
}

/** M9 name for the annotation edit popover. */
export const AnnotationPopover = HighlightEditPopover;

/**
 * The right-click context menu. Two variants: an annotation menu and a page
 * menu. Exported as both ReaderContextMenu (legacy) and ContextMenu (M9 name).
 */
export function ReaderContextMenu({
  wb,
  menu,
  onClose,
  onEditComment,
  onPageAction,
  bump,
}: {
  wb: Workbench;
  menu: ContextMenuState;
  onClose: () => void;
  onEditComment: (annotationId: AnnotationId, x: number, y: number) => void;
  onPageAction: (action: "range" | "area" | "switch" | "lines" | "motion") => void;
  bump: () => void;
}): JSX.Element {
  const [picking, setPicking] = useState<null | "associate" | "insert">(null);
  const ref = useRef<HTMLDivElement>(null);
  const MENU_WIDTH = 248;
  const [pos, setPos] = useState<{ left: number; top: number }>(() => ({
    left: Math.max(
      8,
      Math.min(menu.x, ((typeof window !== "undefined" && window.innerWidth) || 1024) - MENU_WIDTH - 8),
    ),
    top: menu.y,
  }));

  // Flip/clamp against the viewport once the real height is known so the menu
  // never opens off-screen (it opens upward / shifts in when near an edge).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof window === "undefined") return;
    const h = el.offsetHeight;
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    let top = menu.y;
    if (top + h > vh - 8) top = Math.max(8, menu.y - h);
    if (top + h > vh - 8) top = Math.max(8, vh - h - 8);
    const left = Math.max(8, Math.min(menu.x, vw - MENU_WIDTH - 8));
    setPos((p) => (p.left === left && p.top === top ? p : { left, top }));
  }, [menu.x, menu.y, picking]);

  // Esc and any pointer-down outside the menu dismiss it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    const t = setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    return () => {
      document.removeEventListener("keydown", onKey);
      clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  const style: React.CSSProperties = {
    position: "fixed",
    left: pos.left,
    top: pos.top,
    width: MENU_WIDTH,
  };

  if (menu.variant === "page") {
    return (
      <div
        ref={ref}
        data-testid="reader-context-menu"
        data-variant="page"
        role="menu"
        aria-label="Page actions"
        className="ito-ctx-menu"
        style={style}
      >
        <MenuRow testId="ctx-comment-range" icon={Icons.comment} label="Comment on page range…" onClick={() => onPageAction("range")} />
        <MenuRow testId="ctx-select-area" icon={Icons.area} label="Select figure or area" shortcut="A" onClick={() => onPageAction("area")} />
        <div className="ito-ctx-sep" role="separator" />
        <MenuRow testId="ctx-switch-paper" icon={Icons.swap} label="Switch paper…" onClick={() => onPageAction("switch")} />
        <MenuRow testId="ctx-toggle-lines" icon={Icons.lines} label="Toggle source lines" onClick={() => onPageAction("lines")} />
        <MenuRow testId="ctx-toggle-motion" icon={Icons.motion} label="Reduce motion" onClick={() => onPageAction("motion")} />
      </div>
    );
  }

  if (picking) {
    return (
      <div
        ref={ref}
        data-testid="reader-context-menu"
        data-variant="annotation"
        role="menu"
        className="ito-ctx-menu ito-ctx-menu-picker"
        style={style}
      >
        <AssociationMenu
          wb={wb}
          menu={{ annotationId: menu.annotationId, sourceId: menu.sourceId, x: 0, y: 0 }}
          embedded
          onClose={onClose}
          bump={bump}
        />
      </div>
    );
  }

  return (
    <div
      ref={ref}
      data-testid="reader-context-menu"
      data-variant="annotation"
      role="menu"
      aria-label="Annotation actions"
      className="ito-ctx-menu"
      style={style}
    >
      <div className="ito-ctx-colors">
        <span className="ito-ctx-section-label">Colour</span>
        <ContextColorSwatches wb={wb} annotationId={menu.annotationId} bump={bump} />
      </div>
      <div className="ito-ctx-sep" role="separator" />
      <MenuRow
        testId="ctx-edit-comment"
        icon={Icons.pencil}
        label="Edit comment"
        onClick={() => onEditComment(menu.annotationId, menu.x, menu.y)}
      />
      <MenuRow testId="ctx-associate" icon={Icons.link} label="Associate with Subject…" onClick={() => setPicking("associate")} />
      <MenuRow testId="ctx-insert" icon={Icons.quote} label="Insert quote into Subject…" onClick={() => setPicking("insert")} />
      <ShowInNodes wb={wb} annotationId={menu.annotationId} bump={bump} asMenuRow />
      <div className="ito-ctx-sep" role="separator" />
      <MenuRow
        testId="delete-highlight-only"
        icon={Icons.trash}
        label="Delete highlight"
        danger
        onClick={async () => {
          await wb.deleteAnnotationOnly(menu.annotationId);
          bump();
          onClose();
        }}
      />
      <MenuRow
        testId="delete-highlight-and-quotes"
        icon={Icons.trashAll}
        label="Delete highlight and quotes"
        danger
        onClick={async () => {
          await wb.deleteAnnotationAndQuotes(menu.annotationId);
          bump();
          onClose();
        }}
      />
    </div>
  );
}

/** One left-aligned, icon-led row of the reader context menu. */
function MenuRow({
  testId,
  icon,
  label,
  shortcut,
  danger,
  onClick,
}: {
  testId: string;
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  danger?: boolean;
  onClick: () => void | Promise<void>;
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      className={["ito-ctx-item", danger ? "ito-ctx-item-danger" : null].filter(Boolean).join(" ")}
      onClick={() => void onClick()}
    >
      <span className="ito-ctx-item-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="ito-ctx-item-label">{label}</span>
      {shortcut && <kbd className="ito-ctx-item-kbd">{shortcut}</kbd>}
    </button>
  );
}

/** M9 name for the right-click context menu. */
export const ContextMenu = ReaderContextMenu;

/** Inline colour swatches used inside the annotation context menu. */
function ContextColorSwatches({
  wb,
  annotationId,
  bump,
}: {
  wb: Workbench;
  annotationId: AnnotationId;
  bump: () => void;
}): JSX.Element {
  const view = wb.viewFor(annotationId);
  return (
    <div
      data-testid="color-controls"
      role="group"
      aria-label="Color swatches"
      style={{ display: "flex", gap: "0.25rem" }}
    >
      {HIGHLIGHT_COLORS.map((c) => (
        <button
          key={c}
          data-testid={`color-${c}`}
          aria-label={`Color ${c}`}
          onClick={async () => {
            const kind = view?.style.kind ?? "highlight";
            await wb.setAnnotationStyle(annotationId, { kind, color: c });
            bump();
          }}
          className="ito-color-dot"
          data-selected={view?.style.color === c ? "true" : undefined}
          style={{ background: swatch(c) }}
        />
      ))}
    </div>
  );
}

/**
 * Quiet comment surface (R02, R10). It resets its draft whenever it switches to
 * a DIFFERENT annotation so one highlight's in-progress comment can never leak
 * into another (keyed on annotationId).
 */
export function CommentSurface({
  wb,
  annotationId,
  onClose,
  bump,
  embedded = false,
}: {
  wb: Workbench;
  annotationId: AnnotationId;
  onClose: () => void;
  bump: () => void;
  /** Rendered inside the annotation popover: flows inline instead of floating. */
  embedded?: boolean;
}): JSX.Element {
  const view = wb.viewFor(annotationId);
  const [draft, setDraft] = useState(view?.annotation.comment ?? "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(wb.viewFor(annotationId)?.annotation.comment ?? "");
    setError(null);
  }, [wb, annotationId]);

  // `closeAfter` is true for the explicit Save button. Autosave-on-blur passes
  // false: leaving the textarea (to click the sidebar toggle, say) must keep the
  // draft and the popover, never dismiss them.
  const save = async (closeAfter = true): Promise<void> => {
    try {
      await wb.setComment(annotationId, draft);
      setError(null);
      bump();
      if (closeAfter) onClose();
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
      className={embedded ? "ito-comment-embedded" : undefined}
      style={embedded ? undefined : styles.commentSurface}
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
        onBlur={() => {
          // Autosave only a real change; an untouched draft needs no write.
          if (draft !== (wb.viewFor(annotationId)?.annotation.comment ?? "")) void save(false);
        }}
        style={embedded ? undefined : { width: "100%", minHeight: "4rem" }}
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
        <button
          data-testid="comment-save"
          // Keep focus in the textarea so Save is ONE save (no blur-autosave
          // racing the click).
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void save()}
        >
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
export function AssociationMenu({
  wb,
  menu,
  onClose,
  bump,
  embedded,
}: {
  wb: Workbench;
  menu: MenuState;
  onClose: () => void;
  bump: () => void;
  embedded?: boolean;
}): JSX.Element {
  const [picking, setPicking] = useState<null | "associate" | "insert">(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
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
    await wb.insertEvidenceIntoPage(menu.annotationId, pageId, { pos: null });
    wb.openSubjectPage(pageId);
    bump();
    onClose();
  };
  const doCreate = async (): Promise<void> => {
    const title = newTitle.trim();
    if (!title) return;
    const { page } = await wb.createSubjectFromAnnotation(title, menu.annotationId);
    wb.openSubjectPage(page.id);
    bump();
    onClose();
  };
  const doDeleteOnly = async (): Promise<void> => {
    await wb.deleteAnnotationOnly(menu.annotationId);
    bump();
    onClose();
  };
  const doDeleteAndQuotes = async (): Promise<void> => {
    await wb.deleteAnnotationAndQuotes(menu.annotationId);
    bump();
    onClose();
  };

  return (
    <div
      data-testid="association-menu"
      role="menu"
      aria-label="Annotation actions"
      style={
        embedded
          ? { position: "static", display: "flex", flexDirection: "column", gap: "0.25rem" }
          : { ...styles.floating, left: menu.x, top: menu.y + window.scrollY }
      }
    >
      {!picking && !creating && (
        <>
          <button data-testid="menu-create-subject" role="menuitem" onClick={() => setCreating(true)}>
            Create new subject from this…
          </button>
          <button data-testid="menu-associate" role="menuitem" onClick={() => setPicking("associate")}>
            Associate with subject…
          </button>
          <button data-testid="menu-insert" role="menuitem" onClick={() => setPicking("insert")}>
            Insert into subject page…
          </button>
          <button data-testid="delete-highlight-only" role="menuitem" onClick={() => void doDeleteOnly()}>
            Delete highlight only
          </button>
          <button
            data-testid="delete-highlight-and-quotes"
            role="menuitem"
            onClick={() => void doDeleteAndQuotes()}
          >
            Delete highlight and its quotes
          </button>
          <button data-testid="menu-close" role="menuitem" onClick={onClose}>
            Cancel
          </button>
        </>
      )}
      {creating && (
        <div data-testid="create-subject">
          <input
            data-testid="new-subject-title"
            autoFocus
            placeholder="New subject title…"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            aria-label="New subject title"
            onKeyDown={(e) => {
              if (e.key === "Enter") void doCreate();
            }}
          />
          <button data-testid="create-subject-confirm" onClick={() => void doCreate()}>
            Create and cite
          </button>
        </div>
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
 * Reference-directed locating in Nodes (N04/N05/N07). Renders a "Show in Nodes"
 * control only for an annotation cited into >= 1 subject page.
 */
export function ShowInNodes({
  wb,
  annotationId,
  bump,
  asMenuRow = false,
}: {
  wb: Workbench;
  annotationId: AnnotationId;
  bump: () => void;
  /** Render as a labelled context-menu row instead of the compact icon button. */
  asMenuRow?: boolean;
}): JSX.Element | null {
  const [pickerOpen, setPickerOpen] = useState(false);
  const citedPageIds = wb.citedSubjectPagesForAnnotation(annotationId);
  if (citedPageIds.length === 0) return null;

  const locate = (pageId: PageId): void => {
    wb.setViewMode("nodes");
    wb.setFocusedPageId(pageId);
    setPickerOpen(false);
    bump();
  };

  const onClick = (): void => {
    if (citedPageIds.length === 1) {
      locate(citedPageIds[0]!);
      return;
    }
    setPickerOpen((v) => !v);
  };

  return (
    <span style={{ position: "relative", display: asMenuRow ? "block" : "inline-flex" }}>
      {asMenuRow ? (
        <button
          type="button"
          role="menuitem"
          data-testid="show-in-nodes"
          data-annotation-id={annotationId}
          data-cited-count={String(citedPageIds.length)}
          className="ito-ctx-item"
          onClick={onClick}
        >
          <span className="ito-ctx-item-icon" aria-hidden="true">
            {Icons.nodes}
          </span>
          <span className="ito-ctx-item-label">Show in Nodes</span>
        </button>
      ) : (
      <button
        data-testid="show-in-nodes"
        data-annotation-id={annotationId}
        data-cited-count={String(citedPageIds.length)}
        aria-label="Show in Nodes"
        title="Show in Nodes"
        onClick={onClick}
      >
        ◎
      </button>
      )}
      {pickerOpen && citedPageIds.length > 1 && (
        <div
          data-testid="nodes-destination-picker"
          role="menu"
          aria-label="Choose a subject node"
          style={styles.destinationPicker}
        >
          {citedPageIds.map((pid) => {
            const page = wb.rawData().pages.find((p) => p.id === pid);
            return (
              <button
                key={pid}
                data-testid="nodes-destination-option"
                data-page-id={pid}
                role="menuitem"
                onClick={() => locate(pid)}
                style={{ display: "block", width: "100%", textAlign: "left" }}
              >
                {page?.title ?? "Subject"}
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}

/**
 * The binary-offloaded citation popover (A17). Shows the citation's stored
 * quote + comment + page number + source title and offers an "Attach PDF
 * Binary" action (sha256-verified re-hydration).
 */
export function BinaryOffloadedPopover({
  wb,
  popover,
  onClose,
  onAttached,
}: {
  wb: Workbench;
  popover: OffloadedPopover;
  onClose: () => void;
  onAttached: () => void;
}): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);

  const onFile = async (file: File | null): Promise<void> => {
    if (!file) return;
    setAttaching(true);
    setError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await wb.attachSourceBinary(popover.sourceId, bytes);
      if (!result.attached) {
        setError(result.reason ?? "the file did not match this source");
        return;
      }
      onAttached();
    } finally {
      setAttaching(false);
    }
  };

  return (
    <div
      data-testid="binary-offloaded-popover"
      data-return-resolution="binary-offloaded"
      data-source-id={popover.sourceId}
      data-evidence-id={popover.evidenceId}
      role="dialog"
      aria-label="Offloaded source citation"
      style={styles.offloadedPopover}
    >
      <div style={styles.offloadedHeader}>
        <strong data-testid="offloaded-source-title">{popover.sourceTitle}</strong>
        <button data-testid="offloaded-popover-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <p style={styles.offloadedReason}>{popover.reason}</p>
      <blockquote data-testid="offloaded-quote" style={styles.offloadedQuote}>
        {popover.quotedText}
      </blockquote>
      {popover.comment !== "" && (
        <p data-testid="offloaded-comment" style={{ fontSize: "0.82rem", color: "#555" }}>
          {popover.comment}
        </p>
      )}
      <div data-testid="offloaded-page" style={{ fontSize: "0.78rem", color: "#777" }}>
        Page {popover.pageNumber}
      </div>
      {error && (
        <p data-testid="attach-pdf-error" role="alert" style={{ color: "#c5221f", fontSize: "0.8rem" }}>
          {error}
        </p>
      )}
      <label data-testid="attach-pdf-binary" style={styles.attachLabel}>
        {attaching ? "Attaching…" : "Attach PDF Binary"}
        <input
          data-testid="attach-pdf-input"
          type="file"
          accept=".pdf,application/pdf"
          style={{ display: "none" }}
          disabled={attaching}
          onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
        />
      </label>
    </div>
  );
}

/* --------------------------------------------------------------------- */
/* Shared inline styles (presentation moved out of Reader.tsx)           */
/* --------------------------------------------------------------------- */

export const styles: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", height: "100%" },
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
  main: { flex: 1, position: "relative", overflow: "hidden", display: "flex", alignItems: "stretch" },
  pane: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
    minWidth: 0,
    borderRight: "1px solid #eee",
  },
  paneScroll: { flex: 1, minHeight: 0, overflow: "auto", padding: "8px 12px 32px" },
  divider: {
    flex: "0 0 8px",
    cursor: "col-resize",
    background: "#e6e6e6",
    borderLeft: "1px solid #d4d4d4",
    borderRight: "1px solid #d4d4d4",
    alignSelf: "stretch",
  },
  responsiveStub: {
    padding: "0.75rem 1rem",
    margin: "0.5rem",
    background: "#fff4e5",
    border: "1px solid #f0c38a",
    borderRadius: "6px",
    color: "#7a4b00",
    fontSize: "0.85rem",
  },
  paneHeader: {
    display: "flex",
    alignItems: "center",
    flexWrap: "nowrap",
    gap: "6px",
    overflowX: "auto",
    margin: 0,
    padding: "4px 12px",
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
  scopeStatus: {
    padding: "0.5rem 0.75rem",
    margin: "0 0 0.5rem",
    background: "#fff4e5",
    border: "1px solid #f0c38a",
    borderRadius: "6px",
    color: "#7a4b00",
    fontSize: "0.82rem",
  },
  findBar: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "4px 8px",
    borderBottom: "1px solid var(--ito-border, #dcd6c8)",
    background: "var(--ito-bg-elevated, #fff)",
  },
  websiteBadge: {
    fontSize: "0.72rem",
    padding: "0.05rem 0.4rem",
    borderRadius: "4px",
    background: "#e6f0fb",
    color: "#2c4a6f",
  },
  websiteSnapshot: {
    maxWidth: "100%",
    padding: "0.5rem",
    background: "#fff",
    lineHeight: 1.5,
    userSelect: "text",
  },
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
  fixedLayer: { position: "fixed", left: 0, top: 0, width: 0, height: 0, zIndex: 1000 },
  fixedFloating: {
    position: "fixed",
    zIndex: 1000,
    display: "flex",
    gap: "6px",
    alignItems: "center",
    padding: "6px 8px",
    background: "var(--ito-bg-elevated)",
    border: "1px solid var(--ito-border)",
    borderRadius: "var(--ito-radius-md)",
    boxShadow: "var(--ito-shadow-lg)",
    flexWrap: "wrap",
  },
  overflowMenu: {
    position: "absolute",
    zIndex: 1004,
    top: "100%",
    right: 0,
    minWidth: "14rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
    padding: "0.4rem",
    background: "#fff",
    border: "1px solid #ccc",
    borderRadius: "8px",
    boxShadow: "0 6px 24px rgba(0,0,0,0.2)",
  },
  zoomPill: {
    display: "inline-flex",
    alignItems: "center",
    gap: "2px",
    border: "1px solid var(--ito-border, #ccc)",
    borderRadius: "999px",
    padding: "0 2px",
  },
  figurePreview: {
    display: "block",
    maxWidth: "100%",
    maxHeight: "8rem",
    marginBottom: "0.4rem",
    border: "1px solid #ddd",
    borderRadius: "4px",
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
  returnNotice: {
    padding: "0.5rem 1rem",
    background: "#fff4e5",
    borderBottom: "1px solid #f0c38a",
    color: "#7a4b00",
    fontSize: "0.85rem",
  },
  destinationPicker: {
    position: "absolute",
    zIndex: 1002,
    top: "100%",
    right: 0,
    minWidth: "12rem",
    padding: "0.25rem",
    background: "#fff",
    border: "1px solid #ccc",
    borderRadius: "6px",
    boxShadow: "0 6px 24px rgba(0,0,0,0.2)",
  },
  offloadedPopover: {
    position: "absolute",
    zIndex: 1003,
    top: "20%",
    left: "50%",
    transform: "translateX(-50%)",
    width: "24rem",
    maxWidth: "90vw",
    padding: "0.9rem 1rem",
    background: "#fff",
    border: "1px solid #f0c38a",
    borderRadius: "10px",
    boxShadow: "0 8px 30px rgba(0,0,0,0.22)",
  },
  offloadedHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "0.35rem",
  },
  offloadedReason: { fontSize: "0.8rem", color: "#7a4b00", margin: "0 0 0.5rem" },
  offloadedQuote: {
    margin: "0 0 0.5rem",
    padding: "0.35rem 0.6rem",
    borderLeft: "3px solid #1a56db",
    background: "#f6f8ff",
    fontSize: "0.9rem",
  },
  attachLabel: {
    display: "inline-block",
    marginTop: "0.4rem",
    padding: "0.35rem 0.75rem",
    background: "#1a56db",
    color: "#fff",
    borderRadius: "6px",
    cursor: "pointer",
    fontSize: "0.85rem",
  },
};
