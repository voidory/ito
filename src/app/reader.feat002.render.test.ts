/**
 * FEAT-002 jsdom render coverage for the definitive Reader UX overhaul. The
 * full SourcePane renders live pdf.js (browser-only), so this targets the
 * extracted, DOM-pure pieces against a REAL Workbench (in-memory storage):
 *
 *  - clampFixedAnchor / anchorRectFrom: the exact 2.1 clamp formulas + the
 *    jsdom zero-width getBoundingClientRect pointer fallback.
 *  - SelectionToolbar: position:fixed + clamped viewport coordinates near the
 *    anchor rect (2.1).
 *  - HighlightEditPopover: position:fixed, embeds comment-surface + save, color
 *    swatches, highlight/underline toggle, associate/insert, show-in-nodes, and
 *    both delete options; renders area-figure-preview for an area annotation
 *    (2.2a / 2.4c).
 *  - ReaderContextMenu: annotation variant and page variant items (2.2b).
 *  - LiveSelectionPreview: renders a pill per selection rect (2.3a).
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { sha256Hex } from "../storage";
import { Workbench } from "./workbench";
import {
  anchorRectFrom,
  clampFixedAnchor,
  clampZoom,
  HighlightEditPopover,
  LiveSelectionPreview,
  ReaderContextMenu,
  SelectionToolbar,
  serializedRerender,
  type AnchorRect,
  type ContextMenuState,
  type EditPopoverState,
  type ToolbarState,
} from "./Reader";
import type { Source, SourceId, TextAnchor } from "../model";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 10, 9, 8, 7]);

function textAnchor(sourceId: SourceId, versionHash: string, text: string): TextAnchor {
  return {
    docId: sourceId,
    sourceVersionHash: versionHash,
    pageIndex: 0,
    rects: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.02 }],
    selectedText: text,
    prefix: "before ",
    suffix: " after",
  };
}

async function importHashed(wb: Workbench): Promise<Source> {
  const versionHash = await sha256Hex(PDF_BYTES);
  return wb.importSource({
    title: "Hashed Doc",
    bytes: PDF_BYTES,
    versionHash,
    pageCount: 3,
    category: "Papers",
  });
}

let container: HTMLElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  // Remove any portaled fixed layers left on the body.
  document.querySelectorAll('[data-testid="reader-fixed-layer"]').forEach((el) => el.remove());
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

/** Query the whole document (portaled surfaces land on document.body). */
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

describe("FEAT-002 2.1 clamp + anchor helpers", () => {
  it("clampFixedAnchor centres over the anchor and clamps 12px from each edge", () => {
    // A wide viewport so the centred position is not clamped.
    (window as unknown as { innerWidth: number }).innerWidth = 1000;
    const rect: AnchorRect = { left: 400, top: 200, right: 480, bottom: 220, width: 80 };
    const { left, top } = clampFixedAnchor(rect, 260);
    // anchorCenterX = 440; left = 440 - 130 = 310; top = 200 - 48 = 152.
    expect(left).toBe(310);
    expect(top).toBe(152);
  });

  it("clamps the left edge to >= 12 and drops below the anchor when near the top", () => {
    (window as unknown as { innerWidth: number }).innerWidth = 1000;
    const rect: AnchorRect = { left: 0, top: 10, right: 10, bottom: 30, width: 10 };
    const { left, top } = clampFixedAnchor(rect, 260);
    expect(left).toBe(12); // clamped to the 12px minimum
    expect(top).toBe(42); // anchorTop <= 64 -> anchorBottom + 12 = 30 + 12
  });

  it("anchorRectFrom falls back to the pointer when the DOMRect has zero width (jsdom)", () => {
    const zero = { left: 0, top: 0, right: 0, bottom: 0, width: 0 } as DOMRect;
    const rect = anchorRectFrom(zero, 150, 250);
    expect(rect.left).toBe(150);
    expect(rect.top).toBe(250);
    expect(rect.width).toBe(0);
  });
});

