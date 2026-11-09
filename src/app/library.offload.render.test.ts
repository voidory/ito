/**
 * jsdom render coverage for the Library "Offload PDF Binary" control + binary
 * availability badge (M3, A17). It mounts the REAL Library against a REAL
 * Workbench (in-memory storage, nothing mocked) and asserts:
 *  - the source-binary-status badge reflects wb.sourceBinaryStatus ('cached');
 *  - clicking offload-pdf-binary transitions the badge to 'binary-offloaded'
 *    while the library row (the Source) remains present.
 *
 * The sandbox cannot run Playwright Chromium, so this proves the DOM contract
 * headlessly in jsdom.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { Workbench } from "./workbench";
import { Library } from "./Library";
import { sha256Hex } from "../storage";
import type { SourceId } from "../model";

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
        categoryScope: null,
        onScopeChange: () => undefined,
        onOpen: () => undefined,
        onOpenTogether: () => undefined,
      }),
    );
  });
  return container;
}

async function seedSource(wb: Workbench): Promise<SourceId> {
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3]); // %PDF-...
  const source = await wb.importSource({
    title: "Offloadable Paper",
    bytes,
    versionHash: await sha256Hex(bytes),
    pageCount: 2,
    category: "Papers",
  });
  return source.id;
}

describe("Library — offload PDF binary + availability badge (A17)", () => {
  it("renders a 'cached' badge for a source whose binary is present", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const id = await seedSource(wb);
    const el = await mount(wb);

    const badge = el.querySelector(
      `[data-testid="source-binary-status"][data-source-id="${id}"]`,
    )!;
    expect(badge).not.toBeNull();
    expect(badge.getAttribute("data-status")).toBe("cached");
    expect(badge.textContent).toBe("cached");
    expect(el.querySelector('[data-testid="offload-pdf-binary"]')).not.toBeNull();
  });

  it("clicking offload flips the badge to 'binary-offloaded' while the row survives", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const id = await seedSource(wb);
    const el = await mount(wb);

    const button = el.querySelector(
      `[data-testid="offload-pdf-binary"][data-source-id="${id}"]`,
    ) as HTMLButtonElement;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // Allow the async offload + state update to settle.
    await act(async () => {
      await Promise.resolve();
    });

    const badge = el.querySelector(
      `[data-testid="source-binary-status"][data-source-id="${id}"]`,
    )!;
    expect(badge.getAttribute("data-status")).toBe("binary-offloaded");
    expect(badge.textContent).toBe("binary-offloaded");

    // The workbench agrees, and the Source record + library row both survive.
    expect(wb.sourceBinaryStatus(id)).toBe("binary-offloaded");
    expect(wb.rawData().sources.some((s) => s.id === id)).toBe(true);
    expect(
      el.querySelector(`[data-testid="library-item"][data-source-id="${id}"]`),
    ).not.toBeNull();
  });
});
