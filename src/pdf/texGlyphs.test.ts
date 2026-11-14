import { describe, expect, it } from "vitest";
import { glyphsToLatex } from "./mathLayout";
import type { ModelGlyph, ModelRule, PageMathModel } from "./pageMathModel";
import { TEX_ASSEMBLIES, TEX_COMPOSITES, TEX_FONT_SLOTS } from "./texFontSlots";
import { hasSlotTable, regionMathGlyphs } from "./texGlyphs";

const PAGE = { x0: 0, y0: 0, x1: 612, y1: 792 };
/** A glyph at 10pt (or `size`) on the baseline y = 100 unless told otherwise. */
function g(family: string, slot: number, x: number, advance: number, extra: Partial<ModelGlyph> = {}): ModelGlyph {
  return { face: `${family}10`, family, slot, unicode: "?", x, y: 100, advance, size: 10, angle: 0, ...extra };
}
function page(glyphs: ModelGlyph[], rules: ModelRule[] = []): PageMathModel {
  return { width: 612, height: 792, glyphs, rules, vrules: [] };
}
const latex = (glyphs: ModelGlyph[], rules: ModelRule[] = []): string => {
  const region = regionMathGlyphs(page(glyphs, rules), PAGE);
  return glyphsToLatex(region.glyphs, region.rules);
};

describe("the generated slot table", () => {
  it("knows the slots that Unicode gets wrong", () => {
    expect(TEX_FONT_SLOTS.CMEX![88]).toEqual(["\\sum", "op"]); // pdf.js says "X"
    expect(TEX_FONT_SLOTS.CMEX![90]).toEqual(["\\int", "int"]); // pdf.js says "Z"
    expect(TEX_FONT_SLOTS.CMMI![15]![0]).toBe("\\epsilon");
    expect(TEX_FONT_SLOTS.CMMI![34]![0]).toBe("\\varepsilon");
    expect(TEX_FONT_SLOTS.MSBM![82]).toEqual(["R", "ord", "bb"]);
    expect(TEX_FONT_SLOTS.CMSY![76]).toEqual(["L", "ord", "cal"]);
  });

  it("records a style only where the plain command does not already land", () => {
    expect(TEX_FONT_SLOTS.CMR![49]).toEqual(["1", "ord"]); // `1` and `\mathrm{1}` are one glyph
    expect(TEX_FONT_SLOTS.CMR![97]).toEqual(["a", "ord", "rm"]);
    expect(TEX_FONT_SLOTS.CMMI![97]).toEqual(["a", "ord"]);
    expect(TEX_FONT_SLOTS.CMBX![97]).toEqual(["a", "ord", "bf"]);
  });

  it("has composites and assemblies whose parts are all known slots", () => {
    expect(TEX_COMPOSITES.map((c) => c.tex)).toEqual(expect.arrayContaining(["\\neq", "\\notin", "\\cong", "\\ldots", "\\mapsto"]));
    for (const c of TEX_COMPOSITES) for (const [family, slot] of c.parts) expect(TEX_FONT_SLOTS[family]?.[slot]).toBeDefined();
    for (const a of TEX_ASSEMBLIES) for (const slot of a.slots) expect(TEX_FONT_SLOTS[a.family]?.[slot]).toBeDefined();
  });

  it("covers Computer Modern and AMS, not Times", () => {
    expect(hasSlotTable("CMMI")).toBe(true);
    expect(hasSlotTable("MSBM")).toBe(true);
    expect(hasSlotTable("NIMBUSROMNO9L-REGU")).toBe(false);
  });
});

