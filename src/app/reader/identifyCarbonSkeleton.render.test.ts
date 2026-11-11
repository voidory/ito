/**
 * Production MVP — carbon-skeleton Identify control render test (Vitest/jsdom).
 *
 * Mirrors the M18 FEAT-004 Identify render pattern (REAL Workbench over
 * InMemoryStorageAdapter, createRoot/act, portal cleanup). It proves the small
 * UI integration of the deterministic carbon-skeleton MVP:
 *
 *  - the "Carbon skeleton" Identify button is present for an area annotation
 *    alongside the existing Equation/Molecule controls;
 *  - clicking it runs the deterministic recogniser on the stored crop and shows
 *    a result panel with a Dismiss control;
 *  - under jsdom (no usable canvas to decode the data URL) the capability fails
 *    EXPLICITLY — a clear failure state — rather than fabricating a graph, and
 *    it persists nothing to the annotation.
 *
 * NOTE: image DECODING needs a real DOM canvas 2D context, which jsdom lacks,
 * so this test exercises the UI + explicit-failure path only. The recogniser's
 * positive recognition of chains/rings/rotation/thickness is covered by the
 * deterministic algorithmic tests in
 * src/science/recognition/carbonSkeleton/recognizeCarbonSkeleton.mvp.test.ts.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InMemoryStorageAdapter } from "../../test/InMemoryStorageAdapter";
import { Workbench } from "../workbench";
import { HighlightEditPopover } from "./AnnotationOverlays";
import type { NormalizedRect, Source } from "../../model";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.innerHTML = "";
});

async function render(node: ReturnType<typeof createElement>): Promise<HTMLElement> {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
  return container;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

async function importOne(wb: Workbench, title: string): Promise<Source> {
  return wb.importSource({
    title,
    bytes: new Uint8Array([title.length, 2, 3, 4]),
    versionHash: "hash-" + title,
    pageCount: 2,
    category: "Papers",
  });
}

const RECT: NormalizedRect = { x: 0.1, y: 0.1, width: 0.4, height: 0.3 };
const CROP = "data:image/png;base64,AAAA";

function popoverProps(wb: Workbench, annotationId: string, sourceId: string) {
  return {
    wb,
    popover: {
      annotationId: annotationId as never,
      sourceId: sourceId as never,
      rect: { left: 100, top: 100, right: 300, bottom: 140, width: 200 },
    },
    onClose: () => undefined,
    bump: () => undefined,
  };
}

describe("Carbon-skeleton MVP — Identify control", () => {
  it("offers a 'Carbon skeleton' button next to Equation/Molecule for an area annotation", async () => {
    const storage = new InMemoryStorageAdapter();
    const wb = await Workbench.open(storage);
    const src = await importOne(wb, "Structures");
    const area = await wb.commitAreaAnnotation(src.id, 0, RECT, "", CROP);

    await render(
      createElement(HighlightEditPopover, popoverProps(wb, area.annotation.id, src.id)),
    );
    await flush();

    expect(
      document.querySelector('[data-testid="identify-carbon-skeleton-btn"]'),
    ).not.toBeNull();
    // Existing Identify controls remain intact.
    expect(document.querySelector('[data-testid="identify-equation-btn"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="identify-molecule-btn"]')).not.toBeNull();
  });

  it("clicking it fails EXPLICITLY (no canvas under jsdom) and persists nothing", async () => {
    const storage = new InMemoryStorageAdapter();
    const wb = await Workbench.open(storage);
    const src = await importOne(wb, "Structures");
    const area = await wb.commitAreaAnnotation(src.id, 0, RECT, "", CROP);

    await render(
      createElement(HighlightEditPopover, popoverProps(wb, area.annotation.id, src.id)),
    );
    await flush();

    await click(document.querySelector('[data-testid="identify-carbon-skeleton-btn"]')!);

    // A clear failure state is shown (not a fabricated success).
    const failure = document.querySelector('[data-testid="carbon-skeleton-failure"]');
    expect(failure).not.toBeNull();
    expect(document.querySelector('[data-testid="carbon-skeleton-success"]')).toBeNull();
    expect(failure!.textContent ?? "").toMatch(/could not reliably recognise/i);

    // Running recognition persisted nothing to the anchor.
    const stored = wb.rawData().annotations.find((a) => a.id === area.annotation.id)!;
    expect(stored.scope.kind).toBe("area");
    if (stored.scope.kind === "area") {
      expect(stored.scope.anchor.smiles).toBeUndefined();
      expect(stored.scope.anchor.latex).toBeUndefined();
    }

    // Dismiss clears the result panel.
    await click(document.querySelector('[data-testid="carbon-skeleton-dismiss-btn"]')!);
    expect(document.querySelector('[data-testid="carbon-skeleton-result"]')).toBeNull();
  });
});
