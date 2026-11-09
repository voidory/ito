import { describe, expect, it } from "vitest";
import {
  squircleBounds,
  squircleContains,
  squirclePath,
  squirclePoint,
  type SquirclePoint,
} from "./index";

/**
 * Pure-geometry coverage for the superellipse category boundary (A09-M2:
 * nodes float stably inside category boundaries).
 */

describe("squirclePath", () => {
  it("produces a closed superellipse path with sampled vertices", () => {
    const d = squirclePath({ cx: 0, cy: 0, rx: 50, ry: 30, samples: 32 });
    expect(d.startsWith("M")).toBe(true);
    expect(d.trim().endsWith("Z")).toBe(true);
    const lineCmds = (d.match(/L/g) ?? []).length;
    expect(lineCmds).toBe(31); // 32 samples => 1 M + 31 L + Z
  });

  it("boundary points satisfy the implicit superellipse equation", () => {
    const bounds = { cx: 5, cy: -2, rx: 40, ry: 20 };
    const n = 4;
    for (let i = 0; i < 16; i++) {
      const theta = (i / 16) * Math.PI * 2;
      const p = squirclePoint(bounds, theta, n);
      const dx = Math.abs(p.x - bounds.cx) / bounds.rx;
      const dy = Math.abs(p.y - bounds.cy) / bounds.ry;
      expect(Math.pow(dx, n) + Math.pow(dy, n)).toBeCloseTo(1, 6);
    }
  });
});

describe("squircleBounds", () => {
  const points: SquirclePoint[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 0, y: 60 },
    { x: 100, y: 60 },
    { x: 50, y: 30 },
  ];

  it("encloses all member points plus padding", () => {
    const padding = 20;
    const bounds = squircleBounds(points, padding);
    expect(bounds.cx).toBeCloseTo(50, 6);
    expect(bounds.cy).toBeCloseTo(30, 6);
    expect(bounds.rx).toBeCloseTo(50 + padding, 6);
    expect(bounds.ry).toBeCloseTo(30 + padding, 6);
    for (const p of points) {
      expect(squircleContains(bounds, p)).toBe(true);
    }
  });

  it("empty point set yields a padded zero-size box", () => {
    const bounds = squircleBounds([], 5);
    expect(bounds.rx).toBe(5);
    expect(bounds.ry).toBe(5);
  });
});

describe("squircleContains", () => {
  const bounds = { cx: 0, cy: 0, rx: 100, ry: 100 };

  it("is true for interior points (including the center)", () => {
    expect(squircleContains(bounds, { x: 0, y: 0 })).toBe(true);
    expect(squircleContains(bounds, { x: 50, y: 50 })).toBe(true);
  });

  it("is false for far-outside points", () => {
    expect(squircleContains(bounds, { x: 500, y: 500 })).toBe(false);
    expect(squircleContains(bounds, { x: 0, y: 1000 })).toBe(false);
  });

  it("includes the squircle corner region an ellipse would exclude (n=4 > 2)", () => {
    // At (90,90), |0.9|^4 + |0.9|^4 = 1.31 > 1 -> outside even a squircle here.
    expect(squircleContains(bounds, { x: 90, y: 90 })).toBe(false);
    // But (80,80): 0.8^4*2 = 0.819 <= 1 -> inside the squircle (an ellipse
    // would also include it; the squircle is strictly more inclusive at corners).
    expect(squircleContains(bounds, { x: 80, y: 80 })).toBe(true);
  });
});

describe("overlapping squircle bounds share an intersection region", () => {
  it("two overlapping boundaries both contain a point in their overlap", () => {
    const a = squircleBounds(
      [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ],
      10,
    );
    const b = squircleBounds(
      [
        { x: 50, y: 50 },
        { x: 150, y: 150 },
      ],
      10,
    );
    // A point in the geometric overlap (~ (75,75)) is inside both squircles.
    const overlapPoint = { x: 75, y: 75 };
    expect(squircleContains(a, overlapPoint)).toBe(true);
    expect(squircleContains(b, overlapPoint)).toBe(true);
  });
});
