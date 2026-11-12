/**
 * FEAT-005 — graph-theoretic ring / branch / component analysis.
 *
 * Operates on an abstract undirected graph (vertex count + undirected edge
 * list). Everything here is deterministic graph theory, independent of the
 * image pipeline, so it is reusable and independently testable.
 *
 *   - {@link connectedComponents} — union-find over edges.
 *   - {@link cycleRank}           — μ = E − V + C (first Betti number).
 *   - {@link minimumCycleBasis}   — a set of μ independent rings, found by the
 *                                   fundamental cycle of each non-tree edge.
 *   - {@link verticesInCycles}    — atoms lying on at least one ring.
 *   - {@link branchVertices}      — degree-based branch (junction) detection.
 */

export interface Edge {
  readonly a: number;
  readonly b: number;
}

/** Build an adjacency list for `vertexCount` vertices from undirected edges. */
export function adjacency(vertexCount: number, edges: readonly Edge[]): number[][] {
  const adj: number[][] = Array.from({ length: vertexCount }, () => []);
  for (const e of edges) {
    if (e.a === e.b) continue;
    (adj[e.a] as number[]).push(e.b);
    (adj[e.b] as number[]).push(e.a);
  }
  return adj;
}

/** Connected components as arrays of vertex ids (sorted ascending within each). */
export function connectedComponents(
  vertexCount: number,
  edges: readonly Edge[],
): number[][] {
  const parent = Array.from({ length: vertexCount }, (_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while ((parent[r] as number) !== r) r = parent[r] as number;
    while ((parent[x] as number) !== r) {
      const n = parent[x] as number;
      parent[x] = r;
      x = n;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (const e of edges) union(e.a, e.b);
  const groups = new Map<number, number[]>();
  for (let i = 0; i < vertexCount; i++) {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  }
  return [...groups.values()].map((g) => g.sort((x, y) => x - y));
}

/** Count of connected components (including singletons). */
export function componentCount(vertexCount: number, edges: readonly Edge[]): number {
  return connectedComponents(vertexCount, edges).length;
}

/**
 * Cycle rank (circuit rank / first Betti number): μ = E − V + C, where C is the
 * number of connected components. μ equals the number of independent cycles.
 */
export function cycleRank(vertexCount: number, edges: readonly Edge[]): number {
  const uniqueEdges = dedupeEdges(edges);
  const C = componentCount(vertexCount, uniqueEdges);
  return uniqueEdges.length - vertexCount + C;
}

/** Remove duplicate undirected edges and self-loops. */
export function dedupeEdges(edges: readonly Edge[]): Edge[] {
  const seen = new Set<string>();
  const out: Edge[] = [];
  for (const e of edges) {
    if (e.a === e.b) continue;
    const k = e.a < e.b ? `${e.a}:${e.b}` : `${e.b}:${e.a}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ a: Math.min(e.a, e.b), b: Math.max(e.a, e.b) });
  }
  return out;
}

/**
 * Compute a cycle basis: build a BFS spanning forest, then for each non-tree
 * edge (u,v) form one fundamental cycle from the tree path u..v plus that edge.
 * The number of such cycles equals the cycle rank. For clean skeletal drawings
 * (each ring contributes exactly one back-edge) these are the smallest rings;
 * fused systems yield one ring per independent cycle (naphthalene -> 2).
 * Each returned cycle is an ordered list of vertex ids.
 */
export function minimumCycleBasis(
  vertexCount: number,
  edges: readonly Edge[],
): number[][] {
  const uniq = dedupeEdges(edges);
  const adj = adjacency(vertexCount, uniq);

  const parent = new Array<number>(vertexCount).fill(-1);
  const depth = new Array<number>(vertexCount).fill(-1);
  const visited = new Array<boolean>(vertexCount).fill(false);
  const treeEdge = new Set<string>();
  const ek = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);

  for (let s = 0; s < vertexCount; s++) {
    const adjS = adj[s] as number[];
    if (visited[s] || adjS.length === 0) continue;
    visited[s] = true;
    depth[s] = 0;
    const queue: number[] = [s];
    let head = 0;
    while (head < queue.length) {
      const u = queue[head++] as number;
      for (const v of adj[u] as number[]) {
        if (!visited[v]) {
          visited[v] = true;
          parent[v] = u;
          depth[v] = (depth[u] as number) + 1;
          treeEdge.add(ek(u, v));
          queue.push(v);
        }
      }
    }
  }

  const cycles: number[][] = [];
  for (const e of uniq) {
    if (treeEdge.has(ek(e.a, e.b))) continue;
    cycles.push(fundamentalCycle(e.a, e.b, parent, depth));
  }

  cycles.sort((x, y) => x.length - y.length);
  const seen = new Set<string>();
  const result: number[][] = [];
  for (const c of cycles) {
    const kc = [...c].sort((a, b) => a - b).join(",");
    if (seen.has(kc)) continue;
    seen.add(kc);
    result.push(c);
  }
  return result;
}

function fundamentalCycle(
  a: number,
  b: number,
  parent: readonly number[],
  depth: readonly number[],
): number[] {
  const up: number[] = [];
  const down: number[] = [];
  let x = a;
  let y = b;
  const d = (i: number): number => depth[i] as number;
  const par = (i: number): number => parent[i] as number;
  while (d(x) > d(y)) {
    up.push(x);
    x = par(x);
  }
  while (d(y) > d(x)) {
    down.push(y);
    y = par(y);
  }
  while (x !== y) {
    up.push(x);
    down.push(y);
    x = par(x);
    y = par(y);
  }
  const lca = x;
  return [...up, lca, ...down.reverse()];
}

/** Set of vertices that lie on at least one cycle of the basis. */
export function verticesInCycles(
  vertexCount: number,
  edges: readonly Edge[],
): Set<number> {
  const inCycle = new Set<number>();
  for (const cyc of minimumCycleBasis(vertexCount, edges)) {
    for (const v of cyc) inCycle.add(v);
  }
  return inCycle;
}

/** Degree of each vertex (over deduped edges). */
export function degrees(vertexCount: number, edges: readonly Edge[]): number[] {
  const d = new Array<number>(vertexCount).fill(0);
  for (const e of dedupeEdges(edges)) {
    d[e.a] = (d[e.a] as number) + 1;
    d[e.b] = (d[e.b] as number) + 1;
  }
  return d;
}

/** Branch (junction) vertices: degree >= 3. */
export function branchVertices(
  vertexCount: number,
  edges: readonly Edge[],
): number[] {
  const d = degrees(vertexCount, edges);
  const out: number[] = [];
  for (let i = 0; i < vertexCount; i++) if ((d[i] as number) >= 3) out.push(i);
  return out;
}

/** Endpoint (terminal) vertices: degree === 1. */
export function endpointVertices(
  vertexCount: number,
  edges: readonly Edge[],
): number[] {
  const d = degrees(vertexCount, edges);
  const out: number[] = [];
  for (let i = 0; i < vertexCount; i++) if ((d[i] as number) === 1) out.push(i);
  return out;
}

/**
 * Trace substituent chains hanging off a set of ring vertices: starting from
 * each non-ring neighbour of a ring vertex, walk the acyclic branch until a
 * terminal / junction is reached, returning each branch as an ordered list of
 * vertex ids (excluding the ring vertex itself).
 */
export function ringSubstituentChains(
  vertexCount: number,
  edges: readonly Edge[],
  ringVertices: ReadonlySet<number>,
): number[][] {
  const adj = adjacency(vertexCount, dedupeEdges(edges));
  const chains: number[][] = [];
  for (const rv of ringVertices) {
    for (const start of adj[rv] as number[]) {
      if (ringVertices.has(start)) continue; // ring-ring bond, not a substituent
      const chain: number[] = [];
      let prev = rv;
      let curr = start;
      const guard = new Set<number>([rv]);
      while (true) {
        chain.push(curr);
        guard.add(curr);
        const next = (adj[curr] as number[]).filter((n) => n !== prev && !guard.has(n));
        if (next.length !== 1) break; // terminal or branch point ends the chain
        prev = curr;
        curr = next[0] as number;
      }
      chains.push(chain);
    }
  }
  return chains;
}
