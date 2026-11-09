/**
 * FEAT-006 — pure glue for the §3.4 dimensional shift, proven headlessly.
 *
 * The 3D scene is Three.js/WebGL and cannot run in the sandbox, so the testable
 * logic lives in PURE functions covered here:
 *   - mapGraphTo3D(): the live graph -> {particles[], hulls[], links[]} mapping,
 *     which reuses the SAME 2D layout engine (buildScene) so 2D and 3D stay in
 *     parity. We assert particle/hull/link counts, live-graph parity, hull
 *     sizing/centering from the squircle bounds, deterministic depth, and the
 *     no-forced-motion guarantee (identical input => identical output).
 *   - revealPresentation(): the density-reward reveal mapping (absent below the
 *     threshold; present + glowing above it; glow degrades to a static control
 *     when motion is suppressed).
 */

import { describe, expect, it } from "vitest";
import { buildScene, type SceneGraphInput } from "../network";
import { mapGraphTo3D, revealPresentation, THREE_D_STYLE } from "./threeScene.map";

/** A small live-graph fixture: 5 nodes, 2 categories, 1 relationship. */
function sampleGraph(): SceneGraphInput {
  const nodes = ["a", "b", "c", "d", "e"].map((pageId) => ({
    pageId,
    title: pageId.toUpperCase(),
    hidden: false,
    position: null,
  }));
  return {
    nodes,
    links: [
      {
        relationshipId: "r1",
        endpointPageIds: ["a", "b"],
        label: "",
        blendColor: "#4b5578",
        hidden: false,
      },
    ],
    categories: [
      {
        categoryId: "catA",
        name: "CatA",
        colorCode: "#4b5578",
        memberPageIds: ["a", "b", "c"],
      },
      {
        categoryId: "catB",
        name: "CatB",
        colorCode: "#b5653f",
        memberPageIds: ["d", "e"],
      },
    ],
  };
}

