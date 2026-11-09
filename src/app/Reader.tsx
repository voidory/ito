import { useCallback, useEffect, useRef, useState } from "react";
import {
  createAnchor,
  loadDocument,
  renderHighlightOverlay,
  renderPage,
  resolveAnchor,
  type RenderedPage,
} from "../pdf";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { AnchorResolution, AnnotationId, PageId, SourceId, TextAnchor } from "../model";
import {
  HIGHLIGHT_COLORS,
  type AnnotationStyle,
  type AnnotationView,
  type HighlightColor,
  type Workbench,
} from "./workbench";
import { SubjectEditor } from "./SubjectEditor";

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
 * The stored context shown when a followed quote resolves to 'binary-offloaded'
 * (A17). The citation still FUNCTIONS from this metadata; the popover offers
 * re-attachment of the PDF binary to restore the live render.
 */
export interface OffloadedPopover {
  readonly evidenceId: string;
  readonly sourceId: SourceId;
  readonly sourceTitle: string;
  readonly quotedText: string;
  readonly comment: string;
  readonly pageNumber: number;
  readonly reason: string;
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
  const [offloadedPopover, setOffloadedPopover] = useState<OffloadedPopover | null>(null);
  const nonceRef = useRef(0);

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
        setOffloadedPopover({
          evidenceId,
          sourceId: resolved.sourceId,
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
          <label style={{ fontSize: "0.85rem", color: "#555" }}>
            <input
              type="checkbox"
              data-testid="toggle-lines"
              checked={linesVisible}
              onChange={(e) => {
                wb.setLinesVisible(e.target.checked);
                bump();
              }}
            />{" "}
            Show source lines
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
        <main
          data-testid="reader-main"
          data-together={together ? "true" : "false"}
          data-layout={narrow ? "stacked" : "panes"}
          style={{
            ...styles.main,
            flexDirection: narrow ? "column" : "row",
            flexWrap: "nowrap",
            // Closed tab = centred + expanded reading column (only when a single
            // source reads solo with no subject sharing the workspace).
            maxWidth:
              highlightsTabOpen || subjectOpen || paneSlots.length > 1
                ? "none"
                : "60rem",
            margin:
              highlightsTabOpen || subjectOpen || paneSlots.length > 1
                ? "0"
                : "0 auto",
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
                  returnTarget={
                    returnTarget && returnTarget.sourceId === slot.sourceId
                      ? returnTarget
                      : null
                  }
                  openSourceIds={openSourceIds}
                  onScroll={() => bump()}
                  registerScroll={(el) => registerPaneScroll(slot.slotId, el)}
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
          <HighlightsTab wb={wb} openSourceIds={openSourceIds} bump={bump} />
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

interface ToolbarState {
  readonly sourceId: SourceId;
  readonly anchor: TextAnchor;
  readonly x: number;
  readonly y: number;
}

export interface MenuState {
  readonly annotationId: AnnotationId;
  readonly sourceId: SourceId;
  readonly x: number;
  readonly y: number;
}

function SourcePane({
  wb,
  sourceId,
  suppressMotion,
  returnTarget,
  openSourceIds,
  onScroll,
  registerScroll,
  bump,
}: {
  wb: Workbench;
  sourceId: SourceId;
  suppressMotion: boolean;
  returnTarget: ReturnTarget | null;
  openSourceIds: readonly SourceId[];
  onScroll: () => void;
  registerScroll: (el: HTMLElement | null) => void;
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
  // M6 (D01): per-page PDF scope status (scanned / encrypted) surfaced below.
  const [scopeStatus, setScopeStatus] = useState<string | null>(null);
  // M6 (A15, D11): the website snapshot HTML text, when this source is a
  // website rather than a PDF (rendered with full selection/highlighting).
  const [websiteHtml, setWebsiteHtml] = useState<string | null>(null);

  const source = wb.rawData().sources.find((s) => s.id === sourceId);
  const isWebsite = source?.kind === "website" || source?.type === "website";

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
  }, [wb, sourceId, suppressMotion]);

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
  const fittedScaleRef = useRef<number>(1.3);
  useEffect(() => {
    if (!ready || isWebsite) return;
    const mount = mountRef.current;
    if (!mount) return;
    const scroll = mount.parentElement; // the pane-scroll container
    if (!scroll) return;
    let frame = 0;
    const BASE_SCALE = 1.3;
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
      const target = Math.min(BASE_SCALE, Math.max(0.4, avail / intrinsicWidth));
      if (Math.abs(target - fittedScaleRef.current) < 0.02) return;
      fittedScaleRef.current = target;
      void (async () => {
        for (const page of pages) {
          await page.rerender(target);
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

  // M6 (D01): commit a rectangular AREA annotation. For scanned/image PDFs
  // (no selectable text) this is the citable alternative to a text highlight.
  // A default centered rect on the first page is used; the box is draggable in
  // FEAT-003's richer interaction, but the citable record is created here.
  const commitArea = useCallback(async () => {
    const rect = { x: 0.2, y: 0.2, width: 0.6, height: 0.15 };
    await wb.commitAreaAnnotation(sourceId, 0, rect);
    redrawOverlays();
    bump();
  }, [wb, sourceId, redrawOverlays, bump]);

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
      <div style={styles.paneHeader}>
        <strong>{source?.title ?? "…"}</strong>
        <span style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
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
          <button
            data-testid="start-range"
            onClick={() => setRangeMode((v) => !v)}
            aria-pressed={rangeMode}
          >
            Comment on page range
          </button>
          {!isWebsite && (
            <button
              data-testid="add-area-annotation"
              onClick={() => void commitArea()}
              title="Add an area annotation on the first page"
            >
              Mark area
            </button>
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

      <div
        ref={(el) => registerScroll(el)}
        data-testid="pane-scroll"
        data-source-id={sourceId}
        style={styles.paneScroll}
        onScroll={onScroll}
      >
        <div
          ref={mountRef}
          data-testid="pdf-mount"
          style={styles.mount}
          onMouseUp={onMouseUp}
        >
          {isWebsite && websiteHtml != null && (
            <div
              data-testid="website-snapshot"
              data-source-id={sourceId}
              style={styles.websiteSnapshot}
              dangerouslySetInnerHTML={{ __html: sanitizeSnapshotHtml(websiteHtml) }}
            />
          )}
        </div>
      </div>

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
export function AssociationMenu({
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
    // Open the subject for composition so the quote is visible in context.
    wb.openSubjectPage(pageId);
    bump();
    onClose();
  };
  // DELIBERATE subject creation from the selected evidence (spec section 4.2).
  const doCreate = async (): Promise<void> => {
    const title = newTitle.trim();
    if (!title) return;
    const { page } = await wb.createSubjectFromAnnotation(title, menu.annotationId);
    wb.openSubjectPage(page.id);
    bump();
    onClose();
  };
  // D02 "delete highlight only": removes the annotation, keeps every quote.
  const doDeleteOnly = async (): Promise<void> => {
    await wb.deleteAnnotationOnly(menu.annotationId);
    bump();
    onClose();
  };
  // D02 "delete highlight and its quotes": destructive, snapshots then strips.
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
      style={{ ...styles.floating, left: menu.x, top: menu.y + window.scrollY }}
    >
      {!picking && !creating && (
        <>
          <button
            data-testid="menu-create-subject"
            role="menuitem"
            onClick={() => setCreating(true)}
          >
            Create new subject from this…
          </button>
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
          {/* D02 two-mode deletion. "Delete highlight only" removes the
              annotation but PRESERVES every quote (the cited text lives on in
              its subject pages; the reference derives as 'unresolved').
              "Delete highlight and its quotes" is the destructive variant that
              also strips the inline quote nodes after a revision snapshot. */}
          <button
            data-testid="delete-highlight-only"
            role="menuitem"
            onClick={() => void doDeleteOnly()}
          >
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

/**
 * Reference-directed locating in Nodes (N04/N05/N07, §7.1/§7.2). For an
 * annotation CITED into >= 1 subject page (an EvidenceInstance pointing at a
 * subject Page), this renders a "Show in Nodes" control; it renders NOTHING
 * for an annotation cited into zero subject pages (N07 precondition false).
 *
 * The locate transition is an EXPLICIT user action: clicking switches the view
 * to Nodes (`setViewMode('nodes')`) and sets the explicit camera-focus target
 * (`setFocusedPageId`), then bumps. It NEVER runs during ordinary editing, so
 * the camera never jumps unexpectedly (A09-M2).
 *
 *  - N04 (exactly 1 cited subject page): click locates straight to that page.
 *  - N05 (>1 cited subject pages): a lightweight destination picker lists the
 *    linked subject pages so the user chooses which node to center on.
 */
function ShowInNodes({
  wb,
  annotationId,
  bump,
}: {
  wb: Workbench;
  annotationId: AnnotationId;
  bump: () => void;
}): JSX.Element | null {
  const [pickerOpen, setPickerOpen] = useState(false);
  const citedPageIds = wb.citedSubjectPagesForAnnotation(annotationId);
  // N07: no cited subject page => no Show-in-Nodes affordance at all.
  if (citedPageIds.length === 0) return null;

  const locate = (pageId: PageId): void => {
    wb.setViewMode("nodes");
    wb.setFocusedPageId(pageId);
    setPickerOpen(false);
    bump();
  };

  const onClick = (): void => {
    if (citedPageIds.length === 1) {
      // N04: single cited subject page — locate directly.
      locate(citedPageIds[0]!);
      return;
    }
    // N05: multiple cited subject pages — open the destination picker.
    setPickerOpen((v) => !v);
  };

  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
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
 * The binary-offloaded citation popover (A17). The followed quote's source has
 * had its PDF binary evicted locally, so the live render is unavailable. The
 * popover still shows the citation's stored quote + comment + page number +
 * source title (the citation FUNCTIONS from this metadata) and offers an
 * "Attach PDF Binary" file action. Attaching runs `wb.attachSourceBinary`
 * (sha256-verified): a matching file re-hydrates the source back to resolved; a
 * mismatching file is rejected with an inline reason and writes nothing.
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
    // Overlays are measured + positioned relative to the STAGE (not the
    // header-bearing wrapper), so they sit over the selected glyphs (3.1).
    renderHighlightOverlay(page.stage, {
      kind: view.style.kind,
      color: view.style.color,
      rects: anchor.rects,
      animate,
      suppressMotion,
      annotationId: view.annotation.id,
    });
  } else if (view.annotation.scope.kind === "area") {
    // M6 (D01) area annotation: a labeled rectangular region box on the stage.
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
      const page = pages.find(
        (p) => Number(p.container.dataset.pageIndex ?? "-1") === pi,
      );
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

function swatch(c: HighlightColor): string {
  return { yellow: "#ffdd57", green: "#82dc96", blue: "#82beff", pink: "#ff96c8" }[c];
}

/**
 * Minimal defense-in-depth sanitizer for a stored website snapshot (A15, D11).
 * The snapshot was already sanitized at import time by the Workbench; this is a
 * render-time belt-and-braces pass that strips <script> blocks, inline event
 * handlers, and javascript: URLs so a snapshot can never execute script in the
 * reader. The remaining text stays fully selectable for highlighting/quoting.
 */
export function sanitizeSnapshotHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    // Strip inline event-handler attributes whether their value is
    // double-quoted, single-quoted, OR UNQUOTED (e.g. onclick=alert(1)). The
    // leading-whitespace capture group ($1) is preserved so adjacent attributes
    // are not glued together after the strip.
    .replace(/(\s)on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "$1")
    .replace(/javascript:/gi, "");
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
  main: {
    flex: 1,
    position: "relative",
    overflow: "hidden",
    display: "flex",
    alignItems: "stretch",
  },
  pane: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
    minWidth: 0,
    borderRight: "1px solid #eee",
  },
  paneScroll: {
    flex: 1,
    minHeight: 0,
    overflow: "auto",
    padding: "1rem",
  },
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
  scopeStatus: {
    padding: "0.5rem 0.75rem",
    margin: "0 0 0.5rem",
    background: "#fff4e5",
    border: "1px solid #f0c38a",
    borderRadius: "6px",
    color: "#7a4b00",
    fontSize: "0.82rem",
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
