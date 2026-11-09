import { afterEach, describe, expect, it, vi } from "vitest";
import { glyphCaretAtPoint } from "./pointerSelection";

/**
 * Unit coverage for the rotated-aware caret resolution in
 * {@link glyphCaretAtPoint}. jsdom does not compute CSS 2D transform matrices
 * or real per-character `Range.getClientRects()`, so these tests install a
 * deterministic geometry model: each glyph is a `glyph x glyph` box whose
 * position advances along a chosen reading axis (0° / 90° / 270°). This
 * exercises the real axis-projection math (`textBaselineAxis` /
 * `textOffsetAtPoint`) that keeps vertical selection aligned with the visible
 * glyphs — the horizontal `(clientX - left) / width` assumption is explicitly
 * NOT used here.
 */

const GLYPH = 10; // glyph box size in px (both the advance step and the box side)

type Axis = "horizontal" | "vertical-down" | "vertical-up";

interface Harness {
  /** The pointer coordinate at the visual centre of glyph index `i`. */
  centerOf(i: number): { x: number; y: number };
  readonly text: string;
  readonly span: HTMLElement;
}

/**
 * Build a span of `text` whose glyphs are laid out along `axis`, and stub the
 * DOM geometry APIs that {@link glyphCaretAtPoint} relies on so the pure
 * projection logic can be verified without a real browser.
 *
 * Layout (origin at viewport 100,100):
 *  - horizontal:     glyph i occupies x in [100 + 10i, 110 + 10i], y in [100,110]
 *  - vertical-down:  glyph i occupies y in [100 + 10i, 110 + 10i], x in [100,110]
 *  - vertical-up:    glyph i occupies y in [100 - 10i, 110 - 10i], x in [100,110]
 */
function makeHarness(text: string, axis: Axis): Harness {
  const originX = 100;
  const originY = 100;

  const rectForGlyph = (i: number): DOMRect => {
    let left: number;
    let top: number;
    if (axis === "horizontal") {
      left = originX + i * GLYPH;
      top = originY;
    } else if (axis === "vertical-down") {
      left = originX;
      top = originY + i * GLYPH;
    } else {
      // vertical-up: reading progresses toward smaller y
      left = originX;
      top = originY - i * GLYPH;
    }
    return domRect(left, top, GLYPH, GLYPH);
  };

  const centerOf = (i: number) => {
    const r = rectForGlyph(i);
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };

  // The span's own bounding box is the union of its glyph boxes. For vertical
  // text this is a tall/narrow box with swapped visual width/height, matching
  // what a real browser reports for a rotated pdf.js span.
  const all = Array.from({ length: text.length }, (_, i) => rectForGlyph(i));
  const spanLeft = Math.min(...all.map((r) => r.left));
  const spanTop = Math.min(...all.map((r) => r.top));
  const spanRight = Math.max(...all.map((r) => r.right));
  const spanBottom = Math.max(...all.map((r) => r.bottom));
  const spanRect = domRect(spanLeft, spanTop, spanRight - spanLeft, spanBottom - spanTop);

  const textNode = document.createTextNode(text);
  const span = document.createElement("span");
  span.appendChild(textNode);
  span.getBoundingClientRect = () => spanRect;

  const layer = document.createElement("div");
  layer.className = "textLayer";
  layer.appendChild(span);
  document.body.appendChild(layer);

  // spanUnderPoint relies on elementsFromPoint returning the span. jsdom does
  // not implement it, so assign a stub (restored in afterEach).
  const elementsFromPoint = (x: number, y: number): Element[] => {
    if (
      x >= spanRect.left - 2 &&
      x <= spanRect.right + 2 &&
      y >= spanRect.top - 2 &&
      y <= spanRect.bottom + 2
    ) {
      return [span, layer, document.body];
    }
    return [document.body];
  };
  (document as unknown as { elementsFromPoint: typeof elementsFromPoint }).elementsFromPoint =
    elementsFromPoint;

  // Vertical spans report a CSS transform so the code takes the geometry path.
  vi.spyOn(window, "getComputedStyle").mockImplementation(
    () =>
      ({
        transform: axis === "horizontal" ? "none" : "matrix(0, 1, -1, 0, 0, 0)",
        writingMode: "horizontal-tb",
      }) as unknown as CSSStyleDeclaration,
  );

  // Per-character geometry: createRange().getBoundingClientRect() must return
  // the glyph box for [start, start+1).
  vi.spyOn(document, "createRange").mockImplementation(() => {
    let startOffset = 0;
    const range = {
      setStart: (_node: Node, offset: number) => {
        startOffset = offset;
      },
      setEnd: () => {},
      getBoundingClientRect: () => rectForGlyph(startOffset),
    };
    return range as unknown as Range;
  });

  return { centerOf, text, span };
}

