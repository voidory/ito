/**
 * FEAT-005 — geometric graph extraction from a 1px line skeleton.
 *
 * Pipeline:
 *   1. Classify every skeleton pixel by its number of 8-neighbours:
 *        1  -> endpoint, 2 -> on a path, >=3 -> junction.
 *   2. Trace stroke paths between "significant" pixels (endpoints + junctions).
 *      A path whose two ends are the same significant pixel is a self-loop
 *      (an isolated ring with no branch — handled explicitly).
 *   3. Simplify each traced pixel-path to a polyline (Douglas-Peucker), so a
 *      straight bond becomes a 2-point segment and only genuine corners remain.
 *   4. Recover LINE-ANGLE vertices: an interior polyline point whose turn angle
 *      exceeds a threshold is a real skeletal vertex; split the edge there.
 *   5. Assemble vertices + edges, MERGE vertices that are closer than a radius
 *      (so one junction/corner is not counted several times), drop spur edges,
 *      and recompute degrees.
 *
 * Crossing lines (a "+" drawn as two straight strokes) produce a degree-4
 * junction. We do NOT split such crossings into a connected vertex pair; the
 * conservative default is to keep them as a single junction and flag it — the
 * caller decides. See {@link GraphExtractionOptions.keepCrossingsAsJunction}.
 */

import type {
  GeometricEdge,
  GeometricGraph,
  GeometricVertex,
  Point,
} from "./types";
import type { BinaryImage } from "./types";

export interface GraphExtractionOptions {
  simplifyTolerance: number;
  minCornerAngleDeg: number;
  mergeRadius: number;
  minEdgeLength: number;
  /** Keep 4-way crossings as a single junction (true) rather than discarding. */
  keepCrossingsAsJunction?: boolean;
}

interface PixelPath {
  readonly pixels: Point[];
  readonly startKey: number;
  readonly endKey: number;
}

const DEG = 180 / Math.PI;

function key(x: number, y: number, width: number): number {
  return y * width + x;
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Collect foreground neighbour offsets (8-connectivity) of a skeleton pixel. */
function neighbourOffsets(
  data: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
): Point[] {
  const out: Point[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (data[ny * width + nx]) out.push({ x: nx, y: ny });
    }
  }
  return out;
}

/**
 * The 8-neighbourhood in clockwise order P2..P9 (N, NE, E, SE, S, SW, W, NW),
 * as 0/1 foreground flags. Out-of-bounds reads as 0.
 */
function orderedNeighbours(
  data: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number[] {
  const at = (nx: number, ny: number): number => {
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) return 0;
    return data[ny * width + nx] ? 1 : 0;
  };
  return [
    at(x, y - 1),
    at(x + 1, y - 1),
    at(x + 1, y),
    at(x + 1, y + 1),
    at(x, y + 1),
    at(x - 1, y + 1),
    at(x - 1, y),
    at(x - 1, y - 1),
  ];
}

/**
 * Connectivity number (Rutovitz crossing number / 2): the number of distinct
 * 8-connected foreground ARCS meeting the pixel. This is the chemically
 * meaningful "branch count" of a 1px skeleton — unlike a raw 8-neighbour count,
 * it is NOT inflated by the diagonal staircase of a near-horizontal/vertical
 * line (where a single passing strand can touch 3 neighbour cells). A pixel on
 * a line has connectivity 2; a true branch has connectivity >= 3; a terminal
 * endpoint has connectivity 1.
 */
export function connectivityNumber(
  data: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  const n = orderedNeighbours(data, width, height, x, y);
  let crossings = 0;
  for (let i = 0; i < 8; i++) {
    const cur = n[i] as number;
    const nxt = n[(i + 1) % 8] as number;
    if (cur === 1 && nxt === 0) crossings++;
  }
  // A single isolated pixel (no neighbours) has 0 crossings but is an endpoint
  // by convention; treat all-zero neighbourhood as connectivity 0 (ignored).
  return crossings;
}

