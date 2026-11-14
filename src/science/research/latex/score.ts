/**
 * Scoring for the LaTeX extraction benchmark: exact structural match plus a
 * normalised tree edit distance for partial credit, and the aggregation the
 * report and the CI gate read. Pure; see normalize.ts for what "same" means.
 */

import { constructsOf, parseLatex, serialize, treeSize, type TexNode } from "./normalize";

/** The score of one extracted equation against its ground truth. */
export interface EquationScore {
  /** The canonical trees are identical. */
  readonly exact: boolean;
  /** 1 - (tree edit distance / larger tree size), in [0, 1]. */
  readonly similarity: number;
  /** Constructs the ground truth exercises (see `constructsOf`). */
  readonly constructs: readonly string[];
}

/**
 * Ordered tree edit distance (Zhang & Shasha, 1989) with unit costs for
 * insert, delete and relabel.
 */
export function treeEditDistance(a: TexNode, b: TexNode): number {
  const index = (root: TexNode): { labels: string[]; lml: number[]; keyroots: number[] } => {
    const labels: string[] = [];
    const lml: number[] = [];
    const walk = (n: TexNode): number => {
      let first = -1;
      for (const c of n.c) {
        const l = walk(c);
        if (first < 0) first = l;
      }
      const id = labels.length;
      labels.push(n.t);
      lml.push(first < 0 ? id : first);
      return lml[id]!;
    };
    walk(root);
    // A keyroot is the highest node for each distinct leftmost leaf.
    const seen = new Set<number>();
    const keyroots: number[] = [];
    for (let i = labels.length - 1; i >= 0; i--) {
      if (!seen.has(lml[i]!)) {
        seen.add(lml[i]!);
        keyroots.push(i);
      }
    }
    keyroots.sort((x, y) => x - y);
    return { labels, lml, keyroots };
  };
  const A = index(a);
  const B = index(b);
  const n = A.labels.length;
  const m = B.labels.length;
  const td: number[][] = Array.from({ length: n }, () => new Array<number>(m).fill(0));

  for (const i of A.keyroots) {
    for (const j of B.keyroots) {
      const li = A.lml[i]!;
      const lj = B.lml[j]!;
      const rows = i - li + 2;
      const cols = j - lj + 2;
      const fd: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
      for (let x = 1; x < rows; x++) fd[x]![0] = fd[x - 1]![0]! + 1;
      for (let y = 1; y < cols; y++) fd[0]![y] = fd[0]![y - 1]! + 1;
      for (let x = 1; x < rows; x++) {
        for (let y = 1; y < cols; y++) {
          const ai = li + x - 1;
          const bj = lj + y - 1;
          const del = fd[x - 1]![y]! + 1;
          const ins = fd[x]![y - 1]! + 1;
          if (A.lml[ai] === li && B.lml[bj] === lj) {
            const rel = fd[x - 1]![y - 1]! + (A.labels[ai] === B.labels[bj] ? 0 : 1);
            fd[x]![y] = Math.min(del, ins, rel);
            td[ai]![bj] = fd[x]![y]!;
          } else {
            const sub = fd[A.lml[ai]! - li]![B.lml[bj]! - lj]! + td[ai]![bj]!;
            fd[x]![y] = Math.min(del, ins, sub);
          }
        }
      }
    }
  }
  return td[n - 1]![m - 1]!;
}

/** Score one extraction. An empty extraction scores zero similarity. */
export function scoreEquation(groundTruth: string, extracted: string): EquationScore {
  const gt = parseLatex(groundTruth);
  const constructs = constructsOf(gt);
  if (extracted.trim().length === 0) return { exact: false, similarity: 0, constructs };
  const out = parseLatex(extracted);
  if (serialize(gt) === serialize(out)) return { exact: true, similarity: 1, constructs };
  const d = treeEditDistance(gt, out);
  const similarity = Math.max(0, 1 - d / Math.max(treeSize(gt), treeSize(out)));
  return { exact: false, similarity, constructs };
}

