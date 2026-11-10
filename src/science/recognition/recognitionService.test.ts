/**
 * M18 FEAT-003 (spec Phase 3 + Phase 9) — tests for the recognition ABSTRACTION.
 *
 * These tests prove the spec's mandated deterministic boundary:
 *
 *   model output (string) -> normalization -> validation -> representation
 *
 * The MODEL is the only thing replaced — by an INJECTED stub backend. Nothing
 * else is mocked: the REAL normalizeToLatex / convertLatexToMathML
 * (scienceOcr.ts) and the REAL validateSmiles (chemistryValidation.ts) run, and
 * the produced MathML is XML-parsed to assert it has no <parsererror>.
 *
 * The invariants:
 *  (a) the DEFAULT (not-configured) service returns 'unsupported' for every
 *      kind and never fabricates a latex / smiles;
 *  (b) a fake math backend with valid LaTeX -> 'success' + compiling MathML;
 *  (c) a fake math backend with LaTeX that compiles to empty MathML -> 'invalid'
 *      with non-empty errors (bad LaTeX is NEVER stored silently);
 *  (d) a fake molecule backend 'c1ccccc1' -> 'success' + normalizedSmiles with
 *      aromaticity preserved; 'CC(' -> 'invalid';
 *  (e) low backend confidence -> 'low-confidence'.
 */

import { describe, expect, it } from "vitest";
import { createRecognitionService } from "./recognitionService";
import type { ImageModelBackend, RecognitionInput } from "./types";
import { convertLatexToMathML } from "../../pdf/scienceOcr";
import type { MathRecognitionResult } from "./mathRecognizer";
import type { MoleculeRecognitionResult } from "./moleculeRecognizer";

/** A trivial crop input; its pixels are irrelevant because the model is stubbed. */
const INPUT: RecognitionInput = {
  imageDataUrl: "data:image/png;base64,AAAA",
  width: 100,
  height: 40,
};

/** Build a configured fake backend that echoes a fixed text + optional confidence. */
function fakeBackend(text: string, confidence?: number): ImageModelBackend {
  return {
    id: "fake",
    isConfigured: () => true,
    async infer() {
      return confidence !== undefined ? { text, confidence } : { text };
    },
  };
}

/** Assert MathML is structurally valid + XML-parseable with no parsererror. */
function expectValidMathML(mathml: string): void {
  expect(mathml.startsWith('<math xmlns="http://www.w3.org/1998/Math/MathML"')).toBe(true);
  expect(mathml).toContain("</math>");
  const doc = new DOMParser().parseFromString(mathml, "application/xml");
  expect(doc.querySelector("parsererror")).toBeNull();
}

describe("M18 FEAT-003 — default service never fabricates a result", () => {
  it("returns 'unsupported' for every kind with the default (not-configured) backends", async () => {
    const service = createRecognitionService();

    const eq = (await service.recognize("equation", INPUT)) as MathRecognitionResult;
    expect(eq.kind).toBe("equation");
    expect(eq.status).toBe("unsupported");
    expect(eq.latex).toBeUndefined();

    const mol = (await service.recognize("molecule", INPUT)) as MoleculeRecognitionResult;
    expect(mol.kind).toBe("molecule");
    expect(mol.status).toBe("unsupported");
    expect(mol.smiles).toBeUndefined();
    expect(mol.normalizedSmiles).toBeUndefined();

    const rxn = await service.recognize("reaction", INPUT);
    expect(rxn.kind).toBe("reaction");
    expect(rxn.status).toBe("unsupported");
  });
});

describe("M18 FEAT-003 — equation deterministic boundary (injected math backend)", () => {
  it("valid LaTeX -> 'success' + latex that compiles to valid MathML", async () => {
    const latex = "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}";
    const service = createRecognitionService({ mathBackend: fakeBackend(latex) });

    const result = (await service.recognize("equation", INPUT)) as MathRecognitionResult;
    expect(result.status).toBe("success");
    expect(typeof result.latex).toBe("string");
    expect(result.latex!.length).toBeGreaterThan(0);

    const mathml = convertLatexToMathML(result.latex!);
    expectValidMathML(mathml);
    expect(mathml).not.toContain("<mrow></mrow></math>");
  });

  it("LaTeX that compiles to empty MathML -> 'invalid' with non-empty errors", async () => {
    // Whitespace-only normalizes to the empty string, which compiles to an
    // empty <mrow></mrow> — this must be rejected, not stored silently.
    const service = createRecognitionService({ mathBackend: fakeBackend("   ") });

    const result = (await service.recognize("equation", INPUT)) as MathRecognitionResult;
    expect(result.status).toBe("invalid");
    expect(result.latex).toBeUndefined();
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it("low backend confidence -> 'low-confidence' (still carries the latex)", async () => {
    const service = createRecognitionService({ mathBackend: fakeBackend("E = mc^2", 0.2) });

    const result = (await service.recognize("equation", INPUT)) as MathRecognitionResult;
    expect(result.status).toBe("low-confidence");
    expect(result.latex).toBeDefined();
    expect(result.confidence).toBe(0.2);
    expectValidMathML(convertLatexToMathML(result.latex!));
  });
});

describe("M18 FEAT-003 — molecule deterministic boundary (injected molecule backend)", () => {
  it("'c1ccccc1' -> 'success' with normalizedSmiles and aromaticity preserved", async () => {
    const service = createRecognitionService({ moleculeBackend: fakeBackend("c1ccccc1") });

    const result = (await service.recognize("molecule", INPUT)) as MoleculeRecognitionResult;
    expect(result.status).toBe("success");
    expect(result.smiles).toBe("c1ccccc1");
    expect(typeof result.normalizedSmiles).toBe("string");
    // Aromaticity preserved: lowercase aromatic carbons are NOT uppercased.
    expect(result.normalizedSmiles).toContain("c");
    expect(result.normalizedSmiles).not.toContain("C");
  });

  it("'CC(' -> 'invalid' with errors (unbalanced parentheses never accepted)", async () => {
    const service = createRecognitionService({ moleculeBackend: fakeBackend("CC(") });

    const result = (await service.recognize("molecule", INPUT)) as MoleculeRecognitionResult;
    expect(result.status).toBe("invalid");
    expect(result.normalizedSmiles).toBeUndefined();
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it("low backend confidence on a valid SMILES -> 'low-confidence'", async () => {
    const service = createRecognitionService({ moleculeBackend: fakeBackend("CCO", 0.1) });

    const result = (await service.recognize("molecule", INPUT)) as MoleculeRecognitionResult;
    expect(result.status).toBe("low-confidence");
    expect(result.normalizedSmiles).toBeDefined();
    expect(result.confidence).toBe(0.1);
  });
});

describe("M18 FEAT-003 — reaction recognition is explicitly deferred", () => {
  it("returns 'unsupported' even with an injected backend (segmentation is a later phase)", async () => {
    const service = createRecognitionService({ reactionBackend: fakeBackend("CCO>>CC=O") });
    const result = await service.recognize("reaction", INPUT);
    expect(result.status).toBe("unsupported");
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });
});