describe("regionMathGlyphs", () => {
  it("identifies glyphs by slot, whatever pdf.js thinks the character is", () => {
    const { glyphs } = regionMathGlyphs(page([g("CMEX", 88, 50, 14.4, { unicode: "X", y: 90 })]), PAGE);
    expect(glyphs).toHaveLength(1);
    expect(glyphs[0]).toMatchObject({ tex: "\\sum", cls: "op" });
  });

  it("gives an extension-font glyph the baseline of the line it is centred on", () => {
    // A display sum hangs from its origin: 14pt of ink below y = 90.
    const { glyphs } = regionMathGlyphs(page([g("CMEX", 88, 50, 14.4, { y: 90 })]), PAGE);
    const sum = glyphs[0]!;
    expect((sum.top! + sum.bottom!) / 2 + 2.5).toBeCloseTo(sum.base);
    expect(sum.base).toBeGreaterThan(98);
    expect(sum.base).toBeLessThan(101);
  });

  it("merges the parts of a composite symbol", () => {
    // `\neq` is the negation slash (CMSY 54) with `=` (CMR 61) at the same place.
    expect(latex([g("CMMI", 0x61, 40, 5.3), g("CMSY", 54, 48, 0), g("CMR", 61, 48, 7.8), g("CMMI", 0x62, 58.6, 4.3)])).toBe("a\\neq b");
    // `\notin` is a slash (CMMI 61) drawn first, then `\in` (CMSY 50) 0.111 em to its left.
    expect(latex([g("CMMI", 0x78, 40, 5.7), g("CMMI", 61, 49.6, 5), g("CMSY", 50, 48.49, 6.7), g("CMMI", 0x41, 58, 7.5)])).toBe("x\\notin A");
  });

  it("leaves the same glyphs alone when they are not at the composite's offsets", () => {
    // Three full stops a word apart are not `\ldots`.
    expect(latex([g("CMMI", 58, 40, 2.8), g("CMMI", 58, 60, 2.8), g("CMMI", 58, 80, 2.8)])).toBe("...");
    expect(latex([g("CMMI", 58, 40, 2.8), g("CMMI", 58, 44.45, 2.8), g("CMMI", 58, 48.89, 2.8)])).toBe("\\ldots");
  });

  it("builds a tall delimiter from its stacked pieces", () => {
    // parenlefttp (48), parenleftex (66), parenleftbt (64), stacked at one x.
    const stack = [
      g("CMEX", 48, 40, 8.7, { y: 70 }),
      g("CMEX", 66, 40, 8.7, { y: 88 }),
      g("CMEX", 64, 40, 8.7, { y: 94 }),
    ];
    const { glyphs } = regionMathGlyphs(page(stack), PAGE);
    expect(glyphs).toHaveLength(1);
    expect(glyphs[0]).toMatchObject({ tex: "(", cls: "open" });
  });

  it("keeps the character and no class for a font with no table", () => {
    const { glyphs } = regionMathGlyphs(page([g("NIMBUSROMNO9L-REGU", 120, 40, 5, { unicode: "x" })]), PAGE);
    expect(glyphs[0]!.ch).toBe("x");
    expect(glyphs[0]!.tex).toBeUndefined();
  });

  it("takes only what is inside the box, and skips spaces and rotated text", () => {
    const glyphs = [
      g("CMMI", 0x78, 40, 5.7),
      g("CMMI", 0x79, 300, 4.9),
      g("NIMBUSROMNO9L-REGU", 32, 46, 2.5, { unicode: " " }),
      g("CMMI", 0x7a, 50, 4.6, { angle: Math.PI / 2 }),
    ];
    const rules = [{ x0: 38, x1: 60, y: 96, thickness: 0.4 }, { x0: 290, x1: 310, y: 96, thickness: 0.4 }];
    const region = regionMathGlyphs(page(glyphs, rules), { x0: 30, y0: 80, x1: 100, y1: 110 });
    expect(region.glyphs.map((x) => x.tex)).toEqual(["x"]);
    expect(region.rules).toHaveLength(1);
  });

  it("returns nothing for a region with no glyphs", () => {
    expect(regionMathGlyphs(page([]), PAGE)).toEqual({ glyphs: [], rules: [] });
  });
});

