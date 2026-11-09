/**
 * FIX-HIGHLIGHT-OFFSET (spec 3.1) overlay-alignment coverage (jsdom).
 *
 * The real highlight-offset bug was that overlays were measured/positioned
 * against the outer wrapper that ALSO holds the "- Page N" header, so a
 * highlight floated near the top of the wrapper under the header instead of
 * sitting over the glyphs. The fix moves the canvas/text-layer/overlays into a
 * dedicated STAGE and positions overlays relative to that stage.
 *
 * `render.ts` needs the pdf.js worker (browser-only), so these tests drive the
 * pure DOM half directly: they build the same `.pdf-page` > header + stage >
 * (canvas, overlays, .textLayer) structure and assert `renderHighlightOverlay`
 * draws into the STAGE (never the header), positions boxes by the annotation's
 * normalized rects, and renders a labeled area box for an area annotation.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  cropCanvasRegionToDataUrl,
  hitTestAnnotations,
  renderHighlightOverlay,
  type HitTestTarget,
} from "./highlight";

let pageWrapper: HTMLElement | null = null;

/** Build a `.pdf-page` wrapper mirroring render.ts: header + stage + text layer. */
function buildPage(): { wrapper: HTMLElement; header: HTMLElement; stage: HTMLElement } {
  const wrapper = document.createElement("div");
  wrapper.className = "pdf-page";
  const header = document.createElement("div");
  header.setAttribute("data-testid", "pdf-page-header");
  header.textContent = " - Page 1";
  const stage = document.createElement("div");
  stage.setAttribute("data-testid", "pdf-page-stage");
  stage.style.position = "relative";
  const canvas = document.createElement("canvas");
  const textLayer = document.createElement("div");
  textLayer.className = "textLayer";
  stage.append(canvas, textLayer);
  wrapper.append(header, stage);
  document.body.appendChild(wrapper);
  pageWrapper = wrapper;
  return { wrapper, header, stage };
}

afterEach(() => {
  pageWrapper?.remove();
  pageWrapper = null;
});

describe("renderHighlightOverlay - stage alignment (3.1)", () => {
  it("draws the overlay inside the stage, never inside the page header", () => {
    const { header, stage } = buildPage();
    renderHighlightOverlay(stage, {
      kind: "highlight",
      color: "yellow",
      rects: [{ x: 0.1, y: 0.5, width: 0.4, height: 0.03 }],
      animate: false,
      suppressMotion: true,
      annotationId: "ann-1",
    });
    const overlay = stage.querySelector(".ito-highlight") as HTMLElement;
    expect(overlay).not.toBeNull();
    // The overlay is a descendant of the STAGE, not the header.
    expect(stage.contains(overlay)).toBe(true);
    expect(header.contains(overlay)).toBe(false);
    // It sits BENEATH the text layer (so glyphs stay selectable) but after the
    // canvas (so it is above the opaque canvas).
    const children = Array.from(stage.children);
    const overlayIdx = children.indexOf(overlay);
    const textIdx = children.findIndex((c) => c.classList.contains("textLayer"));
    expect(overlayIdx).toBeGreaterThanOrEqual(0);
    expect(overlayIdx).toBeLessThan(textIdx);
  });

  it("positions the fragment box from the normalized rect (over the glyphs)", () => {
    const { stage } = buildPage();
    renderHighlightOverlay(stage, {
      kind: "highlight",
      color: "green",
      rects: [{ x: 0.25, y: 0.6, width: 0.3, height: 0.04 }],
      animate: false,
      suppressMotion: true,
      annotationId: "ann-2",
    });
    const box = stage.querySelector(".ito-highlight-fragment") as HTMLElement;
    expect(box).not.toBeNull();
    // Position reflects the rect, NOT a float near the top of the wrapper.
    expect(box.style.left).toBe("25%");
    expect(box.style.top).toBe("60%");
    expect(box.style.width).toBe("30%");
    expect(parseFloat(box.style.top)).toBeGreaterThan(5);
  });

  it("renders a labeled area box for an area annotation (D01)", () => {
    const { stage } = buildPage();
    renderHighlightOverlay(stage, {
      kind: "highlight",
      color: "blue",
      rects: [{ x: 0.2, y: 0.2, width: 0.5, height: 0.15 }],
      animate: false,
      suppressMotion: true,
      annotationId: "area-1",
      areaBox: true,
      areaLabel: "Figure 1",
    });
    const container = stage.querySelector(".ito-highlight") as HTMLElement;
    expect(container.dataset.area).toBe("true");
    const box = stage.querySelector(".ito-highlight-area") as HTMLElement;
    expect(box).not.toBeNull();
    expect(box.style.left).toBe("20%");
    expect(box.style.width).toBe("50%");
    const label = stage.querySelector(".ito-highlight-area-label") as HTMLElement;
    expect(label.textContent).toBe("Figure 1");
  });

  it("is idempotent: re-rendering the same annotation replaces its overlay", () => {
    const { stage } = buildPage();
    const opts = {
      kind: "highlight" as const,
      color: "pink",
      rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.02 }],
      animate: false,
      suppressMotion: true,
      annotationId: "ann-3",
    };
    renderHighlightOverlay(stage, opts);
    renderHighlightOverlay(stage, opts);
    expect(stage.querySelectorAll('[data-annotation-id="ann-3"]')).toHaveLength(1);
  });
});