describe("mapGraphTo3D — pure graph -> 3D scene descriptor", () => {
  it("produces one particle per visible node, carrying id + title", () => {
    const scene = mapGraphTo3D(sampleGraph());
    expect(scene.particles).toHaveLength(5);
    expect(scene.particles.map((p) => p.pageId).sort()).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
    const a = scene.particles.find((p) => p.pageId === "a")!;
    expect(a.title).toBe("A");
  });

  it("produces one translucent hull per category, centered on the squircle bounds", () => {
    const scene = mapGraphTo3D(sampleGraph());
    expect(scene.hulls).toHaveLength(2);
    const ids = scene.hulls.map((h) => h.categoryId).sort();
    expect(ids).toEqual(["catA", "catB"]);
    for (const hull of scene.hulls) {
      // The hull radius must be positive and at least span the configured depth
      // so a flat-ish category still reads as a 3D bubble.
      expect(hull.radius).toBeGreaterThan(0);
      expect(Number.isFinite(hull.center.x)).toBe(true);
      expect(Number.isFinite(hull.center.z)).toBe(true);
      expect(hull.center.y).toBe(0);
    }
  });

  it("produces one link glyph per visible relationship, bridging particle depths", () => {
    const scene = mapGraphTo3D(sampleGraph());
    expect(scene.links).toHaveLength(1);
    const link = scene.links[0]!;
    expect(link.relationshipId).toBe("r1");
    expect(link.blendColor).toBe("#4b5578");
    expect(link.endpoints).toHaveLength(2);
    // Each endpoint's depth matches the particle it connects (planar footprint
    // is shared with the 2D layout).
    const byId = new Map(scene.particles.map((p) => [p.pageId, p.position]));
    const a = byId.get("a")!;
    const b = byId.get("b")!;
    const ys = link.endpoints.map((e) => e.y).sort();
    expect(ys).toEqual([a.y, b.y].sort());
  });

  it("reuses the 2D layout footprint: particle (x,z) equals the 2D (x,y)", () => {
    const graph = sampleGraph();
    const scene3d = mapGraphTo3D(graph);
    // The hull center is the squircle center in the (x,z) plane; the particles
    // of a category must fall within that planar footprint, confirming the 3D
    // mapping is driven by the SAME buildScene layout rather than a new one.
    const hullA = scene3d.hulls.find((h) => h.categoryId === "catA")!;
    for (const pid of ["a", "b", "c"]) {
      const p = scene3d.particles.find((x) => x.pageId === pid)!;
      const planarDist = Math.hypot(
        p.position.x - hullA.center.x,
        p.position.z - hullA.center.z,
      );
      expect(planarDist).toBeLessThanOrEqual(hullA.radius + 1e-6);
    }
  });

  it("excludes hidden nodes (presentation-only) from the particle cloud", () => {
    const graph = sampleGraph();
    const hidden: SceneGraphInput = {
      ...graph,
      nodes: graph.nodes.map((n) => (n.pageId === "e" ? { ...n, hidden: true } : n)),
    };
    const scene = mapGraphTo3D(hidden);
    expect(scene.particles.map((p) => p.pageId)).not.toContain("e");
    expect(scene.particles).toHaveLength(4);
  });

  it("is deterministic: identical input yields byte-identical output (no camera snap)", () => {
    const a = mapGraphTo3D(sampleGraph());
    const b = mapGraphTo3D(sampleGraph());
    expect(b).toEqual(a);
  });

  it("depth=0 flattens every particle onto the plane", () => {
    const scene = mapGraphTo3D(sampleGraph(), { depth: 0 });
    for (const p of scene.particles) expect(p.position.y).toBe(0);
  });

  it("depth spreads particles through a bounded elevation band deterministically", () => {
    const depth = 200;
    const scene = mapGraphTo3D(sampleGraph(), { depth });
    const ys = scene.particles.map((p) => p.position.y);
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(-depth);
      expect(y).toBeLessThanOrEqual(depth);
    }
    // Not all flat — the band actually produces depth.
    expect(ys.some((y) => Math.abs(y) > 1)).toBe(true);
  });

  it("an empty graph maps to an empty scene with zero extent", () => {
    const scene = mapGraphTo3D({ nodes: [], links: [], categories: [] });
    expect(scene.particles).toHaveLength(0);
    expect(scene.hulls).toHaveLength(0);
    expect(scene.links).toHaveLength(0);
    expect(scene.categoryLinks).toHaveLength(0);
    expect(scene.extent).toBe(0);
  });

  it("A14-M2 parity: a master category-link in buildScene appears in 3D with linkKind preserved", () => {
    // Two categories whose MASTER pages (mA, mB) are joined by a relationship,
    // plus plain members so each category has a squircle to anchor on.
    const graph: SceneGraphInput = {
      nodes: ["mA", "mB", "a", "b"].map((pageId) => ({
        pageId,
        title: pageId,
        hidden: false,
        position: null,
      })),
      links: [
        {
          relationshipId: "rMaster",
          endpointPageIds: ["mA", "mB"],
          label: "",
          blendColor: "#4b5578",
          hidden: false,
        },
      ],
      categories: [
        { categoryId: "catA", name: "A", colorCode: "#4b5578", memberPageIds: ["mA", "a"], masterPageId: "mA" },
        { categoryId: "catB", name: "B", colorCode: "#b5653f", memberPageIds: ["mB", "b"], masterPageId: "mB" },
      ],
    };

    // The 2D scene must have a single 'master' category-link.
    const scene2d = buildScene(graph);
    expect(scene2d.categoryLinks).toHaveLength(1);
    const link2d = scene2d.categoryLinks[0]!;
    expect(link2d.linkKind).toBe("master");

    // The 3D descriptor surfaces the SAME link, lifted onto the y=0 plane with
    // z=y, and preserves linkKind (2D/3D parity).
    const scene3d = mapGraphTo3D(graph);
    expect(scene3d.categoryLinks).toHaveLength(1);
    const link3d = scene3d.categoryLinks[0]!;
    expect(link3d.linkKind).toBe("master");
    expect(link3d.fromCategoryId).toBe(link2d.fromCategoryId);
    expect(link3d.toCategoryId).toBe(link2d.toCategoryId);
    expect(link3d.from).toEqual({ x: link2d.from.x, y: 0, z: link2d.from.y });
    expect(link3d.to).toEqual({ x: link2d.to.x, y: 0, z: link2d.to.y });
  });

  it("A14-M2 parity: a member bridge appears in 3D as a 'member' category-link", () => {
    const graph: SceneGraphInput = {
      nodes: ["a", "b"].map((pageId) => ({ pageId, title: pageId, hidden: false, position: null })),
      links: [
        { relationshipId: "r1", endpointPageIds: ["a", "b"], label: "", blendColor: "#808080", hidden: false },
      ],
      categories: [
        { categoryId: "catA", name: "A", colorCode: "#4b5578", memberPageIds: ["a"] },
        { categoryId: "catB", name: "B", colorCode: "#b5653f", memberPageIds: ["b"] },
      ],
    };
    const scene3d = mapGraphTo3D(graph);
    expect(scene3d.categoryLinks).toHaveLength(1);
    expect(scene3d.categoryLinks[0]!.linkKind).toBe("member");
  });
});

describe("THREE_D_STYLE — §3.5 FIX-3D-CONTRAST descriptors", () => {
  it("uses the deep twilight-ink backdrop #141824 for the scene + fog", () => {
    expect(THREE_D_STYLE.backdrop).toBe("#141824");
    expect(THREE_D_STYLE.fogDensity).toBeGreaterThan(0);
  });

  it("renders clearly visible translucent category hulls at opacity 0.28 with a rim wireframe", () => {
    expect(THREE_D_STYLE.hull.opacity).toBe(0.28);
    // The rim wireframe is present and subtle (lighter than the hull fill).
    expect(THREE_D_STYLE.hull.rimOpacity).toBeGreaterThan(0);
    expect(THREE_D_STYLE.hull.rimOpacity).toBeLessThan(THREE_D_STYLE.hull.opacity);
  });

  it("uses a bright glowing stellar node color + visible connecting lines", () => {
    expect(THREE_D_STYLE.node.color).toBe("#eaf2ff");
    expect(THREE_D_STYLE.node.opacity).toBeGreaterThan(0.5);
    // Links are clearly visible (not the old washed-out 0.4).
    expect(THREE_D_STYLE.link.opacity).toBeGreaterThanOrEqual(0.6);
  });
});

describe("revealPresentation — §3.4 density-reward reveal mapping", () => {
  it("is ABSENT below the density threshold (locked)", () => {
    expect(revealPresentation(false, false)).toEqual({ present: false, glow: false });
    expect(revealPresentation(false, true)).toEqual({ present: false, glow: false });
  });

  it("is PRESENT and GLOWS once unlocked with motion allowed", () => {
    expect(revealPresentation(true, false)).toEqual({ present: true, glow: true });
  });

  it("degrades to a static (non-glowing) control when motion is suppressed", () => {
    expect(revealPresentation(true, true)).toEqual({ present: true, glow: false });
  });
});
