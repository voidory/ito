import { useEffect, useState } from "react";
import { Icons } from "../ui/icons";
import { Popover } from "../ui/primitives";
import type { AnnotationId } from "../../model";
import {
  HIGHLIGHT_COLORS,
  type AnnotationStyle,
  type HighlightColor,
  type Workbench,
} from "../workbench";
import {
  swatch,
  type AnchorRect,
  type EditPopoverState,
  type ToolbarState,
} from "./overlayShared";

export { swatch };
import {
  AssociationMenu,
  CommentSurface,
  ShowInNodes,
} from "./AnnotationMenus";

/**
 * M9/M10 reader annotation OVERLAYS barrel. The anchored floating surfaces
 * (selection toolbar + highlight edit popover) live here and now mount the
 * shared {@link Popover} primitive from ../ui/primitives; their static
 * presentation moved to semantic CSS classes in theme.css (only dynamic
 * coordinates and colour swatches remain inline).
 *
 * The menus / comment / offloaded surfaces were split into ./AnnotationMenus,
 * the pure helpers + types into ./overlayShared, and the shell/sidebar inline
 * style record into ./overlayStyles. Everything is re-exported from here (and
 * from Reader.tsx) so existing imports (tests + testApi) keep resolving, and
 * the legacy aliases SelectionPopup / AnnotationPopover / ContextMenu stay.
 */

/* --------------------------------------------------------------------- */
/* Re-exports: types, helpers, shell/sidebar styles, split-out components */
/* --------------------------------------------------------------------- */

export {
  anchorRectFrom,
  clampFixedAnchor,
  clampZoom,
  cssEscapeId,
  drawAnnotation,
  sanitizeSnapshotHtml,
  serializedRerender,
} from "./overlayShared";
export type {
  AnchorRect,
  ContextMenuState,
  EditPopoverState,
  MenuState,
  OffloadedPopover,
  ToolbarState,
} from "./overlayShared";
export { styles } from "./overlayStyles";
export {
  AssociationMenu,
  BinaryOffloadedPopover,
  CommentSurface,
  ContextMenu,
  ReaderContextMenu,
  ShowInNodes,
} from "./AnnotationMenus";

/* --------------------------------------------------------------------- */
/* Anchored floating overlays                                            */
/* --------------------------------------------------------------------- */

/**
 * Compact selection controls (R01). ONLY highlight/underline + colour - no
 * comment editor, node picker, category selector, or subject page. This is the
 * no-tool fallback popup; it is exported as both SelectionToolbar (legacy name
 * kept for tests) and SelectionPopup (the M9 name). It now mounts the shared
 * <Popover>, which owns its Escape + outside-click dismissal (onDismiss).
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
  return (
    <Popover
      anchor={toolbar.rect}
      width={TOOLBAR_WIDTH}
      onClose={onDismiss}
      role="dialog"
      ariaLabel="Highlight controls"
      testId="selection-toolbar"
      className="ito-selection-toolbar"
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
      <div data-testid="color-controls" className="ito-color-controls">
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
    </Popover>
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
 * Subject, Show in Nodes, and both Delete options. It mounts the shared
 * <Popover> (which owns Escape + outside-click dismissal) and tracks the live
 * highlight rect every render so the popover follows the page as it scrolls
 * (7781d68). Outside-click closes on `mouseup` so the comment textarea's
 * blur-autosave commits first (4e29b1a). Exported as both HighlightEditPopover
 * (legacy) and AnnotationPopover (M9 name).
 */
export function HighlightEditPopover({
  wb,
  popover,
  onClose,
  bump,
  resolveAnchor,
}: {
  wb: Workbench;
  popover: EditPopoverState;
  onClose: () => void;
  bump: () => void;
  /**
   * Re-measure the live on-screen box of the annotation this popover belongs
   * to. When given, the popover follows its highlight as the page scrolls or
   * resizes instead of staying where it first opened.
   */
  resolveAnchor?: (annotationId: AnnotationId) => AnchorRect | null;
}): JSX.Element {
  const POPOVER_WIDTH = 300;
  // The anchor starts at the click/selection rect, then tracks the highlight so
  // <Popover> re-clamps around the live rect on every render (scroll-follow).
  const [anchor, setAnchor] = useState<AnchorRect>(popover.rect);
  useEffect(() => setAnchor(popover.rect), [popover.rect]);
  useEffect(() => {
    if (!resolveAnchor || typeof window === "undefined") return;
    let frame = 0;
    const update = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const r = resolveAnchor(popover.annotationId);
        if (r) setAnchor(r);
      });
    };
    // Capture phase so scrolls of ANY inner container (the page stack) count.
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    update();
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [resolveAnchor, popover.annotationId]);

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
    <Popover
      anchor={anchor}
      width={POPOVER_WIDTH}
      onClose={onClose}
      role="dialog"
      ariaLabel="Edit highlight"
      testId="highlight-edit-popover"
      className="ito-annot-popover ito-highlight-popover"
      dataAttrs={{ "data-annotation-id": popover.annotationId }}
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
          className="ito-area-figure-preview"
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
          <button
            data-testid="promote-to-node-btn"
            className="ito-ctx-item"
            onClick={() => {
              void wb.promoteAnnotationToNode(popover.annotationId).then(() => {
                bump();
                onClose();
              });
            }}
          >
            <span className="ito-ctx-item-icon" aria-hidden="true">
              {Icons.nodes}
            </span>
            <span className="ito-ctx-item-label">Promote to Observation Node</span>
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
    </Popover>
  );
}

/** M9 name for the annotation edit popover. */
export const AnnotationPopover = HighlightEditPopover;
