import { describe, expect, it } from "vitest";
import {
  convertLatexToMathML,
  copyScienceToWordClipboard,
  extractLatexFromRegion,
  renderMechanismSvg,
} from "./scienceOcr";
import type { ChemicalMechanismSpec } from "../model";

describe("M17 science recognition/representation primitives", () => {
  it("normalizes Unicode math text into LaTeX", () => {
    expect(
      extractLatexFromRegion(null, { x: 0, y: 0, width: 1, height: 1 }, "α^2 + √x / y"),
    ).toBe("\\alpha^2 + \\sqrt{x} / y");
  });

  it("converts fractions, scripts, roots and Greek commands to MathML", () => {
    const mathml = convertLatexToMathML("\\frac{a_1}{\\sqrt{x^2}} + \\alpha");
    expect(mathml).toContain("<mfrac>");
    expect(mathml).toContain("<msub>");
    expect(mathml).toContain("<msqrt>");
    expect(mathml).toContain("<msup>");
    expect(mathml).toContain("<mi>α</mi>");
    expect(mathml).toContain('xmlns="http://www.w3.org/1998/Math/MathML"');
  });

  it("renders a simple reaction and electron-flow arrows deterministically", () => {
    const spec: ChemicalMechanismSpec = {
      smiles: "C=C.BrBr>>BrCCBr",
      arrows: [
        {
          id: "a1",
          fromAtomOrBond: "Br1",
          toAtomOrBond: "C1",
          barb: "full",
          curvature: 0.5,
        },
      ],
      conditionsAbove: "hv",
    };

    const first = renderMechanismSvg(spec);
    const second = renderMechanismSvg(spec);

    expect(first).toBe(second);
    expect(first).toContain('data-testid="chem-mechanism-svg"');
    expect(first).toContain('data-smiles="C=C.BrBr&gt;&gt;BrCCBr"');
    expect(first).toContain('data-arrow-id="a1"');
    expect(first).toContain("ito-reaction-head");
  });

  it("builds Word clipboard payloads without requiring a browser clipboard", async () => {
    const payload = await copyScienceToWordClipboard({ kind: "math", latex: "E=mc^2" });
    expect(payload.plainText).toBe("E=mc^2");
    expect(payload.htmlText).toContain("<math");
    expect(payload.htmlText).toContain("<msup>");
  });
});
