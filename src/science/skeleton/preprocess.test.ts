/**
 * FEAT-005 — unit tests for the deterministic preprocessing pipeline.
 * Each stage is exercised in isolation on small, hand-built images.
 */

import { describe, expect, it } from "vitest";
import {
  dilate,
  erode,
  foregroundCount,
  labelComponents,
  morphClose,
  morphOpen,
  otsuThreshold,
  removeSmallComponents,
  rgbaToGrayscale,
  thresholdBinary,
  zhangSuenThin,
} from "./preprocess";
import type { BinaryImage, GrayImage } from "./types";

function gray(width: number, height: number, values: number[]): GrayImage {
  return { width, height, data: new Uint8ClampedArray(values) };
}

function binary(width: number, height: number, values: number[]): BinaryImage {
  return { width, height, data: new Uint8Array(values) };
}

describe("rgbaToGrayscale", () => {
  it("composites transparency onto white and applies BT.601 luma", () => {
    // 2 pixels: opaque black, fully transparent (should read as white).
    const rgba = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 0]);
    const g = rgbaToGrayscale(rgba, 2, 1);
    expect(g.data[0]).toBe(0);
    expect(g.data[1]).toBe(255);
  });

  it("weights green most heavily", () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]);
    const g = rgbaToGrayscale(rgba, 2, 1);
    expect(g.data[1]).toBeGreaterThan(g.data[0] as number); // green brighter than red
  });
});

describe("otsuThreshold + thresholdBinary", () => {
  it("separates a clearly bimodal image", () => {
    // half dark (30), half light (220)
    const g = gray(4, 1, [30, 30, 220, 220]);
    const t = otsuThreshold(g);
    expect(t).toBeGreaterThanOrEqual(30);
    expect(t).toBeLessThan(220);
    const b = thresholdBinary(g, t);
    expect([...b.data]).toEqual([1, 1, 0, 0]);
  });

  it("treats ink exactly at the Otsu cutoff as foreground (<= not <)", () => {
    // crisp near-binary: ink at 20, background at 255.
    const g = gray(4, 1, [20, 255, 20, 255]);
    const b = thresholdBinary(g); // uses Otsu
    expect(foregroundCount(b)).toBe(2);
  });
});

describe("labelComponents + removeSmallComponents", () => {
  it("labels 8-connected blobs and counts pixels", () => {
    // two separate pixels + a 3-pixel L
    const b = binary(5, 2, [
      1, 0, 0, 1, 1,
      0, 0, 0, 1, 0,
    ]);
    const { counts } = labelComponents(b);
    // counts[0] is the background sentinel; real components follow.
    const real = counts.slice(1).sort((a, z) => a - z);
    expect(real).toEqual([1, 3]);
  });

  it("drops components smaller than the threshold", () => {
    const b = binary(5, 2, [
      1, 0, 0, 1, 1,
      0, 0, 0, 1, 0,
    ]);
    const cleaned = removeSmallComponents(b, 2);
    expect(foregroundCount(cleaned)).toBe(3); // the singleton is removed
  });
});

describe("morphology", () => {
  const b = binary(5, 5, [
    0, 0, 0, 0, 0,
    0, 1, 1, 1, 0,
    0, 1, 1, 1, 0,
    0, 1, 1, 1, 0,
    0, 0, 0, 0, 0,
  ]);

  it("dilate grows the region, erode shrinks it", () => {
    expect(foregroundCount(dilate(b))).toBeGreaterThan(foregroundCount(b));
    expect(foregroundCount(erode(b))).toBeLessThan(foregroundCount(b));
  });

  it("open removes a 1px speck; close fills a 1px hole", () => {
    const speck = binary(5, 5, [
      0, 0, 0, 0, 0,
      0, 0, 0, 0, 0,
      0, 0, 1, 0, 0,
      0, 0, 0, 0, 0,
      0, 0, 0, 0, 0,
    ]);
    expect(foregroundCount(morphOpen(speck))).toBe(0);

    const holed = binary(5, 5, [
      1, 1, 1, 1, 1,
      1, 1, 1, 1, 1,
      1, 1, 0, 1, 1,
      1, 1, 1, 1, 1,
      1, 1, 1, 1, 1,
    ]);
    // close should fill the single interior hole.
    const closed = morphClose(holed);
    expect(closed.data[2 * 5 + 2]).toBe(1);
  });
});

describe("zhangSuenThin", () => {
  it("thins a thick horizontal bar to a single-pixel-high medial line", () => {
    // 3px tall, 7px wide bar.
    const w = 9;
    const h = 5;
    const data = new Uint8Array(w * h);
    for (let y = 1; y <= 3; y++) for (let x = 1; x <= 7; x++) data[y * w + x] = 1;
    const skel = zhangSuenThin({ width: w, height: h, data });
    // No column may keep more than one foreground pixel (true 1px thickness),
    // and the result must collapse to a single interior row.
    const rowCounts = new Array(h).fill(0);
    for (let x = 0; x < w; x++) {
      let col = 0;
      for (let y = 0; y < h; y++) {
        if (skel.data[y * w + x]) {
          col++;
          rowCounts[y]++;
        }
      }
      expect(col).toBeLessThanOrEqual(1);
    }
    const usedRows = rowCounts.filter((c: number) => c > 0).length;
    expect(usedRows).toBe(1); // all ink on one medial row
  });

  it("preserves a thin diagonal (idempotent on 1px input)", () => {
    const w = 6;
    const h = 6;
    const data = new Uint8Array(w * h);
    for (let i = 1; i <= 4; i++) data[i * w + i] = 1;
    const once = zhangSuenThin({ width: w, height: h, data });
    const twice = zhangSuenThin(once);
    expect([...once.data]).toEqual([...data]);
    expect([...twice.data]).toEqual([...once.data]);
  });

  it("keeps endpoints (does not erode a line to nothing)", () => {
    const w = 7;
    const h = 3;
    const data = new Uint8Array(w * h);
    for (let x = 1; x <= 5; x++) data[1 * w + x] = 1;
    const skel = zhangSuenThin({ width: w, height: h, data });
    expect(foregroundCount(skel)).toBeGreaterThanOrEqual(5);
  });
});
