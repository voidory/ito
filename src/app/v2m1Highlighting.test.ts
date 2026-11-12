/**
 * v2-m1 verification gate: subtractive pigment highlighting, magnetic
 * glyph-hysteresis selection, and scanned ink-band highlighting (Vitest/jsdom).
 *
 *  - Test 1 (Subtractive Multiply Blending & Page Stage Isolation): the
 *    highlight surfaces composite with `mix-blend-mode: multiply` inside an
 *    isolated page stage, so black glyphs are never lightened.
 *  - Test 2 (35% / 65% Directional Glyph Hysteresis): the first and last
 *    letters of a drag are included a third of the way in, in both directions,
 *    with no snapping to whole words.
 *  - Test 3 (Margin & Inter-Line Band Capture): a press in the margin or in
 *    the leading between lines resolves to the nearest line, and nothing
 *    beyond the pads does.
 *  - Test 4 (Scanned PDF Ink-Band Highlighting & End-to-End Commit): ink rows
 *    are detected from page pixels, and a drag on a page with no selectable
 *    text in the REAL SourcePane previews, then commits, a highlight.
 *
 * jsdom has no layout engine, so span geometry is supplied by stubbing
 * getBoundingClientRect, and pdf.js (worker + canvas raster) is replaced by a
 * minimal fake so the real `renderPage` + `SourcePane` can mount.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { Workbench } from "./workbench";
import { LiveSelectionPreview } from "./reader/AnnotationOverlays";
import { SourcePane } from "./reader/SourcePane";
import type { ActiveTool } from "./reader/ReaderToolbar";
import { COLOR_CSS, renderHighlightOverlay } from "../pdf/highlight";
import {
  DRAG_SLOP_PX,
  LINE_PAD_Y,
  MARGIN_PAD_X,
  captureSpanAtPoint,
  glyphCaretAtPoint,
  installPointerSelection,
  resolveCharOffsetWithHysteresis,
} from "../pdf/pointerSelection";
import {
  SCANNED_LINE_HEIGHT_NORM,
  SCANNED_PASSAGE_TEXT,
  analyzeScannedDrag,
  detectScannedLineRects,
  type ScannedImageData,
} from "../pdf/scannedHighlight";
import { injectSyntheticOcrTextLayer } from "../pdf/textCache";
import type { NormalizedRect, Source } from "../model";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// pdf.js fake: one image-only page (0 text items), instant raster.
// ---------------------------------------------------------------------------

vi.mock("pdfjs-dist/build/pdf.worker.mjs?url", () => ({ default: "mock-worker-url" }));

vi.mock("pdfjs-dist", () => {
  const page = {
    rotate: 0,
    getViewport: (opts: { scale: number }) => ({
      width: 400 * opts.scale,
      height: 600 * opts.scale,
      rotation: 0,
    }),
    // A scanned page: pdf.js extracts no text items at all.
    getTextContent: async () => ({ items: [] }),
    render: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
  };
  class TextLayer {
    render(): Promise<void> {
      return Promise.resolve();
    }
  }
  return {
    GlobalWorkerOptions: { workerSrc: "" },
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => page,
        getMetadata: async () => ({ info: {} }),
      }),
    }),
    TextLayer,
  };
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const editorCss = readFileSync(resolve(process.cwd(), "src/app/editor.css"), "utf8");

function domRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/** Give an element a fixed layout box (jsdom reports 0x0 for everything). */
function setBox(el: Element, left: number, top: number, width: number, height: number): void {
  el.getBoundingClientRect = () => domRect(left, top, width, height);
}

function mouse(
  target: EventTarget,
  type: string,
  x: number,
  y: number,
  init: MouseEventInit = {},
): void {
  const released = type.endsWith("up") || type === "click";
  target.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: released ? 0 : 1,
      detail: 1,
      ...init,
    }),
  );
}

type Rgb = readonly [number, number, number];

function parseRgb(css: string): { rgb: Rgb; alpha: number } {
  const m = css.match(/rgba?\(([^)]+)\)/);
  if (!m) throw new Error(`not an rgb() colour: ${css}`);
  const parts = m[1]!.split(",").map((p) => parseFloat(p));
  return { rgb: [parts[0]!, parts[1]!, parts[2]!], alpha: parts[3] ?? 1 };
}

/** `multiply` compositing of a pigment (with alpha) over an opaque backdrop. */
function multiply(pigment: Rgb, alpha: number, backdrop: Rgb): Rgb {
  return backdrop.map((b, i) => (1 - alpha) * b + alpha * ((pigment[i]! * b) / 255)) as unknown as Rgb;
}

/** Ordinary `source-over` compositing, i.e. what the overlays did before. */
function sourceOver(pigment: Rgb, alpha: number, backdrop: Rgb): Rgb {
  return backdrop.map((b, i) => (1 - alpha) * b + alpha * pigment[i]!) as unknown as Rgb;
}

const luma = (c: Rgb): number => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];

afterEach(() => {
  document.body.replaceChildren();
  document.head.querySelectorAll("style[data-v2m1]").forEach((el) => el.remove());
  window.getSelection()?.removeAllRanges();
});

// ---------------------------------------------------------------------------
// Test 1 — Subtractive Multiply Blending & Page Stage Isolation
// ---------------------------------------------------------------------------

