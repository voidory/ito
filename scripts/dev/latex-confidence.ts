// Fit and check the confidence model (src/pdf/equationConfidence.ts).
//
//   npx vite-node scripts/dev/latex-confidence.ts fit <dir>      fit on the survey rows in <dir>, write the model,
//                                                                 and report the development and held-out sets
//   npx vite-node scripts/dev/latex-confidence.ts sealed         apply the frozen model to the sealed set, aggregate only
//
// <dir> holds the output of latex-evidence.ts: survey-real-display.jsonl,
// survey-real-inline.jsonl, and dev-/heldout- copies of both.
//
// The order is the point. The model is fitted on the survey papers only. The
// trust line is chosen on the survey too, from predictions made for each paper
// by a model that never saw it. The development and held-out sets are then
// scored with everything frozen, and only after that, once, the sealed set.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FEATURES, assessEvidence, type ConfidenceModel } from "../../src/pdf/equationConfidence";
import type { EquationEvidence } from "../../src/pdf/equationEvidence";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL_PATH = resolve(HERE, "../../src/pdf/equationConfidenceModel.json");
const PRECISION_GOAL = 0.98;
const LAMBDA = 2;

interface Row {
  readonly tier: string;
  readonly paper: string;
  readonly ok: boolean;
  readonly evidence: EquationEvidence;
}
const load = (path: string): Row[] =>
  existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row) : [];

const vector = (e: EquationEvidence): number[] => FEATURES.map((f) => f.extract(e));
const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/** Logistic regression for P(exact), L2 on the weights and not the bias, by Newton's method. */
function fit(rows: readonly Row[]): ConfidenceModel {
  const k = FEATURES.length + 1;
  const n = rows.length;
  const X = new Float64Array(n * k);
  const y = new Float64Array(n);
  rows.forEach((r, i) => {
    X[i * k] = 1;
    vector(r.evidence).forEach((v, j) => (X[i * k + j + 1] = v));
    y[i] = r.ok ? 1 : 0;
  });
  const pos = y.reduce((a, b) => a + b, 0);
  const w = new Float64Array(k);
  w[0] = Math.log(pos / (n - pos));
  // The penalised negative log-likelihood, for backtracking.
  const loss = (v: Float64Array): number => {
    let total = 0;
    for (let i = 0; i < n; i++) {
      let z = 0;
      for (let j = 0; j < k; j++) z += v[j]! * X[i * k + j]!;
      total += Math.log1p(Math.exp(-Math.abs(z))) + Math.max(0, y[i]! > 0 ? -z : z);
    }
    for (let a = 1; a < k; a++) total += 0.5 * LAMBDA * v[a]! * v[a]!;
    return total;
  };
  let current = loss(w);
  for (let iter = 0; iter < 60; iter++) {
    const g = new Float64Array(k);
    const H = new Float64Array(k * k);
    for (let i = 0; i < n; i++) {
      let z = 0;
      for (let j = 0; j < k; j++) z += w[j]! * X[i * k + j]!;
      const p = sigmoid(z);
      const r = p - y[i]!;
      const v = p * (1 - p);
      for (let a = 0; a < k; a++) {
        const xa = X[i * k + a]!;
        if (xa === 0) continue;
        g[a]! += r * xa;
        for (let b = a; b < k; b++) H[a * k + b]! += v * xa * X[i * k + b]!;
      }
    }
    const Hm: number[][] = Array.from({ length: k }, (_, a) => Array.from({ length: k }, (_, b) => (b >= a ? H[a * k + b]! : H[b * k + a]!)));
    const gv = Array.from(g);
    for (let a = 1; a < k; a++) {
      gv[a]! += LAMBDA * w[a]!;
      Hm[a]![a]! += LAMBDA;
    }
    // A touch of ridge on the bias keeps the system well conditioned.
    Hm[0]![0]! += 1e-6;
    const step = solve(Hm, gv);
    let scale = 1;
    let next = new Float64Array(k);
    for (let tries = 0; tries < 30; tries++) {
      next = Float64Array.from(w, (wj, j) => wj - scale * step[j]!);
      const l = loss(next);
      if (l <= current) {
        current = l;
        break;
      }
      scale /= 2;
    }
    let size = 0;
    for (let a = 0; a < k; a++) size = Math.max(size, Math.abs(next[a]! - w[a]!));
    w.set(next);
    if (size < 1e-6) break;
  }
  return { bias: w[0]!, weights: Object.fromEntries(FEATURES.map((f, i) => [f.name, w[i + 1]!])) };
}

