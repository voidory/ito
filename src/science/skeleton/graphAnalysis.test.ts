/**
 * FEAT-005 — unit tests for the graph-theoretic analysis: connected
 * components, cycle rank μ = E − V + C, cycle basis, branch / endpoint
 * detection and ring-substituent tracing. Pure graph theory, no images.
 */

import { describe, expect, it } from "vitest";
import {
  branchVertices,
  connectedComponents,
  cycleRank,
  degrees,
  endpointVertices,
  minimumCycleBasis,
  ringSubstituentChains,
  verticesInCycles,
  type Edge,
} from "./graphAnalysis";

const e = (a: number, b: number): Edge => ({ a, b });

describe("connectedComponents", () => {
  it("finds separate components including singletons", () => {
    const comps = connectedComponents(5, [e(0, 1), e(1, 2)]);
    expect(comps).toEqual([
      [0, 1, 2],
      [3],
      [4],
    ]);
  });
});

describe("cycleRank μ = E - V + C", () => {
  it("is 0 for a tree (open chain)", () => {
    expect(cycleRank(4, [e(0, 1), e(1, 2), e(2, 3)])).toBe(0);
  });

  it("is 1 for a single ring", () => {
    expect(cycleRank(4, [e(0, 1), e(1, 2), e(2, 3), e(3, 0)])).toBe(1);
  });

  it("is 2 for two fused rings (shared edge)", () => {
    // 0-1-2-3-0 and 2-3 shared with 2-4-5-3
    const edges = [e(0, 1), e(1, 2), e(2, 3), e(3, 0), e(2, 4), e(4, 5), e(5, 3)];
    expect(cycleRank(6, edges)).toBe(2);
  });

  it("ignores duplicate edges and self-loops", () => {
    expect(cycleRank(3, [e(0, 1), e(1, 0), e(2, 2)])).toBe(0);
  });
});

describe("minimumCycleBasis", () => {
  it("returns one cycle for a single ring, covering all ring vertices", () => {
    const basis = minimumCycleBasis(4, [e(0, 1), e(1, 2), e(2, 3), e(3, 0)]);
    expect(basis).toHaveLength(1);
    expect([...(basis[0] as number[])].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it("returns two cycles for two fused rings", () => {
    const edges = [e(0, 1), e(1, 2), e(2, 3), e(3, 0), e(2, 4), e(4, 5), e(5, 3)];
    const basis = minimumCycleBasis(6, edges);
    expect(basis).toHaveLength(2);
  });

  it("finds a cycle that excludes a pendant branch", () => {
    // triangle 0-1-2 with a tail 2-3
    const edges = [e(0, 1), e(1, 2), e(2, 0), e(2, 3)];
    const inCycle = verticesInCycles(4, edges);
    expect(inCycle.has(0)).toBe(true);
    expect(inCycle.has(1)).toBe(true);
    expect(inCycle.has(2)).toBe(true);
    expect(inCycle.has(3)).toBe(false); // the tail is not on the ring
  });
});

describe("degree-based branch / endpoint detection", () => {
  const edges = [e(0, 1), e(1, 2), e(1, 3)]; // 1 is a junction, 0/2/3 terminals
  it("computes degrees", () => {
    expect(degrees(4, edges)).toEqual([1, 3, 1, 1]);
  });
  it("identifies branch vertices (degree >= 3)", () => {
    expect(branchVertices(4, edges)).toEqual([1]);
  });
  it("identifies endpoint vertices (degree 1)", () => {
    expect(endpointVertices(4, edges)).toEqual([0, 2, 3]);
  });
});

describe("ringSubstituentChains", () => {
  it("traces a substituent chain hanging off a ring vertex", () => {
    // ring 0-1-2-3-0, substituent chain 0-4-5
    const edges = [e(0, 1), e(1, 2), e(2, 3), e(3, 0), e(0, 4), e(4, 5)];
    const ring = verticesInCycles(6, edges);
    const chains = ringSubstituentChains(6, edges, ring);
    expect(chains).toHaveLength(1);
    expect(chains[0]).toEqual([4, 5]);
  });

  it("does not treat a ring-ring bond as a substituent", () => {
    // two triangles sharing vertex 0 via a bond 0-3 (spiro-ish via edge)
    const edges = [e(0, 1), e(1, 2), e(2, 0), e(0, 3), e(3, 4), e(4, 0)];
    const ring = verticesInCycles(5, edges);
    const chains = ringSubstituentChains(5, edges, ring);
    // every vertex is in a ring, so there is no substituent chain.
    expect(chains).toHaveLength(0);
  });
});