/** Accuracy over a set of scored equations. */
export interface Tally {
  readonly n: number;
  readonly exact: number;
  /** exact / n (0 when empty). */
  readonly exactRate: number;
  readonly meanSimilarity: number;
}

export function tally(scores: readonly EquationScore[]): Tally {
  const n = scores.length;
  const exact = scores.filter((s) => s.exact).length;
  const sim = scores.reduce((acc, s) => acc + s.similarity, 0);
  return { n, exact, exactRate: n > 0 ? exact / n : 0, meanSimilarity: n > 0 ? sim / n : 0 };
}

/** Accuracy per construct tag, most frequent first (ties by name). */
export function tallyByConstruct(scores: readonly EquationScore[]): [string, Tally][] {
  const groups = new Map<string, EquationScore[]>();
  for (const s of scores) {
    for (const c of s.constructs) {
      const g = groups.get(c);
      if (g) g.push(s);
      else groups.set(c, [s]);
    }
  }
  return [...groups.entries()]
    .map(([c, g]): [string, Tally] => [c, tally(g)])
    .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]));
}

/**
 * The largest true failure rate still consistent with what was observed, at
 * 95% confidence (exact one-sided Clopper-Pearson bound, by bisection). With
 * zero failures in n trials this is about 3/n: a corpus of 300 equations cannot
 * show a 99.9% success rate however well the extractor does.
 */
export function failureRateUpperBound(n: number, failures: number, confidence = 0.95): number {
  if (n <= 0) return 1;
  if (failures >= n) return 1;
  // P(X <= failures | p) decreases in p; find p where it equals 1 - confidence.
  const cdf = (p: number): number => {
    let term = Math.pow(1 - p, n);
    let sum = term;
    for (let k = 0; k < failures; k++) {
      term *= ((n - k) / (k + 1)) * (p / (1 - p));
      sum += term;
    }
    return sum;
  };
  let lo = failures / n;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (cdf(mid) > 1 - confidence) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** Wilson score interval for a proportion, at 95% confidence. */
export function wilsonInterval(successes: number, n: number): { lower: number; upper: number } {
  if (n <= 0) return { lower: 0, upper: 1 };
  const z = 1.959964;
  const p = successes / n;
  const centre = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
  return { lower: Math.max(0, centre - half), upper: Math.min(1, centre + half) };
}

/**
 * The gap between two success rates, a minus b, with a 95% interval
 * (Newcombe's hybrid score method, 1998, which stays sound when a rate is
 * near 0 or 1, where this benchmark is headed). The held-out report uses it:
 * an interval wholly above zero means the development corpus scores better
 * than unseen equations by more than chance explains.
 */
export function rateGapInterval(
  exactA: number,
  nA: number,
  exactB: number,
  nB: number,
): { gap: number; lower: number; upper: number } {
  const pA = nA > 0 ? exactA / nA : 0;
  const pB = nB > 0 ? exactB / nB : 0;
  const a = wilsonInterval(exactA, nA);
  const b = wilsonInterval(exactB, nB);
  const gap = pA - pB;
  return {
    gap,
    lower: gap - Math.sqrt((pA - a.lower) ** 2 + (b.upper - pB) ** 2),
    upper: gap + Math.sqrt((a.upper - pA) ** 2 + (pB - b.lower) ** 2),
  };
}

/**
 * The gap between two success rates measured on the SAME items, a minus b,
 * with a 95% interval. Only the items the two disagree on carry information:
 * `onlyA` succeeded under a alone, `onlyB` under b alone. (Wald interval on
 * the discordant counts.)
 */
export function pairedGapInterval(onlyA: number, onlyB: number, n: number): { gap: number; lower: number; upper: number } {
  if (n <= 0) return { gap: 0, lower: -1, upper: 1 };
  const z = 1.959964;
  const gap = (onlyA - onlyB) / n;
  const half = (z * Math.sqrt(Math.max(0, onlyA + onlyB - (onlyA - onlyB) ** 2 / n))) / n;
  return { gap, lower: Math.max(-1, gap - half), upper: Math.min(1, gap + half) };
}
