/**
 * Pure graph -> rendered-scene mapping for the 2D concept network (FEAT-004).
 *
 * PURE: no DOM, no React, no Three.js. This is the non-trivial glue between the
 * live Workbench `ConceptGraph` shape and the SVG props the NodesCanvas renders.
 * Keeping it here (not in the .tsx) means the correctness of the mapping — node
 * positions from the real layout engine, hub kind + path, squircle bounds per
 * category, blend color, category-link endpoints — is provable headlessly in
 * Vitest (the sandbox cannot run Playwright Chromium).
 *
 * It depends only on the sibling pure geometry modules (layout/hub/squircle/
 * blend) and a MINIMAL structural view of the graph (declared below) so it does
 * not import src/model or src/app.
 */

import {
  runLayout,
  type LayoutGraph,
  type LayoutLink,
  type LayoutNode,
  type Positions,
  type Vec2,
} from "./layout";
import { hubPath, type HubPath, type Point } from "./hub";
import {
  squircleBounds,
  squirclePath,
  type SquircleBounds,
  type SquirclePoint,
} from "./squircle";
import { resolveBasin, type Basin } from "./basin";

/** Minimal structural node (a subset of the Workbench ConceptNode). */
export interface SceneNodeInput {
  readonly pageId: string;
  readonly title: string;
  readonly hidden: boolean;
  /** A durable laid-out/dragged position, or null to let the engine place it. */
  readonly position: { readonly x: number; readonly y: number } | null;
}

/** Minimal structural link (a subset of the Workbench ConceptLink). */
export interface SceneLinkInput {
  readonly relationshipId: string;
  readonly endpointPageIds: readonly string[];
  readonly label: string;
  readonly blendColor: string;
  readonly hidden: boolean;
}

/** Minimal structural category (a subset of the Workbench ConceptCategory). */
export interface SceneCategoryInput {
  readonly categoryId: string;
  readonly name: string;
  readonly colorCode: string;
  readonly memberPageIds: readonly string[];
  /**
   * The category's master page id (A14-M2), if one has been created. A direct
   * master-page -> master-page relationship between two categories produces an
   * explicit 'master' category-boundary link (§12.2), distinct from the
   * implicit member-bridging 'member' link.
   */
  readonly masterPageId?: string;
  /**
   * M13 (§2.1(2)) the Subject's explicit watercolour BASIN geometry, if set.
   * When present the category's squircle/basin renders from THIS geometry even
   * when it has zero member nodes. When absent the scene mapper derives a
   * deterministic default basin from the category's index so an empty Subject
   * still renders a visible wash. Non-empty categories keep their member-hull
   * squircle unless an explicit basin is supplied, so existing layouts/offsets
   * are never perturbed (additive).
   */
  readonly basin?: Basin;
}

/** The minimal graph the scene mapper consumes (matches ConceptGraph shape). */
export interface SceneGraphInput {
  readonly nodes: readonly SceneNodeInput[];
  readonly links: readonly SceneLinkInput[];
  readonly categories: readonly SceneCategoryInput[];
}

/**
 * A per-node 2D offset applied on top of the engine layout (user drag, D19).
 */
export interface SceneOffset {
  readonly x: number;
  readonly y: number;
}

/** Options for buildScene — deterministic layout + squircle padding. */
export interface BuildSceneOptions {
  /** Layout iterations (determinism: same inputs => same output). */
  readonly iterations?: number;
  /** Seed for the layout PRNG (A09-M2 determinism). */
  readonly seed?: number;
  /** Uniform padding added around a category's member points. */
  readonly squirclePadding?: number;
  /** Radius of the initial ring the nodes are seeded on before the sim runs. */
  readonly seedRadius?: number;
  /**
   * Per-node drag OFFSETS keyed by page id (§3.3, D19). Applied on TOP of the
   * deterministic force-layout coordinates BEFORE hubs + squircle bounds are
   * computed, so squircles and star-hubs stretch/follow a dragged node. A page
   * with no entry keeps its pure layout position, so a graph with NO offsets is
   * byte-identical to the un-offset layout (A09-M2 determinism preserved).
   */
  readonly dragOffsets?: Readonly<Record<string, SceneOffset>>;
  /**
   * Absolute per-node POSITION overrides keyed by page id (§3.3, D19). When
   * present for a page this REPLACES the engine position outright (an explicit
   * placement), taking precedence over `dragOffsets` for that page. Omitted
   * pages keep their layout position, preserving determinism for un-placed
   * graphs.
   */
  readonly nodePositions?: Readonly<Record<string, SceneOffset>>;
}

