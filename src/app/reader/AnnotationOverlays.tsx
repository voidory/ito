import { useEffect, useMemo, useState } from "react";
import { Icons } from "../ui/icons";
import { Popover } from "../ui/primitives";
import type { AnnotationId, AreaAnchor, ChemicalMechanismSpec, ElectronFlowArrow } from "../../model";
import {
  convertLatexToMathML,
  copyScienceToWordClipboard,
  extractMechanismFromRegion,
  figureCharsFromSpans,
  loadRasterFromDataUrl,
  renderMechanismSvg,
} from "../../pdf/scienceOcr";
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
  const areaAnchor =
    view && view.annotation.scope.kind === "area" ? view.annotation.scope.anchor : undefined;
  const imageDataUrl = areaAnchor?.imageDataUrl;
  const [menuMode, setMenuMode] = useState<null | "associate" | "insert" | "link">(null);

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
      {/* M17 (§3.1) crop-to-science actions: extract/edit LaTeX math and
          SMILES/mechanism, preview + copy-for-Word, and an inline curly-arrow
          builder. Science data lives on the AREA anchor (a cropped figure /
          scheme region), so the panel is shown ONLY for area annotations —
          where setAnnotationScienceData actually persists. */}
      {areaAnchor && (
        <SciencePanel
          wb={wb}
          annotationId={popover.annotationId}
          latex={areaAnchor.latex}
          smiles={areaAnchor.smiles}
          mechanism={areaAnchor.mechanism}
          anchor={areaAnchor}
          bump={bump}
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
          {/* M14–M16 (FEAT-001): DIRECT highlight-to-highlight linking — pick a
              second highlight and synthesise an Observation Node citing both
              with a bridging note between them. */}
          <button
            data-testid="link-highlights-btn"
            className="ito-ctx-item"
            onClick={() => setMenuMode("link")}
          >
            <span className="ito-ctx-item-icon" aria-hidden="true">
              {Icons.link}
            </span>
            <span className="ito-ctx-item-label">Link with another highlight…</span>
          </button>
          <ShowInNodes wb={wb} annotationId={popover.annotationId} bump={bump} asMenuRow />
        </div>
      )}
      {(menuMode === "associate" || menuMode === "insert") && (
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
      {menuMode === "link" && (
        <LinkHighlightPicker
          wb={wb}
          fromAnnotationId={popover.annotationId}
          onClose={() => setMenuMode(null)}
          onLinked={() => {
            bump();
            onClose();
          }}
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

/**
 * M17 (§3.1) the Reader popover's crop-to-science panel. Extract/edit LaTeX
 * math and SMILES/mechanism on an (area) annotation, preview the compiled math
 * + the live curly-arrow mechanism `<svg>`, add/toggle `full`/`fishhook`
 * electron-pushing arrows, and 1-click copy either payload for Microsoft Word.
 * All persistence routes through {@link Workbench.setAnnotationScienceData}.
 */
function SciencePanel({
  wb,
  annotationId,
  latex,
  smiles,
  mechanism,
  anchor,
  bump,
}: {
  wb: Workbench;
  annotationId: AnnotationId;
  latex?: string | undefined;
  smiles?: string | undefined;
  mechanism?: ChemicalMechanismSpec | undefined;
  anchor?: AreaAnchor | undefined;
  bump: () => void;
}): JSX.Element {
  const [editing, setEditing] = useState<null | "latex" | "chem">(null);
  const [extractStatus, setExtractStatus] = useState<string | null>(null);

  // Read the mechanism out of the captured figure itself: bonds/atoms keep
  // their printed positions, curly arrows are detected and snapped, and any
  // label text the PDF carries inside the crop names the heteroatoms.
  const autoExtract = async (): Promise<void> => {
    const url = anchor?.imageDataUrl;
    if (!anchor || !url) return;
    setExtractStatus("Reading figure…");
    const image = await loadRasterFromDataUrl(url);
    if (!image) {
      setExtractStatus("This figure has no pixel capture to read — re-crop it from the page.");
      return;
    }
    const page = wb
      .rawData()
      .sources.find((s) => s.id === anchor.docId)
      ?.cachedPages?.find((p) => p.pageIndex === anchor.pageIndex);
    const ocrChars = page ? figureCharsFromSpans(page.spans, anchor.rect) : [];
    const spec = extractMechanismFromRegion({ image, ...(ocrChars.length > 0 ? { ocrChars } : {}) });
    const bondCount = spec.bonds2D?.length ?? 0;
    if (bondCount === 0 && spec.arrows.length === 0) {
      setExtractStatus("No bonds or curly arrows found in this figure.");
      return;
    }
    await wb.setAnnotationScienceData(annotationId, { smiles: spec.smiles, mechanism: spec });
    setSmilesDraft(spec.smiles);
    setExtractStatus(
      `Found ${bondCount} bond${bondCount === 1 ? "" : "s"} and ${spec.arrows.length} curly arrow${
        spec.arrows.length === 1 ? "" : "s"
      }.`,
    );
    bump();
  };
  const [latexDraft, setLatexDraft] = useState(latex ?? "");
  const [smilesDraft, setSmilesDraft] = useState(smiles ?? mechanism?.smiles ?? "");

  const mechSpec: ChemicalMechanismSpec | undefined = useMemo(() => {
    if (mechanism) return mechanism;
    if (smiles) return { smiles, arrows: [] };
    return undefined;
  }, [mechanism, smiles]);

  const svgMarkup = useMemo(
    () => (mechSpec ? renderMechanismSvg(mechSpec) : null),
    [mechSpec],
  );
  const mathPreview = useMemo(
    () => (latex ? convertLatexToMathML(latex) : null),
    [latex],
  );

  const saveLatex = async (value: string): Promise<void> => {
    await wb.setAnnotationScienceData(annotationId, { latex: value });
    setEditing(null);
    bump();
  };
  const saveChem = async (value: string): Promise<void> => {
    // Keep an extracted 2D layout when only the SMILES text is being corrected;
    // without one, lay the scheme out once so the layout is stored, not re-derived.
    const spec: ChemicalMechanismSpec = mechanism?.atoms2D
      ? { ...mechanism, smiles: value }
      : { ...extractMechanismFromRegion({ smiles: value }), arrows: mechanism?.arrows ?? [] };
    await wb.setAnnotationScienceData(annotationId, { smiles: value, mechanism: spec });
    setEditing(null);
    bump();
  };

  const addCurlyArrow = async (barb: "full" | "fishhook"): Promise<void> => {
    const base = mechSpec ?? { smiles: smilesDraft || "C=C", arrows: [] };
    const ids = base.atoms2D?.map((a) => a.id) ?? [];
    const nextArrow: ElectronFlowArrow = {
      id: `a${base.arrows.length + 1}`,
      fromAtomOrBond: ids[0] ?? "C1",
      toAtomOrBond: ids[1] ?? "C2",
      barb,
    };
    const spec: ChemicalMechanismSpec = {
      ...base,
      arrows: [...base.arrows, nextArrow],
    };
    await wb.setAnnotationScienceData(annotationId, { smiles: spec.smiles, mechanism: spec });
    bump();
  };

  return (
    <div data-testid="science-panel" className="ito-science-panel">
      <div className="ito-annot-popover-actions">
        <button
          type="button"
          data-testid="extract-latex-btn"
          className="ito-ctx-item"
          onClick={() => {
            setLatexDraft(latex ?? "");
            setEditing((m) => (m === "latex" ? null : "latex"));
          }}
        >
          <span className="ito-ctx-item-label">Extract / Edit LaTeX Math</span>
        </button>
        <button
          type="button"
          data-testid="extract-chem-btn"
          className="ito-ctx-item"
          onClick={() => {
            setSmilesDraft(smiles ?? mechanism?.smiles ?? "");
            setEditing((m) => (m === "chem" ? null : "chem"));
          }}
        >
          <span className="ito-ctx-item-label">Extract / Edit SMILES &amp; Mechanism</span>
        </button>
        {anchor?.imageDataUrl && (
          <button
            type="button"
            data-testid="auto-extract-mechanism-btn"
            className="ito-ctx-item"
            title="Redraw this figure as a vector mechanism: bonds, labels and curly arrows are read from the picture"
            onClick={() => void autoExtract()}
          >
            <span className="ito-ctx-item-label">Read mechanism from figure</span>
          </button>
        )}
      </div>
      {extractStatus && (
        <div data-testid="extract-mechanism-status" style={{ fontSize: "0.78rem", color: "#666", padding: "0.2rem 0.4rem" }}>
          {extractStatus}
        </div>
      )}

      {editing === "latex" && (
        <div className="ito-science-editor">
          <textarea
            data-testid="latex-input"
            value={latexDraft}
            onChange={(e) => setLatexDraft(e.target.value)}
            rows={2}
            placeholder="\frac{-b \pm \sqrt{b^2 - 4ac}}{2a}"
            style={{ width: "100%", fontFamily: "monospace" }}
          />
          <button data-testid="save-latex-btn" onClick={() => void saveLatex(latexDraft)}>
            Save LaTeX
          </button>
        </div>
      )}

      {editing === "chem" && (
        <div className="ito-science-editor">
          <textarea
            data-testid="smiles-input"
            value={smilesDraft}
            onChange={(e) => setSmilesDraft(e.target.value)}
            rows={2}
            placeholder="C=C.BrBr>>BrCCBr"
            style={{ width: "100%", fontFamily: "monospace" }}
          />
          <button data-testid="save-chem-btn" onClick={() => void saveChem(smilesDraft)}>
            Save SMILES
          </button>
        </div>
      )}

      {latex && (
        <div
          data-testid="annotation-latex-preview"
          className="ito-latex-preview"
          data-latex={latex}
          // The compiled MathML is a safe, self-generated string (no user HTML).
          dangerouslySetInnerHTML={{ __html: mathPreview ?? "" }}
        />
      )}
      {latex && (
        <button
          type="button"
          data-testid="copy-word-math-btn"
          className="ito-ctx-item"
          onClick={() => void copyScienceToWordClipboard({ kind: "math", latex })}
        >
          <span className="ito-ctx-item-label">Copy Math for Word</span>
        </button>
      )}

      {svgMarkup && (
        <>
          <div
            className="ito-chem-preview"
            // Self-generated SVG markup (renderMechanismSvg); no user HTML.
            dangerouslySetInnerHTML={{ __html: svgMarkup }}
          />
          <div className="ito-annot-popover-actions ito-curly-arrow-builder">
            <button
              type="button"
              data-testid="add-curly-arrow-btn"
              className="ito-ctx-item"
              onClick={() => void addCurlyArrow("full")}
            >
              <span className="ito-ctx-item-label">+ Curly Arrow (2e⁻ full)</span>
            </button>
            <button
              type="button"
              data-testid="add-fishhook-arrow-btn"
              className="ito-ctx-item"
              onClick={() => void addCurlyArrow("fishhook")}
            >
              <span className="ito-ctx-item-label">+ Fishhook (1e⁻)</span>
            </button>
          </div>
          <button
            type="button"
            data-testid="copy-word-chem-btn"
            className="ito-ctx-item"
            onClick={() =>
              mechSpec && void copyScienceToWordClipboard({ kind: "chem", spec: mechSpec })
            }
          >
            <span className="ito-ctx-item-label">Copy Mechanism SVG for Word</span>
          </button>
        </>
      )}
    </div>
  );
}

/**
 * M14–M16 (FEAT-001) a compact picker that lists every OTHER highlight so the
 * user can directly link two highlights into a single Observation Node (via
 * {@link Workbench.linkHighlightsToObservation}). It is the click-driven
 * equivalent of dragging one highlight fragment onto another.
 */
function LinkHighlightPicker({
  wb,
  fromAnnotationId,
  onClose,
  onLinked,
}: {
  wb: Workbench;
  fromAnnotationId: AnnotationId;
  onClose: () => void;
  onLinked: () => void;
}): JSX.Element {
  const others = wb.rawData().annotations.filter((a) => a.id !== fromAnnotationId);
  const labelFor = (id: AnnotationId): string => {
    const scope = wb.rawData().annotations.find((a) => a.id === id)?.scope;
    if (scope?.kind === "text") return scope.anchor.selectedText.slice(0, 48);
    if (scope?.kind === "pages")
      return `pp. ${scope.anchor.startPageIndex + 1}-${scope.anchor.endPageIndex + 1}`;
    return "Area highlight";
  };
  return (
    <div data-testid="link-highlight-picker" className="ito-annot-popover-actions">
      <div style={{ fontSize: "0.78rem", color: "#666", padding: "0.2rem 0.4rem" }}>
        Link this highlight with…
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: "11rem", overflow: "auto" }}>
        {others.map((a) => (
          <li key={a.id}>
            <button
              data-testid="link-highlight-option"
              data-annotation-id={a.id}
              className="ito-ctx-item"
              style={{ width: "100%", textAlign: "left" }}
              onClick={() => {
                void wb
                  .linkHighlightsToObservation(fromAnnotationId, a.id)
                  .then(() => onLinked());
              }}
            >
              <span className="ito-ctx-item-label">{labelFor(a.id)}</span>
            </button>
          </li>
        ))}
        {others.length === 0 && (
          <li data-testid="link-highlight-empty" style={{ color: "#888", padding: "0.3rem 0.4rem" }}>
            No other highlights to link yet
          </li>
        )}
      </ul>
      <button data-testid="link-highlight-cancel" className="ito-ctx-item" onClick={onClose}>
        <span className="ito-ctx-item-label">Cancel</span>
      </button>
    </div>
  );
}