/** Solve A x = b by Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    [M[c], M[p]] = [M[p]!, M[c]!];
    for (let r = c + 1; r < n; r++) {
      const f = M[r]![c]! / M[c]![c]!;
      for (let j = c; j <= n; j++) M[r]![j]! -= f * M[c]![j]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r]![n]!;
    for (let j = r + 1; j < n; j++) s -= M[r]![j]! * x[j]!;
    x[r] = s / M[r]![r]!;
  }
  return x;
}

const predict = (m: ConfidenceModel, e: EquationEvidence): number => assessEvidence(e, m).confidence;

/** Area under the ROC curve, for ranking exact drafts above wrong ones. */
function auc(scored: readonly { p: number; ok: boolean }[]): number {
  const sorted = [...scored].sort((a, b) => a.p - b.p);
  let rank = 0;
  let sum = 0;
  let pos = 0;
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j < sorted.length && sorted[j]!.p === sorted[i]!.p) j++;
    const mid = (i + j + 1) / 2;
    for (let t = i; t < j; t++) if (sorted[t]!.ok) (sum += mid, pos++);
    rank = j;
    i = j;
  }
  void rank;
  const neg = sorted.length - pos;
  return (sum - (pos * (pos + 1)) / 2) / (pos * neg);
}

/** Accept everything at or above `trust`: how much, and how right. */
function accepted(scored: readonly { p: number; ok: boolean }[], trust: number): { n: number; share: number; precision: number; caught: number; wrongTotal: number } {
  const take = scored.filter((s) => s.p >= trust);
  const wrong = scored.filter((s) => !s.ok).length;
  const wrongKept = take.filter((s) => !s.ok).length;
  return {
    n: take.length,
    share: take.length / scored.length,
    precision: take.length > 0 ? 1 - wrongKept / take.length : 1,
    caught: wrong > 0 ? 1 - wrongKept / wrong : 1,
    wrongTotal: wrong,
  };
}

const pct = (v: number): string => `${(100 * v).toFixed(1)}%`;

function report(name: string, scored: { p: number; ok: boolean }[], trust: number): void {
  const a = accepted(scored, trust);
  const base = scored.filter((s) => s.ok).length / scored.length;
  const brier = scored.reduce((s, r) => s + (r.p - (r.ok ? 1 : 0)) ** 2, 0) / scored.length;
  console.log(
    `${name.padEnd(26)} n=${String(scored.length).padStart(5)}  exact ${pct(base).padStart(6)}  AUC ${auc(scored).toFixed(3)}  Brier ${brier.toFixed(4)}  ` +
      `trusted ${pct(a.share).padStart(6)} at ${pct(a.precision).padStart(6)} exact  ` +
      `review ${pct(1 - a.share).padStart(6)} holds ${pct(a.caught).padStart(6)} of the ${a.wrongTotal} wrong`,
  );
}

