/**
 * FEAT-005B — unit tests for the evaluation metrics (vertex/bond P-R, graph
 * edit distance, cycle-rank + branch-topology accuracy, geometric matching).
 */

import { describe, expect, it } from "vitest";
import { evaluate, matchVertices, type GroundTruthGraph } from "./metrics";
import type { CarbonSkeletonResult } from "../types";

function result(
  atoms: { x: number; y: number }[],
  bonds: [number, number][],
): CarbonSkeletonResult {
  return {
    atoms: atoms.map((a, id) => ({
      id,
      x: a.x,
      y: a.y,
      degree: bonds.filter(([s, t]) => s === id || t === id).length,
      isEndpoint: false,
      isJunction: false,
      belongsToCycle: false,
    })),
    bonds: bonds.map(([s, t]) => ({ source: Math.min(s, t), target: Math.max(s, t) })),
    cycles: [],
    connectedComponents: [],
    cycleRank: 0,
    confidence: 1,
    status: "success",
    notes: [],
  };
}

describe("metrics", () => {
  it("matches vertices one-to-one within tolerance", () => {
    const pred = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 100, y: 100 }];
    const gt = [{ x: 1, y: 1 }, { x: 9, y: 0 }];
    const map = matchVertices(pred, gt, 3);
    expect(map[0]).toBe(0);
    expect(map[1]).toBe(1);
    expect(map[2]).toBe(-1); // far away → unmatched
  });

  it("scores a perfect reconstruction as exact with F1 = 1", () => {
    const gt: GroundTruthGraph = {
      atoms: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }],
      bonds: [[0, 1], [1, 2]],
      expectedCycleRank: 0,
    };
    const r = result([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }], [[0, 1], [1, 2]]);
    const m = evaluate(r, gt, 4);
    expect(m.exact).toBe(true);
    expect(m.vertex.f1).toBe(1);
    expect(m.bond.f1).toBe(1);
    expect(m.graphEditDistance).toBe(0);
    expect(m.branchTopologyCorrect).toBe(true);
    expect(m.cycleRankCorrect).toBe(true);
  });

  it("penalises a missing vertex (recall < 1) and a dropped bond", () => {
    const gt: GroundTruthGraph = {
      atoms: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }],
      bonds: [[0, 1], [1, 2]],
      expectedCycleRank: 0,
    };
    // Predicted only two of three atoms and one bond.
    const r = result([{ x: 0, y: 0 }, { x: 10, y: 0 }], [[0, 1]]);
    const m = evaluate(r, gt, 4);
    expect(m.exact).toBe(false);
    expect(m.vertex.recall).toBeLessThan(1);
    expect(m.bond.recall).toBeLessThan(1);
    expect(m.graphEditDistance).toBeGreaterThan(0);
  });

  it("penalises a false (extra) vertex with precision < 1", () => {
    const gt: GroundTruthGraph = {
      atoms: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      bonds: [[0, 1]],
      expectedCycleRank: 0,
    };
    const r = result([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 50 }], [[0, 1]]);
    const m = evaluate(r, gt, 4);
    expect(m.vertex.precision).toBeLessThan(1);
    expect(m.vertex.falsePositives).toBe(1);
  });
});
