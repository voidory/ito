import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { IconButton } from "../ui/primitives";

/**
 * M9 (FEAT-002 2) the LEFT reader sidebar, toggled by the toolbar's left
 * sidebar button. Two tabs built from the shared primitive chrome:
 *
 *  - Thumbnails: one ~120px-wide page thumbnail per page, LAZILY rendered via
 *    an IntersectionObserver (only visible pages draw to a canvas). The current
 *    page is outlined; clicking a thumbnail jumps the reader to that page.
 *  - Outline: the pdf.js document outline (getOutline). The tab is HIDDEN
 *    entirely when the document has no outline.
 *
 * It is presentation-only: all navigation flows back through {@link onJump}.
 */

const THUMB_WIDTH = 120;

interface OutlineEntry {
  readonly title: string;
  readonly pageNumber: number | null;
  readonly depth: number;
}

export function LeftSidebar({
  doc,
  pageCount,
  currentPage,
  onJump,
}: {
  doc: PDFDocumentProxy | null;
  pageCount: number;
  currentPage: number;
  onJump: (pageNumber: number) => void;
}): JSX.Element {
  const [outline, setOutline] = useState<OutlineEntry[] | null>(null);
  const [tab, setTab] = useState<"thumbnails" | "outline">("thumbnails");

  // Load the document outline once per document; a null/empty outline hides the
  // Outline tab entirely.
  useEffect(() => {
    let cancelled = false;
    setOutline(null);
    if (!doc) return;
    (async () => {
      try {
        const raw = (await doc.getOutline()) as unknown as RawOutlineNode[] | null;
        if (cancelled) return;
        const flat = raw ? await flattenOutline(doc, raw, 0) : [];
        if (!cancelled) setOutline(flat);
      } catch {
        if (!cancelled) setOutline([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc]);

  const hasOutline = (outline?.length ?? 0) > 0;
  // If the active tab becomes unavailable (outline vanished), fall back.
  useEffect(() => {
    if (tab === "outline" && !hasOutline) setTab("thumbnails");
  }, [tab, hasOutline]);

  return (
    <aside
      data-testid="reader-left-sidebar"
      aria-label="Document navigation"
      className="ito-left-sidebar"
    >
      <div className="ito-left-sidebar-tabs" role="tablist" aria-label="Sidebar tabs">
        <IconButton
          label="Thumbnails"
          data-testid="left-tab-thumbnails"
          pressed={tab === "thumbnails"}
          role="tab"
          aria-selected={tab === "thumbnails"}
          onClick={() => setTab("thumbnails")}
        >
          ▦
        </IconButton>
        {hasOutline && (
          <IconButton
            label="Outline"
            data-testid="left-tab-outline"
            pressed={tab === "outline"}
            role="tab"
            aria-selected={tab === "outline"}
            onClick={() => setTab("outline")}
          >
            ☰
          </IconButton>
        )}
      </div>

      {tab === "thumbnails" && (
        <ThumbnailStrip doc={doc} pageCount={pageCount} currentPage={currentPage} onJump={onJump} />
      )}
      {tab === "outline" && hasOutline && (
        <ul data-testid="outline-list" className="ito-outline-list">
          {outline!.map((entry, i) => (
            <li key={i} style={{ paddingLeft: `${entry.depth * 0.75}rem` }}>
              <button
                type="button"
                data-testid="outline-entry"
                className="ito-outline-entry"
                disabled={entry.pageNumber == null}
                onClick={() => entry.pageNumber != null && onJump(entry.pageNumber)}
              >
                {entry.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

function ThumbnailStrip({
  doc,
  pageCount,
  currentPage,
  onJump,
}: {
  doc: PDFDocumentProxy | null;
  pageCount: number;
  currentPage: number;
  onJump: (pageNumber: number) => void;
}): JSX.Element {
  return (
    <ul data-testid="thumbnail-strip" className="ito-thumbnail-strip">
      {Array.from({ length: pageCount }, (_, i) => i + 1).map((pageNumber) => (
        <li key={pageNumber}>
          <PageThumbnail
            doc={doc}
            pageNumber={pageNumber}
            current={pageNumber === currentPage}
            onJump={onJump}
          />
        </li>
      ))}
    </ul>
  );
}

function PageThumbnail({
  doc,
  pageNumber,
  current,
  onJump,
}: {
  doc: PDFDocumentProxy | null;
  pageNumber: number;
  current: boolean;
  onJump: (pageNumber: number) => void;
}): JSX.Element {
  const ref = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const renderedRef = useRef(false);

  // Lazily flip to visible when the thumbnail scrolls into view.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setVisible(true);
            io.disconnect();
          }
        }
      },
      { root: el.closest(".ito-thumbnail-strip"), rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Render the page into the canvas exactly once it is visible.
  useEffect(() => {
    let cancelled = false;
    if (!visible || !doc || renderedRef.current) return;
    (async () => {
      try {
        const page = await doc.getPage(pageNumber);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        const scale = THUMB_WIDTH / base.width;
        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        await page.render({ canvasContext: ctx, viewport }).promise;
        renderedRef.current = true;
      } catch {
        /* thumbnail rendering is best-effort */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, doc, pageNumber]);

  return (
    <button
      ref={ref}
      type="button"
      data-testid="page-thumbnail"
      data-page-number={pageNumber}
      data-current={current ? "true" : undefined}
      className="ito-page-thumbnail"
      aria-label={`Page ${pageNumber}`}
      aria-current={current ? "page" : undefined}
      onClick={() => onJump(pageNumber)}
    >
      <canvas ref={canvasRef} className="ito-page-thumbnail-canvas" width={THUMB_WIDTH} height={1} />
      <span className="ito-page-thumbnail-label">{pageNumber}</span>
    </button>
  );
}

/* --------------------------------------------------------------------- */
/* pdf.js outline flattening                                             */
/* --------------------------------------------------------------------- */

interface RawOutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items?: RawOutlineNode[];
}

/** Resolve a pdf.js outline destination to a 1-based page number (best effort). */
async function destToPageNumber(
  doc: PDFDocumentProxy,
  dest: string | unknown[] | null,
): Promise<number | null> {
  try {
    const resolved = typeof dest === "string" ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(resolved) || resolved.length === 0) return null;
    const ref = resolved[0];
    const index = await doc.getPageIndex(ref as never);
    return index + 1;
  } catch {
    return null;
  }
}

async function flattenOutline(
  doc: PDFDocumentProxy,
  nodes: RawOutlineNode[],
  depth: number,
): Promise<OutlineEntry[]> {
  const out: OutlineEntry[] = [];
  for (const node of nodes) {
    out.push({
      title: node.title,
      pageNumber: await destToPageNumber(doc, node.dest),
      depth,
    });
    if (node.items && node.items.length > 0) {
      out.push(...(await flattenOutline(doc, node.items, depth + 1)));
    }
  }
  return out;
}