const mode = process.argv[2];
if (mode === "fit") {
  const dir = process.argv[3]!;
  const train = [...load(`${dir}/survey-real-display.jsonl`), ...load(`${dir}/survey-real-inline.jsonl`)];
  // Out-of-fold predictions, folds by paper: the trust line is chosen on
  // predictions the model made for papers it was not fitted on.
  console.log(`loaded ${train.length} rows`);
  const papers = [...new Set(train.map((r) => r.paper))].sort();
  const fold = new Map(papers.map((p, i) => [p, i % 5]));
  const oof: { p: number; ok: boolean; kind: string }[] = [];
  for (let f = 0; f < 5; f++) {
    console.time(`fold ${f}`);
    const m = fit(train.filter((r) => fold.get(r.paper) !== f));
    console.timeEnd(`fold ${f}`);
    for (const r of train) if (fold.get(r.paper) === f) oof.push({ p: predict(m, r.evidence), ok: r.ok, kind: r.tier });
  }
  let trust = 0.5;
  for (let t = 0.5; t <= 0.999; t += 0.001) {
    // Each kind of box must meet the goal on its own: a pooled figure would let
    // the easy inline formulas cover for the display equations.
    const kinds = [...new Set(oof.map((o) => o.kind))];
    if (kinds.every((kind) => accepted(oof.filter((o) => o.kind === kind), t).precision >= PRECISION_GOAL)) {
      trust = t;
      break;
    }
  }
  const model = fit(train);
  writeFileSync(MODEL_PATH, JSON.stringify({ ...model, trustAt: Math.round(trust * 1000) / 1000 }, null, 2) + "\n");
  const frozen = JSON.parse(readFileSync(MODEL_PATH, "utf8")) as ConfidenceModel & { trustAt: number };
  console.log(`trust line ${frozen.trustAt} (chosen so that, out of fold, accepted drafts are at least ${pct(PRECISION_GOAL)} exact in display and in inline)\n`);
  report("survey, out of fold", oof, frozen.trustAt);
  for (const set of ["survey", "dev", "heldout"]) {
    for (const kind of ["display", "inline"]) {
      const rows = load(`${dir}/${set}-real-${kind}.jsonl`);
      if (rows.length === 0) continue;
      const scored = rows.map((r) => ({ p: predict(frozen, r.evidence), ok: r.ok }));
      report(`${set} ${kind}${set === "survey" ? " (fitted)" : ""}`, scored, frozen.trustAt);
    }
  }
  if (process.env.ITO_CURVE) {
    // What each trust line would buy: share of boxes trusted, and how right they are.
    console.log("\ntrust line -> share trusted / exact among trusted, out of fold on survey, then held out");
    const held = (kind: string): { p: number; ok: boolean }[] => load(`${dir}/heldout-real-${kind}.jsonl`).map((r) => ({ p: predict(frozen, r.evidence), ok: r.ok }));
    for (const t of [0.8, 0.9, 0.95, 0.97, 0.98, 0.987, 0.99]) {
      const cells = ["display", "inline"].map((kind) => {
        const o = accepted(oof.filter((x) => x.kind === `real-${kind}`), t);
        const h = accepted(held(kind), t);
        return `${kind}: ${pct(o.share).padStart(6)} / ${pct(o.precision).padStart(6)}   held out ${pct(h.share).padStart(6)} / ${pct(h.precision).padStart(6)}`;
      });
      console.log(`  ${t.toFixed(3)}  ${cells.join("   |   ")}`);
    }
  }
  if (process.env.ITO_WORST) {
    // The survey drafts the model was most sure of and that were wrong: what the evidence cannot see.
    const out = readFileSync(`${dir}/survey-real-display.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row & { id: string });
    const worst = out.filter((r) => !r.ok).map((r) => ({ id: r.id, p: predict(frozen, r.evidence) })).sort((a, b) => b.p - a.p).slice(0, Number(process.env.ITO_WORST));
    writeFileSync(process.env.ITO_WORST_FILE ?? "/dev/stdout", worst.map((w) => `${w.id} ${w.p.toFixed(3)}`).join("\n") + "\n");
  }
  console.log("\nweights:");
  for (const [k, v] of Object.entries(frozen.weights).sort((a, b) => a[1] - b[1])) console.log(`  ${k.padEnd(20)} ${v.toFixed(2)}`);
} else if (mode === "sealed") {
  // One look, aggregate only: no row, no id, no per-feature count leaves this branch.
  const { buildPageMathModel } = await import("../../src/pdf/pageMathModel");
  const { analyzeModelRegion } = await import("../../src/pdf/equationEvidence");
  const { scoreEquation } = await import("../../src/science/research/latex/score");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const frozen = JSON.parse(readFileSync(MODEL_PATH, "utf8")) as ConfidenceModel & { trustAt: number };
  const root = resolve(HERE, "../../src/science/research/latex/corpus-sealed");
  const manifest = JSON.parse(readFileSync(`${root}/manifest.json`, "utf8"));
  for (const name of ["real-display", "real-inline"]) {
    const tier = manifest.tiers[name];
    const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(`${root}/${tier.pdf}`)), verbosity: 0 }).promise;
    const models = new Map<number, Awaited<ReturnType<typeof buildPageMathModel>>>();
    const scored: { p: number; ok: boolean }[] = [];
    for (const [id, pageIndex, x0, y0, x1, y1] of tier.placements) {
      let model = models.get(pageIndex);
      if (!model) {
        const page = await doc.getPage(pageIndex + 1);
        model = buildPageMathModel(await page.getOperatorList(), (f: string) => page.commonObjs.get(f), pdfjs.OPS as never, page.getViewport({ scale: 1 }));
        models.set(pageIndex, model);
        if (models.size > 4) models.delete(models.keys().next().value!);
      }
      const { latex, evidence } = analyzeModelRegion(model, { x: x0 / tier.pageWidth, y: (tier.pageHeight - y1) / tier.pageHeight, width: (x1 - x0) / tier.pageWidth, height: (y1 - y0) / tier.pageHeight });
      scored.push({ p: predict(frozen, evidence), ok: scoreEquation(manifest.equations[id], latex).exact });
    }
    report(`sealed ${name.replace("real-", "")}`, scored, frozen.trustAt);
  }
} else {
  console.error("usage: latex-confidence.ts fit <dir> | sealed");
  process.exit(1);
}
