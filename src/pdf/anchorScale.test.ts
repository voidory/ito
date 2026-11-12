/**
 * FIX-HORIZONTAL-HIGHLIGHT-DRIFT (spec 3.1) scale-invariance coverage (jsdom).
 *
 * The horizontal-drift bug came from the `<canvas>` being constrained
 * independently of `.textLayer` / `.pdf-page-stage` (a stray `max-width: 100%`
 * on the stage, with the canvas pinned at its intrinsic pixel width). Glyph
 * geometry and the stage box then disagreed, so highlights drifted ~110px to
 * the left of the real glyphs in a narrow 2/3-pane layout.
 *
 * The fix keeps canvas + text layer + overlay locked at 1:1 pixel dimensions
 * inside the stage and applies any narrow-pane auto-fit as a single rigid
 * scale of the whole stage. `createAnchor` normalizes strictly against
 * `stage.getBoundingClientRect()`, which already reflects a CSS
 * `transform: scale()`. Because the glyph client rects scale by exactly the
 * same factor as the stage box, the NORMALIZED (0..1) left/width must be
 * byte-for-byte identical at 1.0x and at a 0.6x narrow-pane scale.
 *
 * `render.ts` needs the pdf.js worker (browser-only), so this test drives the
 * pure geometry half directly: it fabricates the stage box + selection client
 * rects at both scales, feeds them through `createAnchor`, then through
 * `renderHighlightOverlay`, and asserts the overlay fragment's percentage
 * left/width are identical across the two scales.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createAnchor, type PageBox } from "./anchor";
import { renderHighlightOverlay } from "./highlight";
import type { SourceId, SourceVersionHash } from "../model";

let stageEl: HTMLElement | null = null;

afterEach(() => {
  stageEl?.remove();
  stageEl = null;
});

/** A tiny DOMRect-like whose only consumed fields are left/top/width/height. */
function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON() {
      return {};
    },
  } as DOMRect;
}

/**
 * A fake Selection whose single range reports fixed client rects. createAnchor
 * only touches rangeCount, getRangeAt(0).getClientRects(), and toString().
 */
function fakeSelection(selectedText: string, clientRects: DOMRect[]): Selection {
  const range = {
    getClientRects: () => clientRects as unknown as DOMRectList,
  };
  return {
    rangeCount: 1,
    getRangeAt: () => range,
    toString: () => selectedText,
  } as unknown as Selection;
}

/**
 * Build the anchor + overlay for a given uniform scale factor. The stage box
 * and the selection glyph rect are BOTH multiplied by `scale`, exactly as a
 * CSS `transform: scale()` on the rigid stage container would report through
 * `getBoundingClientRect()`.
 */
function buildAt(scale: number): { leftPct: string; widthPct: string } {
  // Intrinsic (1:1) page stage is 800x1000 at origin (40, 20). A selected
  // phrase occupies a sub-rect well inside the page.
  const pageBox: PageBox = {
    left: 40 * scale,
    top: 20 * scale,
    width: 800 * scale,
    height: 1000 * scale,
  };
  const glyphRect = rect(
    (40 + 120) * scale, // 120px in from the stage left edge
    (20 + 300) * scale,
    260 * scale, // 260px wide phrase
    18 * scale,
  );

  const anchor = createAnchor({
    docId: "src-1" as SourceId,
    sourceVersionHash: "v1" as SourceVersionHash,
    pageIndex: 0,
    selection: fakeSelection("a representative phrase", [glyphRect]),
    pageBox,
    pageText: "before a representative phrase after",
  });

  const stage = document.createElement("div");
  stage.className = "pdf-page-stage";
  stage.style.position = "relative";
  const textLayer = document.createElement("div");
  textLayer.className = "textLayer";
  stage.appendChild(textLayer);
  document.body.appendChild(stage);
  stageEl = stage;

  renderHighlightOverlay(stage, {
    kind: "highlight",
    color: "yellow",
    rects: anchor.rects,
    animate: false,
    suppressMotion: true,
    annotationId: "ann-scale",
  });

  const fragment = stage.querySelector(".ito-highlight-fragment") as HTMLElement;
  expect(fragment).not.toBeNull();
  return { leftPct: fragment.style.left, widthPct: fragment.style.width };
}

describe("createAnchor + renderHighlightOverlay - scale invariance (3.1)", () => {
  it("produces identical normalized left/width at 1.0x and 0.6x stage scale", () => {
    const full = buildAt(1.0);
    stageEl?.remove();
    stageEl = null;
    const narrow = buildAt(0.6);

    // The normalized percentages must be byte-for-byte identical: a rigid
    // stage scale moves the glyph rects and the stage box together, so the
    // ratio (and thus the overlay's CSS left/width) does not drift.
    expect(narrow.leftPct).toBe(full.leftPct);
    expect(narrow.widthPct).toBe(full.widthPct);

    // Sanity: the computed values match the hand-derived ratios
    // (120/800 = 15% left, 260/800 = 32.5% width).
    expect(full.leftPct).toBe("15%");
    expect(full.widthPct).toBe("32.5%");
  });
});
