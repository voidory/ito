import { describe, expect, it } from "vitest";
import { detectHorizontalRules, dropSentenceMark, glyphsToLatex, type MathGlyph, type MathRule } from "./mathLayout";
import { convertLatexToMathML, extractLatexFromRegion } from "./scienceOcr";

/**
 * A tiny typesetter: lays a string out left-to-right at a baseline/size, so the
 * tests describe geometry the way a PDF does (no structure, just positions).
 */
function run(text: string, x: number, base: number, size = 10): MathGlyph[] {
  const out: MathGlyph[] = [];
  let cur = x;
  for (const ch of Array.from(text)) {
    const w = ch === " " ? 0.3 * size : 0.5 * size;
    if (ch !== " ") out.push({ ch, x0: cur, x1: cur + w, base, size });
    cur += w;
  }
  return out;
}
const end = (g: MathGlyph[]): number => g[g.length - 1]!.x1;

describe("glyphsToLatex — structure from glyph geometry", () => {
  it("reads superscripts and subscripts from baseline shift + size", () => {
    const x = run("x", 0, 100);
    const sup = run("2", end(x), 96, 7);
    const plus = run("+y", end(sup) + 3, 100);
    const sub = run("ij", end(plus), 102, 7);
    expect(glyphsToLatex([...x, ...sup, ...plus, ...sub])).toBe("x^2+y_{ij}");
  });

  it("stacks a subscript and superscript on the same base", () => {
    const x = run("x", 0, 100);
    expect(glyphsToLatex([...x, ...run("i", 5, 102.5, 7), ...run("2", 5, 96, 7)])).toBe("x_i^2");
  });

  it("nests a script inside a script", () => {
    const e = run("e", 0, 100);
    const x = run("x", 5, 96, 7);
    const two = run("2", end(x), 93.4, 5);
    expect(glyphsToLatex([...e, ...x, ...two])).toBe("e^{x^2}");
  });

  it("is independent of the order glyphs arrive in", () => {
    const g = [...run("E=mc", 0, 100), ...run("2", 20, 96, 7)];
    expect(glyphsToLatex([...g].reverse())).toBe("E=mc^2");
  });

  it("builds a fraction from a rule with glyphs stacked on it", () => {
    const lhs = run("x=", 0, 100);
    const num = run("a+b", 14, 93);
    const den = run("2c", 16.5, 107);
    const rule: MathRule = { x0: 13, x1: 30, y: 97.5 };
    expect(glyphsToLatex([...lhs, ...num, ...den], [rule])).toBe("x=\\frac{a+b}{2c}");
  });

  it("handles a radical inside a fraction (the quadratic formula)", () => {
    const lhs = run("x=", 0, 100);
    const num = [...run("−b±√b", 14, 93), ...run("2", 39, 89, 7), ...run("−4ac", 43, 93)];
    const den = run("2a", 32, 107);
    const rules: MathRule[] = [
      { x0: 13, x1: 64, y: 97.5 },
      { x0: 33.5, x1: 63.5, y: 84.5 },
    ];
    expect(glyphsToLatex([...lhs, ...num, ...den], rules)).toBe(
      "x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}",
    );
  });

  it("ignores a rule that is just the stroke of a minus sign", () => {
    const g = run("a−b", 0, 100);
    expect(glyphsToLatex(g, [{ x0: 5, x1: 10, y: 97.5 }])).toBe("a-b");
  });

  it("does not turn an underline between two text lines into a fraction", () => {
    const l1 = run("total mass here", 0, 100);
    const l2 = run("other line text", 0, 113);
    const out = glyphsToLatex([...l1, ...l2], [{ x0: 0, x1: 20, y: 103 }]);
    expect(out).not.toContain("\\frac");
    expect(out).toContain("\\\\");
  });

  it("infers a stacked fraction without a rule when a line runs between", () => {
    const lhs = run("y=", 0, 100);
    const num = run("dy", 12, 93);
    const den = run("dx", 12, 107);
    expect(glyphsToLatex([...lhs, ...num, ...den])).toBe("y=\\frac{dy}{dx}");
  });

  it("attaches limits above and below a sum", () => {
    const sum: MathGlyph = { ch: "∑", x0: 0, x1: 14, base: 92, size: 10 };
    const lo = run("i=1", 0.5, 114, 7);
    const hi = run("n", 5, 86, 7);
    const body = run("a", 16, 100);
    const idx = run("i", 21, 102, 7);
    expect(glyphsToLatex([sum, ...lo, ...hi, ...body, ...idx])).toBe("\\sum_{i=1}^na_i");
  });

  it("maps Greek, operators, functions and prose", () => {
    expect(glyphsToLatex(run("α≤β", 0, 100))).toBe("\\alpha\\leq\\beta");
    expect(glyphsToLatex(run("sin θ", 0, 100))).toBe("\\sin\\theta");
    expect(glyphsToLatex(run("x>0 where x∈ℝ", 0, 100))).toBe("x>0\\text{ where }x\\in\\mathbb{R}");
  });

  it("lifts Unicode super/subscript digits", () => {
    expect(glyphsToLatex(run("x²+H₂O", 0, 100))).toBe("x^2+H_2O");
  });

  it("keeps separate lines of a multi-line selection", () => {
    expect(glyphsToLatex([...run("a=b", 0, 100), ...run("c=d", 0, 114)])).toBe("a=b \\\\ c=d");
  });

  it("returns an empty string for no glyphs and never throws on junk", () => {
    expect(glyphsToLatex([])).toBe("");
    expect(glyphsToLatex([{ ch: "x", x0: NaN, x1: 1, base: 0, size: 10 }])).toBe("");
  });

  it("everything it emits compiles to well-formed MathML", () => {
    const latex = [
      "x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}",
      "\\sum_{i=1}^na_i",
      "x>0\\text{ where }x\\in\\mathbb{R}",
      "a=b \\\\ c=d",
      "\\overline{x}+\\sin\\theta",
    ];
    for (const l of latex) {
      const doc = new DOMParser().parseFromString(convertLatexToMathML(l), "application/xml");
      expect(doc.querySelector("parsererror")).toBeNull();
    }
    expect(convertLatexToMathML("\\sum_{i=1}^na_i")).toContain("<msubsup>");
    expect(convertLatexToMathML("a=b \\\\ c=d")).toContain("<mtable>");
    expect(convertLatexToMathML("\\text{if }x")).toContain("<mtext>");
  });
});

