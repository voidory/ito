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
import {
  extractPreParsedPageLayout,
  hydrateTextLayerFromCache,
  injectSyntheticOcrTextLayer,
  type PreParsedPageLayout,
  type TextItemLike,
  type ViewportLike,
} from "./textCache";
import { CachedGlyphMap } from "./glyphMap";

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
  /**
   * M14–M16 (FEAT-001) windowed virtualization. `ensureRendered()` rasterizes
   * the canvas + builds the text layer on demand (idempotent — a no-op once the
   * page is already rendered) so a lazily-mounted offscreen page's heavy work
   * is deferred until it enters the IntersectionObserver window. `unload()`
   * releases the canvas raster + text layer when the page scrolls far out of
   * the window (keeping the exact-size placeholder shell so scroll height and
   * overlay coordinates never jump). `isRendered()` reports the current state.
   */
  ensureRendered(): Promise<void>;
  unload(): void;
  isRendered(): boolean;
  /**
   * M17 (§1.1) extract this page's normalized pre-parsed layout (for persisting
   * on `Source.cachedPages`), and synchronously hydrate the text layer from a
   * previously cached layout so an immutable set text is selectable instantly
   * on reload without re-parsing pdf.js text content.
   */
  extractLayout(): PreParsedPageLayout;
  hydrateFromCache(layout: PreParsedPageLayout): void;
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
  options: { lazy?: boolean } = {},
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
  // v2-m1: the stage is its own isolated stacking context, so the multiply
  // blend of the highlight overlays composites against THIS page's canvas and
  // stops there (it can never reach through to the desk behind the page).
  stage.style.setProperty("isolation", "isolate");
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

  // M18 (§11) build-once + cached glyph map for this text layer. Selection /
  // range / pageText operations reuse it instead of re-walking the DOM each
  // time; it is invalidated ONLY when the text layer DOM actually changes (a
  // re-render at a new scale, or a cache hydration) — never on zoom/scroll.
  const glyphMap = new CachedGlyphMap(textLayer);

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
  // M14–M16 (FEAT-001) windowed virtualization state. `isDrawn` tracks whether
  // the canvas raster + text layer are currently built; `currentScale` is the
  // last applied scale so ensureRendered() / rerender() stay consistent.
  let isDrawn = false;
  let currentScale = scale;

  /**
   * M14–M16 (FEAT-001) size the STAGE to the page's exact viewport box WITHOUT
   * rasterizing. This keeps an unrendered (virtualized offscreen) page's
   * placeholder shell at the exact width/height it will occupy once drawn, so
   * scroll height and normalized-rect overlay coordinates never jump when the
   * page lazily rasterizes. Idempotent + cheap.
   */
  function sizeStage(renderScale: number): void {
    const viewport = page.getViewport({ scale: renderScale, rotation: page.rotate });
    stage.style.width = `${Math.floor(viewport.width)}px`;
    stage.style.height = `${Math.floor(viewport.height)}px`;
    stage.style.setProperty("--scale-factor", String(renderScale));
  }

  async function draw(renderScale: number): Promise<void> {
    // M13 FEAT-001 — honour the page's intrinsic `/Rotate` entry. `getViewport`
    // does NOT apply the page rotation unless `rotation` is passed explicitly,
    // so a 90°/180°/270° page would otherwise render UNROTATED: the canvas box
    // stays portrait and pdf.js's TextLayer lays its spans out horizontally in
    // the top-left corner instead of along the visibly-rotated baseline. Pass
    // `page.rotate` so pdf.js rotates BOTH the canvas raster AND the text layer
    // consistently; every downstream consumer (the `--scale-factor` sizing, the
    // DOM-geometry glyph map, `rangeToClientRects`/`selectRange`) reads live
    // client rects off this same rotated layer, so the offset mapping is
    // unaffected.
    const viewport = page.getViewport({ scale: renderScale, rotation: page.rotate });
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

    // M13 FEAT-001 — visually rotate the text layer to overlay the rotated
    // canvas. pdf.js lays the spans out in the UNROTATED page coordinate system
    // (the layer is sized to the raw pageWidth x pageHeight) and tags the
    // container with `data-main-rotation`, expecting the host to rotate the
    // whole layer. We apply that rotate()+translate() here using the live
    // rotated viewport box so the layer re-registers exactly over the stage.
    // The translate distances are the ROTATED on-screen dimensions
    // (viewport.width/height already include the page rotation + scale), so the
    // mapping stays correct across zoom/fit-width rerenders. Rotation 0 clears
    // any prior transform.
    const rot = ((viewport.rotation % 360) + 360) % 360;
    const vw = viewport.width;
    const vh = viewport.height;
    if (rot === 90) {
      textLayer.style.transform = `translate(${vw}px, 0px) rotate(90deg)`;
    } else if (rot === 180) {
      textLayer.style.transform = `translate(${vw}px, ${vh}px) rotate(180deg)`;
    } else if (rot === 270) {
      textLayer.style.transform = `translate(0px, ${vh}px) rotate(270deg)`;
    } else {
      textLayer.style.transform = "";
    }

    // M17 (§1.1/§1.2): tag every live pdf.js text span with its NORMALIZED rect
    // (data-norm-rect) so the scanned/zero-height OCR highlight fallback in
    // highlight.ts can recover geometry even when getClientRects() is 0×0; and
    // if this is an image-only page (0 native text items), inject deterministic
    // synthetic OCR text-band spans so it is still selectable/highlightable.
    annotateSpansWithNormRects(renderScale);

    // M18 (§11): the text-layer DOM was just rebuilt (new text nodes), so the
    // cached glyph map is stale — invalidate it so the next selection/range op
    // rebuilds it once against the fresh DOM.
    glyphMap.invalidate();

    // M14–M16 (FEAT-001): the raster + text layer are now built at this scale.
    isDrawn = true;
    currentScale = renderScale;
  }

  /**
   * M17 (§1.1/§1.2) stamp each `.textLayer` span with a `data-norm-rect`
   * ("x,y,w,h" in 0..1) measured against the stage box, and inject synthetic
   * OCR spans when the page has no native text items. Best-effort + guarded so
   * it never breaks the render (jsdom reports 0×0 boxes, which the OCR fallback
   * and the cached-span `data-norm-rect` path handle downstream).
   */
  function annotateSpansWithNormRects(renderScale: number): void {
    const viewport = page.getViewport({ scale: renderScale, rotation: page.rotate });
    const stageW = viewport.width || 1;
    const stageH = viewport.height || 1;
    if (textContent.items.length === 0) {
      // Image-only / scanned page: inject selectable synthetic OCR bands.
      injectSyntheticOcrTextLayer(textLayer, pageIndexOf(), stageW, stageH);
      return;
    }
    const spans = textLayer.querySelectorAll<HTMLElement>("span");
    const stageBox = stage.getBoundingClientRect();
    const useBox = stageBox.width > 0 && stageBox.height > 0;
    spans.forEach((span) => {
      // Prefer the live client rect (browser); fall back to the pdf.js inline
      // style box (jsdom); skip spans that expose neither.
      const rect = span.getBoundingClientRect();
      let left: number, top: number, w: number, h: number;
      if (useBox && rect.width > 0 && rect.height > 0) {
        left = rect.left - stageBox.left;
        top = rect.top - stageBox.top;
        w = rect.width;
        h = rect.height;
      } else {
        left = parseFloat(span.style.left || "");
        top = parseFloat(span.style.top || "");
        w = parseFloat(span.style.width || "");
        h = parseFloat(span.style.height || "");
        if ([left, top, w, h].some((v) => Number.isNaN(v))) return;
      }
      const nx = left / stageW;
      const ny = top / stageH;
      const nw = Math.max(0.008, w / stageW);
      const nh = Math.max(0.008, h / stageH);
      span.dataset.normRect = `${nx},${ny},${nw},${nh}`;
    });
  }

  /** The 0-based page index this render belongs to (from the container attr). */
  function pageIndexOf(): number {
    const raw = container.getAttribute("data-page-index");
    const n = raw != null ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * M17 (§1.1) extract this page's normalized pre-parsed layout from the pdf.js
   * text content so the SourcePane can persist it on `Source.cachedPages` for
   * instant hydration on the next load. Pure read of the already-fetched
   * `textContent` + the live viewport.
   */
  function extractLayout(): PreParsedPageLayout {
    const viewport = page.getViewport({ scale: currentScale, rotation: page.rotate });
    const vp: ViewportLike = {
      width: viewport.width,
      height: viewport.height,
      rotation: viewport.rotation,
    };
    const items = textContent.items as unknown as TextItemLike[];
    return extractPreParsedPageLayout(pageIndexOf(), vp, items);
  }

  /**
   * M17 (§1.1) synchronously hydrate this page's `.textLayer` from a cached
   * layout so selection / highlights / Ctrl+F work the instant a cached set
   * text reopens — before (or without) a full pdf.js textLayer render.
   */
  function hydrateFromCache(layout: PreParsedPageLayout): void {
    const viewport = page.getViewport({ scale: currentScale, rotation: page.rotate });
    hydrateTextLayerFromCache(textLayer, layout, viewport.width, viewport.height);
    // M18 (§11): hydration replaced the text-layer spans, so the cached glyph
    // map must be rebuilt against the hydrated DOM on next use.
    glyphMap.invalidate();
  }

  // M14–M16 (FEAT-001): size the stage to the exact viewport box up front so a
  // virtualized placeholder shell occupies the correct space immediately.
  sizeStage(scale);
  // Lazy pages defer the heavy rasterize + text-layer build until they enter
  // the IntersectionObserver window (the SourcePane calls ensureRendered()). In
  // every eager path (small docs, and jsdom where IntersectionObserver never
  // fires) we draw now so existing unit/render tests pass unchanged.
  if (!options.lazy) {
    await draw(scale);
  }

  /**
   * M18 (§11) resolve a [start, end) offset range to a DOM Range via the CACHED
   * glyph map (build-once, binary-search lookup). Replaces the former per-call
   * TreeWalker + linear `.find()` scan; the map is reused across selection /
   * range operations and rebuilt only when the text layer DOM changes.
   */
  function rangeFor(start: number, end: number): Range {
    return glyphMap.rangeFor(start, end);
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
      // M18 (§11): reuse the cached glyph map's flattened text.
      return glyphMap.text();
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
      // M14–M16 (FEAT-001): a currently-drawn page re-rasterizes at the new
      // scale; an UNLOADED (virtualized) page only resizes its placeholder
      // shell so scroll height + overlay coordinates track the zoom without
      // paying the raster cost until it re-enters the window.
      if (isDrawn) {
        await draw(nextScale);
      } else {
        currentScale = nextScale;
        sizeStage(nextScale);
      }
    },
    async ensureRendered(): Promise<void> {
      if (isDrawn) return;
      await draw(currentScale);
    },
    unload(): void {
      if (!isDrawn) return;
      // Cancel any in-flight render, then drop the heavy raster + glyph spans
      // but KEEP the exact-size stage shell so scroll geometry never jumps.
      if (activeRenderTask) {
        activeRenderTask.cancel();
        activeRenderTask = null;
      }
      const ctx = canvas.getContext("2d");
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
      canvas.width = 0;
      canvas.height = 0;
      textLayer.replaceChildren();
      textLayer.style.transform = "";
      // M18 (§11): the text layer was emptied; drop the cached glyph map so a
      // later re-render rebuilds it against the fresh DOM.
      glyphMap.invalidate();
      isDrawn = false;
      sizeStage(currentScale);
    },
    isRendered(): boolean {
      return isDrawn;
    },
    extractLayout,
    hydrateFromCache,
  };

  return rendered;
}
