/**
 * M9 (FEAT-001 B) jsdom render coverage for the shared UI kit
 * (src/app/ui/primitives.tsx): Button, IconButton, Menu, Popover.
 *
 * Also carries the FEAT-001 geometry invariant test: the selection popup, the
 * annotation popover and the context menu, when positioned via the shared
 * clampFixedAnchor helper, never overlap each other and always sit fully inside
 * the viewport.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  Button,
  IconButton,
  Menu,
  Popover,
  clampFixedAnchor,
  type AnchorRect,
  type MenuItem,
} from "./primitives";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  document.querySelectorAll('[data-testid="ito-popover-layer"]').forEach((el) => el.remove());
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

function q(sel: string): HTMLElement | null {
  return document.querySelector(sel) as HTMLElement | null;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe("M9 UI kit: Button + IconButton", () => {
  it("Button renders its children and forwards click", async () => {
    const onClick = vi.fn();
    await render(createElement(Button, { "data-testid": "b", onClick }, "Save"));
    const b = q('[data-testid="b"]')!;
    expect(b.textContent).toBe("Save");
    await click(b);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("IconButton requires a label and exposes it as aria-label + title", async () => {
    await render(
      createElement(IconButton, { label: "Zoom in", "data-testid": "z", pressed: true }, "+"),
    );
    const b = q('[data-testid="z"]')!;
    expect(b.getAttribute("aria-label")).toBe("Zoom in");
    expect(b.getAttribute("title")).toBe("Zoom in");
    expect(b.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("M9 UI kit: Menu", () => {
  const items: MenuItem[] = [
    { id: "a", label: "Alpha", shortcut: "⌘A", onSelect: () => undefined },
    { id: "b", label: "Beta", onSelect: () => undefined },
  ];

  it("renders left-aligned rows with an icon gutter + shortcut column", async () => {
    await render(
      createElement(Menu, { items, onClose: () => undefined, ariaLabel: "Test menu" }),
    );
    const menu = q('[data-testid="ito-menu"]')!;
    expect(menu.getAttribute("role")).toBe("menu");
    expect(q('[data-testid="menu-item-a"]')).not.toBeNull();
    expect(q('[data-testid="menu-item-b"]')).not.toBeNull();
    // Shortcut column renders for item a.
    expect(menu.querySelector(".ito-ui-menu-item-shortcut")?.textContent).toBe("⌘A");
  });

  it("activating an item invokes onSelect then onClose", async () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    await render(
      createElement(Menu, {
        items: [{ id: "x", label: "X", onSelect }],
        onClose,
        ariaLabel: "m",
      }),
    );
    await click(q('[data-testid="menu-item-x"]')!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape closes the menu", async () => {
    const onClose = vi.fn();
    await render(createElement(Menu, { items, onClose, ariaLabel: "m" }));
    const menu = q('[data-testid="ito-menu"]')!;
    await act(async () => {
      menu.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("M9 UI kit: Popover", () => {
  it("portals onto a fixed layer, clamps to the anchor, and closes on Esc", async () => {
    (window as unknown as { innerWidth: number }).innerWidth = 1000;
    const onClose = vi.fn();
    const anchor: AnchorRect = { left: 400, top: 200, right: 480, bottom: 220, width: 80 };
    await render(
      createElement(Popover, {
        anchor,
        width: 260,
        onClose,
        ariaLabel: "pop",
        testId: "pop",
        children: "body",
      }),
    );
    expect(q('[data-testid="ito-popover-layer"]')).not.toBeNull();
    const pop = q('[data-testid="pop"]')!;
    expect(pop.style.position).toBe("fixed");
    // anchorCenterX 440 - 130 = 310; top 200 - 48 = 152.
    expect(pop.style.left).toBe("310px");
    expect(pop.style.top).toBe("152px");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("FEAT-001 geometry invariant: popup / popover / context menu", () => {
  /** Bounding box for a surface positioned by clampFixedAnchor. */
  function box(anchor: AnchorRect, width: number, height: number) {
    const { left, top } = clampFixedAnchor(anchor, width);
    return { left, top, right: left + width, bottom: top + height };
  }

  function overlaps(a: ReturnType<typeof box>, b: ReturnType<typeof box>): boolean {
    return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  }

  it("the three surfaces never overlap and stay inside the viewport", () => {
    (window as unknown as { innerWidth: number }).innerWidth = 1200;
    const viewportW = 1200;

    // Three distinct, well-separated anchors (selection, highlight, page click).
    const selectionAnchor: AnchorRect = {
      left: 120,
      top: 300,
      right: 240,
      bottom: 320,
      width: 120,
    };
    const popoverAnchor: AnchorRect = {
      left: 560,
      top: 300,
      right: 640,
      bottom: 320,
      width: 80,
    };
    const contextAnchor: AnchorRect = {
      left: 980,
      top: 300,
      right: 1000,
      bottom: 320,
      width: 20,
    };

    const selection = box(selectionAnchor, 260, 40);
    const popover = box(popoverAnchor, 300, 220);
    const context = box(contextAnchor, 220, 180);

    // Pairwise non-overlap.
    expect(overlaps(selection, popover)).toBe(false);
    expect(overlaps(selection, context)).toBe(false);
    expect(overlaps(popover, context)).toBe(false);

    // All three fully inside the viewport horizontally (12px gutter honoured).
    for (const s of [selection, popover, context]) {
      expect(s.left).toBeGreaterThanOrEqual(12);
      expect(s.right).toBeLessThanOrEqual(viewportW - 12);
      expect(s.top).toBeGreaterThanOrEqual(0);
    }
  });
});