/** A rendered node: id, title and its resolved 2D position. */
export interface SceneNode {
  readonly pageId: string;
  readonly title: string;
  readonly x: number;
  readonly y: number;
}

/** A rendered hub glyph for a relationship. */
export interface SceneHub {
  readonly relationshipId: string;
  readonly label: string;
  readonly d: string;
  readonly kind: "lens" | "star";
  readonly endpointCount: number;
  readonly center: Point;
  /** Endpoint positions (so vertices can be asserted to point toward nodes). */
  readonly endpoints: readonly Point[];
  readonly blendColor: string;
}

/** A rendered category squircle. */
export interface SceneSquircle {
  readonly categoryId: string;
  readonly name: string;
  readonly colorCode: string;
  readonly d: string;
  readonly bounds: SquircleBounds;
  /**
   * M13 (§2.1(2)) true when this squircle was rendered from a Subject BASIN
   * (an explicit `Category.basin` or the deterministic default for an EMPTY
   * Subject) rather than from a hull around member node positions. Lets the
   * canvas / tests tell a basin-driven wash from a member-hull wash. A non-empty
   * Subject with no explicit basin keeps `basin: false` (member-hull), so
   * existing scenes are byte-compatible.
   */
  readonly basin: boolean;
}

/** A rendered category-to-category boundary connection (A14-M2). */
export interface SceneCategoryLink {
  readonly fromCategoryId: string;
  readonly toCategoryId: string;
  /**
   * How the link was derived (§12.2, A14-M2):
   *   - 'master': an explicit relationship connects the two categories' MASTER
   *     pages (the required "category master page connects to another category
   *     boundary" capability), or
   *   - 'member': an implicit member-bridging relationship joins a member page
   *     of one category to a member page of the other (secondary signal).
   * When BOTH exist for the same unordered category pair, 'master' wins and
   * exactly one link is emitted.
   */
  readonly linkKind: "master" | "member";
  /** The point on the FROM squircle boundary (nearest the other center). */
  readonly from: Point;
  /** The point on the TO squircle boundary (nearest the other center). */
  readonly to: Point;
}

/** The fully resolved 2D scene ready to render. */
export interface Scene {
  readonly nodes: readonly SceneNode[];
  readonly hubs: readonly SceneHub[];
  readonly squircles: readonly SceneSquircle[];
  readonly categoryLinks: readonly SceneCategoryLink[];
  /** Node positions keyed by page id (for geometry probes / containment). */
  readonly positions: Positions;
}

const DEFAULT_ITERATIONS = 300;
const DEFAULT_SEED = 0x1a2b3c4d;
const DEFAULT_SQUIRCLE_PADDING = 48;
const DEFAULT_SEED_RADIUS = 240;

/**
 * Deterministic initial placement for a node that has no durable position:
 * seed it on a ring by its index so the force sim starts from a stable,
 * reproducible configuration (A09-M2) rather than Math.random.
 */
function ringSeed(index: number, total: number, radius: number): Vec2 {
  if (total <= 0) return { x: 0, y: 0 };
  const theta = (index / total) * Math.PI * 2;
  return { x: Math.cos(theta) * radius, y: Math.sin(theta) * radius };
}

