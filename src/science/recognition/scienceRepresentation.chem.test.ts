/**
 * M18 FEAT-001 (spec Phase 1, Step 1.1 — Chemistry) — regression tests that
 * lock down the EXISTING M17 SMILES → mechanism-SVG representation in
 * src/pdf/scienceOcr.ts. Nothing is mocked: each case drives the REAL exported
 * `renderMechanismSvg` and asserts that the deterministic skeletal renderer
 * does not SILENTLY lose atoms or bonds (heteroatom labels + the expected
 * number of `ito-bond` lines appear) and that the emitted SVG is XML-parseable
 * with no `<parsererror>`.
 *
 * Where the CURRENT minimal parser is known to lose information it is
 * DOCUMENTED, not asserted as supported — see the aromatic-uppercasing test,
 * which pins the present (lossy) behavior and points at FEAT-002, which will
 * preserve aromaticity (c1ccccc1 must become distinguishable from C1CCCCC1).
 */

import { describe, expect, it } from "vitest";
import { renderMechanismSvg } from "../../pdf/scienceOcr";

/** Parse the SVG as XML and assert there is no parsererror; return the doc. */
function expectValidSvg(svg: string): Document {
  expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
  expect(svg).toContain("</svg>");
  const doc = new DOMParser().parseFromString(svg, "application/xml");
  expect(doc.querySelector("parsererror")).toBeNull();
  return doc;
}

/** Count the skeletal bond lines (class="ito-bond") in the markup. */
function countBondLines(svg: string): number {
  return (svg.match(/class="ito-bond"/g) ?? []).length;
}

/** Count the heteroatom labels of a given element (e.g. "O", "N"). */
function countHeteroLabels(doc: Document, element: string): number {
  return Array.from(doc.querySelectorAll("text.ito-atom-label")).filter(
    (t) => (t.textContent ?? "").trim() === element,
  ).length;
}

describe("M18 FEAT-001 — M17 chemistry representation (SMILES → skeletal SVG)", () => {
  it("renders every spec Step 1.1 SMILES to structurally valid SVG", () => {
    for (const smiles of ["C", "CC", "C=C", "CCO", "c1ccccc1", "CC(=O)O"]) {
      expectValidSvg(renderMechanismSvg({ smiles, arrows: [] }));
    }
  });

  it("C (single carbon): one vertex, zero bonds, no heteroatom labels", () => {
    const svg = renderMechanismSvg({ smiles: "C", arrows: [] });
    const doc = expectValidSvg(svg);
    expect(countBondLines(svg)).toBe(0);
    expect(doc.querySelectorAll("text.ito-atom-label").length).toBe(0);
  });

  it("CC (ethane): two carbons joined by exactly one single bond", () => {
    const svg = renderMechanismSvg({ smiles: "CC", arrows: [] });
    expectValidSvg(svg);
    // Two atoms → exactly one bond line (single bond = 1 line).
    expect(countBondLines(svg)).toBe(1);
  });

  it("C=C (ethene): a double bond renders as two parallel bond lines", () => {
    const svg = renderMechanismSvg({ smiles: "C=C", arrows: [] });
    expectValidSvg(svg);
    // One double bond → two parallel ito-bond lines (no atoms lost, order kept).
    expect(countBondLines(svg)).toBe(2);
  });

  it("CCO (ethanol): preserves the O heteroatom label and both chain bonds", () => {
    const svg = renderMechanismSvg({ smiles: "CCO", arrows: [] });
    const doc = expectValidSvg(svg);
    // C–C and C–O → two single bonds, and the O is labelled as a heteroatom.
    expect(countBondLines(svg)).toBe(2);
    expect(countHeteroLabels(doc, "O")).toBe(1);
  });

  it("CC(=O)O (acetic acid): keeps the branch + carbonyl double bond + both oxygens", () => {
    const svg = renderMechanismSvg({ smiles: "CC(=O)O", arrows: [] });
    const doc = expectValidSvg(svg);
    // Atoms: C, C, O (=O carbonyl), O (hydroxyl) → two O heteroatom labels.
    expect(countHeteroLabels(doc, "O")).toBe(2);
    // Bonds: C–C (1 line) + C=O carbonyl (2 parallel lines) + C–O (1 line) = 4.
    // The carbonyl double bond is preserved (two of the four lines come from it).
    expect(countBondLines(svg)).toBe(4);
  });

  it("CCO>>CC=O (reaction SMILES): splits into a reactant side and a product side", () => {
    const svg = renderMechanismSvg({ smiles: "CCO>>CC=O", arrows: [] });
    const doc = expectValidSvg(svg);
    // A reaction arrow is drawn between the two sides.
    expect(doc.querySelector("line.ito-reaction-arrow")).not.toBeNull();
    // Reactant CCO (1 O label, 2 bonds) + product CC=O (1 O label; C–C single +
    // C=O double = 3 bond lines) → 2 O labels and 5 bond lines total. Atoms and
    // bond orders survive the reactant/product split (nothing silently dropped).
    expect(countHeteroLabels(doc, "O")).toBe(2);
    expect(countBondLines(svg)).toBe(5);
  });

  it("DOCUMENTS known-lossy current behavior: aromatic SMILES are uppercased (FEAT-002 will fix)", () => {
    // CURRENT M17 behavior (verified against readOrganicElement in
    // src/pdf/scienceOcr.ts): aromatic lowercase atoms are UPPERCASED, so the
    // benzene ring c1ccccc1 renders byte-identically to the saturated ring
    // C1CCCCC1 — aromaticity is LOST. This is a representation limitation, not
    // a feature. FEAT-002 (Phase 2.2 of `kiro science`) will preserve
    // aromaticity so c1ccccc1 becomes distinguishable from C1CCCCC1. This test
    // pins the present lossy behavior so that fix is a deliberate, visible
    // change rather than an accidental one.
    const aromatic = renderMechanismSvg({ smiles: "c1ccccc1", arrows: [] });
    const saturated = renderMechanismSvg({ smiles: "C1CCCCC1", arrows: [] });
    expectValidSvg(aromatic);
    expectValidSvg(saturated);
    // The ring closure bond is present on both (6 atoms → 6 ring bonds).
    expect(countBondLines(aromatic)).toBe(countBondLines(saturated));
    // KNOWN LOSS: the only thing distinguishing the two outputs today is the
    // raw `data-smiles` attribute (the input string is echoed verbatim). The
    // actual RENDERED chemistry — every atom label and bond line — is byte
    // identical, because the aromatic lowercase atoms were uppercased to C
    // before layout. Aromaticity is therefore lost in the representation.
    // FEAT-002 (Phase 2.2 of `kiro science`) must preserve aromaticity so the
    // rendered geometry (not merely the echoed attribute) differs.
    const stripSmilesAttr = (svg: string): string =>
      svg.replace(/ data-smiles="[^"]*"/, "");
    expect(stripSmilesAttr(aromatic)).toBe(stripSmilesAttr(saturated));
  });

  it("is deterministic: identical SMILES yields byte-identical SVG", () => {
    const a = renderMechanismSvg({ smiles: "CC(=O)O", arrows: [] });
    const b = renderMechanismSvg({ smiles: "CC(=O)O", arrows: [] });
    expect(a).toBe(b);
  });
});
