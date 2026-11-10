/**
 * FEAT-005B — evaluation metrics for comparing a reconstructed carbon skeleton
 * against ground truth.
 *
 * The synthetic benchmark (`../benchmark.test.ts`) scores a single boolean:
 * graph isomorphism. For real-world evaluation we need finer-grained metrics so
 * a near-miss is distinguishable from a catastrophic failure and so failures
 * can be categorised. All metrics here are deterministic.
 *
 * Because the ground-truth graph has KNOWN pixel coordinates (the corpus layout
 * scaled to device pixels), we match reconstructed atoms to ground-truth atoms
 * GEOMETRICALLY (nearest neighbour within a scale-derived tolerance, one-to-one
 * via greedy assignment on ascending distance). That mapping yields:
 *   - vertex precision / recall / F1,
 *   - bond precision / recall / F1 (an edge is correct iff BOTH of its endpoints
 *     matched AND the corresponding ground-truth edge exists),
 *   - graph edit distance (vertex + edge insert/delete count under the mapping),
 *   - cycle-rank accuracy (μ),
 *   - branch-topology accuracy (the multiset of vertex degrees matches),
 *   - exact reconstruction (isomorphism, delegated to graphCompare).
 */

import { cycleRank, degrees, type Edge } from "../graphAnalysis";
import { compareGraphs, type SimpleGraph } from "../graphCompare";
import type { CarbonSkeletonResult, Point } from "../types";

export interface GroundTruthGraph {
  /** Ground-truth atom coordinates in the SAME pixel space as the result. */
  readonly atoms: readonly Point[];
  readonly bonds: readonly (readonly [number, number])[];
  readonly expectedCycleRank: number;
}

export interface PrecisionRecall {
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
}

export interface EvaluationMetrics {
  /** Exact graph reconstruction (isomorphism) — same metric as synthetic. */
  readonly exact: boolean;
  readonly vertex: PrecisionRecall;
  readonly bond: PrecisionRecall;
  /** Graph edit distance: #(vertex + edge) edits under the geometric mapping. */
  readonly graphEditDistance: number;
  readonly cycleRankExpected: number;
  readonly cycleRankActual: number;
  readonly cycleRankCorrect: boolean;
  /** Branch topology: does the sorted degree sequence match ground truth? */
  readonly branchTopologyCorrect: boolean;
  /** Counts for quick inspection. */
  readonly gtVertices: number;
  readonly gtBonds: number;
  readonly predVertices: number;
  readonly predBonds: number;
  /** Mapping diagnostics for the visualiser: predIndex -> gtIndex (or -1). */
  readonly predToGt: readonly number[];
}

function prf(tp: number, fp: number, fn: number): PrecisionRecall {
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { truePositives: tp, falsePositives: fp, falseNegatives: fn, precision, recall, f1 };
}

/**
 * Greedy one-to-one nearest-neighbour matching of predicted atoms to
 * ground-truth atoms within `tolerance` pixels. Returns predToGt[i] = gt index
 * matched to predicted atom i, or -1 if unmatched.
 */
