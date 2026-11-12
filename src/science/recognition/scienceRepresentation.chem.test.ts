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

  it("FEAT-002 preserves aromaticity: c1ccccc1 now renders DIFFERENTLY from C1CCCCC1", () => {
    // FEAT-001 pinned the (then) lossy M17 behavior: aromatic lowercase atoms
    // were uppercased, so benzene c1ccccc1 rendered byte-identically to the
    // saturated ring C1CCCCC1. FEAT-002 (spec Phase 2.2) extended the internal
    // representation (src/science/recognition/chemGraph.ts) to PRESERVE
    // aromaticity, and the renderer now marks aromatic bonds and draws an inner
    // aromatic ring — so the two SMILES are no longer byte-identical even after
    // stripping the echoed data-smiles attribute. This assertion was updated
    // (per the FEAT-001 pointer) to require that difference.
    const aromatic = renderMechanismSvg({ smiles: "c1ccccc1", arrows: [] });
    const saturated = renderMechanismSvg({ smiles: "C1CCCCC1", arrows: [] });
    expectValidSvg(aromatic);
    expectValidSvg(saturated);
    // Both still have the same number of skeletal bond lines (6 atoms → 6 bonds).
    expect(countBondLines(aromatic)).toBe(countBondLines(saturated));
    // Aromaticity is now VISIBLE in the markup: aromatic bonds carry
    // data-aromatic and an inner aromatic ring circle is drawn.
    expect(aromatic).toContain('data-aromatic="true"');
    expect(aromatic).toContain('class="ito-aromatic-ring"');
    expect(saturated).not.toContain('data-aromatic="true"');
    expect(saturated).not.toContain('class="ito-aromatic-ring"');
    // The rendered geometry (not merely the echoed data-smiles attribute) now
    // differs between the aromatic and the saturated ring.
    const stripSmilesAttr = (svg: string): string =>
      svg.replace(/ data-smiles="[^"]*"/, "");
    expect(stripSmilesAttr(aromatic)).not.toBe(stripSmilesAttr(saturated));
  });

  it("is deterministic: identical SMILES yields byte-identical SVG", () => {
    const a = renderMechanismSvg({ smiles: "CC(=O)O", arrows: [] });
    const b = renderMechanismSvg({ smiles: "CC(=O)O", arrows: [] });
    expect(a).toBe(b);
  });
});