/**
 * Map the live graph to layout-engine input. Hidden nodes are EXCLUDED from the
 * simulation (presentation-only). Durable positions are honored; nodes without
 * one are ring-seeded deterministically. Category membership is passed through
 * so the engine's category attraction pulls multi-category nodes into overlaps
 * (A10-M2).
 */
export function toLayoutGraph(
  graph: SceneGraphInput,
  seedRadius: number = DEFAULT_SEED_RADIUS,
): LayoutGraph {
  const visible = graph.nodes.filter((n) => !n.hidden);
  const visibleIds = new Set(visible.map((n) => n.pageId));

  const categoryIdsByPage = new Map<string, string[]>();
  for (const cat of graph.categories) {
    for (const pid of cat.memberPageIds) {
      if (!visibleIds.has(pid)) continue;
      const list = categoryIdsByPage.get(pid) ?? [];
      list.push(cat.categoryId);
      categoryIdsByPage.set(pid, list);
    }
  }

  const nodes: LayoutNode[] = visible.map((n, i) => {
    const seeded = n.position ?? ringSeed(i, visible.length, seedRadius);
    return {
      id: n.pageId,
      x: seeded.x,
      y: seeded.y,
      categoryIds: categoryIdsByPage.get(n.pageId) ?? [],
    };
  });

  // A link expands to a spring between every consecutive endpoint pair so the
  // N-endpoint hub still exerts cohesion. Hidden links are excluded.
  const links: LayoutLink[] = [];
  for (const link of graph.links) {
    if (link.hidden) continue;
    const pts = link.endpointPageIds.filter((id) => visibleIds.has(id));
    for (let i = 0; i + 1 < pts.length; i++) {
      links.push({ sourceId: pts[i]!, targetId: pts[i + 1]! });
    }
  }

  return { nodes, links };
}

/** Centroid of a set of points (origin for an empty set). */
function centroid(points: readonly Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / points.length, y: sy / points.length };
}

/**
 * The point on a squircle boundary nearest to a target direction, found by
 * marching a ray from the center toward `target` and sampling the boundary at
 * that angle. Pure geometry; used to anchor category-to-category links on the
 * two squircles' boundaries (A14-M2).
 */
function boundaryPointToward(bounds: SquircleBounds, target: Point): Point {
  const angle = Math.atan2(target.y - bounds.cy, target.x - bounds.cx);
  // Superellipse parametric point (exponent default 4) at this angle.
  const ct = Math.cos(angle);
  const st = Math.sin(angle);
  const sp = (t: number): number =>
    Math.sign(t) * Math.pow(Math.abs(t), 2 / 4);
  return { x: bounds.cx + bounds.rx * sp(ct), y: bounds.cy + bounds.ry * sp(st) };
}

/**
 * Build a boundary-anchored SceneCategoryLink for an unordered category pair.
 * The two categories are ordered deterministically (a < b) and each endpoint is
 * anchored on the owning squircle's boundary nearest the other center.
 */
function categoryLinkFor(
  a: string,
  b: string,
  linkKind: "master" | "member",
  boundsByCategory: ReadonlyMap<string, SquircleBounds>,
): SceneCategoryLink {
  const [fromId, toId] = a < b ? [a, b] : [b, a];
  const fromB = boundsByCategory.get(fromId)!;
  const toB = boundsByCategory.get(toId)!;
  return {
    fromCategoryId: fromId,
    toCategoryId: toId,
    linkKind,
    from: boundaryPointToward(fromB, { x: toB.cx, y: toB.cy }),
    to: boundaryPointToward(toB, { x: fromB.cx, y: fromB.cy }),
  };
}

