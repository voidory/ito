import { useMemo, useRef, useState } from "react";
import type { AnnotationId, PageId, SourceId } from "../model";
import type { Workbench } from "./workbench";
import { MobileCaptureComposer } from "./MobileCaptureComposer";

/**
 * M4/M5 (§16.1, A20, A21) the responsive Phone Reading shell. On a phone (or
 * when toggled on for deterministic testing) the workbench collapses to a
 * single-document flow:
 *
 *   Library -> single-document Reader -> tap a cited annotation/passage
 *   ("Inspect Related Writing") -> a slide-up bottom sheet shows the linked
 *   Subject Page prose & quotes -> "Back to Reading" closes the sheet and
 *   PRESERVES the exact PDF source + page scroll position + zoom scale (A21).
 *
 * The sheet is an OVERLAY: opening/closing it never remounts the reader body,
 * so the reader's scroll offset and zoom scale (held in refs here) survive the
 * round-trip untouched. Per-source mobile offline cache controls let a phone
 * user selectively cache or offload the PDF binary.
 */
export function MobileReaderSheet({
  wb,
  sourceId,
  onBackToLibrary,
  onChange,
}: {
  wb: Workbench;
  /** The single source open in the phone reader. */
  sourceId: SourceId;
  onBackToLibrary: () => void;
  onChange: () => void;
}): JSX.Element {
  // Reader view state the A21 round-trip must preserve across sheet open/close.
  // Held in refs so the sheet overlay (which does NOT remount this body) can be
  // shown/hidden without disturbing scroll offset or zoom scale.
  const scrollRef = useRef(0);
  const [zoom, setZoom] = useState(1);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // The related-writing bottom sheet target: the annotation whose cited subject
  // pages we are inspecting, or null when the sheet is closed.
  const [inspecting, setInspecting] = useState<AnnotationId | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);

  const source = useMemo(
    () => wb.rawData().sources.find((s) => s.id === sourceId) ?? null,
    [wb, sourceId, wb.rawData()],
  );
  const annotations = useMemo(
    () => wb.annotationsForSource(sourceId),
    [wb, sourceId, wb.rawData()],
  );
  const binaryStatus = wb.sourceBinaryStatus(sourceId);

  const captureScroll = (): void => {
    if (bodyRef.current) scrollRef.current = bodyRef.current.scrollTop;
  };
  const restoreScroll = (): void => {
    if (bodyRef.current) bodyRef.current.scrollTop = scrollRef.current;
  };

  const openSheet = (annotationId: AnnotationId): void => {
    // Preserve the exact scroll position before the sheet slides up (A21).
    captureScroll();
    setInspecting(annotationId);
  };
  const closeSheet = (): void => {
    setInspecting(null);
    // Restore the exact scroll position after the sheet closes (A21).
    restoreScroll();
  };

  const onOffload = async (): Promise<void> => {
    await wb.offloadSourceBinary(sourceId);
    onChange();
  };
  const onAttach = async (file: File | null): Promise<void> => {
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    await wb.attachSourceBinary(sourceId, bytes);
    onChange();
  };

  return (
    <section
      data-testid="mobile-reader-shell"
      data-source-id={sourceId}
      data-zoom={zoom}
      style={styles.shell}
    >
      <header style={styles.header}>
        <button data-testid="mobile-back-to-library" onClick={onBackToLibrary}>
          ← Library
        </button>
        <span data-testid="mobile-reader-title" style={styles.title}>
          {source?.title ?? "Document"}
        </span>
        <span style={styles.spacer} />
        <div style={styles.zoomControls}>
          <button
            data-testid="mobile-zoom-out"
            aria-label="Zoom out"
            onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.1) * 10) / 10))}
          >
            −
          </button>
          <span data-testid="mobile-zoom-scale">{zoom.toFixed(1)}×</span>
          <button
            data-testid="mobile-zoom-in"
            aria-label="Zoom in"
            onClick={() => setZoom((z) => Math.min(3, Math.round((z + 0.1) * 10) / 10))}
          >
            +
          </button>
        </div>
        <button data-testid="open-capture-composer" onClick={() => setComposerOpen((v) => !v)}>
          {composerOpen ? "Close capture" : "Capture"}
        </button>
      </header>

      {/* Per-source mobile offline cache controls. */}
      <div style={styles.cacheBar}>
        <span
          data-testid="source-binary-status"
          data-source-id={sourceId}
          data-status={binaryStatus}
          style={styles.statusBadge}
        >
          {binaryStatus}
        </span>
        <button
          data-testid="offload-pdf-binary"
          data-source-id={sourceId}
          disabled={binaryStatus === "binary-offloaded"}
          onClick={() => void onOffload()}
        >
          Offload PDF
        </button>
        <label data-testid="attach-pdf-binary" style={{ cursor: "pointer" }}>
          Attach PDF
          <input
            data-testid="attach-pdf-input"
            type="file"
            accept="application/pdf,.pdf"
            style={{ display: "none" }}
            onChange={(e) => void onAttach(e.target.files?.[0] ?? null)}
          />
        </label>
      </div>

      {composerOpen ? (
        <MobileCaptureComposer wb={wb} currentSourceId={sourceId} onChange={onChange} />
      ) : null}

      {/* The single-document reader body. Its scroll + zoom survive the sheet. */}
      <div
        ref={bodyRef}
        data-testid="mobile-reader-body"
        style={{ ...styles.body, fontSize: `${zoom}rem` }}
      >
        {annotations.length === 0 ? (
          <p style={{ color: "#777" }}>No cited passages in this document yet.</p>
        ) : (
          <ul style={styles.annotationList}>
            {annotations.map((view) => {
              const citedPages = wb.citedSubjectPagesForAnnotation(view.annotation.id);
              const quote =
                view.annotation.comment ?? view.rangeLabel ?? "Highlighted passage";
              return (
                <li
                  key={view.annotation.id}
                  data-testid="mobile-reader-passage"
                  data-annotation-id={view.annotation.id}
                  style={styles.passage}
                >
                  <span style={{ flex: 1 }}>{quote}</span>
                  {citedPages.length > 0 ? (
                    <button
                      data-testid="mobile-inspect-writing"
                      data-annotation-id={view.annotation.id}
                      onClick={() => openSheet(view.annotation.id)}
                    >
                      Inspect Related Writing
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {inspecting ? (
        <RelatedWritingSheet
          wb={wb}
          annotationId={inspecting}
          onBack={closeSheet}
        />
      ) : null}
    </section>
  );
}

/**
 * The slide-up related-writing bottom sheet (A21): shows the Subject Page prose
 * and quotes linked to the tapped annotation. "Back to Reading" closes it,
 * returning to the exact reader context (its parent restores scroll + zoom).
 */
function RelatedWritingSheet({
  wb,
  annotationId,
  onBack,
}: {
  wb: Workbench;
  annotationId: AnnotationId;
  onBack: () => void;
}): JSX.Element {
  const pageIds = wb.citedSubjectPagesForAnnotation(annotationId);
  const pages = pageIds
    .map((id: PageId) => wb.rawData().pages.find((p) => p.id === id))
    .filter((p): p is NonNullable<typeof p> => p != null);

  return (
    <aside
      data-testid="mobile-related-writing-sheet"
      role="dialog"
      aria-label="Related writing"
      style={styles.sheet}
    >
      <div style={styles.sheetHeader}>
        <h3 style={{ margin: 0 }}>Related writing</h3>
        <button data-testid="mobile-return-to-reading" onClick={onBack}>
          Back to Reading
        </button>
      </div>
      <div style={styles.sheetBody}>
        {pages.length === 0 ? (
          <p style={{ color: "#777" }}>No linked subject page.</p>
        ) : (
          pages.map((page) => (
            <article
              key={page.id}
              data-testid="related-writing-page"
              data-page-id={page.id}
              style={{ marginBottom: "1rem" }}
            >
              <h4 style={{ margin: "0 0 0.25rem" }}>{page.title}</h4>
              <ProsePreview wb={wb} pageId={page.id} />
            </article>
          ))
        )}
      </div>
    </aside>
  );
}

/** Renders the subject page's prose as plain text extracted from its doc JSON. */
function ProsePreview({ wb, pageId }: { wb: Workbench; pageId: PageId }): JSX.Element {
  const text = useMemo(() => {
    try {
      return extractText(wb.subjectDocJson(pageId));
    } catch {
      return "";
    }
  }, [wb, pageId]);
  return (
    <p data-testid="related-writing-prose" style={{ whiteSpace: "pre-wrap", margin: 0 }}>
      {text}
    </p>
  );
}

/** Flatten a ProseMirror document JSON into its visible text runs. */
function extractText(doc: unknown): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as { text?: unknown; content?: unknown };
    if (typeof n.text === "string") out.push(n.text);
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(doc);
  return out.join(" ").trim();
}

const styles: Record<string, React.CSSProperties> = {
  shell: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    minHeight: "100%",
    maxWidth: "48rem",
    margin: "0 auto",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.5rem 0.75rem",
    borderBottom: "1px solid #e5e2dc",
    flexWrap: "wrap",
  },
  title: { fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  spacer: { flex: 1 },
  zoomControls: { display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.85rem" },
  cacheBar: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.4rem 0.75rem",
    borderBottom: "1px solid #eee",
    fontSize: "0.8rem",
  },
  statusBadge: {
    fontSize: "0.72rem",
    padding: "0.05rem 0.45rem",
    borderRadius: "4px",
    background: "#e6f4ea",
    color: "#166534",
  },
  body: { flex: 1, overflow: "auto", padding: "0.75rem" },
  annotationList: { listStyle: "none", padding: 0, margin: 0 },
  passage: {
    display: "flex",
    alignItems: "center",
    gap: "0.6rem",
    padding: "0.5rem 0",
    borderBottom: "1px solid #eee",
  },
  sheet: {
    position: "fixed",
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: "70vh",
    overflow: "auto",
    background: "#fff",
    borderTop: "1px solid #dcd6c8",
    borderTopLeftRadius: "14px",
    borderTopRightRadius: "14px",
    boxShadow: "0 -6px 24px rgba(0,0,0,0.18)",
    padding: "1rem",
    zIndex: 50,
  },
  sheetHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "0.75rem",
  },
  sheetBody: {},
};