describe("v2-m1 Test 1 — subtractive multiply blending & page stage isolation", () => {
  function buildStage(): HTMLElement {
    const stage = document.createElement("div");
    stage.className = "pdf-page-stage";
    const canvas = document.createElement("canvas");
    const textLayer = document.createElement("div");
    textLayer.className = "textLayer";
    stage.append(canvas, textLayer);
    document.body.appendChild(stage);
    return stage;
  }

  it("editor.css multiplies every highlight surface and isolates the page stage", () => {
    const style = document.createElement("style");
    style.dataset.v2m1 = "true";
    style.textContent = editorCss;
    document.head.appendChild(style);

    const stage = buildStage();
    renderHighlightOverlay(stage, {
      kind: "highlight",
      color: "yellow",
      rects: [{ x: 0.1, y: 0.2, width: 0.5, height: 0.02 }],
      animate: false,
      suppressMotion: true,
      annotationId: "ann-css",
    });
    const preview = document.createElement("div");
    preview.className = "ito-selection-live-preview";
    document.body.appendChild(preview);

    const blendOf = (el: Element): string =>
      getComputedStyle(el).getPropertyValue("mix-blend-mode");
    expect(blendOf(stage.querySelector(".ito-highlight")!)).toBe("multiply");
    expect(blendOf(stage.querySelector(".ito-highlight-fragment")!)).toBe("multiply");
    expect(blendOf(preview)).toBe("multiply");
    // The transparent text layer multiplies too, so the native ::selection tint
    // painted inside it is ink rather than a veil over the glyphs.
    expect(blendOf(stage.querySelector(".textLayer")!)).toBe("multiply");
    // The stage is an isolated stacking context: the blend stops at this page.
    expect(getComputedStyle(stage).getPropertyValue("isolation")).toBe("isolate");

    // Wet-edge pooling on the dried strip (not a flat plastic rectangle).
    const fragment = getComputedStyle(stage.querySelector(".ito-highlight-fragment")!);
    expect(fragment.getPropertyValue("border-radius")).toBe("3px");
    expect(fragment.getPropertyValue("box-shadow")).toContain("inset 0 0 0 1px");
  });

  it("the overlays carry the blend inline, and an underline is a bare 2.5px pigment stroke", () => {
    const stage = buildStage();
    renderHighlightOverlay(stage, {
      kind: "highlight",
      color: "green",
      rects: [
        { x: 0.1, y: 0.2, width: 0.5, height: 0.02 },
        { x: 0.1, y: 0.23, width: 0.3, height: 0.02 },
      ],
      animate: false,
      suppressMotion: true,
      annotationId: "ann-hl",
    });
    const container = stage.querySelector<HTMLElement>('[data-annotation-id="ann-hl"]')!;
    expect(container.style.getPropertyValue("mix-blend-mode")).toBe("multiply");
    expect(container.dataset.style).toBe("highlight");
    const fragments = container.querySelectorAll<HTMLElement>(".ito-highlight-fragment");
    expect(fragments).toHaveLength(2);
    for (const f of Array.from(fragments)) {
      expect(f.style.getPropertyValue("mix-blend-mode")).toBe("multiply");
      expect(f.dataset.style).toBe("highlight");
      expect(f.style.borderRadius).toBe("3px");
      // An opaque pigment, not an alpha veil.
      expect(parseRgb(f.style.background).alpha).toBe(1);
    }

    renderHighlightOverlay(stage, {
      kind: "underline",
      color: "blue",
      rects: [{ x: 0.1, y: 0.4, width: 0.5, height: 0.02 }],
      animate: false,
      suppressMotion: true,
      annotationId: "ann-ul",
    });
    const underline = stage.querySelector<HTMLElement>(
      '[data-annotation-id="ann-ul"] .ito-highlight-fragment',
    )!;
    expect(underline.dataset.style).toBe("underline");
    expect(underline.style.getPropertyValue("mix-blend-mode")).toBe("multiply");
    expect(underline.style.backgroundColor).toBe("transparent");
    expect(underline.style.borderBottomWidth).toBe("2.5px");
    expect(underline.style.borderBottomStyle).toBe("solid");
    // The stroke sits on the baseline: the bottom edge of the line rect.
    expect(parseFloat(underline.style.top)).toBeCloseTo(42, 6);
  });

  it("the live preview strips are multiply pigment with no alpha veil", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        createElement(LiveSelectionPreview, {
          preview: {
            color: COLOR_CSS["yellow"]!,
            rects: [{ left: 10, top: 20, right: 110, bottom: 34, width: 100 }],
          },
        }),
      );
    });
    const pill = host.querySelector<HTMLElement>(".ito-selection-live-preview")!;
    expect(pill.style.getPropertyValue("mix-blend-mode")).toBe("multiply");
    expect(pill.style.opacity).toBe("");
    expect(pill.style.left).toBe("10px");
    expect(pill.style.height).toBe("14px");
    act(() => root.unmount());
  });

  it("multiply never lightens black glyphs, and the pigments are luminous washes", () => {
    for (const [name, css] of Object.entries(COLOR_CSS)) {
      const { rgb, alpha } = parseRgb(css);
      // Ink under the highlight stays exactly black: 0 x pigment = 0.
      expect(multiply(rgb, alpha, BLACK), name).toEqual([0, 0, 0]);
      // Paper takes the full tint, and the tint is a light, high-luminance wash.
      const onPaper = multiply(rgb, alpha, WHITE);
      expect(luma(onPaper), name).toBeGreaterThan(200);
      expect(luma(onPaper), name).toBeLessThan(250);
      // Dark grey body text keeps its darkness too (multiply only darkens).
      const grey: Rgb = [26, 26, 26];
      expect(luma(multiply(rgb, alpha, grey)), name).toBeLessThanOrEqual(luma(grey));
    }
    // The regression this replaces: the former 45% source-over yellow lifted
    // black text to a washed-out olive.
    expect(luma(sourceOver([255, 221, 87], 0.45, BLACK))).toBeGreaterThan(90);
  });
});

// ---------------------------------------------------------------------------
// Tests 2 + 3 fixtures: a hand-laid text layer with known glyph geometry
// ---------------------------------------------------------------------------

/**
 * A `.textLayer` with one span per line. Each line is 12px tall and every
 * glyph is exactly `glyphWidth` px wide (jsdom cannot measure characters, so
 * the selection code spreads them evenly over the span box, which this makes
 * exact).
 */
