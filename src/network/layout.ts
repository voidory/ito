/**
 * Deterministic force-directed layout engine for the concept network.
 *
 * This module is PURE: no DOM, no React, no Three.js, no imports from
 * src/model or src/app. It operates on plain numeric inputs so the hard
 * physics can be proven in isolation (Vitest) and reused by later rendering
 * features.
 *
 * Determinism (acceptance A09-M2): every stochastic choice goes through a
 * SEEDED PRNG (mulberry32), never Math.random, so identical (graph, seed)
 * inputs yield byte-identical output across runs. Light damping guarantees the
 * system converges rather than oscillating, so there are no "unexpected snaps".
 *
 * Category attraction (acceptance A10-M2): in addition to node repulsion and
 * spring attraction along links, every node feels one attraction force per
 * category it belongs to, pulling it toward that category's centroid. A node in
 * multiple categories is therefore pulled toward each centroid and settles in
 * the overlap region (roughly the average of its categories' centroids).
 */

/** A 2D point. */
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/** Graph input node: an id, a start position, and its category membership. */
export interface LayoutNode {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly categoryIds: readonly string[];
}

/** An undirected link between two node ids. */
export interface LayoutLink {
  readonly sourceId: string;
  readonly targetId: string;
}

/** The immutable graph description handed to the layout engine. */
export interface LayoutGraph {
  readonly nodes: readonly LayoutNode[];
  readonly links: readonly LayoutLink[];
}

/** Tunable force parameters. All have documented defaults. */
export interface LayoutParams {
  /** Node-node repulsion strength (Coulomb-like, 1/r^2). */
  readonly repulsion: number;
  /** Spring (link) stiffness (Hooke-like). */
  readonly springStiffness: number;
  /** Natural rest length of a link spring. */
  readonly springLength: number;
  /** Strength of the pull toward each category centroid (A10-M2). */
  readonly categoryAttraction: number;
  /** Velocity retention per step in [0,1); < 1 so energy bleeds off. */
  readonly damping: number;
  /** Integration time step. */
  readonly timeStep: number;
  /** Minimum separation used to avoid singular 1/r^2 at r -> 0. */
  readonly minDistance: number;
}

/** Default force parameters tuned for small-to-medium concept graphs. */
export const DEFAULT_LAYOUT_PARAMS: LayoutParams = {
  repulsion: 2000,
  springStiffness: 0.08,
  springLength: 120,
  categoryAttraction: 0.02,
  damping: 0.85,
  timeStep: 0.9,
  minDistance: 1,
};

/** Mutable per-node simulation body. */
export interface Body {
  readonly id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  readonly categoryIds: readonly string[];
}

/** The full mutable simulation state threaded through layoutStep. */
export interface LayoutState {
  readonly bodies: readonly Body[];
  readonly links: readonly LayoutLink[];
}

/** Final positions keyed by node id. */
export type Positions = Readonly<Record<string, Vec2>>;

/**
 * mulberry32: a tiny, fast, well-distributed seeded PRNG. Deterministic for a
 * given 32-bit seed. Returns a function yielding floats in [0, 1).
 */
