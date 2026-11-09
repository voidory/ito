import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  buildScene,
  categoryPigment,
  NATURAL_PALETTE_ORDER,
  type Scene,
  type SceneGraphInput,
  type SceneOffset,
} from "../network";
import type { CategoryId, PageId, RelationshipId, RelationshipKind, SourceId } from "../model";
import type { ConceptGraph, Workbench } from "./workbench";
import { Button, IconButton } from "./ui/primitives";
import { OverlapBleeds, SheenOverlay, WatercolorDefs, WaterBackdrop } from "./WatercolorLayer";
import "./network.css";

/** The relationship kinds a user can pick when creating a hub (§3.1). */
const RELATIONSHIP_KINDS: readonly RelationshipKind[] = [
  "relates",
  "supports",
  "contradicts",
  "derives",
];

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
  focusedPageId = null,
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
  /**
   * The explicit locate camera-focus target (N04/N05, FEAT-004). When set, the
   * matching graph-node is marked `data-focused="true"` and visually
   * emphasized. This is a STATIC visual focus derived from explicit state —
   * there is NO camera animation on idle (A09-M2). Defaults to null (no focus).
   */
  focusedPageId?: string | null;
  suppressMotion: boolean;
  bump: () => void;
}): JSX.Element {
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  // FIX-NODES-LABEL-OVERLAP (§3.2): the "Open connecting page" action pill is
  // hidden until a hub is hovered OR actively selected/editing, so the pills no
  // longer render permanently on every hub and overdraw nearby node dots and
  // category labels. `editingHub` latches while the inline label prompt for a
  // hub is open so its pill stays reachable during the edit.
  const [hoveredHub, setHoveredHub] = useState<string | null>(null);
  const [editingHub, setEditingHub] = useState<string | null>(null);

  // --- FEAT-003 (3.1) interactive creation toolbar state ------------------
  // The "+ Category" popover (name + watercolor swatch + membership toggles).
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryColor, setNewCategoryColor] = useState<string>(
    NATURAL_PALETTE_ORDER[0]!,
  );
  // "Connect Nodes" multi-select mode and the ordered set of selected pages. A
  // Set preserves insert order via an array mirror; we keep a plain array so
  // createRelationship receives endpoints in click order (first = lens anchor).
  const [connectMode, setConnectMode] = useState(false);
  const [selectedNodeIds, setSelectedNodeIds] = useState<PageId[]>([]);
  // The Create-Hub popover controls (kind + label), shown once >=2 selected.
  const [hubKind, setHubKind] = useState<RelationshipKind>("relates");
  const [hubLabel, setHubLabel] = useState("");

  // --- §3.3 interactive 2D canvas state -----------------------------------
  // Background pan offset folded into the viewBox (data-pan-x / data-pan-y).
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  // Zoom scale seeded from the Workbench (persisted presentation state). A
  // larger scale zooms IN (the viewBox shrinks around its center).
  const [zoom, setZoom] = useState<number>(() => wb.zoom());
  // The LIVE node drag in progress (committed to wb.setDragOffset on pointer-up
  // so it persists per ADR-0009). null when no node is being dragged.
  const [liveDrag, setLiveDrag] = useState<{
    pageId: string;
    dx: number;
    dy: number;
  } | null>(null);
  // Raw pointer bookkeeping for drag/pan gestures (not rendered).
  const dragRef = useRef<{
    kind: "node" | "pan";
    pageId?: string;
    startX: number;
    startY: number;
    baseDx: number;
    baseDy: number;
    basePanX: number;
    basePanY: number;
    moved: boolean;
  } | null>(null);

  const velRef = useRef<{ x: number; y: number; t: number; vx: number; vy: number } | null>(null);

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

  // Persisted per-node drag offsets (D19) merged with the LIVE in-progress drag
  // so a dragged node (and the hubs/squircles touching it) follow the pointer
  // before the offset is committed on pointer-up. Absolute nodePositions (if
  // any) are threaded through unchanged — buildScene lets an override win.
  const presentation = wb.presentationView();
  const effectiveDragOffsets = useMemo<Record<string, SceneOffset>>(() => {
    const merged: Record<string, SceneOffset> = { ...presentation.dragOffsets };
    if (liveDrag) {
      const base = merged[liveDrag.pageId] ?? { x: 0, y: 0 };
      merged[liveDrag.pageId] = { x: base.x + liveDrag.dx, y: base.y + liveDrag.dy };
    }
    return merged;
    // Recompute when the persisted offsets or the live drag change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(presentation.dragOffsets), liveDrag]);
  const offsetsSignature = JSON.stringify(effectiveDragOffsets);
  const positionsSignature = JSON.stringify(presentation.nodePositions);

  const scene: Scene = useMemo(
    () =>
      buildScene(graphInput, {
        dragOffsets: effectiveDragOffsets,
        nodePositions: presentation.nodePositions,
      }),
    // graphInput is rebuilt each render; the signatures capture its content so
    // the expensive layout only recomputes on real data / offset changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature, offsetsSignature, positionsSignature],
  );

  // Base view box padded around the scene extents so everything is visible
  // without any camera animation. Computed from the resolved positions, not
  // constants. Pan + zoom are folded on top (§3.3) into the rendered viewBox.
  const baseViewBox = useMemo(() => computeViewBox(scene), [scene]);
  const viewBox = useMemo(
    () => applyPanZoom(baseViewBox, pan, zoom),
    [baseViewBox, pan, zoom],
  );

  // --- §3.3 zoom controls --------------------------------------------------
  const commitZoom = useCallback(
    (next: number): void => {
      const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
      setZoom(clamped);
      void wb.setZoom(clamped);
    },
    [wb],
  );
  const onZoomIn = useCallback(() => commitZoom(zoom * ZOOM_STEP), [commitZoom, zoom]);
  const onZoomOut = useCallback(() => commitZoom(zoom / ZOOM_STEP), [commitZoom, zoom]);
  const onZoomReset = useCallback(() => {
    setPan({ x: 0, y: 0 });
    commitZoom(1);
  }, [commitZoom]);
  // --- Smooth camera --------------------------------------------------------
  // `pan` / `zoom` (and therefore `viewBox`) are the camera's TARGET. What is on
  // screen eases toward it: we keep the displayed view box `dv` and express the
  // difference to the target as a transform on the scene group (a FLIP), so a
  // zoom-button press, a wheel tick or a reset glides instead of jumping, and a
  // retarget mid-flight continues from wherever the picture currently is.
  // While the pointer is dragging the canvas (or momentum is carrying it) the
  // camera snaps 1:1 so the map sticks to the finger/cursor.
  const prefersReduced = usePrefersReducedMotion();
  const motion = !suppressMotion && !prefersReduced;
  const camRef = useRef<SVGGElement | null>(null);
  const dvRef = useRef<ViewBoxNums | null>(null);
  const tvRef = useRef<ViewBoxNums>(parseViewBox(viewBox));
  const snapRef = useRef(false);
  const camFrame = useRef(0);

  const applyCam = useCallback((): void => {
    const g = camRef.current;
    const d = dvRef.current;
    const t = tvRef.current;
    if (!g || !d) return;
    const k = t.w / d.w;
    const tx = t.x - d.x * k;
    const ty = t.y - d.y * k;
    if (Math.abs(k - 1) < 1e-5 && Math.abs(tx) < 1e-3 && Math.abs(ty) < 1e-3) {
      g.removeAttribute("transform");
    } else {
      g.setAttribute("transform", `translate(${tx} ${ty}) scale(${k})`);
    }
  }, []);

  const runCam = useCallback((): void => {
    if (camFrame.current) return;
    let last = performance.now();
    const tick = (now: number): void => {
      const dt = Math.min(64, now - last);
      last = now;
      const d = dvRef.current;
      const t = tvRef.current;
      if (!d) {
        camFrame.current = 0;
        return;
      }
      // Frame-rate independent exponential ease (~120ms time constant).
      const a = 1 - Math.exp(-dt / 120);
      d.x += (t.x - d.x) * a;
      d.y += (t.y - d.y) * a;
      d.w += (t.w - d.w) * a;
      d.h += (t.h - d.h) * a;
      const close =
        Math.abs(t.x - d.x) < 0.02 &&
        Math.abs(t.y - d.y) < 0.02 &&
        Math.abs(t.w - d.w) < 0.02;
      if (close) {
        dvRef.current = { ...t };
        applyCam();
        camFrame.current = 0;
        return;
      }
      applyCam();
      camFrame.current = requestAnimationFrame(tick);
    };
    camFrame.current = requestAnimationFrame(tick);
  }, [applyCam]);

  useLayoutEffect(() => {
    const t = parseViewBox(viewBox);
    tvRef.current = t;
    if (!dvRef.current || snapRef.current || !motion) {
      dvRef.current = { ...t };
      applyCam();
      return;
    }
    runCam();
  }, [viewBox, motion, applyCam, runCam]);

  useEffect(
    () => () => {
      if (camFrame.current) cancelAnimationFrame(camFrame.current);
      if (inertiaFrame.current) cancelAnimationFrame(inertiaFrame.current);
      if (wheelPersist.current) clearTimeout(wheelPersist.current);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // --- Wheel: zoom toward the cursor ---------------------------------------
  // Native non-passive listener: React's onWheel is passive, so preventDefault
  // would be ignored and the wheel would also scroll the page. The zoom is
  // continuous (proportional to the wheel delta, so trackpads feel natural) and
  // anchored on the point under the cursor; the camera easing above smooths it.
  const wheelPersist = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inertiaFrame = useRef(0);
  const latest = useRef({ zoom, pan, baseViewBox, viewBox });
  latest.current = { zoom, pan, baseViewBox, viewBox };
  const wheelRef = useRef<(e: WheelEvent) => void>(() => undefined);
  wheelRef.current = (e: WheelEvent): void => {
    const svg = svgRef.current;
    if (!svg) return;
    if (inertiaFrame.current) {
      cancelAnimationFrame(inertiaFrame.current);
      inertiaFrame.current = 0;
      snapRef.current = false;
    }
    const { zoom: z, baseViewBox: base, viewBox: vbStr } = latest.current;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const rate = e.ctrlKey ? 0.01 : 0.0018; // pinch gestures report ctrlKey
    const factor = Math.exp(-e.deltaY * unit * rate);
    const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor));
    if (nz === z) return;

    const rect = svg.getBoundingClientRect();
    // Map the cursor through what is ACTUALLY on screen (the eased, displayed
    // view), not the target - a wheel tick can land mid-glide.
    const shown = dvRef.current ?? parseViewBox(vbStr);
    const sD = Math.min(rect.width / shown.w, rect.height / shown.h);
    const oxD = (rect.width - shown.w * sD) / 2;
    const oyD = (rect.height - shown.h * sD) / 2;
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const cxs = shown.x + (sx - oxD) / sD;
    const cys = shown.y + (sy - oyD) / sD;
    // New target view at the new zoom, positioned so that scene point stays put
    // under the cursor.
    const bv = parseViewBox(base);
    const nw = bv.w / nz;
    const nh = bv.h / nz;
    const s2 = Math.min(rect.width / nw, rect.height / nh);
    const ox2 = (rect.width - nw * s2) / 2;
    const oy2 = (rect.height - nh * s2) / 2;
    const nx = cxs - (sx - ox2) / s2;
    const ny = cys - (sy - oy2) / s2;
    const bcx = bv.x + bv.w / 2;
    const bcy = bv.y + bv.h / 2;
    setPan({ x: nx - (bcx - nw / 2), y: ny - (bcy - nh / 2) });
    setZoom(nz);
    // Persist once the wheel settles, not on every tick.
    if (wheelPersist.current) clearTimeout(wheelPersist.current);
    wheelPersist.current = setTimeout(() => void wb.setZoom(nz), 250);
  };

  // --- §3.3 node drag + background pan gestures ----------------------------
  const svgRef = useRef<SVGSVGElement | null>(null);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onNativeWheel = (e: WheelEvent): void => {
      e.preventDefault();
      wheelRef.current(e);
    };
    svg.addEventListener("wheel", onNativeWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onNativeWheel);
  }, []);
  // Convert a client delta (px) into scene units using the current viewBox so
  // a drag tracks the pointer regardless of zoom / fit scaling.
  const toSceneDelta = useCallback(
    (clientDx: number, clientDy: number): { dx: number; dy: number } => {
      const svg = svgRef.current;
      const vb = parseViewBox(viewBox);
      const rect = svg?.getBoundingClientRect();
      const w = rect && rect.width > 0 ? rect.width : vb.w;
      const h = rect && rect.height > 0 ? rect.height : vb.h;
      return { dx: (clientDx / w) * vb.w, dy: (clientDy / h) * vb.h };
    },
    [viewBox],
  );

  const onNodePointerDown = useCallback(
    (e: React.PointerEvent<SVGGElement>, pageId: string): void => {
      e.stopPropagation();
      (e.currentTarget as SVGGElement).setPointerCapture?.(e.pointerId);
      const base = presentation.dragOffsets[pageId] ?? { x: 0, y: 0 };
      dragRef.current = {
        kind: "node",
        pageId,
        startX: e.clientX,
        startY: e.clientY,
        baseDx: base.x,
        baseDy: base.y,
        basePanX: pan.x,
        basePanY: pan.y,
        moved: false,
      };
      setLiveDrag({ pageId, dx: 0, dy: 0 });
    },
    [pan, presentation.dragOffsets],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>): void => {
      const drag = dragRef.current;
      if (!drag) return;
      const { dx, dy } = toSceneDelta(e.clientX - drag.startX, e.clientY - drag.startY);
      if (!drag.moved && (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5)) {
        drag.moved = true;
        // Now it is a real pan: keep receiving moves even off the canvas.
        if (drag.kind === "pan") svgRef.current?.setPointerCapture?.(e.pointerId);
      }
      if (drag.kind === "node") {
        setLiveDrag({ pageId: drag.pageId!, dx, dy });
      } else {
        // Background pan: dragging right/down moves the view the same way, so
        // the viewBox origin shifts in the OPPOSITE direction.
        const next = { x: drag.basePanX - dx, y: drag.basePanY - dy };
        // Track release velocity (scene units / ms, lightly smoothed) for momentum.
        const now = performance.now();
        const prev = velRef.current;
        if (prev && now > prev.t) {
          const dt = now - prev.t;
          const k = 0.35;
          velRef.current = {
            x: next.x,
            y: next.y,
            t: now,
            vx: prev.vx * (1 - k) + ((next.x - prev.x) / dt) * k,
            vy: prev.vy * (1 - k) + ((next.y - prev.y) / dt) * k,
          };
        } else {
          velRef.current = { x: next.x, y: next.y, t: now, vx: 0, vy: 0 };
        }
        setPan(next);
      }
    },
    [toSceneDelta],
  );

  // Momentum: after a quick flick the map keeps gliding and settles, instead of
  // stopping dead under the cursor.
  const startInertia = useCallback((vx: number, vy: number): void => {
    snapRef.current = true;
    let last = performance.now();
    let cvx = vx;
    let cvy = vy;
    const tick = (now: number): void => {
      const dt = Math.min(48, now - last);
      last = now;
      const decay = Math.exp(-dt / 240);
      cvx *= decay;
      cvy *= decay;
      if (Math.hypot(cvx, cvy) < 0.004) {
        inertiaFrame.current = 0;
        snapRef.current = false;
        return;
      }
      setPan((p) => ({ x: p.x + cvx * dt, y: p.y + cvy * dt }));
      inertiaFrame.current = requestAnimationFrame(tick);
    };
    inertiaFrame.current = requestAnimationFrame(tick);
  }, []);

  const endGesture = useCallback((): void => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (drag.kind === "pan") {
      const v = velRef.current;
      velRef.current = null;
      // A flick: momentum only if the pointer was still moving when released.
      const stale = v ? performance.now() - v.t > 90 : true;
      if (drag.moved && motion && v && !stale && Math.hypot(v.vx, v.vy) > 0.02) {
        startInertia(v.vx, v.vy);
      } else {
        snapRef.current = false;
      }
    }
    if (drag.kind === "node" && drag.moved) {
      const live = liveDrag;
      const dx = drag.baseDx + (live?.dx ?? 0);
      const dy = drag.baseDy + (live?.dy ?? 0);
      // Commit the dragged OFFSET so it persists (D19); setDragOffset records
      // NO history revision (FEAT-001 excludes drag frames).
      void wb.setDragOffset(drag.pageId as PageId, dx, dy).then(() => {
        setLiveDrag(null);
        bump();
      });
    } else {
      setLiveDrag(null);
    }
  }, [liveDrag, wb, bump, motion, startInertia]);

  const onBackgroundPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>): void => {
      // Only start a pan on an empty-canvas press (nodes stop propagation).
      // Do NOT capture the pointer yet: capturing on press retargets the
      // following `click` to the <svg>, so plain clicks on anything inside it
      // that isn't a node (e.g. a placeholder's "Return to Reader") never fire.
      // The capture is taken once the press actually turns into a drag.
      if (inertiaFrame.current) {
        cancelAnimationFrame(inertiaFrame.current);
        inertiaFrame.current = 0;
      }
      snapRef.current = true; // the map follows the pointer 1:1 while held
      velRef.current = null;
      dragRef.current = {
        kind: "pan",
        startX: e.clientX,
        startY: e.clientY,
        baseDx: 0,
        baseDy: 0,
        basePanX: pan.x,
        basePanY: pan.y,
        moved: false,
      };
    },
    [pan],
  );

  const onHubClick = (relationshipId: string): void => {
    const current =
      graph.links.find((l) => l.relationshipId === relationshipId)?.label ?? "";
    setEditingHub(relationshipId);
    const next = window.prompt("Connecting page label", current);
    setEditingHub(null);
    if (next === null) return;
    void wb.setRelationshipLabel(relationshipId as RelationshipId, next).then(bump);
  };

  const onOpenConnectingPage = (relationshipId: string): void => {
    void wb.developRelationshipPage(relationshipId as RelationshipId).then(bump);
  };

  const onNodeClick = (pageId: string): void => {
    // A drag that moved should not also open the page (gesture disambiguation).
    if (dragRef.current?.moved) return;
    // FEAT-003 (3.1): in Connect Nodes mode a click TOGGLES the node in the
    // multi-select set (building a hub) rather than opening its page.
    if (connectMode) {
      setSelectedNodeIds((prev) =>
        prev.includes(pageId as PageId)
          ? prev.filter((id) => id !== (pageId as PageId))
          : [...prev, pageId as PageId],
      );
      return;
    }
    // Reuse the SubjectEditor open flow: a node IS a page, so clicking opens it
    // for composition (the connecting-page editor path for subject nodes).
    wb.openSubjectPage(pageId as PageId);
    bump();
  };

  // --- FEAT-003 (3.1) creation handlers ------------------------------------
  // "+ Subject": prompt a title and create a real subject Page directly in the
  // network. The new page immediately appears as a graph-node.
  const onCreateSubject = (): void => {
    const title = window.prompt("New subject page title", "");
    if (title === null) return;
    const trimmed = title.trim();
    if (trimmed === "") return;
    void wb.createSubjectPage(trimmed).then(bump);
  };

  // "+ Category": toggle the creation popover. Entering connect mode / the
  // category popover are mutually exclusive so only one surface is open.
  const onToggleCategoryModal = (): void => {
    setCategoryModalOpen((open) => {
      const next = !open;
      if (next) {
        setConnectMode(false);
        setSelectedNodeIds([]);
      }
      return next;
    });
  };

  const onCreateCategory = (): void => {
    const name = newCategoryName.trim();
    if (name === "") return;
    void wb.createCategory(name, newCategoryColor).then(() => {
      setNewCategoryName("");
      bump();
    });
  };

  // Toggle a page's membership in a category (§3.1) via the real workbench
  // mutations. Adds when absent, removes when present; both persist.
  const onToggleMembership = (categoryId: CategoryId, pageId: PageId, isMember: boolean): void => {
    const op = isMember
      ? wb.removePageFromCategory(categoryId, pageId)
      : wb.addPageToCategory(categoryId, pageId);
    void op.then(bump);
  };

  // "Connect Nodes": toggle multi-node selection mode. Leaving the mode clears
  // the selection so stale picks never leak into the next session.
  const onToggleConnectMode = (): void => {
    setConnectMode((on) => {
      const next = !on;
      if (next) {
        setCategoryModalOpen(false);
      }
      setSelectedNodeIds([]);
      return next;
    });
  };

  // "Create Hub": build a real Relationship from the selected nodes. 2 nodes
  // make a lens; N>=3 make a star hub (the topology is derived by the engine).
  const onCreateHub = (): void => {
    if (selectedNodeIds.length < 2) return;
    void wb
      .createRelationship(selectedNodeIds, hubKind, hubLabel.trim())
      .then(() => {
        setSelectedNodeIds([]);
        setHubLabel("");
        setConnectMode(false);
        bump();
      });
  };

  return (
    <div
      data-testid="nodes-canvas-shell"
      className="nodes-canvas-shell"
      data-suppress-motion={suppressMotion ? "true" : "false"}
      style={{ position: "relative", width: "100%", height: "100%" }}
    >
      {/* FEAT-003 (3.1) floating creation bar: build the whole concept network
          with the mouse (+ Subject, + Category, Connect Nodes / Create Hub). */}
      <div data-testid="nodes-create-bar" className="nodes-create-bar">
        <Button data-testid="nodes-create-subject-btn" onClick={onCreateSubject}>
          + Subject
        </Button>
        <Button
          data-testid="nodes-create-category-btn"
          data-active={categoryModalOpen ? "true" : "false"}
          aria-expanded={categoryModalOpen}
          onClick={onToggleCategoryModal}
        >
          + Category
        </Button>
        <Button
          data-testid="nodes-connect-mode-btn"
          data-active={connectMode ? "true" : "false"}
          aria-pressed={connectMode}
          onClick={onToggleConnectMode}
        >
          {connectMode ? "Connecting…" : "Connect Nodes"}
        </Button>
      </div>

      {/* §3.1 category creation + membership popover. */}
      {categoryModalOpen && (
        <div data-testid="nodes-category-modal" className="nodes-category-modal">
          <h3>New category</h3>
          <input
            type="text"
            data-testid="nodes-category-name-input"
            placeholder="Category name"
            value={newCategoryName}
            onChange={(e) => setNewCategoryName(e.target.value)}
          />
          <div className="nodes-swatch-row" data-testid="nodes-category-swatches">
            {NATURAL_PALETTE_ORDER.map((color) => (
              <button
                key={color}
                type="button"
                data-testid="nodes-category-swatch"
                data-color={color}
                data-selected={newCategoryColor === color ? "true" : "false"}
                aria-label={`Use ${color}`}
                className="nodes-swatch"
                style={{ background: color }}
                onClick={() => setNewCategoryColor(color)}
              />
            ))}
          </div>
          <button
            type="button"
            data-testid="nodes-category-create-btn"
            onClick={onCreateCategory}
          >
            Create category
          </button>

          {/* Per-category membership toggles for every existing Subject Page. */}
          {graph.categories.map((cat) => (
            <div key={cat.categoryId} data-testid="nodes-category-membership">
              <h3>{cat.name}</h3>
              <div className="nodes-category-members">
                {graph.nodes.map((node) => {
                  const isMember = cat.memberPageIds.includes(node.pageId);
                  return (
                    <label
                      key={node.pageId}
                      className="nodes-category-member"
                      data-testid="nodes-category-member"
                      data-category-id={cat.categoryId}
                      data-page-id={node.pageId}
                    >
                      <input
                        type="checkbox"
                        data-testid="nodes-category-member-toggle"
                        data-category-id={cat.categoryId}
                        data-page-id={node.pageId}
                        checked={isMember}
                        onChange={() =>
                          onToggleMembership(cat.categoryId, node.pageId, isMember)
                        }
                      />
                      {node.title}
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* §3.1 Create Hub popover: shown once >=2 nodes are selected in connect
          mode. 2 nodes -> lens, N>=3 -> star (topology derived by the engine). */}
      {connectMode && selectedNodeIds.length >= 2 && (
        <div data-testid="nodes-hub-modal" className="nodes-hub-modal">
          <h3>Create hub ({selectedNodeIds.length} nodes)</h3>
          <select
            data-testid="nodes-hub-kind-select"
            value={hubKind}
            onChange={(e) => setHubKind(e.target.value as RelationshipKind)}
          >
            {RELATIONSHIP_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
          <input
            type="text"
            data-testid="nodes-hub-label-input"
            placeholder="Connection label"
            value={hubLabel}
            onChange={(e) => setHubLabel(e.target.value)}
          />
          <Button data-testid="nodes-create-hub-btn" onClick={onCreateHub}>
            Create Hub
          </Button>
        </div>
      )}

      {/* §3.3 zoom controls — wired to wb.setZoom via the folded viewBox. */}
      <div data-testid="canvas-zoom-controls" className="canvas-zoom-controls">
        <IconButton label="Zoom in" data-testid="canvas-zoom-in" onClick={onZoomIn}>
          +
        </IconButton>
        <IconButton label="Zoom out" data-testid="canvas-zoom-out" onClick={onZoomOut}>
          −
        </IconButton>
        <IconButton label="Reset zoom" data-testid="canvas-zoom-reset" onClick={onZoomReset}>
          Reset
        </IconButton>
      </div>
      <svg
        ref={svgRef}
        data-testid="nodes-canvas"
        className="nodes-canvas"
        viewBox={viewBox}
        data-pan-x={round(pan.x)}
        data-pan-y={round(pan.y)}
        data-zoom={round(zoom)}
        preserveAspectRatio="xMidYMid meet"
        data-suppress-motion={suppressMotion ? "true" : "false"}
        role="img"
        aria-label="Concept network"
        onPointerDown={onBackgroundPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
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
        <WatercolorDefs squircles={scene.squircles} motion={motion} />
      </defs>

      <g ref={camRef} data-testid="camera">
      <WaterBackdrop
        squircles={scene.squircles}
        extent={parseViewBox(baseViewBox)}
        motion={motion}
      />

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
              <path
                className="category-squircle-fill"
                d={sq.d}
                fill={`url(#wash-${sq.categoryId.replace(/[^a-zA-Z0-9_-]/g, "_")})`}
              />
              {motion && <SheenOverlay d={sq.d} />}
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

      {/* Where two category washes overlap their pigments mix like colours in water. */}
      <OverlapBleeds squircles={scene.squircles} motion={motion} />

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
        {scene.hubs.map((hub) => {
          // FIX-NODES-LABEL-OVERLAP (§3.2): only reveal the action pill for the
          // hovered or actively-selected/editing hub so pills never render
          // permanently on all hubs and overdraw neighbouring dots/labels.
          const pillVisible =
            hoveredHub === hub.relationshipId || editingHub === hub.relationshipId;
          return (
          <g
            key={hub.relationshipId}
            data-testid="hub-group"
            data-hub-active={pillVisible ? "true" : "false"}
            onMouseEnter={() => setHoveredHub(hub.relationshipId)}
            onMouseLeave={() =>
              setHoveredHub((cur) => (cur === hub.relationshipId ? null : cur))
            }
          >
            <path
              className="graph-hub"
              data-testid="graph-hub"
              data-relationship-id={hub.relationshipId}
              data-hub-kind={hub.kind}
              data-endpoint-count={hub.endpointCount}
              data-hub-cx={round(hub.center.x)}
              data-hub-cy={round(hub.center.y)}
              d={hub.d}
              fill={hub.blendColor}
              onClick={() => onOpenConnectingPage(hub.relationshipId)}
            />
            {/*
              A13-M2: develop/open the hub's FULL Connecting Page in the
              SubjectEditor. Distinct from the inline short-label edit (the
              graph-hub click above, which keeps the prompt path reachable).
              Clicking lazily creates-or-opens the explanatory subject Page and
              bumps so the shell re-renders into the editor. Hidden until the
              hub is hovered or selected/editing (§3.2 declutter).
            */}
            <text
              className="open-connecting-page"
              data-testid="open-connecting-page"
              data-relationship-id={hub.relationshipId}
              data-pill-visible={pillVisible ? "true" : "false"}
              x={round(hub.center.x)}
              y={round(hub.center.y) + 22}
              textAnchor="middle"
              role="button"
              style={{
                opacity: pillVisible ? 1 : 0,
                pointerEvents: pillVisible ? "auto" : "none",
              }}
              onClick={() => onOpenConnectingPage(hub.relationshipId)}
            >
              Open connecting page
            </text>
            {/* Short-label edit lives on its own hover control: a single click on
                the hub opens the page (which re-lays-out the map), so a
                double-click gesture cannot be relied on. */}
            <text
              className="open-connecting-page"
              data-testid="edit-hub-label"
              data-relationship-id={hub.relationshipId}
              x={round(hub.center.x)}
              y={round(hub.center.y) + 40}
              textAnchor="middle"
              role="button"
              style={{
                opacity: pillVisible ? 1 : 0,
                pointerEvents: pillVisible ? "auto" : "none",
              }}
              onClick={() => onHubClick(hub.relationshipId)}
            >
              Edit label
            </text>
          </g>
          );
        })}
      </g>

      {/* Circular dot nodes with minimal hover labels. */}
      <g data-testid="node-layer">
        {scene.nodes.map((node) => (
          <g
            key={node.pageId}
            className={
              focusedPageId === node.pageId ? "graph-node graph-node-focused" : "graph-node"
            }
            data-testid="graph-node"
            data-page-id={node.pageId}
            data-focused={focusedPageId === node.pageId ? "true" : "false"}
            data-selected={selectedNodeIds.includes(node.pageId as PageId) ? "true" : "false"}
            data-x={round(node.x)}
            data-y={round(node.y)}
            transform={`translate(${node.x} ${node.y})`}
            style={{ cursor: "grab" }}
            onPointerDown={(e) => onNodePointerDown(e, node.pageId)}
            onClick={() => onNodeClick(node.pageId)}
            onMouseEnter={() => setHoveredNode(node.pageId)}
            onMouseLeave={() =>
              setHoveredNode((cur) => (cur === node.pageId ? null : cur))
            }
          >
            <circle
              r={7}
              className="graph-node-dot"
              // De-phase the idle bob so the dots drift independently.
              style={{ animationDelay: `${-((hashPhase(node.pageId) % 70) / 10)}s` }}
            />
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
      </g>
      </svg>
    </div>
  );
}

/** Vertical spacing between stacked N06 placeholders (presentation only). */
const PLACEHOLDER_SPACING = 96;

/** Zoom bounds + per-step multiplier for the §3.3 canvas zoom controls. */
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 5;
const ZOOM_STEP = 1.2;

/** Parse an SVG viewBox string into its numeric components. */
/** Small stable per-id number used to de-phase ambient animation. */
function hashPhase(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

interface ViewBoxNums {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** True when the OS asks for reduced motion (live-updating). */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = (): void => setReduced(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

function parseViewBox(vb: string): { x: number; y: number; w: number; h: number } {
  const [x, y, w, h] = vb.split(/\s+/).map(Number);
  return { x: x ?? 0, y: y ?? 0, w: w || 1, h: h || 1 };
}

/**
 * Fold the pan offset and zoom scale into a base viewBox (§3.3). Zooming in
 * (scale > 1) shrinks the viewBox around its center so the scene appears
 * larger; panning shifts the origin. Pure — no camera animation.
 */
function applyPanZoom(base: string, pan: { x: number; y: number }, zoom: number): string {
  const { x, y, w, h } = parseViewBox(base);
  const cx = x + w / 2;
  const cy = y + h / 2;
  const zw = w / zoom;
  const zh = h / zoom;
  const nx = cx - zw / 2 + pan.x;
  const ny = cy - zh / 2 + pan.y;
  return `${round(nx)} ${round(ny)} ${round(zw)} ${round(zh)}`;
}

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
