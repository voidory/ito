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

    expect(el.querySelector('[data-testid="category-link"]')).not.toBeNull();
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
});