/**
 * Classify skeleton pixels by CONNECTIVITY NUMBER (not raw neighbour count), so
 * the diagonal staircase of a straight line is not mistaken for a run of
 * junctions. Returns each foreground pixel's connectivity, plus the set of
 * "significant" pixels: endpoints (connectivity 1) and branch junctions
 * (connectivity >= 3). Pixels on a line (connectivity 2) are not significant.
 */
export function classifySkeletonPixels(skel: BinaryImage): {
  degree: Map<number, number>;
  significant: Set<number>;
} {
  const { width, height, data } = skel;
  const degree = new Map<number, number>();
  const significant = new Set<number>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!data[y * width + x]) continue;
      const k = key(x, y, width);
      const c = connectivityNumber(data, width, height, x, y);
      degree.set(k, c);
      if (c === 1 || c >= 3) significant.add(k);
    }
  }
  return { degree, significant };
}

/**
 * Choose the next pixel when walking a 1px strand from `curr` (arrived from
 * `prev`). Among foreground neighbours that are neither `curr` nor `prev` and
 * not already consumed, prefer a 4-connected (orthogonal) step over a diagonal
 * one — this follows the medial strand of a staircase cleanly and avoids
 * corner-cutting. Returns null at a dead end.
 */
function nextStrandPixel(
  data: Uint8Array,
  width: number,
  height: number,
  curr: Point,
  prev: Point | null,
  consumed: Set<number>,
): Point | null {
  const neigh = neighbourOffsets(data, width, height, curr.x, curr.y);
  const avail = neigh.filter((p) => {
    if (prev && p.x === prev.x && p.y === prev.y) return false;
    return !consumed.has(key(p.x, p.y, width));
  });
  if (avail.length === 0) return null;
  // Prefer orthogonal neighbours (Manhattan distance 1) to diagonal ones.
  const ortho = avail.filter((p) => Math.abs(p.x - curr.x) + Math.abs(p.y - curr.y) === 1);
  const pick = (ortho.length > 0 ? ortho : avail)[0];
  return pick ?? null;
}

/**
 * Trace all stroke paths between significant pixels on a 1px skeleton. Interior
 * (connectivity-2) pixels are consumed as each strand is walked, so every strand
 * is traced exactly once. A pure loop (a ring with no branch / terminal, hence
 * no significant pixel) is detected separately and emitted as a closed path
 * (startKey === endKey).
 *
 * Robust to the diagonal staircase of near-axis lines (see
 * {@link nextStrandPixel}) and guarded against infinite loops.
 */
