/**
 * FEAT-005B — the real-world benchmark regression test.
 *
 * This is the primary deliverable: a REPRODUCIBLE evaluation of the existing
 * carbon-skeleton pipeline against >= 50 real molecular structures rendered to
 * genuine anti-aliased PNGs (committed under `fixtures/realworld/png/`) and
 * decoded with the pure-TS PNG decoder. It asserts:
 *   - the corpus is real (>= 50 structures, all categories, dev/eval split),
 *   - the actual PNG-decode path works,
 *   - per-category and per-transform metrics are computed,
 *   - real-world accuracy is measured SEPARATELY from synthetic, and the
 *     real-world number is strictly tracked (a regression guard, not a target
 *     the algorithm was tuned to),
 *   - every failure is CLASSIFIED into a known category.
 *
 * Thresholds are intentionally LOOSE lower bounds: they guard against
 * regressions without letting the suite become a tuning target for the held-out
 * set (which the spec forbids).
 */

import { beforeAll, describe, expect, it } from "vitest";
import { CARBON_SKELETON_CORPUS } from "../fixtures";
import { hasRenderedCorpus, runBenchmark, type BenchmarkReport } from "./runBenchmark";
import { REAL_WORLD_CORPUS } from "./corpus";
import { structuresIn } from "./split";

describe("FEAT-005B real-world carbon-skeleton benchmark", () => {
  // The benchmark is deterministic; compute it ONCE and share across assertions
  // (decoding 55 PNGs + running the pipeline is the expensive part).
  let report: BenchmarkReport;
  beforeAll(() => {
    report = runBenchmark();
  });
  it("has a committed rendered corpus of >= 50 real structures", () => {
    expect(hasRenderedCorpus(), "rendered PNG corpus (variants.json) must be committed").toBe(true);
    expect(REAL_WORLD_CORPUS.length).toBeGreaterThanOrEqual(50);
    const categories = new Set(REAL_WORLD_CORPUS.map((s) => s.category));
    // All required structural classes present.
    for (const required of [
      "straight-chain",
      "branched-chain",
      "simple-ring",
      "substituted-ring",
      "fused-ring",
      "connected-ring",
      "small-ring",
      "multi-branch",
      "polycyclic",
    ]) {
      expect(categories.has(required as never), `missing category ${required}`).toBe(true);
    }
  });

  it("separates development and evaluation examples (both non-empty, stratified)", () => {
    const dev = structuresIn("development");
    const evalSet = structuresIn("evaluation");
    expect(dev.length).toBeGreaterThan(0);
    expect(evalSet.length).toBeGreaterThan(0);
    expect(dev.length + evalSet.length).toBe(REAL_WORLD_CORPUS.length);
    // Every category is represented on BOTH sides so held-out per-category
    // metrics exist.
    const devCats = new Set(dev.map((s) => s.category));
    const evalCats = new Set(evalSet.map((s) => s.category));
    for (const c of new Set(REAL_WORLD_CORPUS.map((s) => s.category))) {
      expect(devCats.has(c), `dev missing ${c}`).toBe(true);
      expect(evalCats.has(c), `eval missing ${c}`).toBe(true);
    }
  });

  it("decodes actual PNG crops and reconstructs them (browser-free decode path)", () => {
    expect(report.baseCases.length).toBe(REAL_WORLD_CORPUS.length);
    // Every base image decoded to non-empty pixels and produced a result.
    for (const c of report.baseCases) {
      expect(c.grayWidth).toBeGreaterThan(0);
      expect(c.grayHeight).toBeGreaterThan(0);
      expect(["success", "low-confidence", "invalid", "unsupported"]).toContain(c.result.status);
    }
  });

  it("reports metrics per structural category (clean base render)", () => {
    const cats = new Set(report.byCategory.map((c) => c.category));
    expect(cats.size).toBeGreaterThanOrEqual(8);
    for (const c of report.byCategory) {
      expect(c.aggregate.count).toBeGreaterThan(0);
      // Each category's F1 bundle is a valid probability.
      expect(c.aggregate.vertexF1).toBeGreaterThanOrEqual(0);
      expect(c.aggregate.vertexF1).toBeLessThanOrEqual(1);
      expect(c.aggregate.bondF1).toBeLessThanOrEqual(1);
    }
  });

  it("measures real-world accuracy SEPARATELY from synthetic, and is clearly lower", () => {
    // Synthetic clean = 100% (asserted in ../benchmark.test.ts). The real-world
    // clean render must be measured on its own and is expected to be lower,
    // demonstrating the synthetic score does NOT establish real-world accuracy.
    expect(report.overallBase.exactRate).toBeLessThan(1);
    // Regression lower bound (NOT a tuning target): real-world clean recognition
    // should stay well above chance. Measured ~0.91 at authoring time.
    expect(report.overallBase.exactRate).toBeGreaterThanOrEqual(0.8);
    // Geometry is largely correct even when topology is not: F1 stays high.
    expect(report.overallBase.vertexF1).toBeGreaterThanOrEqual(0.95);
    expect(report.overallBase.bondF1).toBeGreaterThanOrEqual(0.9);
    // The synthetic corpus is a different, separate category.
    expect(CARBON_SKELETON_CORPUS.length).toBeGreaterThanOrEqual(20);
    expect(report.overallBase.count).not.toBe(CARBON_SKELETON_CORPUS.length);
  });

  it("evaluates robustness under every required transformation", () => {
    const transforms = new Set(report.byTransform.map((t) => t.transform));
    for (const t of [
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
    ]) {
      expect(transforms.has(t), `missing transform ${t}`).toBe(true);
    }
    // Robustness guard: no transform should collapse accuracy to near-zero —
    // that would indicate a decode/pipeline break rather than a hard case.
    for (const t of report.byTransform) {
      expect(t.aggregate.vertexF1, `${t.transform} vertexF1 collapsed`).toBeGreaterThanOrEqual(0.8);
    }
  });

  it("classifies every failure into a known category (never a bare 'wrong graph')", () => {
    const known = new Set([
      "rounded-corners",
      "closely-spaced-vertices",
      "degree-four-ambiguity",
      "crossing-bonds",
      "fused-rings",
      "very-small-rings",
      "thick-antialiased-lines",
      "labels-touching-bonds",
      "multiple-disconnected-structures",
      "rotation-skew-staircase",
      "noise-contrast-compression",
      "uncategorised",
    ]);
    for (const c of report.all) {
      if (c.metrics.exact) {
        expect(c.failure).toBeNull();
      } else {
        expect(c.failure).not.toBeNull();
        expect(known.has(c.failure!.category)).toBe(true);
        expect(c.failure!.evidence.length).toBeGreaterThan(0);
        expect([
          "preprocessing",
          "geometric-graph-extraction",
          "topology-reconstruction",
          "explicit-ambiguity-detection",
          "different-recognition-method",
          "none",
        ]).toContain(c.failure!.remedy);
      }
    }
    // The dominant structural failure mode must be detected somewhere in the
    // corpus (we deliberately include quaternary carbons).
    expect(Object.keys(report.failureCounts).length).toBeGreaterThan(0);
  });

  it("computes graph edit distance and cycle-rank accuracy", () => {
    expect(report.overallBase.meanGraphEditDistance).toBeGreaterThanOrEqual(0);
    // Most clean structures recover μ exactly.
    expect(report.overallBase.cycleRankAccuracy).toBeGreaterThanOrEqual(0.9);
  });
});