describe("layout of exact glyphs", () => {
  it("reads font style from the font, not from word length", () => {
    // Bold x, blackboard R, calligraphic L, upright d, italic x.
    expect(latex([g("CMBX", 0x78, 40, 6.1)])).toBe("\\mathbf{x}");
    expect(latex([g("MSBM", 82, 40, 7.2)])).toBe("\\mathbb{R}");
    expect(latex([g("CMSY", 76, 40, 6.9)])).toBe("\\mathcal{L}");
    expect(latex([g("CMR", 0x64, 40, 5.6), g("CMMI", 0x78, 45.6, 5.7)])).toBe("\\mathrm{d}x");
  });

  it("reads upright `cos` as a function and italic `cos` as three variables", () => {
    const word = (family: string): ModelGlyph[] => [g(family, 0x63, 40, 4.4), g(family, 0x6f, 44.4, 5), g(family, 0x73, 49.4, 3.9), g("CMMI", 0x74, 55, 3.6)];
    expect(latex(word("CMR"))).toBe("\\cos t");
    expect(latex(word("CMMI"))).toBe("cost");
  });

  it("joins upright words a word space apart into one piece of text", () => {
    const text = [
      g("CMMI", 0x78, 20, 5.7),
      g("CMR", 0x69, 30, 2.8), g("CMR", 0x66, 32.8, 3.1), // "if"
      g("CMR", 0x6e, 39.2, 5.6), g("CMR", 0x6f, 44.8, 5), g("CMR", 0x74, 49.8, 3.9), // "not"
      g("CMMI", 0x79, 58, 4.9),
    ];
    expect(latex(text)).toBe("x\\text{ if not }y");
  });

  it("puts an accent on the glyph under it", () => {
    // \hat (CMR 94) raised over a capital, \vec (CMMI 126) over x with a subscript.
    expect(latex([g("CMR", 94, 42.4, 5, { y: 97.4 }), g("CMMI", 0x42, 40, 7.6)])).toBe("\\hat{B}");
    expect(latex([g("CMMI", 126, 40.6, 5), g("CMMI", 0x78, 40, 5.7), g("CMMI", 0x69, 45.7, 2.4, { y: 101.5, size: 7 })])).toBe("\\vec{x}_i");
  });

  it("takes limits above and below a display operator, and scripts beside an integral", () => {
    const sum = [
      g("CMEX", 88, 50, 14.4, { y: 90 }),
      g("CMMI", 0x69, 51, 2.4, { y: 111.6, size: 7 }), g("CMR", 61, 53.4, 6.1, { y: 111.6, size: 7 }), g("CMR", 49, 59.5, 4, { y: 111.6, size: 7 }),
      g("CMMI", 0x6e, 55, 4.2, { y: 87.5, size: 7 }),
      g("CMMI", 0x61, 66.1, 5.3),
    ];
    expect(latex(sum)).toBe("\\sum_{i=1}^na");
    const int = [
      g("CMEX", 90, 50, 5.5, { y: 86.4 }),
      g("CMR", 48, 55.5, 4, { y: 108.4, size: 7 }),
      g("CMR", 49, 60, 4, { y: 89.1, size: 7 }),
      g("CMMI", 0x66, 66, 4.9),
    ];
    expect(latex(int)).toBe("\\int_0^1f");
  });

  it("uses the PDF's rules for fractions and radicals", () => {
    const frac = [g("CMMI", 0x61, 43, 5.3, { y: 90.7 }), g("CMMI", 0x62, 43.5, 4.3, { y: 104.3 })];
    expect(latex(frac, [{ x0: 41.8, x1: 49.5, y: 97.5, thickness: 0.4 }])).toBe("\\frac{a}{b}");
    // The radical sign (CMSY 112) hangs from the rule that starts where it ends.
    const sqrt = [g("CMSY", 112, 40, 8.3, { y: 91.2 }), g("CMMI", 0x78, 48.3, 5.7)];
    expect(latex(sqrt, [{ x0: 48.3, x1: 54, y: 91, thickness: 0.4 }])).toBe("\\sqrt{x}");
    // No rule, no fraction: a stack of exact glyphs is not guessed to be one.
    expect(latex(frac)).not.toContain("\\frac");
  });

  it("does not take a script for a main glyph at the smallest size", () => {
    // x^2 at 5pt: same size, the exponent only raised.
    expect(latex([g("CMMI", 0x78, 40, 3.5, { size: 5 }), g("CMR", 50, 43.5, 3.4, { size: 5, y: 98.2 })])).toBe("x^2");
  });
});
