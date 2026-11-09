/**
 * jsdom render coverage for the M9 (FEAT-002 2) left reader sidebar. The live
 * pdf.js thumbnail + outline loading is browser-only, so this targets the
 * DOM-pure contract with a null document:
 *
 *  - Thumbnails tab renders one page-thumbnail per page with the current page
 *    outlined (data-current) and a page-number jump callback.
 *  - The Outline tab is HIDDEN when the document carries no outline.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LeftSidebar } from "./LeftSidebar";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function render(node: ReturnType<typeof createElement>): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
  return container;
}

describe("LeftSidebar — thumbnails + outline chrome", () => {
  it("renders one thumbnail per page with the current page outlined", async () => {
    const el = await render(
      createElement(LeftSidebar, {
        doc: null,
        pageCount: 5,
        currentPage: 3,
        onJump: () => undefined,
      }),
    );
    const thumbs = el.querySelectorAll('[data-testid="page-thumbnail"]');
    expect(thumbs).toHaveLength(5);
    const current = Array.from(thumbs).filter(
      (t) => t.getAttribute("data-current") === "true",
    );
    expect(current).toHaveLength(1);
    expect(current[0]!.getAttribute("data-page-number")).toBe("3");
  });

  it("hides the Outline tab when there is no outline (null doc)", async () => {
    const el = await render(
      createElement(LeftSidebar, {
        doc: null,
        pageCount: 2,
        currentPage: 1,
        onJump: () => undefined,
      }),
    );
    expect(el.querySelector('[data-testid="left-tab-thumbnails"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="left-tab-outline"]')).toBeNull();
    expect(el.querySelector('[data-testid="thumbnail-strip"]')).not.toBeNull();
  });

  it("clicking a thumbnail jumps to that page", async () => {
    const jumps: number[] = [];
    const el = await render(
      createElement(LeftSidebar, {
        doc: null,
        pageCount: 3,
        currentPage: 1,
        onJump: (n: number) => jumps.push(n),
      }),
    );
    const second = el.querySelector(
      '[data-testid="page-thumbnail"][data-page-number="2"]',
    ) as HTMLButtonElement;
    await act(async () => {
      second.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(jumps).toEqual([2]);
  });
});
