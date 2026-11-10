/**
 * FEAT-005 — unit tests for graph comparison / isomorphism used by the
 * benchmark to score reconstructions against ground truth.
 */

import { describe, expect, it } from "vitest";
import { compareGraphs, invariants, isIsomorphic, type SimpleGraph } from "./graphCompare";

const path4: SimpleGraph = {
  vertexCount: 4,
  edges: [
    { a: 0, b: 1 },
    { a: 1, b: 2 },
    { a: 2, b: 3 },
  ],
};
// Same path, relabelled (3-2-1-0): isomorphic to path4.
const path4Relabelled: SimpleGraph = {
  vertexCount: 4,
  edges: [
    { a: 3, b: 2 },
    { a: 2, b: 1 },
    { a: 1, b: 0 },
  ],
};
// A star (center 1): same V/E but different degree sequence.
const star4: SimpleGraph = {
  vertexCount: 4,
  edges: [
    { a: 0, b: 1 },
    { a: 1, b: 2 },
    { a: 1, b: 3 },
  ],
};

describe("invariants", () => {
  it("computes V, E, sorted degree sequence and cycle rank", () => {
    const inv = invariants(path4);
    expect(inv.vertices).toBe(4);
    expect(inv.edges).toBe(3);
    expect(inv.degreeSequence).toEqual([1, 1, 2, 2]);
    expect(inv.cycleRank).toBe(0);
  });
});

describe("isIsomorphic", () => {
  it("recognises relabelled identical graphs", () => {
    expect(isIsomorphic(path4, path4Relabelled)).toBe(true);
  });

  it("rejects graphs with different degree sequences", () => {
    expect(isIsomorphic(path4, star4)).toBe(false);
  });

  it("distinguishes two non-isomorphic graphs with equal V, E and degree seq", () => {
    // Two triangles with a pendant each vs. a 6-cycle: both 6V/6E, but only one
    // has degree-3 vertices. Use a subtler pair: C4+C4 disjoint vs C8.
    const twoSquares: SimpleGraph = {
      vertexCount: 8,
      edges: [
        { a: 0, b: 1 },
        { a: 1, b: 2 },
        { a: 2, b: 3 },
        { a: 3, b: 0 },
        { a: 4, b: 5 },
        { a: 5, b: 6 },
        { a: 6, b: 7 },
        { a: 7, b: 4 },
      ],
    };
    const octagon: SimpleGraph = {
      vertexCount: 8,
      edges: [
        { a: 0, b: 1 },
        { a: 1, b: 2 },
        { a: 2, b: 3 },
        { a: 3, b: 4 },
        { a: 4, b: 5 },
        { a: 5, b: 6 },
        { a: 6, b: 7 },
        { a: 7, b: 0 },
      ],
    };
    // Same V(8), E(8), all degree 2 — but different cycle rank (2 vs 1), so the
    // comparison catches it via invariants before even attempting backtracking.
    expect(compareGraphs(twoSquares, octagon).isomorphic).toBe(false);
    expect(isIsomorphic(twoSquares, octagon)).toBe(false);
  });
});

describe("compareGraphs", () => {
  it("reports isomorphic with no mismatches for equal graphs", () => {
    const cmp = compareGraphs(path4, path4Relabelled);
    expect(cmp.isomorphic).toBe(true);
    expect(cmp.mismatches).toHaveLength(0);
  });

  it("lists specific invariant mismatches", () => {
    const cmp = compareGraphs(path4, star4);
    expect(cmp.isomorphic).toBe(false);
    expect(cmp.mismatches.join(" ")).toMatch(/degree sequence/);
  });
});
