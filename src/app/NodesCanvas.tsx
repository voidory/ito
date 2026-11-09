import { useMemo, useState } from "react";
import {
  buildScene,
  categoryPigment,
  type Scene,
  type SceneGraphInput,
} from "../network";
import type { CategoryId, PageId, RelationshipId, SourceId } from "../model";
import type { ConceptGraph, Workbench } from "./workbench";
import "./network.css";

/**
 * NodesCanvas (FEAT-004, spec §3) — the 2D concept-network SVG scene.
 *
 * It reads the DERIVED concept graph from the Workbench (`wb.conceptGraph()`,
 * FEAT-003), runs the REAL force-directed layout (src/network/layout.ts, via
 * buildScene) to obtain node positions, and renders:
 *   - circular dot nodes with minimal hover labels (§3.1.1),
 *   - relationship hubs ("The Bump") via hubPath() — lens for N=2, concave
 *     arched star for N>=3, translucent + centered; clicking opens the
 *     relationship's label (connecting-page) surface,
 *   - category squircles via squirclePath()/squircleBounds() with a dotted-
 *     dashed border and a watercolor multiply fill (#watercolor-turbulent-edge),
 *   - category-to-category boundary connections (A14-M2), data-driven.
 *
 * Determinism (A09-M2): positions come from the seeded layout engine over the
 * LIVE Workbench records, so idle positions are stable between renders — there
 * is no forced camera motion. Suppress-motion / prefers-reduced-motion disable
 * the only transition (the hover label fade), matching the Reader.
 *
 * Geometry is NOT reimplemented here: it is all delegated to the proven pure
 * src/network modules.
 */
/**
 * A transient N06 placeholder descriptor (never a durable record). Passed in by
 * the shell when the user opens the Nodes view for an unconnected PDF.
 */
export interface NodePlaceholderProps {
  readonly sourceId: string;
  readonly title: string;
  readonly transient: boolean;
}

