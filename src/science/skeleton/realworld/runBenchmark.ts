/**
 * FEAT-005B — the reproducible real-world benchmark runner.
 *
 * Loads the rendered PNG corpus + `variants.json` (produced by the Python
 * renderer from the TypeScript single-source-of-truth), decodes each PNG with
 * the pure-TS {@link decodePngToGray}, runs the EXISTING reconstruction pipeline
 * unchanged, scores it with {@link evaluate}, and classifies any failure with
 * {@link classifyFailure}. Everything here is deterministic and runs under
 * vitest/Node without a DOM.
 *
 * Results are reported SEPARATELY by structural category and by robustness
 * transform, and the development / evaluation split is respected so the
 * held-out set can be reported on its own.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { reconstructCarbonSkeleton } from "../carbonSkeleton";
import type { CarbonSkeletonResult, Point } from "../types";
import { decodePngToGray } from "./pngDecode";
import {
  aggregate,
  evaluate,
  type AggregateMetrics,
  type EvaluationMetrics,
  type GroundTruthGraph,
} from "./metrics";
import {
  classifyFailure,
  type FailureCategory,
  type FailureClassification,
} from "./failureAnalysis";

export interface VariantEntry {
  readonly file: string;
  readonly name: string;
  readonly transform: string;
  readonly category: string;
  readonly split: "development" | "evaluation";
  readonly atoms: [number, number][];
  readonly bonds: [number, number][];
  readonly expectedCycleRank: number;
  readonly bondLengthPx: number;
  readonly hasLabels?: boolean;
}

export interface VariantsManifest {
  readonly count: number;
  readonly variants: VariantEntry[];
}

export interface EvaluatedCase {
  readonly entry: VariantEntry;
  readonly result: CarbonSkeletonResult;
  readonly metrics: EvaluationMetrics;
  readonly failure: FailureClassification | null;
  readonly groundTruth: GroundTruthGraph;
  readonly grayWidth: number;
  readonly grayHeight: number;
}

const FIXTURES_DIR = resolve(__dirname, "..", "fixtures", "realworld");

export function fixturesDir(): string {
  return FIXTURES_DIR;
}

export function hasRenderedCorpus(): boolean {
  return existsSync(resolve(FIXTURES_DIR, "variants.json"));
}

export function loadVariantsManifest(): VariantsManifest {
  const path = resolve(FIXTURES_DIR, "variants.json");
  return JSON.parse(readFileSync(path, "utf8")) as VariantsManifest;
}

/** Decode + reconstruct + score one corpus entry. */
export function evaluateEntry(entry: VariantEntry): EvaluatedCase {
  const bytes = new Uint8Array(readFileSync(resolve(FIXTURES_DIR, "png", entry.file)));
  const gray = decodePngToGray(bytes);
  const result = reconstructCarbonSkeleton(gray);

  const groundTruth: GroundTruthGraph = {
    atoms: entry.atoms.map(([x, y]) => ({ x, y }) as Point),
    bonds: entry.bonds.map(([a, b]) => [a, b] as [number, number]),
    expectedCycleRank: entry.expectedCycleRank,
  };

  // Vertex-match tolerance: 0.45 * bond length, scaled for transforms that
  // shrink the drawing (lowres keeps size; rotation keeps bond length).
  const tolerance = entry.bondLengthPx * 0.45;
  const metrics = evaluate(result, groundTruth, tolerance);

  const failure = metrics.exact
    ? null
    : classifyFailure(result, groundTruth, metrics, {
        transform: entry.transform,
        hasLabels: Boolean(entry.hasLabels),
        lineWidth: inferLineWidth(entry),
      });

  return {
    entry,
    result,
    metrics,
    failure,
    groundTruth,
    grayWidth: gray.width,
    grayHeight: gray.height,
  };
}

function inferLineWidth(entry: VariantEntry): number {
  if (entry.transform === "thick") return 6;
  if (entry.transform === "thin") return 1;
  return 3;
}

export interface CategoryReport {
  readonly category: string;
  readonly aggregate: AggregateMetrics;
}

export interface TransformReport {
  readonly transform: string;
  readonly aggregate: AggregateMetrics;
}

export interface BenchmarkReport {
  readonly all: EvaluatedCase[];
  readonly baseCases: EvaluatedCase[];
  readonly evaluationBaseCases: EvaluatedCase[];
  readonly developmentBaseCases: EvaluatedCase[];
  readonly overallBase: AggregateMetrics;
  readonly evaluationBase: AggregateMetrics;
  readonly developmentBase: AggregateMetrics;
  readonly byCategory: CategoryReport[];
  readonly byTransform: TransformReport[];
  readonly failureCounts: Record<string, number>;
  readonly failureSamples: { category: FailureCategory; cases: string[] }[];
}

/** Evaluate the whole corpus and build the structured report. */
export function runBenchmark(): BenchmarkReport {
  const manifest = loadVariantsManifest();
  const all = manifest.variants.map(evaluateEntry);

  const baseCases = all.filter((c) => c.entry.transform === "base");
  const evaluationBaseCases = baseCases.filter((c) => c.entry.split === "evaluation");
  const developmentBaseCases = baseCases.filter((c) => c.entry.split === "development");

  const byCategoryMap = new Map<string, EvaluatedCase[]>();
  for (const c of baseCases) {
    const arr = byCategoryMap.get(c.entry.category) ?? [];
    arr.push(c);
    byCategoryMap.set(c.entry.category, arr);
  }
  const byCategory: CategoryReport[] = [...byCategoryMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([category, cases]) => ({ category, aggregate: aggregate(cases.map((c) => c.metrics)) }));

  const byTransformMap = new Map<string, EvaluatedCase[]>();
  for (const c of all) {
    const arr = byTransformMap.get(c.entry.transform) ?? [];
    arr.push(c);
    byTransformMap.set(c.entry.transform, arr);
  }
  const transformOrder = [
    "base",
    "rot15",
    "rot30",
    "skew",
    "jpegish",
    "gauss",
    "saltpepper",
    "thin",
    "thick",
    "lowres",
    "contrast",
  ];
  const byTransform: TransformReport[] = [...byTransformMap.entries()]
    .sort((a, b) => transformOrder.indexOf(a[0]) - transformOrder.indexOf(b[0]))
    .map(([transform, cases]) => ({ transform, aggregate: aggregate(cases.map((c) => c.metrics)) }));

  const failureCounts: Record<string, number> = {};
  const failureSamplesMap = new Map<FailureCategory, string[]>();
  for (const c of all) {
    if (!c.failure) continue;
    failureCounts[c.failure.category] = (failureCounts[c.failure.category] ?? 0) + 1;
    const arr = failureSamplesMap.get(c.failure.category) ?? [];
    if (arr.length < 6) arr.push(`${c.entry.name}${c.entry.transform === "base" ? "" : "__" + c.entry.transform}`);
    failureSamplesMap.set(c.failure.category, arr);
  }
  const failureSamples = [...failureSamplesMap.entries()].map(([category, cases]) => ({ category, cases }));

  return {
    all,
    baseCases,
    evaluationBaseCases,
    developmentBaseCases,
    overallBase: aggregate(baseCases.map((c) => c.metrics)),
    evaluationBase: aggregate(evaluationBaseCases.map((c) => c.metrics)),
    developmentBase: aggregate(developmentBaseCases.map((c) => c.metrics)),
    byCategory,
    byTransform,
    failureCounts,
    failureSamples,
  };
}
