import { useCallback, useEffect, useRef, useState } from "react";
import type { AnnotationId, PageId, SourceId } from "../model";
import { type HighlightColor, type Workbench } from "./workbench";
import { SubjectEditor } from "./SubjectEditor";
import { importPdfFiles } from "./pdfImport";
import { ReaderToolbar, type ActiveTool } from "./reader/ReaderToolbar";
import { AnnotationSidebar } from "./reader/AnnotationSidebar";
import { LeftSidebar } from "./reader/LeftSidebar";
import {
  cssEscapeId,
  styles,
  BinaryOffloadedPopover,
  type OffloadedPopover as OffloadedPopoverState,
} from "./reader/AnnotationOverlays";
import { SourcePane } from "./reader/SourcePane";
import { PaneGroup, PassageEvidenceLines } from "./reader/EvidenceLines";
import { type PaneCommands, type ReturnTarget } from "./reader/paneTypes";

/*
 * FEAT-001/002: the reader is composed of focused modules under src/app/reader/*:
 * the annotation OVERLAYS (AnnotationOverlays), the single TOOLBAR + the two
 * SIDEBARs, the SourcePane (pdf.js lifecycle + in-pane annotation interactions)
 * and the inter-pane EvidenceLines/PaneGroup. Reader.tsx remains the shell +
 * state owner and BARREL re-exports the moved symbols so existing imports
 * (tests + testApi.ts) keep resolving unchanged.
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
export {
  createScrollCoalescer,
  type PaneCommands,
  type ScrollCoalescer,
} from "./reader/paneTypes";

/**
 * M14–M16 (FEAT-001) the minimum viewport width (px) at which the integrated
 * workspace renders the full 3-pane center-editor layout (Paper A | Editor |
 * Paper B) when two sources are open together with a subject page. BELOW this
 * width the workspace adapts to a compact 2-pane layout (Paper A | Editor) with
 * the 2nd PDF surfaced as a 1-click quick-swap tab. Exported so the test asserts
 * the exact boundary.
 */
