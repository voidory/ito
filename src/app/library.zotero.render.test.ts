/**
 * jsdom render coverage for the §2.3 "Import Zotero" Library UI. It mounts the
 * REAL Library against a REAL Workbench (in-memory storage, nothing mocked) and
 * asserts:
 *  - import-zotero-btn is visible in the Library header and opens the modal;
 *  - submitting raw Zotero JSON calls wb.importZoteroBundle and reports a
 *    summary while the source is actually added to the brain.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { Workbench } from "./workbench";
import { Library } from "./Library";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function mount(wb: Workbench, onImported: () => void): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      createElement(Library, {
        wb,
        onOpen: () => undefined,
        onOpenTogether: () => undefined,
        onImported,
      }),
    );
  });
  return container;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe("Library — Import Zotero button + modal (§2.3)", () => {
  it("renders a visible Import Zotero button in the header", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const el = await mount(wb, () => undefined);
    const btn = el.querySelector('[data-testid="import-zotero-btn"]');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe("Import Zotero");
    // The modal is not open until the button is clicked.
    expect(el.querySelector('[data-testid="import-zotero-modal"]')).toBeNull();
  });

  it("opens the modal and submitting raw JSON calls importZoteroBundle", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    let imported = 0;
    const el = await mount(wb, () => {
      imported += 1;
    });

    await click(el.querySelector('[data-testid="import-zotero-btn"]')!);
    const modal = el.querySelector('[data-testid="import-zotero-modal"]');
    expect(modal).not.toBeNull();

    const input = el.querySelector('[data-testid="zotero-json-input"]') as HTMLTextAreaElement;
    const raw = JSON.stringify({ items: [{ key: "ITEM1", title: "Imported Paper" }] });
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(input, raw);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await click(el.querySelector('[data-testid="zotero-import-submit"]')!);
    // Let the async import settle.
    await act(async () => {
      await Promise.resolve();
    });

    expect(imported).toBeGreaterThan(0);
    expect(el.querySelector('[data-testid="zotero-import-summary"]')).not.toBeNull();
    // The engine actually added the source.
    expect(wb.rawData().sources.some((s) => s.title === "Imported Paper")).toBe(true);
  });
});
