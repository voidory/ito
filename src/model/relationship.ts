/**
 * The single normalized accessor for a Relationship's endpoints (ADR-0008).
 *
 * A Relationship may carry an explicit N>=2 `endpointPageIds` list (the N>=3
 * star-hub "Connecting Page", §3.1) OR be the DEGENERATE 2-page edge described
 * only by `fromPageId`/`toPageId`. The rest of the app must read endpoints ONE
 * way so lens-vs-star topology, hub geometry and blendColor derivation all see
 * a consistent list — never branch on the presence of `endpointPageIds`
 * elsewhere.
 */

import type { PageId } from "./ids";
import type { Relationship } from "./types";

/**
 * Normalized endpoint page ids for a relationship. Returns `endpointPageIds`
 * when present (N-endpoint hub), otherwise the 2-page degenerate case
 * `[fromPageId, toPageId]`. The result is always length >= 2 for a well-formed
 * relationship.
 */
export function relationshipEndpoints(rel: Relationship): readonly PageId[] {
  return rel.endpointPageIds ?? [rel.fromPageId, rel.toPageId];
}

/**
 * Whether a relationship renders as the N>=3 arched star hub (true) or the N=2
 * lens (false). Derived from the normalized endpoint count so callers never
 * re-derive the topology rule (A13-M2).
 */
export function isStarHub(rel: Relationship): boolean {
  return relationshipEndpoints(rel).length >= 3;
}
