/**
 * From the extractor's evidence to a probability that the draft is exactly
 * right, and to reasons a person can check.
 *
 * Each feature is one thing the evidence can say, scaled to roughly 0..1, and
 * has a plain-language doubt for when it is large. A logistic model weighs
 * them. The weights are fitted by `scripts/dev/latex-confidence.ts` on the
 * survey papers and stored in `equationConfidenceModel.json`; this module has
 * no number in it that was chosen by eye except the scalings below.
 *
 * What the model is a probability of: that the draft matches the source's
 * structure exactly (the benchmark's exact match), for a box drawn tightly
 * round an equation on a TeX page. Boxes that cut glyphs are not in the
 * calibration data, so they are not weighed: they raise a doubt of their own
 * and cap the confidence (see `assessEvidence`).
 */

import type { EquationEvidence } from "./equationEvidence";
import MODEL from "./equationConfidenceModel.json";

/** A decision this close to its threshold (in ems) counts as fully in doubt; farther ones fade out by `reach`. */
const CLOSE = (margin: number | undefined, reach: number): number =>
  margin === undefined ? 0 : Math.max(0, 1 - margin / reach);

interface Feature {
  readonly name: string;
  readonly extract: (e: EquationEvidence) => number;
  /** What to tell the person when this feature is large. Absent: it is a base rate, not a reason. */
  readonly doubt?: string;
}

const same = (e: EquationEvidence, k: string): number => 1 - (e.stability.same[k] ?? 1);

export const FEATURES: readonly Feature[] = [
  { name: "unstable.10", extract: (e) => same(e, "10"), doubt: "A tiny shift in where the glyphs sit changes the result." },
  { name: "unstable.20", extract: (e) => same(e, "20"), doubt: "A small shift in where the glyphs sit changes the result." },
  { name: "unstable.40", extract: (e) => same(e, "40"), doubt: "A small shift in where the glyphs sit changes the result." },
  { name: "unstable.60", extract: (e) => same(e, "60") },
  { name: "closeCall.script", extract: (e) => Math.max(CLOSE(e.layout.margins.scriptBand, 0.1), CLOSE(e.layout.margins.scriptLevel, 0.1)), doubt: "A script sits almost between a superscript and the main line." },
  { name: "closeCall.scriptGap", extract: (e) => CLOSE(e.layout.margins.scriptGap, 0.05) },
  { name: "closeCall.lines", extract: (e) => Math.max(CLOSE(e.layout.margins.lineGap, 0.1), CLOSE(e.layout.margins.lineJoin, 0.1), CLOSE(e.layout.margins.rowApart, 0.1)), doubt: "It was close whether some of this is on its own line." },
  { name: "closeCall.words", extract: (e) => Math.max(CLOSE(e.layout.margins.wordSpace, 0.05), CLOSE(e.layout.margins.runGap, 0.03)), doubt: "It was close whether a gap is a word space." },
  { name: "orphanScript", extract: (e) => (e.output.orphanScripts > 0 ? 1 : 0), doubt: "A script was left with nothing to attach to." },
  { name: "unidentified", extract: (e) => (e.region.unidentified > 0 ? 1 : 0), doubt: "A symbol is from a font Ito has no table for, so it was guessed from its character." },
  { name: "rawCharacter", extract: (e) => (e.output.rawCharacters > 0 ? 1 : 0), doubt: "A symbol could only be written as a raw character." },
  { name: "unusedRule", extract: (e) => (e.layout.counts.ruleUnused ? 1 : 0), doubt: "A line drawn in the box was not used as a fraction bar or root." },
  { name: "droppedNumber", extract: (e) => (e.glyphs.droppedNumbers > 0 ? 1 : 0), doubt: "An equation number beside the formula was left out." },
  { name: "unbalanced", extract: (e) => (e.output.unbalanced ? 1 : 0), doubt: "The brackets in the result do not pair up." },
  { name: "environment", extract: (e) => (e.output.environments > 0 ? 1 : 0), doubt: "It contains a matrix, cases or aligned rows, which are read least reliably." },
  { name: "rows", extract: (e) => Math.min(1, e.output.rows / 3) },
  { name: "stacks", extract: (e) => (e.output.stacks > 0 ? 1 : 0), doubt: "It contains a symbol stacked over another, or a brace with a label." },
  { name: "size", extract: (e) => Math.log1p(e.glyphs.glyphs) / 5 },
  { name: "depth", extract: (e) => Math.min(1, e.output.depth / 8) },
  { name: "inlineBox", extract: (e) => (e.box.heightEms < 2.6 ? 1 : 0) },
  { name: "fractions", extract: (e) => Math.min(1, e.output.fractions / 3) },
  { name: "scripts", extract: (e) => Math.min(1, e.output.scripts / 12) },
];

/** The fitted weights (see the fitting script). `bias` first, then one weight per feature, by name. */
export interface ConfidenceModel {
  readonly bias: number;
  readonly weights: Readonly<Record<string, number>>;
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/** The score before the sigmoid, and each feature's share of it. */
export function scoreEvidence(e: EquationEvidence, model: ConfidenceModel = MODEL as ConfidenceModel): { z: number; parts: { name: string; part: number; doubt?: string }[] } {
  const parts = FEATURES.map((f) => ({ name: f.name, part: (model.weights[f.name] ?? 0) * f.extract(e), ...(f.doubt ? { doubt: f.doubt } : {}) }));
  return { z: model.bias + parts.reduce((s, p) => s + p.part, 0), parts };
}

/** Confidence at or above which a draft is shown without a caveat. Chosen by the fitting script. */
export const TRUST_AT: number = (MODEL as { trustAt: number }).trustAt;

/**
 * The confidence in a draft, and the reasons for doubt, strongest first.
 *
 * A box that cut into glyphs (or sits within a tenth of an em of one) was
 * probably drawn badly, and the benchmark never draws one so: that is a
 * doubt the data cannot weigh, so it caps the confidence below the trust line.
 */
export function assessEvidence(e: EquationEvidence, model: ConfidenceModel = MODEL as ConfidenceModel): { confidence: number; doubts: string[] } {
  const { z, parts } = scoreEvidence(e, model);
  let confidence = sigmoid(z);
  const doubts = parts
    .filter((p) => p.doubt && p.part < -0.5)
    .sort((a, b) => a.part - b.part)
    .map((p) => p.doubt!)
    .filter((d, i, all) => all.indexOf(d) === i);
  if (e.region.cutDropped > 0 || e.region.cutKept > 0) {
    doubts.unshift("The box cuts through some of the symbols; check that nothing at its edges is missing or extra.");
    confidence = Math.min(confidence, TRUST_AT - 0.01);
  } else if (e.region.nearEdge > 0) {
    doubts.unshift("A symbol sits right at the edge of the box.");
    confidence = Math.min(confidence, TRUST_AT - 0.01);
  }
  if (confidence < TRUST_AT && doubts.length === 0) doubts.push("This kind of equation is often read wrongly.");
  return { confidence, doubts };
}
