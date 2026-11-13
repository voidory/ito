import { describe, expect, it } from "vitest";
import { canonicalLatex, constructsOf, parseLatex } from "./normalize";
import { failureRateUpperBound, scoreEquation, tally, treeEditDistance } from "./score";

const same = (a: string, b: string): void => expect(canonicalLatex(a)).toBe(canonicalLatex(b));
const differ = (a: string, b: string): void => expect(canonicalLatex(a)).not.toBe(canonicalLatex(b));

describe("canonicalLatex — spellings of the same structure are equal", () => {
  it("ignores braces, whitespace and script order", () => {
    same("x^{2}", "x^2");
    same("x_i^2", "x^{2}_{i}");
    same("{x_i}^2", "x_i^2");
    same("a + b", "a+b");
    same("{{a}}", "a");
    same("x^{12}", "x^{1 2}");
  });

  it("ignores spacing, sizing and style commands", () => {
    same("\\int_0^1 f(x)\\,dx", "\\int_0^1 f(x) dx");
    same("\\left(\\frac{a}{b}\\right)", "(\\frac{a}{b})");
    same("\\Big[ x \\Big]", "[x]");
    same("\\left. f \\right|_0", "f|_0");
    same("\\dfrac{a}{b}", "\\frac ab");
    same("\\sum\\limits_{i=1}^{n} a_i", "\\sum_{i=1}^n a_i");
    same("\\displaystyle a \\quad b", "ab");
  });

  it("folds synonyms, primes and Unicode", () => {
    same("a \\le b \\ne c", "a \\leq b \\neq c");
    same("a \\not= b", "a \\neq b");
    same("x \\to 0", "x \\rightarrow 0");
    same("f'(x)", "f^{\\prime}(x)");
    same("f''", "f^{\\prime\\prime}");
    same("α≤β", "\\alpha\\leq\\beta");
    same("a−b", "a-b");
    same("\\lVert x \\rVert", "\\| x \\|");
    same("a \\mid b", "a | b");
    same("1,\\ldots,n", "1,...,n");
    same("a \\cdots b", "a\\cdot\\cdot\\cdot b");
  });

  it("treats upright operator names and prose consistently", () => {
    same("\\sin x", "\\mathrm{sin} x");
    same("\\operatorname{sin} x", "\\sin x");
    same("x\\text{ if }y", "x\\text{if}y");
    same("\\text{for}\\text{ all}", "\\text{for all}");
    same("\\text{a}", "\\mathrm{a}");
  });

  it("folds matrix and alignment environments", () => {
    same("\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}", "\\left(\\begin{matrix}a&b\\\\c&d\\end{matrix}\\right)");
    same("\\begin{aligned}a&=b\\\\&=c\\end{aligned}", "a=b \\\\ =c");
    same("\\begin{aligned}a&=b\\end{aligned}", "a=b");
    same("\\begin{cases}a&x>0\\\\b&x<0\\end{cases}", "\\left\\{\\begin{array}{ll}a&x>0\\\\b&x<0\\end{array}\\right.");
  });

  it("keeps what is visibly different", () => {
    differ("x^2", "x_2");
    differ("x^2", "x2");
    differ("\\frac{a}{b}", "a/b");
    differ("\\frac{a}{b}", "\\frac{b}{a}");
    differ("\\sqrt{x}", "x");
    differ("\\sqrt[3]{x}", "\\sqrt{x}");
    differ("\\mathrm{d}x", "dx");
    differ("\\epsilon", "\\varepsilon");
    differ("\\bar{x}", "\\overline{x}");
    differ("\\mathbf{x}", "x");
    differ("a=b \\\\ c=d", "a=bc=d");
    differ("\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}", "\\begin{pmatrix}a&c\\\\b&d\\end{pmatrix}");
    differ("e^{x^2}", "e^{x2}");
    differ("\\binom{n}{k}", "\\frac{n}{k}");
  });

  it("never throws on malformed input", () => {
    for (const bad of ["", "}", "{", "^", "\\frac", "\\begin{pmatrix}a&", "\\sqrt[", "x^^2", "\\left("]) {
      expect(() => parseLatex(bad)).not.toThrow();
    }
  });
});

describe("constructsOf", () => {
  it("tags what an equation exercises", () => {
    expect(constructsOf(parseLatex("x^2"))).toEqual(["script"]);
    expect(constructsOf(parseLatex("\\sum_{i=1}^n a_i"))).toEqual(["big-operator", "limits", "script"]);
    expect(constructsOf(parseLatex("\\frac{1}{\\sqrt{2\\pi}}"))).toEqual(["fraction", "greek", "radical"]);
    expect(constructsOf(parseLatex("e^{x^2}"))).toContain("nested-script");
    expect(constructsOf(parseLatex("\\left(\\frac{a}{b}\\right)"))).toContain("tall-delimiter");
    expect(constructsOf(parseLatex("a=b \\\\ c=d"))).toEqual(["multi-line"]);
    expect(constructsOf(parseLatex("a+b"))).toEqual(["plain"]);
  });
});

describe("scoring", () => {
  it("tree edit distance counts single edits", () => {
    const d = (a: string, b: string): number => treeEditDistance(parseLatex(a), parseLatex(b));
    expect(d("a+b", "a+b")).toBe(0);
    expect(d("a+b", "a-b")).toBe(1);
    expect(d("a+b", "a+b+c")).toBe(2);
    expect(d("x^2", "x2")).toBeGreaterThan(0);
    expect(d("\\frac{a}{b}", "\\frac{a}{c}")).toBe(1);
  });

  it("scores exact, partial and empty extractions", () => {
    expect(scoreEquation("x^{2}", "x^2")).toMatchObject({ exact: true, similarity: 1 });
    const partial = scoreEquation("\\frac{a+b}{c}", "\\frac{a-b}{c}");
    expect(partial.exact).toBe(false);
    expect(partial.similarity).toBeGreaterThan(0.5);
    expect(partial.similarity).toBeLessThan(1);
    expect(scoreEquation("x^2", "")).toMatchObject({ exact: false, similarity: 0 });
  });

  it("tallies and bounds the failure rate", () => {
    const t = tally([scoreEquation("a", "a"), scoreEquation("a", "b")]);
    expect(t).toMatchObject({ n: 2, exact: 1, exactRate: 0.5 });
    // Zero failures in n trials bounds the failure rate near 3/n.
    expect(failureRateUpperBound(300, 0)).toBeCloseTo(0.00994, 4);
    expect(failureRateUpperBound(3000, 0)).toBeLessThan(0.001);
    expect(failureRateUpperBound(2900, 0)).toBeGreaterThan(0.001);
    expect(failureRateUpperBound(100, 100)).toBe(1);
  });
});
