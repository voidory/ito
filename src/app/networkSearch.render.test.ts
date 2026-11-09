/**
 * jsdom render coverage for the NetworkSearch shell surface (FEAT-005). It
 * mounts the REAL component against a REAL Workbench (in-memory storage,
 * nothing mocked), types a query matching seeded records, asserts the results
 * container surfaces a result item, and that selecting each result kind drives
 * the EXPECTED Workbench transition while creating ZERO durable records.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { Workbench } from "./workbench";
import { NetworkSearch } from "./NetworkSearch";
import type { DocumentJson } from "../editor";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function mount(wb: Workbench, categoryScope: string | null = null): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      createElement(NetworkSearch, { wb, categoryScope, bump: () => undefined }),
    );
  });
  return container;
}

async function type(el: HTMLElement, value: string): Promise<void> {
  const input = el.querySelector('[data-testid="network-search-input"]') as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function docWithText(text: string): DocumentJson {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

describe("NetworkSearch — renders + selects against a real Workbench", () => {
  it("renders no results container until a matching query is typed", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    await wb.createSubjectPage("Evolution");
    const el = await mount(wb);

    expect(el.querySelector('[data-testid="network-search-input"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="network-search-results"]')).toBeNull();

    await type(el, "zzz-no-match");
    expect(el.querySelector('[data-testid="network-search-results"]')).toBeNull();
  });

  it("shows a page result for a matching query and selecting it opens the subject page", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const page = await wb.createSubjectPage("Evolutionary Biology");
    const el = await mount(wb);

    await type(el, "biology");

    const results = el.querySelector('[data-testid="network-search-results"]')!;
    expect(results).not.toBeNull();
    const item = results.querySelector(
      `[data-testid="network-search-result"][data-result-id="${page.id}"]`,
    ) as HTMLElement;
    expect(item).not.toBeNull();
    expect(item.getAttribute("data-result-kind")).toBe("page");

    await act(async () => {
      item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(wb.snapshot().openSubjectPageId).toBe(page.id);
    // Selecting opened nothing durable beyond the one page we created.
    const d = wb.rawData();
    expect(d.pages.length).toBe(1);
    expect(d.relationships.length).toBe(0);
    expect(d.categories.length).toBe(0);
  });

  it("selecting a page result in the Nodes view also sets the focus target", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const page = await wb.createSubjectPage("Market Dynamics");
    wb.setViewMode("nodes");
    const el = await mount(wb);

    await type(el, "market");
    const item = el.querySelector(
      `[data-testid="network-search-result"][data-result-id="${page.id}"]`,
    ) as HTMLElement;
    await act(async () => {
      item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(wb.focusedPageId()).toBe(page.id);
  });

  it("selecting a category result sets the category scope", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const cat = await wb.createCategory("Ecology", "#4b5578");
    const el = await mount(wb);

    await type(el, "ecolo");
    const item = el.querySelector(
      `[data-testid="network-search-result"][data-result-id="${cat.id}"]`,
    ) as HTMLElement;
    expect(item.getAttribute("data-result-kind")).toBe("category");
    await act(async () => {
      item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(wb.categoryScope()).toBe("Ecology");
  });

  it("selecting an annotation result opens its source in the Reader", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const src = await wb.importSource({
      title: "Paper",
      bytes: new Uint8Array([1, 2, 3, 4]),
      versionHash: "v1",
      pageCount: 2,
    });
    wb.openSource(src.id);
    const view = await wb.commitTextAnnotation({
      sourceId: src.id,
      anchor: {
        docId: src.id,
        sourceVersionHash: "v1",
        pageIndex: 0,
        rects: [],
        selectedText: "memorable phrase",
        prefix: "",
        suffix: "",
      },
    });
    wb.closeWorkspace();
    expect(wb.snapshot().openSourceIds).toEqual([]);

    const el = await mount(wb);
    await type(el, "memorable phrase");
    const item = el.querySelector(
      `[data-testid="network-search-result"][data-result-id="${view.annotation.id}"]`,
    ) as HTMLElement;
    expect(item.getAttribute("data-result-kind")).toBe("annotation");
    await act(async () => {
      item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(wb.snapshot().openSourceIds).toEqual([src.id]);
  });

  it("matches composed body text and restricts page hits to the active category scope", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const inScope = await wb.createSubjectPage("Note One");
    const outScope = await wb.createSubjectPage("Note Two");
    await wb.saveSubjectDoc(inScope.id, docWithText("shared keyword alpha"));
    await wb.saveSubjectDoc(outScope.id, docWithText("shared keyword beta"));
    await wb.createCategory("Scope", "#4b5578", [inScope.id]);

    const el = await mount(wb, "Scope");
    await type(el, "shared keyword");

    const pageItems = Array.from(
      el.querySelectorAll('[data-testid="network-search-result"][data-result-kind="page"]'),
    ).map((n) => n.getAttribute("data-result-id"));
    expect(pageItems).toContain(inScope.id);
    expect(pageItems).not.toContain(outScope.id);
  });
});
