/**
 * FEAT-003 (M2) — relationship endpoint normalizer tests (ADR-0008).
 *
 * `relationshipEndpoints` is the ONE accessor the rest of the app uses to read
 * a relationship's endpoints, reconciling the legacy directed 2-page edge with
 * the N-endpoint "Connecting Page". `isStarHub` derives the lens-vs-star rule
 * (A13-M2) from the normalized endpoint count.
 */

import { describe, expect, it } from "vitest";
import { isStarHub, relationshipEndpoints } from "./relationship";
import { newPageId, newRelationshipId, type Relationship } from "./index";

function rel(partial: Partial<Relationship>): Relationship {
  const from = newPageId();
  const to = newPageId();
  return {
    id: newRelationshipId(),
    fromPageId: from,
    toPageId: to,
    kind: "relates",
    label: "",
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

describe("relationshipEndpoints", () => {
  it("falls back to [from, to] for a 2-page degenerate edge", () => {
    const r = rel({});
    expect(relationshipEndpoints(r)).toEqual([r.fromPageId, r.toPageId]);
    expect(isStarHub(r)).toBe(false);
  });

  it("uses the explicit endpointPageIds when present", () => {
    const ids = [newPageId(), newPageId(), newPageId()];
    const r = rel({ endpointPageIds: ids });
    expect(relationshipEndpoints(r)).toEqual(ids);
    expect(isStarHub(r)).toBe(true);
  });

  it("treats exactly 2 explicit endpoints as a lens", () => {
    const ids = [newPageId(), newPageId()];
    const r = rel({ endpointPageIds: ids });
    expect(isStarHub(r)).toBe(false);
  });
});