describe("detectHorizontalRules", () => {
  function canvas(w: number, h: number, paint: (set: (x: number, y: number) => void) => void) {
    const data = new Uint8ClampedArray(w * h * 4).fill(255);
    paint((x, y) => {
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 0;
    });
    return { data, width: w, height: h };
  }

  it("finds an isolated thin bar", () => {
    const img = canvas(60, 40, (set) => {
      for (let x = 10; x < 50; x++) set(x, 20);
    });
    const rules = detectHorizontalRules(img);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ x0: 10, x1: 50, thickness: 1 });
  });

  it("rejects the top stroke of a T and a solid block", () => {
    const t = canvas(60, 40, (set) => {
      for (let x = 10; x < 30; x++) set(x, 10);
      for (let y = 10; y < 30; y++) for (let x = 18; x < 22; x++) set(x, y);
    });
    expect(detectHorizontalRules(t)).toHaveLength(0);
    const block = canvas(60, 40, (set) => {
      for (let y = 5; y < 35; y++) for (let x = 10; x < 50; x++) set(x, y);
    });
    expect(detectHorizontalRules(block)).toHaveLength(0);
  });

  it("keeps a vinculum whose left end joins a radical stroke", () => {
    const img = canvas(80, 40, (set) => {
      for (let x = 10; x < 70; x++) set(x, 8);
      for (let y = 8; y < 30; y++) set(10 - Math.floor((y - 8) / 6), y);
    });
    expect(detectHorizontalRules(img)).toHaveLength(1);
  });
});

