/**
 * FEAT-005 — opt-in artifact generator for the carbon-skeleton corpus.
 *
 * Fixtures are defined ONCE in TypeScript (`fixtures.ts`), which is the single
 * source of truth for both the tests and the on-disk SVG / ground-truth
 * artifacts. Running with ITO_WRITE_SKELETON_FIXTURES=1 writes, under
 * `src/science/research/skeleton/fixtures/`:
 *   - <name>.svg            : the skeletal drawing (for visual inspection / docs)
 *   - ground-truth.json     : every fixture's ground-truth carbon graph
 *
 *   ITO_WRITE_SKELETON_FIXTURES=1 npx vitest run src/science/research/skeleton/fixtures.artifacts
 *
 * Without the env flag the suite is a no-op assertion, so it never slows the
 * normal test run or writes during CI.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CARBON_SKELETON_CORPUS,
  fixtureGroundTruth,
  fixtureToSvg,
  rasterizeFixture,
  type SkeletonFixture,
} from "./fixtures";
import { reconstructCarbonSkeleton } from "../../skeleton/carbonSkeleton";
import { compareGraphs } from "./graphCompare";
import { rasterizeSegments } from "../../skeleton/raster";
import type { GrayImage, Point } from "../../skeleton/types";

const WRITE = process.env.ITO_WRITE_SKELETON_FIXTURES === "1";

describe("carbon-skeleton fixture artifacts", () => {
  it(WRITE ? "writes SVG + ground-truth artifacts" : "is a no-op unless opted in", () => {
    if (!WRITE) {
      expect(CARBON_SKELETON_CORPUS.length).toBeGreaterThanOrEqual(20);
      return;
    }
    const here = dirname(fileURLToPath(import.meta.url));
    const outDir = resolve(here, "fixtures");
    mkdirSync(outDir, { recursive: true });

    const groundTruth: Record<string, unknown> = {};
    for (const f of CARBON_SKELETON_CORPUS) {
      writeFileSync(resolve(outDir, `${f.name}.svg`), fixtureToSvg(f), "utf8");
      const gt = fixtureGroundTruth(f);
      groundTruth[f.name] = {
        description: f.description,
        category: f.category,
        vertices: gt.vertexCount,
        edges: gt.edges.map((e) => [e.a, e.b]),
        expectedCycleRank: f.expectedCycleRank,
      };
    }
    writeFileSync(
      resolve(outDir, "ground-truth.json"),
      JSON.stringify(groundTruth, null, 2) + "\n",
      "utf8",
    );
    expect(Object.keys(groundTruth).length).toBe(CARBON_SKELETON_CORPUS.length);

    // Also (re)generate the benchmark report from the same source of truth.
    writeFileSync(resolve(here, "BENCHMARK.md"), buildBenchmarkReport(), "utf8");
  });
});

// --- Benchmark report generation (shared source of truth) -----------------

interface RenderConfig {
  label: string;
  radius: number;
  antialias: boolean;
  rotateDeg?: number;
}

const REPORT_CONFIGS: RenderConfig[] = [
  { label: "crisp-1px", radius: 0.8, antialias: false },
  { label: "antialiased", radius: 1.6, antialias: true },
  { label: "thick-2.4px", radius: 2.4, antialias: true },
  { label: "rot-30deg", radius: 1.6, antialias: true, rotateDeg: 30 },
  { label: "rot-45deg", radius: 1.6, antialias: true, rotateDeg: 45 },
];

function renderFixture(f: SkeletonFixture, cfg: RenderConfig): GrayImage {
  if (!cfg.rotateDeg) {
    return rasterizeFixture(f, { radius: cfg.radius, antialias: cfg.antialias }).image;
  }
  const th = (cfg.rotateDeg * Math.PI) / 180;
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  const rot = f.atoms.map((p) => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos }));
  const minX = Math.min(...rot.map((p) => p.x));
  const minY = Math.min(...rot.map((p) => p.y));
  const PAD = 24;
  const shifted = rot.map((p) => ({ x: p.x - minX + PAD, y: p.y - minY + PAD }));
  const w = Math.ceil(Math.max(...shifted.map((p) => p.x)) + PAD);
  const h = Math.ceil(Math.max(...shifted.map((p) => p.y)) + PAD);
  const segs = f.bonds.map(([a, b]) => ({ from: shifted[a] as Point, to: shifted[b] as Point }));
  return rasterizeSegments(w, h, segs, { radius: cfg.radius, antialias: cfg.antialias });
}

function buildBenchmarkReport(): string {
  const total = CARBON_SKELETON_CORPUS.length;
  const lines: string[] = [];
  lines.push("# FEAT-005 Carbon-Skeleton Benchmark Report");
  lines.push("");
  lines.push(
    "Auto-generated from `fixtures.artifacts.test.ts` (run with " +
      "`ITO_WRITE_SKELETON_FIXTURES=1`). Single source of truth: `fixtures.ts`.",
  );
  lines.push("");
  lines.push(`Corpus size: **${total}** distinct structures.`);
  lines.push(
    "Metric: exact **graph isomorphism** vs. ground truth (vertex count, edge " +
      "count, degree sequence, cycle rank, topology).",
  );
  lines.push("");
  lines.push("## Accuracy by render condition");
  lines.push("");
  lines.push("| Render condition | Accuracy | Failing structures |");
  lines.push("|---|---|---|");
  for (const cfg of REPORT_CONFIGS) {
    let pass = 0;
    const fails: string[] = [];
    for (const f of CARBON_SKELETON_CORPUS) {
      const image = renderFixture(f, cfg);
      const result = reconstructCarbonSkeleton(image);
      const gt = fixtureGroundTruth(f);
      const cmp = compareGraphs(
        { vertexCount: gt.vertexCount, edges: gt.edges },
        {
          vertexCount: result.atoms.length,
          edges: result.bonds.map((b) => ({ a: b.source, b: b.target })),
        },
      );
      if (cmp.isomorphic) pass++;
      else fails.push(f.name);
    }
    const pct = ((100 * pass) / total).toFixed(1);
    lines.push(`| ${cfg.label} | ${pass}/${total} (${pct}%) | ${fails.length ? fails.join(", ") : "—"} |`);
  }
  lines.push("");
  lines.push("## Per-structure ground truth (clean render)");
  lines.push("");
  lines.push("| Structure | Class | V | E | μ | reconstructed exactly (1px) |");
  lines.push("|---|---|---|---|---|---|");
  for (const f of CARBON_SKELETON_CORPUS) {
    const image = renderFixture(f, { label: "crisp", radius: 0.8, antialias: false });
    const result = reconstructCarbonSkeleton(image);
    const gt = fixtureGroundTruth(f);
    const cmp = compareGraphs(
      { vertexCount: gt.vertexCount, edges: gt.edges },
      {
        vertexCount: result.atoms.length,
        edges: result.bonds.map((b) => ({ a: b.source, b: b.target })),
      },
    );
    lines.push(
      `| ${f.name} | ${f.category} | ${gt.vertexCount} | ${gt.edges.length} | ${f.expectedCycleRank} | ${cmp.isomorphic ? "yes" : "NO"} |`,
    );
  }
  lines.push("");
  lines.push("## Failure analysis");
  lines.push("");
  lines.push(
    "- **Degree-4 vertices under rotation (neopentane):** four bonds meeting at " +
      "a point become ambiguous when two rotate into near-collinearity — the " +
      "junction reads as a straight line and drops to degree 2. Flagged, not " +
      "guessed.",
  );
  lines.push(
    "- **Smallest ring under anti-aliasing (cyclopropane):** 60° apexes round " +
      "into short arcs when a thick anti-aliased stroke is thinned, splitting or " +
      "merging a vertex. Correct at 1px and at thick crisp strokes.",
  );
  lines.push(
    "- **Dense small rings at 45° rotation:** corner rounding interacts with the " +
      "staircase of newly-diagonal edges, occasionally off by one vertex.",
  );
  lines.push("");
  lines.push(
    "These are inherent geometric ambiguities for a purely deterministic " +
      "recogniser; proposed targeted fixes are in `SKELETON_RECOGNITION.md`.",
  );
  lines.push("");
  lines.push(
    "> Synthetic fixtures validate the algorithm. They do **not** by themselves " +
      "establish real-world accuracy on scanned or hand-drawn diagrams.",
  );
  lines.push("");
  return lines.join("\n");
}