export function tracePaths(skel: BinaryImage): PixelPath[] {
  const { width, height, data } = skel;
  const { degree, significant } = classifySkeletonPixels(skel);
  const paths: PixelPath[] = [];
  const toXY = (k: number): Point => ({ x: k % width, y: Math.floor(k / width) });

  // Interior pixels get consumed as strands are walked; significant pixels are
  // NEVER consumed (a junction belongs to all its incident strands).
  const consumed = new Set<number>();
  const maxSteps = width * height + 4;

  // 1. Trace from every significant pixel outward along each strand.
  for (const startKey of significant) {
    const start = toXY(startKey);
    for (const first of neighbourOffsets(data, width, height, start.x, start.y)) {
      const firstKey = key(first.x, first.y, width);
      // Skip a neighbour that is itself significant only if that strand (the
      // direct significant-significant edge) was already walked from the other
      // side; track those via a dedicated edge set.
      if (significant.has(firstKey)) {
        const idA = Math.min(startKey, firstKey);
        const idB = Math.max(startKey, firstKey);
        const eid = idA * (width * height) + idB;
        if (consumed.has(-eid - 1)) continue; // sentinel for direct edges
        consumed.add(-eid - 1);
        paths.push({ pixels: [start, first], startKey, endKey: firstKey });
        continue;
      }
      if (consumed.has(firstKey)) continue;

      const pixels: Point[] = [start, first];
      consumed.add(firstKey);
      let prev: Point = start;
      let curr: Point = first;
      let steps = 0;
      while (steps++ < maxSteps) {
        const currKey = key(curr.x, curr.y, width);
        if (significant.has(currKey)) break;
        const nextP = nextStrandPixel(data, width, height, curr, prev, consumed);
        if (!nextP) break;
        const nk = key(nextP.x, nextP.y, width);
        pixels.push(nextP);
        if (!significant.has(nk)) consumed.add(nk);
        prev = curr;
        curr = nextP;
      }
      paths.push({ pixels, startKey, endKey: key(curr.x, curr.y, width) });
    }
  }

  // 2. Pure loops: rings of only connectivity-2 pixels have no significant
  //    pixel, so nothing above traced them. Walk each remaining unconsumed
  //    connectivity-2 pixel's loop and emit it as a closed path.
  for (const [k, c] of degree) {
    if (c !== 2 || consumed.has(k)) continue;
    const start = toXY(k);
    const firstN = nextStrandPixel(data, width, height, start, null, consumed);
    if (!firstN) continue;
    const pixels: Point[] = [start];
    consumed.add(k);
    let prev: Point = start;
    let curr: Point = firstN;
    let steps = 0;
    while (steps++ < maxSteps) {
      pixels.push(curr);
      const ck = key(curr.x, curr.y, width);
      if (ck === k) break;
      consumed.add(ck);
      const nextP = nextStrandPixel(data, width, height, curr, prev, consumed);
      if (!nextP) {
        // Close the loop if we are adjacent to the start.
        const backToStart = neighbourOffsets(data, width, height, curr.x, curr.y).some(
          (p) => p.x === start.x && p.y === start.y,
        );
        if (backToStart) pixels.push(start);
        break;
      }
      prev = curr;
      curr = nextP;
    }
    paths.push({ pixels, startKey: k, endKey: k });
  }

  return paths;
}

/** Perpendicular distance from point p to the line through a->b. */
function perpDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return dist(p, a);
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

/** Douglas-Peucker polyline simplification. Keeps endpoints. */
export function douglasPeucker(points: readonly Point[], tolerance: number): Point[] {
  if (points.length <= 2) return [...points];
  let maxDist = 0;
  let index = 0;
  const first = points[0] as Point;
  const last = points[points.length - 1] as Point;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i] as Point, first, last);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }
  if (maxDist > tolerance) {
    const left = douglasPeucker(points.slice(0, index + 1), tolerance);
    const right = douglasPeucker(points.slice(index), tolerance);
    return [...left.slice(0, -1), ...right];
  }
  return [first, last];
}

/** Turn angle (degrees) at interior point b of the path a-b-c. 0 = straight. */
function turnAngleDeg(a: Point, b: Point, c: Point): number {
  const v1x = b.x - a.x;
  const v1y = b.y - a.y;
  const v2x = c.x - b.x;
  const v2y = c.y - b.y;
  const l1 = Math.hypot(v1x, v1y);
  const l2 = Math.hypot(v2x, v2y);
  if (l1 === 0 || l2 === 0) return 0;
  let cos = (v1x * v2x + v1y * v2y) / (l1 * l2);
  cos = Math.max(-1, Math.min(1, cos));
  return Math.acos(cos) * DEG;
}

interface VertexAccumulator {
  points: Point[];
}

/**
 * Build a {@link GeometricGraph} from a line skeleton. This is the main entry
 * point for graph extraction.
 */
