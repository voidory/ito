/**
 * FEAT-005B — opt-in generator for the real-world reports + visual-debug SVGs.
 *
 * Run with ITO_WRITE_REALWORLD_REPORT=1 to (re)write:
 *   src/science/skeleton/realworld/REALWORLD_BENCHMARK.md
 *   src/science/skeleton/realworld/FAILURE_ANALYSIS.md
 *   src/science/skeleton/fixtures/realworld/debug/<name>[__transform].svg
 *
 *   ITO_WRITE_REALWORLD_REPORT=1 npx vitest run \
 *     src/science/skeleton/realworld/report
 *
 * Requires the rendered corpus (`variants.json`). Without the flag it is a cheap
 * no-op so CI never writes.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decodePngToGray } from "./pngDecode";
import { hasRenderedCorpus, runBenchmark, fixturesDir } from "./runBenchmark";
import { buildFailureReport, buildRealWorldReport } from "./report";
import { renderDebugSvg } from "./visualize";

const WRITE = process.env.ITO_WRITE_REALWORLD_REPORT === "1";

describe("real-world reports + debug artifacts", () => {
  it(WRITE ? "writes reports and debug SVGs" : "is a no-op unless opted in", () => {
    if (!WRITE) {
      expect(true).toBe(true);
      return;
    }
    if (!hasRenderedCorpus()) {
      throw new Error(
        "rendered corpus missing; run: ITO_WRITE_REALWORLD_MANIFEST=1 vitest run " +
          "src/science/skeleton/realworld/manifest && python scripts/gen-realworld-corpus.py",
      );
    }

    const report = runBenchmark();
    const here = resolve(fixturesDir(), "..", "..", "realworld");
    writeFileSync(resolve(here, "REALWORLD_BENCHMARK.md"), buildRealWorldReport(report), "utf8");
    writeFileSync(resolve(here, "FAILURE_ANALYSIS.md"), buildFailureReport(report), "utf8");

    const debugDir = resolve(fixturesDir(), "debug");
    mkdirSync(debugDir, { recursive: true });
    for (const c of report.all) {
      const rawBytes = readFileSync(resolve(fixturesDir(), "png", c.entry.file));
      const gray = decodePngToGray(new Uint8Array(rawBytes));
      const svg = renderDebugSvg({
        gray,
        result: c.result,
        groundTruth: c.groundTruth,
        metrics: c.metrics,
        title: `${c.entry.name}${c.entry.transform === "base" ? "" : " · " + c.entry.transform}`,
        originalPngBase64: rawBytes.toString("base64"),
      });
      const base = c.entry.file.replace(/\.png$/, ".svg");
      writeFileSync(resolve(debugDir, base), svg, "utf8");
    }

    expect(report.overallBase.count).toBeGreaterThanOrEqual(50);
  });
});
