/**
 * M17 (§2) figure → mechanism vectoriser.
 *
 * Takes the PIXELS of a cropped textbook figure (a reaction mechanism drawn as
 * skeletal structures with curly electron-pushing arrows) and recovers:
 *
 *  - the bond-line graph, with every vertex at the position it has in the
 *    picture (`atoms2D` / `bonds2D`, double/triple bonds merged);
 *  - atom labels (heteroatoms, groups, free species) as label boxes, with their
 *    text when the caller can supply it (PDF text layer / OCR chars);
 *  - every curly arrow as a cubic Bézier with tail, head, bulge and barb style
 *    (full 2e⁻ vs fishhook 1e⁻);
 *  - everything else (unread labels, lone-pair dots, charges, wedges, straight
 *    reaction arrows, brackets) as traced ink, so the redrawn figure is
 *    lossless even where nothing was "understood".
 *
 * It is classical image analysis — binarise, connected components, thinning,
 * skeleton-graph tracing, polyline fitting — pure, synchronous, deterministic
 * and dependency-free, so it runs identically in the browser and in vitest.
 * It is NOT a general optical-structure-recognition engine: see the limits
 * listed on {@link vectorizeMechanismImage}.
 */

import type { SpatialAtom2D, SpatialBond2D } from "../model";

/** RGBA pixels (the shape of a DOM `ImageData`). */
export interface RasterImage {
  readonly data: ArrayLike<number>;
  readonly width: number;
  readonly height: number;
}

/** A piece of text known to sit in the figure (from a PDF text layer or OCR). */
export interface FigureChar {
  readonly text: string;
  /** Normalized 0..1 centre of the text within the figure box. */
  readonly x: number;
  readonly y: number;
  /** Optional normalized size; when absent a glyph-sized box is assumed. */
  readonly w?: number;
  readonly h?: number;
}

/** A curly arrow as measured in the picture (normalized 0..1 box coordinates). */
export interface RawCurlyArrow {
  readonly id?: string;
  readonly tailX: number;
  readonly tailY: number;
  readonly headX: number;
  readonly headY: number;
  /** A point the arc bulges through (used for the signed curvature). */
  readonly ctrlX?: number;
  readonly ctrlY?: number;
  /** Cubic Bézier control points of the arc as drawn. */
  readonly c1X?: number;
  readonly c1Y?: number;
  readonly c2X?: number;
  readonly c2Y?: number;
  readonly barb?: "full" | "fishhook";
}

export interface VectorizedMechanism {
  readonly atoms2D: readonly SpatialAtom2D[];
  readonly bonds2D: readonly SpatialBond2D[];
  readonly rawArrows: readonly RawCurlyArrow[];
  /** Traced residual ink, SVG path data in source-pixel units. */
  readonly ink: readonly string[];
  readonly inkSize: readonly [number, number];
  readonly aspect: number;
  /** Best-effort SMILES of the recovered graph ("*" for unread labels). */
  readonly smiles: string;
  /** Median bond length in pixels (0 when no bond was found). */
  readonly bondLengthPx: number;
}

export interface VectorizeOptions {
  readonly ocrChars?: readonly FigureChar[];
}

// ---------------------------------------------------------------------------
// Raster primitives (all masks are padded by 1px so no bounds checks are needed)
// ---------------------------------------------------------------------------

interface Grid {
  readonly W: number;
  readonly H: number;
  readonly PW: number;
  /** 8-neighbour index offsets, clockwise from north (P2..P9). */
  readonly off: readonly number[];
}

function makeGrid(W: number, H: number): Grid {
  const PW = W + 2;
  return { W, H, PW, off: [-PW, -PW + 1, 1, PW + 1, PW, PW - 1, -1, -PW - 1] };
}

/**
 * Classify every pixel: 0 = paper, 1 = neutral (black/grey) ink, 2 = coloured
 * ink. Curly arrows are very often printed in a second colour; keeping the two
 * classes apart stops a red arrow that touches a black bond from fusing with it.
 */
function classifyInk(img: RasterImage, g: Grid): Uint8Array {
  const { W, H, PW } = g;
  const n = W * H;
  const lum = new Uint8Array(n);
  const chroma = new Uint8Array(n);
  const hist = new Float64Array(256);
  const d = img.data;
  for (let i = 0; i < n; i++) {
    const a = (d[i * 4 + 3] ?? 255) / 255;
    const r = (d[i * 4] ?? 255) * a + 255 * (1 - a);
    const gg = (d[i * 4 + 1] ?? 255) * a + 255 * (1 - a);
    const b = (d[i * 4 + 2] ?? 255) * a + 255 * (1 - a);
    const l = Math.round(0.299 * r + 0.587 * gg + 0.114 * b);
    lum[i] = l;
    chroma[i] = Math.round(Math.max(r, gg, b) - Math.min(r, gg, b));
    hist[l] = (hist[l] ?? 0) + 1;
  }
  // Otsu threshold on luminance, clamped to a sane band.
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t]!;
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (wB === 0) continue;
    const wF = n - wB;
    if (wF === 0) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      thr = t;
    }
  }
  thr = Math.max(90, Math.min(210, thr));

  const cls = new Uint8Array(PW * (H + 2));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const c = chroma[i]!;
      const l = lum[i]!;
      if (c >= 70 && l < 235) cls[(y + 1) * PW + x + 1] = 2;
      else if (l < thr) cls[(y + 1) * PW + x + 1] = 1;
    }
  }
  // Anti-aliasing halo: a not-very-dark neutral pixel touching coloured ink
  // belongs to the coloured stroke.
  const halo: number[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y + 1) * PW + x + 1;
      if (cls[p] !== 1 || lum[y * W + x]! < 100) continue;
      for (const o of g.off) {
        if (cls[p + o] === 2) {
          halo.push(p);
          break;
        }
      }
    }
  }
  for (const p of halo) cls[p] = 2;
  return cls;
}

/** Zhang–Suen thinning (in place) followed by staircase clean-up. */
function thin(mask: Uint8Array, g: Grid): void {
  const o = g.off;
  let pts: number[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) pts.push(i);
  let changed = true;
  while (changed) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      const del: number[] = [];
      for (const p of pts) {
        const n2 = mask[p + o[0]!]!, n3 = mask[p + o[1]!]!, n4 = mask[p + o[2]!]!, n5 = mask[p + o[3]!]!;
        const n6 = mask[p + o[4]!]!, n7 = mask[p + o[5]!]!, n8 = mask[p + o[6]!]!, n9 = mask[p + o[7]!]!;
        const B = n2 + n3 + n4 + n5 + n6 + n7 + n8 + n9;
        if (B < 2 || B > 6) continue;
        const A =
          (!n2 && n3 ? 1 : 0) + (!n3 && n4 ? 1 : 0) + (!n4 && n5 ? 1 : 0) + (!n5 && n6 ? 1 : 0) +
          (!n6 && n7 ? 1 : 0) + (!n7 && n8 ? 1 : 0) + (!n8 && n9 ? 1 : 0) + (!n9 && n2 ? 1 : 0);
        if (A !== 1) continue;
        if (step === 0) {
          if (n2 && n4 && n6) continue;
          if (n4 && n6 && n8) continue;
        } else {
          if (n2 && n4 && n8) continue;
          if (n2 && n6 && n8) continue;
        }
        del.push(p);
      }
      if (del.length > 0) {
        changed = true;
        for (const p of del) mask[p] = 0;
        pts = pts.filter((p) => mask[p]);
      }
    }
  }
  // Remove corner pixels that are redundant for 8-connectivity, so a clean
  // stroke has exactly two neighbours per pixel and only true junctions have 3+.
  for (const p of pts) {
    if (!mask[p]) continue;
    const N = mask[p + o[0]!], NE = mask[p + o[1]!], E = mask[p + o[2]!], SE = mask[p + o[3]!];
    const S = mask[p + o[4]!], SW = mask[p + o[5]!], Wst = mask[p + o[6]!], NW = mask[p + o[7]!];
    if (
      (N && E && !S && !Wst && !SW) ||
      (E && S && !N && !Wst && !NW) ||
      (S && Wst && !N && !E && !NE) ||
      (Wst && N && !S && !E && !SE)
    ) {
      mask[p] = 0;
    }
  }
}

