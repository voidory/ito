/**
 * Production MVP — algorithmic regression tests.
 *
 * These are DETERMINISTIC unit tests of the bounded product feature, NOT the
 * research benchmark. Each case builds a tiny skeletal drawing from explicit
 * atom coordinates + bonds, rasterises it with the shared pure rasteriser
 * (`src/science/skeleton/raster`), and asserts the MVP recognises (or
 * explicitly rejects) it. No research corpus, no network, no RDKit.
 *
 * Coverage (the MVP acceptance criteria):
 *   1. straight carbon chain
 *   2. branched carbon chain
 *   3. simple ring
 *   4. another branched structure
 *   5. rotated input
 *   6. modest rasterisation / stroke-thickness variation
 *   7. invalid / unsupported input → explicit failure
 */

import { describe, expect, it } from "vitest";
import { rasterizeSegments, type Point, type RasterStyle } from "../../skeleton";
import { recognizeCarbonSkeleton } from "./recognizeCarbonSkeleton";

const BOND = 36;
const PAD = 24;
const COS30 = Math.cos(Math.PI / 6);
const SIN30 = Math.sin(Math.PI / 6);

interface Structure {
  readonly atoms: readonly Point[];
  readonly bonds: readonly (readonly [number, number])[];
}

/** Zig-zag open chain of `n` carbons (conventional 120° skeletal angles). */
function zigzag(n: number): Structure {
  const atoms: Point[] = [];
  const bonds: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    atoms.push({ x: i * BOND * COS30, y: i % 2 === 0 ? 0 : BOND * SIN30 });
    if (i > 0) bonds.push([i - 1, i]);
  }
  return { atoms, bonds };
}

/** Regular k-gon ring, side length = BOND. */
function ring(k: number): Structure {
  const r = BOND / (2 * Math.sin(Math.PI / k));
  const atoms: Point[] = [];
  const bonds: [number, number][] = [];
  for (let i = 0; i < k; i++) {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / k;
    atoms.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
    bonds.push([i, (i + 1) % k]);
  }
  return { atoms, bonds };
}

function rotate(s: Structure, deg: number): Structure {
  const th = (deg * Math.PI) / 180;
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  return {
    atoms: s.atoms.map((p) => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos })),
    bonds: s.bonds,
  };
}

/** Normalise coordinates into a padded image and rasterise to a GrayImage. */
function render(s: Structure, style: RasterStyle = { radius: 1.6, antialias: true }) {
  const minX = Math.min(...s.atoms.map((p) => p.x));
  const minY = Math.min(...s.atoms.map((p) => p.y));
  const shifted = s.atoms.map((p) => ({ x: p.x - minX + PAD, y: p.y - minY + PAD }));
  const w = Math.ceil(Math.max(...shifted.map((p) => p.x)) + PAD);
  const h = Math.ceil(Math.max(...shifted.map((p) => p.y)) + PAD);
  const segments = s.bonds.map(([a, b]) => ({
    from: shifted[a] as Point,
    to: shifted[b] as Point,
  }));
  return rasterizeSegments(w, h, segments, style);
}

