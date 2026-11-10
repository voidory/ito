/**
 * M18 FEAT-004 (spec Steps 4.5 / 5.2 / Phase 12) — the DETERMINISTIC
 * recognition boundary for equations + molecules.
 *
 *   model output (string)  ->  normalization  ->  validation  ->  representation
 *
 * The MODEL is the only thing replaced, by an INJECTED stub backend. Everything
 * downstream is the REAL code: normalizeToLatex + convertLatexToMathML
 * (scienceOcr.ts) for equations, validateSmiles (chemistryValidation.ts) for
 * molecules. For each equation class we assert the produced MathML is
 * XML-parseable (<math>, no <parsererror>) and carries the expected structural
 * element; for each molecule class we assert a 'success' result with a
 * normalizedSmiles that preserves aromaticity / charge.
 */

import { describe, expect, it } from "vitest";
import { createRecognitionService } from "./recognitionService";
import { convertLatexToMathML } from "../../pdf/scienceOcr";
import type { ImageModelBackend, RecognitionInput } from "./types";
import type { MathRecognitionResult } from "./mathRecognizer";
import type { MoleculeRecognitionResult } from "./moleculeRecognizer";

const INPUT: RecognitionInput = {
  imageDataUrl: "data:image/png;base64,AAAA",
  width: 120,
  height: 48,
};

/** A configured fake backend that echoes a fixed model output string. */
function fakeBackend(text: string): ImageModelBackend {
  return {
    id: "fake",
    isConfigured: () => true,
    async infer() {
      return { text };
    },
  };
}

/** XML-parse the MathML and assert it is well-formed with no <parsererror>. */
function expectParseableMathML(mathml: string): void {
  expect(mathml.startsWith('<math xmlns="http://www.w3.org/1998/Math/MathML"')).toBe(true);
  expect(mathml).toContain("</math>");
  const doc = new DOMParser().parseFromString(mathml, "application/xml");
  expect(doc.querySelector("parsererror")).toBeNull();
}

async function recognizeEquation(latex: string): Promise<MathRecognitionResult> {
  const service = createRecognitionService({ mathBackend: fakeBackend(latex) });
  return (await service.recognize("equation", INPUT)) as MathRecognitionResult;
}

async function recognizeMolecule(smiles: string): Promise<MoleculeRecognitionResult> {
  const service = createRecognitionService({ moleculeBackend: fakeBackend(smiles) });
  return (await service.recognize("molecule", INPUT)) as MoleculeRecognitionResult;
}

describe("M18 FEAT-004 — equation boundary: model LaTeX -> MathML structure", () => {
  // [latex, expected structural element produced by convertLatexToMathML]
  const cases: Array<[string, string]> = [
    ["x + y = z", "<mi>"],
    ["\\frac{a}{b}", "<mfrac>"],
    ["\\sqrt{x}", "<msqrt>"],
    ["x^2", "<msup>"],
    ["a_i", "<msub>"],
    ["\\alpha + \\beta", "<mi>"],
    ["\\int_0^1 x\\,dx", "<msubsup>"],
    ["\\sum_{i=1}^{n} i", "<msub>"],
  ];

  for (const [latex, expectedEl] of cases) {
    it(`"${latex}" -> success + MathML containing ${expectedEl}`, async () => {
      const result = await recognizeEquation(latex);
      expect(result.status).toBe("success");
      expect(typeof result.latex).toBe("string");
      expect(result.latex!.length).toBeGreaterThan(0);

      const mathml = convertLatexToMathML(result.latex!);
      expectParseableMathML(mathml);
      expect(mathml).toContain(expectedEl);
    });
  }

  it("Greek letters carry through to their glyphs in the MathML", async () => {
    const result = await recognizeEquation("\\alpha + \\beta");
    const mathml = convertLatexToMathML(result.latex!);
    expectParseableMathML(mathml);
    // α / β glyphs are present (not left as literal \alpha).
    expect(mathml).toMatch(/α|β/);
  });

  it("whitespace-only model output is rejected as invalid (never stored)", async () => {
    const result = await recognizeEquation("   ");
    expect(result.status).toBe("invalid");
    expect(result.latex).toBeUndefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });
});

describe("M18 FEAT-004 — molecule boundary: model SMILES -> validation", () => {
  // [smiles, assertion on the normalizedSmiles]
  // The deterministic normalizer canonicalizes to an atom sequence (ring-closure
  // digits + branch parens are dropped), so assertions target the ATOMS it keeps.
  const cases: Array<[string, (n: string) => void]> = [
    ["C", (n) => expect(n).toBe("C")],
    ["CCO", (n) => expect(n.toUpperCase()).toContain("CCO")],
    ["CC(=O)O", (n) => expect(n.toUpperCase()).toContain("CCOO")],
    ["C1CCCCC1", (n) => expect(n.toUpperCase()).toBe("CCCCCC")],
  ];

  for (const [smiles, assertNorm] of cases) {
    it(`"${smiles}" -> success with a normalizedSmiles`, async () => {
      const result = await recognizeMolecule(smiles);
      expect(result.status).toBe("success");
      expect(result.smiles).toBe(smiles);
      expect(typeof result.normalizedSmiles).toBe("string");
      assertNorm(result.normalizedSmiles!);
    });
  }

  it("aromatic c1ccccc1 preserves lowercase aromaticity (never uppercased)", async () => {
    const result = await recognizeMolecule("c1ccccc1");
    expect(result.status).toBe("success");
    expect(result.normalizedSmiles).toContain("c");
    expect(result.normalizedSmiles).not.toContain("C");
  });

  it("charged [NH4+] preserves the + charge", async () => {
    const result = await recognizeMolecule("[NH4+]");
    expect(result.status).toBe("success");
    expect(result.normalizedSmiles).toContain("+");
  });

  it("charged [O-] preserves the - charge", async () => {
    const result = await recognizeMolecule("[O-]");
    expect(result.status).toBe("success");
    expect(result.normalizedSmiles).toContain("-");
  });

  it("heteroatom alcohol CCO retains the oxygen", async () => {
    const result = await recognizeMolecule("CCO");
    expect(result.status).toBe("success");
    expect(result.normalizedSmiles!.toUpperCase()).toContain("O");
  });

  it("an invalid SMILES (unbalanced parens) is never silently accepted", async () => {
    const result = await recognizeMolecule("CC(");
    expect(result.status).toBe("invalid");
    expect(result.normalizedSmiles).toBeUndefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });
});