function buildTextLayer(
  lines: readonly { text: string; left: number; top: number }[],
  glyphWidth = 10,
): { root: HTMLElement; layer: HTMLElement; spans: HTMLElement[] } {
  const root = document.createElement("div");
  const layer = document.createElement("div");
  layer.className = "textLayer";
  const spans = lines.map((line) => {
    const span = document.createElement("span");
    span.textContent = line.text;
    setBox(span, line.left, line.top, line.text.length * glyphWidth, 12);
    layer.appendChild(span);
    return span;
  });
  root.appendChild(layer);
  document.body.appendChild(root);
  return { root, layer, spans };
}

const selectedText = (): string => window.getSelection()?.toString() ?? "";

// ---------------------------------------------------------------------------
// Test 2 — 35% / 65% Directional Glyph Hysteresis Without Word-Snapping
// ---------------------------------------------------------------------------

describe("v2-m1 Test 2 — 35% / 65% directional glyph hysteresis (no word snapping)", () => {
  it("resolveCharOffsetWithHysteresis applies the anchor and directional focus thresholds", () => {
    // Anchor: anywhere in the first two thirds of the letter keeps the letter.
    expect(resolveCharOffsetWithHysteresis(0, "anchor")).toBe(0);
    expect(resolveCharOffsetWithHysteresis(0.5, "anchor")).toBe(0);
    expect(resolveCharOffsetWithHysteresis(0.64, "anchor")).toBe(0);
    expect(resolveCharOffsetWithHysteresis(0.65, "anchor")).toBe(1);
    expect(resolveCharOffsetWithHysteresis(1, "anchor")).toBe(1);

    // Dragging forward: a glyph is included once 35% of it is crossed.
    expect(resolveCharOffsetWithHysteresis(0.34, "focus-forward")).toBe(0);
    expect(resolveCharOffsetWithHysteresis(0.35, "focus-forward")).toBe(1);
    expect(resolveCharOffsetWithHysteresis(0.4, "focus-forward")).toBe(1);

    // Dragging backward: a glyph is included once the pointer is at 65% going left.
    expect(resolveCharOffsetWithHysteresis(0.66, "focus-backward")).toBe(1);
    expect(resolveCharOffsetWithHysteresis(0.65, "focus-backward")).toBe(0);
    expect(resolveCharOffsetWithHysteresis(0.5, "focus-backward")).toBe(0);

    // The mirrored anchor for a right-to-left drag keeps the pressed letter.
    expect(resolveCharOffsetWithHysteresis(0.5, "anchor-backward")).toBe(1);
    expect(resolveCharOffsetWithHysteresis(0.35, "anchor-backward")).toBe(0);

    // Out-of-range fractions clamp (a point past either end of the glyph).
    expect(resolveCharOffsetWithHysteresis(-3, "focus-forward")).toBe(0);
    expect(resolveCharOffsetWithHysteresis(7, "focus-backward")).toBe(1);
  });

  describe("driving the real pointer-selection controller", () => {
    let fixture: ReturnType<typeof buildTextLayer>;
    let uninstall: () => void;
    // "hello world" from x=100, 10px per glyph: glyph i spans [100+10i, 110+10i).
    const at = (glyph: number, fraction: number): number => 100 + glyph * 10 + fraction * 10;
    const Y = 106;

    beforeEach(() => {
      fixture = buildTextLayer([{ text: "hello world", left: 100, top: 100 }]);
      uninstall = installPointerSelection(fixture.root, {
        getLayers: () => [fixture.layer],
        enabled: () => true,
      });
    });
    afterEach(() => uninstall());

    it("a press at 50% of the first glyph includes it; 40% into the last glyph includes it", () => {
      mouse(fixture.spans[0]!, "mousedown", at(0, 0.5), Y);
      mouse(window, "mousemove", at(7, 0.4), Y);
      // Starts with the 'h' pressed at its midpoint, ends with the 'o' of
      // "world" crossed by 40% — and stops there: no snap out to "world".
      expect(selectedText()).toBe("hello wo");
      mouse(window, "mouseup", at(7, 0.4), Y);
    });

    it("tracks the pointer one character at a time, mid-word", () => {
      mouse(fixture.spans[0]!, "mousedown", at(1, 0.5), Y);
      mouse(window, "mousemove", at(3, 0.2), Y);
      expect(selectedText()).toBe("el"); // 20% into the second 'l': not yet
      mouse(window, "mousemove", at(3, 0.4), Y);
      expect(selectedText()).toBe("ell"); // 40% in: included
      mouse(window, "mousemove", at(4, 0.3), Y);
      expect(selectedText()).toBe("ell"); // 30% into 'o': not yet
      mouse(window, "mousemove", at(4, 0.36), Y);
      expect(selectedText()).toBe("ello"); // a whole word only because the pointer got there
      mouse(window, "mousemove", at(8, 0.5), Y);
      expect(selectedText()).toBe("ello wor"); // and straight through the next one
      mouse(window, "mouseup", at(8, 0.5), Y);
    });

    it("a press past 65% of a glyph starts after it", () => {
      mouse(fixture.spans[0]!, "mousedown", at(0, 0.7), Y);
      mouse(window, "mousemove", at(4, 0.9), Y);
      expect(selectedText()).toBe("ello");
      mouse(window, "mouseup", at(4, 0.9), Y);
    });

    it("dragging backward keeps the pressed letter and uses the 65% threshold", () => {
      mouse(fixture.spans[0]!, "mousedown", at(8, 0.5), Y);
      mouse(window, "mousemove", at(6, 0.7), Y);
      expect(selectedText()).toBe("or"); // 'w' only reached to 70% from the right: not yet
      mouse(window, "mousemove", at(6, 0.6), Y);
      expect(selectedText()).toBe("wor"); // crossed 65%: included, 'r' still kept
      mouse(window, "mouseup", at(6, 0.6), Y);
    });

    it("hand jitter under the drag slop selects nothing", () => {
      mouse(fixture.spans[0]!, "mousedown", at(2, 0.5), Y);
      mouse(window, "mousemove", at(2, 0.5) + (DRAG_SLOP_PX - 1), Y);
      expect(selectedText()).toBe("");
      mouse(window, "mouseup", at(2, 0.5) + (DRAG_SLOP_PX - 1), Y);
    });
  });
});

