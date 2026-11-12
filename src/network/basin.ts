/**
 * Pure, DOM-free Subject-basin geometry for the Nodes canvas (M13, §2.1(2/3)).
 *
 * A Subject's watercolour BASIN is an ELLIPSE (a superellipse with exponent
 * n = 2): centre `(x, y)` + semi-axes `(rx, ry)`. Membership is spatial — an
 * Observation Node belongs to every Subject whose basin geometrically contains
 * its `[x, y]` position (§2.1(3)). This module is a function of input geometry
 * only: no DOM, no React, no src/model, no src/app — so basin containment and
 * the deterministic default-basin layout are provable headlessly in Vitest.
 */

import { squircleContains, type SquirclePoint } from "./squircle";

/** A Subject basin: centre + semi-axes (same shape as `Category.basin`). */
export interface Basin {
  readonly x: number;
  readonly y: number;
  readonly rx: number;
  readonly ry: number;
}

/**
 * True iff a node position lies inside (or on) a Subject basin — ELLIPSE
 * containment (`(dx/rx)^2 + (dy/ry)^2 <= 1`). Implemented by delegating to the
 * proven superellipse containment with exponent n = 2 so there is ONE
 * containment code path for both squircles and basins. A degenerate zero
 * semi-axis only contains the exact centre.
 */
export function pointInSubjectBasin(
  nodePos: { readonly x: number; readonly y: number },
  basin: Basin,
): boolean {
  const point: SquirclePoint = { x: nodePos.x, y: nodePos.y };
  return squircleContains(
    { cx: basin.x, cy: basin.y, rx: basin.rx, ry: basin.ry },
    point,
    2,
  );
}

/**
 * Deterministic DEFAULT basin for a Subject that has no explicit `basin` yet,
 * derived purely from its INDEX in the category list and the total count so
 * even a 0-node Subject renders a visible wash on the canvas. Basins are placed
 * on a ring (seeded by index) so successive Subjects sit apart but close enough
 * that adjacent ones overlap into an A∩B lens — matching the force-layout
 * ring-seed convention used for nodes (A09-M2 determinism). The geometry is a
 * pure function of `(index, total)`, so identical inputs always yield identical
 * basins and existing seeded node layouts are never perturbed.
 */
export function defaultBasin(index: number, total: number): Basin {
  const count = Math.max(1, total);
  // A single Subject sits at the origin; multiple Subjects ring around it.
  const ringRadius = count <= 1 ? 0 : 220;
  const theta = (index / count) * Math.PI * 2;
  const x = Math.cos(theta) * ringRadius;
  const y = Math.sin(theta) * ringRadius;
  // Generous semi-axes so adjacent default basins overlap (A∩B visible) and a
  // lone Subject still fills a comfortable territory around any nodes placed in
  // it. These are deterministic constants, independent of node positions.
  return { x, y, rx: 200, ry: 160 };
}

/**
 * Resolve the EFFECTIVE basin for a Subject: its explicit `basin` when present,
 * otherwise the deterministic default derived from `(index, total)`. Callers in
 * the scene mapper and the workbench use this single accessor so the default is
 * identical everywhere.
 */
export function resolveBasin(
  basin: Basin | undefined,
  index: number,
  total: number,
): Basin {
  return basin ?? defaultBasin(index, total);
}

/**
 * The centroid of the overlap (A∩B) of two basins, approximated as the midpoint
 * of the two centres. Used when membership is set programmatically into an
 * overlap so the node is placed where both basins contain it. Pure geometry.
 */
export function overlapCentroid(a: Basin, b: Basin): { x: number; y: number } {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
