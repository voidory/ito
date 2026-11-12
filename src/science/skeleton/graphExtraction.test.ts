/**
 * FEAT-005 — unit tests for geometric graph extraction from a 1px skeleton:
 * connectivity-number classification (NOT raw neighbour count), Douglas-Peucker
 * simplification, path tracing, corner recovery, vertex merging and spur
 * rejection.
 */

import { describe, expect, it } from "vitest";
import {
  classifySkeletonPixels,
  connectivityNumber,
  douglasPeucker,
  extractGeometricGraph,
  tracePaths,
} from "./graphExtraction";
import { DEFAULT_PIPELINE_OPTIONS, type BinaryImage, type Point } from "./types";

function img(width: number, height: number, rows: string[]): BinaryImage {
  const data = new Uint8Array(width * height);
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === "#") data[y * width + x] = 1;
  });
  return { width, height, data };
}

const opts = { ...DEFAULT_PIPELINE_OPTIONS };

describe("connectivityNumber", () => {
  it("is 2 for a pixel on a straight diagonal (staircase does not inflate it)", () => {
    const b = img(5, 5, [
      "#....",
      ".#...",
      "..#..",
      "...#.",
      "....#",
    ]);
    expect(connectivityNumber(b.data, 5, 5, 2, 2)).toBe(2);
  });

  it("is 1 for a terminal endpoint", () => {
    const b = img(5, 3, [
      ".....",
      ".###.",
      ".....",
    ]);
    expect(connectivityNumber(b.data, 5, 3, 1, 1)).toBe(1);
  });

  it("is 3 at a genuine T-junction", () => {
    const b = img(5, 5, [
      "..#..",
      "..#..",
      "#####",
      ".....",
      ".....",
    ]);
    expect(connectivityNumber(b.data, 5, 5, 2, 2)).toBe(3);
  });
});

describe("classifySkeletonPixels", () => {
  it("marks only the two endpoints of a diagonal as significant", () => {
    const b = img(5, 5, [
      "#....",
      ".#...",
      "..#..",
      "...#.",
      "....#",
    ]);
    const { significant } = classifySkeletonPixels(b);
    // The two ends (connectivity 1), not the interior staircase pixels.
    expect(significant.size).toBe(2);
  });

  it("marks the branch point of a T as significant", () => {
    const b = img(5, 5, [
      "..#..",
      "..#..",
      "#####",
      ".....",
      ".....",
    ]);
    const { significant } = classifySkeletonPixels(b);
    const w = 5;
    expect(significant.has(2 * w + 2)).toBe(true); // the junction
  });
});

describe("douglasPeucker", () => {
  it("collapses a straight run to its two endpoints", () => {
    const pts: Point[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ];
    expect(douglasPeucker(pts, 1)).toEqual([
      { x: 0, y: 0 },
      { x: 3, y: 0 },
    ]);
  });

  it("keeps a genuine corner", () => {
    const pts: Point[] = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 }, // sharp turn
    ];
    const simplified = douglasPeucker(pts, 1);
    expect(simplified).toContainEqual({ x: 4, y: 0 });
  });
});

describe("tracePaths", () => {
  it("traces a single open strand between two endpoints", () => {
    const b = img(7, 3, [
      ".......",
      ".#####.",
      ".......",
    ]);
    const paths = tracePaths(b);
    expect(paths).toHaveLength(1);
    expect(paths[0]?.startKey).not.toBe(paths[0]?.endKey);
  });

  it("traces a closed loop as a single path with start === end", () => {
    const b = img(5, 5, [
      ".###.",
      ".#.#.",
      ".#.#.",
      ".###.",
      ".....",
    ]);
    const paths = tracePaths(b);
    const loop = paths.find((p) => p.startKey === p.endKey);
    expect(loop).toBeDefined();
  });
});

describe("extractGeometricGraph", () => {
  it("extracts a 2-vertex, 1-edge graph from a straight line", () => {
    const b = img(9, 3, [
      ".........",
      ".#######.",
      ".........",
    ]);
    const g = extractGeometricGraph(b, opts);
    expect(g.vertices).toHaveLength(2);
    expect(g.edges).toHaveLength(1);
    expect(g.vertices.every((v) => v.kind === "endpoint")).toBe(true);
  });

  it("recovers a line-angle vertex at an L bend (3 vertices, 2 edges)", () => {
    // Drawn at a realistic scale (bonds ~> mergeRadius) so the three vertices
    // are not merged. A vertical stroke of ~40px meeting a horizontal one.
    const w = 60;
    const h = 60;
    const data = new Uint8Array(w * h);
    for (let y = 8; y <= 48; y++) data[y * w + 8] = 1; // vertical
    for (let x = 8; x <= 50; x++) data[48 * w + x] = 1; // horizontal
    const g = extractGeometricGraph({ width: w, height: h, data }, opts);
    expect(g.vertices).toHaveLength(3);
    expect(g.edges).toHaveLength(2);
    // The corner vertex has degree 2; the two ends are endpoints.
    const degs = g.vertices.map((v) => v.degree).sort();
    expect(degs).toEqual([1, 1, 2]);
  });

  it("does not create a junction for a near-straight bend below the angle threshold", () => {
    // A gentle ~10deg bend across ~50px; with a high corner-angle threshold it
    // must simplify to a single straight edge (2 vertices).
    const w = 70;
    const h = 30;
    const data = new Uint8Array(w * h);
    for (let x = 8; x <= 60; x++) {
      const y = 15 - Math.round((x - 8) * 0.09); // slope ~5deg
      data[y * w + x] = 1;
    }
    const g = extractGeometricGraph({ width: w, height: h, data }, { ...opts, minCornerAngleDeg: 45 });
    expect(g.vertices).toHaveLength(2);
  });
});
