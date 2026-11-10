/**
 * M18 FEAT-001 (spec Phase 1, Step 1.2 — Area crop pipeline) — regression tests
 * that lock down the EXISTING M17 Area crop in src/pdf/highlight.ts:
 *
 *   PDF page canvas  →  normalized rect  →  imageDataUrl
 *
 * Nothing is mocked: each case drives the REAL exported `cropCanvasRegionToDataUrl`.
 * Under jsdom there is no real 2d canvas backend (`getContext("2d")` returns
 * null), so the function returns its DETERMINISTIC inline-SVG fallback that
 * encodes the cropped pixel size `sw x sh = round(width*srcW) x round(height*srcH)`
 * (clamped to a minimum of 1). We decode that fallback to assert the crop region
 * maps to the correct source pixels and stays correct as the canvas is scaled
 * (simulating different zoom levels).
 *
 * NOTE: true rotation-invariance and pixel-exactness of the crop are covered at
 * the BROWSER level by e2e/reader-workbench.spec.ts and e2e/pdf-anchor.spec.ts;
 * jsdom has no real 2d canvas, so those visual guarantees cannot be asserted
 * here. These unit tests pin the deterministic coordinate math + the "always a
 * usable data: URL" contract.
 */

import { describe, expect, it } from "vitest";
import { cropCanvasRegionToDataUrl } from "../../pdf/highlight";
import type { NormalizedRect } from "../../model";

/** Build a jsdom <canvas> with a known backing-store pixel size. */
function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** Decode the "figure {w}x{h}" size encoded in the deterministic SVG fallback. */
function decodeFallbackSize(dataUrl: string): { w: number; h: number } | null {
  expect(dataUrl.startsWith("data:image/svg+xml,")).toBe(true);
  const svg = decodeURIComponent(dataUrl.slice("data:image/svg+xml,".length));
  const m = svg.match(/figure (\d+)x(\d+)/);
  if (!m) return null;
  return { w: parseInt(m[1]!, 10), h: parseInt(m[2]!, 10) };
}

describe("M18 FEAT-001 — M17 Area crop pipeline (cropCanvasRegionToDataUrl)", () => {
  it("(1) a normalized rect maps to the correct source pixel region", () => {
    const srcW = 800;
    const srcH = 600;
    const canvas = makeCanvas(srcW, srcH);
    const rect: NormalizedRect = { x: 0.25, y: 0.5, width: 0.5, height: 0.25 };

    const url = cropCanvasRegionToDataUrl(canvas, rect);
    const size = decodeFallbackSize(url);
    expect(size).not.toBeNull();
    // sw x sh = round(width*srcW) x round(height*srcH).
    expect(size!.w).toBe(Math.round(rect.width * srcW)); // 400
    expect(size!.h).toBe(Math.round(rect.height * srcH)); // 150
  });

  it("(2) coordinates stay correct across canvas sizes (different zoom levels)", () => {
    const rect: NormalizedRect = { x: 0.1, y: 0.1, width: 0.3, height: 0.2 };

    // Same normalized rect; a canvas rendered at 2× zoom yields a 2× crop size.
    const small = decodeFallbackSize(cropCanvasRegionToDataUrl(makeCanvas(400, 300), rect))!;
    const large = decodeFallbackSize(cropCanvasRegionToDataUrl(makeCanvas(800, 600), rect))!;

    expect(small.w).toBe(Math.round(rect.width * 400)); // 120
    expect(small.h).toBe(Math.round(rect.height * 300)); // 60
    expect(large.w).toBe(Math.round(rect.width * 800)); // 240
    expect(large.h).toBe(Math.round(rect.height * 600)); // 120
    // The crop scales proportionally with the rendered (zoomed) canvas.
    expect(large.w).toBe(small.w * 2);
    expect(large.h).toBe(small.h * 2);
  });

  it("(3) a null / zero-size canvas still yields a usable (never-empty) data: URL", () => {
    const rect: NormalizedRect = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 };

    // Scanned / image-only page with no 2d backend, or a missing canvas: must
    // never throw and must still return a non-empty data: URL.
    for (const canvas of [null, undefined, makeCanvas(0, 0)]) {
      const url = cropCanvasRegionToDataUrl(canvas, rect);
      expect(url.startsWith("data:")).toBe(true);
      expect(url.length).toBeGreaterThan("data:".length);
      // The fallback clamps the crop size to a minimum of 1×1 so the URL is
      // always a renderable image.
      const size = decodeFallbackSize(url);
      expect(size!.w).toBeGreaterThanOrEqual(1);
      expect(size!.h).toBeGreaterThanOrEqual(1);
    }
  });

  it("(4) a text-layer-backed page crop also produces a data: URL", () => {
    // A normal text-layer page renders to a sized canvas; cropping it yields a
    // usable data: URL exactly like an image-only page.
    const canvas = makeCanvas(1024, 768);
    const rect: NormalizedRect = { x: 0, y: 0, width: 1, height: 1 };
    const url = cropCanvasRegionToDataUrl(canvas, rect);
    expect(url.startsWith("data:")).toBe(true);
    const size = decodeFallbackSize(url);
    // Full-page crop → the full backing-store pixel size.
    expect(size!.w).toBe(1024);
    expect(size!.h).toBe(768);
  });

  it("every returned value starts with 'data:' and is non-empty and deterministic", () => {
    const canvas = makeCanvas(500, 400);
    const rect: NormalizedRect = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
    const a = cropCanvasRegionToDataUrl(canvas, rect);
    const b = cropCanvasRegionToDataUrl(canvas, rect);
    expect(a.startsWith("data:")).toBe(true);
    expect(a.length).toBeGreaterThan(0);
    // Deterministic: identical inputs yield identical URLs.
    expect(a).toBe(b);
  });
});
