/**
 * FEAT-005 — unit tests for carbon-skeleton reconstruction: geometric graph ->
 * CarbonSkeletonResult, status/confidence assessment, and the full image ->
 * result pipeline on small hand-built images. The exhaustive corpus accuracy
 * check lives in benchmark.test.ts.
 */

import { describe, expect, it } from "vitest";
import {
  geometricGraphToCarbonSkeleton,
  reconstructCarbonSkeleton,
} from "./carbonSkeleton";
import { rasterizeSegments } from "./raster";
import type { GeometricGraph, GrayImage } from "./types";

function vertex(id: number, x: number, y: number) {
  return { id, x, y, degree: 0, kind: "corner" as const };
}

describe("geometricGraphToCarbonSkeleton", () => {
  it("maps vertices to carbons and edges to bonds, annotating degree/role", () => {
    // path 0-1-2 with a branch 1-3 => one junction, three endpoints.
    const graph: GeometricGraph = {
      vertices: [vertex(0, 0, 0), vertex(1, 10, 0), vertex(2, 20, 0), vertex(3, 10, 10)],
      edges: [
        { source: 0, target: 1, path: [], length: 10 },
        { source: 1, target: 2, path: [], length: 10 },
        { source: 1, target: 3, path: [], length: 10 },
      ],
    };
    const r = geometricGraphToCarbonSkeleton(graph);
    expect(r.atoms).toHaveLength(4);
    expect(r.bonds).toHaveLength(3);
    const junction = r.atoms.find((a) => a.id === 1);
    expect(junction?.degree).toBe(3);
    expect(junction?.isJunction).toBe(true);
    expect(r.atoms.filter((a) => a.isEndpoint)).toHaveLength(3);
    expect(r.cycleRank).toBe(0);
    expect(r.status).toBe("success");
  });

  it("reports a ring and marks its atoms belongsToCycle", () => {
    const graph: GeometricGraph = {
      vertices: [vertex(0, 0, 0), vertex(1, 10, 0), vertex(2, 10, 10), vertex(3, 0, 10)],
      edges: [
        { source: 0, target: 1, path: [], length: 10 },
        { source: 1, target: 2, path: [], length: 10 },
        { source: 2, target: 3, path: [], length: 10 },
        { source: 0, target: 3, path: [], length: 10 },
      ],
    };
    const r = geometricGraphToCarbonSkeleton(graph);
    expect(r.cycleRank).toBe(1);
    expect(r.cycles).toHaveLength(1);
    expect(r.atoms.every((a) => a.belongsToCycle)).toBe(true);
  });

  it("flags a degree-4 vertex as a possible crossing and lowers confidence", () => {
    const graph: GeometricGraph = {
      vertices: [
        vertex(0, 10, 10),
        vertex(1, 10, 0),
        vertex(2, 20, 10),
        vertex(3, 10, 20),
        vertex(4, 0, 10),
      ],
      edges: [
        { source: 0, target: 1, path: [], length: 10 },
        { source: 0, target: 2, path: [], length: 10 },
        { source: 0, target: 3, path: [], length: 10 },
        { source: 0, target: 4, path: [], length: 10 },
      ],
    };
    const r = geometricGraphToCarbonSkeleton(graph);
    expect(r.confidence).toBeLessThan(1);
    expect(r.notes.some((n) => /degree >= 4/.test(n))).toBe(true);
  });

  it("returns 'invalid' for vertices with no bonds, 'unsupported' for empty", () => {
    const noBonds: GeometricGraph = { vertices: [vertex(0, 0, 0)], edges: [] };
    expect(geometricGraphToCarbonSkeleton(noBonds).status).toBe("invalid");
    const empty: GeometricGraph = { vertices: [], edges: [] };
    expect(geometricGraphToCarbonSkeleton(empty).status).toBe("unsupported");
  });
});

describe("reconstructCarbonSkeleton (full pipeline)", () => {
  function line(): GrayImage {
    return rasterizeSegments(60, 20, [{ from: { x: 8, y: 10 }, to: { x: 52, y: 10 } }], {
      radius: 1.6,
      antialias: true,
    });
  }

  it("reconstructs a straight bond as 2 carbons + 1 bond", () => {
    const r = reconstructCarbonSkeleton(line());
    expect(r.atoms).toHaveLength(2);
    expect(r.bonds).toHaveLength(1);
    expect(r.status).toBe("success");
  });

  it("returns 'unsupported' for a blank image without fabricating atoms", () => {
    const blank: GrayImage = {
      width: 40,
      height: 40,
      data: new Uint8ClampedArray(40 * 40).fill(255),
    };
    const r = reconstructCarbonSkeleton(blank);
    expect(r.status).toBe("unsupported");
    expect(r.atoms).toHaveLength(0);
  });

  it("does not mutate the input image", () => {
    const g = line();
    const before = Uint8ClampedArray.from(g.data);
    reconstructCarbonSkeleton(g);
    expect([...g.data]).toEqual([...before]);
  });
});
