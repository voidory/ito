/**
 * FEAT-005C — independent-renderer validation.
 *
 * PubChem supplies the molecule identity/SMILES; RDKit supplies an independent
 * 2D drawing/layout. The locked SVG source is bundled in corpusBundle.ts.
 * Ground-truth carbon graphs come from the molecular graph, not from Ito's
 * renderer. The SVG bond paths are rasterised deterministically in TypeScript,
 * so evaluation requires no Python, network or additional runtime dependency.
 *
 * This is an independent-renderer benchmark, NOT a scanned-textbook benchmark.
 */
import { gunzipSync, strFromU8 } from "fflate";
import { reconstructCarbonSkeleton } from "../carbonSkeleton";
import type { CarbonSkeletonResult, GrayImage, Point } from "../types";
import { aggregateIndependent, evaluateIndependent } from "./independentMetrics";
import type { EvaluationMetrics } from "../realworld/metrics";
import type { GroundTruthGraph } from "../realworld/metrics";
import { INDEPENDENT_CORPUS_B64 } from "./corpusBundle";

interface Entry {
  file: string; name: string; source: "PubChem"; cid: number; smiles: string;
  category: string; split: "evaluation"; atoms: [number, number][];
  bonds: [number, number][]; expectedCycleRank: number; bondLengthPx: number;
  hasLabels: boolean;
}
interface Bundle { svgs: Record<string, string>; manifest: { count: number; variants: Entry[] } }

export interface IndependentCase {
  readonly entry: Entry;
  readonly result: CarbonSkeletonResult;
  readonly metrics: EvaluationMetrics;
}
export interface IndependentReport {
  readonly cases: IndependentCase[];
  readonly aggregate: ReturnType<typeof aggregateIndependent>;
  readonly byCategory: Record<string, ReturnType<typeof aggregateIndependent>>;
}

let cachedBundle: Bundle | undefined;
function loadBundle(): Bundle {
  if (cachedBundle) return cachedBundle;
  const bytes = Uint8Array.from(atob(INDEPENDENT_CORPUS_B64), (c) => c.charCodeAt(0));
  cachedBundle = JSON.parse(strFromU8(gunzipSync(bytes))) as Bundle;
  return cachedBundle;
}

function parseBondPaths(svg: string): { x0: number; y0: number; x1: number; y1: number; width: number }[] {
  const paths: { x0: number; y0: number; x1: number; y1: number; width: number }[] = [];
  const pathRe = /<path\s+[^>]*class=['"]bond-[^'"]+['"][^>]*d=['"]([^'"]+)['"][^>]*style=['"]([^'"]+)['"][^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = pathRe.exec(svg))) {
    const coords = [...m[1].matchAll(/[ML]\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/g)]
      .map((x) => [Number(x[1]), Number(x[2])] as [number, number]);
    const sw = Number((m[2].match(/stroke-width:([\d.]+)px/) ?? [])[1] ?? 2);
    for (let i = 1; i < coords.length; i++) {
      const [x0, y0] = coords[i - 1];
      const [x1, y1] = coords[i];
      paths.push({ x0, y0, x1, y1, width: sw });
    }
  }
  return paths;
}

export function rasterizeIndependentSvg(svg: string, width = 420, height = 320): GrayImage {
  const SS = 3;
  const W = width * SS, H = height * SS;
  const hi = new Uint8Array(W * H);
  const stamp = (cx: number, cy: number, radius: number) => {
    const x0 = Math.max(0, Math.floor(cx - radius));
    const x1 = Math.min(W - 1, Math.ceil(cx + radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const y1 = Math.min(H - 1, Math.ceil(cy + radius));
    const r2 = radius * radius;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r2) hi[y * W + x] = 1;
    }
  };
  for (const p of parseBondPaths(svg)) {
    const x0 = p.x0 * SS, y0 = p.y0 * SS, x1 = p.x1 * SS, y1 = p.y1 * SS;
    const dx = x1 - x0, dy = y1 - y0;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy)));
    const radius = (p.width * SS) / 2;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      stamp(x0 + dx * t, y0 + dy * t, radius);
    }
  }
  const data = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let ink = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      ink += hi[(y * SS + sy) * W + (x * SS + sx)];
    }
    data[y * width + x] = Math.round(255 * (1 - ink / (SS * SS)));
  }
  return { width, height, data };
}

export function evaluateIndependentEntry(entry: Entry, svg: string): IndependentCase {
  const result = reconstructCarbonSkeleton(rasterizeIndependentSvg(svg));
  const gt: GroundTruthGraph = {
    atoms: entry.atoms.map(([x, y]) => ({ x, y }) as Point),
    bonds: entry.bonds.map(([a, b]) => [a, b] as [number, number]),
    expectedCycleRank: entry.expectedCycleRank,
  };
  const metrics = evaluateIndependent(result, gt, entry.bondLengthPx * 0.35);
  return { entry, result, metrics };
}

export function runIndependentBenchmark(): IndependentReport {
  const { svgs, manifest } = loadBundle();
  const cases = manifest.variants.map((entry) => evaluateIndependentEntry(entry, svgs[entry.file] as string));
  const byCategory: Record<string, IndependentCase[]> = {};
  for (const c of cases) (byCategory[c.entry.category] ??= []).push(c);
  const categoryReports: Record<string, ReturnType<typeof aggregateIndependent>> = {};
  for (const [k, v] of Object.entries(byCategory)) categoryReports[k] = aggregateIndependent(v.map((x) => x.metrics));
  return { cases, aggregate: aggregateIndependent(cases.map((x) => x.metrics)), byCategory: categoryReports };
}

export function independentCorpusSize(): number {
  return loadBundle().manifest.count;
}
