/**
 * M18 FEAT-002 (spec Phase 2, Steps 2.1–2.3) — tests for the chemistry
 * representation + validation layer. Nothing is mocked: the REAL graph parser
 * (chemGraph.ts) and the REAL deterministic validator (chemistryValidation.ts)
 * are exercised. Covers the spec Step 2.1 feature matrix (valid vs invalid
 * SMILES), asserts aromaticity is preserved (c1ccccc1 aromatic, C1CCCCC1 not),
 * and asserts formal charge / isotope / chirality / explicit-H are captured for
 * bracket atoms. An invalid result is never silently accepted (valid:false +
 * non-empty errors).
 */

import { describe, expect, it } from "vitest";
import { parseSmilesGraph, parseReactionGraph, parseBracketAtom } from "./chemGraph";
import { validateSmiles, normalizeSmiles } from "./chemistryValidation";

describe("M18 FEAT-002 — validateSmiles: valid cases", () => {
  const validCases = ["C", "CC", "C=C", "CCO", "c1ccccc1", "CC(=O)O", "[NH4+]", "[O-]", "C1CCCCC1", "CCO.O", "CCO>>CC=O"];

  for (const smiles of validCases) {
    it(`accepts ${smiles} with a normalizedSmiles`, () => {
      const result = validateSmiles(smiles);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(typeof result.normalizedSmiles).toBe("string");
      expect(result.normalizedSmiles!.length).toBeGreaterThan(0);
    });
  }
});

describe("M18 FEAT-002 — validateSmiles: invalid cases are never silently accepted", () => {
  const invalidCases: Array<[string, string]> = [
    ["CC(", "unbalanced parentheses"],
    ["C1CC", "unbalanced ring closure"],
    ["", "empty string"],
    ["C=", "dangling bond operator"],
    ["C[", "unbalanced bracket"],
  ];

  for (const [smiles, why] of invalidCases) {
    it(`rejects "${smiles}" (${why}) with a non-empty errors array`, () => {
      const result = validateSmiles(smiles);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      // An invalid result must NOT carry a normalizedSmiles.
      expect(result.normalizedSmiles).toBeUndefined();
    });
  }
});

describe("M18 FEAT-002 — aromaticity is preserved in the parsed graph", () => {
  it("c1ccccc1 atoms are aromatic:true", () => {
    const [benzene] = parseSmilesGraph("c1ccccc1");
    expect(benzene).toBeTruthy();
    expect(benzene!.atoms.length).toBe(6);
    expect(benzene!.atoms.every((a) => a.aromatic)).toBe(true);
    expect(benzene!.atoms.every((a) => a.element === "C")).toBe(true);
  });

  it("C1CCCCC1 atoms are aromatic:false", () => {
    const [cyclohexane] = parseSmilesGraph("C1CCCCC1");
    expect(cyclohexane).toBeTruthy();
    expect(cyclohexane!.atoms.length).toBe(6);
    expect(cyclohexane!.atoms.every((a) => !a.aromatic)).toBe(true);
  });

  it("the ring-closure bond is preserved for both rings", () => {
    const [benzene] = parseSmilesGraph("c1ccccc1");
    const [cyclohexane] = parseSmilesGraph("C1CCCCC1");
    // 6 chain bonds + 1 ring-closure bond.
    expect(benzene!.bonds.length).toBe(6);
    expect(cyclohexane!.bonds.length).toBe(6);
    // Benzene ring bonds are flagged aromatic.
    expect(benzene!.bonds.some((b) => b.aromatic === true)).toBe(true);
    expect(cyclohexane!.bonds.every((b) => b.aromatic !== true)).toBe(true);
  });
});

describe("M18 FEAT-002 — bracket atoms capture charge / isotope / chirality / explicit-H", () => {
  it("[NH4+] → N, charge +1, explicitH 4", () => {
    const atom = parseBracketAtom("NH4+");
    expect(atom.element).toBe("N");
    expect(atom.charge).toBe(1);
    expect(atom.explicitH).toBe(4);
  });

  it("[O-] → O, charge -1", () => {
    const atom = parseBracketAtom("O-");
    expect(atom.element).toBe("O");
    expect(atom.charge).toBe(-1);
  });

  it("[C@@H] → C, chirality @@, explicitH 1", () => {
    const atom = parseBracketAtom("C@@H");
    expect(atom.element).toBe("C");
    expect(atom.chirality).toBe("@@");
    expect(atom.explicitH).toBe(1);
  });

  it("[13C] → C, isotope 13", () => {
    const atom = parseBracketAtom("13C");
    expect(atom.element).toBe("C");
    expect(atom.isotope).toBe(13);
  });

  it("[Mg+2] → Mg, charge +2", () => {
    const atom = parseBracketAtom("Mg+2");
    expect(atom.element).toBe("Mg");
    expect(atom.charge).toBe(2);
  });

  it("captures bracket-atom data through validateSmiles (valid + warnings)", () => {
    const result = validateSmiles("[C@@H](F)(Cl)Br");
    expect(result.valid).toBe(true);
    // Chirality is captured but flagged as not canonicalized by the default backend.
    expect(result.warnings.some((w) => /stereochemistry/i.test(w))).toBe(true);
  });
});

describe("M18 FEAT-002 — disconnected components and reactions", () => {
  it("CCO.O parses into two disconnected components", () => {
    const components = parseSmilesGraph("CCO.O");
    expect(components.length).toBe(2);
    expect(components[0]!.atoms.length).toBe(3);
    expect(components[1]!.atoms.length).toBe(1);
  });

  it("CCO>>CC=O splits into reactants and products", () => {
    const rxn = parseReactionGraph("CCO>>CC=O");
    expect(rxn.reactants.length).toBe(1);
    expect(rxn.agents.length).toBe(0);
    expect(rxn.products.length).toBe(1);
    expect(rxn.reactants[0]!.atoms.length).toBe(3);
    expect(rxn.products[0]!.atoms.length).toBe(3);
    // The product carbonyl double bond is preserved.
    expect(rxn.products[0]!.bonds.some((b) => b.order === 2)).toBe(true);
  });

  it("normalizeSmiles is deterministic for the same input", () => {
    expect(normalizeSmiles("CCO")).toBe(normalizeSmiles("CCO"));
    expect(normalizeSmiles("c1ccccc1")).toBe(normalizeSmiles("c1ccccc1"));
  });
});
