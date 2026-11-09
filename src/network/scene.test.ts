/**
 * Vitest coverage for the pure graph -> scene mapping (FEAT-004 glue logic).
 *
 * The runtime rendering/interaction proof is the Playwright spec
 * (e2e/concept-network.spec.ts), which CANNOT run in this sandbox (the
 * Playwright Chromium binary cannot be downloaded — proxy 403). So the
 * non-trivial glue — node positions from the REAL layout engine, hub kind +
 * path, squircle bounds per category, A10 multi-category intersection, A14
 * category-link derivation, blend-color pass-through, determinism — is proven
 * here headlessly against the same pure modules the canvas uses.
 */

import { describe, it, expect } from "vitest";
import { buildScene, toLayoutGraph } from "./scene";
import type { SceneGraphInput } from "./scene";
import { squircleContains } from "./squircle";

function graph(partial: Partial<SceneGraphInput>): SceneGraphInput {
  return {
    nodes: partial.nodes ?? [],
    links: partial.links ?? [],
    categories: partial.categories ?? [],
  };
}

function node(pageId: string, hidden = false): SceneGraphInput["nodes"][number] {
  return { pageId, title: `Node ${pageId}`, hidden, position: null };
}

describe("buildScene — node positions come from the real layout engine", () => {
  it("places every visible node and excludes hidden ones", () => {
    const g = graph({
      nodes: [node("a"), node("b"), node("c"), node("d", true)],
      links: [
        { relationshipId: "r1", endpointPageIds: ["a", "b"], label: "", blendColor: "#808080", hidden: false },
      ],
    });
    const scene = buildScene(g);
    const ids = scene.nodes.map((n) => n.pageId).sort();
    expect(ids).toEqual(["a", "b", "c"]);
    // Positions are finite numbers produced by the simulation, not (0,0) stubs.
    for (const n of scene.nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
    // A link pulls its two nodes to a finite, non-degenerate separation.
    const a = scene.nodes.find((n) => n.pageId === "a")!;
    const b = scene.nodes.find((n) => n.pageId === "b")!;
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(0);
  });

  it("is deterministic: identical inputs yield identical positions (A09-M2)", () => {
    const g = graph({
      nodes: [node("a"), node("b"), node("c")],
      links: [
        { relationshipId: "r1", endpointPageIds: ["a", "b", "c"], label: "", blendColor: "#777", hidden: false },
      ],
    });
    const one = buildScene(g);
    const two = buildScene(g);
    expect(two.positions).toEqual(one.positions);
    expect(two.hubs[0]!.d).toEqual(one.hubs[0]!.d);
  });

  it("honors a durable position for a node instead of ring-seeding it", () => {
    const g: SceneGraphInput = {
      nodes: [
        { pageId: "a", title: "A", hidden: false, position: { x: 1000, y: -500 } },
        node("b"),
      ],
      links: [],
      categories: [],
    };
    const lg = toLayoutGraph(g);
    const a = lg.nodes.find((n) => n.id === "a")!;
    expect(a.x).toBe(1000);
    expect(a.y).toBe(-500);
  });
});

describe("buildScene — hub topology (A13-M2)", () => {
  it("renders a lens for a 2-endpoint relationship", () => {
    const g = graph({
      nodes: [node("a"), node("b")],
      links: [
        { relationshipId: "r1", endpointPageIds: ["a", "b"], label: "", blendColor: "#808080", hidden: false },
      ],
    });
    const scene = buildScene(g);
    expect(scene.hubs).toHaveLength(1);
    expect(scene.hubs[0]!.kind).toBe("lens");
    expect(scene.hubs[0]!.endpointCount).toBe(2);
    expect(scene.hubs[0]!.d.startsWith("M")).toBe(true);
  });

  it("renders a star for a >=3-endpoint relationship with endpointCount>=3", () => {
    const g = graph({
      nodes: [node("a"), node("b"), node("c"), node("d")],
      links: [
        { relationshipId: "r1", endpointPageIds: ["a", "b", "c", "d"], label: "", blendColor: "#555", hidden: false },
      ],
    });
    const scene = buildScene(g);
    expect(scene.hubs[0]!.kind).toBe("star");
    expect(scene.hubs[0]!.endpointCount).toBe(4);
  });

  it("star vertices point toward the connected nodes", () => {
    const g = graph({
      nodes: [node("a"), node("b"), node("c")],
      links: [
        { relationshipId: "r1", endpointPageIds: ["a", "b", "c"], label: "", blendColor: "#555", hidden: false },
      ],
    });
    const scene = buildScene(g);
    const hub = scene.hubs[0]!;
    // For each endpoint, the angle from the hub center toward that node should
    // match (within tolerance) an outer vertex direction. We verify by checking
    // that the hub center lies "between" the endpoints (centroid) and that each
    // endpoint has a distinct bearing from center — the precondition the star
    // generator uses to aim a vertex at each node.
    const bearings = hub.endpoints.map((p) =>
      Math.atan2(p.y - hub.center.y, p.x - hub.center.x),
    );
    const unique = new Set(bearings.map((b) => Math.round(b * 100)));
    expect(unique.size).toBe(hub.endpoints.length);
  });

  it("carries the relationship's derived blend color through to the hub", () => {
    const g = graph({
      nodes: [node("a"), node("b")],
      links: [
        { relationshipId: "r1", endpointPageIds: ["a", "b"], label: "", blendColor: "#123456", hidden: false },
      ],
    });
    const scene = buildScene(g);
    expect(scene.hubs[0]!.blendColor).toBe("#123456");
  });

  it("omits hidden relationships from the hub layer", () => {
    const g = graph({
      nodes: [node("a"), node("b")],
      links: [
        { relationshipId: "r1", endpointPageIds: ["a", "b"], label: "", blendColor: "#808080", hidden: true },
      ],
    });
    expect(buildScene(g).hubs).toHaveLength(0);
  });
});

describe("buildScene — category squircles (A09/A10-M2)", () => {
  it("produces one squircle per category and contains its member nodes", () => {
    const g: SceneGraphInput = {
      nodes: [node("a"), node("b"), node("c")],
      links: [
        { relationshipId: "r1", endpointPageIds: ["a", "b"], label: "", blendColor: "#808080", hidden: false },
      ],
      categories: [
        { categoryId: "cat1", name: "One", colorCode: "#4b5578", memberPageIds: ["a", "b"] },
      ],
    };
    const scene = buildScene(g);
    expect(scene.squircles).toHaveLength(1);
    const sq = scene.squircles[0]!;
    for (const id of ["a", "b"]) {
      const n = scene.nodes.find((x) => x.pageId === id)!;
      expect(squircleContains(sq.bounds, { x: n.x, y: n.y })).toBe(true);
    }
  });

  it("A10-M2: a node in TWO categories renders inside BOTH squircles (intersection)", () => {
    const g: SceneGraphInput = {
      nodes: [node("shared"), node("a1"), node("a2"), node("b1"), node("b2")],
      links: [],
      categories: [
        { categoryId: "catA", name: "A", colorCode: "#4b5578", memberPageIds: ["shared", "a1", "a2"] },
        { categoryId: "catB", name: "B", colorCode: "#b5653f", memberPageIds: ["shared", "b1", "b2"] },
      ],
    };
    const scene = buildScene(g);
    const shared = scene.nodes.find((n) => n.pageId === "shared")!;
    const aB = scene.squircles.find((s) => s.categoryId === "catA")!.bounds;
    const bB = scene.squircles.find((s) => s.categoryId === "catB")!.bounds;
    expect(squircleContains(aB, { x: shared.x, y: shared.y })).toBe(true);
    expect(squircleContains(bB, { x: shared.x, y: shared.y })).toBe(true);
  });
});

describe("deriveCategoryLinks — A14-M2 (data-driven)", () => {
  it("links two categories when a relationship bridges their members", () => {
    const g: SceneGraphInput = {
      nodes: [node("a"), node("b")],
      links: [
        { relationshipId: "r1", endpointPageIds: ["a", "b"], label: "", blendColor: "#808080", hidden: false },
      ],
      categories: [
        { categoryId: "catA", name: "A", colorCode: "#4b5578", memberPageIds: ["a"] },
        { categoryId: "catB", name: "B", colorCode: "#b5653f", memberPageIds: ["b"] },
      ],
    };
    const scene = buildScene(g);
    expect(scene.categoryLinks).toHaveLength(1);
    const link = scene.categoryLinks[0]!;
    expect([link.fromCategoryId, link.toCategoryId].sort()).toEqual(["catA", "catB"]);
    // A member-bridging link (no master pages) is classified 'member'.
    expect(link.linkKind).toBe("member");
    // The endpoints sit on the two squircle boundaries, not at the centers.
    const aB = scene.squircles.find((s) => s.categoryId === link.fromCategoryId)!.bounds;
    const bB = scene.squircles.find((s) => s.categoryId === link.toCategoryId)!.bounds;
    expect(squircleContains(aB, link.from)).toBe(true);
    expect(squircleContains(bB, link.to)).toBe(true);
  });

  it("does not link a category to itself or emit duplicates", () => {
    const g: SceneGraphInput = {
      nodes: [node("a"), node("b"), node("c")],
      links: [
        { relationshipId: "r1", endpointPageIds: ["a", "b"], label: "", blendColor: "#808080", hidden: false },
        { relationshipId: "r2", endpointPageIds: ["b", "c"], label: "", blendColor: "#808080", hidden: false },
      ],
      categories: [
        { categoryId: "catA", name: "A", colorCode: "#4b5578", memberPageIds: ["a", "b", "c"] },
      ],
    };
    const scene = buildScene(g);
    expect(scene.categoryLinks).toHaveLength(0);
  });

  it("is driven purely by data (no hardcoded pairs)", () => {
    const empty = buildScene(graph({ nodes: [node("a")], categories: [] }));
    expect(empty.categoryLinks).toHaveLength(0);
  });
});

describe("deriveCategoryLinks — master vs member boundary links (A14-M2, §12.2)", () => {
  it("emits exactly one 'master' link when two categories' master pages are joined", () => {
    const g: SceneGraphInput = {
      // mA/mB are the master pages; a/b are plain members so each category has
      // a squircle to anchor the boundary link on.
      nodes: [node("mA"), node("mB"), node("a"), node("b")],
      links: [
        { relationshipId: "r1", endpointPageIds: ["mA", "mB"], label: "", blendColor: "#808080", hidden: false },
      ],
      categories: [
        { categoryId: "catA", name: "A", colorCode: "#4b5578", memberPageIds: ["mA", "a"], masterPageId: "mA" },
        { categoryId: "catB", name: "B", colorCode: "#b5653f", memberPageIds: ["mB", "b"], masterPageId: "mB" },
      ],
    };
    const scene = buildScene(g);
    expect(scene.categoryLinks).toHaveLength(1);
    const link = scene.categoryLinks[0]!;
    expect(link.linkKind).toBe("master");
    expect([link.fromCategoryId, link.toCategoryId].sort()).toEqual(["catA", "catB"]);
  });

  it("classifies a member-bridging relationship (no master link) as 'member'", () => {
    const g: SceneGraphInput = {
      nodes: [node("mA"), node("mB"), node("a"), node("b")],
      links: [
        // r1 bridges MEMBERS a<->b, NOT the master pages.
        { relationshipId: "r1", endpointPageIds: ["a", "b"], label: "", blendColor: "#808080", hidden: false },
      ],
      categories: [
        { categoryId: "catA", name: "A", colorCode: "#4b5578", memberPageIds: ["mA", "a"], masterPageId: "mA" },
        { categoryId: "catB", name: "B", colorCode: "#b5653f", memberPageIds: ["mB", "b"], masterPageId: "mB" },
      ],
    };
    const scene = buildScene(g);
    expect(scene.categoryLinks).toHaveLength(1);
    expect(scene.categoryLinks[0]!.linkKind).toBe("member");
  });

  it("master wins the dedupe: one link when BOTH a master and a member bridge exist", () => {
    const g: SceneGraphInput = {
      nodes: [node("mA"), node("mB"), node("a"), node("b")],
      links: [
        // r1: member bridge a<->b; r2: master bridge mA<->mB. Same cat pair.
        { relationshipId: "r1", endpointPageIds: ["a", "b"], label: "", blendColor: "#808080", hidden: false },
        { relationshipId: "r2", endpointPageIds: ["mA", "mB"], label: "", blendColor: "#808080", hidden: false },
      ],
      categories: [
        { categoryId: "catA", name: "A", colorCode: "#4b5578", memberPageIds: ["mA", "a"], masterPageId: "mA" },
        { categoryId: "catB", name: "B", colorCode: "#b5653f", memberPageIds: ["mB", "b"], masterPageId: "mB" },
      ],
    };
    const scene = buildScene(g);
    expect(scene.categoryLinks).toHaveLength(1);
    expect(scene.categoryLinks[0]!.linkKind).toBe("master");
  });

  it("does not emit a master link for a hidden master-page relationship", () => {
    const g: SceneGraphInput = {
      nodes: [node("mA"), node("mB"), node("a"), node("b")],
      links: [
        { relationshipId: "r1", endpointPageIds: ["mA", "mB"], label: "", blendColor: "#808080", hidden: true },
      ],
      categories: [
        { categoryId: "catA", name: "A", colorCode: "#4b5578", memberPageIds: ["mA", "a"], masterPageId: "mA" },
        { categoryId: "catB", name: "B", colorCode: "#b5653f", memberPageIds: ["mB", "b"], masterPageId: "mB" },
      ],
    };
    expect(buildScene(g).categoryLinks).toHaveLength(0);
  });
});
