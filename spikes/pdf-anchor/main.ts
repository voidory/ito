/**
 * Runtime harness for the PDF anchor round-trip spike (FEAT-002, spec
 * section 26). Driven by e2e/pdf-anchor.spec.ts in a REAL chromium browser.
 *
 * It renders the committed 3+ page fixture with a genuine pdf.js text layer and
 * exposes a small imperative API on `window.__spike` so the Playwright test can:
 *   - render a page,
 *   - select a known text range in the real text layer,
 *   - create a portable anchor,
 *   - reload / zoom / resize and resolve it,
 *   - read back the resolved rects + text.
 *
 * All the interesting logic lives in src/pdf; this file only wires it to the DOM
 * and reports JSON so assertions run in Node.
 */

import {
  createAnchor,
  hashBytes,
  loadDocument,
  renderPage,
  resolveAnchor,
  type RenderedPage,
} from "../../src/pdf";
import type { SourceId, SourceVersionHash, TextAnchor } from "../../src/model";
// The fixture is imported as a URL so Vite serves the real committed bytes.
import fixtureUrl from "../../src/test/fixtures/sample-3page.pdf?url";
import type { PDFDocumentProxy } from "pdfjs-dist";

interface SpikeApi {
  /** Load the fixture and render the given 1-based page. */
  render(pageNumber: number, scale?: number): Promise<{
    pageText: string;
    versionHash: string;
    numPages: number;
  }>;
  /** Find the first offset of `needle` in the rendered page text. */
  findOffset(needle: string): number;
  /** Select [start, end) in the live text layer and create an anchor. */
  createAnchorForRange(start: number, end: number): TextAnchor;
  /** Resolve an anchor against the current render; returns rects + text. */
  resolve(anchor: TextAnchor): {
    kind: string;
    rects: { x: number; y: number; width: number; height: number }[];
    text: string;
  };
  /** Re-render the current page at a new scale (zoom). */
  zoom(scale: number): Promise<void>;
  /** Resize the mount container width to simulate a page resize. */
  resizeMount(cssWidth: number): void;
  /** The current page's extracted text. */
  pageText(): string;
}

const mount = document.getElementById("mount") as HTMLDivElement;

let doc: PDFDocumentProxy | null = null;
let fixtureBytes: Uint8Array | null = null;
let versionHash: SourceVersionHash = "" as SourceVersionHash;
let rendered: RenderedPage | null = null;

const DOC_ID = "src_spike_fixture" as SourceId;

async function ensureBytes(): Promise<Uint8Array> {
  if (fixtureBytes) return fixtureBytes;
  const res = await fetch(fixtureUrl);
  fixtureBytes = new Uint8Array(await res.arrayBuffer());
  return fixtureBytes;
}

const api: SpikeApi = {
  async render(pageNumber, scale = 1.5) {
    const bytes = await ensureBytes();
    versionHash = (await hashBytes(bytes)) as SourceVersionHash;
    doc ??= await loadDocument(bytes);
    mount.replaceChildren();
    rendered = await renderPage(doc, pageNumber, mount, scale);
    return {
      pageText: rendered.pageText,
      versionHash,
      numPages: doc.numPages,
    };
  },

  findOffset(needle) {
    if (!rendered) throw new Error("render() first");
    return rendered.pageText.indexOf(needle);
  },

  createAnchorForRange(start, end) {
    if (!rendered) throw new Error("render() first");
    const range = rendered.selectRange(start, end);
    const selection = window.getSelection();
    if (!selection) throw new Error("no window selection");
    selection.removeAllRanges();
    selection.addRange(range);
    return createAnchor({
      docId: DOC_ID,
      sourceVersionHash: versionHash,
      pageIndex: 0,
      selection,
      pageBox: rendered.pageBox(),
      pageText: rendered.pageText,
    });
  },

  resolve(anchor) {
    if (!rendered) throw new Error("render() first");
    const r = resolveAnchor({
      anchor,
      currentVersionHash: versionHash,
      pageText: rendered.pageText,
      pageBox: rendered.pageBox(),
      rangeToClientRects: (s, e) => rendered!.rangeToClientRects(s, e),
    });
    return {
      kind: r.resolution.kind,
      rects: r.rects.map((rc) => ({ ...rc })),
      text: r.text,
    };
  },

  async zoom(scale) {
    if (!rendered) throw new Error("render() first");
    await rendered.rerender(scale);
  },

  resizeMount(cssWidth) {
    mount.style.width = `${cssWidth}px`;
  },

  pageText() {
    if (!rendered) throw new Error("render() first");
    return rendered.pageText;
  },
};

declare global {
  interface Window {
    __spike: SpikeApi;
  }
}

window.__spike = api;
// Signal readiness for the Playwright test.
document.body.setAttribute("data-spike-ready", "true");