describe("FEAT-002 2.1 SelectionToolbar is fixed + clamped near the anchor", () => {
  it("renders position:fixed with clamped viewport coordinates", async () => {
    (window as unknown as { innerWidth: number }).innerWidth = 1000;
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const src = await importHashed(wb);
    const toolbar: ToolbarState = {
      sourceId: src.id,
      anchor: textAnchor(src.id, src.versionHash, "quote me"),
      rect: { left: 400, top: 200, right: 480, bottom: 220, width: 80 },
    };
    await render(
      createElement(SelectionToolbar, {
        toolbar,
        onCommit: () => undefined,
        onDismiss: () => undefined,
      }),
    );
    const el = q('[data-testid="selection-toolbar"]')!;
    expect(el).not.toBeNull();
    // M10: the toolbar now mounts the shared <Popover>, which portals onto the
    // fixed .ito-ui-popover-layer and positions the surface via clampFixedAnchor.
    expect(el.style.position).toBe("fixed");
    expect(el.className).toContain("ito-ui-popover");
    expect(el.className).toContain("ito-selection-toolbar");
    expect(q('[data-testid="ito-popover-layer"]')).not.toBeNull();
    // The z-index now comes from the --ito-z-popover token on .ito-ui-popover,
    // not an inline style, so it is no longer asserted inline.
    // anchorCenterX 440 - 130 = 310; top 200 - 48 = 152.
    expect(el.style.left).toBe("310px");
    expect(el.style.top).toBe("152px");
    // The compact highlight/underline/color controls are present.
    expect(q('[data-testid="commit-highlight"]')).not.toBeNull();
    expect(q('[data-testid="commit-underline"]')).not.toBeNull();
    expect(q('[data-testid="color-controls"]')).not.toBeNull();
    expect(q('[data-testid="dismiss-toolbar"]')).not.toBeNull();
  });
});

describe("FEAT-002 2.2a HighlightEditPopover (1-click edit)", () => {
  async function setup(): Promise<{ wb: Workbench; popover: EditPopoverState }> {
    (window as unknown as { innerWidth: number }).innerWidth = 1000;
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const src = await importHashed(wb);
    const a = await wb.commitTextAnnotation({
      sourceId: src.id,
      anchor: textAnchor(src.id, src.versionHash, "quote me"),
    });
    const popover: EditPopoverState = {
      annotationId: a.annotation.id,
      sourceId: src.id,
      rect: { left: 300, top: 300, right: 300, bottom: 300, width: 0 },
    };
    return { wb, popover };
  }

  it("is fixed and exposes comment+save, colors, style toggle, associate/insert, show-in-nodes, and both deletes", async () => {
    const { wb, popover } = await setup();
    await render(
      createElement(HighlightEditPopover, {
        wb,
        popover,
        onClose: () => undefined,
        bump: () => undefined,
      }),
    );
    const el = q('[data-testid="highlight-edit-popover"]')!;
    // M10: the edit popover now mounts the shared <Popover> and is clamped over
    // its anchor (centre 300, width 300 -> left 150; top 300 - 48 = 252).
    expect(el.style.position).toBe("fixed");
    expect(el.className).toContain("ito-ui-popover");
    expect(el.className).toContain("ito-annot-popover");
    expect(el.style.left).toBe("150px");
    expect(el.style.top).toBe("252px");
    expect(q('[data-testid="ito-popover-layer"]')).not.toBeNull();
    expect(q('[data-testid="comment-surface"]')).not.toBeNull();
    expect(q('[data-testid="comment-input"]')).not.toBeNull();
    expect(q('[data-testid="comment-save"]')).not.toBeNull();
    expect(q('[data-testid="color-yellow"]')).not.toBeNull();
    expect(q('[data-testid="toggle-style-kind"]')).not.toBeNull();
    expect(q('[data-testid="popover-associate-insert"]')).not.toBeNull();
    expect(q('[data-testid="delete-highlight-only"]')).not.toBeNull();
    expect(q('[data-testid="delete-highlight-and-quotes"]')).not.toBeNull();
  });

  it("delete-highlight-only removes the annotation", async () => {
    const { wb, popover } = await setup();
    await render(
      createElement(HighlightEditPopover, {
        wb,
        popover,
        onClose: () => undefined,
        bump: () => undefined,
      }),
    );
    await click(q('[data-testid="delete-highlight-only"]')!);
    expect(wb.rawData().annotations.some((x) => x.id === popover.annotationId)).toBe(false);
  });

  it("renders area-figure-preview for an area annotation carrying imageDataUrl (2.4c)", async () => {
    (window as unknown as { innerWidth: number }).innerWidth = 1000;
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const src = await importHashed(wb);
    const dataUrl = "data:image/png;base64,ABCD";
    const a = await wb.commitAreaAnnotation(
      src.id,
      0,
      { x: 0.1, y: 0.1, width: 0.3, height: 0.2 },
      undefined,
      dataUrl,
    );
    const popover: EditPopoverState = {
      annotationId: a.annotation.id,
      sourceId: src.id,
      rect: { left: 300, top: 300, right: 300, bottom: 300, width: 0 },
    };
    await render(
      createElement(HighlightEditPopover, {
        wb,
        popover,
        onClose: () => undefined,
        bump: () => undefined,
      }),
    );
    const img = q('[data-testid="area-figure-preview"]') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe(dataUrl);
  });
});

