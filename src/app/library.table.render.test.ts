/**
 * jsdom render coverage for the M9 (FEAT-002 3) Library TABLE. It mounts the
 * REAL Library against a REAL Workbench (in-memory storage) and asserts:
 *  - the table renders the six columns (Title, Authors, Year, Pages,
 *    Annotations, Date added) with sortable headers;
 *  - each source is a library-item row carrying the per-column cells + an
 *    annotation count read live from the workbench;
 *  - the collection tree lists one node per category and drives onScopeChange;
 *  - clicking a sortable header reorders the rows (title asc -> desc).
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { sha256Hex } from "../storage";
import { Workbench } from "./workbench";
import { Library } from "./Library";
import type { Source, SourceId } from "../model";

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
  onScopeChange: (c: string | null) => void = () => undefined,
): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      createElement(Library, {
        wb,
        categoryScope: null,
        onScopeChange,
        onOpen: () => undefined,
        onOpenTogether: () => undefined,
      }),
    );
  });
  return container;
}

async function seed(wb: Workbench, title: string, category: string): Promise<Source> {
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, title.length & 0xff]);
  return wb.importSource({
    title,
    bytes,
    versionHash: await sha256Hex(bytes),
    pageCount: 3,
    category,
  });
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("Library — sortable table + collection tree (FEAT-002 3)", () => {
  it("renders the six sortable column headers", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    await seed(wb, "Alpha", "Papers");
    const el = await mount(wb);
    for (const key of ["title", "authors", "year", "pages", "annotations", "importedAt"]) {
      expect(el.querySelector(`[data-testid="library-sort-${key}"]`)).not.toBeNull();
    }
    expect(el.querySelector('[data-testid="library-table"]')).not.toBeNull();
  });

  it("renders a row per source with the per-column cells and a live annotation count", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const a = await seed(wb, "Alpha Paper", "Papers");
    await wb.commitAreaAnnotation(a.id, 0, { x: 0.1, y: 0.1, width: 0.2, height: 0.2 });
    const el = await mount(wb);

    const row = el.querySelector(
      `[data-testid="library-item"][data-source-id="${a.id}"]`,
    )!;
    expect(row.tagName.toLowerCase()).toBe("tr");
    expect(row.querySelector('[data-testid="library-open"]')!.textContent).toBe("Alpha Paper");
    expect(row.querySelector('[data-testid="library-cell-pages"]')!.textContent).toBe("3");
    expect(row.querySelector('[data-testid="library-cell-annotations"]')!.textContent).toBe("1");
    expect(row.querySelector('[data-testid="library-cell-date"]')!.textContent).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });

  it("lists one collection-tree node per category and fires onScopeChange", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    await seed(wb, "A", "Papers");
    await seed(wb, "B", "Books");
    const scopes: (string | null)[] = [];
    const el = await mount(wb, (c) => scopes.push(c));

    const nodes = el.querySelectorAll('[data-testid="collection-node"]');
    expect(Array.from(nodes).map((n) => n.getAttribute("data-category")).sort()).toEqual([
      "Books",
      "Papers",
    ]);
    await click(el.querySelector('[data-testid="collection-node"][data-category="Books"]')!);
    expect(scopes).toContain("Books");
    await click(el.querySelector('[data-testid="collection-all"]')!);
    expect(scopes).toContain(null);
  });

  it("toggling a header flips the sort direction order of rows", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    await seed(wb, "Alpha", "Papers");
    await seed(wb, "Zeta", "Papers");
    const el = await mount(wb);

    const titlesAsc = Array.from(el.querySelectorAll('[data-testid="library-open"]')).map(
      (b) => b.textContent,
    );
    expect(titlesAsc).toEqual(["Alpha", "Zeta"]);

    await click(el.querySelector('[data-testid="library-sort-title"]')!);
    const titlesDesc = Array.from(el.querySelectorAll('[data-testid="library-open"]')).map(
      (b) => b.textContent,
    );
    expect(titlesDesc).toEqual(["Zeta", "Alpha"]);
  });
});

// Keep an explicit reference so an unused-import lint never trips on SourceId.
export type _KeepSourceId = SourceId;
