/**
 * Pure, DOM-free 4-tier canvas hit-testing for the Nodes view (M13, §2.2).
 *
 * Clicking any spatial entity on the Nodes canvas opens its exact comparison
 * workspace. The handoff defines a STRICT distance-priority order, nearest
 * entity first within a radius, so one click unambiguously resolves to one of
 * four targets:
 *
 *   P1 Observation Node          — within the pick radius of a node `{x, y}`.
 *   P2 Node-to-Node Hub / line   — within the pick radius of a hub `center` or
 *                                  a connector line segment between endpoints.
 *   P3 Overlapping Subject zone  — farther than the pick radius from any
 *                                  node/hub AND inside >= 2 Subject basins.
 *   P4 Single Subject basin      — farther than the pick radius from any
 *                                  node/hub AND inside exactly 1 Subject basin.
 *
 * PURE: a function of input geometry only — no DOM, no React, no src/model, no
 * src/app. The caller (NodesCanvas) converts a ~24px client pick radius into
 * scene units via the live viewBox and passes it in, so this module stays
 * headlessly unit-testable. Node dots render at r=7 but the pick radius is the
 * generous click target (≈24px), so the radius is supplied, never hardcoded.
 *
 * It depends only on the sibling pure geometry (scene types + basin containment)
 * and a MINIMAL basin view (centre + semi-axes) so it never reaches into the
 * Workbench records.
 */

import type { Scene } from "./scene";
import { pointInSubjectBasin, type Basin } from "./basin";
import type { Point } from "./hub";

/** The default client-pixel pick radius (the handoff's <=24px click target). */
export const DEFAULT_PICK_RADIUS = 24;

/** A Subject basin paired with the category id it belongs to. */
export interface HitTestBasin {
  readonly categoryId: string;
  readonly basin: Basin;
}

/** P1 — an Observation Node was clicked; carries the node's page id. */
export interface NodeHit {
  readonly kind: "node";
  readonly pageId: string;
  /** Scene-unit distance from the click to the node centre. */
  readonly distance: number;
}

/** P2 — a Node-to-Node intersection/hub (or its connector line) was clicked. */
export interface HubHit {
  readonly kind: "hub";
  readonly relationshipId: string;
  /** Scene-unit distance from the click to the nearest hub centre / line. */
  readonly distance: number;
}

/** P3 — an overlapping Subject zone (>=2 basins) was clicked. */
export interface OverlapHit {
  readonly kind: "overlap";
  /** The containing Subject (category) ids, sorted for a deterministic key. */
  readonly subjectIds: readonly string[];
}

/** P4 — a single Subject basin was clicked. */
export interface BasinHit {
  readonly kind: "basin";
  readonly subjectId: string;
}

/** Nothing under the pointer (bare paper desk outside every basin). */
export interface MissHit {
  readonly kind: "none";
}

/** The discriminated hit-test result for the four priorities (or a miss). */
export type HitTestResult = NodeHit | HubHit | OverlapHit | BasinHit | MissHit;

/** Options for {@link hitTestCanvas}. */
export interface HitTestOptions {
  /**
   * The pick radius in SCENE UNITS (the caller converts ~24px client pixels via
   * the live viewBox). Defaults to {@link DEFAULT_PICK_RADIUS} so a 1:1 scene is
   * still usable headlessly. P1/P2 require the click within this radius; P3/P4
   * require it STRICTLY beyond this radius from every node/hub.
   */
  readonly pickRadius?: number;
  /**
   * The Subject basins to test for P3/P4 containment, each tagged with its
   * category id. Supplied explicitly (not read off `scene.squircles`) so the
   * caller controls which category a basin belongs to — the scene squircle
   * carries no category->basin geometry link beyond its bounds.
   */
  readonly basins?: readonly HitTestBasin[];
}

/** Euclidean distance between two points. */
function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Shortest distance from point `p` to the finite line SEGMENT `a`–`b`. Used so
 * a click anywhere ALONG a hub's connector line (not just at its centre) counts
 * as hitting that Node-to-Node intersection (P2). Pure geometry.
 */
function distanceToSegment(p: Point, a: Point, b: Point): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq === 0) return dist(p, a);
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return dist(p, { x: a.x + abx * t, y: a.y + aby * t });
}

/**
 * Resolve a click on the Nodes canvas to exactly ONE of the four priorities
 * (§2.2), nearest-entity-first within the pick radius.
 *
 * Priority order is strict:
 *   1. The NEAREST node within `pickRadius` wins (P1) — even if a hub/line is
 *      also within range, the node is closer-intent.
 *   2. Else the NEAREST hub centre OR connector line within `pickRadius` (P2).
 *   3. Else, being >`pickRadius` from every node/hub, the set of basins that
 *      geometrically contain the point: >=2 -> overlap (P3), ==1 -> basin (P4).
 *   4. Else a miss (bare paper).
 *
 * Determinism: ties are broken by the scene's existing node/hub order and, for
 * P3, by sorting the containing subject ids, so identical inputs always yield
 * an identical result.
 */
export function hitTestCanvas(
  scene: Scene,
  point: Point,
  options: HitTestOptions = {},
): HitTestResult {
  const pickRadius = options.pickRadius ?? DEFAULT_PICK_RADIUS;
  const basins = options.basins ?? [];

  // -- P1: nearest Observation Node within the pick radius. -----------------
  let bestNode: NodeHit | null = null;
  for (const node of scene.nodes) {
    const d = dist(point, { x: node.x, y: node.y });
    if (d <= pickRadius && (bestNode === null || d < bestNode.distance)) {
      bestNode = { kind: "node", pageId: node.pageId, distance: d };
    }
  }
  if (bestNode) return bestNode;

  // -- P2: nearest hub centre OR connector line within the pick radius. -----
  let bestHub: HubHit | null = null;
  for (const hub of scene.hubs) {
    // Distance to the hub glyph centre.
    let d = dist(point, hub.center);
    // Distance to each connector line segment between consecutive endpoints,
    // so a click along the drawn line (not only the centre) hits the hub.
    const eps = hub.endpoints;
    for (let i = 0; i + 1 < eps.length; i++) {
      d = Math.min(d, distanceToSegment(point, eps[i]!, eps[i + 1]!));
    }
    // A 2-endpoint lens: also test the single A–B segment (covered above).
    if (d <= pickRadius && (bestHub === null || d < bestHub.distance)) {
      bestHub = { kind: "hub", relationshipId: hub.relationshipId, distance: d };
    }
  }
  if (bestHub) return bestHub;

  // -- P3/P4: more than pickRadius from every node/hub — test basins. -------
  const containing: string[] = [];
  for (const { categoryId, basin } of basins) {
    if (pointInSubjectBasin(point, basin)) containing.push(categoryId);
  }
  if (containing.length >= 2) {
    return { kind: "overlap", subjectIds: [...containing].sort() };
  }
  if (containing.length === 1) {
    return { kind: "basin", subjectId: containing[0]! };
  }

  // -- Miss: bare paper desk outside every basin. ---------------------------
  return { kind: "none" };
}