describe("FEAT-002 2.2b ReaderContextMenu", () => {
  it("annotation variant shows the specified items", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const src = await importHashed(wb);
    const a = await wb.commitTextAnnotation({
      sourceId: src.id,
      anchor: textAnchor(src.id, src.versionHash, "quote me"),
    });
    const menu: ContextMenuState = {
      variant: "annotation",
      annotationId: a.annotation.id,
      sourceId: src.id,
      x: 50,
      y: 60,
    };
    await render(
      createElement(ReaderContextMenu, {
        wb,
        menu,
        onClose: () => undefined,
        onEditComment: () => undefined,
        onPageAction: () => undefined,
        bump: () => undefined,
      }),
    );
    const el = q('[data-testid="reader-context-menu"]')!;
    expect(el.getAttribute("data-variant")).toBe("annotation");
    expect(el.style.position).toBe("fixed");
    expect(q('[data-testid="ctx-edit-comment"]')).not.toBeNull();
    expect(q('[data-testid="color-controls"]')).not.toBeNull();
    expect(q('[data-testid="ctx-associate"]')).not.toBeNull();
    expect(q('[data-testid="ctx-insert"]')).not.toBeNull();
    expect(q('[data-testid="delete-highlight-only"]')).not.toBeNull();
    expect(q('[data-testid="delete-highlight-and-quotes"]')).not.toBeNull();
  });

  it("page variant shows the page actions", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const src = await importHashed(wb);
    const menu: ContextMenuState = { variant: "page", sourceId: src.id, x: 50, y: 60 };
    await render(
      createElement(ReaderContextMenu, {
        wb,
        menu,
        onClose: () => undefined,
        onEditComment: () => undefined,
        onPageAction: () => undefined,
        bump: () => undefined,
      }),
    );
    const el = q('[data-testid="reader-context-menu"]')!;
    expect(el.getAttribute("data-variant")).toBe("page");
    expect(q('[data-testid="ctx-comment-range"]')).not.toBeNull();
    expect(q('[data-testid="ctx-select-area"]')).not.toBeNull();
    expect(q('[data-testid="ctx-switch-paper"]')).not.toBeNull();
    expect(q('[data-testid="ctx-toggle-lines"]')).not.toBeNull();
    expect(q('[data-testid="ctx-toggle-motion"]')).not.toBeNull();
  });

  it("page variant fires onPageAction for each item", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const src = await importHashed(wb);
    const menu: ContextMenuState = { variant: "page", sourceId: src.id, x: 50, y: 60 };
    const actions: string[] = [];
    await render(
      createElement(ReaderContextMenu, {
        wb,
        menu,
        onClose: () => undefined,
        onEditComment: () => undefined,
        onPageAction: (a) => actions.push(a),
        bump: () => undefined,
      }),
    );
    await click(q('[data-testid="ctx-select-area"]')!);
    expect(actions).toContain("area");
  });
});

