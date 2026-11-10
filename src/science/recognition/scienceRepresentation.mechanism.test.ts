/**
 * M18 FEAT-001 (spec Phase 1, Step 1.1 — Mechanisms) — regression tests that
 * lock down the EXISTING M17 curly-arrow mechanism renderer in
 * src/pdf/scienceOcr.ts. Nothing is mocked: each case drives the REAL exported
 * `renderMechanismSvg` with a `ChemicalMechanismSpec` and asserts the renderer
 * FAILS GRACEFULLY — it always emits a well-formed `<svg>` (XML-parseable, no
 * `<parsererror>`), an electron-pushing arrow NEVER silently vanishes (every
 * arrow yields exactly one `ito-curly-arrow` path, even when its anchors
 * reference atoms that do not exist), full/fishhook arrows select the correct
 * markers, reaction-condition captions appear, and output is byte-deterministic.
 */

import { describe, expect, it } from "vitest";
import { renderMechanismSvg } from "../../pdf/scienceOcr";
import type { ChemicalMechanismSpec } from "../../model";

/** Parse the SVG as XML and assert there is no parsererror; return the doc. */
function expectValidSvg(svg: string): Document {
  expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
  expect(svg).toContain("</svg>");
  const doc = new DOMParser().parseFromString(svg, "application/xml");
  expect(doc.querySelector("parsererror")).toBeNull();
  return doc;
}

function countCurlyArrows(svg: string): number {
  return (svg.match(/class="ito-curly-arrow"/g) ?? []).length;
}

describe("M18 FEAT-001 — M17 mechanism renderer (ChemicalMechanismSpec → SVG)", () => {
  it("atom-to-atom and bond-to-atom arrows each render exactly one curly path", () => {
    const spec: ChemicalMechanismSpec = {
      smiles: "C=C.BrBr>>BrCCBr",
      arrows: [
        // atom-to-atom
        { id: "a1", fromAtomOrBond: "C1", toAtomOrBond: "Br1", barb: "full" },
        // bond-to-atom (source names a bond "Br1-Br2")
        { id: "a2", fromAtomOrBond: "Br1-Br2", toAtomOrBond: "C2", barb: "fishhook" },
      ],
    };
    const svg = renderMechanismSvg(spec);
    expectValidSvg(svg);
    // Both arrows are drawn — none silently dropped.
    expect(countCurlyArrows(svg)).toBe(2);
  });

  it("full arrows use the full barb marker and fishhook arrows use the fishhook barb marker", () => {
    const svg = renderMechanismSvg({
      smiles: "C=C.BrBr>>BrCCBr",
      arrows: [
        { id: "full-1", fromAtomOrBond: "C1", toAtomOrBond: "Br1", barb: "full" },
        { id: "fish-1", fromAtomOrBond: "Br1", toAtomOrBond: "Br2", barb: "fishhook" },
      ],
    });
    expectValidSvg(svg);
    expect(svg).toContain("url(#ito-full-barb)");
    expect(svg).toContain("url(#ito-fishhook-barb)");
    // Barb metadata is carried on each path.
    expect((svg.match(/data-barb="full"/g) ?? []).length).toBe(1);
    expect((svg.match(/data-barb="fishhook"/g) ?? []).length).toBe(1);
  });

  it("renders reaction conditions above and below the arrow", () => {
    const svg = renderMechanismSvg({
      smiles: "CCO>>CC=O",
      conditionsAbove: "PCC",
      conditionsBelow: "DCM",
      arrows: [],
    });
    const doc = expectValidSvg(svg);
    const above = doc.querySelector("text.ito-conditions-above");
    const below = doc.querySelector("text.ito-conditions-below");
    expect(above?.textContent).toBe("PCC");
    expect(below?.textContent).toBe("DCM");
  });

  it("FAILS GRACEFULLY on malformed/unresolved anchors: arrows still render, SVG still valid", () => {
    // fromAtomOrBond / toAtomOrBond reference atoms that do not exist anywhere
    // in the scheme. The renderer must NOT throw and must NOT drop the arrow —
    // an electron-pushing arrow silently vanishing would misrepresent the
    // mechanism. It deterministically arcs across the scene instead.
    const spec: ChemicalMechanismSpec = {
      smiles: "CC>>CC",
      arrows: [
        { id: "ghost-1", fromAtomOrBond: "Xe9", toAtomOrBond: "Zz42", barb: "full" },
        { id: "ghost-2", fromAtomOrBond: "", toAtomOrBond: "", barb: "fishhook" },
        { id: "ghost-3", fromAtomOrBond: "Q[7]", toAtomOrBond: "nowhere", barb: "full" },
      ],
    };
    const svg = renderMechanismSvg(spec);
    expectValidSvg(svg);
    // All three unresolved arrows are still drawn — none vanished.
    expect(countCurlyArrows(svg)).toBe(3);
    // Each carries its id so the UI can still edit/remove it.
    expect(svg).toContain('data-arrow-id="ghost-1"');
    expect(svg).toContain('data-arrow-id="ghost-2"');
    expect(svg).toContain('data-arrow-id="ghost-3"');
  });

  it("produces a well-formed SVG even for an empty / degenerate spec", () => {
    // No reactants, no products, no arrows: still a parseable <svg>.
    const svg = renderMechanismSvg({ smiles: "", arrows: [] });
    expectValidSvg(svg);
    expect(countCurlyArrows(svg)).toBe(0);
  });

  it("is deterministic: identical mechanism input yields byte-identical markup", () => {
    const spec: ChemicalMechanismSpec = {
      smiles: "C=C.BrBr>>BrCCBr",
      conditionsAbove: "CH2Cl2",
      conditionsBelow: "0 °C",
      arrows: [
        { id: "a1", fromAtomOrBond: "C1=C2", toAtomOrBond: "Br1", barb: "full" },
        { id: "a2", fromAtomOrBond: "Br1-Br2", toAtomOrBond: "Br2", barb: "fishhook" },
        { id: "a3", fromAtomOrBond: "ghost", toAtomOrBond: "void", barb: "full" },
      ],
    };
    expect(renderMechanismSvg(spec)).toBe(renderMechanismSvg(spec));
  });
});
