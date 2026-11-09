/**
 * jsdom render coverage for the M9 (FEAT-002 3) Library TABLE. It mounts the
 * REAL Library against a REAL Workbench (in-memory storage) and asserts:
 *  - the table renders the six columns (Title, Authors, Year, Pages,
 *    Annotations, Date added) with sortable headers;
 *  - each source is a library-item row carrying the per-column cells + an
 *    annotation count read live from the workbench;
 *  - the list is flat (no category sections or tree);
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

async function mount(wb: Workbench): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      createElement(Library, {
        wb,
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

  it("is one flat list: no category sections, tree or scope select", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    await seed(wb, "A", "Papers");
    await seed(wb, "B", "References");
    const el = await mount(wb);

    expect(el.querySelectorAll('[data-testid="library-table"]').length).toBe(1);
    expect(el.querySelectorAll('[data-testid="library-item"]').length).toBe(2);
    expect(el.querySelector('[data-testid="library-category"]')).toBeNull();
    expect(el.querySelector('[data-testid="collection-tree"]')).toBeNull();
    expect(el.querySelector('[data-testid="library-scope"]')).toBeNull();
  });

  it("delete asks first, then removes the PDF and its highlights", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const a = await seed(wb, "Keep", "Papers");
    const b = await seed(wb, "Remove", "Papers");
    const el = await mount(wb);

    await click(el.querySelector(`[data-testid="delete-source"][data-source-id="${b.id}"]`)!);
    expect(el.querySelector('[data-testid="delete-confirm"]')).not.toBeNull();
    // Nothing is deleted until confirmed.
    expect(wb.rawData().sources.length).toBe(2);

    await click(el.querySelector('[data-testid="delete-cancel"]')!);
    expect(el.querySelector('[data-testid="delete-confirm"]')).toBeNull();
    expect(wb.rawData().sources.length).toBe(2);

    await click(el.querySelector(`[data-testid="delete-source"][data-source-id="${b.id}"]`)!);
    await click(el.querySelector('[data-testid="delete-confirm-yes"]')!);
    expect(wb.rawData().sources.map((s) => s.id)).toEqual([a.id]);
    expect(el.querySelectorAll('[data-testid="library-item"]').length).toBe(1);
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
