import { describe, expect, it } from "vitest";
import { hubPath, endpointAngles, type Point } from "./index";

/**
 * Pure-geometry coverage for the hub glyph generator (A13-M2):
 * N === 2 => lens; N >= 3 => concave arched star with outward vertices each
 * pointing toward its endpoint.
 */

/** Parse the numeric coordinate pairs out of an SVG path `d` string. */
function parsePoints(d: string): Point[] {
  const nums = d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
  const pts: Point[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    pts.push({ x: nums[i]!, y: nums[i + 1]! });
  }
  return pts;
}

function angleDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
}

describe("hubPath — N === 2 lens", () => {
  const center: Point = { x: 0, y: 0 };
  const endpoints: readonly Point[] = [
    { x: -50, y: 0 },
    { x: 50, y: 0 },
  ];

  it("returns kind 'lens' and a valid closed path", () => {
    const { d, kind } = hubPath({ center, endpoints });
    expect(kind).toBe("lens");
    expect(d.startsWith("M")).toBe(true);
    expect(d.trim().endsWith("Z")).toBe(true);
    // Two cubic arcs form the spindle.
    expect((d.match(/C/g) ?? []).length).toBe(2);
  });

  it("has two points aimed along the node-to-node vector (horizontal here)", () => {
    const { d } = hubPath({ center, endpoints });
    const pts = parsePoints(d);
    // The first on-path command is the start tip; the second cubic endpoint is
    // the far tip. Both tips lie on the horizontal axis through center.
    const tip1 = pts[0]!;
    expect(Math.abs(tip1.y)).toBeLessThan(1e-6);
    // The extreme x values are the two tips at +/- half-length along the axis.
    const xs = pts.map((p) => p.x);
    expect(Math.min(...xs)).toBeCloseTo(-50, 3);
    expect(Math.max(...xs)).toBeCloseTo(50, 3);
  });

  it("aims the lens along a diagonal node vector", () => {
    const diag: readonly Point[] = [
      { x: -30, y: -30 },
      { x: 30, y: 30 },
    ];
    const { d, kind } = hubPath({ center, endpoints: diag });
    expect(kind).toBe("lens");
    const pts = parsePoints(d);
    const tip1 = pts[0]!;
    // Tip lies on the y = x diagonal (aimed along the node vector).
    expect(tip1.x).toBeCloseTo(tip1.y, 3);
  });
});

describe("hubPath — N >= 3 concave arched star", () => {
  function starEndpoints(n: number, radius: number): Point[] {
    const pts: Point[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      pts.push({ x: Math.cos(a) * radius, y: Math.sin(a) * radius });
    }
    return pts;
  }

  it("returns kind 'star' for N=3 and N=5", () => {
    const center: Point = { x: 0, y: 0 };
    expect(hubPath({ center, endpoints: starEndpoints(3, 100) }).kind).toBe("star");
    expect(hubPath({ center, endpoints: starEndpoints(5, 100) }).kind).toBe("star");
  });

  it("has exactly N outer points, each pointing toward its endpoint (angle ~ atan2)", () => {
    const center: Point = { x: 0, y: 0 };
    const n = 5;
    const endpoints = starEndpoints(n, 120);
    const { d } = hubPath({ center, endpoints });
    const pts = parsePoints(d);

    // Expected endpoint angles.
    const expectedAngles = endpointAngles(center, endpoints);

    // For each endpoint, there must be a path vertex whose angle from center
    // matches its atan2 direction within tolerance, and whose radius ~ outer.
    const outer = 120;
    for (const expected of expectedAngles) {
      const match = pts.find((p) => {
        const r = Math.hypot(p.x, p.y);
        const a = Math.atan2(p.y, p.x);
        return Math.abs(r - outer) < 1 && angleDiff(a, expected) < 0.05;
      });
      expect(match, `no outer vertex pointing at angle ${expected}`).toBeTruthy();
    }
  });

  it("has concave inner control points (inner radius < outer radius)", () => {
    const center: Point = { x: 0, y: 0 };
    const outer = 120;
    const { d } = hubPath({ center, endpoints: starEndpoints(4, outer) });
    const pts = parsePoints(d);
    const radii = pts.map((p) => Math.hypot(p.x, p.y));
    const minR = Math.min(...radii);
    const maxR = Math.max(...radii);
    // There exist inner control points pulled toward center (concave notch).
    expect(minR).toBeLessThan(maxR);
    expect(minR).toBeLessThan(outer * 0.7);
    // Outer vertices reach out toward the nodes.
    expect(maxR).toBeCloseTo(outer, 0);
  });

  it("points at unevenly placed endpoints (angles from real atan2, not a regular polygon)", () => {
    const center: Point = { x: 10, y: -5 };
    const endpoints: Point[] = [
      { x: 110, y: -5 }, // due east
      { x: 10, y: 95 }, // due north (screen down is +y, still atan2-driven)
      { x: -80, y: -5 }, // due west
    ];
    const { d, kind } = hubPath({ center, endpoints });
    expect(kind).toBe("star");
    const pts = parsePoints(d);
    const expectedAngles = endpointAngles(center, endpoints);
    for (const expected of expectedAngles) {
      const match = pts.find((p) => {
        const a = Math.atan2(p.y - center.y, p.x - center.x);
        return angleDiff(a, expected) < 0.05;
      });
      expect(match, `no vertex aimed at ${expected}`).toBeTruthy();
    }
  });
});