// ---------------------------------------------------------------------------
// Test 3 — Margin & Inter-Line Band Capture
// ---------------------------------------------------------------------------

describe("v2-m1 Test 3 — margin & inter-line band capture", () => {
  // Two lines, 10px of leading between them:
  //   A: x 100..290, y 100..112      B: x 100..260, y 122..134
  const LINE_A = { text: "first line of text.", left: 100, top: 100 };
  const LINE_B = { text: "second line here", left: 100, top: 122 };

  it("uses the specified pads", () => {
    expect(LINE_PAD_Y).toBe(6);
    expect(MARGIN_PAD_X).toBe(16);
  });

  it("a press 10px into the left margin lands on the line's leading edge", () => {
    const { layer, spans } = buildTextLayer([LINE_A, LINE_B]);
    const captured = captureSpanAtPoint(layer, 90, 106);
    expect(captured).toEqual({ span: spans[0], kind: "margin" });
    const caret = glyphCaretAtPoint(layer, 90, 106);
    expect(caret?.node).toBe(spans[0]!.firstChild);
    expect(caret?.offset).toBe(0);
  });

  it("a press 10px past the end of a line lands on its trailing edge", () => {
    const { layer, spans } = buildTextLayer([LINE_A, LINE_B]);
    const caret = glyphCaretAtPoint(layer, 300, 106);
    expect(caret?.node).toBe(spans[0]!.firstChild);
    expect(caret?.offset).toBe(LINE_A.text.length);
  });

  it("a press in the leading between two lines goes to the nearer line", () => {
    const { layer, spans } = buildTextLayer([LINE_A, LINE_B]);
    // 4px below line A (6px above B) -> A.
    expect(captureSpanAtPoint(layer, 150, 116)).toEqual({ span: spans[0], kind: "line-band" });
    // 4px above line B (6px below A) -> B.
    expect(captureSpanAtPoint(layer, 150, 118)).toEqual({ span: spans[1], kind: "line-band" });
    // ...and resolves to the glyph under the pointer's x, not a line edge:
    // x=150 is the midpoint of glyph 5, and a press there keeps that glyph.
    expect(glyphCaretAtPoint(layer, 150, 116)?.offset).toBe(5);
  });

  it("being ON a line's row beats being merely near another line", () => {
    // Line A is short; the point is level with A just past its end, and also
    // 5px above the longer line B that runs underneath it.
    const { layer, spans } = buildTextLayer([
      { text: "short", left: 100, top: 100 },
      { text: "a much longer line below", left: 100, top: 116 },
    ]);
    expect(captureSpanAtPoint(layer, 160, 111)).toEqual({ span: spans[0], kind: "margin" });
  });

  it("captures nothing beyond the pads", () => {
    const { layer } = buildTextLayer([LINE_A, LINE_B]);
    expect(captureSpanAtPoint(layer, 100 - MARGIN_PAD_X - 1, 106)).toBeNull(); // far left margin
    expect(captureSpanAtPoint(layer, 290 + MARGIN_PAD_X + 1, 106)).toBeNull(); // far right margin
    expect(captureSpanAtPoint(layer, 150, 100 - LINE_PAD_Y - 1)).toBeNull(); // above the block
    expect(captureSpanAtPoint(layer, 150, 134 + LINE_PAD_Y + 1)).toBeNull(); // below the block
    expect(glyphCaretAtPoint(layer, 40, 40)).toBeNull();
  });

  it("a drag does not leave its line until the pointer is strictly nearer another", () => {
    // The focus is on short line A; the pointer has run on past its end and
    // dipped into the leading above the longer line B (10px of leading).
    const { layer, spans } = buildTextLayer([
      { text: "short", left: 100, top: 100 },
      { text: "a much longer line below", left: 100, top: 122 },
    ]);
    // Dead centre of the leading (5px from each line): B is the only line in
    // reach here, but it is no nearer than the line being held, so nothing
    // moves...
    expect(captureSpanAtPoint(layer, 220, 117, spans[0])).toBeNull();
    // ...one pixel further down B is strictly nearer and takes over.
    expect(captureSpanAtPoint(layer, 220, 118, spans[0])).toEqual({
      span: spans[1],
      kind: "line-band",
    });
    // With no focus to hold (a fresh press), the same point simply resolves.
    expect(captureSpanAtPoint(layer, 220, 117)).toEqual({ span: spans[1], kind: "line-band" });
  });

  it("a press in the left margin starts the selection at the first character", () => {
    const fixture = buildTextLayer([LINE_A, LINE_B]);
    const uninstall = installPointerSelection(fixture.root, {
      getLayers: () => [fixture.layer],
      enabled: () => true,
    });
    // Pointerdown 10px left of the line (on the layer itself, not a span), then
    // drag 40% into the 5th glyph ("first").
    mouse(fixture.layer, "mousedown", 90, 106);
    mouse(window, "mousemove", 100 + 4 * 10 + 4, 106);
    expect(selectedText()).toBe("first");
    mouse(window, "mouseup", 144, 106);
    uninstall();
  });

  it("a press between lines anchors on the nearer line at the pointer's column", () => {
    const fixture = buildTextLayer([LINE_A, LINE_B]);
    const uninstall = installPointerSelection(fixture.root, {
      getLayers: () => [fixture.layer],
      enabled: () => true,
    });
    // 4px under line A at the start of "line" (glyph 6), dragged onto the line.
    mouse(fixture.layer, "mousedown", 100 + 6 * 10 + 2, 116);
    mouse(window, "mousemove", 100 + 9 * 10 + 5, 106);
    expect(selectedText()).toBe("line");
    mouse(window, "mouseup", 195, 106);
    uninstall();
  });

  it("skips the placeholder OCR bands of a scanned page", () => {
    const layer = document.createElement("div");
    layer.className = "textLayer";
    document.body.appendChild(layer);
    injectSyntheticOcrTextLayer(layer, 0, 400, 600);
    const bands = Array.from(layer.querySelectorAll<HTMLElement>("span"));
    expect(bands.length).toBeGreaterThan(0);
    // Even with real geometry under the pointer, a placeholder is not text.
    setBox(bands[0]!, 20, 50, 360, 20);
    expect(captureSpanAtPoint(layer, 100, 60)).toBeNull();

    // Recognized OCR text on such a band IS selectable.
    layer.replaceChildren();
    injectSyntheticOcrTextLayer(layer, 0, 400, 600, ["reaction yield 87%"]);
    const real = layer.querySelector<HTMLElement>("span")!;
    setBox(real, 20, 50, 180, 20);
    expect(captureSpanAtPoint(layer, 100, 60)).toEqual({ span: real, kind: "direct" });
  });
});

