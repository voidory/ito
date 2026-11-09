/**
 * jsdom render coverage for NodesCanvas (FEAT-004 step 7).
 *
 * This complements the pure scene.test.ts and the Playwright spec: it mounts
 * the REAL React component against a REAL Workbench (in-memory storage, nothing
 * mocked) and asserts the data-testid/data-* contract the Playwright spec polls
 * — graph-node per page, graph-hub with data-hub-kind + data-endpoint-count,
 * category-squircle with the .category-squircle-fill class, the
 * #watercolor-turbulent-edge filter in <defs>, and the A14 category-link. The
 * sandbox cannot run Playwright Chromium, so this proves the DOM contract
 * headlessly in jsdom.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { Workbench } from "./workbench";
import { NodesCanvas } from "./NodesCanvas";
import type { PageId } from "../model";

// React 18 act() environment flag.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function mount(
  wb: Workbench,
  extra: {
    categoryScope?: string | null;
    placeholder?: { sourceId: string; title: string; transient: boolean } | null;
    placeholders?: readonly { sourceId: string; title: string; transient: boolean }[];
    focusedPageId?: string | null;
  } = {},
): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      createElement(NodesCanvas, {
        wb,
        suppressMotion: false,
        bump: () => undefined,
        ...extra,
      }),
    );
  });
  return container;
}

/**
 * jsdom has no PointerEvent constructor. React's pointer-event plugin listens
 * for native events named "pointerdown"/"pointermove"/"pointerup", so a
 * MouseEvent carrying that type triggers the React handlers; we augment it with
 * the `pointerId` the handlers read.
 */
function pointer(type: string, props: { clientX?: number; clientY?: number; pointerId?: number }): Event {
  const ev = new MouseEvent(type, {
    bubbles: true,
    clientX: props.clientX ?? 0,
    clientY: props.clientY ?? 0,
  });
  Object.defineProperty(ev, "pointerId", { value: props.pointerId ?? 1 });
  return ev;
}

async function makePages(wb: Workbench, titles: readonly string[]): Promise<PageId[]> {
  const ids: PageId[] = [];
  for (const t of titles) ids.push((await wb.createSubjectPage(t)).id);
  return ids;
}

