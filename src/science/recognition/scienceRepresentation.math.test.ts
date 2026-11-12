/**
 * M18 FEAT-001 (spec Phase 1, Step 1.1 — Math) — regression tests that lock
 * down the EXISTING M17 math representation pipeline in src/pdf/scienceOcr.ts:
 *
 *   input  →  normalized LaTeX  →  MathML
 *
 * Nothing is mocked: every assertion drives the REAL exported functions
 * `extractLatexFromRegion` (the public door onto the internal `normalizeToLatex`
 * normalizer — reached with a null stage + a hint string) and
 * `convertLatexToMathML`. The generated MathML is asserted to be structurally
 * valid: it opens with the canonical `<math xmlns=...>`, closes with `</math>`,
 * and parses as XML with NO `<parsererror>` element.
 *
 * The exact structural claims (which inputs produce <msqrt>/<mfrac>/<msup>/
 * <msub>) were verified against the code in src/pdf/scienceOcr.ts, NOT assumed:
 *   - `normalizeToLatex` maps Unicode Greek (α→\alpha …) and operator glyphs,
 *     turns `√x`/`√(…)` into `\sqrt{…}`, and simple top-level `a/b` into
 *     `\frac{a}{b}`. It does NOT map the Unicode superscript/subscript glyphs
 *     `²`/`₂` — those only become <msup>/<msub> via the caret/underscore forms
 *     `x^2` / `x_2`, which the tokenizer + parser handle. We therefore test the
 *     caret/underscore forms for the script structure and separately DOCUMENT
 *     that the literal Unicode `x²`/`x₂` pass through as <mo> today.
 */

import { describe, expect, it } from "vitest";
import { convertLatexToMathML, extractLatexFromRegion } from "../../pdf/scienceOcr";
import type { NormalizedRect } from "../../model";

const FULL_RECT: NormalizedRect = { x: 0, y: 0, width: 1, height: 1 };

/** Reach the internal normalizer via the real exported door (null stage → hint). */
function normalize(input: string): string {
  return extractLatexFromRegion(null, FULL_RECT, input);
}

/** Assert MathML is structurally valid + XML-parseable with no parsererror. */
function expectValidMathML(mathml: string): Document {
  expect(mathml.startsWith('<math xmlns="http://www.w3.org/1998/Math/MathML"')).toBe(true);
  expect(mathml).toContain("</math>");
  const doc = new DOMParser().parseFromString(mathml, "application/xml");
  expect(doc.querySelector("parsererror")).toBeNull();
  return doc;
}

describe("M18 FEAT-001 — M17 math pipeline (input → normalized LaTeX → MathML)", () => {
  it("every spec Step 1.1 math input compiles to structurally valid MathML", () => {
    // The spec's math battery. Each flows input → normalize → convert and the
    // resulting MathML must be well-formed.
    const inputs = ["α", "β", "√x", "x²", "x₂", "a/b", "\\frac{a}{b}", "\\sqrt{x}", "\\alpha"];
    for (const input of inputs) {
      const latex = normalize(input);
      const mathml = convertLatexToMathML(latex);
      expectValidMathML(mathml);
    }
  });

  it("Greek glyph α and the LaTeX command \\alpha both normalize + render Greek", () => {
    // α → \alpha (Unicode mapped), \alpha stays \alpha; both compile to the
    // Greek character carried inside an <mi>.
    const fromGlyph = normalize("α");
    const fromCommand = normalize("\\alpha");
    expect(fromGlyph).toContain("\\alpha");
    expect(fromCommand).toContain("\\alpha");
    for (const latex of [fromGlyph, fromCommand]) {
      const mathml = convertLatexToMathML(latex);
      expectValidMathML(mathml);
      // The compiler emits the Greek α character inside an <mi>.
      expect(mathml).toContain("α");
      expect(mathml).toContain("<mi>");
    }
    // β likewise.
    const beta = convertLatexToMathML(normalize("β"));
    expectValidMathML(beta);
    expect(beta).toContain("β");
  });

  it("√x and \\sqrt{x} both produce an <msqrt> radical", () => {
    // Unicode radical: √x → \sqrt{x}.
    const fromGlyph = normalize("√x");
    expect(fromGlyph).toBe("\\sqrt{x}");
    const mlGlyph = convertLatexToMathML(fromGlyph);
    expectValidMathML(mlGlyph);
    expect(mlGlyph).toContain("<msqrt>");

    // Already-LaTeX radical: \sqrt{x} passes through and still yields <msqrt>.
    const fromCommand = normalize("\\sqrt{x}");
    const mlCommand = convertLatexToMathML(fromCommand);
    expectValidMathML(mlCommand);
    expect(mlCommand).toContain("<msqrt>");
  });

  it("a/b and \\frac{a}{b} both produce an <mfrac>", () => {
    // Simple top-level a/b → \frac{a}{b}.
    const fromSlash = normalize("a/b");
    expect(fromSlash).toBe("\\frac{a}{b}");
    const mlSlash = convertLatexToMathML(fromSlash);
    expectValidMathML(mlSlash);
    expect(mlSlash).toContain("<mfrac>");

    // Already-LaTeX fraction.
    const fromFrac = normalize("\\frac{a}{b}");
    const mlFrac = convertLatexToMathML(fromFrac);
    expectValidMathML(mlFrac);
    expect(mlFrac).toContain("<mfrac>");
  });

  it("caret/underscore scripts produce <msup>/<msub> (the forms the normalizer supports)", () => {
    // The spec lists x² / x₂. The normalizer does NOT map the Unicode
    // superscript/subscript glyphs; the <msup>/<msub> STRUCTURE is produced by
    // the caret/underscore forms, which is what the tokenizer + parser handle.
    const sup = convertLatexToMathML(normalize("x^2"));
    expectValidMathML(sup);
    expect(sup).toContain("<msup>");

    const sub = convertLatexToMathML(normalize("x_2"));
    expectValidMathML(sub);
    expect(sub).toContain("<msub>");
  });

  it("DOCUMENTS current behavior: literal Unicode x² / x₂ are not mapped to scripts", () => {
    // Current M17 behavior (verified against normalizeToLatex in
    // src/pdf/scienceOcr.ts): the Unicode superscript-two (²) and
    // subscript-two (₂) glyphs are NOT rewritten to `x^{2}` / `x_{2}`, so the
    // compiler emits them as plain <mo> operators rather than <msup>/<msub>.
    // This test pins the CURRENT behavior so a future Unicode-script mapping is
    // an intentional, visible change rather than a silent regression.
    const supMl = convertLatexToMathML(normalize("x²"));
    expectValidMathML(supMl);
    expect(supMl).not.toContain("<msup>");
    expect(supMl).toContain("²");

    const subMl = convertLatexToMathML(normalize("x₂"));
    expectValidMathML(subMl);
    expect(subMl).not.toContain("<msub>");
    expect(subMl).toContain("₂");
  });

  it("is deterministic: identical input yields byte-identical MathML", () => {
    const latex = normalize("\\frac{a}{b}");
    expect(convertLatexToMathML(latex)).toBe(convertLatexToMathML(latex));
  });
});