/**
 * Derive category-to-category boundary connections from the DATA (A14-M2). Two
 * kinds of link are produced, with MASTER winning the per-pair dedupe (§12.2):
 *
 *   1. MASTER links (derived FIRST): an explicit relationship directly connects
 *      one category's MASTER page to another category's MASTER page. This is the
 *      required "category master page connects to another category boundary"
 *      capability — a first-class signal, not merely a filter.
 *   2. MEMBER links (derived SECOND): the pre-existing member-bridging signal —
 *      a relationship joins a member page of one category to a member page of
 *      the other. A member link is SKIPPED when a master link already covers
 *      the same unordered category pair (master wins the dedupe).
 *
 * Fully data-driven (no hardcoded pairs) and consistent with ADR-0008's
 * reference-by-id model. Deterministic: ordered category-pair keys keep the
 * first-seen link. When no master pages exist the output is exactly the legacy
 * member-bridging set (all 'member'), preserving prior behaviour.
 */
export function deriveCategoryLinks(
  graph: SceneGraphInput,
  boundsByCategory: ReadonlyMap<string, SquircleBounds>,
): SceneCategoryLink[] {
  // Which categories each page belongs to (member bridging).
  const catsByPage = new Map<string, string[]>();
  // Which category a page is the MASTER of (master bridging). A page can be the
  // master of at most one category by construction.
  const masterCatByPage = new Map<string, string>();
  for (const cat of graph.categories) {
    for (const pid of cat.memberPageIds) {
      const list = catsByPage.get(pid) ?? [];
      list.push(cat.categoryId);
      catsByPage.set(pid, list);
    }
    if (cat.masterPageId != null) masterCatByPage.set(cat.masterPageId, cat.categoryId);
  }

  const seen = new Set<string>();
  const out: SceneCategoryLink[] = [];

  const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

  // 1) MASTER links first.
  for (const link of graph.links) {
    if (link.hidden) continue;
    const eps = link.endpointPageIds;
    for (let i = 0; i < eps.length; i++) {
      for (let j = i + 1; j < eps.length; j++) {
        const a = masterCatByPage.get(eps[i]!);
        const b = masterCatByPage.get(eps[j]!);
        if (a == null || b == null || a === b) continue;
        const key = pairKey(a, b);
        if (seen.has(key)) continue;
        if (!boundsByCategory.get(a) || !boundsByCategory.get(b)) continue;
        seen.add(key);
        out.push(categoryLinkFor(a, b, "master", boundsByCategory));
      }
    }
  }

  // 2) MEMBER links second (skipping pairs already covered by a master link).
  for (const link of graph.links) {
    if (link.hidden) continue;
    const eps = link.endpointPageIds;
    for (let i = 0; i < eps.length; i++) {
      for (let j = i + 1; j < eps.length; j++) {
        const aCats = catsByPage.get(eps[i]!) ?? [];
        const bCats = catsByPage.get(eps[j]!) ?? [];
        for (const a of aCats) {
          for (const b of bCats) {
            if (a === b) continue;
            const key = pairKey(a, b);
            if (seen.has(key)) continue;
            if (!boundsByCategory.get(a) || !boundsByCategory.get(b)) continue;
            seen.add(key);
            out.push(categoryLinkFor(a, b, "member", boundsByCategory));
          }
        }
      }
    }
  }

  return out;
}

/**
 * Build the full rendered scene from a live graph. Node positions come from the
 * REAL force-directed layout engine (never placeholder constants); hubs,
 * squircles and category-links are derived from those positions. Deterministic:
 * identical (graph, options) yield identical output.
 */
