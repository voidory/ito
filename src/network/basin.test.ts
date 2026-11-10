/**
 * Unit tests for the pure Subject-basin geometry (M13 §2.1(2/3)). DOM-free: the
 * ellipse containment, deterministic default layout, and overlap centroid are
 * all functions of input geometry only.
 */

import { describe, expect, it } from "vitest";
import {
  defaultBasin,
  overlapCentroid,
  pointInSubjectBasin,
  resolveBasin,
  type Basin,
} from "./basin";

describe("pointInSubjectBasin — ellipse containment (n=2)", () => {
  const basin: Basin = { x: 0, y: 0, rx: 100, ry: 50 };

  it("contains the centre and points well inside", () => {
    expect(pointInSubjectBasin({ x: 0, y: 0 }, basin)).toBe(true);
    expect(pointInSubjectBasin({ x: 40, y: 10 }, basin)).toBe(true);
  });

  it("includes the boundary along each semi-axis", () => {
    expect(pointInSubjectBasin({ x: 100, y: 0 }, basin)).toBe(true);
    expect(pointInSubjectBasin({ x: 0, y: 50 }, basin)).toBe(true);
  });

  it("excludes points outside the ellipse (not the bounding box)", () => {
    // Inside the bounding box corner but OUTSIDE the ellipse.
    expect(pointInSubjectBasin({ x: 90, y: 45 }, basin)).toBe(false);
    expect(pointInSubjectBasin({ x: 200, y: 0 }, basin)).toBe(false);
  });

  it("a degenerate zero-axis basin only contains its exact centre", () => {
    const pt: Basin = { x: 5, y: 7, rx: 0, ry: 0 };
    expect(pointInSubjectBasin({ x: 5, y: 7 }, pt)).toBe(true);
    expect(pointInSubjectBasin({ x: 6, y: 7 }, pt)).toBe(false);
  });
});

describe("defaultBasin / resolveBasin — deterministic layout", () => {
  it("is a pure function of (index, total) — identical inputs, identical output", () => {
    expect(defaultBasin(1, 3)).toEqual(defaultBasin(1, 3));
    expect(defaultBasin(0, 1)).toEqual({ x: 0, y: 0, rx: 200, ry: 160 });
  });

  it("places a lone Subject at the origin and rings multiple Subjects apart", () => {
    const solo = defaultBasin(0, 1);
    expect(solo.x).toBeCloseTo(0, 6);
    expect(solo.y).toBeCloseTo(0, 6);
    const a = defaultBasin(0, 2);
    const b = defaultBasin(1, 2);
    // Two ringed basins have distinct centres.
    expect(a.x).not.toBeCloseTo(b.x, 3);
  });

  it("resolveBasin prefers an explicit basin and falls back to the default", () => {
    const explicit: Basin = { x: 9, y: 9, rx: 12, ry: 12 };
    expect(resolveBasin(explicit, 2, 5)).toEqual(explicit);
    expect(resolveBasin(undefined, 2, 5)).toEqual(defaultBasin(2, 5));
  });
});

describe("overlapCentroid", () => {
  it("is the midpoint of the two basin centres", () => {
    const a: Basin = { x: 0, y: 0, rx: 10, ry: 10 };
    const b: Basin = { x: 100, y: 40, rx: 10, ry: 10 };
    expect(overlapCentroid(a, b)).toEqual({ x: 50, y: 20 });
  });
});
