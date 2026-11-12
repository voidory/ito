/**
 * Pure superellipse ("squircle") geometry for category boundaries (A09-M2:
 * "nodes float stably inside category boundaries").
 *
 * PURE: a function of input geometry only. No DOM, no React, no Three.js.
 *
 * A superellipse is the locus |x/rx|^n + |y/ry|^n = 1. For n === 2 it is an
 * ellipse; as n grows it approaches a rectangle. The default exponent ~4 gives
 * the rounded-rectangle "squircle" look.
 */

/** A 2D point. */
export interface SquirclePoint {
  readonly x: number;
  readonly y: number;
}

/** A squircle boundary: center + semi-axes. */
export interface SquircleBounds {
  readonly cx: number;
  readonly cy: number;
  readonly rx: number;
  readonly ry: number;
}

/** Input for squirclePath. `n` defaults to 4 and `samples` to 64. */
export interface SquirclePathInput {
  readonly cx: number;
  readonly cy: number;
  readonly rx: number;
  readonly ry: number;
  readonly n?: number;
  readonly samples?: number;
}

/** Default superellipse exponent — the "squircle" rounded-rectangle look. */
export const DEFAULT_SQUIRCLE_EXPONENT = 4;

function fmt(v: number): string {
  return (Math.round(v * 1000) / 1000).toString();
}

/** Signed-power helper: preserves sign while raising |t| to an exponent. */
function signedPow(t: number, exp: number): number {
  return Math.sign(t) * Math.pow(Math.abs(t), exp);
}

/**
 * Point on a superellipse boundary at parameter angle `theta`. Uses the
 * standard parametric form with the 2/n exponent so the returned point always
 * satisfies the implicit equation.
 */
export function squirclePoint(
  bounds: SquircleBounds,
  theta: number,
  n: number = DEFAULT_SQUIRCLE_EXPONENT,
): SquirclePoint {
  const ct = Math.cos(theta);
  const st = Math.sin(theta);
  const x = bounds.cx + bounds.rx * signedPow(ct, 2 / n);
  const y = bounds.cy + bounds.ry * signedPow(st, 2 / n);
  return { x, y };
}

/**
 * Produce a CLOSED SVG path approximating the superellipse boundary by sampling
 * `samples` points and joining them with line segments (ending in `Z`).
 */
export function squirclePath(input: SquirclePathInput): string {
  const n = input.n ?? DEFAULT_SQUIRCLE_EXPONENT;
  const samples = input.samples ?? 64;
  const bounds: SquircleBounds = {
    cx: input.cx,
    cy: input.cy,
    rx: input.rx,
    ry: input.ry,
  };
  let d = "";
  for (let i = 0; i < samples; i++) {
    const theta = (i / samples) * Math.PI * 2;
    const p = squirclePoint(bounds, theta, n);
    d += `${i === 0 ? "M" : "L"} ${fmt(p.x)} ${fmt(p.y)} `;
  }
  d += "Z";
  return d;
}

/**
 * Compute a squircle boundary enclosing a set of member points with uniform
 * padding. The center is the midpoint of the point extents; the semi-axes span
 * the half-extent plus padding. An empty set yields a padded zero-size box.
 */
export function squircleBounds(
  points: readonly SquirclePoint[],
  padding = 0,
): SquircleBounds {
  if (points.length === 0) {
    return { cx: 0, cy: 0, rx: padding, ry: padding };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const rx = (maxX - minX) / 2 + padding;
  const ry = (maxY - minY) / 2 + padding;
  return { cx, cy, rx, ry };
}

/**
 * True iff `point` lies inside (or on) the squircle boundary, evaluated against
 * the implicit superellipse equation |dx/rx|^n + |dy/ry|^n <= 1. Degenerate
 * zero semi-axes only contain the exact center.
 */
export function squircleContains(
  bounds: SquircleBounds,
  point: SquirclePoint,
  n: number = DEFAULT_SQUIRCLE_EXPONENT,
): boolean {
  if (bounds.rx <= 0 || bounds.ry <= 0) {
    return point.x === bounds.cx && point.y === bounds.cy;
  }
  const dx = Math.abs(point.x - bounds.cx) / bounds.rx;
  const dy = Math.abs(point.y - bounds.cy) / bounds.ry;
  return Math.pow(dx, n) + Math.pow(dy, n) <= 1 + 1e-9;
}