describe("recognizeCarbonSkeleton (production MVP)", () => {
  it("1. recognises a straight carbon chain (hexane, 6 carbons)", () => {
    const result = recognizeCarbonSkeleton(render(zigzag(6)));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.skeleton.topology.carbonCount).toBe(6);
    expect(result.skeleton.topology.bondCount).toBe(5);
    expect(result.skeleton.topology.ringCount).toBe(0);
    expect(result.skeleton.topology.shape).toBe("linear-chain");
    // Exactly two chain termini.
    expect(result.skeleton.carbons.filter((c) => c.isEndpoint)).toHaveLength(2);
    expect(result.skeleton.carbons.some((c) => c.isBranch)).toBe(false);
    // The result reports the analysed image's pixel space (the coordinate
    // system the carbon x/y live in), and every carbon falls inside it.
    const img = render(zigzag(6));
    expect(result.skeleton.imageWidth).toBe(img.width);
    expect(result.skeleton.imageHeight).toBe(img.height);
    for (const c of result.skeleton.carbons) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.x).toBeLessThanOrEqual(result.skeleton.imageWidth);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeLessThanOrEqual(result.skeleton.imageHeight);
    }
  });

  it("2. recognises a branched carbon chain (isobutane: a central branch)", () => {
    // Central carbon (0) with three substituents (isobutane skeleton).
    const c = { x: 0, y: 0 };
    const structure: Structure = {
      atoms: [
        c,
        { x: -BOND * COS30, y: BOND * SIN30 },
        { x: BOND * COS30, y: BOND * SIN30 },
        { x: 0, y: -BOND },
      ],
      bonds: [
        [0, 1],
        [0, 2],
        [0, 3],
      ],
    };
    const result = recognizeCarbonSkeleton(render(structure));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.skeleton.topology.carbonCount).toBe(4);
    expect(result.skeleton.topology.bondCount).toBe(3);
    expect(result.skeleton.topology.ringCount).toBe(0);
    expect(result.skeleton.topology.shape).toBe("branched-chain");
    expect(result.skeleton.carbons.filter((c2) => c2.isBranch)).toHaveLength(1);
    expect(result.skeleton.carbons.filter((c2) => c2.isEndpoint)).toHaveLength(3);
  });

  it("3. recognises a simple ring (cyclohexane)", () => {
    const result = recognizeCarbonSkeleton(render(ring(6)));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.skeleton.topology.carbonCount).toBe(6);
    expect(result.skeleton.topology.bondCount).toBe(6);
    expect(result.skeleton.topology.ringCount).toBe(1);
    expect(result.skeleton.topology.shape).toBe("monocyclic");
    expect(result.skeleton.topology.ring).toBeDefined();
    expect(result.skeleton.topology.ring).toHaveLength(6);
    // Every carbon sits on the ring.
    expect(result.skeleton.carbons.every((c) => c.inRing)).toBe(true);
  });

  it("4. recognises another branched structure (a longer chain with a methyl branch)", () => {
    // 2-methylpentane: main chain 0-1-2-3-4 with a branch 1-5.
    const main = zigzag(5);
    const branchFrom = main.atoms[1] as Point;
    const structure: Structure = {
      atoms: [...main.atoms, { x: branchFrom.x, y: branchFrom.y - BOND }],
      bonds: [...main.bonds, [1, 5]],
    };
    const result = recognizeCarbonSkeleton(render(structure));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.skeleton.topology.carbonCount).toBe(6);
    expect(result.skeleton.topology.bondCount).toBe(5);
    expect(result.skeleton.topology.ringCount).toBe(0);
    expect(result.skeleton.topology.shape).toBe("branched-chain");
    expect(result.skeleton.carbons.filter((c) => c.isBranch)).toHaveLength(1);
    expect(result.skeleton.carbons.filter((c) => c.isEndpoint)).toHaveLength(3);
  });

  it("5. recognises a rotated input (hexane rotated 30°)", () => {
    const result = recognizeCarbonSkeleton(render(rotate(zigzag(6), 30)));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.skeleton.topology.carbonCount).toBe(6);
    expect(result.skeleton.topology.bondCount).toBe(5);
    expect(result.skeleton.topology.shape).toBe("linear-chain");
  });

  it("6. tolerates modest rasterisation / stroke-thickness variation (thick ring)", () => {
    const thick = recognizeCarbonSkeleton(
      render(ring(6), { radius: 2.4, antialias: true }),
    );
    expect(thick.success).toBe(true);
    if (!thick.success) return;
    expect(thick.skeleton.topology.carbonCount).toBe(6);
    expect(thick.skeleton.topology.ringCount).toBe(1);
    expect(thick.skeleton.topology.shape).toBe("monocyclic");

    const crisp = recognizeCarbonSkeleton(
      render(zigzag(5), { radius: 0.8, antialias: false }),
    );
    expect(crisp.success).toBe(true);
    if (!crisp.success) return;
    expect(crisp.skeleton.topology.carbonCount).toBe(5);
    expect(crisp.skeleton.topology.shape).toBe("linear-chain");
  });

  describe("7. explicit failure for invalid / unsupported input", () => {
    it("fails explicitly on a blank image", () => {
      const blank = rasterizeSegments(80, 80, []);
      const result = recognizeCarbonSkeleton(blank);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.status).toBe("unsupported");
      expect(result.reason.length).toBeGreaterThan(0);
    });

    it("fails explicitly on a zero-dimension image", () => {
      const result = recognizeCarbonSkeleton({
        width: 0,
        height: 0,
        data: new Uint8ClampedArray(0),
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.status).toBe("unsupported");
    });

    it("rejects a fused/polycyclic structure as out of scope", () => {
      // Two fused hexagons sharing an edge (decalin-like) → cycleRank 2.
      const r = BOND / (2 * Math.sin(Math.PI / 6));
      const left = ring(6).atoms;
      // Second ring sharing the rightmost edge: translate a hexagon by its width.
      const dx = 2 * r * Math.cos(Math.PI / 6);
      const right = left.map((p) => ({ x: p.x + dx, y: p.y }));
      // Build a combined structure; dedupe is handled by the engine on pixels.
      const atoms = [...left, ...right];
      const bonds: [number, number][] = [];
      for (let i = 0; i < 6; i++) bonds.push([i, (i + 1) % 6]);
      for (let i = 0; i < 6; i++) bonds.push([6 + i, 6 + ((i + 1) % 6)]);
      const result = recognizeCarbonSkeleton(render({ atoms, bonds }));
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.status).toBe("unsupported");
      expect(result.reason).toMatch(/ring|polycyclic|fused|cross|disconnected/i);
    });
  });
});
