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
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { PageBox } from "./anchor";

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
  readonly container: HTMLDivElement;
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

  const container = document.createElement("div");
  container.className = "pdf-page";
  container.style.position = "relative";
  mount.appendChild(container);

  const canvas = document.createElement("canvas");
  canvas.style.display = "block";
  container.appendChild(canvas);

  const textLayer = document.createElement("div");
  textLayer.className = "textLayer";
  // The pdf.js TextLayer positions absolutely-placed spans; the container must
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
  container.appendChild(textLayer);

  const textContent = await page.getTextContent();

  async function draw(renderScale: number): Promise<void> {
    const viewport = page.getViewport({ scale: renderScale });
    const ratio = globalThis.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    container.style.width = `${Math.floor(viewport.width)}px`;
    container.style.height = `${Math.floor(viewport.height)}px`;
    // pdf.js TextLayer positions its spans using the `--scale-factor` CSS var
    // on the containing element. Without it the text divs do NOT track the
    // canvas across zoom, which would break anchor stability. Set it on both
    // the page container and the text layer so geometry stays consistent.
    container.style.setProperty("--scale-factor", String(renderScale));
    textLayer.style.setProperty("--scale-factor", String(renderScale));

    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    await page.render({ canvasContext: ctx, viewport }).promise;

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
    // The DOM-derived page text (what resolve matches against). Prefer the
    // live DOM text so offsets are internally consistent with client rects.
    get pageText() {
      return buildGlyphMap().text;
    },
    pageBox(): PageBox {
      const r = container.getBoundingClientRect();
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