export const WORKSPACE_3PANE_MIN_WIDTH = 1360;

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
  // M14–M16 (FEAT-001): the live viewport width driving the adaptive <1360px
  // multi-pane breakpoint. Tracked alongside the phone `narrow` flag.
  const [viewportWidth, setViewportWidth] = useState<number>(() =>
    typeof window !== "undefined" ? window.innerWidth : WORKSPACE_3PANE_MIN_WIDTH,
  );
  useEffect(() => {
    const onResize = (): void => {
      setNarrow(window.innerWidth < 760);
      setViewportWidth(window.innerWidth);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // The ordered pane slots: each open source is a reader pane; the open subject
  // page is the middle composition pane. The approved arrangement interleaves
  // the subject between sources (Paper A | subject | Paper B) when two sources
  // are open together; otherwise it trails the single source.
  // M14–M16 (FEAT-001): below WORKSPACE_3PANE_MIN_WIDTH a 2-sources+subject
  // workspace is TOO narrow for the full Paper A | Editor | Paper B layout, so
  // it collapses to a compact Paper A | Editor and surfaces Paper B as a
  // 1-click quick-swap tab. `compactTwoPane` gates that layout; `secondSourceId`
  // is the hidden Paper B offered for the swap.
  const compactTwoPane =
    !narrow &&
    subjectOpen &&
    openSourceIds.length >= 2 &&
    viewportWidth < WORKSPACE_3PANE_MIN_WIDTH;
  const secondSourceId: SourceId | null = compactTwoPane ? openSourceIds[1]! : null;

  const paneSlots: { slotId: string; kind: "source" | "subject"; sourceId?: SourceId }[] =
    (() => {
      const sources = openSourceIds.map((id) => ({
        slotId: id as string,
        kind: "source" as const,
        sourceId: id,
      }));
      if (!subjectOpen) return sources;
      const subjectPane = { slotId: "subject", kind: "subject" as const };
      // Compact 2-pane: render ONLY the first PDF pane beside the Editor; the
      // 2nd PDF (Paper B) is reachable via the quick-swap tab.
      if (compactTwoPane) {
        return [sources[0]!, subjectPane];
      }
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

  // M13 (§2.2): the Source Switcher Pill data for a node / node-intersection
  // workspace — the cited sources ranked by citation count DESC. The open
  // workspace shows the TOP-2 in the pane slots; any cited source NOT currently
  // open is offered under "Swap to:". Only shown when there are cited sources
  // AND the open page is a node / node-intersection workspace page.
  const openPageKind = wb.snapshot().openPageKind;
  const sourceRanking =
    openPageKind === "node" || openPageKind === "node-intersection"
      ? wb.citedSourceRankingForOpenWorkspace()
      : [];
  const swapTargets = sourceRanking.filter((r) => !openSourceIds.includes(r.sourceId));
  // Swap a cited source into a reader pane: if two panes are open, replace the
  // lowest-ranked open source; otherwise add alongside (ensureSourceOpen). This
  // keeps the subject page open and the other panes untouched (§8.2 note).
  const swapInSource = useCallback(
    (toSourceId: SourceId) => {
      const openCited = sourceRanking.filter((r) => openSourceIds.includes(r.sourceId));
      const replaceTarget = openCited.length >= 2 ? openCited[openCited.length - 1]!.sourceId : null;
      if (replaceTarget) wb.switchReaderPane(replaceTarget, toSourceId);
      else wb.ensureSourceOpen(toSourceId);
      bump();
    },
    [wb, bump, sourceRanking, openSourceIds],
  );

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
      {/* M14–M16 (FEAT-002): "← Return to Map" — switch back to the Nodes view
          and smoothly pull the camera back out from the last dive target. Only
          shown once a dive into this workspace was recorded. */}
      {wb.lastDiveTarget() != null && (
        <button
          data-testid="return-to-map-dive-btn"
          className="ito-return-to-map"
          onClick={() => {
            wb.returnToMap();
            bump();
          }}
          style={{
            alignSelf: "flex-start",
            margin: "0.35rem 0.75rem",
            padding: "0.3rem 0.7rem",
            fontSize: "0.82rem",
            border: "1px solid #d9d4c7",
            borderRadius: "6px",
            background: "#f4f1ea",
            cursor: "pointer",
          }}
        >
          ← Return to Map
        </button>
      )}
      <input
        ref={readerPdfInputRef}
        data-testid="import-pdf-input"
        type="file"
        accept=".pdf,application/pdf"
        multiple
        className="ito-visually-hidden-input"
        onChange={(e) => {
          void importReaderFiles(e.target.files);
          e.target.value = "";
        }}
      />
      {together && (
        <div data-testid="open-together-indicator" className="ito-open-together">
          Shared workspace · no analysis
        </div>
      )}

      {/* M13 (§2.2): Source Switcher Pill — lists cited sources with counts and
          offers to "Swap to:" any cited source not currently in a pane (e.g.
          "Paper A (5) · Paper B (3) · Swap to: Paper C (1)"). Toggling swaps a
          3rd+ PDF into a pane via switchReaderPane/ensureSourceOpen.
          M14–M16 (FEAT-001): in the compact <1360px 2-pane layout the switcher
          also renders even with no cited sources, carrying the prominent
          `compact-second-source-tab` at its FRONT for 1-click swapping to the
          hidden Paper B. */}
      {(sourceRanking.length > 0 || compactTwoPane) && (
        <div
          data-testid="workspace-source-switcher"
          className="ito-source-switcher"
          role="group"
          aria-label="Cited sources"
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "0.3rem",
            padding: "0.35rem 0.75rem",
            fontSize: "0.82rem",
            background: "#f4f1ea",
            borderBottom: "1px solid #e5e2dc",
          }}
        >
          {/* M14–M16 (FEAT-001): prominent 1-click quick-swap tab for the hidden
              Paper B in the compact 2-pane layout. Clicking promotes Paper B
              into the single visible PDF pane (swapping it with Paper A) so the
              user can flip between the two papers without the full 3-pane width. */}
          {compactTwoPane && secondSourceId != null && (
            <button
              data-testid="compact-second-source-tab"
              data-source-id={secondSourceId}
              className="ito-compact-source-tab"
              onClick={() => {
                wb.promoteOpenSource(secondSourceId);
                bump();
              }}
              style={{
                fontWeight: 600,
                padding: "0.2rem 0.6rem",
                marginRight: "0.4rem",
                border: "1px solid #c9b98a",
                borderRadius: "6px",
                background: "#fbf3dd",
                cursor: "pointer",
              }}
            >
              {wb.rawData().sources.find((s) => s.id === secondSourceId)?.title ?? "Paper B"} →
            </button>
          )}
          <span style={{ fontWeight: 600, marginRight: "0.25rem" }}>Sources:</span>
          {sourceRanking.map((r, i) => (
            <span
              key={r.sourceId}
              data-testid="source-switcher-cited"
              data-source-id={r.sourceId}
              data-count={r.count}
              data-open={openSourceIds.includes(r.sourceId) ? "true" : "false"}
              style={{ opacity: openSourceIds.includes(r.sourceId) ? 1 : 0.7 }}
            >
              {i > 0 ? " · " : ""}
              {r.title} ({r.count})
            </span>
          ))}
          {swapTargets.length > 0 && (
            <span style={{ marginLeft: "0.5rem" }}>
              Swap to:{" "}
              {swapTargets.map((r) => (
                <button
                  key={r.sourceId}
                  data-testid="source-switcher-swap"
                  data-source-id={r.sourceId}
                  data-count={r.count}
                  className="ito-source-swap-btn"
                  onClick={() => swapInSource(r.sourceId)}
                >
                  {r.title} ({r.count})
                </button>
              ))}
            </span>
          )}
        </div>
      )}

      {returnNotice && (
        <div data-testid="source-return-notice" role="alert" style={styles.returnNotice}>
          {returnNotice}
          <button
            data-testid="dismiss-return-notice"
            aria-label="Dismiss"
            onClick={() => setReturnNotice(null)}
            className="ito-dismiss-inline"
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
        data-workspace-density={compactTwoPane ? "compact-2pane" : undefined}
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
          className="ito-reader-main"
          style={{
            ...styles.main,
            flexDirection: narrow ? "column" : "row",
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
                  className="ito-subject-pane-fill"
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
