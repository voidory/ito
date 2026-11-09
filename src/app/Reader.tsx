import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  createAnchor,
  cropCanvasRegionToDataUrl,
  hitTestAnnotations,
  installPointerSelection,
  loadDocument,
  renderPage,
  resolveAnchor,
  type HitTestTarget,
  type RenderedPage,
} from "../pdf";
import type { NormalizedRect } from "../model";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { AnchorResolution, AnnotationId, PageId, SourceId, TextAnchor } from "../model";
import {
  type AnnotationStyle,
  type HighlightColor,
  type Workbench,
} from "./workbench";
import { SubjectEditor } from "./SubjectEditor";
import { importPdfFiles } from "./pdfImport";
import { ReaderToolbar, type ActiveTool } from "./reader/ReaderToolbar";
import { AnnotationSidebar } from "./reader/AnnotationSidebar";
import { LeftSidebar } from "./reader/LeftSidebar";
import {
  anchorRectFrom,
  clampZoom,
  cssEscapeId,
  drawAnnotation,
  sanitizeSnapshotHtml,
  serializedRerender,
  swatch,
  styles,
  AssociationMenu,
  BinaryOffloadedPopover,
  CommentSurface,
  HighlightEditPopover,
  LiveSelectionPreview,
  ReaderContextMenu,
  SelectionToolbar,
  type AnchorRect,
  type ContextMenuState,
  type EditPopoverState,
  type MenuState,
  type OffloadedPopover as OffloadedPopoverState,
  type ToolbarState,
} from "./reader/AnnotationOverlays";

/*
 * M9 (FEAT-001): the reader annotation OVERLAYS, the right-panel SIDEBAR and the
 * single TOOLBAR now live in src/app/reader/*. Reader.tsx remains the shell +
 * state owner and re-exports the moved symbols so existing imports (tests +
 * testApi.ts) keep resolving unchanged.
 */
export {
  anchorRectFrom,
  clampFixedAnchor,
  clampZoom,
  drawAnnotation,
  sanitizeSnapshotHtml,
  serializedRerender,
  AssociationMenu,
  BinaryOffloadedPopover,
  CommentSurface,
  HighlightEditPopover,
  LiveSelectionPreview,
  ReaderContextMenu,
  SelectionToolbar,
} from "./reader/AnnotationOverlays";
export type {
  AnchorRect,
  ContextMenuState,
  EditPopoverState,
  MenuState,
  OffloadedPopover,
  ToolbarState,
} from "./reader/AnnotationOverlays";

/**
 * Imperative commands the single reader toolbar drives on the primary source
 * pane (zoom / paging / find). The pane registers an implementation via
 * `registerCommands`; the shell calls them from the toolbar buttons.
 */
export interface PaneCommands {
  readonly zoomIn: () => void;
  readonly zoomOut: () => void;
  readonly resetZoom: () => void;
  readonly fitWidth: () => void;
  readonly goToPage: (pageNumber: number) => void;
  readonly openFind: () => void;
  /** The live pdf.js document for the left-sidebar thumbnails/outline. */
  readonly getDoc: () => PDFDocumentProxy | null;
}

/** A pending source-return request (spec section 8.2, A17). */
interface ReturnTarget {
  readonly sourceId: SourceId;
  readonly anchor: TextAnchor | null;
  readonly pageIndex: number;
  readonly resolution: AnchorResolution;
  /** Monotonic nonce so repeat returns to the same quote re-trigger the scroll. */
  readonly nonce: number;
}

/**
 * FEAT-003 (3.3) a requestAnimationFrame scroll coalescer. Scrolling the
 * SourcePane used to call the root bump() on EVERY scroll tick, which forces a
 * whole-app re-render (every open pane, the subject editor, the network search)
 * on each wheel/touch frame. The inter-pane evidence lines already recompute
 * themselves from a local, rAF-coalesced scroll listener (PassageEvidenceLines)
 * and the per-page highlight overlays are painted directly into the DOM, so the
 * scroll handler never needs to go through React at all.
 *
 * This helper keeps at most ONE frame scheduled at a time: repeated schedule()
 * calls within a single frame collapse into a single `onFrame` invocation, and
 * cancel() tears the pending frame down on unmount. It is pure (no React) so it
 * can be unit-tested headlessly, and it NEVER calls bump().
 */
export interface ScrollCoalescer {
  /** Request an `onFrame` run on the next animation frame (coalesced). */
  readonly schedule: () => void;
  /** Cancel any pending frame (call on unmount). */
  readonly cancel: () => void;
}

