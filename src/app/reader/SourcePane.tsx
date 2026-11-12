import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  analyzePdfPage,
  computeHeadTailHash,
  createAnchor,
  createAnchorRectsWithOcrFallback,
  cropCanvasRegionToDataUrl,
  hitTestAnnotations,
  installPointerSelection,
  loadDocument,
  recomputeRectsFromQuote,
  renderPage,
  resolveAnchor,
  type HitTestTarget,
  type IngestionController,
  type RenderedPage,
} from "../../pdf";
import type { NormalizedRect, PreParsedPageLayout } from "../../model";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { AnnotationId, SourceId } from "../../model";
import {
  type AnnotationStyle,
  type HighlightColor,
  type Workbench,
} from "../workbench";
import { type ActiveTool } from "./ReaderToolbar";
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
  CommentSurface,
  HighlightEditPopover,
  LiveSelectionPreview,
  ReaderContextMenu,
  SelectionToolbar,
  type AnchorRect,
  type ContextMenuState,
  type EditPopoverState,
  type MenuState,
  type ToolbarState,
} from "./AnnotationOverlays";
import {
  createScrollCoalescer,
  type AreaDragState,
  type PaneCommands,
  type ReturnTarget,
  type ScrollCoalescer,
} from "./paneTypes";

/**
 * The primary reading pane: owns the pdf.js document lifecycle (load + render +
 * refit + zoom), the per-page highlight overlays, and all in-pane annotation
 * interactions (selection toolbar, edit popover, context menu, area cropper,
 * range comments, find). Extracted from Reader.tsx during the FEAT-002
 * decomposition; Reader.tsx remains the shell/state owner and renders this.
 */