export function createPrng(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a fresh simulation state from a graph. Node start positions are jittered
 * by a seeded PRNG so coincident inputs separate deterministically (two nodes
 * sharing the exact same start would otherwise feel no repulsion direction).
 */
export function createLayoutState(graph: LayoutGraph, seed: number): LayoutState {
  const prng = createPrng(seed);
  const bodies: Body[] = graph.nodes.map((n) => ({
    id: n.id,
    // Deterministic sub-pixel jitter keeps the sim from stalling on exact ties
    // while leaving the caller-provided layout essentially intact.
    x: n.x + (prng() - 0.5) * 0.01,
    y: n.y + (prng() - 0.5) * 0.01,
    vx: 0,
    vy: 0,
    categoryIds: n.categoryIds,
  }));
  return { bodies, links: graph.links };
}

/** Compute the centroid of each category from the current body positions. */
function categoryCentroids(bodies: readonly Body[]): Map<string, Vec2> {
  const sums = new Map<string, { x: number; y: number; count: number }>();
  for (const b of bodies) {
    for (const c of b.categoryIds) {
      const acc = sums.get(c) ?? { x: 0, y: 0, count: 0 };
      acc.x += b.x;
      acc.y += b.y;
      acc.count += 1;
      sums.set(c, acc);
    }
  }
  const centroids = new Map<string, Vec2>();
  for (const [c, acc] of sums) {
    centroids.set(c, { x: acc.x / acc.count, y: acc.y / acc.count });
  }
  return centroids;
}

/**
 * Advance the simulation by one deterministic step, returning a NEW state. The
 * input state is not mutated, so callers can snapshot/compare freely.
 */
export function layoutStep(state: LayoutState, params: LayoutParams): LayoutState {
  const bodies = state.bodies;
  const n = bodies.length;
  const fx = new Array<number>(n).fill(0);
  const fy = new Array<number>(n).fill(0);

  // 1) Pairwise repulsion (Coulomb-like, ~1/r^2).
  for (let i = 0; i < n; i++) {
    const bi = bodies[i]!;
    for (let j = i + 1; j < n; j++) {
      const bj = bodies[j]!;
      let dx = bi.x - bj.x;
      let dy = bi.y - bj.y;
      let distSq = dx * dx + dy * dy;
      const minSq = params.minDistance * params.minDistance;
      if (distSq < minSq) distSq = minSq;
      const dist = Math.sqrt(distSq);
      const force = params.repulsion / distSq;
      dx /= dist;
      dy /= dist;
      fx[i]! += dx * force;
      fy[i]! += dy * force;
      fx[j]! -= dx * force;
      fy[j]! -= dy * force;
    }
  }

  // Index lookup for links.
  const indexById = new Map<string, number>();
  for (let i = 0; i < n; i++) indexById.set(bodies[i]!.id, i);

  // 2) Spring attraction along links (Hooke-like toward rest length).
  for (const link of state.links) {
    const si = indexById.get(link.sourceId);
    const ti = indexById.get(link.targetId);
    if (si === undefined || ti === undefined) continue;
    const bs = bodies[si]!;
    const bt = bodies[ti]!;
    let dx = bt.x - bs.x;
    let dy = bt.y - bs.y;
    let dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < params.minDistance) dist = params.minDistance;
    const displacement = dist - params.springLength;
    const force = params.springStiffness * displacement;
    dx /= dist;
    dy /= dist;
    fx[si]! += dx * force;
    fy[si]! += dy * force;
    fx[ti]! -= dx * force;
    fy[ti]! -= dy * force;
  }

  // 3) Category attraction toward each membership's centroid (A10-M2). A node
  //    in two categories is pulled toward both, settling in the overlap.
  const centroids = categoryCentroids(bodies);
  for (let i = 0; i < n; i++) {
    const b = bodies[i]!;
    for (const c of b.categoryIds) {
      const centroid = centroids.get(c);
      if (centroid === undefined) continue;
      fx[i]! += (centroid.x - b.x) * params.categoryAttraction;
      fy[i]! += (centroid.y - b.y) * params.categoryAttraction;
    }
  }

  // 4) Integrate with damping so kinetic energy bleeds off (no oscillation).
  const next: Body[] = bodies.map((b, i) => {
    const vx = (b.vx + fx[i]! * params.timeStep) * params.damping;
    const vy = (b.vy + fy[i]! * params.timeStep) * params.damping;
    return {
      id: b.id,
      x: b.x + vx * params.timeStep,
      y: b.y + vy * params.timeStep,
      vx,
      vy,
      categoryIds: b.categoryIds,
    };
  });

  return { bodies: next, links: state.links };
}

/** Options for runLayout. */
export interface RunLayoutOptions {
  readonly iterations: number;
  readonly seed: number;
  readonly params?: Partial<LayoutParams>;
}

/** Extract the current positions from a layout state. */
export function statePositions(state: LayoutState): Positions {
  const out: Record<string, Vec2> = {};
  for (const b of state.bodies) out[b.id] = { x: b.x, y: b.y };
  return out;
}

/**
 * Run the deterministic simulation for a fixed number of iterations and return
 * final positions. Identical (graph, seed, iterations, params) inputs produce
 * byte-identical output.
 */
export function runLayout(graph: LayoutGraph, options: RunLayoutOptions): Positions {
  const params: LayoutParams = { ...DEFAULT_LAYOUT_PARAMS, ...options.params };
  let state = createLayoutState(graph, options.seed);
  for (let i = 0; i < options.iterations; i++) {
    state = layoutStep(state, params);
  }
  return statePositions(state);
}

/**
 * Total kinetic energy of a state — useful for convergence assertions: a
 * converged system has near-zero kinetic energy (no perpetual motion/snaps).
 */
export function kineticEnergy(state: LayoutState): number {
  let sum = 0;
  for (const b of state.bodies) sum += b.vx * b.vx + b.vy * b.vy;
  return sum;
}
