/**
 * Unit tests for the pure 4-tier canvas hit-tester (M13 §2.2). DOM-free: the
 * strict distance-priority resolution (node > hub/line > overlap > basin) is a
 * function of input geometry only, so it is driven here with hand-built Scene
 * fragments + explicit basins — nothing mocked, no React, no DOM.
 */

import { describe, expect, it } from "vitest";
import { hitTestCanvas, type HitTestBasin } from "./hitTest";
import type { Scene, SceneHub, SceneNode } from "./scene";

/** Build a minimal Scene from the pieces each test cares about. */
function makeScene(parts: {
  nodes?: SceneNode[];
  hubs?: SceneHub[];
}): Scene {
  return {
    nodes: parts.nodes ?? [],
    hubs: parts.hubs ?? [],
    squircles: [],
    categoryLinks: [],
    positions: {},
  };
}

function node(pageId: string, x: number, y: number): SceneNode {
  return { pageId, title: pageId, x, y };
}

function hub(relationshipId: string, center: { x: number; y: number }, endpoints: { x: number; y: number }[]): SceneHub {
  return {
    relationshipId,
    label: relationshipId,
    d: "",
    kind: endpoints.length >= 3 ? "star" : "lens",
    endpointCount: endpoints.length,
    center,
    endpoints,
    blendColor: "#000",
  };
}

const basinA: HitTestBasin = { categoryId: "A", basin: { x: -40, y: 0, rx: 100, ry: 100 } };
const basinB: HitTestBasin = { categoryId: "B", basin: { x: 40, y: 0, rx: 100, ry: 100 } };
const basinC: HitTestBasin = { categoryId: "C", basin: { x: 0, y: 40, rx: 100, ry: 100 } };

describe("hitTestCanvas — P1 Observation Node", () => {
  it("returns the nearest node within the pick radius", () => {
    const scene = makeScene({ nodes: [node("n1", 0, 0), node("n2", 30, 0)] });
    const r = hitTestCanvas(scene, { x: 5, y: 0 }, { pickRadius: 24 });
    expect(r.kind).toBe("node");
    if (r.kind === "node") expect(r.pageId).toBe("n1");
  });

  it("node wins over a hub even when both are within the pick radius", () => {
    const scene = makeScene({
      nodes: [node("n1", 0, 0)],
      hubs: [hub("r1", { x: 6, y: 0 }, [{ x: -50, y: 0 }, { x: 50, y: 0 }])],
    });
    const r = hitTestCanvas(scene, { x: 3, y: 0 }, { pickRadius: 24 });
    expect(r.kind).toBe("node");
  });

  it("misses a node beyond the pick radius", () => {
    const scene = makeScene({ nodes: [node("n1", 0, 0)] });
    const r = hitTestCanvas(scene, { x: 40, y: 0 }, { pickRadius: 24 });
    expect(r.kind).toBe("none");
  });
});

describe("hitTestCanvas — P2 Node-to-Node Hub / connector line", () => {
  it("hits the hub centre within the pick radius", () => {
    const scene = makeScene({
      hubs: [hub("r1", { x: 0, y: 0 }, [{ x: -200, y: -200 }, { x: 200, y: 200 }])],
    });
    const r = hitTestCanvas(scene, { x: 8, y: -8 }, { pickRadius: 24 });
    // The click is 8px off-centre perpendicular-ish but the centre is <24px.
    expect(r.kind).toBe("hub");
    if (r.kind === "hub") expect(r.relationshipId).toBe("r1");
  });

  it("hits anywhere ALONG the connector line, not only the centre", () => {
    // A horizontal line from (-100,0) to (100,0); the centre is (0,0). A click
    // near (80, 5) is far from the centre but close to the line segment.
    const scene = makeScene({
      hubs: [hub("r1", { x: 0, y: 0 }, [{ x: -100, y: 0 }, { x: 100, y: 0 }])],
    });
    const r = hitTestCanvas(scene, { x: 80, y: 5 }, { pickRadius: 24 });
    expect(r.kind).toBe("hub");
  });

  it("returns the nearest hub when two are in range", () => {
    const scene = makeScene({
      hubs: [
        hub("r1", { x: 0, y: 0 }, [{ x: -10, y: 0 }, { x: 10, y: 0 }]),
        hub("r2", { x: 15, y: 0 }, [{ x: 5, y: 0 }, { x: 25, y: 0 }]),
      ],
    });
    const r = hitTestCanvas(scene, { x: 2, y: 0 }, { pickRadius: 24 });
    expect(r.kind).toBe("hub");
    if (r.kind === "hub") expect(r.relationshipId).toBe("r1");
  });
});

describe("hitTestCanvas — P3 overlap / P4 single basin", () => {
  const basins = [basinA, basinB, basinC];

  it("P4: >pickRadius from any node/hub, inside exactly 1 basin", () => {
    const scene = makeScene({});
    const r = hitTestCanvas(scene, { x: -130, y: 0 }, { basins, pickRadius: 24 });
    expect(r.kind).toBe("basin");
    if (r.kind === "basin") expect(r.subjectId).toBe("A");
  });

  it("P3: inside >=2 basins returns the sorted containing subject ids", () => {
    const scene = makeScene({});
    const r = hitTestCanvas(scene, { x: 0, y: 20 }, { basins, pickRadius: 24 });
    expect(r.kind).toBe("overlap");
    if (r.kind === "overlap") expect([...r.subjectIds]).toEqual(["A", "B", "C"]);
  });

  it("a node within range still OUTranks an overlapping basin zone (strict priority)", () => {
    // A node sits at the overlap point: P1 wins even though the point is inside
    // 3 basins (the >pickRadius precondition for P3/P4 is not met).
    const scene = makeScene({ nodes: [node("n1", 0, 20)] });
    const r = hitTestCanvas(scene, { x: 0, y: 20 }, { basins, pickRadius: 24 });
    expect(r.kind).toBe("node");
  });

  it("a miss outside every basin and far from nodes/hubs", () => {
    const scene = makeScene({});
    const r = hitTestCanvas(scene, { x: 1000, y: 1000 }, { basins, pickRadius: 24 });
    expect(r.kind).toBe("none");
  });
});
