/**
 * FEAT-005 — benchmark: run the FULL controlled corpus (>= 20 structures)
 * through the deterministic pipeline and score each reconstruction against its
 * known ground-truth graph by graph isomorphism, preserving vertex count, edge
 * count, degree sequence, cycle rank and ring connectivity.
 *
 * This is the primary accuracy deliverable. It asserts exact reconstruction on
 * the clean synthetic corpus, and also records accuracy under thicker strokes
 * and rotation so recurring failure modes are measured, not hidden.
 *
 * NOTE: synthetic fixtures validate the ALGORITHM. They do NOT by themselves
 * establish real-world recognition accuracy on scanned / hand-drawn diagrams —
 * see docs for the limitations discussion.
 */

import { describe, expect, it } from "vitest";
import {
  CARBON_SKELETON_CORPUS,
  fixtureGroundTruth,
  rasterizeFixture,
  type SkeletonFixture,
} from "./fixtures";
import { reconstructCarbonSkeleton } from "../../skeleton/carbonSkeleton";
import { compareGraphs, type SimpleGraph } from "./graphCompare";
import { rasterizeSegments } from "../../skeleton/raster";
import type { GrayImage, Point } from "../../skeleton/types";

interface RenderConfig {
  readonly label: string;
  readonly radius: number;
  readonly antialias: boolean;
  readonly rotateDeg?: number;
}

const CONFIGS: RenderConfig[] = [
  { label: "crisp-1px", radius: 0.8, antialias: false },
  { label: "antialiased", radius: 1.6, antialias: true },
  { label: "thick-2.4px", radius: 2.4, antialias: true },
  { label: "rot-30deg", radius: 1.6, antialias: true, rotateDeg: 30 },
  { label: "rot-45deg", radius: 1.6, antialias: true, rotateDeg: 45 },
];

function rotateAtoms(atoms: readonly Point[], deg: number): Point[] {
  const th = (deg * Math.PI) / 180;
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  return atoms.map((p) => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos }));
}

function renderFixture(f: SkeletonFixture, cfg: RenderConfig): GrayImage {
  if (!cfg.rotateDeg) {
    return rasterizeFixture(f, { radius: cfg.radius, antialias: cfg.antialias }).image;
  }
  const rot = rotateAtoms(f.atoms, cfg.rotateDeg);
  const minX = Math.min(...rot.map((p) => p.x));
  const minY = Math.min(...rot.map((p) => p.y));
  const PAD = 24;
  const shifted = rot.map((p) => ({ x: p.x - minX + PAD, y: p.y - minY + PAD }));
  const w = Math.ceil(Math.max(...shifted.map((p) => p.x)) + PAD);
  const h = Math.ceil(Math.max(...shifted.map((p) => p.y)) + PAD);
  const segs = f.bonds.map(([a, b]) => ({
    from: shifted[a] as Point,
    to: shifted[b] as Point,
  }));
  return rasterizeSegments(w, h, segs, { radius: cfg.radius, antialias: cfg.antialias });
}

function scoreFixture(
  f: SkeletonFixture,
  cfg: RenderConfig,
): { isomorphic: boolean; mismatches: string[]; cycleRankOk: boolean } {
  const image = renderFixture(f, cfg);
  const result = reconstructCarbonSkeleton(image);
  const gt = fixtureGroundTruth(f);
  const expected: SimpleGraph = { vertexCount: gt.vertexCount, edges: gt.edges };
  const actual: SimpleGraph = {
    vertexCount: result.atoms.length,
    edges: result.bonds.map((b) => ({ a: b.source, b: b.target })),
  };
  const cmp = compareGraphs(expected, actual);
  return {
    isomorphic: cmp.isomorphic,
    mismatches: cmp.mismatches,
    cycleRankOk: result.cycleRank === f.expectedCycleRank,
  };
}