describe("FEAT-002 hitTestAnnotations (2.2)", () => {
  const targets: HitTestTarget[] = [
    { id: "a", rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.05 }] },
    { id: "b", rects: [{ x: 0.5, y: 0.5, width: 0.3, height: 0.1 }] },
  ];

  it("returns the id of the annotation whose rect contains the normalized point", () => {
    expect(hitTestAnnotations(targets, 0.15, 0.12)).toBe("a");
    expect(hitTestAnnotations(targets, 0.6, 0.55)).toBe("b");
  });

  it("returns null when the point is outside every rect", () => {
    expect(hitTestAnnotations(targets, 0.95, 0.95)).toBeNull();
  });

  it("matches the FIRST target in order when rects overlap", () => {
    const overlapping: HitTestTarget[] = [
      { id: "top", rects: [{ x: 0, y: 0, width: 1, height: 1 }] },
      { id: "under", rects: [{ x: 0, y: 0, width: 1, height: 1 }] },
    ];
    expect(hitTestAnnotations(overlapping, 0.5, 0.5)).toBe("top");
  });

  it("applies a small tolerance so clicks on thin boxes register", () => {
    const thin: HitTestTarget[] = [
      { id: "thin", rects: [{ x: 0.2, y: 0.5, width: 0.3, height: 0 }] },
    ];
    expect(hitTestAnnotations(thin, 0.3, 0.5)).toBe("thin");
  });
});

describe("FEAT-002 cropCanvasRegionToDataUrl (2.4)", () => {
  it("returns a deterministic SVG data URL fallback when the 2d context is null (jsdom)", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 100;
    const url = cropCanvasRegionToDataUrl(canvas, { x: 0.1, y: 0.1, width: 0.5, height: 0.5 });
    expect(url.startsWith("data:image/svg+xml,")).toBe(true);
    // The SVG encodes the cropped pixel size (0.5 * 200 = 100, 0.5 * 100 = 50).
    expect(decodeURIComponent(url)).toContain("figure 100x50");
  });

  it("returns an SVG fallback for a null/zero-size canvas", () => {
    const url = cropCanvasRegionToDataUrl(null, { x: 0, y: 0, width: 1, height: 1 });
    expect(url.startsWith("data:image/svg+xml,")).toBe(true);
  });

  it("uses a real 2d crop + toDataURL when getContext returns a context", () => {
    const out = document.createElement("canvas");
    // Stub a 2d context + toDataURL so the non-jsdom path is exercised.
    const ctx = { drawImage: () => undefined } as unknown as CanvasRenderingContext2D;
    const original = HTMLCanvasElement.prototype.getContext;
    const originalToDataUrl = HTMLCanvasElement.prototype.toDataURL;
    // Only stub for canvases created inside the helper: patch the prototype.
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string) {
      return kind === "2d" ? ctx : null;
    } as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,AAAA";
    try {
      const src = document.createElement("canvas");
      src.width = 100;
      src.height = 100;
      const url = cropCanvasRegionToDataUrl(src, { x: 0, y: 0, width: 0.5, height: 0.5 });
      expect(url).toBe("data:image/png;base64,AAAA");
    } finally {
      HTMLCanvasElement.prototype.getContext = original;
      HTMLCanvasElement.prototype.toDataURL = originalToDataUrl;
      out.remove();
    }
  });
});