export function matchVertices(
  predicted: readonly Point[],
  groundTruth: readonly Point[],
  tolerance: number,
): number[] {
  interface Cand {
    p: number;
    g: number;
    d: number;
  }
  const cands: Cand[] = [];
  for (let p = 0; p < predicted.length; p++) {
    const pp = predicted[p] as Point;
    for (let g = 0; g < groundTruth.length; g++) {
      const gg = groundTruth[g] as Point;
      const d = Math.hypot(pp.x - gg.x, pp.y - gg.y);
      if (d <= tolerance) cands.push({ p, g, d });
    }
  }
  cands.sort((a, b) => a.d - b.d);
  const predToGt = new Array<number>(predicted.length).fill(-1);
  const gtUsed = new Array<boolean>(groundTruth.length).fill(false);
  for (const c of cands) {
    if (predToGt[c.p] !== -1 || gtUsed[c.g]) continue;
    predToGt[c.p] = c.g;
    gtUsed[c.g] = true;
  }
  return predToGt;
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * Compute the full metric bundle. `tolerance` is the vertex-match radius; a good
 * default is ~0.4 * bond length (so a vertex must be clearly closer to its own
 * ground-truth atom than to a neighbour).
 */
export function evaluate(
  result: CarbonSkeletonResult,
  gt: GroundTruthGraph,
  tolerance: number,
): EvaluationMetrics {
  const predPts = result.atoms.map((a) => ({ x: a.x, y: a.y }));
  const predToGt = matchVertices(predPts, gt.atoms, tolerance);

  // Vertex precision/recall from the one-to-one matching.
  const matched = predToGt.filter((g) => g >= 0).length;
  const vtp = matched;
  const vfp = predPts.length - matched; // predicted atoms with no GT match
  const vfn = gt.atoms.length - matched; // GT atoms never matched
  const vertex = prf(vtp, vfp, vfn);

  // Bond precision/recall: translate predicted bonds into GT-index space.
  const gtBondSet = new Set(gt.bonds.map(([a, b]) => edgeKey(a, b)));
  const predBondSet = new Set<string>();
  for (const b of result.bonds) {
    const ga = predToGt[b.source];
    const gb = predToGt[b.target];
    if (ga === undefined || gb === undefined || ga < 0 || gb < 0) {
      // Bond touching an unmatched (false) vertex: counts as a false positive
      // via a sentinel key so it is never a true positive.
      predBondSet.add(`X:${b.source}:${b.target}`);
    } else {
      predBondSet.add(edgeKey(ga, gb));
    }
  }
  let btp = 0;
  for (const k of predBondSet) if (gtBondSet.has(k)) btp++;
  const bfp = predBondSet.size - btp;
  const bfn = gtBondSet.size - btp;
  const bond = prf(btp, bfp, bfn);

  // Graph edit distance under the mapping: unmatched vertices (both sides) +
  // mismatched edges (both sides) each cost 1 edit.
  const vertexEdits = vfp + vfn;
  const edgeEdits = bfp + bfn;
  const graphEditDistance = vertexEdits + edgeEdits;

  // Cycle rank.
  const predEdges: Edge[] = result.bonds.map((b) => ({ a: b.source, b: b.target }));
  const cycleRankActual = cycleRank(result.atoms.length, predEdges);
  const cycleRankExpected = gt.expectedCycleRank;

  // Branch topology: sorted degree sequence equality.
  const gtEdges: Edge[] = gt.bonds.map(([a, b]) => ({ a, b }));
  const gtDeg = [...degrees(gt.atoms.length, gtEdges)].sort((a, b) => a - b);
  const predDeg = [...degrees(result.atoms.length, predEdges)].sort((a, b) => a - b);
  const branchTopologyCorrect =
    gtDeg.length === predDeg.length && gtDeg.every((d, i) => d === predDeg[i]);

  // Exact isomorphism (the same metric the synthetic benchmark uses).
  const expected: SimpleGraph = { vertexCount: gt.atoms.length, edges: gtEdges };
  const actual: SimpleGraph = {
    vertexCount: result.atoms.length,
    edges: predEdges,
  };
  const exact = compareGraphs(expected, actual).isomorphic;

  return {
    exact,
    vertex,
    bond,
    graphEditDistance,
    cycleRankExpected,
    cycleRankActual,
    cycleRankCorrect: cycleRankActual === cycleRankExpected,
    branchTopologyCorrect,
    gtVertices: gt.atoms.length,
    gtBonds: gt.bonds.length,
    predVertices: result.atoms.length,
    predBonds: result.bonds.length,
    predToGt,
  };
}

/** Aggregate many metric bundles into category / overall summary numbers. */
export interface AggregateMetrics {
  readonly count: number;
  readonly exactRate: number;
  readonly vertexF1: number;
  readonly bondF1: number;
  readonly vertexPrecision: number;
  readonly vertexRecall: number;
  readonly bondPrecision: number;
  readonly bondRecall: number;
  readonly meanGraphEditDistance: number;
  readonly cycleRankAccuracy: number;
  readonly branchTopologyAccuracy: number;
}

export function aggregate(metrics: readonly EvaluationMetrics[]): AggregateMetrics {
  const n = metrics.length;
  if (n === 0) {
    return {
      count: 0,
      exactRate: 0,
      vertexF1: 0,
      bondF1: 0,
      vertexPrecision: 0,
      vertexRecall: 0,
      bondPrecision: 0,
      bondRecall: 0,
      meanGraphEditDistance: 0,
      cycleRankAccuracy: 0,
      branchTopologyAccuracy: 0,
    };
  }
  const sum = (f: (m: EvaluationMetrics) => number): number => metrics.reduce((s, m) => s + f(m), 0);
  return {
    count: n,
    exactRate: sum((m) => (m.exact ? 1 : 0)) / n,
    vertexF1: sum((m) => m.vertex.f1) / n,
    bondF1: sum((m) => m.bond.f1) / n,
    vertexPrecision: sum((m) => m.vertex.precision) / n,
    vertexRecall: sum((m) => m.vertex.recall) / n,
    bondPrecision: sum((m) => m.bond.precision) / n,
    bondRecall: sum((m) => m.bond.recall) / n,
    meanGraphEditDistance: sum((m) => m.graphEditDistance) / n,
    cycleRankAccuracy: sum((m) => (m.cycleRankCorrect ? 1 : 0)) / n,
    branchTopologyAccuracy: sum((m) => (m.branchTopologyCorrect ? 1 : 0)) / n,
  };
}