interface Pt {
  x: number;
  y: number;
}

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  len: number;
  comp: number;
  order: number;
  /** True when it came from a small free-standing stroke (not a bond network). */
  loose: boolean;
  dead?: boolean;
}

interface Comp {
  readonly id: number;
  readonly cls: number;
  readonly pix: Int32Array;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly area: number;
  skel: number[];
  segs: Segment[];
  polyLen: number;
  /** Skeleton length lying on gently-bending (arc-like) paths. */
  curvyLen: number;
  kind: "unknown" | "arrow" | "bonds" | "glyph" | "ink" | "line";
}

const dist = (ax: number, ay: number, bx: number, by: number): number => Math.hypot(ax - bx, ay - by);

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

// ---------------------------------------------------------------------------
// Skeleton graph → straight segments
// ---------------------------------------------------------------------------

/** Douglas–Peucker simplification of an open polyline. */
function simplify(points: Pt[], eps: number): Pt[] {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    const A = points[a]!;
    const B = points[b]!;
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const L = Math.hypot(dx, dy) || 1;
    let worst = -1;
    let worstD = eps;
    for (let i = a + 1; i < b; i++) {
      const P = points[i]!;
      const dd = L > 1e-6 && (dx !== 0 || dy !== 0)
        ? Math.abs((P.x - A.x) * dy - (P.y - A.y) * dx) / L
        : dist(P.x, P.y, A.x, A.y);
      if (dd > worstD) {
        worstD = dd;
        worst = i;
      }
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return points.filter((_p, i) => keep[i]);
}

/**
 * Trace one component's skeleton into a graph (junction/end nodes joined by
 * pixel paths), drop thinning spurs, and fit straight segments to every path.
 */
function traceSegments(
  comp: Comp,
  sk: Uint8Array,
  lab: Int32Array,
  g: Grid,
  stroke: number,
): { segs: Segment[]; polyLen: number; curvyLen: number } {
  const { PW, off } = g;
  const mine = (q: number): boolean => sk[q] === 1 && lab[q] === comp.id;
  const px = (p: number): Pt => ({ x: (p % PW) - 1, y: Math.floor(p / PW) - 1 });
  const degree = (p: number): number => {
    let c = 0;
    for (const o of off) if (mine(p + o)) c++;
    return c;
  };
  const skel = comp.skel;
  if (skel.length <= 1) return { segs: [], polyLen: 0, curvyLen: 0 };

  // Node pixels: ends (1 neighbour) and junctions (3+). A pure loop has none,
  // so seed it with an arbitrary pixel.
  const nodeOf = new Map<number, number>();
  const nodePix: number[] = [];
  for (const p of skel) {
    const dgr = degree(p);
    if (dgr !== 2) nodePix.push(p);
  }
  if (nodePix.length === 0) nodePix.push(skel[0]!);
  const nodePixSet = new Set(nodePix);
  // Cluster adjacent node pixels into nodes.
  const nodes: { x: number; y: number; n: number }[] = [];
  for (const p of nodePix) {
    if (nodeOf.has(p)) continue;
    const id = nodes.length;
    const node = { x: 0, y: 0, n: 0 };
    nodes.push(node);
    const stack = [p];
    nodeOf.set(p, id);
    while (stack.length > 0) {
      const q = stack.pop()!;
      const c = px(q);
      node.x += c.x;
      node.y += c.y;
      node.n++;
      for (const o of off) {
        const r = q + o;
        if (nodePixSet.has(r) && !nodeOf.has(r)) {
          nodeOf.set(r, id);
          stack.push(r);
        }
      }
    }
  }
  for (const nd of nodes) {
    nd.x /= nd.n;
    nd.y /= nd.n;
  }

  interface Edge {
    a: number;
    b: number;
    pts: Pt[];
    len: number;
    dead: boolean;
  }
  const edges: Edge[] = [];
  const visited = new Set<number>();
  for (const start of nodePix) {
    const a = nodeOf.get(start)!;
    for (const o of off) {
      const first = start + o;
      if (!mine(first) || nodePixSet.has(first) || visited.has(first)) continue;
      const pts: Pt[] = [{ x: nodes[a]!.x, y: nodes[a]!.y }];
      let cur = first;
      let endNode = -1;
      let steps = 0;
      for (;;) {
        visited.add(cur);
        pts.push(px(cur));
        steps++;
        let next = -1;
        let nodeHit = -1;
        for (const o2 of off) {
          const q = cur + o2;
          if (!mine(q)) continue;
          if (nodePixSet.has(q)) {
            const nid = nodeOf.get(q)!;
            // Do not bounce straight back into the node we just left.
            if (nid !== a || steps > 2) nodeHit = nid;
          } else if (!visited.has(q)) {
            next = q;
          }
        }
        if (next >= 0) {
          cur = next;
          continue;
        }
        endNode = nodeHit >= 0 ? nodeHit : a;
        break;
      }
      pts.push({ x: nodes[endNode]!.x, y: nodes[endNode]!.y });
      let len = 0;
      for (let i = 1; i < pts.length; i++) len += dist(pts[i]!.x, pts[i]!.y, pts[i - 1]!.x, pts[i - 1]!.y);
      edges.push({ a, b: endNode, pts, len, dead: false });
    }
  }

  // Spur pruning: a short edge hanging off a junction is a thinning artefact.
  const deg = new Array<number>(nodes.length).fill(0);
  for (const e of edges) {
    deg[e.a]!++;
    deg[e.b]!++;
  }
  const spur = 2.5 * stroke + 2;
  for (const e of edges) {
    if (e.a === e.b) continue;
    const endA = deg[e.a] === 1;
    const endB = deg[e.b] === 1;
    if (endA !== endB && e.len < spur) e.dead = true;
  }

  const eps = Math.max(1.5, 1.1 * stroke);
  const segs: Segment[] = [];
  let polyLen = 0;
  let curvyLen = 0;
  for (const e of edges) {
    if (e.dead) continue;
    polyLen += e.len;
    const poly = simplify(e.pts, eps);
    // Bond chains turn sharply (45°+) at a vertex; a path that bends by a
    // gentle 10–40° between fitted pieces is an arc, not bonds.
    let gentle = 0;
    let sharp = 0;
    for (let i = 1; i < poly.length - 1; i++) {
      const ux = poly[i]!.x - poly[i - 1]!.x, uy = poly[i]!.y - poly[i - 1]!.y;
      const vx = poly[i + 1]!.x - poly[i]!.x, vy = poly[i + 1]!.y - poly[i]!.y;
      const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
      if (lu < 3 * stroke || lv < 3 * stroke) continue;
      const cos = (ux * vx + uy * vy) / (lu * lv);
      if (cos <= 0.77) sharp++;
      else if (cos < 0.985) gentle++;
    }
    if (gentle > 0 && gentle >= sharp) curvyLen += e.len;
    for (let i = 1; i < poly.length; i++) {
      const A = poly[i - 1]!;
      const B = poly[i]!;
      const len = dist(A.x, A.y, B.x, B.y);
      if (len < 1) continue;
      segs.push({ x1: A.x, y1: A.y, x2: B.x, y2: B.y, len, comp: comp.id, order: 1, loose: false });
    }
  }
  return { segs, polyLen, curvyLen };
}

// ---------------------------------------------------------------------------
// Curly-arrow detection
// ---------------------------------------------------------------------------

interface ArrowPx {
  tail: Pt;
  head: Pt;
  c1: Pt;
  c2: Pt;
  mid: Pt;
  barb: "full" | "fishhook";
  curved: boolean;
}

/** Longest geodesic path through a component's skeleton (double BFS). */
function diameterPath(comp: Comp, sk: Uint8Array, lab: Int32Array, g: Grid): number[] {
  const mine = (q: number): boolean => sk[q] === 1 && lab[q] === comp.id;
  const bfs = (src: number): { far: number; parent: Map<number, number> } => {
    const parent = new Map<number, number>([[src, -1]]);
    let queue = [src];
    let far = src;
    while (queue.length > 0) {
      const next: number[] = [];
      for (const p of queue) {
        far = p;
        for (const o of g.off) {
          const q = p + o;
          if (mine(q) && !parent.has(q)) {
            parent.set(q, p);
            next.push(q);
          }
        }
      }
      queue = next;
    }
    return { far, parent };
  };
  const a = bfs(comp.skel[0]!).far;
  const { far: b, parent } = bfs(a);
  const path: number[] = [];
  for (let p = b; p !== -1; p = parent.get(p) ?? -1) path.push(p);
  return path.reverse();
}

/**
 * Decide whether a component is an arrow (one open stroke carrying a head at
 * exactly one end) and, if so, measure it. `curved: false` marks a straight
 * arrow (a reaction arrow), which the caller keeps as ink.
 */
function detectArrow(comp: Comp, sk: Uint8Array, lab: Int32Array, g: Grid, strokeHint: number): ArrowPx | null {
  const { PW } = g;
  const skLen = comp.skel.length;
  if (skLen < 10) return null;
  const s = Math.max(1, Math.min(comp.area / skLen, strokeHint * 1.6));
  if (skLen < 5 * s) return null;
  const pathIdx = diameterPath(comp, sk, lab, g);
  const Lp = pathIdx.length;
  if (Lp < 0.6 * skLen) return null;
  const P: Pt[] = pathIdx.map((p) => ({ x: (p % PW) - 1, y: Math.floor(p / PW) - 1 }));
  const ink: Pt[] = [];
  for (let i = 0; i < comp.pix.length; i++) {
    const p = comp.pix[i]!;
    ink.push({ x: (p % PW) - 1, y: Math.floor(p / PW) - 1 });
  }

  // Head evidence: ink piled up around one end of the stroke but not the other.
  const Rm = Math.min(Math.max(3 * s + 3, 5), 0.45 * Lp);
  const massAt = (c: Pt): number => {
    let m = 0;
    for (const q of ink) if (dist(q.x, q.y, c.x, c.y) <= Rm) m++;
    return m;
  };
  const m0 = massAt(P[0]!);
  const m1 = massAt(P[Lp - 1]!);
  const headAtEnd = m1 >= m0;
  const mHead = Math.max(m0, m1);
  const mTail = Math.max(1, Math.min(m0, m1));
  if (mHead < 1.45 * mTail) {
    // Weak head (thin fishhook, faint print): still an arrow if the stroke is
    // one SMOOTH arc — bond chains turn by 45°+ at every vertex, arcs do not.
    if (mHead < 1.12 * mTail) return null;
    const poly = simplify(P, Math.max(1.5, 1.1 * s));
    if (poly.length < 3) return null;
    for (let i = 1; i < poly.length - 1; i++) {
      const ux = poly[i]!.x - poly[i - 1]!.x, uy = poly[i]!.y - poly[i - 1]!.y;
      const vx = poly[i + 1]!.x - poly[i]!.x, vy = poly[i + 1]!.y - poly[i]!.y;
      const cos = (ux * vx + uy * vy) / ((Math.hypot(ux, uy) || 1) * (Math.hypot(vx, vy) || 1));
      // Ignore the kink where the stroke runs into the head itself.
      const nearEnd = Math.min(
        dist(poly[i]!.x, poly[i]!.y, P[0]!.x, P[0]!.y),
        dist(poly[i]!.x, poly[i]!.y, P[Lp - 1]!.x, P[Lp - 1]!.y),
      ) < 4 * s + 4;
      if (cos < 0.68 && !nearEnd) return null; // > ~47° turn
    }
  }
  if (!headAtEnd) P.reverse();
  const end = P[Lp - 1]!;

  // Every skeleton branch off the main stroke must be part of the head.
  const Rh = Math.min(Math.max(6 * s + 4, 8), 0.5 * Lp);
  const onPath = new Set(pathIdx);
  let offTotal = 0;
  let offNear = 0;
  for (const p of comp.skel) {
    if (onPath.has(p)) continue;
    offTotal++;
    if (dist((p % PW) - 1, Math.floor(p / PW) - 1, end.x, end.y) <= 1.6 * Rh) offNear++;
  }
  if (offTotal > 0 && offNear < 0.85 * offTotal) return null;
  if (offTotal > 0.6 * Lp) return null;

  // Shaft axis just before the head, then the tip = furthest head ink along it.
  const back = P[Math.max(0, Lp - 1 - Math.round(Math.min(1.6 * Rh, 0.5 * Lp)))]!;
  let cx = 0;
  let cy = 0;
  let cn = 0;
  for (const q of ink) {
    if (dist(q.x, q.y, end.x, end.y) <= Rh) {
      cx += q.x;
      cy += q.y;
      cn++;
    }
  }
  if (cn === 0) return null;
  cx /= cn;
  cy /= cn;
  let ax = cx - back.x;
  let ay = cy - back.y;
  const al = Math.hypot(ax, ay);
  if (al < 1e-6) return null;
  ax /= al;
  ay /= al;
  let tip: Pt = end;
  let bestProj = -Infinity;
  for (const q of ink) {
    if (dist(q.x, q.y, cx, cy) > 1.4 * Rh) continue;
    const pr = (q.x - back.x) * ax + (q.y - back.y) * ay;
    if (pr > bestProj) {
      bestProj = pr;
      tip = q;
    }
  }

  // Barb style: is the head ink on both sides of the shaft axis, or one?
  // Tail → (shaft) → tip polyline, parametrised by arc length.
  const cut = Math.max(1, Lp - 1 - Math.round(Math.min(Rh, 0.35 * Lp)));
  const line: Pt[] = P.slice(0, cut);
  line.push(tip);
  const at = (t: number): Pt => {
    const target = t * total;
    let i = 1;
    while (i < cum.length - 1 && cum[i]! < target) i++;
    const span = cum[i]! - cum[i - 1]! || 1;
    const f = (target - cum[i - 1]!) / span;
    return {
      x: line[i - 1]!.x + (line[i]!.x - line[i - 1]!.x) * f,
      y: line[i - 1]!.y + (line[i]!.y - line[i - 1]!.y) * f,
    };
  };
  // Thinning eats the stroke's rounded end: push the tail back out to the ink.
  {
    const start = line[0]!;
    const ref = line[Math.min(line.length - 1, 6)]!;
    const ox = start.x - ref.x;
    const oy = start.y - ref.y;
    const ol = Math.hypot(ox, oy);
    if (ol > 1e-6) {
      let bestT = 0;
      let bestQ = start;
      for (const q of ink) {
        if (dist(q.x, q.y, start.x, start.y) > 3 * s + 2) continue;
        const pr = ((q.x - start.x) * ox + (q.y - start.y) * oy) / ol;
        if (pr > bestT) {
          bestT = pr;
          bestQ = q;
        }
      }
      line.unshift(bestQ);
    }
  }
  const cum: number[] = [0];
  for (let i = 1; i < line.length; i++) {
    cum.push(cum[i - 1]! + dist(line[i]!.x, line[i]!.y, line[i - 1]!.x, line[i - 1]!.y));
  }
  const total = cum[cum.length - 1]!;
  const tail = line[0]!;
  const q1 = at(1 / 3);
  const q2 = at(2 / 3);
  // Cubic Bézier interpolating tail, q1 (t=1/3), q2 (t=2/3), tip.
  const c1: Pt = {
    x: (-5 * tail.x + 18 * q1.x - 9 * q2.x + 2 * tip.x) / 6,
    y: (-5 * tail.y + 18 * q1.y - 9 * q2.y + 2 * tip.y) / 6,
  };
  const c2: Pt = {
    x: (2 * tail.x - 9 * q1.x + 18 * q2.x - 5 * tip.x) / 6,
    y: (2 * tail.y - 9 * q1.y + 18 * q2.y - 5 * tip.y) / 6,
  };
  // Barb style, measured from the tip (the one point of the head that is known
  // exactly): look at where the head's wide part lies relative to the ray from
  // the tip back to the shaft. A full head straddles that ray; a fishhook hangs
  // off one side of it.
  // Head length: walking back from the tip, the ink cross-section widens up to
  // the head's base and then collapses to the bare shaft.
  const dMax = Math.max(6, Math.round(Math.min(1.5 * Rh, 0.5 * Lp)));
  const ringCount = new Array<number>(dMax + 2).fill(0);
  for (const q of ink) {
    const dq = Math.round(dist(q.x, q.y, tip.x, tip.y));
    if (dq <= dMax) ringCount[dq]!++;
  }
  let ringMax = 0;
  let headLen = 5;
  for (let dq = 2; dq <= dMax; dq++) {
    if (ringCount[dq]! > ringMax) {
      ringMax = ringCount[dq]!;
      headLen = dq;
    }
  }
  while (headLen < dMax && ringCount[headLen + 1]! >= 0.6 * ringMax) headLen++;
  headLen = Math.max(5, headLen);
  let ex = 0;
  let ey = 0;
  let en = 0;
  for (const q of ink) {
    const dq = dist(q.x, q.y, tip.x, tip.y);
    if (dq >= 1.2 * headLen && dq <= 1.2 * headLen + 1.5 * s + 1.5) {
      ex += q.x;
      ey += q.y;
      en++;
    }
  }
  // Two independent estimates of the head's axis, both anchored at the tip:
  //  (a) the ray back to where the shaft leaves the head, and
  //  (b) the shaft's own tangent, extrapolated with its curvature (a
  //      least-squares quadratic through the shaft just behind the head).
  // For each, measure how far the head's wide part sits off that axis, in
  // units of its own angular spread. A full head straddles the axis (≈0); a
  // fishhook hangs off one side (≳1). Full is by far the common case, so
  // fishhook needs both estimates to agree, or one to be emphatic.
  const offAxis = (sx: number, sy: number): number => {
    let sum = 0;
    let sum2 = 0;
    let cnt = 0;
    for (const q of ink) {
      const qx = q.x - tip.x;
      const qy = q.y - tip.y;
      const dq = Math.hypot(qx, qy);
      if (dq < 0.5 * headLen || dq > headLen) continue;
      const phi = Math.atan2(sx * qy - sy * qx, sx * qx + sy * qy);
      sum += phi;
      sum2 += phi * phi;
      cnt++;
    }
    if (cnt < 6) return 0;
    const mean = sum / cnt;
    return Math.abs(mean) / Math.sqrt(Math.max(1e-9, sum2 / cnt - mean * mean));
  };
  let barb: "full" | "fishhook" = "full";
  if (en > 0 && Lp >= 4 * headLen) {
    const statRay = offAxis(ex / en - tip.x, ey / en - tip.y);
    let statTangent = statRay;
    const hi = Math.max(2, Lp - 1 - Math.round(headLen));
    const lo = Math.max(0, hi - Math.round(Math.max(14, 2.5 * headLen)));
    if (hi - lo + 1 >= 10) {
      let s1 = 0, s2 = 0, s3 = 0, s4 = 0;
      let x0 = 0, x1 = 0, x2 = 0, y0 = 0, y1 = 0, y2 = 0;
      const s0 = hi - lo + 1;
      for (let i = lo; i <= hi; i++) {
        const t = i - hi;
        const t2 = t * t;
        s1 += t; s2 += t2; s3 += t2 * t; s4 += t2 * t2;
        x0 += P[i]!.x; x1 += P[i]!.x * t; x2 += P[i]!.x * t2;
        y0 += P[i]!.y; y1 += P[i]!.y * t; y2 += P[i]!.y * t2;
      }
      const det = s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
      if (Math.abs(det) > 1e-9) {
        const lin = (r0: number, r1: number, r2: number): number =>
          (s0 * (r1 * s4 - s3 * r2) - r0 * (s1 * s4 - s3 * s2) + s2 * (s1 * r2 - r1 * s2)) / det;
        const quad = (r0: number, r1: number, r2: number): number =>
          (s0 * (s2 * r2 - r1 * s3) - s1 * (s1 * r2 - r1 * s2) + r0 * (s1 * s3 - s2 * s2)) / det;
        const tt = 0.5 * headLen; // tangent half-way into the (straight) head
        const dxT = lin(x0, x1, x2) + 2 * quad(x0, x1, x2) * tt;
        const dyT = lin(y0, y1, y2) + 2 * quad(y0, y1, y2) * tt;
        if (Math.hypot(dxT, dyT) > 1e-6) statTangent = offAxis(-dxT, -dyT);
      }
    }
    if (Math.max(statRay, statTangent) >= 1.4 || Math.min(statRay, statTangent) >= 0.75) barb = "fishhook";
  }

  const chord = dist(tail.x, tail.y, tip.x, tip.y);
  let maxDev = 0;
  for (const q of line) {
    const dv = chord > 1e-6
      ? Math.abs((q.x - tail.x) * (tip.y - tail.y) - (q.y - tail.y) * (tip.x - tail.x)) / chord
      : dist(q.x, q.y, tail.x, tail.y);
    if (dv > maxDev) maxDev = dv;
  }
  const curved = chord < 1e-6 || maxDev / chord >= 0.07;
  return { tail, head: tip, c1, c2, mid: at(0.5), barb, curved };
}

// ---------------------------------------------------------------------------
// Ink tracing
// ---------------------------------------------------------------------------

/** Trace a component's pixels to compact SVG path data (merged pixel runs). */
function traceInk(comp: Comp, g: Grid): string {
  const { PW } = g;
  const sorted = Array.from(comp.pix).sort((a, b) => a - b);
  interface Run {
    x: number;
    w: number;
    y: number;
    h: number;
  }
  const done: Run[] = [];
  let open = new Map<string, Run>();
  let i = 0;
  let prevY = -2;
  while (i < sorted.length) {
    const y = Math.floor(sorted[i]! / PW) - 1;
    const rowRuns: Run[] = [];
    while (i < sorted.length && Math.floor(sorted[i]! / PW) - 1 === y) {
      const x = (sorted[i]! % PW) - 1;
      let w = 1;
      while (i + 1 < sorted.length && sorted[i + 1] === sorted[i]! + 1) {
        w++;
        i++;
      }
      i++;
      rowRuns.push({ x, w, y, h: 1 });
    }
    const nextOpen = new Map<string, Run>();
    for (const r of rowRuns) {
      const key = `${r.x},${r.w}`;
      const up = y === prevY + 1 ? open.get(key) : undefined;
      if (up) {
        up.h++;
        nextOpen.set(key, up);
        open.delete(key);
      } else {
        nextOpen.set(key, r);
      }
    }
    for (const r of open.values()) done.push(r);
    open = nextOpen;
    prevY = y;
  }
  for (const r of open.values()) done.push(r);
  done.sort((a, b) => a.y - b.y || a.x - b.x);
  return done.map((r) => `M${r.x} ${r.y}h${r.w}v${r.h}h${-r.w}z`).join("");
}

// ---------------------------------------------------------------------------
// Graph → SMILES
// ---------------------------------------------------------------------------

const ORGANIC = new Set(["B", "C", "N", "O", "P", "S", "F", "Cl", "Br", "I"]);
const GROUP_TOKENS: Record<string, string> = {
  OH: "O", HO: "O", NH2: "N", H2N: "N", NH: "N", HN: "N", SH: "S", HS: "S",
  CH3: "C", H3C: "C", Me: "C", CH2: "C", H2C: "C", CH: "C", HC: "C", H: "[H]",
  H2O: "O", OH2: "O", NH3: "N", H3N: "N", HBr: "Br", HCl: "Cl",
};
const CHARGED_TOKENS: Record<string, string> = {
  "OH-": "[OH-]", "HO-": "[OH-]", "O-": "[O-]", "Br-": "[Br-]", "Cl-": "[Cl-]", "I-": "[I-]",
  "F-": "[F-]", "H+": "[H+]", "H3O+": "[OH3+]", "NH4+": "[NH4+]", "NH3+": "[NH3+]",
  "H3N+": "[NH3+]", "N+": "[N+]", "O+": "[O+]", "C+": "[C+]", "C-": "[C-]", "OH2+": "[OH2+]",
  "H2O+": "[OH2+]", "S-": "[S-]", "N-": "[N-]", "CN-": "[C-]#N", "NC-": "[C-]#N",
};

/** The SMILES token for an atom label ("*" when it cannot be interpreted). */
function smilesToken(element: string): string {
  const raw = element.replace(/\s+/g, "");
  const norm = raw
    .replace(/[−–⁻⊖]/g, "-")
    .replace(/[⁺⊕]/g, "+")
    .replace(/[₀-₉]/g, (c) => String(c.charCodeAt(0) - 0x2080));
  if (ORGANIC.has(norm)) return norm;
  if (GROUP_TOKENS[norm]) return GROUP_TOKENS[norm]!;
  if (CHARGED_TOKENS[norm]) return CHARGED_TOKENS[norm]!;
  return "*";
}

/**
 * Write a best-effort SMILES for a 2D graph (depth-first, ring-closure digits,
 * "." between disconnected fragments). Unread labels become "*".
 */
export function smilesFromGraph(atoms: readonly SpatialAtom2D[], bonds: readonly SpatialBond2D[]): string {
  const adj = new Map<string, { to: string; order: number; bond: number }[]>();
  for (const a of atoms) adj.set(a.id, []);
  bonds.forEach((b, i) => {
    adj.get(b.fromAtomId)?.push({ to: b.toAtomId, order: b.order, bond: i });
    adj.get(b.toAtomId)?.push({ to: b.fromAtomId, order: b.order, bond: i });
  });
  const elementOf = new Map(atoms.map((a) => [a.id, a.element]));
  const sym = (order: number): string => (order === 2 ? "=" : order === 3 ? "#" : "");
  const visited = new Set<string>();
  const treeBond = new Set<number>();
  const closures = new Map<string, string[]>();
  let ringNo = 0;
  const closedBond = new Set<number>();
  const walk = (id: string, viaBond: number): void => {
    visited.add(id);
    for (const e of adj.get(id) ?? []) {
      if (e.bond === viaBond || closedBond.has(e.bond) || treeBond.has(e.bond)) continue;
      if (visited.has(e.to)) {
        ringNo++;
        const label = ringNo < 10 ? String(ringNo) : `%${ringNo}`;
        closedBond.add(e.bond);
        closures.set(id, [...(closures.get(id) ?? []), `${sym(e.order)}${label}`]);
        closures.set(e.to, [...(closures.get(e.to) ?? []), label]);
      } else {
        treeBond.add(e.bond);
        walk(e.to, e.bond);
      }
    }
  };
  const write = (id: string, viaBond: number): string => {
    let out = smilesToken(elementOf.get(id) ?? "C") + (closures.get(id) ?? []).join("");
    const kids = (adj.get(id) ?? []).filter((e) => treeBond.has(e.bond) && e.bond !== viaBond);
    // Only descend along tree bonds that lead AWAY from this atom.
    const down = kids.filter((e) => !written.has(e.to));
    down.forEach((e, i) => {
      written.add(e.to);
      const sub = sym(e.order) + write(e.to, e.bond);
      out += i < down.length - 1 ? `(${sub})` : sub;
    });
    return out;
  };
  const written = new Set<string>();
  const parts: string[] = [];
  for (const a of atoms) {
    if (visited.has(a.id)) continue;
    walk(a.id, -1);
    written.add(a.id);
    parts.push(write(a.id, -1));
  }
  return parts.join(".");
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/**
 * Vectorise a cropped mechanism figure.
 *
 * Known limits (it degrades to traced ink, never to nothing):
 *  - a black curly arrow that TOUCHES a black bond fuses with the structure and
 *    is not recognised (coloured arrows are separated by colour);
 *  - label TEXT is only known when `ocrChars` supplies it; otherwise labels are
 *    kept as traced glyphs and appear as "*" in the SMILES;
 *  - wedge/hash stereo bonds, aromatic circles and brackets are carried as ink.
 */
export function vectorizeMechanismImage(img: RasterImage, opts: VectorizeOptions = {}): VectorizedMechanism {
  const W = Math.max(1, Math.floor(img.width));
  const H = Math.max(1, Math.floor(img.height));
  const g = makeGrid(W, H);
  const { PW, off } = g;
  const cls = classifyInk(img, g);

  // Connected components (8-connected, same ink class).
  const lab = new Int32Array(cls.length);
  const comps: Comp[] = [];
  for (let start = 0; start < cls.length; start++) {
    if (cls[start] === 0 || lab[start] !== 0) continue;
    const id = comps.length + 1;
    const c = cls[start]!;
    const stack = [start];
    lab[start] = id;
    const pix: number[] = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    while (stack.length > 0) {
      const p = stack.pop()!;
      pix.push(p);
      const x = (p % PW) - 1;
      const y = Math.floor(p / PW) - 1;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (const o of off) {
        const q = p + o;
        if (cls[q] === c && lab[q] === 0) {
          lab[q] = id;
          stack.push(q);
        }
      }
    }
    comps.push({
      id, cls: c, pix: Int32Array.from(pix), x0, y0, x1, y1, area: pix.length,
      skel: [], segs: [], polyLen: 0, curvyLen: 0, kind: "unknown",
    });
  }

  // Skeleton (per ink class so different classes never bridge).
  const sk = new Uint8Array(cls.length);
  for (const c of [1, 2]) {
    const m = new Uint8Array(cls.length);
    let any = false;
    for (let i = 0; i < cls.length; i++) {
      if (cls[i] === c) {
        m[i] = 1;
        any = true;
      }
    }
    if (!any) continue;
    thin(m, g);
    for (let i = 0; i < m.length; i++) if (m[i]) sk[i] = 1;
  }
  for (let i = 0; i < sk.length; i++) if (sk[i]) comps[lab[i]! - 1]!.skel.push(i);

  const strokes: number[] = [];
  for (const c of comps) if (c.skel.length >= 8) strokes.push(c.area / c.skel.length);
  const stroke = Math.max(1, median(strokes) || 1);

  for (const c of comps) {
    const t = traceSegments(c, sk, lab, g, Math.max(1, Math.min(stroke * 1.5, c.area / Math.max(1, c.skel.length))));
    c.segs = t.segs;
    c.polyLen = t.polyLen;
    c.curvyLen = t.curvyLen;
  }

  // Typical bond length: length-weighted median of the long straight segments.
  const minSeg = Math.max(8, 5 * stroke);
  const longSegs = comps.flatMap((c) => c.segs).filter((s) => s.len >= minSeg).sort((a, b) => a.len - b.len);
  let B = 0;
  if (longSegs.length > 0) {
    const totalLen = longSegs.reduce((acc, s) => acc + s.len, 0);
    let acc = 0;
    for (const s of longSegs) {
      acc += s.len;
      if (acc >= totalLen / 2) {
        B = s.len;
        break;
      }
    }
  }
  if (B === 0) B = 0.25 * Math.min(W, H);

  const dim = (c: Comp): number => Math.max(c.x1 - c.x0 + 1, c.y1 - c.y0 + 1);
  const glyphMax = 0.8 * B;
  const arrows: ArrowPx[] = [];
  const pool: Segment[] = [];
  const looseCandidates: Comp[] = [];

  for (const c of comps) {
    const size = dim(c);
    if (size >= 0.45 * B || (c.cls === 2 && size >= 0.25 * B)) {
      const arrow = detectArrow(c, sk, lab, g, stroke);
      if (arrow) {
        if (arrow.curved) {
          arrows.push(arrow);
          c.kind = "arrow";
        } else {
          c.kind = "ink"; // a straight (reaction / equilibrium) arrow
        }
        continue;
      }
    }
    const straightLen = c.segs.filter((s) => s.len >= 0.3 * B).reduce((a, s) => a + s.len, 0);
    const straight = c.polyLen > 0 && straightLen >= 0.8 * c.polyLen && c.curvyLen <= 0.2 * c.polyLen;
    // A lone straight stroke may be a free bond, a short label-to-label bond,
    // or the second line of a double bond: decided below, once the pool exists.
    const big = c.segs.filter((s) => s.len >= Math.max(3.5 * stroke, 0.22 * B));
    if (big.length === 1 && c.segs.length <= 2 && big[0]!.len >= 0.75 * c.polyLen) {
      c.kind = "line";
      looseCandidates.push(c);
      continue;
    }
    if (size > glyphMax) {
      if (straight) {
        c.kind = "bonds";
        // Short pieces are kept as connectors (they weld their two ends into
        // one vertex) so a kinked bond does not break the chain.
        for (const s of c.segs) pool.push(s);
      } else {
        c.kind = "ink";
      }
      continue;
    }
    c.kind = "glyph";
  }

  // Glyph metrics.
  const glyphHeights = comps.filter((c) => c.kind === "glyph" && c.y1 - c.y0 + 1 >= 4).map((c) => c.y1 - c.y0 + 1);
  const gh = median(glyphHeights) || 0.5 * B;
  const isTiny = (c: Comp): boolean => dim(c) < 0.3 * gh;
  const solidGlyphs = (): Comp[] => comps.filter((c) => c.kind === "glyph" && !isTiny(c));

  const unit = (s: Segment): Pt => ({ x: (s.x2 - s.x1) / s.len, y: (s.y2 - s.y1) / s.len });
  const boxDist = (c: Comp, x: number, y: number): number => {
    const dx = Math.max(c.x0 - x, 0, x - c.x1);
    const dy = Math.max(c.y0 - y, 0, y - c.y1);
    return Math.hypot(dx, dy);
  };
  /** Is `s` the second/third line of a multiple bond drawn beside `main`? */
  const isParallelPartner = (s: Segment, main: Segment): boolean => {
    if (main.len < 0.45 * B || s.len < 0.3 * main.len || s.len > 1.25 * main.len) return false;
    const us = unit(s);
    const um = unit(main);
    const cross = Math.abs(us.x * um.y - us.y * um.x);
    if (cross > 0.21) return false; // > ~12°
    const mx = (s.x1 + s.x2) / 2 - main.x1;
    const my = (s.y1 + s.y2) / 2 - main.y1;
    const perp = Math.abs(mx * um.y - my * um.x);
    if (perp < 0.8 * stroke || perp > 0.36 * B) return false;
    const t1 = (s.x1 - main.x1) * um.x + (s.y1 - main.y1) * um.y;
    const t2 = (s.x2 - main.x1) * um.x + (s.y2 - main.y1) * um.y;
    const lo = Math.max(0, Math.min(t1, t2));
    const hi = Math.min(main.len, Math.max(t1, t2));
    return hi - lo >= 0.65 * s.len;
  };

  // Resolve small free strokes: double-bond partner, short label-to-label bond,
  // or just a glyph ("l", "I", "−", …).
  const glyphsNow = solidGlyphs();
  for (const c of looseCandidates) {
    const s = c.segs.reduce((a, b) => (b.len > a.len ? b : a));
    const partner = pool.find((m) => m.comp !== c.id && isParallelPartner(s, m));
    if (partner) {
      partner.order = Math.min(3, partner.order + 1);
      c.kind = "bonds";
      continue;
    }
    const u = unit(s);
    const reach = 0.5 * B;
    const connects = (ex: number, ey: number, dx: number, dy: number): boolean => {
      for (let t = 0; t <= reach; t += Math.max(1, 0.05 * B)) {
        const x = ex + dx * t;
        const y = ey + dy * t;
        for (const gl of glyphsNow) if (boxDist(gl, x, y) <= 0.08 * B) return true;
      }
      for (const m of pool) {
        if (dist(ex, ey, m.x1, m.y1) <= 0.25 * B || dist(ex, ey, m.x2, m.y2) <= 0.25 * B) return true;
      }
      return false;
    };
    if (
      dim(c) > glyphMax ||
      (s.len >= 0.3 * B && connects(s.x1, s.y1, -u.x, -u.y) && connects(s.x2, s.y2, u.x, u.y))
    ) {
      s.loose = true;
      c.kind = "bonds";
      pool.push(s);
    } else {
      c.kind = "glyph";
    }
  }

  // Merge free-standing parallel pairs/triples (e.g. a "=" drawn between labels).
  pool.sort((a, b) => b.len - a.len);
  for (let i = 0; i < pool.length; i++) {
    const a = pool[i]!;
    if (a.dead) continue;
    for (let j = i + 1; j < pool.length; j++) {
      const b = pool[j]!;
      if (b.dead || !b.loose || a.comp === b.comp) continue;
      if (!isParallelPartner(b, a)) continue;
      b.dead = true;
      if (a.loose && a.order === 1) {
        // Two free lines: the bond axis is their mid-line.
        const flip = (b.x1 - b.x2) * (a.x1 - a.x2) + (b.y1 - b.y2) * (a.y1 - a.y2) < 0;
        const bx1 = flip ? b.x2 : b.x1, by1 = flip ? b.y2 : b.y1, bx2 = flip ? b.x1 : b.x2, by2 = flip ? b.y1 : b.y2;
        a.x1 = (a.x1 + bx1) / 2;
        a.y1 = (a.y1 + by1) / 2;
        a.x2 = (a.x2 + bx2) / 2;
        a.y2 = (a.y2 + by2) / 2;
        a.len = dist(a.x1, a.y1, a.x2, a.y2);
      }
      a.order = Math.min(3, a.order + 1);
    }
  }
  const segs = pool.filter((s) => !s.dead);

  // Labels: group neighbouring glyphs (same line, small gap; scripts included).
  const glyphs = solidGlyphs();
  const parent = glyphs.map((_c, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < glyphs.length; i++) {
    for (let j = i + 1; j < glyphs.length; j++) {
      const a = glyphs[i]!;
      const b = glyphs[j]!;
      const gapX = Math.max(a.x0 - b.x1, b.x0 - a.x1, 0);
      const gapY = Math.max(a.y0 - b.y1, b.y0 - a.y1, 0);
      if (gapX <= 0.38 * gh && gapY <= 0.12 * gh) parent[find(i)] = find(j);
    }
  }
  interface Label {
    comps: Comp[];
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    text: string;
    textBox: [number, number, number, number] | null;
    atom: number;
  }
  const labelByRoot = new Map<number, Label>();
  glyphs.forEach((c, i) => {
    const r = find(i);
    let l = labelByRoot.get(r);
    if (!l) {
      l = { comps: [], x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, text: "", textBox: null, atom: -1 };
      labelByRoot.set(r, l);
    }
    l.comps.push(c);
    l.x0 = Math.min(l.x0, c.x0);
    l.y0 = Math.min(l.y0, c.y0);
    l.x1 = Math.max(l.x1, c.x1);
    l.y1 = Math.max(l.y1, c.y1);
  });
  const labels = Array.from(labelByRoot.values()).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);

  // Attach known text; glyph components it explains are drawn as text, not ink.
  const explained = new Set<number>();
  const chars = (opts.ocrChars ?? []).map((c) => {
    const w = (c.w ?? (0.9 * gh * Math.max(1, c.text.length)) / W) * W;
    const h = (c.h ?? (1.2 * gh) / H) * H;
    return { text: c.text, cx: c.x * W, cy: c.y * H, x0: c.x * W - w / 2, x1: c.x * W + w / 2, y0: c.y * H - h / 2, y1: c.y * H + h / 2 };
  });
  for (const l of labels) {
    const inside = chars
      .filter((c) => c.cx >= l.x0 - 0.3 * gh && c.cx <= l.x1 + 0.3 * gh && c.cy >= l.y0 - 0.4 * gh && c.cy <= l.y1 + 0.4 * gh)
      .sort((a, b) => a.cx - b.cx);
    if (inside.length === 0) continue;
    const text = inside.map((c) => c.text).join("").replace(/\s+/g, "");
    if (text.length === 0) continue;
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const c of l.comps) {
      const mx = (c.x0 + c.x1) / 2;
      const my = (c.y0 + c.y1) / 2;
      const m = 0.25 * gh;
      if (inside.some((ch) => mx >= ch.x0 - m && mx <= ch.x1 + m && my >= ch.y0 - m && my <= ch.y1 + m)) {
        explained.add(c.id);
        bx0 = Math.min(bx0, c.x0);
        by0 = Math.min(by0, c.y0);
        bx1 = Math.max(bx1, c.x1 + 1);
        by1 = Math.max(by1, c.y1 + 1);
      }
    }
    if (bx1 > bx0) {
      l.text = text;
      l.textBox = [bx0, by0, bx1 - bx0, by1 - by0];
    }
  }

  // Vertices: cluster segment endpoints.
  interface EndRef {
    seg: number;
    end: 0 | 1;
    x: number;
    y: number;
  }
  const ends: EndRef[] = [];
  segs.forEach((s, i) => {
    ends.push({ seg: i, end: 0, x: s.x1, y: s.y1 }, { seg: i, end: 1, x: s.x2, y: s.y2 });
  });
  const rc = Math.max(2.5 * stroke + 1, 0.16 * B);
  const ep = ends.map((_e, i) => i);
  const efind = (i: number): number => (ep[i] === i ? i : (ep[i] = efind(ep[i]!)));
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      if (ends[i]!.seg === ends[j]!.seg) {
        // A stub shorter than a quarter bond is a kink, not a bond: weld it.
        if (segs[ends[i]!.seg]!.len < 0.25 * B) ep[efind(i)] = efind(j);
        continue;
      }
      if (dist(ends[i]!.x, ends[i]!.y, ends[j]!.x, ends[j]!.y) <= rc) ep[efind(i)] = efind(j);
    }
  }
  interface Vertex {
    x: number;
    y: number;
    n: number;
    label: number;
    ends: EndRef[];
  }
  const vertices: Vertex[] = [];
  const vertexOfRoot = new Map<number, number>();
  const vertexOfEnd: number[] = [];
  ends.forEach((e, i) => {
    const r = efind(i);
    let v = vertexOfRoot.get(r);
    if (v === undefined) {
      v = vertices.length;
      vertexOfRoot.set(r, v);
      vertices.push({ x: 0, y: 0, n: 0, label: -1, ends: [] });
    }
    const vx = vertices[v]!;
    vx.x += e.x;
    vx.y += e.y;
    vx.n++;
    vx.ends.push(e);
    vertexOfEnd[i] = v;
  });
  for (const v of vertices) {
    v.x /= v.n;
    v.y /= v.n;
  }

  // A free bond end pointing into a label bonds to that label.
  const labelDist = (l: Label, x: number, y: number): number =>
    Math.hypot(Math.max(l.x0 - x, 0, x - l.x1), Math.max(l.y0 - y, 0, y - l.y1));
  for (const v of vertices) {
    if (v.n !== 1) continue;
    const e = v.ends[0]!;
    const s = segs[e.seg]!;
    const u = unit(s);
    const dir = e.end === 0 ? { x: -u.x, y: -u.y } : u;
    let bestL = -1;
    let bestD = 0.45 * B;
    labels.forEach((l, li) => {
      const d0 = labelDist(l, v.x, v.y);
      if (d0 > bestD) return;
      const d1 = labelDist(l, v.x + dir.x * Math.min(d0, 0.3 * B), v.y + dir.y * Math.min(d0, 0.3 * B));
      if (d0 > 0.1 * B && d1 >= d0) return; // pointing away from it
      bestD = d0;
      bestL = li;
    });
    v.label = bestL;
  }

  // Atoms.
  interface AtomPx {
    element: string;
    x: number;
    y: number;
    box: [number, number, number, number] | null;
  }
  const atomsPx: AtomPx[] = [];
  const vertexAtom: number[] = [];
  vertices.forEach((v, vi) => {
    if (v.label >= 0) {
      const l = labels[v.label]!;
      if (l.atom < 0) {
        // The atom sits on the glyph the bond actually points at.
        let near = l.comps[0]!;
        let nd = Infinity;
        for (const c of l.comps) {
          const dd = boxDist(c, v.x, v.y);
          if (dd < nd) {
            nd = dd;
            near = c;
          }
        }
        l.atom = atomsPx.length;
        atomsPx.push({
          element: l.text || "?",
          x: (near.x0 + near.x1 + 1) / 2,
          y: (near.y0 + near.y1 + 1) / 2,
          box: l.textBox ?? [l.x0, l.y0, l.x1 - l.x0 + 1, l.y1 - l.y0 + 1],
        });
      }
      vertexAtom[vi] = l.atom;
    } else {
      vertexAtom[vi] = atomsPx.length;
      atomsPx.push({ element: "C", x: v.x, y: v.y, box: null });
    }
  });
  // Free-standing labels (reagents, leaving groups, captions) are atoms too, so
  // arrows can start from / land on them.
  for (const l of labels) {
    if (l.atom >= 0) continue;
    l.atom = atomsPx.length;
    atomsPx.push({
      element: l.text || "?",
      x: (l.x0 + l.x1 + 1) / 2,
      y: (l.y0 + l.y1 + 1) / 2,
      box: l.textBox ?? [l.x0, l.y0, l.x1 - l.x0 + 1, l.y1 - l.y0 + 1],
    });
  }

  // Bonds (deduplicated per atom pair).
  const bondMap = new Map<string, { a: number; b: number; order: number; len: number }>();
  segs.forEach((s, i) => {
    const a = vertexAtom[vertexOfEnd[i * 2]!]!;
    const b = vertexAtom[vertexOfEnd[i * 2 + 1]!]!;
    if (a === b) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    const prev = bondMap.get(key);
    if (prev) prev.order = Math.min(3, Math.max(prev.order, s.order));
    else bondMap.set(key, { a, b, order: s.order, len: s.len });
  });
  let bondsPx = Array.from(bondMap.values());

  // A straight 2-coordinate carbon whose two single bonds together are no longer
  // than one bond is a split bond, not an atom: fuse it away.
  for (let pass = 0; pass < 4; pass++) {
    let fused = false;
    for (let ai = 0; ai < atomsPx.length; ai++) {
      const at = atomsPx[ai]!;
      if (at.element !== "C" || at.box) continue;
      const inc = bondsPx.filter((b) => b.a === ai || b.b === ai);
      if (inc.length !== 2 || inc[0]!.order !== 1 || inc[1]!.order !== 1) continue;
      const o0 = inc[0]!.a === ai ? inc[0]!.b : inc[0]!.a;
      const o1 = inc[1]!.a === ai ? inc[1]!.b : inc[1]!.a;
      if (o0 === o1) continue;
      const p0 = atomsPx[o0]!;
      const p1 = atomsPx[o1]!;
      const v0x = p0.x - at.x, v0y = p0.y - at.y, v1x = p1.x - at.x, v1y = p1.y - at.y;
      const l0 = Math.hypot(v0x, v0y), l1 = Math.hypot(v1x, v1y);
      if (l0 < 1e-6 || l1 < 1e-6) continue;
      const cos = (v0x * v1x + v0y * v1y) / (l0 * l1);
      if (cos > -0.94 || l0 + l1 > 1.35 * B) continue;
      bondsPx = bondsPx.filter((b) => b !== inc[0] && b !== inc[1]);
      if (!bondsPx.some((b) => (b.a === o0 && b.b === o1) || (b.a === o1 && b.b === o0))) {
        bondsPx.push({ a: o0, b: o1, order: 1, len: l0 + l1 });
      }
      at.element = "";
      fused = true;
    }
    if (!fused) break;
  }

  // Ids + normalisation.
  const idOf: string[] = [];
  const atoms2D: SpatialAtom2D[] = [];
  atomsPx.forEach((a, i) => {
    if (a.element === "") {
      idOf[i] = "";
      return;
    }
    const base = a.element === "?" ? "X" : a.element.replace(/[^A-Za-z0-9+\-]/g, "") || "X";
    const id = `${base}${atoms2D.length + 1}`;
    idOf[i] = id;
    atoms2D.push({
      id,
      element: a.element,
      x: a.x / W,
      y: a.y / H,
      ...(a.box ? { labelBox: [a.box[0] / W, a.box[1] / H, a.box[2] / W, a.box[3] / H] as const } : {}),
    });
  });
  const bonds2D: SpatialBond2D[] = bondsPx.map((b) => {
    const order = (b.order >= 3 ? 3 : b.order === 2 ? 2 : 1) as 1 | 2 | 3;
    const symb = order === 2 ? "=" : order === 3 ? "#" : "-";
    return { id: `${idOf[b.a]}${symb}${idOf[b.b]}`, fromAtomId: idOf[b.a]!, toAtomId: idOf[b.b]!, order };
  });

  const rawArrows: RawCurlyArrow[] = arrows
    .sort((a, b) => a.tail.x - b.tail.x || a.tail.y - b.tail.y)
    .map((a, i) => ({
      id: `a${i + 1}`,
      tailX: a.tail.x / W, tailY: a.tail.y / H,
      headX: a.head.x / W, headY: a.head.y / H,
      ctrlX: a.mid.x / W, ctrlY: a.mid.y / H,
      c1X: a.c1.x / W, c1Y: a.c1.y / H,
      c2X: a.c2.x / W, c2Y: a.c2.y / H,
      barb: a.barb,
    }));

  // Everything not turned into a bond, a read label or a curly arrow is ink.
  const ink: string[] = [];
  for (const c of comps) {
    if (c.kind === "bonds" || c.kind === "arrow") continue;
    if (c.kind === "glyph" && explained.has(c.id)) continue;
    ink.push(traceInk(c, g));
  }

  const lens = bondsPx.map((b) => dist(atomsPx[b.a]!.x, atomsPx[b.a]!.y, atomsPx[b.b]!.x, atomsPx[b.b]!.y));
  return {
    atoms2D,
    bonds2D,
    rawArrows,
    ink,
    inkSize: [W, H],
    aspect: W / H,
    smiles: smilesFromGraph(atoms2D, bonds2D),
    bondLengthPx: median(lens),
  };
}