describe("NodesCanvas — renders from live Workbench records", () => {
  it("renders one graph-node per page and the watercolor filter once", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    await makePages(wb, ["Alpha", "Beta"]);
    const el = await mount(wb);

    expect(el.querySelectorAll('[data-testid="graph-node"]').length).toBe(2);
    // The turbulence edge filter is defined exactly once in <defs>.
    expect(el.querySelectorAll("#watercolor-turbulent-edge").length).toBe(1);
    expect(el.querySelector("feTurbulence")).not.toBeNull();
    expect(el.querySelector("feDisplacementMap")).not.toBeNull();
  });

  it("renders a lens hub for a 2-endpoint relationship", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const [a, b] = await makePages(wb, ["A", "B"]);
    await wb.createRelationship([a!, b!]);
    const el = await mount(wb);

    const hub = el.querySelector('[data-testid="graph-hub"]');
    expect(hub).not.toBeNull();
    expect(hub!.getAttribute("data-hub-kind")).toBe("lens");
    expect(hub!.getAttribute("data-endpoint-count")).toBe("2");
  });

  it("renders a star hub with endpoint-count>=3 for a >=3-endpoint relationship", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const ids = await makePages(wb, ["A", "B", "C"]);
    await wb.createRelationship(ids);
    const el = await mount(wb);

    const hub = el.querySelector('[data-testid="graph-hub"]')!;
    expect(hub.getAttribute("data-hub-kind")).toBe("star");
    expect(Number(hub.getAttribute("data-endpoint-count"))).toBeGreaterThanOrEqual(3);
  });

  it("renders a category squircle with the multiply watercolor fill class", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const [a, b] = await makePages(wb, ["A", "B"]);
    const cat = await wb.createCategory("Theme", "#4b5578", [a!, b!]);
    const el = await mount(wb);

    const sq = el.querySelector(`[data-category-id="${cat.id}"]`);
    expect(sq).not.toBeNull();
    expect(sq!.getAttribute("data-testid")).toBe("category-squircle");
    expect(sq!.querySelector(".category-squircle-fill")).not.toBeNull();
    // Dotted-dashed border present.
    expect(sq!.querySelector(".category-squircle-border")).not.toBeNull();
  });

  it("renders a category-link between two categories bridged by a relationship (A14-M2)", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const [a, b] = await makePages(wb, ["A", "B"]);
    await wb.createCategory("CatA", "#4b5578", [a!]);
    await wb.createCategory("CatB", "#b5653f", [b!]);
    await wb.createRelationship([a!, b!]);
    const el = await mount(wb);

    const link = el.querySelector('[data-testid="category-link"]');
    expect(link).not.toBeNull();
    // A member-bridging relationship (no master pages) is classed 'member'.
    expect(link!.getAttribute("data-link-kind")).toBe("member");
  });

  it("renders a 'master' category-link when two categories' master pages are related (A14-M2)", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const [a, b] = await makePages(wb, ["A", "B"]);
    const catA = await wb.createCategory("CatA", "#4b5578", [a!]);
    const catB = await wb.createCategory("CatB", "#b5653f", [b!]);
    // Connect the two category BOUNDARIES (master page <-> master page).
    await wb.connectCategoryBoundaries(catA.id, catB.id);
    const el = await mount(wb);

    const links = Array.from(el.querySelectorAll('[data-testid="category-link"]'));
    expect(links.length).toBe(1);
    expect(links[0]!.getAttribute("data-link-kind")).toBe("master");
  });

  it("FEAT-005: with a category scope, renders only that category + overlapping ones", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const [p1, p2, p3, p4] = await makePages(wb, ["Species", "Climate", "Markets", "Rome"]);
    const ecology = await wb.createCategory("Ecology", "#4b5578", [p1!, p2!]);
    const economics = await wb.createCategory("Economics", "#b5653f", [p2!, p3!]);
    const history = await wb.createCategory("History", "#5f7a52", [p4!]);

    const el = await mount(wb, { categoryScope: "Ecology" });
    const squircleIds = Array.from(
      el.querySelectorAll('[data-testid="category-squircle"]'),
    ).map((e) => e.getAttribute("data-category-id"));

    // Ecology + Economics (overlap via p2) render; disjoint History does not.
    expect(squircleIds).toContain(ecology.id);
    expect(squircleIds).toContain(economics.id);
    expect(squircleIds).not.toContain(history.id);

    // p4 (only in History) is filtered out of the node layer.
    const nodeIds = Array.from(el.querySelectorAll('[data-testid="graph-node"]')).map((n) =>
      n.getAttribute("data-page-id"),
    );
    expect(nodeIds).not.toContain(p4);
    expect(nodeIds).toContain(p1);
  });

  it("FEAT-005/N06: renders the transient 'Not connected yet' placeholder with the PDF title", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const source = await wb.importSource({
      title: "Lonely Paper",
      bytes: new Uint8Array([1, 2, 3, 4]),
      versionHash: "h1",
      pageCount: 3,
    });
    const placeholder = wb.nodePlaceholderFor(source.id);
    const el = await mount(wb, { placeholder });

    const node = el.querySelector('[data-testid="node-placeholder"]')!;
    expect(node).not.toBeNull();
    expect(node.getAttribute("data-transient")).toBe("true");
    expect(node.getAttribute("data-source-id")).toBe(source.id);
    expect(el.querySelector('[data-testid="node-placeholder-title"]')!.textContent).toContain(
      "Lonely Paper",
    );
    // Rendering the placeholder created no durable graph records.
    const d = wb.rawData();
    expect(d.pages.length).toBe(0);
    expect(d.relationships.length).toBe(0);
    expect(d.categories.length).toBe(0);
  });

  it("Ruling 2/N06: renders one placeholder group per open unconnected source, each with a Return-to-Reader control", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const s1 = await wb.importSource({
      title: "First Paper",
      bytes: new Uint8Array([1, 2, 3, 4]),
      versionHash: "h1",
      pageCount: 2,
    });
    const s2 = await wb.importSource({
      title: "Second Paper",
      bytes: new Uint8Array([5, 6, 7, 8]),
      versionHash: "h2",
      pageCount: 2,
    });
    const placeholders = [wb.nodePlaceholderFor(s1.id), wb.nodePlaceholderFor(s2.id)];
    const el = await mount(wb, { placeholders });

    const groups = Array.from(el.querySelectorAll('[data-testid="node-placeholder"]'));
    expect(groups).toHaveLength(2);
    const sourceIds = groups.map((g) => g.getAttribute("data-source-id")).sort();
    expect(sourceIds).toEqual([s1.id, s2.id].sort());
    for (const g of groups) {
      expect(g.getAttribute("data-transient")).toBe("true");
      // Each placeholder carries a Return-to-Reader control.
      expect(g.querySelector('[data-testid="placeholder-return-reader"]')).not.toBeNull();
    }
    // Two distinct return-to-reader controls across the layer.
    expect(el.querySelectorAll('[data-testid="placeholder-return-reader"]').length).toBe(2);

    // Rendering created zero durable graph records.
    const d = wb.rawData();
    expect(d.pages.length).toBe(0);
    expect(d.relationships.length).toBe(0);
    expect(d.categories.length).toBe(0);
  });

  it("Ruling 2/N06: clicking Return-to-Reader switches to Files focused on that source and creates no records", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const s1 = await wb.importSource({
      title: "First Paper",
      bytes: new Uint8Array([1, 2, 3, 4]),
      versionHash: "h1",
      pageCount: 2,
    });
    const s2 = await wb.importSource({
      title: "Second Paper",
      bytes: new Uint8Array([5, 6, 7, 8]),
      versionHash: "h2",
      pageCount: 2,
    });
    wb.setViewMode("nodes");
    const placeholders = [wb.nodePlaceholderFor(s1.id), wb.nodePlaceholderFor(s2.id)];
    const el = await mount(wb, { placeholders });

    const s2Group = el.querySelector(
      `[data-testid="node-placeholder"][data-source-id="${s2.id}"]`,
    )!;
    const control = s2Group.querySelector(
      '[data-testid="placeholder-return-reader"]',
    ) as HTMLElement;
    await act(async () => {
      control.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Switched back to Files focused on s2; zero durable records created.
    expect(wb.viewMode()).toBe("files");
    expect(wb.snapshot().openSourceIds).toEqual([s2.id]);
    const d = wb.rawData();
    expect(d.pages.length).toBe(0);
    expect(d.relationships.length).toBe(0);
    expect(d.categories.length).toBe(0);
  });

  it("A13-M2: a rendered hub exposes an open-connecting-page control", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const [a, b] = await makePages(wb, ["A", "B"]);
    const rel = await wb.createRelationship([a!, b!]);
    const el = await mount(wb);

    const control = el.querySelector('[data-testid="open-connecting-page"]');
    expect(control).not.toBeNull();
    expect(control!.getAttribute("data-relationship-id")).toBe(rel.id);
    // The hub itself is still rendered alongside the control (both affordances).
    expect(el.querySelector('[data-testid="graph-hub"]')).not.toBeNull();
  });

  it("A13-M2: clicking open-connecting-page develops+opens the explanatory page", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const [a, b] = await makePages(wb, ["A", "B"]);
    const rel = await wb.createRelationship([a!, b!], "relates", "bridges");
    const el = await mount(wb);

    const control = el.querySelector(
      '[data-testid="open-connecting-page"]',
    ) as SVGTextElement;
    await act(async () => {
      control.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const explanatoryId = wb.explanatoryPageId(rel.id);
    expect(explanatoryId).not.toBeNull();
    expect(wb.snapshot().openSubjectPageId).toBe(explanatoryId);
  });

  it("N04/N05: with focusedPageId set, the matching graph-node has data-focused='true' and others do not", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const [a, b] = await makePages(wb, ["A", "B"]);
    const el = await mount(wb, { focusedPageId: a! });

    const nodes = Array.from(el.querySelectorAll('[data-testid="graph-node"]'));
    const focused = nodes.filter((n) => n.getAttribute("data-focused") === "true");
    expect(focused).toHaveLength(1);
    expect(focused[0]!.getAttribute("data-page-id")).toBe(a);
    const other = nodes.find((n) => n.getAttribute("data-page-id") === b)!;
    expect(other.getAttribute("data-focused")).toBe("false");
  });

  it("omits a presentation-hidden node from the node layer", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const [a, b] = await makePages(wb, ["A", "B"]);
    await wb.hideNode(a!);
    const el = await mount(wb);

    const ids = Array.from(el.querySelectorAll('[data-testid="graph-node"]')).map((n) =>
      n.getAttribute("data-page-id"),
    );
    expect(ids).toEqual([b]);
  });

  // --- §3.3 interactive 2D canvas (pan / zoom / node drag) ----------------

  it("§3.3: renders zoom controls wired to wb.setZoom (in / out / reset)", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    await makePages(wb, ["A", "B"]);
    const el = await mount(wb);

    const zoomIn = el.querySelector('[data-testid="canvas-zoom-in"]') as HTMLButtonElement;
    const zoomOut = el.querySelector('[data-testid="canvas-zoom-out"]') as HTMLButtonElement;
    const zoomReset = el.querySelector('[data-testid="canvas-zoom-reset"]') as HTMLButtonElement;
    expect(zoomIn).not.toBeNull();
    expect(zoomOut).not.toBeNull();
    expect(zoomReset).not.toBeNull();

    expect(wb.zoom()).toBe(1);
    await act(async () => {
      zoomIn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // Zooming in increased the persisted scale (and shrank the viewBox).
    expect(wb.zoom()).toBeGreaterThan(1);
    const zoomedIn = wb.zoom();

    await act(async () => {
      zoomReset.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(wb.zoom()).toBe(1);

    await act(async () => {
      zoomOut.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(wb.zoom()).toBeLessThan(1);
    expect(zoomedIn).toBeGreaterThan(wb.zoom());
  });

  it("§3.3: the canvas exposes data-pan-x / data-pan-y / data-zoom", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    await makePages(wb, ["A"]);
    const el = await mount(wb);
    const svg = el.querySelector('[data-testid="nodes-canvas"]')!;
    expect(svg.getAttribute("data-pan-x")).toBe("0");
    expect(svg.getAttribute("data-pan-y")).toBe("0");
    expect(svg.getAttribute("data-zoom")).toBe("1");
  });

  it("§3.3: dragging a node commits wb.setDragOffset on pointer-up (persists, D19)", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const [a] = await makePages(wb, ["A", "B"]);
    const el = await mount(wb);

    const svg = el.querySelector('[data-testid="nodes-canvas"]') as SVGSVGElement;
    // jsdom has no layout; give the SVG a measurable client box so the drag
    // delta maps to scene units deterministically.
    svg.getBoundingClientRect = () =>
      ({ width: 400, height: 400, left: 0, top: 0, right: 400, bottom: 400, x: 0, y: 0, toJSON() {} }) as DOMRect;

    const group = el.querySelector(
      `[data-testid="graph-node"][data-page-id="${a}"]`,
    ) as SVGGElement;
    (group as unknown as { setPointerCapture?: () => void }).setPointerCapture = () => undefined;

    await act(async () => {
      group.dispatchEvent(pointer("pointerdown", { clientX: 10, clientY: 10, pointerId: 1 }));
    });
    await act(async () => {
      svg.dispatchEvent(pointer("pointermove", { clientX: 60, clientY: 90, pointerId: 1 }));
    });
    await act(async () => {
      svg.dispatchEvent(pointer("pointerup", { pointerId: 1 }));
    });

    // A durable drag offset was persisted for the dragged node (non-zero).
    const off = wb.presentationView().dragOffsets[a!];
    expect(off).toBeDefined();
    expect(Math.abs(off!.x) + Math.abs(off!.y)).toBeGreaterThan(0);
    // Dragging records NO history revision (FEAT-001 excludes drag frames).
    expect(wb.revisions().length).toBe(0);
  });
});