// ---------------------------------------------------------------------------
// Test 4 — Scanned PDF Ink-Band Highlighting & End-to-End Commit
// ---------------------------------------------------------------------------

/** A white RGBA page raster with the given horizontal ink bars painted in. */
function scannedPage(
  width: number,
  height: number,
  bars: readonly { top: number; bottom: number; left: number; right: number; luma?: number }[],
): ScannedImageData {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const bar of bars) {
    const value = bar.luma ?? 20;
    for (let y = bar.top; y < bar.bottom; y++) {
      for (let x = bar.left; x < bar.right; x++) {
        const i = (y * width + x) * 4;
        data[i] = value;
        data[i + 1] = value;
        data[i + 2] = value;
      }
    }
  }
  return { data, width, height };
}

const W = 400;
const H = 600;
// Two printed text rows: a full line, then a shorter one (a paragraph's end).
const ROW_1 = { top: 100, bottom: 112, left: 40, right: 360 };
const ROW_2 = { top: 124, bottom: 136, left: 40, right: 300 };
const TWO_ROWS = scannedPage(W, H, [ROW_1, ROW_2]);

function expectRect(actual: NormalizedRect | undefined, expected: NormalizedRect): void {
  expect(actual).toBeDefined();
  expect(actual!.x).toBeCloseTo(expected.x, 6);
  expect(actual!.y).toBeCloseTo(expected.y, 6);
  expect(actual!.width).toBeCloseTo(expected.width, 6);
  expect(actual!.height).toBeCloseTo(expected.height, 6);
}

function boxOf(a: { x: number; y: number }, b: { x: number; y: number }): NormalizedRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