describe("FEAT-002 2.4 commitAreaAnnotation persists imageDataUrl", () => {
  it("stores the figure crop data URL on the area anchor", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const src = await importHashed(wb);
    const dataUrl = "data:image/png;base64,ZZZZ";
    const view = await wb.commitAreaAnnotation(
      src.id,
      1,
      { x: 0.2, y: 0.2, width: 0.4, height: 0.3 },
      undefined,
      dataUrl,
    );
    const ann = wb.rawData().annotations.find((a) => a.id === view.annotation.id)!;
    expect(ann.scope.kind).toBe("area");
    if (ann.scope.kind === "area") {
      expect(ann.scope.anchor.imageDataUrl).toBe(dataUrl);
    }
  });

  it("omits imageDataUrl when none is provided (backward compatible)", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const src = await importHashed(wb);
    const view = await wb.commitAreaAnnotation(src.id, 0, { x: 0, y: 0, width: 0.5, height: 0.5 });
    const ann = wb.rawData().annotations.find((a) => a.id === view.annotation.id)!;
    if (ann.scope.kind === "area") {
      expect(ann.scope.anchor.imageDataUrl).toBeUndefined();
    }
  });
});

describe("FEAT-002 2.5 clampZoom steps between 50% and 300%", () => {
  it("clamps below 50% up to the 0.5 floor", () => {
    expect(clampZoom(0.4)).toBe(0.5);
    expect(clampZoom(0.5 - 0.1)).toBe(0.5);
  });

  it("clamps above 300% down to the 3.0 ceiling", () => {
    expect(clampZoom(3.5)).toBe(3);
    expect(clampZoom(3 + 0.1)).toBe(3);
  });

  it("steps cleanly without float drift", () => {
    expect(clampZoom(1 + 0.1)).toBe(1.1);
    expect(clampZoom(1 - 0.1)).toBe(0.9);
  });
});

describe("FEAT-002 2.5 serializedRerender guards overlapping page renders", () => {
  /**
   * A fake RenderedPage whose rerender resolves only when the test releases it,
   * so we can observe whether two renders ever overlap on the same canvas (the
   * pdf.js "same canvas during multiple render()" hazard the zoom + fit effects
   * both drive).
   */
  function makeFakePage() {
    const scales: number[] = [];
    let inFlight = 0;
    let maxConcurrent = 0;
    let resolveCurrent: (() => void) | null = null;
    const page = {
      rerender(scale: number): Promise<void> {
        scales.push(scale);
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        return new Promise<void>((resolve) => {
          resolveCurrent = () => {
            inFlight -= 1;
            resolveCurrent = null;
            resolve();
          };
        });
      },
    };
    return {
      page,
      scales,
      get maxConcurrent() {
        return maxConcurrent;
      },
      release(): Promise<void> {
        resolveCurrent?.();
        return Promise.resolve();
      },
    };
  }

  it("never runs two renders on the same page at once and applies the latest target", async () => {
    const fake = makeFakePage();
    const pageArg = fake.page as unknown as Parameters<typeof serializedRerender>[0];

    // Three rapid requests while the first render is still in flight.
    const p1 = serializedRerender(pageArg, 1.3);
    const p2 = serializedRerender(pageArg, 2.6);
    const p3 = serializedRerender(pageArg, 1.9);

    // Only the first render actually started; the others coalesced.
    expect(fake.scales).toEqual([1.3]);
    expect(fake.maxConcurrent).toBe(1);

    // Release the first render: the serializer should now run ONLY the latest
    // pending target (1.9), dropping the intermediate 2.6.
    await fake.release();
    await Promise.resolve();
    await fake.release();
    await Promise.all([p1, p2, p3]);

    expect(fake.scales).toEqual([1.3, 1.9]);
    expect(fake.maxConcurrent).toBe(1);
  });
});

describe("FEAT-002 2.3a LiveSelectionPreview", () => {
  it("renders one watercolor pill per selection rect", async () => {
    const rects: AnchorRect[] = [
      { left: 10, top: 20, right: 60, bottom: 32, width: 50 },
      { left: 10, top: 34, right: 90, bottom: 46, width: 80 },
    ];
    await render(
      createElement(LiveSelectionPreview, { preview: { color: "#ffdd57", rects } }),
    );
    const host = q('[data-testid="live-selection-preview"]')!;
    expect(host).not.toBeNull();
    const pills = host.querySelectorAll(".ito-selection-live-preview");
    expect(pills).toHaveLength(2);
    expect((pills[0] as HTMLElement).style.position).toBe("fixed");
  });
});