export function SourcePane({
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
  // Phase 1 (STRUCTURAL INDEXING) a 0-based pageIndex -> RenderedPage index so
  // resolving a page by its `data-page-index` is O(1) instead of a linear
  // `pagesRef.current.find(...)`. It is a DERIVED mirror of `pagesRef.current`,
  // rebuilt in lockstep whenever that array is (re)assigned (source switch /
  // initial render), so it can never point at a page from a previous document.
  // A `useRef` (not state): it mirrors runtime DOM, must not trigger renders.
  const pageByIndexRef = useRef<Map<number, RenderedPage>>(new Map());
  const docRef = useRef<PDFDocumentProxy | null>(null);
  // M14–M16 (FEAT-001) the live windowed-virtualization observer (large PDFs).
  const virtualizationObserverRef = useRef<IntersectionObserver | null>(null);
  // M18 (FEAT-PDF-CACHE §15/§20-15) the in-flight analysis-cache ingestion
  // controller for THIS source, so switching sources cancels obsolete work.
  const ingestionControllerRef = useRef<IngestionController | null>(null);
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
  // Phase 1 (STRUCTURAL INDEXING) resolve a RenderedPage by its 0-based page
  // index in O(1) via `pageByIndexRef`, replacing the linear
  // `pagesRef.current.find(p => Number(p.container.dataset.pageIndex) === i)`
  // that was duplicated across ~16 call sites. Stable identity (reads the ref),
  // so it never needs to appear in a dependency array.
  const resolvePageByIndex = useCallback(
    (pageIndex: number): RenderedPage | undefined => pageByIndexRef.current.get(pageIndex),
    [],
  );
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
      // Phase 1: pass the O(1) page resolver so a "pages"-range annotation no
      // longer does a linear pages.find per page of its range.
      drawAnnotation(view, pagesRef.current, suppressMotion, false, resolvePageByIndex);
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
  }, [wb, sourceId, suppressMotion, resolvePageByIndex]);

  // M13 (§1.2) recompute the live selection preview pills + the selection
  // toolbar anchor from the CURRENT browser selection, clipped to the
  // originating .pdf-page-stage. `selectionchange` does NOT fire on scroll, so
  // without this the preview pill + toolbar freeze at stale viewport coords and
  // drift off the page onto the desk. When the selection's anchor scrolls
  // entirely outside .pane-scroll's visible viewport we HIDE the preview + clip
  // the toolbar; when it scrolls back in we restore it. Pure DOM reads +
  // setState — never calls bump(). Routed through a ref so the (once-created)
  // scroll coalescer always sees the latest state/setters.
  const syncSelectionToScroll = useCallback((): void => {
    const hasToolbar = toolbar != null;
    const hasPreview = livePreview != null && livePreview.rects.length > 0;
    if (!hasToolbar && !hasPreview) return;

    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const page = pagesRef.current.find((p) =>
      p.textLayer.contains(range.commonAncestorContainer),
    );
    if (!page) return;

    // The visible viewport of the scroll container; clip the selection to it so
    // a selection scrolled off-screen hides rather than floats on the desk.
    const scrollBox = scrollRef.current?.getBoundingClientRect() ?? null;
    const stageBox = page.stage.getBoundingClientRect();
    const anchorRect = range.getBoundingClientRect();
    const outOfView =
      scrollBox != null &&
      (anchorRect.bottom <= scrollBox.top ||
        anchorRect.top >= scrollBox.bottom ||
        anchorRect.right <= scrollBox.left ||
        anchorRect.left >= scrollBox.right);

    // Hide the live preview when the selection anchor is scrolled out of the
    // visible pane; otherwise mirror the CURRENT client rects (clipped to the
    // page stage) as the preview pills.
    if (hasPreview) {
      if (outOfView) {
        setLivePreview((prev) => (prev && prev.rects.length > 0 ? { ...prev, rects: [] } : prev));
      } else {
        const rects = Array.from(range.getClientRects())
          .filter((r) => r.width > 0 && r.height > 0)
          .map((r) => ({
            left: Math.max(r.left, stageBox.left),
            top: Math.max(r.top, stageBox.top),
            right: Math.min(r.right, stageBox.right),
            bottom: Math.min(r.bottom, stageBox.bottom),
            width: Math.min(r.right, stageBox.right) - Math.max(r.left, stageBox.left),
          }))
          .filter((r) => r.width > 0 && r.bottom - r.top > 0);
        setLivePreview((prev) =>
          prev ? { color: prev.color, rects } : { color: swatch("yellow"), rects },
        );
      }
    }

    // Re-anchor the selection toolbar to the selection's current viewport rect
    // (so it follows the text on scroll) and clip it when out of view.
    if (hasToolbar) {
      if (outOfView) {
        setToolbar((prev) =>
          prev && prev.rect.width !== -1
            ? { ...prev, rect: { ...prev.rect, width: -1 } }
            : prev,
        );
      } else {
        const nextRect = anchorRectFrom(anchorRect, anchorRect.left, anchorRect.top);
        setToolbar((prev) => (prev ? { ...prev, rect: nextRect } : prev));
      }
    }
  }, [toolbar, livePreview]);
  const syncSelectionToScrollRef = useRef(syncSelectionToScroll);
  syncSelectionToScrollRef.current = syncSelectionToScroll;

  // FEAT-003 (3.3) rAF-coalesced LOCAL scroll handling. Scrolling re-paints the
  // per-page highlight overlays directly into the DOM (redrawOverlays) so they
  // stay pinned to their pages; it NEVER calls the root bump(), so scrolling a
  // reader pane no longer forces a whole-app re-render. The inter-pane evidence
  // lines are updated separately by PassageEvidenceLines' own scroll listener.
  // A single frame is scheduled at a time and torn down on unmount. M13 (§1.2):
  // the same frame re-anchors the live selection preview + toolbar to the
  // current selection rects so they follow the page on scroll.
  const redrawOverlaysRef = useRef(redrawOverlays);
  redrawOverlaysRef.current = redrawOverlays;
  const scrollCoalescerRef = useRef<ScrollCoalescer | null>(null);
  if (scrollCoalescerRef.current === null) {
    scrollCoalescerRef.current = createScrollCoalescer(() => {
      redrawOverlaysRef.current();
      syncSelectionToScrollRef.current();
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
      // M14–M16 (FEAT-001) windowed virtualization. For a LARGE document
      // (> 8 pages) in a browser that supports IntersectionObserver, render
      // pages LAZILY: each page's exact-size placeholder shell is created
      // immediately (so scroll height + PassageEvidenceLines coordinates never
      // jump) and the heavy canvas raster + text layer are built on demand as
      // the page enters the 150% rootMargin window. jsdom (unit/render tests)
      // has no IntersectionObserver, so there we render EAGERLY — every
      // existing small-fixture test (1–12 pages) stays 100% compatible.
      const supportsIO = typeof IntersectionObserver !== "undefined";
      const virtualize = doc.numPages > 8 && supportsIO;
      const pages: RenderedPage[] = [];
      // Phase 1: build the 0-based pageIndex -> RenderedPage map as pages are
      // created, keyed by the SAME `data-page-index` every resolver reads.
      const pageByIndex = new Map<number, RenderedPage>();
      for (let p = 1; p <= doc.numPages; p++) {
        const rp = await renderPage(doc, p, mount, 1.3, { lazy: virtualize });
        rp.container.dataset.pageIndex = String(p - 1);
        rp.stage.dataset.pageIndex = String(p - 1);
        pages.push(rp);
        pageByIndex.set(p - 1, rp);
      }
      if (cancelled) return;
      pagesRef.current = pages;
      // Replace (never merge) the index so a re-render for a NEW document cannot
      // retain pages from the previous one (§ document switching invariant).
      pageByIndexRef.current = pageByIndex;
      // Install the virtualization observer once the shells are mounted. The
      // observer root is the `.pane-scroll` container (the mount's parent) and
      // its 150% vertical rootMargin pre-renders a page ~1.5 viewports before it
      // scrolls in, so scrolling stays 0-latency and constant-memory.
      if (virtualize) {
        virtualizationObserverRef.current = installVirtualizationObserver(
          mount,
          pages,
          () => redrawOverlaysRef.current(),
        );
      }
      setRangeEnd(doc.numPages - 1);
      // M6 (D01): a page with 0 selectable text items is a scanned/image PDF.
      if (pages.length > 0 && pages.every((p) => p.textItemCount === 0)) {
        setScopeStatus(
          "Scanned PDF (no selectable text layer) - use page-range or area annotations",
        );
      }
      // FIX-PAGECOUNT-BACKFILL (3.1 / D01): backfill a batch-ingested source's
      // pageCount (stored as 0) now that pdf.js knows the real page count.
      // FEAT-002: also backfill authors/year from the live pdf.js metadata when
      // they were not captured at ingest (jsdom has no worker, so import-time
      // extraction returns undefined and the real values are filled in here).
      // M12 (FEAT-001): also backfill the universal identity signals
      // (docStem / canonicalId / textShingles) once the live text layer is
      // available, so a loaded PDF can later re-hydrate its slot on re-import.
      const needsIdentity =
        source != null &&
        (source.canonicalId == null ||
          source.docStem == null ||
          source.textShingles == null ||
          source.textShingles.length < 4);
      if (
        source &&
        (source.pageCount === 0 ||
          source.authors == null ||
          source.year == null ||
          needsIdentity)
      ) {
        const meta = await readLiveMetadata(doc);
        const pageTexts = needsIdentity ? await extractPageTexts(doc) : undefined;
        void wb.updateSourceMetadata(sourceId, {
          pageCount: source.pageCount === 0 ? doc.numPages : undefined,
          authors: meta.authors,
          year: meta.year,
          ...(pageTexts != null ? { pageTexts } : {}),
        });
      }

      // M17 (§1.1): set-text pre-parsed layout cache. An imported PDF is an
      // immutable set text, so parsing getTextContent() on every reload is
      // wasted work. When the source already carries `cachedPages`, hydrate
      // each RENDERED page's `.textLayer` from the cache IMMEDIATELY (selection
      // / highlights / Ctrl+F work on load). On first load (no cache) extract
      // the normalized layouts from the rendered pages and persist them so the
      // next open is instant. Only drawn pages expose a layout; a virtualized
      // page caches once it rasterizes (best-effort, never blocks the render).
      if (source && !cancelled) {
        if (source.cachedPages && source.cachedPages.length > 0) {
          const byIndex = new Map(source.cachedPages.map((p) => [p.pageIndex, p]));
          for (const rp of pages) {
            if (!rp.isRendered()) continue;
            const layout = byIndex.get(Number(rp.container.dataset.pageIndex ?? "0"));
            if (layout) {
              try {
                rp.hydrateFromCache(layout);
              } catch {
                // Hydration is an optimization; a failure just means the live
                // pdf.js text layer is used as-is.
              }
            }
          }
        } else {
          const layouts: PreParsedPageLayout[] = [];
          for (const rp of pages) {
            if (!rp.isRendered()) continue;
            try {
              layouts.push(rp.extractLayout());
            } catch {
              // skip a page whose layout could not be extracted
            }
          }
          if (layouts.length > 0) void wb.cacheParsedPdfPages(sourceId, layouts);
        }
      }

      setReady(true);

      // M18 (FEAT-PDF-CACHE §4/§8): drive the PERSISTENT per-page analysis cache
      // in the background. This is the long-term source of reusable document
      // information: on a cold open it analyses each page once (bounded
      // concurrency) and persists incrementally; on a warm open the manifest is
      // already complete and this is an O(1) lookup that schedules no analysis.
      // It runs AFTER the pages are visible (never blocks first paint) and is
      // cancelled if the source switches. A no-op when no analysis store is
      // wired (jsdom / legacy path), so the existing render is unaffected.
      if (source && !cancelled && wb.pdfAnalysisStore()) {
        const bytesForId = bytes;
        const fileSize = bytesForId.byteLength;
        const headTailHash = computeHeadTailHash(bytesForId);
        const pdfId = (doc as unknown as { fingerprints?: (string | null)[] })
          .fingerprints?.[0] ?? null;
        const identity = wb.pdfDocumentIdentity(sourceId, {
          fileSize,
          pdfId,
          headTailHash,
        });
        if (identity) {
          const controller = wb.createPdfIngestionController();
          ingestionControllerRef.current?.cancel();
          ingestionControllerRef.current = controller;
          const analyzePage = (pageNumber: number) =>
            analyzePdfPage(
              doc as unknown as Parameters<typeof analyzePdfPage>[0],
              pageNumber,
            );
          void wb
            .openPdfAnalysisCache({
              sourceId,
              documentId: identity.documentId,
              sourceFingerprint: identity.sourceFingerprint,
              fileSize,
              pageCount: doc.numPages,
              analyzePage,
              controller,
              currentPage: 1,
            })
            .catch((err) => console.error("pdf analysis cache failed", err));
        }
      }
    })().catch((err) => console.error("render failed", err));
    return () => {
      cancelled = true;
      // M14–M16 (FEAT-001): tear down the virtualization observer so a
      // re-render / unmount never leaks observers across source swaps.
      virtualizationObserverRef.current?.disconnect();
      virtualizationObserverRef.current = null;
      // M18 (FEAT-PDF-CACHE §15): cancel any in-flight analysis ingestion so a
      // source switch does not keep analysing the old document (§20 case 15).
      ingestionControllerRef.current?.cancel();
      ingestionControllerRef.current = null;
      // Phase 1: drop the page index so a source switch never exposes a page
      // from the previous document before the new render repopulates it.
      pageByIndexRef.current = new Map();
    };
  }, [wb, sourceId]);

  // Draw overlays whenever annotations change / pages become ready.
  useEffect(() => {
    if (ready) redrawOverlays();
  }, [ready, redrawOverlays]);

  // M14–M16 (FEAT-001): DIRECT highlight-to-highlight DRAG linking. Delegated
  // native drag listeners on the mount make each drawn highlight fragment
  // draggable; dropping one fragment onto ANOTHER highlight's fragment calls
  // wb.linkHighlightsToObservation(fromId, toId), synthesising an Observation
  // Node that cites both with a bridging note. Pure DOM wiring (no React re-
  // render until the link commits); a drop onto the same highlight is ignored.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const annotationIdOf = (el: EventTarget | null): AnnotationId | null => {
      const frag = (el as HTMLElement | null)?.closest?.(".ito-highlight[data-annotation-id]");
      const id = frag?.getAttribute("data-annotation-id");
      return id ? (id as AnnotationId) : null;
    };
    const onDragStart = (e: DragEvent): void => {
      const id = annotationIdOf(e.target);
      if (!id || !e.dataTransfer) return;
      e.dataTransfer.setData("application/x-ito-annotation", id as string);
      e.dataTransfer.effectAllowed = "link";
    };
    const onDragOver = (e: DragEvent): void => {
      if (e.dataTransfer?.types.includes("application/x-ito-annotation")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "link";
      }
    };
    const onDrop = (e: DragEvent): void => {
      const fromId = e.dataTransfer?.getData("application/x-ito-annotation") as
        | AnnotationId
        | undefined;
      const toId = annotationIdOf(e.target);
      if (!fromId || !toId || fromId === toId) return;
      e.preventDefault();
      void wb
        .linkHighlightsToObservation(fromId, toId)
        .then(() => bump())
        .catch((err) => console.error("highlight link failed", err));
    };
    mount.addEventListener("dragstart", onDragStart);
    mount.addEventListener("dragover", onDragOver);
    mount.addEventListener("drop", onDrop);
    return () => {
      mount.removeEventListener("dragstart", onDragStart);
      mount.removeEventListener("dragover", onDragOver);
      mount.removeEventListener("drop", onDrop);
    };
  }, [wb, bump]);

  // M13 (§1.3) live quote-to-rect re-anchoring. When a revised PDF shifted a
  // paragraph to a new vertical position/page, reanchorAnnotations moved the
  // annotation's pageIndex and marked it `rectsStale`, but the stored
  // normalized rects still hold the PREVIOUS draft's coordinates. On page
  // render, for each stale text annotation, re-measure its quote against the
  // live .textLayer (recomputeRectsFromQuote) and persist fresh rects via
  // wb.updateAnnotationRects (which also clears the stale flag). An empty match
  // keeps the existing rects (updateAnnotationRects is a no-op on []). Runs once
  // per ready render; the persist triggers a redraw through the owning effects.
  useEffect(() => {
    if (!ready || isWebsite) return;
    const views = wb.annotationsForSource(sourceId);
    void (async () => {
      for (const view of views) {
        const ann = view.annotation;
        if (ann.scope.kind !== "text") continue;
        if (ann.rectsStale !== true) continue;
        const anchor = ann.scope.anchor;
        const page = resolvePageByIndex(anchor.pageIndex); // Phase 1 O(1) lookup
        if (!page) continue;
        const rects = recomputeRectsFromQuote(page.stage, anchor.selectedText);
        if (rects.length === 0) continue;
        await wb.updateAnnotationRects(ann.id, rects);
      }
      redrawOverlays();
    })().catch((err) => console.error("rect re-anchor failed", err));
  }, [ready, wb, sourceId, isWebsite, redrawOverlays]);

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
    const page = resolvePageByIndex(returnTarget.pageIndex); // Phase 1 O(1) lookup
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
        let anchor = createAnchor({
          docId: sourceId,
          sourceVersionHash: source.versionHash,
          pageIndex,
          selection,
          pageBox: page.pageBox(),
          pageText: page.pageText,
        });
        // M17 (§1.2(1)): scanned / OCR pages can report empty or 0×0 client
        // rects, so createAnchor yields no `rects` and the highlight would be
        // invisible. Recover non-zero normalized rects from the matched
        // `.textLayer` spans (their cached/synthesized `data-norm-rect`) so a
        // selection on an OCR span always commits a visible highlight.
        if (anchor.rects.length === 0) {
          const ocrRects = createAnchorRectsWithOcrFallback(page.stage, range);
          if (ocrRects.length > 0) anchor = { ...anchor, rects: ocrRects };
        }
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
          // M13 (§1.2) clear the live preview on an immediate tool-first commit.
          setLivePreview(null);
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
      // M13 (§1.2) clear the live watercolor preview on commit so no stale pill
      // lingers after the highlight is painted.
      setLivePreview(null);
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
      // Phase 1: fetch ONLY this page's annotations via the page-bucket index
      // (O(1 + Aₚ)) instead of scanning every annotation of the source. The
      // index uses the same scope->page resolver, so membership is identical;
      // the per-scope rect shaping below is unchanged.
      const views = wb.annotationsForPage(sourceId, pageIndex);
      const targets: HitTestTarget[] = [];
      for (const view of views) {
        const scope = view.annotation.scope;
        if (scope.kind === "text") {
          targets.push({ id: view.annotation.id, rects: scope.anchor.rects });
        } else if (scope.kind === "area") {
          targets.push({ id: view.annotation.id, rects: [scope.anchor.rect] });
        } else {
          // "pages" range: a right-click anywhere on a ranged page targets it.
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
      const page = resolvePageByIndex(pageIndex); // Phase 1 O(1) lookup
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
      const page = resolvePageByIndex(start.pageIndex); // Phase 1 O(1) lookup
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
      const page = resolvePageByIndex(start.pageIndex); // Phase 1 O(1) lookup
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
    // Phase 1 O(1) lookup: data-page-index is 0-based, pageNumber is 1-based.
    const page = resolvePageByIndex(pageNumber - 1);
    page?.container.scrollIntoView({ behavior: "auto", block: "start" });
  }, [resolvePageByIndex]);

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
            <AreaDragPreview areaDrag={areaDrag} pageByIndexRef={pageByIndexRef} mountRef={mountRef} />
          )}
        </div>
      </div>

      {/* FEAT-002 (2.1) fixed viewport layer rendered via a portal OUTSIDE the
          .pane-scroll (overflow:auto) subtree, so the selection toolbar and the
          highlight edit popover are never clipped. */}
      <ReaderFixedLayer>
        {toolbar && toolbar.rect.width !== -1 && (
          <SelectionToolbar
            toolbar={toolbar}
            onCommit={commitHighlight}
            onDismiss={() => {
              setToolbar(null);
              // M13 (§1.2) dismissing the toolbar also clears the live preview.
              setLivePreview(null);
            }}
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
            redrawOverlays={redrawOverlays}
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
 * M14–M16 (FEAT-001) install the windowed-virtualization IntersectionObserver
 * for a large PDF. The observer root is the `.pane-scroll` container (the
 * mount's parent) with a generous 150% vertical rootMargin, so a page is
 * rasterized ~1.5 viewports before it scrolls into view and unloaded once it
 * drifts ~1.5 viewports past — constant memory, 0-latency scrolling. Each page
 * inside the active window carries `data-virtualized-window="true"` on its
 * `.pdf-page-stage`; the exact-size placeholder shell of every offscreen page
 * is kept so scroll height + overlay coordinates never jump. Returns the
 * observer (the caller may disconnect it) or null when IntersectionObserver is
 * unavailable (jsdom, where pages were already rendered eagerly).
 *
 * `onPageRendered` is invoked after a page lazily rasterizes so the pane can
 * repaint that page's highlight overlays onto the freshly built layers.
 */
function installVirtualizationObserver(
  mount: HTMLElement,
  pages: readonly RenderedPage[],
  onPageRendered: () => void,
): IntersectionObserver | null {
  if (typeof IntersectionObserver === "undefined") return null;
  const scroll = mount.parentElement ?? mount;
  const byStage = new Map<Element, RenderedPage>();
  for (const page of pages) byStage.set(page.stage, page);

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const page = byStage.get(entry.target);
        if (!page) continue;
        if (entry.isIntersecting) {
          page.stage.setAttribute("data-virtualized-window", "true");
          if (!page.isRendered()) {
            void page
              .ensureRendered()
              .then(() => onPageRendered())
              .catch((err) => console.error("lazy page render failed", err));
          }
        } else {
          page.stage.removeAttribute("data-virtualized-window");
          // Unload the raster + text layer once the page leaves the 150%
          // window; the exact-size shell remains so geometry is preserved.
          page.unload();
        }
      }
    },
    { root: scroll, rootMargin: "150% 0px", threshold: 0 },
  );
  for (const page of pages) observer.observe(page.stage);
  return observer;
}

