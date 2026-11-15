import { describe, expect, it } from "vitest";
import { assessEvidence, FEATURES, TRUST_AT } from "./equationConfidence";
import { outputStats, type EquationEvidence } from "./equationEvidence";

/** The evidence of a plain, stable, fully identified one-line draft. */
function calm(latex = "a+b=c"): EquationEvidence {
  return {
    box: { widthEms: 6, heightEms: 2 },
    stability: { same: { "10": 1, "20": 1, "40": 1, "60": 1 }, distinct: 1 },
    region: { cutDropped: 0, cutKept: 0, nearEdge: 0, unidentified: 0 },
    glyphs: { glyphs: 5, exact: 5, droppedNumbers: 0, rules: 0, rulesUsable: 0 },
    layout: { margins: {}, counts: {} },
    output: outputStats(latex),
  };
}

describe("confidence from evidence", () => {
  it("trusts a plain, stable, identified draft and says nothing against it", () => {
    const { confidence, doubts } = assessEvidence(calm());
    expect(confidence).toBeGreaterThanOrEqual(TRUST_AT);
    expect(doubts).toEqual([]);
  });

  it("gives a reason for each thing that lowers it", () => {
    const cases: [string, EquationEvidence, RegExp][] = [
      ["a symbol from an unknown font", { ...calm(), region: { ...calm().region, unidentified: 1 } }, /no table for/],
      ["a script left with nothing to attach to", { ...calm("{}^2+a"), output: outputStats("{}^2+a") }, /nothing to attach/],
      ["a draft that changes when glyphs shift", { ...calm(), stability: { same: { "10": 0.5, "20": 0.3, "40": 0, "60": 0 }, distinct: 4 } }, /shift in where the glyphs sit/],
    ];
    for (const [name, evidence, reason] of cases) {
      const { confidence, doubts } = assessEvidence(evidence);
      expect(confidence, name).toBeLessThan(TRUST_AT);
      expect(doubts.join(" "), name).toMatch(reason);
    }
  });

  it("lowers confidence for a close call, without crying wolf over one on its own", () => {
    const close = assessEvidence({ ...calm(), layout: { margins: { scriptBand: 0.005 }, counts: {} } });
    expect(close.confidence).toBeLessThan(assessEvidence(calm()).confidence);
    // Several close calls together are what earn a caveat.
    const many = assessEvidence({ ...calm(), layout: { margins: { scriptBand: 0.005, scriptLevel: 0.005, lineGap: 0.01 }, counts: {} }, stability: { same: { "10": 0.7, "20": 0.5, "40": 0.2, "60": 0 }, distinct: 3 } });
    expect(many.confidence).toBeLessThan(TRUST_AT);
  });

  it("caps a draft from a box that cut glyphs, whatever else is true", () => {
    const cut = assessEvidence({ ...calm(), region: { ...calm().region, cutDropped: 1 } });
    expect(cut.confidence).toBeLessThan(TRUST_AT);
    expect(cut.doubts[0]).toMatch(/cuts through some of the symbols/);
    const edge = assessEvidence({ ...calm(), region: { ...calm().region, nearEdge: 2 } });
    expect(edge.confidence).toBeLessThan(TRUST_AT);
    expect(edge.doubts[0]).toMatch(/right at the edge/);
  });

  it("always gives a reason when it does not trust a draft", () => {
    const { confidence, doubts } = assessEvidence({ ...calm(), glyphs: { ...calm().glyphs, glyphs: 400 }, output: outputStats("x".repeat(400)) });
    if (confidence < TRUST_AT) expect(doubts.length).toBeGreaterThan(0);
  });

  it("has a doubt for every feature that is not just a base rate", () => {
    const names = FEATURES.filter((f) => f.doubt).map((f) => f.name);
    expect(names.length).toBeGreaterThan(8);
  });
});
