/**
 * FEAT-005 — graph comparison for benchmarking a reconstructed carbon skeleton
 * against a known ground-truth graph.
 *
 * Carbon-skeleton graphs are plain undirected graphs where all vertices are the
 * same label (carbon), so topological equality is GRAPH ISOMORPHISM. For the
 * sizes in the test corpus (<= ~20 vertices), an exact isomorphism check with
 * degree-sequence + refinement pruning is fast and correct. We also expose the
 * coarser invariants the spec asks to preserve (vertex count, edge count,
 * degree sequence, cycle rank) so failures can be diagnosed, not just detected.
 */

import { cycleRank, degrees, type Edge } from "./graphAnalysis";

export interface SimpleGraph {
  readonly vertexCount: number;
  readonly edges: readonly Edge[];
}

export interface GraphComparison {
  readonly isomorphic: boolean;
  readonly sameVertexCount: boolean;
  readonly sameEdgeCount: boolean;
  readonly sameDegreeSequence: boolean;
  readonly sameCycleRank: boolean;
  /** Per-invariant expected/actual, for failure analysis. */
  readonly expected: GraphInvariants;
  readonly actual: GraphInvariants;
  readonly mismatches: string[];
}

export interface GraphInvariants {
  readonly vertices: number;
  readonly edges: number;
  readonly degreeSequence: number[];
  readonly cycleRank: number;
}

export function invariants(g: SimpleGraph): GraphInvariants {
  const deg = degrees(g.vertexCount, g.edges);
  return {
    vertices: g.vertexCount,
    edges: dedupeCount(g.edges),
    degreeSequence: [...deg].sort((a, b) => a - b),
    cycleRank: cycleRank(g.vertexCount, g.edges),
  };
}

function dedupeCount(edges: readonly Edge[]): number {
  const seen = new Set<string>();
  for (const e of edges) {
    if (e.a === e.b) continue;
    seen.add(e.a < e.b ? `${e.a}:${e.b}` : `${e.b}:${e.a}`);
  }
  return seen.size;
}

function adjMatrix(g: SimpleGraph): boolean[][] {
  const m = Array.from({ length: g.vertexCount }, () =>
    new Array<boolean>(g.vertexCount).fill(false),
  );
  for (const e of g.edges) {
    if (e.a === e.b) continue;
    (m[e.a] as boolean[])[e.b] = true;
    (m[e.b] as boolean[])[e.a] = true;
  }
  return m;
}

/**
 * Exact isomorphism test via backtracking with degree-compatibility pruning.
 * Suitable for the small graphs in the corpus. Returns true iff there is a
 * bijection of vertices mapping edges to edges.
 */
export function isIsomorphic(g1: SimpleGraph, g2: SimpleGraph): boolean {
  if (g1.vertexCount !== g2.vertexCount) return false;
  if (dedupeCount(g1.edges) !== dedupeCount(g2.edges)) return false;

  const n = g1.vertexCount;
  const d1 = degrees(n, g1.edges);
  const d2 = degrees(n, g2.edges);
  if ([...d1].sort().join(",") !== [...d2].sort().join(",")) return false;

  const a1 = adjMatrix(g1);
  const a2 = adjMatrix(g2);

  const mapping = new Array<number>(n).fill(-1);
  const used = new Array<boolean>(n).fill(false);

  // Order g1 vertices by descending degree for earlier pruning.
  const deg1 = (i: number): number => d1[i] as number;
  const deg2 = (i: number): number => d2[i] as number;
  const order = [...Array(n).keys()].sort((x, y) => deg1(y) - deg1(x));
  const row1 = (i: number): boolean[] => a1[i] as boolean[];
  const row2 = (i: number): boolean[] => a2[i] as boolean[];

  const backtrack = (pos: number): boolean => {
    if (pos === n) return true;
    const u = order[pos] as number;
    for (let v = 0; v < n; v++) {
      if (used[v] || deg2(v) !== deg1(u)) continue;
      // Consistency: for every already-mapped g1 vertex w, edge(u,w) must match
      // edge(v, mapping[w]).
      let ok = true;
      for (let p = 0; p < pos; p++) {
        const w = order[p] as number;
        if (row1(u)[w] !== row2(v)[mapping[w] as number]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      mapping[u] = v;
      used[v] = true;
      if (backtrack(pos + 1)) return true;
      used[v] = false;
      mapping[u] = -1;
    }
    return false;
  };

  return backtrack(0);
}

/** Full comparison report: isomorphism + per-invariant diffs. */
export function compareGraphs(expected: SimpleGraph, actual: SimpleGraph): GraphComparison {
  const ei = invariants(expected);
  const ai = invariants(actual);
  const mismatches: string[] = [];
  const sameVertexCount = ei.vertices === ai.vertices;
  const sameEdgeCount = ei.edges === ai.edges;
  const sameDegreeSequence =
    ei.degreeSequence.length === ai.degreeSequence.length &&
    ei.degreeSequence.every((d, i) => d === ai.degreeSequence[i]);
  const sameCycleRank = ei.cycleRank === ai.cycleRank;

  if (!sameVertexCount) mismatches.push(`vertices: expected ${ei.vertices}, got ${ai.vertices}`);
  if (!sameEdgeCount) mismatches.push(`edges: expected ${ei.edges}, got ${ai.edges}`);
  if (!sameDegreeSequence)
    mismatches.push(
      `degree sequence: expected [${ei.degreeSequence}], got [${ai.degreeSequence}]`,
    );
  if (!sameCycleRank)
    mismatches.push(`cycle rank: expected ${ei.cycleRank}, got ${ai.cycleRank}`);

  const iso =
    sameVertexCount && sameEdgeCount && sameDegreeSequence && sameCycleRank
      ? isIsomorphic(expected, actual)
      : false;
  if (
    !iso &&
    sameVertexCount &&
    sameEdgeCount &&
    sameDegreeSequence &&
    sameCycleRank
  ) {
    mismatches.push("invariants match but graphs are not isomorphic (topology differs)");
  }

  return {
    isomorphic: iso,
    sameVertexCount,
    sameEdgeCount,
    sameDegreeSequence,
    sameCycleRank,
    expected: ei,
    actual: ai,
    mismatches,
  };
}
