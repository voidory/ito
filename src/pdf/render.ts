/**
 * pdf.js integration: render a page to a canvas + a genuinely selectable text
 * layer, and expose the helpers the anchor layer needs (page text, page box,
 * and a range→client-rects mapper over the real text-layer DOM).
 *
 * This module is browser-only (it touches the DOM and the pdf.js worker) and is
 * exercised by the Playwright spike e2e/pdf-anchor.spec.ts. It is intentionally
 * kept out of the model/anchor logic so that create/resolve stay DOM-agnostic
 * and unit-testable.
 */

import * as pdfjs from "pdfjs-dist";
// Vite resolves this to a hashed asset URL and copies the worker into the build.
import PdfWorker from "pdfjs-dist/build/pdf.worker.mjs?url";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import type { PageBox } from "./anchor";

/**
 * M13 (§1.1) detect pdf.js's RenderingCancelledException WITHOUT importing a
 * concrete class (the symbol is not in the public type surface). A cancelled
 * RenderTask rejects its `.promise`; we identify that rejection by name so we
 * can swallow it (an intentional cancellation is never an error).
 */
function isRenderingCancelled(err: unknown): boolean {
  return (
    err != null &&
    typeof err === "object" &&
    (err as { name?: string }).name === "RenderingCancelledException"
  );
}

pdfjs.GlobalWorkerOptions.workerSrc = PdfWorker;