export function createScrollCoalescer(onFrame: () => void): ScrollCoalescer {
  let frame = 0;
  const raf =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (cb: FrameRequestCallback): number => setTimeout(() => cb(0), 16) as unknown as number;
  const caf =
    typeof cancelAnimationFrame === "function"
      ? cancelAnimationFrame
      : (handle: number): void => clearTimeout(handle);
  const schedule = (): void => {
    // A frame is already pending: coalesce this tick into it (do not stack).
    if (frame !== 0) return;
    frame = raf(() => {
      frame = 0;
      onFrame();
    });
  };
  const cancel = (): void => {
    if (frame !== 0) {
      caf(frame);
      frame = 0;
    }
  };
  return { schedule, cancel };
}

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
  openSubjectPageId,
  suppressMotion,
  highlightsTabOpen,
  onToggleTab,
  onToggleMotion,
  onBackToLibrary,
  bump,
}: {
  wb: Workbench;
  openSourceIds: readonly SourceId[];
  openSubjectPageId: PageId | null;
  suppressMotion: boolean;
  highlightsTabOpen: boolean;
  onToggleTab: (open: boolean) => void;
  onToggleMotion: (suppress: boolean) => void;
  onBackToLibrary: () => void;
  bump: () => void;
}): JSX.Element {
  const together = openSourceIds.length > 1;
  const [returnTarget, setReturnTarget] = useState<ReturnTarget | null>(null);
  const [returnNotice, setReturnNotice] = useState<string | null>(null);
  // A17/D02: when a followed quote resolves to 'binary-offloaded' we surface a
  // popover that renders the stored quote + comment + page number + source
  // title and offers "Attach PDF Binary". The citation still functions from
  // this stored metadata; attaching re-hydrates the live render.
  const [offloadedPopover, setOffloadedPopover] = useState<OffloadedPopoverState | null>(null);
  const nonceRef = useRef(0);
  const readerPdfInputRef = useRef<HTMLInputElement>(null);

  // FEAT-001/002 tool-first state owned by the reader shell. The active tool
  // persists until toggled off or Esc; the active colour drives immediate
  // highlight/underline commits (1-4) and the no-tool popup default.
  const [activeTool, setActiveTool] = useState<ActiveTool>(null);
  const [activeColor, setActiveColor] = useState<HighlightColor>("yellow");
  // FEAT-002: the annotation selected from the sidebar (flashed + card-active).
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<AnnotationId | null>(null);
  // FEAT-002: the left sidebar (Thumbnails / Outline), toggled from the toolbar.
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(false);

  // Scroll the reader to an annotation's page, flash its overlay, and mark it
  // selected (sidebar card click). The flash reuses a short-lived CSS class on
  // the overlay container keyed by data-annotation-id.
  const selectAnnotation = useCallback(
    (annotationId: AnnotationId, pageNumber: number) => {
      setSelectedAnnotationId(annotationId);
      paneCommandsRef.current?.goToPage(pageNumber);
      if (typeof document !== "undefined") {
        const el = document.querySelector<HTMLElement>(
          `[data-annotation-id="${cssEscapeId(annotationId)}"]`,
        );
        if (el) {
          el.classList.add("ito-highlight-flash");
          window.setTimeout(() => el.classList.remove("ito-highlight-flash"), 1200);
        }
      }
    },
    [],
  );

  // The primary source pane registers its imperative zoom/paging/find commands
  // here so the single reader toolbar can drive them; it reports zoom/page back
  // up via onNavChange. A single-document reader (the default) wires one pane.
  const paneCommandsRef = useRef<PaneCommands | null>(null);
  const [nav, setNav] = useState<{ zoom: number; page: number; pageCount: number }>({
    zoom: 1,
    page: 1,
    pageCount: 1,
  });

  // Global keyboard: colours 1-4, tools H/U/N/A, Esc clears the tool. Ignored
  // while typing in an input/textarea/contenteditable so the comment box and
  // page input keep working.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null;
      const typing =
        !!t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable);
      if (e.key === "Escape") {
        setActiveTool(null);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const colorKeys: Record<string, HighlightColor> = {
        "1": "yellow",
        "2": "green",
        "3": "blue",
        "4": "pink",
      };
      if (colorKeys[e.key]) {
        setActiveColor(colorKeys[e.key]!);
        return;
      }
      const toolKeys: Record<string, Exclude<ActiveTool, null>> = {
        h: "highlight",
        u: "underline",
        n: "note",
        a: "area",
      };
      const tool = toolKeys[e.key.toLowerCase()];
      if (tool) setActiveTool((cur) => (cur === tool ? null : tool));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Local-PDF import from the Reader header (same hash + numPages + importSource
  // path as the Library button). Resets the input so the same file re-imports.
  const importReaderFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const count = await importPdfFiles(wb, Array.from(files));
      if (count > 0) bump();
    },
    [wb, bump],
  );

  // Source-return (A17): resolve the evidence's live source WITHOUT closing the
  // subject page. A changed/missing version produces an explicit notice and
  // never navigates to unrelated content.
  const followSource = useCallback(
    (evidenceId: string) => {
      const resolved = wb.resolveEvidenceSource(evidenceId);
      if (!resolved) return;
      nonceRef.current += 1;
      // A17: a binary-offloaded resolution does NOT navigate to unrelated
      // content; it opens a popover with the stored quote/comment/page/title
      // and an "Attach PDF Binary" action to re-hydrate the live render.
      if (resolved.resolution.kind === "binary-offloaded") {
        const data = wb.rawData();
        const evidence = data.evidenceInstances.find((e) => e.id === evidenceId);
        const annotation = data.annotations.find(
          (a) => a.id === evidence?.annotationId,
        );
        const source = data.sources.find((s) => s.id === resolved.sourceId);
        const pageIndex = resolved.anchor?.pageIndex ?? resolved.scopeStartPageIndex;
        setReturnNotice(null);
        setReturnTarget(null);
        // A binary-offloaded resolution always carries a real source id (the
        // annotation + source still exist; only the PDF bytes were evicted).
        setOffloadedPopover({
          evidenceId,
          sourceId: resolved.sourceId!,
          sourceTitle: source?.title ?? "Source",
          quotedText: evidence?.quotedText ?? "",
          comment: annotation?.comment ?? "",
          pageNumber: pageIndex + 1,
          reason: resolved.resolution.reason,
        });
        return;
      }
      if (resolved.resolution.kind !== "resolved") {
        setReturnNotice(
          resolved.resolution.kind === "mismatched"
            ? "The source version changed since this quote was captured; the exact passage could not be located."
            : `The source passage is unavailable: ${resolved.resolution.reason}.`,
        );
        // A deleted annotation resolves with a null sourceId: there is nowhere
        // to navigate, so show only the notice and clear any prior target.
        if (resolved.sourceId == null) {
          setReturnTarget(null);
          return;
        }
        setReturnTarget({
          sourceId: resolved.sourceId,
          anchor: resolved.anchor,
          pageIndex: resolved.anchor?.pageIndex ?? resolved.scopeStartPageIndex,
          resolution: resolved.resolution,
          nonce: nonceRef.current,
        });
        return;
      }
      setReturnNotice(null);
      if (resolved.sourceId == null) {
        setReturnTarget(null);
        return;
      }
      setReturnTarget({
        sourceId: resolved.sourceId,
        anchor: resolved.anchor,
        pageIndex: resolved.anchor?.pageIndex ?? resolved.scopeStartPageIndex,
        resolution: resolved.resolution,
        nonce: nonceRef.current,
      });
    },
    [wb],
  );

  // Make sure the source the quote points at is actually open; if it is not in
  // the current workspace, open it alongside (still never replaces the subject).
  useEffect(() => {
    if (returnTarget && !openSourceIds.includes(returnTarget.sourceId)) {
      wb.openSource(returnTarget.sourceId);
      bump();
    }
  }, [returnTarget, openSourceIds, wb, bump]);

  const subjectOpen = openSubjectPageId != null;
  // Scroll containers for each pane so lines can be re-routed on scroll and the
  // integrated workspace scrolls panes INDEPENDENTLY (section 8.2).
  const paneScrollRefs = useRef<Map<string, HTMLElement>>(new Map());
  const bodyRef = useRef<HTMLDivElement>(null);
  const linesVisible = wb.snapshot().workspaceLayout.linesVisible;

  // Narrow-screen (phone) responsive detection. A squeezed three-pane
  // miniature is explicitly NOT attempted; narrow screens get a documented
  // single-column flow stub instead (section 8.2).
  const [narrow, setNarrow] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.innerWidth < 760 : false,
  );
  useEffect(() => {
    const onResize = (): void => setNarrow(window.innerWidth < 760);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // The ordered pane slots: each open source is a reader pane; the open subject
  // page is the middle composition pane. The approved arrangement interleaves
  // the subject between sources (Paper A | subject | Paper B) when two sources
  // are open together; otherwise it trails the single source.
  const paneSlots: { slotId: string; kind: "source" | "subject"; sourceId?: SourceId }[] =
    (() => {
      const sources = openSourceIds.map((id) => ({
        slotId: id as string,
        kind: "source" as const,
        sourceId: id,
      }));
      if (!subjectOpen) return sources;
      const subjectPane = { slotId: "subject", kind: "subject" as const };
      if (sources.length >= 2) {
        return [sources[0]!, subjectPane, ...sources.slice(1)];
      }
      return [...sources, subjectPane];
    })();

  const registerPaneScroll = useCallback((slotId: string, el: HTMLElement | null) => {
    if (el) paneScrollRefs.current.set(slotId, el);
    else paneScrollRefs.current.delete(slotId);
  }, []);

  const primaryTitle =
    (openSourceIds[0] && wb.rawData().sources.find((s) => s.id === openSourceIds[0])?.title) ||
    "Reader";
  const switchable = wb
    .rawData()
    .sources.filter((s) => !openSourceIds.includes(s.id));

  return (
    <div data-testid="reader" data-view="reader" style={styles.root}>
      <ReaderToolbar
        title={primaryTitle}
        sidebarOpen={highlightsTabOpen}
        onToggleSidebar={() => onToggleTab(!highlightsTabOpen)}
        leftSidebarOpen={leftSidebarOpen}
        onToggleLeftSidebar={() => setLeftSidebarOpen((v) => !v)}
        onBackToLibrary={onBackToLibrary}
        activeTool={activeTool}
        onToggleTool={(t) => setActiveTool((cur) => (cur === t ? null : t))}
        activeColor={activeColor}
        onSetColor={setActiveColor}
        zoom={nav.zoom}
        onZoomOut={() => paneCommandsRef.current?.zoomOut()}
        onZoomIn={() => paneCommandsRef.current?.zoomIn()}
        onResetZoom={() => paneCommandsRef.current?.resetZoom()}
        onFitWidth={() => paneCommandsRef.current?.fitWidth()}
        page={nav.page}
        pageCount={nav.pageCount}
        onGoToPage={(n) => paneCommandsRef.current?.goToPage(n)}
        onPrevPage={() => paneCommandsRef.current?.goToPage(Math.max(1, nav.page - 1))}
        onNextPage={() => paneCommandsRef.current?.goToPage(Math.min(nav.pageCount, nav.page + 1))}
        onOpenFind={() => paneCommandsRef.current?.openFind()}
        suppressMotion={suppressMotion}
        linesVisible={linesVisible}
        onToggleMotion={() => onToggleMotion(!suppressMotion)}
        onToggleLines={() => {
          wb.setLinesVisible(!linesVisible);
          bump();
        }}
        onSwitchPaper={
          switchable.length > 0
            ? () => {
                const to = switchable[0]!.id;
                if (openSourceIds[0]) wb.switchReaderPane(openSourceIds[0], to);
                bump();
              }
            : undefined
        }
        onImportPdf={() => readerPdfInputRef.current?.click()}
      />
      <input
        ref={readerPdfInputRef}
        data-testid="import-pdf-input"
        type="file"
        accept=".pdf,application/pdf"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          void importReaderFiles(e.target.files);
          e.target.value = "";
        }}
      />
      {together && (
        <div
          data-testid="open-together-indicator"
          style={{
            padding: "2px 10px",
            fontSize: "0.78rem",
            color: "var(--ito-muted)",
            borderBottom: "1px solid var(--ito-border)",
            background: "var(--ito-bg-paper)",
          }}
        >
          Shared workspace · no analysis
        </div>
      )}

      {returnNotice && (
        <div data-testid="source-return-notice" role="alert" style={styles.returnNotice}>
          {returnNotice}
          <button
            data-testid="dismiss-return-notice"
            aria-label="Dismiss"
            onClick={() => setReturnNotice(null)}
            style={{ marginLeft: "0.5rem" }}
          >
            ×
          </button>
        </div>
      )}

      {offloadedPopover && (
        <BinaryOffloadedPopover
          wb={wb}
          popover={offloadedPopover}
          onClose={() => setOffloadedPopover(null)}
          onAttached={() => {
            setOffloadedPopover(null);
            // Re-follow so the now-cached source resolves + scrolls to the quote.
            followSource(offloadedPopover.evidenceId);
            bump();
          }}
        />
      )}

      <div
        data-testid="reader-body"
        data-tab-open={highlightsTabOpen ? "true" : "false"}
        data-subject-open={subjectOpen ? "true" : "false"}
        data-narrow={narrow ? "true" : "false"}
        data-pane-count={String(paneSlots.length)}
        style={styles.body}
        ref={bodyRef}
      >
        {leftSidebarOpen && !narrow && (
          <LeftSidebar
            doc={paneCommandsRef.current?.getDoc() ?? null}
            pageCount={nav.pageCount}
            currentPage={nav.page}
            onJump={(n) => paneCommandsRef.current?.goToPage(n)}
          />
        )}
        <main
          data-testid="reader-main"
          data-together={together ? "true" : "false"}
          data-layout={narrow ? "stacked" : "panes"}
          style={{
            ...styles.main,
            flexDirection: narrow ? "column" : "row",
            flexWrap: "nowrap",
            // The reading area always fills the space left by whichever side
            // panels are open; pages re-fit to it (see the fit-to-pane effect).
            maxWidth: "none",
            margin: 0,
          }}
        >
          {narrow && (
            <div data-testid="responsive-flow-stub" style={styles.responsiveStub} role="note">
              Narrow screen: the three-pane editing workspace stacks into a
              single-column flow. Panes appear in order (source → subject →
              source) rather than as a squeezed miniature. Side-by-side editing
              is a wide-screen experience (see docs/MILESTONE-MATRIX.md).
            </div>
          )}

          {paneSlots.map((slot, i) => (
            <PaneGroup
              key={slot.slotId}
              last={i === paneSlots.length - 1}
              narrow={narrow}
              weight={wb.paneWidth(slot.slotId)}
              onResize={(weight) => {
                wb.setPaneWidth(slot.slotId, weight);
                bump();
              }}
              slotId={slot.slotId}
            >
              {slot.kind === "source" ? (
                <SourcePane
                  wb={wb}
                  sourceId={slot.sourceId!}
                  suppressMotion={suppressMotion}
                  onToggleMotion={onToggleMotion}
                  returnTarget={
                    returnTarget && returnTarget.sourceId === slot.sourceId
                      ? returnTarget
                      : null
                  }
                  openSourceIds={openSourceIds}
                  registerScroll={(el) => registerPaneScroll(slot.slotId, el)}
                  activeTool={activeTool}
                  activeColor={activeColor}
                  onClearTool={() => setActiveTool(null)}
                  isPrimary={slot.sourceId === openSourceIds[0]}
                  registerCommands={
                    slot.sourceId === openSourceIds[0]
                      ? (c) => {
                          paneCommandsRef.current = c;
                        }
                      : undefined
                  }
                  onNavChange={
                    slot.sourceId === openSourceIds[0] ? setNav : undefined
                  }
                  bump={bump}
                />
              ) : (
                /* Subject editor sits ALONGSIDE the reader as a first-class
                   pane; source-return never closes or replaces it (A17). It is
                   NEVER hidden behind a modal while composing (section 8.2). */
                <div
                  style={{ height: "100%" }}
                  ref={(el) => registerPaneScroll("subject", el)}
                >
                  <SubjectEditor
                    wb={wb}
                    pageId={openSubjectPageId!}
                    onFollowSource={followSource}
                    onClose={() => {
                      wb.closeSubjectPage();
                      bump();
                    }}
                    bump={bump}
                  />
                </div>
              )}
            </PaneGroup>
          ))}

          {/* Passage-to-evidence lines route through the inter-pane margin and
              never obstruct readability (section 10.2). Presentation only. */}
          {subjectOpen && !narrow && (
            <PassageEvidenceLines
              wb={wb}
              bodyRef={bodyRef}
              paneScrollRefs={paneScrollRefs}
              visible={linesVisible}
              bump={bump}
            />
          )}
        </main>

        {/* Closed tab reserves ZERO width: the aside is not rendered at all. */}
        {highlightsTabOpen && (
          <AnnotationSidebar
            wb={wb}
            openSourceIds={openSourceIds}
            bump={bump}
            currentPage={nav.page}
            selectedAnnotationId={selectedAnnotationId}
            onSelectAnnotation={selectAnnotation}
          />
        )}
      </div>
    </div>
  );
}