export function buildScene(graph: SceneGraphInput, options: BuildSceneOptions = {}): Scene {
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const seed = options.seed ?? DEFAULT_SEED;
  const padding = options.squirclePadding ?? DEFAULT_SQUIRCLE_PADDING;
  const seedRadius = options.seedRadius ?? DEFAULT_SEED_RADIUS;

  const layoutGraph = toLayoutGraph(graph, seedRadius);
  const enginePositions = runLayout(layoutGraph, { iterations, seed });

  // Apply per-node drag offsets / absolute position overrides on TOP of the
  // engine layout (§3.3, D19). An absolute override wins outright; otherwise a
  // drag offset is added to the engine position. Pages with neither keep their
  // pure layout coordinate, so a graph with NO offsets yields output identical
  // to the un-offset layout (A09-M2 determinism). Hubs + squircle bounds are
  // computed from these ADJUSTED positions below, so they follow a dragged node.
  const dragOffsets = options.dragOffsets ?? {};
  const nodePositions = options.nodePositions ?? {};
  const mutablePositions: Record<string, Vec2> = {};
  for (const [pageId, p] of Object.entries(enginePositions)) {
    const override = nodePositions[pageId];
    if (override) {
      mutablePositions[pageId] = { x: override.x, y: override.y };
      continue;
    }
    const off = dragOffsets[pageId];
    mutablePositions[pageId] = off
      ? { x: p.x + off.x, y: p.y + off.y }
      : { x: p.x, y: p.y };
  }
  const positions: Positions = mutablePositions;

  const posOf = (pageId: string): Point | null => {
    const p = positions[pageId];
    return p ? { x: p.x, y: p.y } : null;
  };

  const nodes: SceneNode[] = [];
  for (const n of graph.nodes) {
    if (n.hidden) continue;
    const p = posOf(n.pageId);
    if (!p) continue;
    nodes.push({ pageId: n.pageId, title: n.title, x: p.x, y: p.y });
  }

  // Hubs: one per visible relationship whose endpoints are all placed.
  const hubs: SceneHub[] = [];
  for (const link of graph.links) {
    if (link.hidden) continue;
    const endpoints: Point[] = [];
    let complete = true;
    for (const id of link.endpointPageIds) {
      const p = posOf(id);
      if (!p) {
        complete = false;
        break;
      }
      endpoints.push(p);
    }
    if (!complete || endpoints.length < 2) continue;
    const center = centroid(endpoints);
    const path: HubPath = hubPath({ center, endpoints });
    hubs.push({
      relationshipId: link.relationshipId,
      label: link.label,
      d: path.d,
      kind: path.kind,
      endpointCount: endpoints.length,
      center,
      endpoints,
      blendColor: link.blendColor,
    });
  }

  // Squircles: one per category. A category with visible member nodes keeps its
  // member-hull squircle EXACTLY as before (so existing non-empty categories
  // are never perturbed); an EMPTY category — or one carrying an explicit
  // Subject basin — renders from its BASIN geometry so even a 0-node Subject
  // shows a visible watercolour wash (M13 §2.1(2)). The default basin is
  // deterministic in the category's index, so this stays side-effect-free on
  // the seeded node layout.
  const squircles: SceneSquircle[] = [];
  const boundsByCategory = new Map<string, SquircleBounds>();
  graph.categories.forEach((cat, index) => {
    const memberPts: SquirclePoint[] = [];
    for (const pid of cat.memberPageIds) {
      const p = posOf(pid);
      if (p) memberPts.push(p);
    }
    let bounds: SquircleBounds;
    let fromBasin: boolean;
    if (memberPts.length > 0 && cat.basin == null) {
      // Unchanged legacy path: hull around member positions.
      bounds = squircleBounds(memberPts, padding);
      fromBasin = false;
    } else {
      // Empty Subject, or an explicit basin: render the Subject's basin
      // territory (explicit geometry, else the deterministic default).
      const basin: Basin = resolveBasin(cat.basin, index, graph.categories.length);
      bounds = { cx: basin.x, cy: basin.y, rx: basin.rx, ry: basin.ry };
      fromBasin = true;
    }
    boundsByCategory.set(cat.categoryId, bounds);
    squircles.push({
      categoryId: cat.categoryId,
      name: cat.name,
      colorCode: cat.colorCode,
      d: squirclePath(bounds),
      bounds,
      basin: fromBasin,
    });
  });

  const categoryLinks = deriveCategoryLinks(graph, boundsByCategory);

  return { nodes, hubs, squircles, categoryLinks, positions };
}
