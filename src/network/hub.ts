/**
 * Procedural SVG path generator for "The Bump" hub glyph (§3.1).
 *
 * PURE: a function of input geometry only. No DOM, no React, no Three.js.
 *
 * - N === 2: a smooth double-pointed translucent lens / spindle centered on the
 *   midpoint of the two endpoints, with its two points aimed along the vector
 *   between the nodes. Built from two cubic Bezier arcs.
 * - N >= 3: a multi-pointed arched STAR. One OUTER vertex per endpoint, each
 *   pointing directly TOWARD its node (angle = atan2 toward that node). The
 *   boundary between consecutive outer points dips to an INNER control point
 *   pulled toward the center, so the web arches CONCAVE inward like a stellar
 *   nucleus (inner radius < outer radius). (Acceptance A13-M2.)
 */

/** A 2D point. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Input geometry for a hub glyph. */
export interface HubInput {
  /** The hub center (typically the centroid of the endpoints). */
  readonly center: Point;
  /** The 2D positions of the N connected nodes. */
  readonly endpoints: readonly Point[];
}

/** Result of hubPath: the SVG `d` string and which glyph kind was produced. */
export interface HubPath {
  readonly d: string;
  readonly kind: "lens" | "star";
}

function fmt(n: number): string {
  // Round to a stable precision so output is deterministic and compact.
  return (Math.round(n * 1000) / 1000).toString();
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Build a smooth double-pointed lens for exactly two endpoints. The lens long
 * axis runs along the node-to-node vector; its two sharp points sit at the
 * endpoints' projection and it bulges symmetrically on the perpendicular axis.
 */
function lensPath(center: Point, a: Point, b: Point): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  // Unit axis (point-to-point) and its perpendicular.
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;

  const half = len / 2;
  // Bulge (lens width) scales with length; keeps a pleasant spindle aspect.
  const bulge = Math.max(half * 0.5, 1);

  // Two tips along the axis.
  const tip1: Point = { x: center.x - ux * half, y: center.y - uy * half };
  const tip2: Point = { x: center.x + ux * half, y: center.y + uy * half };
  // Control points bow outward on the perpendicular at the quarter marks.
  const c = half * 0.55;
  const cp1a: Point = { x: tip1.x + ux * c + px * bulge, y: tip1.y + uy * c + py * bulge };
  const cp1b: Point = { x: tip2.x - ux * c + px * bulge, y: tip2.y - uy * c + py * bulge };
  const cp2a: Point = { x: tip2.x - ux * c - px * bulge, y: tip2.y - uy * c - py * bulge };
  const cp2b: Point = { x: tip1.x + ux * c - px * bulge, y: tip1.y + uy * c - py * bulge };

  return (
    `M ${fmt(tip1.x)} ${fmt(tip1.y)} ` +
    `C ${fmt(cp1a.x)} ${fmt(cp1a.y)} ${fmt(cp1b.x)} ${fmt(cp1b.y)} ${fmt(tip2.x)} ${fmt(tip2.y)} ` +
    `C ${fmt(cp2a.x)} ${fmt(cp2a.y)} ${fmt(cp2b.x)} ${fmt(cp2b.y)} ${fmt(tip1.x)} ${fmt(tip1.y)} ` +
    `Z`
  );
}

/** The angle (radians) from center toward each endpoint. */
export function endpointAngles(center: Point, endpoints: readonly Point[]): number[] {
  return endpoints.map((p) => Math.atan2(p.y - center.y, p.x - center.x));
}

/**
 * Build a concave arched star: each endpoint gets an OUTER vertex pointing
 * toward it; between consecutive outer vertices (sorted by angle) sits an INNER
 * control point pulled toward center, producing concave arcs. The outer radius
 * is the distance to the nearest endpoint (so points reach toward the real
 * nodes); the inner radius is a fraction of that, guaranteeing inner < outer.
 */
function starPath(center: Point, endpoints: readonly Point[]): string {
  // Sort endpoints by angle so the ring is traversed consistently.
  const withAngle = endpoints
    .map((p) => ({ p, a: Math.atan2(p.y - center.y, p.x - center.x) }))
    .sort((l, r) => l.a - r.a);

  // Outer radius: reach toward the endpoints (use the max so all points touch
  // out toward their nodes; distances may differ so each point lands on its
  // own node direction at this radius).
  const radii = endpoints.map((p) => dist(center, p));
  const outer = Math.max(...radii, 1);
  const innerRatio = 0.45; // concave notch: inner boundary pulled inward.
  const inner = outer * innerRatio;

  const count = withAngle.length;
  const outerPts: Point[] = withAngle.map(({ a }) => ({
    x: center.x + Math.cos(a) * outer,
    y: center.y + Math.sin(a) * outer,
  }));
  // Inner points sit on the angular bisector between consecutive outer points.
  const innerPts: Point[] = [];
  for (let i = 0; i < count; i++) {
    const a1 = withAngle[i]!.a;
    let a2 = withAngle[(i + 1) % count]!.a;
    if (a2 < a1) a2 += Math.PI * 2;
    const mid = (a1 + a2) / 2;
    innerPts.push({
      x: center.x + Math.cos(mid) * inner,
      y: center.y + Math.sin(mid) * inner,
    });
  }

  // Walk outer -> inner -> outer, using the inner point as a quadratic control
  // so the boundary curves CONCAVE toward center between points.
  let d = `M ${fmt(outerPts[0]!.x)} ${fmt(outerPts[0]!.y)} `;
  for (let i = 0; i < count; i++) {
    const ctrl = innerPts[i]!;
    const nextOuter = outerPts[(i + 1) % count]!;
    d += `Q ${fmt(ctrl.x)} ${fmt(ctrl.y)} ${fmt(nextOuter.x)} ${fmt(nextOuter.y)} `;
  }
  d += "Z";
  return d;
}

/**
 * Generate the hub glyph path for the given geometry. Returns the SVG `d`
 * string and the glyph kind: "lens" for N === 2, "star" for N >= 3.
 *
 * Fewer than 2 endpoints is degenerate; we emit a tiny closed lens at center so
 * callers always receive a valid path.
 */
export function hubPath(input: HubInput): HubPath {
  const { center, endpoints } = input;
  if (endpoints.length === 2) {
    return { d: lensPath(center, endpoints[0]!, endpoints[1]!), kind: "lens" };
  }
  if (endpoints.length >= 3) {
    return { d: starPath(center, endpoints), kind: "star" };
  }
  // Degenerate (0 or 1 endpoint): small symmetric lens so the path is valid.
  const a: Point = { x: center.x - 1, y: center.y };
  const b: Point = { x: center.x + 1, y: center.y };
  return { d: lensPath(center, a, b), kind: "lens" };
}
