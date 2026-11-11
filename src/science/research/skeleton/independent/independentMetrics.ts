/**
 * FEAT-005C metrics.
 *
 * Unlike FEAT-005B's historical metrics, vertex correspondence here uses a
 * maximum-cardinality, minimum-distance one-to-one assignment (Hungarian
 * algorithm). The edit metric is explicitly a mapped edit count, not
 * unrestricted minimum graph-edit distance.
 */
import { cycleRank, degrees, type Edge } from "../../../skeleton/graphAnalysis";
import { compareGraphs, type SimpleGraph } from "../graphCompare";
import type { CarbonSkeletonResult, Point } from "../../../skeleton/types";
import type { AggregateMetrics, EvaluationMetrics, GroundTruthGraph, PrecisionRecall } from "../realworld/metrics";

function prf(tp: number, fp: number, fn: number): PrecisionRecall {
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { truePositives: tp, falsePositives: fp, falseNegatives: fn, precision, recall, f1 };
}

function hungarian(cost: readonly (readonly number[])[]): number[] {
  const n = cost.length;
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(n + 1).fill(0);
  const p = new Array<number>(n + 1).fill(0);
  const way = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(n + 1).fill(Infinity);
    const used = new Array<boolean>(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity, j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }
  const assignment = new Array<number>(n).fill(-1);
  for (let j = 1; j <= n; j++) assignment[p[j] - 1] = j - 1;
  return assignment;
}

export function matchVerticesOptimal(
  predicted: readonly Point[],
  groundTruth: readonly Point[],
  tolerance: number,
): number[] {
  const np = predicted.length, ng = groundTruth.length;
  if (np === 0) return [];
  if (ng === 0) return new Array<number>(np).fill(-1);
  const n = np + ng;
  const unmatched = tolerance + 1e-6;
  const forbidden = unmatched * 1000 + 1;
  const cost = Array.from({ length: n }, () => new Array<number>(n).fill(0));

  for (let p = 0; p < np; p++) {
    for (let g = 0; g < ng; g++) {
      const d = Math.hypot(predicted[p].x - groundTruth[g].x, predicted[p].y - groundTruth[g].y);
      cost[p][g] = d <= tolerance ? d : forbidden;
    }
    for (let d = 0; d < np; d++) cost[p][ng + d] = d === p ? unmatched : forbidden;
  }
  for (let g = 0; g < ng; g++) {
    for (let gg = 0; gg < ng; gg++) cost[np + g][gg] = gg === g ? unmatched : forbidden;
    for (let d = 0; d < np; d++) cost[np + g][ng + d] = 0;
  }

  const assignment = hungarian(cost);
  return assignment.slice(0, np).map((j, p) =>
    j >= 0 && j < ng && cost[p][j] <= tolerance ? j : -1,
  );
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export function evaluateIndependent(
  result: CarbonSkeletonResult,
  gt: GroundTruthGraph,
  tolerance: number,
): EvaluationMetrics {
  const predicted = result.atoms.map((a) => ({ x: a.x, y: a.y }));
  const predToGt = matchVerticesOptimal(predicted, gt.atoms, tolerance);
  const matched = predToGt.filter((g) => g >= 0).length;
  const vertex = prf(matched, predicted.length - matched, gt.atoms.length - matched);

  const gtBonds = new Set(gt.bonds.map(([a, b]) => edgeKey(a, b)));
  const predBonds = new Set<string>();
  for (const b of result.bonds) {
    const a = predToGt[b.source], c = predToGt[b.target];
    predBonds.add(a >= 0 && c >= 0 ? edgeKey(a, c) : `X:${b.source}:${b.target}`);
  }
  let tp = 0;
  for (const e of predBonds) if (gtBonds.has(e)) tp++;
  const bond = prf(tp, predBonds.size - tp, gtBonds.size - tp);

  const predEdges: Edge[] = result.bonds.map((b) => ({ a: b.source, b: b.target }));
  const gtEdges: Edge[] = gt.bonds.map(([a, b]) => ({ a, b }));
  const exact = compareGraphs(
    { vertexCount: gt.atoms.length, edges: gtEdges } as SimpleGraph,
    { vertexCount: result.atoms.length, edges: predEdges } as SimpleGraph,
  ).isomorphic;

  const predDeg = [...degrees(result.atoms.length, predEdges)].sort((a, b) => a - b);
  const gtDeg = [...degrees(gt.atoms.length, gtEdges)].sort((a, b) => a - b);

  return {
    exact,
    vertex,
    bond,
    graphEditDistance:
      (predicted.length - matched) +
      (gt.atoms.length - matched) +
      (predBonds.size - tp) +
      (gtBonds.size - tp),
    cycleRankExpected: gt.expectedCycleRank,
    cycleRankActual: cycleRank(result.atoms.length, predEdges),
    cycleRankCorrect: cycleRank(result.atoms.length, predEdges) === gt.expectedCycleRank,
    branchTopologyCorrect: predDeg.length === gtDeg.length && predDeg.every((d, i) => d === gtDeg[i]),
    gtVertices: gt.atoms.length,
    gtBonds: gt.bonds.length,
    predVertices: result.atoms.length,
    predBonds: result.bonds.length,
    predToGt,
  };
}

export function aggregateIndependent(metrics: readonly EvaluationMetrics[]): AggregateMetrics {
  const n = metrics.length;
  if (!n) return {
    count: 0, exactRate: 0, vertexF1: 0, bondF1: 0,
    vertexPrecision: 0, vertexRecall: 0, bondPrecision: 0, bondRecall: 0,
    meanGraphEditDistance: 0, cycleRankAccuracy: 0, branchTopologyAccuracy: 0,
  };
  const sum = (f: (m: EvaluationMetrics) => number) => metrics.reduce((s, m) => s + f(m), 0);
  return {
    count: n,
    exactRate: sum((m) => m.exact ? 1 : 0) / n,
    vertexF1: sum((m) => m.vertex.f1) / n,
    bondF1: sum((m) => m.bond.f1) / n,
    vertexPrecision: sum((m) => m.vertex.precision) / n,
    vertexRecall: sum((m) => m.vertex.recall) / n,
    bondPrecision: sum((m) => m.bond.precision) / n,
    bondRecall: sum((m) => m.bond.recall) / n,
    meanGraphEditDistance: sum((m) => m.graphEditDistance) / n,
    cycleRankAccuracy: sum((m) => m.cycleRankCorrect ? 1 : 0) / n,
    branchTopologyAccuracy: sum((m) => m.branchTopologyCorrect ? 1 : 0) / n,
  };
}