/**
 * FEAT-002 best-effort live PDF metadata read used to backfill a source's
 * authors/year when they were not captured at ingest (jsdom has no pdf.js
 * worker, so import-time extraction returns undefined). NEVER rejects: a
 * failure or missing field simply yields an undefined value.
 */
async function readLiveMetadata(
  doc: PDFDocumentProxy,
): Promise<{ authors: string | undefined; year: string | undefined }> {
  try {
    const meta = await doc.getMetadata();
    const info = (meta?.info ?? {}) as Record<string, unknown>;
    const rawAuthor = typeof info.Author === "string" ? info.Author.trim() : "";
    const authors = rawAuthor.length > 0 ? rawAuthor : undefined;
    const year =
      yearFromPdfDate(info.CreationDate) ?? yearFromPdfDate(info.ModDate) ?? undefined;
    return { authors, year };
  } catch {
    return { authors: undefined, year: undefined };
  }
}

/** Parse a 4-digit year out of a PDF date string ("D:YYYYMMDDHHmmSS"). */
function yearFromPdfDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const m = value.match(/D:(\d{4})/) ?? value.match(/(\d{4})/);
  return m ? m[1] : undefined;
}

/**
 * M12 (FEAT-001) best-effort per-page text extraction via pdf.js
 * `getTextContent()`. Joins each item's `str`; preserves newlines where pdf.js
 * flags an end-of-line so the fingerprint engine can strip running headers by
 * line. Scans at most the first 60 pages (enough for canonicalId + a robust
 * MinHash sample) so a huge textbook does not stall the reader. Never throws;
 * returns `[]` when text extraction is unavailable (e.g. a scanned PDF).
 */
async function extractPageTexts(doc: PDFDocumentProxy): Promise<string[]> {
  const out: string[] = [];
  const limit = Math.min(doc.numPages, 60);
  for (let p = 1; p <= limit; p++) {
    try {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const parts: string[] = [];
      for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
        if (typeof item.str === "string") {
          parts.push(item.str);
          if (item.hasEOL) parts.push("\n");
        }
      }
      out.push(parts.join(" "));
    } catch {
      out.push("");
    }
  }
  return out;
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
  pageByIndexRef,
  mountRef,
}: {
  areaDrag: AreaDragState;
  pageByIndexRef: React.MutableRefObject<Map<number, RenderedPage>>;
  mountRef: React.RefObject<HTMLDivElement>;
}): JSX.Element {
  // Phase 1 O(1) lookup of the originating page by its 0-based index.
  const page = pageByIndexRef.current.get(areaDrag.pageIndex);
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
