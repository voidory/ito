import { describe, expect, it } from "vitest";
import { independentCorpusSize, runIndependentBenchmark } from "./benchmark";
import { matchVerticesOptimal } from "./independentMetrics";

describe("FEAT-005C independent-renderer validation", () => {
  it("contains a locked, evaluation-only corpus", () => {
    expect(independentCorpusSize()).toBeGreaterThanOrEqual(30);
    const report = runIndependentBenchmark();
    expect(report.cases).toHaveLength(independentCorpusSize());
    expect(report.cases.every((c) => c.entry.source === "PubChem")).toBe(true);
    expect(report.cases.every((c) => c.entry.split === "evaluation")).toBe(true);
  });

  it("uses one-to-one optimal geometric matching rather than greedy matching", () => {
    const mapping = matchVerticesOptimal(
      [{ x: 0, y: 0 }, { x: 1, y: 0 }],
      [{ x: 0.9, y: 0 }, { x: 2.0, y: 0 }],
      1.1,
    );
    expect(mapping).toEqual([1, 0]);
  });

  it("reports results without imposing a tuned accuracy target", () => {
    const report = runIndependentBenchmark();
    expect(report.aggregate.count).toBe(report.cases.length);
    expect(Object.keys(report.byCategory).length).toBeGreaterThanOrEqual(5);
  });
});