describe("v2-m1 Test 4 — scanned PDF ink-band highlighting", () => {
  describe("detectScannedLineRects", () => {
    it("snaps a single-line drag to the ink row's exact height and the dragged x-range", () => {
      const start = { x: 0.2, y: 106 / H };
      const end = { x: 0.6, y: 108 / H };
      const rects = detectScannedLineRects(boxOf(start, end), TWO_ROWS, start, end);
      expect(rects).toHaveLength(1);
      expectRect(rects[0], {
        x: 0.2,
        y: ROW_1.top / H,
        width: 0.4,
        height: (ROW_1.bottom - ROW_1.top) / H,
      });
      expect(analyzeScannedDrag(boxOf(start, end), TWO_ROWS, start, end).mode).toBe("ink");
    });

    it("gives the same strip for a right-to-left drag along the line", () => {
      const start = { x: 0.6, y: 108 / H };
      const end = { x: 0.2, y: 104 / H };
      const rects = detectScannedLineRects(boxOf(start, end), TWO_ROWS, start, end);
      expect(rects).toHaveLength(1);
      expectRect(rects[0], { x: 0.2, y: ROW_1.top / H, width: 0.4, height: 12 / H });
    });

    it("takes the nearer row when the drag runs along the leading between two rows", () => {
      const start = { x: 0.2, y: 115 / H }; // 3px under row 1, 9px over row 2
      const end = { x: 0.5, y: 115 / H };
      const rects = detectScannedLineRects(boxOf(start, end), TWO_ROWS, start, end);
      expect(rects).toHaveLength(1);
      expect(rects[0]!.y).toBeCloseTo(ROW_1.top / H, 6);
      // A caller can insist on rows the drag actually crossed (SourcePane does
      // on a page that has its own text layer).
      const strict = analyzeScannedDrag(boxOf(start, end), TWO_ROWS, start, end, {
        snapToNearestRow: false,
      });
      expect(strict.mode).toBe("geometric");
    });

    it("does not borrow a neighbouring line's row for a drag through the blank margin", () => {
      // Level with row 1, but entirely in the margin to its left (ink starts at x=40).
      const start = { x: 4 / W, y: 106 / H };
      const end = { x: 34 / W, y: 106 / H };
      const detection = analyzeScannedDrag(boxOf(start, end), TWO_ROWS, start, end);
      expect(detection.mode).toBe("geometric");
      // Once the drag reaches the ink, the row is found.
      const into = { x: 80 / W, y: 106 / H };
      expect(analyzeScannedDrag(boxOf(start, into), TWO_ROWS, start, into).mode).toBe("ink");
    });

    it("flows a multi-line drag: start -> right ink margin, then left ink margin -> end", () => {
      const start = { x: 0.25, y: 105 / H };
      const end = { x: 0.5, y: 130 / H };
      const rects = detectScannedLineRects(boxOf(start, end), TWO_ROWS, start, end);
      expect(rects).toHaveLength(2);
      // First line: from the press to the right edge of that row's ink.
      expectRect(rects[0], {
        x: 0.25,
        y: ROW_1.top / H,
        width: ROW_1.right / W - 0.25,
        height: 12 / H,
      });
      // Last line: from the left edge of that row's ink to the release.
      expectRect(rects[1], {
        x: ROW_2.left / W,
        y: ROW_2.top / H,
        width: 0.5 - ROW_2.left / W,
        height: 12 / H,
      });
    });

    it("spans whole middle lines between their own ink margins, whichever way it was dragged", () => {
      const row3 = { top: 148, bottom: 160, left: 40, right: 340 };
      const page = scannedPage(W, H, [ROW_1, ROW_2, row3]);
      // Dragged UPWARD from the third row to the first.
      const start = { x: 0.7, y: 155 / H };
      const end = { x: 0.3, y: 104 / H };
      const rects = detectScannedLineRects(boxOf(start, end), page, start, end);
      expect(rects).toHaveLength(3);
      expectRect(rects[0], { x: 0.3, y: ROW_1.top / H, width: ROW_1.right / W - 0.3, height: 12 / H });
      // The short middle line is covered to ITS ink end, not the block's.
      expectRect(rects[1], {
        x: ROW_2.left / W,
        y: ROW_2.top / H,
        width: (ROW_2.right - ROW_2.left) / W,
        height: 12 / H,
      });
      expectRect(rects[2], { x: row3.left / W, y: row3.top / H, width: 0.7 - row3.left / W, height: 12 / H });
    });

    it("treats luminance below 200 as ink and anything lighter as paper", () => {
      const start = { x: 0.2, y: 106 / H };
      const end = { x: 0.6, y: 106 / H };
      const faint = scannedPage(W, H, [{ ...ROW_1, luma: 210 }]);
      expect(analyzeScannedDrag(boxOf(start, end), faint, start, end).mode).toBe("geometric");
      const grey = scannedPage(W, H, [{ ...ROW_1, luma: 190 }]);
      expect(analyzeScannedDrag(boxOf(start, end), grey, start, end).mode).toBe("ink");
    });

    it("keeps to the dragged column of a two-column page", () => {
      const left1 = { top: 100, bottom: 112, left: 30, right: 180 };
      const left2 = { top: 124, bottom: 136, left: 30, right: 180 };
      // The right column's lines sit on a different grid, across a 40px gutter.
      const right1 = { top: 110, bottom: 122, left: 220, right: 370 };
      const page = scannedPage(W, H, [left1, left2, right1]);
      const start = { x: 0.2, y: 105 / H };
      const end = { x: 0.3, y: 130 / H };
      const rects = detectScannedLineRects(boxOf(start, end), page, start, end);
      expect(rects).toHaveLength(2);
      for (const r of rects) expect(r.x + r.width).toBeLessThanOrEqual(left1.right / W + 1e-9);
    });

    it("falls back to standard reading-height strips without ImageData", () => {
      const start = { x: 0.2, y: 0.3 };
      const end = { x: 0.7, y: 0.305 };
      for (const image of [undefined, null]) {
        const one = detectScannedLineRects(boxOf(start, end), image, start, end);
        expect(one).toHaveLength(1);
        expectRect(one[0], {
          x: 0.2,
          y: 0.3025 - SCANNED_LINE_HEIGHT_NORM / 2,
          width: 0.5,
          height: SCANNED_LINE_HEIGHT_NORM,
        });
      }
      expect(analyzeScannedDrag(boxOf(start, end), null, start, end).mode).toBe("geometric");

      // A taller drag decomposes into evenly pitched line strips.
      const far = { x: 0.7, y: 0.3 + SCANNED_LINE_HEIGHT_NORM * 3 };
      const many = detectScannedLineRects(boxOf(start, far), null, start, far);
      expect(many).toHaveLength(4);
      for (const r of many) {
        expect(r.height).toBeCloseTo(SCANNED_LINE_HEIGHT_NORM, 6);
        expect(r.width).toBeGreaterThan(0);
        expect(r.x).toBeGreaterThanOrEqual(0.2 - 1e-9);
        expect(r.x + r.width).toBeLessThanOrEqual(0.7 + 1e-9);
      }
      const tops = many.map((r) => r.y);
      expect([...tops].sort((a, b) => a - b)).toEqual(tops);
      // Deterministic: the same drag always yields the same strips.
      expect(detectScannedLineRects(boxOf(start, far), null, start, far)).toEqual(many);
    });

    it("falls back to the same strips where the region has no line structure", () => {
      const start = { x: 0.2, y: 0.3 };
      const end = { x: 0.7, y: 0.305 };
      const expected = detectScannedLineRects(boxOf(start, end), null, start, end);
      const blank = scannedPage(W, H, []);
      const solid = scannedPage(W, H, [{ top: 0, bottom: H, left: 0, right: W }]);
      for (const image of [blank, solid]) {
        const detection = analyzeScannedDrag(boxOf(start, end), image, start, end);
        expect(detection.mode).toBe("geometric");
        expect(detection.rects).toEqual(expected);
      }
    });

    it("defaults the drag ends to the box corners, and drops a sliver", () => {
      const rects = detectScannedLineRects(
        { x: 0.2, y: 104 / H, width: 0.4, height: 4 / H },
        TWO_ROWS,
      );
      expect(rects).toHaveLength(1);
      expectRect(rects[0], { x: 0.2, y: ROW_1.top / H, width: 0.4, height: 12 / H });
      // A straight-down nudge has no width to highlight.
      expect(detectScannedLineRects({ x: 0.3, y: 0.3, width: 0, height: 0.004 }, null)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // End to end: the real SourcePane over a page with no selectable text.
  // -------------------------------------------------------------------------

  describe("SourcePane drag on a page with no selectable text", () => {
    let host: HTMLElement | null = null;
    let root: Root | null = null;
    let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;
    /** When set, the fake 2d context serves this raster to getImageData. */
    let raster: ((width: number, height: number) => ScannedImageData) | null = null;

    beforeEach(() => {
      raster = null;
      // jsdom has neither a 2d canvas backend nor ResizeObserver.
      originalGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string) {
        if (kind !== "2d") return null;
        const ctx: Record<string, unknown> = { setTransform: () => undefined };
        const serve = raster;
        if (serve) {
          ctx["drawImage"] = () => undefined;
          ctx["getImageData"] = (_x: number, _y: number, w: number, h: number) => serve(w, h);
        }
        return ctx as unknown as CanvasRenderingContext2D;
      } as typeof HTMLCanvasElement.prototype.getContext;
      (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      };
    });

    afterEach(() => {
      if (root) act(() => root!.unmount());
      host?.remove();
      root = null;
      host = null;
      HTMLCanvasElement.prototype.getContext = originalGetContext;
      delete (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver;
    });

    const q = <T extends HTMLElement = HTMLElement>(selector: string): T | null =>
      document.querySelector<T>(selector);

    async function flush(): Promise<void> {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }

    /** Mount the real SourcePane over the faked one-page scanned PDF. */
    async function mountScannedPane(
      activeTool: ActiveTool,
    ): Promise<{ wb: Workbench; source: Source; stage: HTMLElement; textLayer: HTMLElement }> {
      const wb = await Workbench.open(new InMemoryStorageAdapter());
      const source = await wb.importSource({
        title: "Scanned monograph",
        bytes: new Uint8Array([9, 8, 7, 6]),
        versionHash: "hash-scanned",
        pageCount: 1,
        category: "Papers",
      });
      host = document.createElement("div");
      document.body.appendChild(host);
      root = createRoot(host);
      await act(async () => {
        root!.render(
          createElement(SourcePane, {
            wb,
            sourceId: source.id,
            suppressMotion: true,
            onToggleMotion: () => undefined,
            returnTarget: null,
            openSourceIds: [source.id],
            registerScroll: () => undefined,
            activeTool,
            activeColor: "green",
            onClearTool: () => undefined,
            isPrimary: true,
            bump: () => undefined,
          }),
        );
      });
      for (let i = 0; i < 50 && q('[data-testid="source-pane"]')?.dataset.ready !== "true"; i++) {
        await flush();
      }
      expect(q('[data-testid="source-pane"]')?.dataset.ready).toBe("true");
      const stage = q('[data-testid="pdf-page-stage"]')!;
      const textLayer = stage.querySelector<HTMLElement>(".textLayer")!;
      // The page stage as laid out by a browser: 400 x 600 at (50, 80).
      setBox(stage, 50, 80, 400, 600);
      return { wb, source, stage, textLayer };
    }

    /** One complete pointer gesture, as a browser delivers it. */
    async function drag(
      stage: HTMLElement,
      from: { x: number; y: number },
      to: { x: number; y: number },
      afterMove?: () => void,
    ): Promise<void> {
      await act(async () => {
        mouse(stage, "pointerdown", from.x, from.y);
        mouse(stage, "mousedown", from.x, from.y);
      });
      await act(async () => {
        mouse(stage, "pointermove", to.x, to.y);
        mouse(stage, "mousemove", to.x, to.y);
      });
      afterMove?.();
      // pointerup, mouseup and click arrive in one task: nothing runs between.
      await act(async () => {
        mouse(stage, "pointerup", to.x, to.y);
        mouse(stage, "mouseup", to.x, to.y);
        mouse(stage, "click", to.x, to.y);
      });
      await flush();
    }

    const scannedAnnotations = (wb: Workbench, source: Source) =>
      wb.annotationsForSource(source.id).filter((v) => v.annotation.scope.kind === "text");

    function expectUsableRects(rects: readonly NormalizedRect[]): void {
      expect(rects.length).toBeGreaterThan(0);
      for (const r of rects) {
        expect(r.width).toBeGreaterThan(0);
        expect(r.height).toBeGreaterThan(0);
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.width).toBeLessThanOrEqual(1 + 1e-9);
        expect(r.y + r.height).toBeLessThanOrEqual(1 + 1e-9);
      }
    }

    it("renders the scanned page with an isolated stage and no real text spans", async () => {
      const { stage, textLayer } = await mountScannedPane(null);
      expect(stage.style.getPropertyValue("isolation")).toBe("isolate");
      expect(q('[data-testid="pdf-scope-status"]')?.textContent).toContain("Scanned PDF");
      // Whatever the text layer holds is placeholder OCR banding, not text.
      const spans = Array.from(textLayer.querySelectorAll("span"));
      expect(spans.every((s) => s.getAttribute("data-ocr-synthetic") === "true")).toBe(true);
    });

    it("with no tool: previews the strips live, then opens the selection toolbar and commits", async () => {
      const { wb, source, stage, textLayer } = await mountScannedPane(null);
      // 0 .textLayer spans under the drag (and none anywhere on the page).
      textLayer.replaceChildren();
      expect(textLayer.querySelectorAll("span")).toHaveLength(0);

      let liveStrips = 0;
      await drag(stage, { x: 130, y: 260 }, { x: 330, y: 263 }, () => {
        // During the drag the watercolour strips track the pointer.
        const preview = q('[data-testid="live-selection-preview"]')!;
        expect(preview).not.toBeNull();
        // Mounted outside the z-indexed fixed layer so its multiply blend
        // reaches the page.
        expect(preview.closest('[data-testid="reader-fixed-layer"]')).toBeNull();
        const strips = preview.querySelectorAll<HTMLElement>(".ito-selection-live-preview");
        liveStrips = strips.length;
        const strip = strips[0]!;
        expect(strip.style.getPropertyValue("mix-blend-mode")).toBe("multiply");
        // Viewport coordinates of the dragged x-range on the stage.
        expect(parseFloat(strip.style.left)).toBeCloseTo(130, 4);
        expect(parseFloat(strip.style.width)).toBeCloseTo(200, 4);
        // One standard line high, around the pointer's row.
        expect(parseFloat(strip.style.height)).toBeCloseTo(SCANNED_LINE_HEIGHT_NORM * 600, 4);
        expect(parseFloat(strip.style.top)).toBeLessThan(260);
        expect(parseFloat(strip.style.top) + parseFloat(strip.style.height)).toBeGreaterThan(263);
      });
      expect(liveStrips).toBe(1);

      // Nothing is committed yet: the release opens the selection toolbar, and
      // the strips stay up behind it.
      expect(scannedAnnotations(wb, source)).toHaveLength(0);
      expect(q('[data-testid="selection-toolbar"]')).not.toBeNull();
      expect(q('[data-testid="highlight-edit-popover"]')).toBeNull();
      expect(document.querySelectorAll(".ito-selection-live-preview")).toHaveLength(1);

      await act(async () => {
        q('[data-testid="commit-highlight"]')!.dispatchEvent(
          new MouseEvent("click", { bubbles: true }),
        );
      });
      await flush();

      const committed = scannedAnnotations(wb, source);
      expect(committed).toHaveLength(1);
      const scope = committed[0]!.annotation.scope;
      if (scope.kind !== "text") throw new Error("expected a text annotation");
      expect(scope.anchor.selectedText).toBe(SCANNED_PASSAGE_TEXT);
      expect(scope.anchor.pageIndex).toBe(0);
      expect(scope.anchor.sourceVersionHash).toBe(source.versionHash);
      expectUsableRects(scope.anchor.rects);
      expect(scope.anchor.rects[0]!.x).toBeCloseTo((130 - 50) / 400, 6);
      expect(scope.anchor.rects[0]!.width).toBeCloseTo(200 / 400, 6);
      expect(committed[0]!.style.kind).toBe("highlight");

      // Committed exactly like native text: toolbar + preview gone, and the
      // multiply overlay drawn on the page.
      expect(q('[data-testid="selection-toolbar"]')).toBeNull();
      expect(q('[data-testid="live-selection-preview"]')).toBeNull();
      const fragment = stage.querySelector<HTMLElement>(".ito-highlight-fragment")!;
      expect(fragment).not.toBeNull();
      expect(fragment.style.getPropertyValue("mix-blend-mode")).toBe("multiply");
    });

    it("with the Highlight tool: commits on release, with no popup", async () => {
      const { wb, source, stage } = await mountScannedPane("highlight");
      // The placeholder OCR bands are left in place here: they must not turn
      // the drag into a text selection, even one lying right under the pointer.
      const band = stage.querySelector<HTMLElement>(".textLayer span")!;
      setBox(band, 60, 250, 380, 24);

      await drag(stage, { x: 130, y: 260 }, { x: 330, y: 300 });

      const committed = scannedAnnotations(wb, source);
      expect(committed).toHaveLength(1);
      const scope = committed[0]!.annotation.scope;
      if (scope.kind !== "text") throw new Error("expected a text annotation");
      expect(scope.anchor.selectedText).toBe(SCANNED_PASSAGE_TEXT);
      expectUsableRects(scope.anchor.rects);
      // A 40px-tall drag on a 600px page spans several reading lines.
      expect(scope.anchor.rects.length).toBeGreaterThan(1);
      expect(committed[0]!.style).toEqual({ kind: "highlight", color: "green" });

      expect(q('[data-testid="selection-toolbar"]')).toBeNull();
      expect(q('[data-testid="live-selection-preview"]')).toBeNull();
      // The click that ends the drag must not open the new highlight's popover.
      expect(q('[data-testid="highlight-edit-popover"]')).toBeNull();
      expect(stage.querySelectorAll(".ito-highlight-fragment").length).toBe(
        scope.anchor.rects.length,
      );
    });

    it("snaps the committed strip to the printed ink row when the canvas is readable", async () => {
      // The page raster shows one text row at y 100..112 of 600 (x 40..360 of 400).
      raster = (w, h) =>
        scannedPage(w, h, [
          {
            top: Math.round((100 / 600) * h),
            bottom: Math.round((112 / 600) * h),
            left: Math.round((40 / 400) * w),
            right: Math.round((360 / 400) * w),
          },
        ]);
      const { wb, source, stage } = await mountScannedPane("underline");
      const canvas = stage.querySelector("canvas")!;
      const rowTop = Math.round((100 / 600) * canvas.height) / canvas.height;
      const rowBottom = Math.round((112 / 600) * canvas.height) / canvas.height;

      // Dragged sloppily along the row: 6px into it at one end, 9px at the other.
      await drag(stage, { x: 50 + 100, y: 80 + 106 }, { x: 50 + 300, y: 80 + 109 });

      const committed = scannedAnnotations(wb, source);
      expect(committed).toHaveLength(1);
      const scope = committed[0]!.annotation.scope;
      if (scope.kind !== "text") throw new Error("expected a text annotation");
      expect(scope.anchor.rects).toHaveLength(1);
      const rect = scope.anchor.rects[0]!;
      expect(rect.y).toBeCloseTo(rowTop, 6);
      expect(rect.y + rect.height).toBeCloseTo(rowBottom, 6);
      expect(rect.x).toBeCloseTo(100 / 400, 6);
      expect(rect.width).toBeCloseTo(200 / 400, 6);
      expect(committed[0]!.style.kind).toBe("underline");
    });

    it("ignores a drag of 6px or less", async () => {
      const { wb, source, stage } = await mountScannedPane("highlight");
      await drag(stage, { x: 130, y: 260 }, { x: 135, y: 262 });
      expect(scannedAnnotations(wb, source)).toHaveLength(0);
      expect(q('[data-testid="live-selection-preview"]')).toBeNull();
    });
  });
});