/**
 * A pane wrapper that applies the pane's flex-grow WEIGHT (adjustable widths,
 * section 8.2) and renders a draggable divider after it (except the last pane).
 * The weight ratio is the durable-across-transitions pane configuration (R19);
 * dragging the divider calls back into the Workbench so the ratio survives
 * layout changes.
 */
function PaneGroup({
  children,
  last,
  narrow,
  weight,
  onResize,
  slotId,
}: {
  children: React.ReactNode;
  last: boolean;
  narrow: boolean;
  weight: number;
  onResize: (weight: number) => void;
  slotId: string;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      dragging.current = true;
      const startX = e.clientX;
      const startWidth = ref.current?.getBoundingClientRect().width ?? 1;
      const startWeight = weight;
      const move = (ev: PointerEvent): void => {
        if (!dragging.current) return;
        const dx = ev.clientX - startX;
        // Convert pixel delta into a proportional weight change.
        const factor = (startWidth + dx) / Math.max(1, startWidth);
        onResize(Math.max(0.15, startWeight * factor));
      };
      const up = (): void => {
        dragging.current = false;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [weight, onResize],
  );

  return (
    <>
      <div
        ref={ref}
        data-testid="workspace-pane"
        data-slot-id={slotId}
        style={{
          flex: narrow ? "1 1 auto" : `${weight} 1 0`,
          minWidth: 0,
          minHeight: narrow ? "60vh" : 0,
          height: narrow ? "auto" : "100%",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {children}
      </div>
      {!last && !narrow && (
        <div
          data-testid="pane-divider"
          data-slot-id={slotId}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize pane"
          onPointerDown={onPointerDown}
          style={styles.divider}
        />
      )}
    </>
  );
}

/** FEAT-002 (2.4b) the live rubber-band box while dragging an area selection. */
interface AreaDragState {
  readonly pageIndex: number;
  /** Normalized (0..1) rect relative to the originating pdf-page-stage. */
  readonly rect: NormalizedRect;
}

function SourcePane({
  wb,
  sourceId,
  suppressMotion,
  onToggleMotion,
  returnTarget,
  openSourceIds,
  registerScroll,
  activeTool,
  activeColor,
  onClearTool,
  isPrimary,
  registerCommands,
  onNavChange,
  bump,
}: {
  wb: Workbench;
  sourceId: SourceId;
  suppressMotion: boolean;
  onToggleMotion: (suppress: boolean) => void;
  returnTarget: ReturnTarget | null;
  openSourceIds: readonly SourceId[];
  registerScroll: (el: HTMLElement | null) => void;
  activeTool: ActiveTool;
  activeColor: HighlightColor;
  onClearTool: () => void;
  isPrimary: boolean;
  registerCommands?: ((commands: PaneCommands) => void) | undefined;
  onNavChange?: ((nav: { zoom: number; page: number; pageCount: number }) => void) | undefined;
  bump: () => void;
}): JSX.Element {
  const onToggleMotionForPane = onToggleMotion;
  const linesVisibleForPane = wb.snapshot().workspaceLayout.linesVisible;
  const mountRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLElement | null>(null);
  const pagesRef = useRef<RenderedPage[]>([]);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const [ready, setReady] = useState(false);
  const [toolbar, setToolbar] = useState<ToolbarState | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [rangeMode, setRangeMode] = useState(false);
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(0);
  const [openComment, setOpenComment] = useState<AnnotationId | null>(null);
  // FEAT-002 (2.2a) the 1-click highlight edit popover, anchored fixed.
  const [editPopover, setEditPopover] = useState<EditPopoverState | null>(null);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<AnnotationId | null>(null);
  // FEAT-002 (2.2b) the right-click context menu (annotation or page variant).
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  // FEAT-001/002 Zotero-style area cropper. Area-select is now driven by the
  // tool-first model: it is active exactly when the shell's Area tool is on.
  const areaSelectActive = activeTool === "area";
  const [areaDrag, setAreaDrag] = useState<AreaDragState | null>(null);
  const areaDragRef = useRef<{ pageIndex: number; startX: number; startY: number } | null>(null);
  // FEAT-002 (2.3) the page whose text selection is active (locks other pages).
  const [activeSelectionPage, setActiveSelectionPage] = useState<number | null>(null);
  // FEAT-002 (2.3a) live watercolor selection preview pills (viewport rects).
  const [livePreview, setLivePreview] = useState<{ color: string; rects: AnchorRect[] } | null>(
    null,
  );
  // FEAT-002 (2.5) native PDF zoom scale (50%..300%), locked 1:1 across layers.
  const BASE_ZOOM = 1.3;
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  // M6 (D01): per-page PDF scope status (scanned / encrypted) surfaced below.
  const [scopeStatus, setScopeStatus] = useState<string | null>(null);
  // M6 (A15, D11): the website snapshot HTML text, when this source is a
  // website rather than a PDF (rendered with full selection/highlighting).
  const [websiteHtml, setWebsiteHtml] = useState<string | null>(null);

  const source = wb.rawData().sources.find((s) => s.id === sourceId);
  const isWebsite = source?.kind === "website" || source?.type === "website";

  const selectedRef = useRef<AnnotationId | null>(null);
  // Live on-screen box of an annotation (union of its drawn fragments), so the
  // edit popover can follow its highlight while the page scrolls.
  const resolvePopoverAnchor = useCallback((id: AnnotationId): AnchorRect | null => {
    const mount = mountRef.current;
    if (!mount) return null;
    const id_ = cssEscapeId(id);
    // Only the drawn pieces (text fragments, area box, range border) — the
    // `.ito-highlight` wrapper itself spans the whole page.
    const els = mount.querySelectorAll(
      `.ito-highlight[data-annotation-id="${id_}"] .ito-highlight-fragment, ` +
        `.ito-highlight[data-annotation-id="${id_}"] .ito-highlight-area, ` +
        `.ito-highlight[data-annotation-id="${id_}"] .ito-highlight-border`,
    );
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const el of Array.from(els)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      left = Math.min(left, r.left);
      top = Math.min(top, r.top);
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    }
    if (!Number.isFinite(left)) return null;
    return { left, top, right, bottom, width: right - left };
  }, []);
  const redrawOverlays = useCallback(() => {
    const views = wb.annotationsForSource(sourceId);
    for (const page of pagesRef.current) {
      page.stage
        .querySelectorAll(".ito-highlight")
        .forEach((el) => el.remove());
    }
    for (const view of views) {
      drawAnnotation(view, pagesRef.current, suppressMotion, false);
    }
    // FEAT-002 (2.2a) re-apply the active accent outline after a redraw removed
    // and recreated the fragments.
    const sel = selectedRef.current;
    const mount = mountRef.current;
    if (sel && mount) {
      mount
        .querySelectorAll(`.ito-highlight[data-annotation-id="${cssEscapeId(sel)}"]`)
        .forEach((el) => el.setAttribute("data-selected", "true"));
    }
  }, [wb, sourceId, suppressMotion]);

  // FEAT-003 (3.3) rAF-coalesced LOCAL scroll handling. Scrolling re-paints the
  // per-page highlight overlays directly into the DOM (redrawOverlays) so they
  // stay pinned to their pages; it NEVER calls the root bump(), so scrolling a
  // reader pane no longer forces a whole-app re-render. The inter-pane evidence
  // lines are updated separately by PassageEvidenceLines' own scroll listener.
  // A single frame is scheduled at a time and torn down on unmount.
  const redrawOverlaysRef = useRef(redrawOverlays);
  redrawOverlaysRef.current = redrawOverlays;
  const scrollCoalescerRef = useRef<ScrollCoalescer | null>(null);
  if (scrollCoalescerRef.current === null) {
    scrollCoalescerRef.current = createScrollCoalescer(() => {
      redrawOverlaysRef.current();
    });
  }
  const onPaneScroll = useCallback(() => {
    scrollCoalescerRef.current?.schedule();
  }, []);
  useEffect(() => {
    const coalescer = scrollCoalescerRef.current;
    return () => coalescer?.cancel();
  }, []);

  // Render the document pages once.
  useEffect(() => {
    let cancelled = false;
    const mount = mountRef.current;
    if (!mount) return;
    (async () => {
      const bytes = await wb.readSourceBytes(sourceId);
      if (!bytes || cancelled) return;
      // M6 (A15, D11): a website source renders its stored snapshot HTML as a
      // single selectable page (full text selection + highlighting + quoting),
      // never a pdf.js document.
      if (isWebsite) {
        const html = new TextDecoder().decode(bytes);
        if (cancelled) return;
        setWebsiteHtml(html);
        setReady(true);
        return;
      }
      let doc: PDFDocumentProxy;
      try {
        doc = await loadDocument(bytes);
      } catch (err) {
        // M6 (D01): an encrypted PDF cannot be opened without a password.
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        if (/password|encrypt/i.test(msg)) {
          setScopeStatus("Encrypted PDF - password required");
          setReady(true);
          return;
        }
        throw err;
      }
      docRef.current = doc;
      mount.replaceChildren();
      const pages: RenderedPage[] = [];
      for (let p = 1; p <= doc.numPages; p++) {
        const rp = await renderPage(doc, p, mount, 1.3);
        rp.container.dataset.pageIndex = String(p - 1);
        rp.stage.dataset.pageIndex = String(p - 1);
        pages.push(rp);
      }
      if (cancelled) return;
      pagesRef.current = pages;
      setRangeEnd(doc.numPages - 1);
      // M6 (D01): a page with 0 selectable text items is a scanned/image PDF.
      if (pages.length > 0 && pages.every((p) => p.textItemCount === 0)) {
        setScopeStatus(
          "Scanned PDF (no selectable text layer) - use page-range or area annotations",
        );
      }
      // FIX-PAGECOUNT-BACKFILL (3.1 / D01): backfill a batch-ingested source's
      // pageCount (stored as 0) now that pdf.js knows the real page count.
      if (source && source.pageCount === 0) {
        void wb.updateSourcePageCount(sourceId, doc.numPages);
      }
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

  // FIX-PANE-CLIPPING (3.2): responsive fit-to-pane scaling. When the pane is
  // narrower than a rendered page, re-render each page at a scale that fits the
  // available width so PDF text never clips horizontally in 2-pane / 3-pane
  // layouts. The text layer re-renders with the stage (RenderedPage.rerender),
  // so glyphs + canvas + overlays stay aligned at the fitted scale. A
  // ResizeObserver keeps it in sync as dividers are dragged. Idempotent: it
  // only re-renders when the fitted scale meaningfully changes.
  // The current fit-to-pane TARGET scale (<= BASE_SCALE). It doubles as the
  // base multiplier the zoom composes with, so it starts at BASE_ZOOM (the
  // unzoomed base scale) and is narrowed by the ResizeObserver refit.
  const fittedScaleRef = useRef<number>(BASE_ZOOM);
  // Mirrors fittedScaleRef into state so the toolbar can show the real scale.
  const [fitScale, setFitScale] = useState<number>(BASE_ZOOM);
  useEffect(() => {
    if (!ready || isWebsite) return;
    const mount = mountRef.current;
    if (!mount) return;
    const scroll = mount.parentElement; // the pane-scroll container
    if (!scroll) return;
    let frame = 0;
    const BASE_SCALE = 1.3;
    // Fit-width may scale PAST the base render scale so a wide pane is filled
    // instead of leaving dead gutters; capped so a huge monitor does not render
    // an absurdly large canvas.
    const FIT_MAX = 2.6;
    const refit = (): void => {
      const pages = pagesRef.current;
      if (pages.length === 0) return;
      // Intrinsic (BASE_SCALE) width of a page = current stage width scaled
      // back to base. Use the first page as representative.
      const first = pages[0]!;
      const factor = first.textLayer
        ? Number(first.stage.style.getPropertyValue("--scale-factor")) || BASE_SCALE
        : BASE_SCALE;
      const intrinsicWidth = first.stage.getBoundingClientRect().width / factor;
      if (intrinsicWidth <= 0) return;
      // Available content width inside the scroll container (minus padding).
      const style = getComputedStyle(scroll);
      const padding =
        parseFloat(style.paddingLeft || "0") + parseFloat(style.paddingRight || "0");
      const avail = scroll.clientWidth - padding;
      if (avail <= 0) return;
      const target = Math.min(FIT_MAX, Math.max(0.4, avail / intrinsicWidth));
      if (Math.abs(target - fittedScaleRef.current) < 0.02) return;
      fittedScaleRef.current = target;
      setFitScale(target);
      // Compose the fit target with the CURRENT user zoom so a resize tick
      // after a zoom re-fits the width WITHOUT discarding the zoom. The applied
      // scale is the fit target scaled by the live zoom multiplier (zoom === 1
      // leaves the pure fit behavior unchanged).
      const applied = target * zoomRef.current;
      void (async () => {
        for (const page of pages) {
          await serializedRerender(page, applied);
        }
        redrawOverlays();
      })();
    };
    const schedule = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(refit);
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(scroll);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [ready, isWebsite, redrawOverlays]);

  // Source-return: scroll this pane to the exact passage and flash a transient
  // overlay re-derived from the live render (A17, spec section 8.2). For an
  // unresolved/mismatched return we still scroll to the recorded page but draw
  // NO fake highlight and leave the explicit notice (shown by the Reader) in
  // place — never a silent navigation to unrelated content.
  useEffect(() => {
    if (!ready || !returnTarget) return;
    const source = wb.rawData().sources.find((s) => s.id === sourceId);
    if (!source) return;
    const page = pagesRef.current.find(
      (p) => Number(p.container.dataset.pageIndex ?? "-1") === returnTarget.pageIndex,
    );
    if (!page) return;
    page.stage.querySelectorAll(".ito-return").forEach((el) => el.remove());
    page.container.scrollIntoView({
      behavior: suppressMotion ? "auto" : "smooth",
      block: "center",
    });
    page.container.setAttribute("data-return-target", "true");

    if (returnTarget.resolution.kind === "resolved" && returnTarget.anchor) {
      const resolved = resolveAnchor({
        anchor: returnTarget.anchor,
        currentVersionHash: source.versionHash,
        pageText: page.pageText,
        pageBox: page.pageBox(),
        rangeToClientRects: (s, e) => page.rangeToClientRects(s, e),
      });
      page.container.setAttribute("data-return-resolution", resolved.resolution.kind);
      if (resolved.resolution.kind === "resolved") {
        for (const r of resolved.rects) {
          const el = document.createElement("div");
          el.className = "ito-return";
          Object.assign(el.style, {
            position: "absolute",
            left: `${r.x * 100}%`,
            top: `${r.y * 100}%`,
            width: `${r.width * 100}%`,
            height: `${r.height * 100}%`,
            background: "rgba(26,86,219,0.25)",
            outline: "2px solid #1a56db",
            borderRadius: "3px",
            pointerEvents: "none",
          } satisfies Partial<CSSStyleDeclaration>);
          // Insert the return flash above the canvas, beneath the text layer.
          page.stage.insertBefore(el, page.textLayer);
        }
      }
    } else {
      page.container.setAttribute("data-return-resolution", returnTarget.resolution.kind);
    }
  }, [ready, returnTarget, wb, sourceId, suppressMotion]);

  // Capture a text selection inside this pane's text layers → portable anchor.
  // FEAT-002 (2.1): the toolbar is anchored to the selection's viewport rect so
  // it renders on the fixed layer near the text (never clipped by pane-scroll).
  const onMouseUp = useCallback(
    (e?: React.MouseEvent) => {
      if (rangeMode || areaSelectActive) return;
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
        // FEAT-002 (2) tool-first: with a Highlight/Underline tool active, the
        // annotation is created IMMEDIATELY with the active colour and NO
        // popup. With no tool active, show the single fallback popup; it must
        // never coexist with an open annotation popover.
        if (activeTool === "highlight" || activeTool === "underline") {
          void wb.commitTextAnnotation({
            sourceId,
            anchor,
            style: { kind: activeTool, color: activeColor },
          });
          window.getSelection()?.removeAllRanges();
          setToolbar(null);
          redrawOverlays();
          bump();
          return;
        }
        if (activeTool === "note" || activeTool === "area") {
          // Note/Area tools act on a page point/drag, not a text selection.
          setToolbar(null);
          return;
        }
        const rect = anchorRectFrom(
          range.getBoundingClientRect(),
          e?.clientX ?? 0,
          e?.clientY ?? 0,
        );
        setEditPopover(null);
        setToolbar({ sourceId, anchor, rect });
      } catch {
        setToolbar(null);
      }
    },
    [rangeMode, areaSelectActive, source, sourceId, activeTool, activeColor, wb, redrawOverlays, bump],
  );

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

  // FEAT-002 (2.2) build the hit-test targets for a page: each annotation on
  // that page as a set of NORMALIZED (0..1) rects relative to the stage. Last
  // annotation wins when overlapping (most-recently-committed on top), so we
  // iterate in reverse. Text -> anchor.rects, area -> [rect], range -> full
  // page (so a right-click anywhere on a ranged page targets it).
  const hitTargetsForPage = useCallback(
    (pageIndex: number): HitTestTarget[] => {
      const views = wb.annotationsForSource(sourceId);
      const targets: HitTestTarget[] = [];
      for (const view of views) {
        const scope = view.annotation.scope;
        if (scope.kind === "text" && scope.anchor.pageIndex === pageIndex) {
          targets.push({ id: view.annotation.id, rects: scope.anchor.rects });
        } else if (scope.kind === "area" && scope.anchor.pageIndex === pageIndex) {
          targets.push({ id: view.annotation.id, rects: [scope.anchor.rect] });
        } else if (
          scope.kind === "pages" &&
          pageIndex >= scope.anchor.startPageIndex &&
          pageIndex <= scope.anchor.endPageIndex
        ) {
          targets.push({
            id: view.annotation.id,
            rects: [{ x: 0, y: 0, width: 1, height: 1 }],
          });
        }
      }
      return targets.reverse();
    },
    [wb, sourceId],
  );

  // Convert a pointer event into (stage, pageIndex, normalized nx/ny) if the
  // event lands inside a rendered page stage. jsdom returns a zero-sized rect,
  // in which case normalized coordinates collapse to 0 (still deterministic).
  const stageHitAt = useCallback(
    (clientX: number, clientY: number): { pageIndex: number; nx: number; ny: number } | null => {
      for (const page of pagesRef.current) {
        const box = page.stage.getBoundingClientRect();
        const inside =
          box.width > 0 &&
          box.height > 0 &&
          clientX >= box.left &&
          clientX <= box.right &&
          clientY >= box.top &&
          clientY <= box.bottom;
        if (!inside) continue;
        const pageIndex = Number(page.container.dataset.pageIndex ?? "0");
        return {
          pageIndex,
          nx: (clientX - box.left) / box.width,
          ny: (clientY - box.top) / box.height,
        };
      }
      return null;
    },
    [],
  );

  // FEAT-002 (2.2a) 1-click a highlight: select it and open the anchored edit
  // popover. Only when the selection is collapsed (a drag selection never
  // triggers it). The popover anchors above the pointer.
  const onStageClick = useCallback(
    (clientX: number, clientY: number, target: HTMLElement | null) => {
      const sel = window.getSelection();
      if (sel && sel.isCollapsed === false) return; // a text selection drag
      const hit = stageHitAt(clientX, clientY);
      if (!hit) return;
      // FEAT-002 (2) Note tool: clicking a page point drops a small pin via
      // commitAreaAnnotation([nx, ny, 0.025, 0.025]) and opens the annotation
      // popover focused on the comment input. No model/schema change.
      if (activeTool === "note") {
        const pin: NormalizedRect = { x: hit.nx, y: hit.ny, width: 0.025, height: 0.025 };
        void (async () => {
          const view = await wb.commitAreaAnnotation(sourceId, hit.pageIndex, pin);
          onClearTool();
          setToolbar(null);
          setContextMenu(null);
          setSelectedAnnotationId(view.annotation.id);
          setEditPopover({
            annotationId: view.annotation.id,
            sourceId,
            rect: anchorRectFrom(null, clientX, clientY),
          });
          redrawOverlays();
          bump();
          // Focus the comment input once the popover mounts.
          requestAnimationFrame(() => {
            (
              document.querySelector(
                '[data-testid="highlight-edit-popover"] [data-testid="comment-input"]',
              ) as HTMLTextAreaElement | null
            )?.focus();
          });
        })();
        return;
      }
      const id = hitTestAnnotations(hitTargetsForPage(hit.pageIndex), hit.nx, hit.ny);
      if (!id) return;
      const rect = anchorRectFrom(
        target?.getBoundingClientRect() ?? null,
        clientX,
        clientY,
      );
      setSelectedAnnotationId(id as AnnotationId);
      setToolbar(null);
      setContextMenu(null);
      setEditPopover({ annotationId: id as AnnotationId, sourceId, rect });
    },
    [stageHitAt, hitTargetsForPage, sourceId, activeTool, wb, onClearTool, redrawOverlays, bump],
  );

  // FEAT-002 (2.2b) right-click: annotation variant over a hit, page variant
  // otherwise. Always preventDefault so the browser menu never appears.
  const onStageContextMenu = useCallback(
    (clientX: number, clientY: number): void => {
      const hit = stageHitAt(clientX, clientY);
      if (hit) {
        const id = hitTestAnnotations(hitTargetsForPage(hit.pageIndex), hit.nx, hit.ny);
        if (id) {
          setSelectedAnnotationId(id as AnnotationId);
          setContextMenu({
            variant: "annotation",
            annotationId: id as AnnotationId,
            sourceId,
            x: clientX,
            y: clientY,
          });
          return;
        }
      }
      setContextMenu({ variant: "page", sourceId, x: clientX, y: clientY });
    },
    [stageHitAt, hitTargetsForPage, sourceId],
  );

  // FEAT-002 (2.4b) commit an area annotation from a dragged normalized rect,
  // cropping the exact page-canvas region into a PNG (SVG fallback in jsdom).
  const commitAreaFromDrag = useCallback(
    async (pageIndex: number, rect: NormalizedRect) => {
      const page = pagesRef.current.find(
        (p) => Number(p.container.dataset.pageIndex ?? "-1") === pageIndex,
      );
      const imageDataUrl = cropCanvasRegionToDataUrl(page?.canvas ?? null, rect);
      await wb.commitAreaAnnotation(sourceId, pageIndex, rect, undefined, imageDataUrl);
      // The Area tool stays active until toggled off (FEAT-002 2.4); just clear
      // the live rubber-band box.
      setAreaDrag(null);
      areaDragRef.current = null;
      redrawOverlays();
      bump();
    },
    [wb, sourceId, redrawOverlays, bump],
  );

  // Reveal the edit popover when an annotation overlay is clicked, and the
  // context menu on right-click, via COORDINATE hit-testing on the stage (the
  // text layer sits on top of the fragments, so DOM-target closest() never
  // reaches them). Fragments stay pointer-events:none so a drag selection can
  // always start / pass through highlighted text (2.2.1).
  useEffect(() => {
    if (!ready) return;
    const mount = mountRef.current;
    if (!mount) return;
    const clickHandler = (ev: MouseEvent) => {
      onStageClick(ev.clientX, ev.clientY, ev.target as HTMLElement | null);
    };
    const ctxHandler = (ev: MouseEvent) => {
      ev.preventDefault();
      onStageContextMenu(ev.clientX, ev.clientY);
    };
    mount.addEventListener("click", clickHandler);
    mount.addEventListener("contextmenu", ctxHandler);
    return () => {
      mount.removeEventListener("click", clickHandler);
      mount.removeEventListener("contextmenu", ctxHandler);
    };
  }, [ready, onStageClick, onStageContextMenu]);

  // FEAT-002 (2.4b) area-select rubber-band drag on the stage. Active only in
  // area-select mode; a >8px drag crops + commits on pointerup.
  const onAreaPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!areaSelectActive) return;
      const hit = stageHitAt(e.clientX, e.clientY);
      if (!hit) return;
      e.preventDefault();
      areaDragRef.current = { pageIndex: hit.pageIndex, startX: hit.nx, startY: hit.ny };
      setAreaDrag({
        pageIndex: hit.pageIndex,
        rect: { x: hit.nx, y: hit.ny, width: 0, height: 0 },
      });
    },
    [areaSelectActive, stageHitAt],
  );

  const onAreaPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const start = areaDragRef.current;
      if (!areaSelectActive || !start) return;
      const page = pagesRef.current.find(
        (p) => Number(p.container.dataset.pageIndex ?? "-1") === start.pageIndex,
      );
      if (!page) return;
      const box = page.stage.getBoundingClientRect();
      const nx = box.width > 0 ? (e.clientX - box.left) / box.width : start.startX;
      const ny = box.height > 0 ? (e.clientY - box.top) / box.height : start.startY;
      const x = Math.min(start.startX, nx);
      const y = Math.min(start.startY, ny);
      const width = Math.abs(nx - start.startX);
      const height = Math.abs(ny - start.startY);
      setAreaDrag({ pageIndex: start.pageIndex, rect: { x, y, width, height } });
    },
    [areaSelectActive],
  );

  const onAreaPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const start = areaDragRef.current;
      if (!areaSelectActive || !start) return;
      const page = pagesRef.current.find(
        (p) => Number(p.container.dataset.pageIndex ?? "-1") === start.pageIndex,
      );
      const box = page?.stage.getBoundingClientRect();
      const nx = box && box.width > 0 ? (e.clientX - box.left) / box.width : start.startX;
      const ny = box && box.height > 0 ? (e.clientY - box.top) / box.height : start.startY;
      const x = Math.min(start.startX, nx);
      const y = Math.min(start.startY, ny);
      const width = Math.abs(nx - start.startX);
      const height = Math.abs(ny - start.startY);
      // Pixel threshold: drag must exceed 8px in BOTH axes. Convert the 8px
      // threshold into normalized space using the stage box when available.
      const pxW = box && box.width > 0 ? width * box.width : width;
      const pxH = box && box.height > 0 ? height * box.height : height;
      if (pxW > 8 && pxH > 8) {
        void commitAreaFromDrag(start.pageIndex, { x, y, width, height });
      } else {
        setAreaDrag(null);
        areaDragRef.current = null;
      }
    },
    [areaSelectActive, commitAreaFromDrag],
  );

  // FEAT-002 (2.2a) paint an active accent outline on the fragments of the
  // selected annotation, and clear it from every other annotation. Driven by
  // selectedAnnotationId; runs after overlays are (re)drawn.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    mount
      .querySelectorAll('.ito-highlight[data-selected="true"]')
      .forEach((el) => el.removeAttribute("data-selected"));
    if (!selectedAnnotationId) return;
    mount
      .querySelectorAll(`.ito-highlight[data-annotation-id="${cssEscapeId(selectedAnnotationId)}"]`)
      .forEach((el) => el.setAttribute("data-selected", "true"));
  }, [selectedAnnotationId, ready]);

  // Keep a ref mirror of the selected id so redrawOverlays (which rebuilds
  // fragments) can re-apply the outline without re-subscribing.
  useEffect(() => {
    selectedRef.current = selectedAnnotationId;
  }, [selectedAnnotationId]);

  // FEAT-002 (2.3) page-locked selection: when a pointer goes down inside a
  // page stage, record that page as the active selection page until pointerup.
  // While active, user-select is disabled on every OTHER page + the headers so
  // a drag near the last character never loops into the next page's textLayer.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const onDown = (ev: PointerEvent) => {
      if (areaSelectActive) return;
      const hit = stageHitAt(ev.clientX, ev.clientY);
      if (hit) {
        setActiveSelectionPage(hit.pageIndex);
        // FEAT-002 (2.2.1): mark a drag so fragments go pointer-transparent and
        // the selection can pass through highlighted text.
        mount.setAttribute("data-pointer-dragging", "true");
      }
    };
    const onUp = () => {
      setActiveSelectionPage(null);
      mount.removeAttribute("data-pointer-dragging");
    };
    mount.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    return () => {
      mount.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
    };
  }, [areaSelectActive, stageHitAt]);

  // Pointer-driven selection: only text the pointer actually crosses gets
  // selected (no snapping from blank margins, no whole-line grabs from gaps).
  const pointerSelEnabledRef = useRef(true);
  pointerSelEnabledRef.current = !areaSelectActive && !rangeMode && activeTool !== "note";
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || isWebsite) return;
    return installPointerSelection(mount, {
      getLayers: () => pagesRef.current.map((p) => p.textLayer),
      enabled: () => pointerSelEnabledRef.current,
    });
  }, [isWebsite, ready]);

  // Apply / clear the per-page user-select lock as activeSelectionPage changes.
  useEffect(() => {
    for (const page of pagesRef.current) {
      const pi = Number(page.container.dataset.pageIndex ?? "-1");
      const locked = activeSelectionPage != null && pi !== activeSelectionPage;
      page.stage.style.userSelect = locked ? "none" : "";
      (page.stage.style as unknown as Record<string, string>)["webkitUserSelect"] = locked
        ? "none"
        : "";
    }
  }, [activeSelectionPage]);

  // FEAT-002 (2.3a) live watercolor selection preview pills: while a
  // non-collapsed selection lives inside a page stage, mirror its client rects
  // on the fixed layer as soft, on-theme pills tinted with the active color.
  useEffect(() => {
    const onSelectionChange = (): void => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setLivePreview(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const page = pagesRef.current.find((p) =>
        p.textLayer.contains(range.commonAncestorContainer),
      );
      if (!page) {
        setLivePreview(null);
        return;
      }
      const rects = Array.from(range.getClientRects())
        .filter((r) => r.width > 0 && r.height > 0)
        .map((r) => ({
          left: r.left,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
          width: r.width,
        }));
      if (rects.length === 0) {
        setLivePreview(null);
        return;
      }
      setLivePreview({ color: swatch("yellow"), rects });
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, []);

  // FEAT-002 (2.5) apply the zoom scale: re-render every page at the current
  // fit target * zoom so canvas, text layer and overlays all stay locked 1:1.
  // Skipped for websites (no pdf.js pages).
  useEffect(() => {
    if (!ready || isWebsite) return;
    zoomRef.current = zoom;
    const pages = pagesRef.current;
    if (pages.length === 0) return;
    // Apply the zoom ON TOP of the current fit-to-pane target (fittedScaleRef)
    // so zooming a pane that was fitted-down does not jump back to the base
    // width, and so the zoom and fit effects agree on a single applied scale.
    // Renders are serialized per page so the zoom effect and a concurrent
    // ResizeObserver refit can never drive overlapping pdf.js render() calls on
    // the same canvas (the "same canvas during multiple render()" error).
    const applied = fittedScaleRef.current * zoom;
    void (async () => {
      for (const page of pages) {
        await serializedRerender(page, applied);
      }
      redrawOverlays();
    })();
  }, [zoom, ready, isWebsite, redrawOverlays]);

  // FEAT-002 (2.5a) native NON-PASSIVE wheel listener on .pane-scroll: Ctrl /
  // Cmd + wheel preventDefaults (so the browser tab never zooms) and steps the
  // PDF zoom smoothly between 50% and 300%. Attached imperatively so passive
  // defaults do not block preventDefault.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handler = (ev: WheelEvent): void => {
      if (!(ev.ctrlKey || ev.metaKey)) return;
      ev.preventDefault();
      const step = ev.deltaY < 0 ? 0.1 : -0.1;
      setZoom((z) => clampZoom(z + step));
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [ready]);

  // FEAT-001 current page tracking via IntersectionObserver (NOT scroll-driven
  // re-renders): the page whose stage is most visible is reported as current.
  const [currentPage, setCurrentPage] = useState(1);
  useEffect(() => {
    if (!ready || !isPrimary) return;
    const mount = mountRef.current;
    if (!mount || typeof IntersectionObserver === "undefined") return;
    const ratios = new Map<number, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const pi = Number((e.target as HTMLElement).dataset.pageIndex ?? "-1");
          ratios.set(pi, e.isIntersecting ? e.intersectionRatio : 0);
        }
        let best = -1;
        let bestRatio = -1;
        for (const [pi, r] of ratios) {
          if (r > bestRatio) {
            bestRatio = r;
            best = pi;
          }
        }
        if (best >= 0) setCurrentPage(best + 1);
      },
      { root: scrollRef.current, threshold: [0.1, 0.25, 0.5, 0.75] },
    );
    for (const page of pagesRef.current) io.observe(page.container);
    return () => io.disconnect();
  }, [ready, isPrimary]);

  // FEAT-001 report zoom/page/count up to the shell toolbar (primary pane only)
  // and register the imperative toolbar commands (zoom / paging / find).
  const pageCount = source?.pageCount ?? pagesRef.current.length ?? 1;
  useEffect(() => {
    if (!isPrimary) return;
    // Report the EFFECTIVE scale (fit x user zoom) so the toolbar percentage
    // matches what is on screen instead of a bare multiplier.
    onNavChange?.({ zoom: (fitScale / 1) * zoom, page: currentPage, pageCount });
  }, [isPrimary, zoom, fitScale, currentPage, pageCount, onNavChange]);

  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findMatches, setFindMatches] = useState<{ total: number; active: number }>({
    total: 0,
    active: 0,
  });

  const goToPage = useCallback((pageNumber: number) => {
    const page = pagesRef.current.find(
      (p) => Number(p.container.dataset.pageIndex ?? "-1") === pageNumber - 1,
    );
    page?.container.scrollIntoView({ behavior: "auto", block: "start" });
  }, []);

  useEffect(() => {
    if (!isPrimary || !registerCommands) return;
    registerCommands({
      zoomIn: () => setZoom((z) => clampZoom(z + 0.1)),
      zoomOut: () => setZoom((z) => clampZoom(z - 0.1)),
      resetZoom: () => setZoom(1),
      // Fit width resets the user zoom; the fit-to-pane effect applies the base
      // fitted scale with zoom === 1.
      fitWidth: () => setZoom(1),
      goToPage,
      openFind: () => setFindOpen(true),
      getDoc: () => docRef.current,
    });
  }, [isPrimary, registerCommands, goToPage]);

  // FEAT-001 inline find using pdf.js text layers. Ctrl/Cmd+F opens the bar;
  // Enter / Shift+Enter move between matches; matches get a .ito-find-match
  // class in the text layer.
  useEffect(() => {
    if (!isPrimary) return;
    const onKey = (ev: KeyboardEvent): void => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "f") {
        ev.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isPrimary]);

  const runFind = useCallback(
    (query: string, step: 1 | -1 | 0) => {
      const q = query.trim().toLowerCase();
      for (const page of pagesRef.current) {
        page.textLayer
          .querySelectorAll(".ito-find-match")
          .forEach((el) => el.classList.remove("ito-find-match", "ito-find-active"));
      }
      if (!q) {
        setFindMatches({ total: 0, active: 0 });
        return;
      }
      const hits: HTMLElement[] = [];
      for (const page of pagesRef.current) {
        for (const span of Array.from(page.textLayer.querySelectorAll("span"))) {
          if ((span.textContent ?? "").toLowerCase().includes(q)) {
            span.classList.add("ito-find-match");
            hits.push(span as HTMLElement);
          }
        }
      }
      if (hits.length === 0) {
        setFindMatches({ total: 0, active: 0 });
        return;
      }
      setFindMatches((prev) => {
        const nextActive =
          step === 0
            ? 0
            : (prev.active + step + hits.length) % hits.length;
        const el = hits[nextActive];
        el?.classList.add("ito-find-active");
        el?.scrollIntoView({ behavior: "auto", block: "center" });
        return { total: hits.length, active: nextActive };
      });
    },
    [],
  );

  // Other sources (not currently open in any pane) the user can switch THIS
  // pane to — keeps the same subject while a reader pane shows a third paper
  // (section 8.2 note).
  const switchable = wb
    .rawData()
    .sources.filter((s) => s.id !== sourceId && !openSourceIds.includes(s.id));

  return (
    <div
      data-testid="source-pane"
      data-source-id={sourceId}
      data-ready={ready ? "true" : "false"}
      style={styles.pane}
    >
      <div className="ito-pane-header" style={styles.paneHeader}>
        <strong className="ito-pane-title" title={source?.title ?? ""}>
          {source?.title ?? "…"}
        </strong>
        <span className="ito-pane-actions" style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          {isWebsite && (
            <span
              data-testid="website-availability-badge"
              data-source-id={sourceId}
              data-status={source?.availabilityStatus ?? "snapshot-cached"}
              title={source?.url ?? ""}
              style={styles.websiteBadge}
            >
              Snapshot cached
            </span>
          )}
          {/* Page-range comment entry (kept reachable for the accessible flow +
              e2e). Zoom / find / tools / overflow now live in the single reader
              toolbar above. */}
          <button
            data-testid="start-range"
            onClick={() => setRangeMode((v) => !v)}
            aria-pressed={rangeMode}
            title="Comment on page range"
          >
            ¶
          </button>
          {switchable.length > 0 && (
            <select
              data-testid="switch-paper"
              aria-label="Switch this pane to another paper"
              value=""
              onChange={(e) => {
                const to = e.target.value;
                if (!to) return;
                wb.switchReaderPane(sourceId, to as SourceId);
                bump();
              }}
            >
              <option value="">Switch paper…</option>
              {switchable.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          )}
        </span>
      </div>

      {scopeStatus && (
        <div data-testid="pdf-scope-status" role="note" style={styles.scopeStatus}>
          {scopeStatus}
        </div>
      )}

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

      {isPrimary && findOpen && (
        <div data-testid="find-bar" role="search" style={styles.findBar}>
          <input
            data-testid="find-input"
            aria-label="Find in document"
            autoFocus
            value={findQuery}
            placeholder="Find in document"
            onChange={(e) => {
              setFindQuery(e.target.value);
              runFind(e.target.value, 0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                runFind(findQuery, e.shiftKey ? -1 : 1);
              } else if (e.key === "Escape") {
                setFindOpen(false);
                runFind("", 0);
              }
            }}
          />
          <span data-testid="find-count" style={{ fontSize: "0.8rem", color: "var(--ito-muted)" }}>
            {findMatches.total === 0 ? "0/0" : `${findMatches.active + 1}/${findMatches.total}`}
          </span>
          <button
            data-testid="find-prev"
            aria-label="Previous match"
            onClick={() => runFind(findQuery, -1)}
          >
            ‹
          </button>
          <button
            data-testid="find-next"
            aria-label="Next match"
            onClick={() => runFind(findQuery, 1)}
          >
            ›
          </button>
          <button
            data-testid="find-close"
            aria-label="Close find"
            onClick={() => {
              setFindOpen(false);
              runFind("", 0);
            }}
          >
            ×
          </button>
        </div>
      )}

      <div
        ref={(el) => {
          scrollRef.current = el;
          registerScroll(el);
        }}
        data-testid="pane-scroll"
        data-source-id={sourceId}
        style={styles.paneScroll}
        onScroll={onPaneScroll}
      >
        <div
          ref={mountRef}
          data-testid="pdf-mount"
          data-area-select={areaSelectActive ? "true" : "false"}
          className={["ito-page-canvas", areaSelectActive ? "ito-area-select-active" : null]
            .filter(Boolean)
            .join(" ")}
          style={{ ...styles.mount, cursor: areaSelectActive ? "crosshair" : undefined }}
          onMouseUp={onMouseUp}
          onPointerDown={onAreaPointerDown}
          onPointerMove={onAreaPointerMove}
          onPointerUp={onAreaPointerUp}
        >
          {isWebsite && websiteHtml != null && (
            <div
              data-testid="website-snapshot"
              data-source-id={sourceId}
              style={styles.websiteSnapshot}
              dangerouslySetInnerHTML={{ __html: sanitizeSnapshotHtml(websiteHtml) }}
            />
          )}
          {/* FEAT-002 (2.4b) the live rubber-band area-select box. Positioned
              over the originating page stage via normalized percentages. */}
          {areaDrag && (
            <AreaDragPreview areaDrag={areaDrag} pagesRef={pagesRef} mountRef={mountRef} />
          )}
        </div>
      </div>

      {/* FEAT-002 (2.1) fixed viewport layer rendered via a portal OUTSIDE the
          .pane-scroll (overflow:auto) subtree, so the selection toolbar and the
          highlight edit popover are never clipped. */}
      <ReaderFixedLayer>
        {toolbar && (
          <SelectionToolbar
            toolbar={toolbar}
            onCommit={commitHighlight}
            onDismiss={() => setToolbar(null)}
          />
        )}
        {editPopover && (
          <HighlightEditPopover
            wb={wb}
            popover={editPopover}
            resolveAnchor={resolvePopoverAnchor}
            onClose={() => {
              setEditPopover(null);
              setSelectedAnnotationId(null);
            }}
            bump={bump}
          />
        )}
        {contextMenu && (
          <ReaderContextMenu
            wb={wb}
            menu={contextMenu}
            onClose={() => setContextMenu(null)}
            onEditComment={(annotationId, x, y) => {
              setContextMenu(null);
              setEditPopover({
                annotationId,
                sourceId,
                rect: anchorRectFrom(null, x, y),
              });
            }}
            onPageAction={(action) => {
              setContextMenu(null);
              if (action === "range") setRangeMode(true);
              // The Area tool is now selected from the single reader toolbar
              // (tool-first model); the page context menu no longer toggles a
              // separate area-select flag.
              else if (action === "lines") {
                wb.setLinesVisible(!linesVisibleForPane);
                bump();
              } else if (action === "motion") onToggleMotionForPane(!suppressMotion);
            }}
            bump={bump}
          />
        )}
        {livePreview && <LiveSelectionPreview preview={livePreview} />}
      </ReaderFixedLayer>

      {openComment && (
        <ReaderFixedLayer>
          <CommentSurface
            wb={wb}
            annotationId={openComment}
            onClose={() => setOpenComment(null)}
            bump={bump}
          />
        </ReaderFixedLayer>
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
 * FEAT-002 (2.1) a fixed viewport layer rendered into document.body via a
 * portal so its children escape the .pane-scroll (overflow:auto) clipping. In
 * jsdom document.body exists, so the portal renders inline under the test root.
 */
function ReaderFixedLayer({ children }: { children: React.ReactNode }): JSX.Element | null {
  if (typeof document === "undefined") return <>{children}</>;
  return createPortal(
    <div data-testid="reader-fixed-layer" style={styles.fixedLayer}>
      {children}
    </div>,
    document.body,
  );
}

/**
 * FEAT-002 (2.4b) the live rubber-band area-select box, positioned over the
 * originating page stage. The stage offset relative to the pdf-mount is read so
 * the box sits over the dragged region even on later pages.
 */
function AreaDragPreview({
  areaDrag,
  pagesRef,
  mountRef,
}: {
  areaDrag: AreaDragState;
  pagesRef: React.MutableRefObject<RenderedPage[]>;
  mountRef: React.RefObject<HTMLDivElement>;
}): JSX.Element {
  const page = pagesRef.current.find(
    (p) => Number(p.container.dataset.pageIndex ?? "-1") === areaDrag.pageIndex,
  );
  const mount = mountRef.current;
  let left = 0;
  let top = 0;
  let width = 0;
  let height = 0;
  if (page && mount) {
    const stageBox = page.stage.getBoundingClientRect();
    const mountBox = mount.getBoundingClientRect();
    const offsetX = stageBox.left - mountBox.left;
    const offsetY = stageBox.top - mountBox.top;
    left = offsetX + areaDrag.rect.x * stageBox.width;
    top = offsetY + areaDrag.rect.y * stageBox.height;
    width = areaDrag.rect.width * stageBox.width;
    height = areaDrag.rect.height * stageBox.height;
  }
  return (
    <div
      data-testid="area-drag-preview"
      className="ito-area-drag-preview"
      style={{
        position: "absolute",
        left,
        top,
        width,
        height,
        border: "2px dashed var(--ito-accent, #2c4a6f)",
        background: "rgba(44, 74, 111, 0.12)",
        borderRadius: "4px",
        pointerEvents: "none",
        zIndex: 20,
      }}
    />
  );
}

/**
 * The passage-to-evidence line layer for the editing workspace (spec section
 * 10.2). It draws one SVG polyline per `passageEvidenceLine`, routing from the
 * source pane's edge toward the subject pane through the inter-pane margin so
 * it NEVER crosses over readable text. Lines recompute on source scroll, editor
 * scroll, zoom and pane resize via a live geometry pass over the registered
 * pane scroll containers + evidence chips. The visibility toggle controls only
 * whether this layer renders — the underlying line DATA is always present, so
 * hiding is non-destructive (A08/R08 foundation). There is NO camera motion:
 * the layer never scrolls or re-centres any pane.
 */
function PassageEvidenceLines({
  wb,
  bodyRef,
  paneScrollRefs,
  visible,
  bump,
}: {
  wb: Workbench;
  bodyRef: React.RefObject<HTMLDivElement>;
  paneScrollRefs: React.MutableRefObject<Map<string, HTMLElement>>;
  visible: boolean;
  bump: () => void;
}): JSX.Element {
  const [segments, setSegments] = useState<
    { evidenceId: string; x1: number; y1: number; x2: number; y2: number }[]
  >([]);
  const frame = useRef<number>(0);

  const recompute = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return;
    const bodyBox = body.getBoundingClientRect();
    const lines = wb.passageEvidenceLines();
    const subjectEl = paneScrollRefs.current.get("subject");
    const next: typeof segments = [];
    for (const line of lines) {
      const sourceScroll = paneScrollRefs.current.get(line.sourceId);
      if (!sourceScroll || !subjectEl) continue;
      // Anchor the source end at the source passage's page container when it is
      // on screen; otherwise at the pane's vertical centre (still no motion).
      const pageEl = sourceScroll.querySelector(
        `.pdf-page[data-page-index="${line.sourcePageIndex}"]`,
      ) as HTMLElement | null;
      const srcBox = (pageEl ?? sourceScroll).getBoundingClientRect();
      const paneBox = sourceScroll.getBoundingClientRect();
      // Clamp the source y into the visible pane band so a scrolled-away
      // passage still yields a sensible margin endpoint (never off-canvas).
      const srcY = Math.min(
        Math.max(srcBox.top + srcBox.height / 2, paneBox.top + 6),
        paneBox.bottom - 6,
      );
      // The subject end anchors at the matching evidence chip if present.
      const chip = subjectEl.querySelector(
        `[data-testid="evidence-chip"][data-evidence-id="${line.evidenceId}"]`,
      ) as HTMLElement | null;
      const subjBox = subjectEl.getBoundingClientRect();
      const dstBox = chip ? chip.getBoundingClientRect() : subjBox;
      const dstY = Math.min(
        Math.max(dstBox.top + dstBox.height / 2, subjBox.top + 6),
        subjBox.bottom - 6,
      );
      // Route from the source pane's INNER edge (toward the subject) to the
      // subject pane's INNER edge — i.e. through the inter-pane gutter.
      const sourceLeftOfSubject = paneBox.left < subjBox.left;
      const x1 = (sourceLeftOfSubject ? paneBox.right : paneBox.left) - bodyBox.left;
      const x2 = (sourceLeftOfSubject ? subjBox.left : subjBox.right) - bodyBox.left;
      next.push({
        evidenceId: line.evidenceId,
        x1,
        y1: srcY - bodyBox.top,
        x2,
        y2: dstY - bodyBox.top,
      });
    }
    setSegments(next);
  }, [wb, bodyRef, paneScrollRefs]);

  // Recompute on any scroll (source or editor), resize, and after mount. We use
  // rAF-coalesced passive listeners so dragging a divider or scrolling a pane
  // updates lines smoothly without obstructing interaction, and without ever
  // moving a pane (presentation only, no camera motion).
  useEffect(() => {
    const schedule = (): void => {
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(recompute);
    };
    schedule();
    const scrolls = [...paneScrollRefs.current.values()];
    // The subject editor's inner scroller (styles.doc) is the element that
    // actually scrolls the composition, so listen there too (editor scroll).
    const subjectWrapper = paneScrollRefs.current.get("subject");
    const subjectDoc = subjectWrapper?.querySelector(
      '[data-testid="subject-doc"]',
    ) as HTMLElement | null;
    const listenEls = subjectDoc ? [...scrolls, subjectDoc] : scrolls;
    for (const el of listenEls) el.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const ro = new ResizeObserver(schedule);
    if (bodyRef.current) ro.observe(bodyRef.current);
    for (const el of scrolls) ro.observe(el);
    return () => {
      cancelAnimationFrame(frame.current);
      for (const el of listenEls) el.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      ro.disconnect();
    };
    // `bump` is intentionally not a dep; recompute closes over live refs.
  }, [recompute, paneScrollRefs, bodyRef, bump]);

  const count = segments.length;

  return (
    <svg
      data-testid="passage-evidence-lines"
      data-visible={visible ? "true" : "false"}
      data-line-count={String(count)}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        // The toggle changes PRESENTATION ONLY: hidden lines keep their data
        // (data-line-count stays accurate) but are not painted.
        visibility: visible ? "visible" : "hidden",
        zIndex: 5,
      }}
      aria-hidden="true"
    >
      {segments.map((s) => {
        const midX = (s.x1 + s.x2) / 2;
        return (
          <path
            key={s.evidenceId}
            data-testid="evidence-line"
            data-evidence-id={s.evidenceId}
            d={`M ${s.x1} ${s.y1} C ${midX} ${s.y1}, ${midX} ${s.y2}, ${s.x2} ${s.y2}`}
            fill="none"
            stroke="#1a56db"
            strokeWidth={1.5}
            strokeOpacity={0.55}
            strokeDasharray="4 3"
          />
        );
      })}
    </svg>
  );
}