export function NodesCanvas({
  wb,
  categoryScope = null,
  placeholder = null,
  placeholders,
  suppressMotion,
  bump,
}: {
  wb: Workbench;
  /**
   * The active category scope (§3.3). null = the global network; a category
   * name = only that category's squircle + its local/overlapping network.
   */
  categoryScope?: string | null;
  /**
   * A single transient "not connected yet" placeholder (N06), or null. Retained
   * for backwards compatibility; prefer `placeholders` for the open-together
   * case where every unconnected open source gets its own placeholder.
   */
  placeholder?: NodePlaceholderProps | null;
  /**
   * Transient "not connected yet" placeholders (N06) — one per currently open
   * UNCONNECTED source. When provided this takes precedence over the single
   * `placeholder` prop. Each placeholder creates ZERO durable records.
   */
  placeholders?: readonly NodePlaceholderProps[];
  suppressMotion: boolean;
  bump: () => void;
}): JSX.Element {
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);

  // N06: render one transient placeholder per open UNCONNECTED source. The
  // `placeholders` array (open-together) takes precedence; the single
  // `placeholder` prop is kept for backwards compatibility.
  const effectivePlaceholders: readonly NodePlaceholderProps[] =
    placeholders ?? (placeholder ? [placeholder] : []);

  // Read the live derived graph and map it to a rendered scene. Keyed on a
  // structural signature so the deterministic layout only re-runs when the
  // underlying records actually change (idle = stable positions, A09-M2).
  const graph = wb.conceptGraph();
  // Apply the §3.3 category filter off the LIVE graph: with a scope selected we
  // keep only that category's members plus nodes in overlapping categories
  // (categories sharing at least one member page with the scoped one).
  const filtered = filterGraphToScope(graph, categoryScope);
  const graphInput: SceneGraphInput = {
    nodes: filtered.nodes.map((n) => ({
      pageId: n.pageId,
      title: n.title,
      hidden: n.hidden,
      position: n.position,
    })),
    links: filtered.links.map((l) => ({
      relationshipId: l.relationshipId,
      endpointPageIds: l.endpointPageIds,
      label: l.label,
      blendColor: l.blendColor,
      hidden: l.hidden,
    })),
    categories: filtered.categories.map((c) => ({
      categoryId: c.categoryId,
      name: c.name,
      colorCode: c.colorCode,
      memberPageIds: c.memberPageIds,
      ...(c.masterPageId != null ? { masterPageId: c.masterPageId } : {}),
    })),
  };
  const signature = JSON.stringify(graphInput);

  const scene: Scene = useMemo(
    () => buildScene(graphInput, {}),
    // graphInput is rebuilt each render; the signature captures its content so
    // the expensive layout only recomputes on real data changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature],
  );

  // View box padded around the scene extents so everything is visible without
  // any camera animation. Computed from the resolved positions, not constants.
  const viewBox = useMemo(() => computeViewBox(scene), [scene]);

  const onHubClick = (relationshipId: string): void => {
    const current =
      graph.links.find((l) => l.relationshipId === relationshipId)?.label ?? "";
    const next = window.prompt("Connecting page label", current);
    if (next === null) return;
    void wb.setRelationshipLabel(relationshipId as RelationshipId, next).then(bump);
  };

  const onNodeClick = (pageId: string): void => {
    // Reuse the SubjectEditor open flow: a node IS a page, so clicking opens it
    // for composition (the connecting-page editor path for subject nodes).
    wb.openSubjectPage(pageId as PageId);
    bump();
  };

  return (
    <svg
      data-testid="nodes-canvas"
      className="nodes-canvas"
      viewBox={viewBox}
      preserveAspectRatio="xMidYMid meet"
      data-suppress-motion={suppressMotion ? "true" : "false"}
      role="img"
      aria-label="Concept network"
    >
      <defs>
        {/*
          Hand-painted watercolor edge: low-frequency turbulence displaces the
          squircle boundary so the fill looks bled rather than vector-crisp.
          Defined ONCE and referenced by every .category-squircle-fill (§3.2).
        */}
        <filter
          id="watercolor-turbulent-edge"
          x="-20%"
          y="-20%"
          width="140%"
          height="140%"
          filterUnits="objectBoundingBox"
        >
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.012 0.016"
            numOctaves={2}
            seed={7}
            result="noise"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="noise"
            scale={14}
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </defs>

      {effectivePlaceholders.length > 0 ? (
        <g data-testid="node-placeholder-layer">
          {effectivePlaceholders.map((ph, i) => {
            // Offset each placeholder along a column so multiple open-together
            // unconnected sources (N06) do not overlap. Purely presentational.
            const offsetY = i * PLACEHOLDER_SPACING;
            return (
              <g
                key={ph.sourceId}
                data-testid="node-placeholder"
                data-transient={ph.transient ? "true" : "false"}
                data-source-id={ph.sourceId}
                className="node-placeholder"
                transform={`translate(0 ${offsetY})`}
              >
                <circle className="node-placeholder-dot" r={9} cx={0} cy={0} />
                <text
                  className="node-placeholder-label"
                  x={0}
                  y={28}
                  textAnchor="middle"
                >
                  Not connected yet
                </text>
                <text
                  className="node-placeholder-title"
                  data-testid="node-placeholder-title"
                  x={0}
                  y={48}
                  textAnchor="middle"
                >
                  {ph.title}
                </text>
                {/*
                  Return-to-Reader (N06): switch back to the Files/Reader view
                  focused on THIS source. This is EPHEMERAL navigation only — it
                  calls setViewMode + openSource, creating ZERO durable
                  Page/Relationship/Category records.
                */}
                <text
                  className="placeholder-return-reader"
                  data-testid="placeholder-return-reader"
                  data-source-id={ph.sourceId}
                  x={0}
                  y={68}
                  textAnchor="middle"
                  role="button"
                  onClick={() => {
                    wb.setViewMode("files");
                    wb.openSource(ph.sourceId as SourceId);
                    bump();
                  }}
                >
                  Return to Reader
                </text>
              </g>
            );
          })}
        </g>
      ) : scene.nodes.length === 0 && scene.squircles.length === 0 ? (
        <text className="nodes-empty" x={0} y={0} textAnchor="middle">
          No concept nodes yet
        </text>
      ) : null}

      {/* Category squircles (drawn first so nodes/hubs sit on top). */}
      <g data-testid="category-layer">
        {scene.squircles.map((sq) => {
          const pigment = categoryPigment(sq.categoryId, sq.colorCode);
          return (
            <g
              key={sq.categoryId}
              data-testid="category-squircle"
              data-category-id={sq.categoryId}
            >
              <path className="category-squircle-fill" d={sq.d} fill={pigment} />
              <path
                className="category-squircle-border"
                d={sq.d}
                stroke={pigment}
              />
              <text
                className="category-squircle-label"
                x={sq.bounds.cx}
                y={sq.bounds.cy - sq.bounds.ry - 8}
                textAnchor="middle"
              >
                {sq.name}
              </text>
            </g>
          );
        })}
      </g>

      {/* Category-to-category boundary connections (A14-M2). */}
      <g data-testid="category-link-layer">
        {scene.categoryLinks.map((cl) => (
          <line
            key={`${cl.fromCategoryId}|${cl.toCategoryId}`}
            className="category-link"
            data-testid="category-link"
            data-from-category-id={cl.fromCategoryId}
            data-to-category-id={cl.toCategoryId}
            data-link-kind={cl.linkKind}
            x1={cl.from.x}
            y1={cl.from.y}
            x2={cl.to.x}
            y2={cl.to.y}
          />
        ))}
      </g>

      {/* Relationship hubs ("The Bump"). */}
      <g data-testid="hub-layer">
        {scene.hubs.map((hub) => (
          <path
            key={hub.relationshipId}
            className="graph-hub"
            data-testid="graph-hub"
            data-relationship-id={hub.relationshipId}
            data-hub-kind={hub.kind}
            data-endpoint-count={hub.endpointCount}
            data-hub-cx={round(hub.center.x)}
            data-hub-cy={round(hub.center.y)}
            d={hub.d}
            fill={hub.blendColor}
            onClick={() => onHubClick(hub.relationshipId)}
          />
        ))}
      </g>

      {/* Circular dot nodes with minimal hover labels. */}
      <g data-testid="node-layer">
        {scene.nodes.map((node) => (
          <g
            key={node.pageId}
            className="graph-node"
            data-testid="graph-node"
            data-page-id={node.pageId}
            data-x={round(node.x)}
            data-y={round(node.y)}
            transform={`translate(${node.x} ${node.y})`}
            onClick={() => onNodeClick(node.pageId)}
            onMouseEnter={() => setHoveredNode(node.pageId)}
            onMouseLeave={() =>
              setHoveredNode((cur) => (cur === node.pageId ? null : cur))
            }
          >
            <circle r={7} />
            <text
              className="graph-node-label"
              x={11}
              y={4}
              style={hoveredNode === node.pageId ? { opacity: 1 } : undefined}
            >
              {node.title}
            </text>
          </g>
        ))}
      </g>
    </svg>
  );
}

