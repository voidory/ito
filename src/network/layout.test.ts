import { describe, expect, it } from "vitest";
import {
  createLayoutState,
  kineticEnergy,
  layoutStep,
  runLayout,
  DEFAULT_LAYOUT_PARAMS,
  type LayoutGraph,
  type LayoutParams,
  type Vec2,
} from "./index";

/**
 * Pure-logic coverage for the deterministic force-directed layout engine.
 * Proves A09-M2 (determinism + convergence, "no unexpected snaps") and the
 * computational core of A10-M2 (a multi-category node settles in the overlap).
 */

function centroid(points: readonly Vec2[]): Vec2 {
  const sum = points.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

describe("layout — determinism", () => {
  const graph: LayoutGraph = {
    nodes: [
      { id: "a", x: 0, y: 0, categoryIds: ["cat1"] },
      { id: "b", x: 10, y: 5, categoryIds: ["cat1"] },
      { id: "c", x: -5, y: 8, categoryIds: ["cat2"] },
      { id: "d", x: 3, y: -4, categoryIds: ["cat2"] },
    ],
    links: [
      { sourceId: "a", targetId: "b" },
      { sourceId: "c", targetId: "d" },
      { sourceId: "b", targetId: "c" },
    ],
  };

  it("produces byte-identical positions for identical (graph, seed, iterations)", () => {
    const run1 = runLayout(graph, { iterations: 150, seed: 42 });
    const run2 = runLayout(graph, { iterations: 150, seed: 42 });
    expect(JSON.stringify(run1)).toBe(JSON.stringify(run2));
  });

  it("different seeds generally yield different layouts", () => {
    const run1 = runLayout(graph, { iterations: 150, seed: 1 });
    const run2 = runLayout(graph, { iterations: 150, seed: 2 });
    expect(JSON.stringify(run1)).not.toBe(JSON.stringify(run2));
  });

  it("does not call Math.random (determinism holds even if Math.random is stubbed)", () => {
    const original = Math.random;
    try {
      // If the engine leaked a Math.random call, this would break determinism.
      Math.random = () => 0.123456789;
      const run1 = runLayout(graph, { iterations: 100, seed: 7 });
      Math.random = () => 0.987654321;
      const run2 = runLayout(graph, { iterations: 100, seed: 7 });
      expect(JSON.stringify(run1)).toBe(JSON.stringify(run2));
    } finally {
      Math.random = original;
    }
  });
});

describe("layout — convergence (no perpetual oscillation / snaps)", () => {
  const graph: LayoutGraph = {
    nodes: [
      { id: "a", x: 0, y: 0, categoryIds: ["cat1"] },
      { id: "b", x: 40, y: 0, categoryIds: ["cat1"] },
      { id: "c", x: 0, y: 40, categoryIds: ["cat1"] },
      { id: "d", x: 40, y: 40, categoryIds: ["cat1"] },
    ],
    links: [
      { sourceId: "a", targetId: "b" },
      { sourceId: "b", targetId: "c" },
      { sourceId: "c", targetId: "d" },
    ],
  };

  it("positions change by less than epsilon after enough iterations", () => {
    const params: LayoutParams = DEFAULT_LAYOUT_PARAMS;
    let state = createLayoutState(graph, 99);
    for (let i = 0; i < 400; i++) state = layoutStep(state, params);
    const before = state.bodies.map((b) => ({ x: b.x, y: b.y }));
    for (let i = 0; i < 20; i++) state = layoutStep(state, params);
    const after = state.bodies.map((b) => ({ x: b.x, y: b.y }));

    let maxMove = 0;
    for (let i = 0; i < before.length; i++) {
      maxMove = Math.max(maxMove, dist(before[i]!, after[i]!));
    }
    expect(maxMove).toBeLessThan(0.5);
  });

  it("kinetic energy decays toward zero (damping dissipates motion)", () => {
    let state = createLayoutState(graph, 99);
    for (let i = 0; i < 30; i++) state = layoutStep(state, DEFAULT_LAYOUT_PARAMS);
    const early = kineticEnergy(state);
    for (let i = 0; i < 400; i++) state = layoutStep(state, DEFAULT_LAYOUT_PARAMS);
    const late = kineticEnergy(state);
    expect(late).toBeLessThan(early);
    expect(late).toBeLessThan(0.1);
  });
});

describe("layout — category attraction (A10-M2 core)", () => {
  // Two spatially separated category clusters, plus one node in BOTH categories
  // and one single-category control node that starts at the same spot.
  const graph: LayoutGraph = {
    nodes: [
      // cat1 cluster on the left
      { id: "l1", x: -200, y: 0, categoryIds: ["cat1"] },
      { id: "l2", x: -200, y: 40, categoryIds: ["cat1"] },
      { id: "l3", x: -200, y: -40, categoryIds: ["cat1"] },
      // cat2 cluster on the right
      { id: "r1", x: 200, y: 0, categoryIds: ["cat2"] },
      { id: "r2", x: 200, y: 40, categoryIds: ["cat2"] },
      { id: "r3", x: 200, y: -40, categoryIds: ["cat2"] },
      // A node in BOTH categories, and a single-category control, both starting
      // at the origin with no links (isolate the category force).
      { id: "both", x: 0, y: 0, categoryIds: ["cat1", "cat2"] },
      { id: "single", x: 0, y: 0, categoryIds: ["cat1"] },
    ],
    links: [],
  };

  it("single-category node settles inside its own cluster region", () => {
    const pos = runLayout(graph, { iterations: 300, seed: 5 });
    const cat1Centroid = centroid([pos["l1"]!, pos["l2"]!, pos["l3"]!, pos["single"]!]);
    // The single-category control is pulled toward cat1 (left, negative x).
    expect(pos["single"]!.x).toBeLessThan(0);
    // ...and lands near its cluster centroid rather than drifting to cat2.
    expect(dist(pos["single"]!, cat1Centroid)).toBeLessThan(dist(pos["single"]!, pos["r1"]!));
  });

  it("a node in TWO categories settles nearer both centroids' midpoint than a single-category node", () => {
    const pos = runLayout(graph, { iterations: 300, seed: 5 });
    const cat1Centroid = centroid([pos["l1"]!, pos["l2"]!, pos["l3"]!]);
    const cat2Centroid = centroid([pos["r1"]!, pos["r2"]!, pos["r3"]!]);
    const midpoint: Vec2 = {
      x: (cat1Centroid.x + cat2Centroid.x) / 2,
      y: (cat1Centroid.y + cat2Centroid.y) / 2,
    };
    const bothToMid = dist(pos["both"]!, midpoint);
    const singleToMid = dist(pos["single"]!, midpoint);
    expect(bothToMid).toBeLessThan(singleToMid);
    // The dual-category node lives in the overlap region between the clusters:
    // closer to the midpoint than to either cluster centroid alone.
    expect(bothToMid).toBeLessThan(dist(pos["both"]!, cat1Centroid));
    expect(bothToMid).toBeLessThan(dist(pos["both"]!, cat2Centroid));
  });
});