function domRect(x: number, y: number, w: number, h: number): DOMRect {
  return {
    x,
    y,
    left: x,
    top: y,
    width: w,
    height: h,
    right: x + w,
    bottom: y + h,
    toJSON() {
      return this;
    },
  } as DOMRect;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
});

describe("glyphCaretAtPoint — rotation-aware offset resolution", () => {
  const text = "ROTATED";
  const layer = () => document.querySelector<HTMLElement>(".textLayer")!;

  it("0°: a horizontal drag advances the offset monotonically along x", () => {
    const h = makeHarness(text, "horizontal");
    const offsets = Array.from({ length: text.length }, (_, i) => {
      const c = h.centerOf(i);
      return glyphCaretAtPoint(layer(), c.x, c.y)!.offset;
    });
    // Pointing at the centre of glyph i yields offset i or i+1 (the near edge),
    // and the sequence is strictly non-decreasing from 0 toward text.length.
    expect(offsets[0]).toBeLessThanOrEqual(1);
    expect(offsets.at(-1)).toBeGreaterThanOrEqual(text.length - 1);
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]!).toBeGreaterThanOrEqual(offsets[i - 1]!);
    }
  });

  it("90° (vertical-down): a vertical drag advances the offset along +y, not x", () => {
    const h = makeHarness(text, "vertical-down");
    const offsets = Array.from({ length: text.length }, (_, i) => {
      const c = h.centerOf(i);
      return glyphCaretAtPoint(layer(), c.x, c.y)!.offset;
    });
    expect(offsets[0]).toBeLessThanOrEqual(1);
    expect(offsets.at(-1)).toBeGreaterThanOrEqual(text.length - 1);
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]!).toBeGreaterThanOrEqual(offsets[i - 1]!);
    }
    // Dragging to the far (last-glyph) end selects to the end of the run.
    const end = h.centerOf(text.length - 1);
    expect(glyphCaretAtPoint(layer(), end.x, end.y)!.offset).toBe(text.length);
  });

  it("270° (vertical-up): a vertical drag advances the offset along -y", () => {
    const h = makeHarness(text, "vertical-up");
    const offsets = Array.from({ length: text.length }, (_, i) => {
      const c = h.centerOf(i);
      return glyphCaretAtPoint(layer(), c.x, c.y)!.offset;
    });
    // Reading direction is toward smaller y, so later glyphs sit higher on the
    // page; the offset must still increase as we follow the reading axis.
    expect(offsets[0]).toBeLessThanOrEqual(1);
    expect(offsets.at(-1)).toBeGreaterThanOrEqual(text.length - 1);
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]!).toBeGreaterThanOrEqual(offsets[i - 1]!);
    }
    const end = h.centerOf(text.length - 1);
    expect(glyphCaretAtPoint(layer(), end.x, end.y)!.offset).toBe(text.length);
  });

  it("90°: resolves distinct offsets for pointers that differ only in y (axis is vertical)", () => {
    const h = makeHarness(text, "vertical-down");
    const near = h.centerOf(1);
    const far = h.centerOf(text.length - 2);
    const nearOffset = glyphCaretAtPoint(layer(), near.x, near.y)!.offset;
    const farOffset = glyphCaretAtPoint(layer(), far.x, far.y)!.offset;
    // If the code wrongly projected onto x (constant for a vertical span) these
    // would be equal. They must differ because the axis is +y.
    expect(farOffset).toBeGreaterThan(nearOffset);
  });

  it("a press in the blank margin (outside the span) selects nothing", () => {
    const h = makeHarness(text, "vertical-down");
    const c = h.centerOf(0);
    expect(glyphCaretAtPoint(layer(), c.x - 60, c.y)).toBeNull();
  });
});