/** Vertical spacing between stacked N06 placeholders (presentation only). */
const PLACEHOLDER_SPACING = 96;

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Filter a derived concept graph to the §3.3 category scope. With no scope the
 * graph is returned unchanged (the GLOBAL network). With a scope (a category
 * name) we keep ONLY:
 *   - the scoped category and every category that OVERLAPS it (shares at least
 *     one member page), and
 *   - the nodes that belong to any of those kept categories, and
 *   - the links whose endpoints all fall inside that kept node set.
 * This is pure and operates entirely off the live graph — no record is touched.
 */
export function filterGraphToScope(
  graph: ConceptGraph,
  categoryScope: string | null,
): ConceptGraph {
  if (categoryScope == null) return graph;
  const scoped = graph.categories.find((c) => c.name === categoryScope);
  // Scope names an unknown/empty category: show nothing rather than everything.
  if (!scoped) {
    return { nodes: [], links: [], categories: [] };
  }
  const scopedMembers = new Set<PageId>(scoped.memberPageIds);
  // Categories that overlap the scoped one (including the scoped category).
  const keptCategoryIds = new Set<CategoryId>([scoped.categoryId]);
  for (const c of graph.categories) {
    if (c.categoryId === scoped.categoryId) continue;
    if (c.memberPageIds.some((p) => scopedMembers.has(p))) {
      keptCategoryIds.add(c.categoryId);
    }
  }
  const keptCategories = graph.categories.filter((c) => keptCategoryIds.has(c.categoryId));
  const keptPageIds = new Set<PageId>();
  for (const c of keptCategories) {
    for (const p of c.memberPageIds) keptPageIds.add(p);
  }
  const nodes = graph.nodes.filter((n) => keptPageIds.has(n.pageId));
  const links = graph.links.filter((l) =>
    l.endpointPageIds.every((p) => keptPageIds.has(p)),
  );
  return { nodes, links, categories: keptCategories };
}

/**
 * Compute a padded SVG viewBox from the resolved scene extents (positions +
 * squircle bounds). This is a STATIC framing derived from the data — it never
 * animates, preserving the no-forced-camera-motion guarantee (A09-M2).
 */
function computeViewBox(scene: Scene): string {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (x: number, y: number): void => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const n of scene.nodes) include(n.x, n.y);
  for (const sq of scene.squircles) {
    include(sq.bounds.cx - sq.bounds.rx, sq.bounds.cy - sq.bounds.ry);
    include(sq.bounds.cx + sq.bounds.rx, sq.bounds.cy + sq.bounds.ry);
  }
  if (!Number.isFinite(minX)) {
    // Empty scene: a modest default frame centered on the origin.
    return "-200 -200 400 400";
  }
  const pad = 80;
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;
  const w = Math.max(maxX - minX, 1);
  const h = Math.max(maxY - minY, 1);
  return `${round(minX)} ${round(minY)} ${round(w)} ${round(h)}`;
}