describe("carbon-skeleton benchmark corpus", () => {
  it("contains at least 20 distinct structures spanning all required classes", () => {
    expect(CARBON_SKELETON_CORPUS.length).toBeGreaterThanOrEqual(20);
    const categories = new Set(CARBON_SKELETON_CORPUS.map((f) => f.category));
    expect(categories).toEqual(
      new Set([
        "straight-chain",
        "bent-chain",
        "branched-chain",
        "cycloalkane",
        "ring-substituent",
        "fused-ring",
      ]),
    );
    const names = CARBON_SKELETON_CORPUS.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length); // all distinct
  });

  it("reconstructs EVERY structure exactly on the clean (crisp-1px) corpus", () => {
    const failures: string[] = [];
    for (const f of CARBON_SKELETON_CORPUS) {
      const s = scoreFixture(f, { label: "crisp-1px", radius: 0.8, antialias: false });
      if (!s.isomorphic) failures.push(`${f.name}: ${s.mismatches.join("; ")}`);
    }
    expect(failures).toEqual([]);
  });

  it("reconstructs the antialiased corpus with at most one documented miss", () => {
    // Antialiasing + thinning rounds sharp corners. The ONLY structure that is
    // sensitive to this at radius 1.6 is cyclopropane — the smallest possible
    // ring, whose 60deg apexes round into short arcs that can split one vertex
    // into two. This is a documented limitation (see SKELETON_RECOGNITION.md),
    // not a silent failure; every result still carries an explicit status.
    const failures: string[] = [];
    for (const f of CARBON_SKELETON_CORPUS) {
      const s = scoreFixture(f, { label: "antialiased", radius: 1.6, antialias: true });
      if (!s.isomorphic) failures.push(f.name);
    }
    expect(failures.length).toBeLessThanOrEqual(1);
    // Whatever fails must be the documented small-ring case, not a regression
    // in a chain / substituent / large-ring structure.
    for (const name of failures) expect(name).toBe("cyclopropane");
  });

  it("preserves cycle rank μ for every structure (clean render)", () => {
    for (const f of CARBON_SKELETON_CORPUS) {
      const s = scoreFixture(f, { label: "crisp-1px", radius: 0.8, antialias: false });
      expect(s.cycleRankOk, `${f.name} cycle rank`).toBe(true);
    }
  });

  it("measures accuracy and records failure modes across render configs", () => {
    const lines: string[] = [];
    lines.push("# FEAT-005 Carbon Skeleton Benchmark Report");
    lines.push("");
    lines.push(`Corpus size: ${CARBON_SKELETON_CORPUS.length} structures.`);
    lines.push("Metric: exact graph isomorphism vs. ground truth (V, E, degree");
    lines.push("sequence, cycle rank, topology).");
    lines.push("");
    lines.push("| Render config | Accuracy | Failing structures |");
    lines.push("|---|---|---|");

    const perConfig: { label: string; pass: number; total: number; fails: string[] }[] = [];
    for (const cfg of CONFIGS) {
      let pass = 0;
      const fails: string[] = [];
      for (const f of CARBON_SKELETON_CORPUS) {
        const s = scoreFixture(f, cfg);
        if (s.isomorphic) pass++;
        else fails.push(f.name);
      }
      perConfig.push({ label: cfg.label, pass, total: CARBON_SKELETON_CORPUS.length, fails });
      const pct = ((100 * pass) / CARBON_SKELETON_CORPUS.length).toFixed(1);
      lines.push(
        `| ${cfg.label} | ${pass}/${CARBON_SKELETON_CORPUS.length} (${pct}%) | ${
          fails.length ? fails.join(", ") : "—"
        } |`,
      );
    }
    lines.push("");

    // Emit the report to the console (captured in CI logs) and assert the two
    // clean configs are perfect; rotated configs are allowed documented misses.
    // eslint-disable-next-line no-console
    console.log("\n" + lines.join("\n") + "\n");

    // Crisp 1px and thick renders must be perfect (the clean-diagram
    // completion criterion). The antialiased render allows the single
    // documented small-ring miss.
    const perfectConfigs = ["crisp-1px", "thick-2.4px"];
    for (const c of perConfig.filter((x) => perfectConfigs.includes(x.label))) {
      expect(c.pass, `${c.label}: ${c.fails.join(", ")}`).toBe(c.total);
    }
    const aa = perConfig.find((c) => c.label === "antialiased");
    expect(aa && aa.pass >= aa.total - 1).toBe(true);
    // Rotated renders must still reconstruct the large majority; this guards
    // against regressions while acknowledging the documented degree-4
    // collinearity and small-ring rounding limits.
    const rotated = perConfig.filter((c) => c.label.startsWith("rot"));
    for (const c of rotated) {
      expect(c.pass, `${c.label}: ${c.fails.join(", ")}`).toBeGreaterThanOrEqual(
        c.total - 3,
      );
    }
  });
});