describe("extractLatexFromRegion — box selection over a text layer", () => {
  /** A stage whose spans carry normalized rects, as cache-hydrated layers do. */
  function stage(spans: { text: string; rect: [number, number, number, number]; geom?: string }[]) {
    const el = document.createElement("div");
    const layer = document.createElement("div");
    layer.className = "textLayer";
    for (const s of spans) {
      const span = document.createElement("span");
      span.textContent = s.text;
      span.dataset.normRect = s.rect.join(",");
      if (s.geom) span.dataset.baseGeom = s.geom;
      layer.appendChild(span);
    }
    el.appendChild(layer);
    return el;
  }

  it("takes only the glyphs inside the box when it cuts through a run", () => {
    const el = stage([{ text: "a+b=c+d=", rect: [0.1, 0.1, 0.4, 0.01] }]);
    const out = extractLatexFromRegion(el, { x: 0.3, y: 0.09, width: 0.25, height: 0.03 });
    expect(out).toBe("c+d=");
  });

  it("uses the stamped baseline to recover a superscript", () => {
    const el = stage([
      { text: "x", rect: [0.1, 0.1, 0.005, 0.01], geom: "0.1,0.11,0.01,0" },
      { text: "2", rect: [0.105, 0.096, 0.0035, 0.007], geom: "0.105,0.106,0.007,0" },
    ]);
    expect(extractLatexFromRegion(el, { x: 0, y: 0, width: 1, height: 1 })).toBe("x^2");
  });

  it("skips text that is not horizontal on screen and falls back to the hint", () => {
    const el = stage([{ text: "x", rect: [0.1, 0.1, 0.005, 0.01], geom: "0.1,0.11,0.01,1.5708" }]);
    expect(extractLatexFromRegion(el, { x: 0, y: 0, width: 1, height: 1 }, "α")).toBe("\\alpha");
  });
});

describe("what is in the box but not in the formula", () => {
  it("drops the mark that ends the sentence, and only that", () => {
    expect(dropSentenceMark("E=mc^2.")).toBe("E=mc^2");
    expect(dropSentenceMark("x_{i},")).toBe("x_{i}");
    expect(dropSentenceMark("a,b;")).toBe("a,b");
    expect(dropSentenceMark("f(x)=0\\,.")).toBe("f(x)=0");
    // Spacing commands and dots the author wrote stay.
    expect(dropSentenceMark("a\\,")).toBe("a\\,");
    expect(dropSentenceMark("a,b,...")).toBe("a,b,...");
    expect(dropSentenceMark(".")).toBe(".");
  });

  it("drops an equation number set flush right, clear of the equation", () => {
    const eq = run("x=y", 100, 100);
    expect(glyphsToLatex([...eq, ...run("(12)", 400, 100)])).toBe("x=y");
    expect(glyphsToLatex([...eq, ...run("(2.3)", 400, 100)])).toBe("x=y");
    expect(glyphsToLatex([...eq, ...run("(A.1)", 400, 100)])).toBe("x=y");
    // On a line of its own under a wide equation.
    expect(glyphsToLatex([...eq, ...run("(12)", 400, 114)])).toBe("x=y");
    // And flush left, as leqno sets it.
    expect(glyphsToLatex([...run("(12)", 10, 100), ...eq])).toBe("x=y");
  });

  it("drops the number of each line of a several-line equation", () => {
    const got = glyphsToLatex([...run("x=y", 100, 100), ...run("(1)", 400, 100), ...run("a=b", 100, 120), ...run("(2)", 400, 120)]);
    expect(got).not.toMatch(/\(/);
  });

  it("keeps parentheses that are part of the formula", () => {
    const f = run("f", 100, 100);
    expect(glyphsToLatex([...f, ...run("(1)", end(f), 100)])).toBe("f(1)");
    const eq = run("x=y", 100, 100);
    // Not a number: a condition.
    expect(glyphsToLatex([...eq, ...run("(n>1)", 400, 100)])).toMatch(/\(n>1\)$/);
    // A number alone is the selection.
    expect(glyphsToLatex(run("(12)", 100, 100))).toBe("(12)");
  });
});