/** Compute a stable content hash of the PDF bytes (edition-drift detection). */
export async function hashBytes(bytes: Uint8Array): Promise<string> {
  // Copy into a plain ArrayBuffer so the type is BufferSource (not Shared).
  const buf = bytes.slice().buffer as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function loadDocument(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  // Clone into a fresh buffer; pdf.js transfers/neuters the input.
  const data = bytes.slice();
  return pdfjs.getDocument({ data }).promise;
}

/**
 * A rendered page: the canvas, the text-layer container, the extracted page
 * text, and helpers to map between text offsets and DOM geometry.
 */
export interface RenderedPage {
  readonly canvas: HTMLCanvasElement;
  readonly textLayer: HTMLDivElement;
  /** The outer `.pdf-page` wrapper (header + stage). Carries data-page-index. */
  readonly container: HTMLDivElement;
  /**
   * FIX-HIGHLIGHT-OFFSET (3.1) inner `.pdf-page-stage`: the positioning context
   * for the canvas, the text layer and ALL overlays. Exact viewport size.
   */
  readonly stage: HTMLDivElement;
  /**
   * M6 (D01) number of selectable text items pdf.js extracted for this page.
   * 0 means a scanned/image page with no selectable text layer, which the
   * Reader surfaces so the user reaches for page-range or area annotations.
   */
  readonly textItemCount: number;
  readonly pageText: string;
  /** Bounding box of the page container in CSS pixels. */
  pageBox(): PageBox;
  /** Map a [start, end) text offset range to its DOM client rects. */
  rangeToClientRects(start: number, end: number): DOMRect[];
  /** Build a DOM Range selecting the [start, end) text offset range. */
  selectRange(start: number, end: number): Range;
  /** Re-render at a new scale (zoom). Updates geometry in place. */
  rerender(scale: number): Promise<void>;
}

interface GlyphMap {
  /** Flattened page text (what offsets index into). */
  readonly text: string;
  /** For each run div, [startOffset, endOffset) in `text` and the text node. */
  readonly runs: readonly {
    readonly node: Text;
    readonly start: number;
    readonly end: number;
  }[];
}

/**
 * Render a single page (1-based pageNumber) into `mount`. Builds a canvas and a
 * pdf.js TextLayer with real, selectable text divs.
 */
export async function renderPage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  mount: HTMLElement,
  scale = 1.5,
): Promise<RenderedPage> {
  const page: PDFPageProxy = await doc.getPage(pageNumber);

  // FIX-HIGHLIGHT-OFFSET (3.1): the outer `.pdf-page` wrapper now holds a
  // separate page HEADER ("- Page N") ABOVE a dedicated inner STAGE. All
  // overlays (highlights, area boxes, return flashes) position against the
  // STAGE, never the header-bearing wrapper, so a highlight sits over the real
  // glyphs instead of floating near the top of the wrapper under the header.
  const container = document.createElement("div");
  container.className = "pdf-page";
  container.style.position = "relative";
  mount.appendChild(container);

  const header = document.createElement("div");
  header.className = "pdf-page-header";
  header.dataset.testid = "pdf-page-header";
  header.setAttribute("data-testid", "pdf-page-header");
  // ' - Page N' (plain hyphen, NOT an em dash).
  header.textContent = ` - Page ${pageNumber}`;
  container.appendChild(header);

  const stage = document.createElement("div");
  stage.className = "pdf-page-stage";
  stage.setAttribute("data-testid", "pdf-page-stage");
  // The stage establishes the positioning context + exact viewport box; canvas,
  // text layer and overlays all live inside it.
  stage.style.position = "relative";
  container.appendChild(stage);

  const canvas = document.createElement("canvas");
  canvas.style.display = "block";
  stage.appendChild(canvas);

  const textLayer = document.createElement("div");
  textLayer.className = "textLayer";
  // The pdf.js TextLayer positions absolutely-placed spans; the stage must
  // establish the positioning context and overlay exactly on the canvas.
  Object.assign(textLayer.style, {
    position: "absolute",
    left: "0",
    top: "0",
    transformOrigin: "0 0",
    // Make the selectable text visible-but-transparent so Playwright can both
    // see and select it, matching how pdf.js overlays text on the canvas.
    color: "transparent",
  } satisfies Partial<CSSStyleDeclaration>);
  stage.appendChild(textLayer);

  const textContent = await page.getTextContent();

  // M13 (§1.1) the single in-flight pdf.js RenderTask for THIS canvas. The
  // initial draw(scale) and any fit-width/zoom-triggered rerender(nextScale)
  // both go through draw(); without tracking, an in-flight initial render and a
  // rerender can call page.render() twice on the SAME canvas, which pdf.js
  // rejects with "Cannot use the same canvas during multiple render()
  // operations" and clears the canvas to blank white. Cancelling the previous
  // task (and swallowing its RenderingCancelledException) guarantees the two
  // renders are serialized on the canvas.
  let activeRenderTask: RenderTask | null = null;

  async function draw(renderScale: number): Promise<void> {
    const viewport = page.getViewport({ scale: renderScale });
    const ratio = globalThis.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    // The STAGE is sized to the exact viewport box (the overlay positioning
    // context). The outer wrapper sizes to its content (header + stage) so it
    // never becomes the overlay box.
    stage.style.width = `${Math.floor(viewport.width)}px`;
    stage.style.height = `${Math.floor(viewport.height)}px`;
    // pdf.js TextLayer positions its spans using the `--scale-factor` CSS var
    // on the containing element. Without it the text divs do NOT track the
    // canvas across zoom, which would break anchor stability. Set it on both
    // the stage and the text layer so geometry stays consistent.
    stage.style.setProperty("--scale-factor", String(renderScale));
    textLayer.style.setProperty("--scale-factor", String(renderScale));

    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

    // M13 (§1.1) cancel any still-in-flight render on this canvas BEFORE
    // starting a new one so pdf.js never has two concurrent render() calls on
    // the same canvas. The cancelled task's promise rejects with a
    // RenderingCancelledException, which we swallow (it is an intentional
    // supersede, not a failure).
    const previous = activeRenderTask;
    if (previous) {
      previous.cancel();
      try {
        await previous.promise;
      } catch (err) {
        if (!isRenderingCancelled(err)) throw err;
      }
    }

    const task = page.render({ canvasContext: ctx, viewport });
    activeRenderTask = task;
    try {
      await task.promise;
    } catch (err) {
      // A newer draw() may have cancelled THIS task (intentional supersede);
      // swallow that cancellation (and skip the text-layer rebuild so the newer
      // draw owns the DOM). Any other render error is a real failure.
      if (!isRenderingCancelled(err)) throw err;
      return;
    } finally {
      // Only clear the slot if THIS task is still the active one (a newer
      // draw() may already have replaced it).
      if (activeRenderTask === task) activeRenderTask = null;
    }

    // Rebuild the text layer for this scale.
    textLayer.replaceChildren();
    const textLayerBuilder = new pdfjs.TextLayer({
      textContentSource: textContent,
      container: textLayer,
      viewport,
    });
    await textLayerBuilder.render();
  }

  await draw(scale);

  function buildGlyphMap(): GlyphMap {
    // Walk the text-layer DOM in document order, concatenating text nodes and
    // recording each node's offset span. This is derived from the LIVE DOM so
    // the offsets line up with the client rects the DOM reports.
    const runs: { node: Text; start: number; end: number }[] = [];
    let text = "";
    const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
    let n = walker.nextNode();
    while (n) {
      const node = n as Text;
      const content = node.data;
      runs.push({ node, start: text.length, end: text.length + content.length });
      text += content;
      n = walker.nextNode();
    }
    return { text, runs };
  }

  function rangeFor(start: number, end: number): Range {
    const map = buildGlyphMap();
    const startRun = map.runs.find((r) => start >= r.start && start < r.end);
    const endRun = map.runs.find((r) => end > r.start && end <= r.end);
    if (!startRun || !endRun) {
      throw new Error(
        `rangeFor: offsets [${start}, ${end}) not covered by text layer`,
      );
    }
    const range = document.createRange();
    range.setStart(startRun.node, start - startRun.start);
    range.setEnd(endRun.node, end - endRun.start);
    return range;
  }

  const rendered: RenderedPage = {
    canvas,
    textLayer,
    container,
    stage,
    textItemCount: textContent.items.length,
    // The DOM-derived page text (what resolve matches against). Prefer the
    // live DOM text so offsets are internally consistent with client rects.
    get pageText() {
      return buildGlyphMap().text;
    },
    pageBox(): PageBox {
      // FIX-HIGHLIGHT-OFFSET (3.1): measure the STAGE, not the outer wrapper
      // that also contains the page header, so normalized rects map to the
      // glyph region exactly.
      const r = stage.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    },
    rangeToClientRects(start: number, end: number): DOMRect[] {
      return Array.from(rangeFor(start, end).getClientRects());
    },
    selectRange(start: number, end: number): Range {
      return rangeFor(start, end);
    },
    async rerender(nextScale: number): Promise<void> {
      await draw(nextScale);
    },
  };

  return rendered;
}