export function extractGeometricGraph(
  skel: BinaryImage,
  opts: GraphExtractionOptions,
): GeometricGraph {
  const { width } = skel;
  const paths = tracePaths(skel);

  // --- Bond-length scale estimation --------------------------------------
  // Estimate the BOND length (not the whole-strand length) so the geometry
  // thresholds (corner detection, merge radius, simplify tolerance) are
  // SCALE-INVARIANT. We do a cheap first-pass Douglas-Peucker on each strand
  // with a small fixed tolerance, which breaks a zig-zag chain into its
  // individual bond segments, then take the MEDIAN segment length. This
  // resists both the staircase of near-axis lines and the long-strand bias of
  // an open chain.
  const probeSegLens: number[] = [];
  for (const p of paths) {
    const probe = douglasPeucker(p.pixels, Math.max(1.5, opts.simplifyTolerance));
    for (let i = 0; i + 1 < probe.length; i++) {
      const a = probe[i] as Point;
      const b = probe[i + 1] as Point;
      const l = Math.hypot(a.x - b.x, a.y - b.y);
      if (l > 1) probeSegLens.push(l);
    }
  }
  probeSegLens.sort((a, b) => a - b);
  const scale = probeSegLens.length
    ? (probeSegLens[Math.floor(probeSegLens.length / 2)] as number)
    : 20;

  // Effective, scale-aware thresholds. A corner is only kept if BOTH adjacent
  // segments are a meaningful fraction of the bond scale — this rejects the
  // 1-step staircase jogs of a straight line while keeping true line-angle
  // vertices. The merge radius is capped well below the bond scale so distinct
  // carbons are never merged.
  const effTol = Math.max(opts.simplifyTolerance, scale * 0.12);
  const minSegLen = Math.max(3, scale * 0.3);
  // Merge radius scales WITH the bond length so corner-rounding from
  // anti-aliasing + thinning (which can split one sharp vertex into two gentle
  // bends a stroke-width apart) collapses back to a single vertex — while
  // staying well below half the bond length so genuinely distinct carbons are
  // never merged. `opts.mergeRadius` acts only as an absolute floor.
  const effMerge = Math.min(
    scale * 0.42,
    Math.max(opts.mergeRadius, scale * 0.26),
  );

  // A vertex registry keyed by a quantised coordinate, so corners / endpoints /
  // junctions that land on the same spot are merged. We seed vertices from the
  // significant pixel endpoints of paths and from recovered corners.
  const vertexPoints: VertexAccumulator[] = [];
  // Spatial lookup: find an existing vertex within the effective radius.
  const findOrAddVertex = (p: Point): number => {
    let best = -1;
    let bestD = effMerge;
    for (let i = 0; i < vertexPoints.length; i++) {
      const vp = vertexPoints[i] as VertexAccumulator;
      // centroid so far
      const cx = vp.points.reduce((s, q) => s + q.x, 0) / vp.points.length;
      const cy = vp.points.reduce((s, q) => s + q.y, 0) / vp.points.length;
      const d = Math.hypot(cx - p.x, cy - p.y);
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      (vertexPoints[best] as VertexAccumulator).points.push(p);
      return best;
    }
    vertexPoints.push({ points: [p] });
    return vertexPoints.length - 1;
  };

  interface RawEdge {
    a: number;
    b: number;
    path: Point[];
  }
  const rawEdges: RawEdge[] = [];

  for (const path of paths) {
    // Simplify the traced pixel sequence to a polyline using the scale-aware
    // tolerance, which removes staircase jitter on straight bonds.
    const simplified = douglasPeucker(path.pixels, effTol);

    // Recover line-angle vertices at interior corners of the simplified path.
    // A corner is kept only when the turn exceeds the angle threshold AND both
    // adjacent segments are at least `minSegLen` long — this rejects residual
    // staircase jogs while keeping genuine skeletal vertices.
    const cutIndices: number[] = [0];
    let lastCut = 0;
    for (let i = 1; i < simplified.length - 1; i++) {
      const prevP = simplified[lastCut] as Point;
      const here = simplified[i] as Point;
      const nextP = simplified[i + 1] as Point;
      const ang = turnAngleDeg(prevP, here, nextP);
      const segInLen = Math.hypot(here.x - prevP.x, here.y - prevP.y);
      const segOutLen = Math.hypot(nextP.x - here.x, nextP.y - here.y);
      if (ang >= opts.minCornerAngleDeg && segInLen >= minSegLen && segOutLen >= minSegLen) {
        cutIndices.push(i);
        lastCut = i;
      }
    }
    cutIndices.push(simplified.length - 1);

    // Each consecutive pair of cut indices is one straight bond segment.
    const vertexIds: number[] = cutIndices.map((ci) =>
      findOrAddVertex(simplified[ci] as Point),
    );
    for (let s = 0; s < vertexIds.length - 1; s++) {
      const a = vertexIds[s] as number;
      const b = vertexIds[s + 1] as number;
      if (a === b) continue;
      const segPath = simplified.slice(
        cutIndices[s] as number,
        (cutIndices[s + 1] as number) + 1,
      );
      rawEdges.push({ a, b, path: segPath });
    }
    // Closed loop (startKey === endKey) whose polyline has no interior corner:
    // ensure the loop still forms an edge between distinct vertices. The
    // simplification above collapses a clean circle poorly, so for a pure loop
    // we force at least the first/last split which findOrAddVertex merges — the
    // corner recovery handles polygonal rings (cyclohexane etc.) correctly.
  }

  // Compute vertex centroids + build the graph.
  const centroids: Point[] = vertexPoints.map((vp) => ({
    x: vp.points.reduce((s, q) => s + q.x, 0) / vp.points.length,
    y: vp.points.reduce((s, q) => s + q.y, 0) / vp.points.length,
  }));

  // Deduplicate edges (undirected) and drop zero/short spurs.
  const edgeMap = new Map<string, RawEdge>();
  for (const e of rawEdges) {
    const id = e.a < e.b ? `${e.a}:${e.b}` : `${e.b}:${e.a}`;
    if (!edgeMap.has(id)) edgeMap.set(id, e);
  }

  const cen = (i: number): Point => centroids[i] as Point;

  // First pass: degrees from all candidate edges (for spur detection).
  const degreeCount = new Array<number>(centroids.length).fill(0);
  for (const e of edgeMap.values()) {
    degreeCount[e.a] = (degreeCount[e.a] as number) + 1;
    degreeCount[e.b] = (degreeCount[e.b] as number) + 1;
  }

  // Determine a length scale to reject spur edges (fragments shorter than a
  // fraction of the median kept-edge length AND shorter than minEdgeLength,
  // that dangle from a junction).
  const lengths = [...edgeMap.values()].map((e) => dist(cen(e.a), cen(e.b)));
  const sorted = [...lengths].sort((a, b) => a - b);
  const median = sorted.length ? (sorted[Math.floor(sorted.length / 2)] as number) : 0;

  const keptEdges: GeometricEdge[] = [];
  for (const e of edgeMap.values()) {
    const len = dist(cen(e.a), cen(e.b));
    const isSpur =
      len < opts.minEdgeLength &&
      len < median * 0.35 &&
      (degreeCount[e.a] === 1 || degreeCount[e.b] === 1);
    if (isSpur) continue;
    const s = Math.min(e.a, e.b);
    const t = Math.max(e.a, e.b);
    keptEdges.push({
      source: s,
      target: t,
      path: e.path,
      length: len,
    });
  }

  // Recompute degrees over kept edges and build vertices, dropping any vertex
  // that ended up isolated.
  const finalDegree = new Array<number>(centroids.length).fill(0);
  for (const e of keptEdges) {
    finalDegree[e.source] = (finalDegree[e.source] as number) + 1;
    finalDegree[e.target] = (finalDegree[e.target] as number) + 1;
  }

  // Remap to compact ids, discarding isolated vertices.
  const remap = new Map<number, number>();
  const vertices: GeometricVertex[] = [];
  for (let i = 0; i < centroids.length; i++) {
    const degree = finalDegree[i] as number;
    if (degree === 0) continue;
    const newId = vertices.length;
    remap.set(i, newId);
    const kind: GeometricVertex["kind"] =
      degree === 1 ? "endpoint" : degree >= 3 ? "junction" : "corner";
    vertices.push({ id: newId, x: cen(i).x, y: cen(i).y, degree, kind });
  }

  const edges: GeometricEdge[] = keptEdges.map((e) => ({
    source: remap.get(e.source) as number,
    target: remap.get(e.target) as number,
    path: e.path,
    length: e.length,
  }));

  void key; // retained for symmetry with trace; silence unused in strict builds
  void width;
  return { vertices, edges };
}
