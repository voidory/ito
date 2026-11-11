/**
 * M19 regression — deleting an area annotation must immediately remove its
 * imperatively-rendered yellow overlay from the page DOM, not just the
 * persisted annotation record.
 *
 * Background: reader highlights are drawn into the page stage OUTSIDE React by
 * `drawAnnotation` (src/app/reader/overlayShared.ts → renderHighlightOverlay).
 * SourcePane's draw-on-change effect does NOT re-fire on an annotation delete
 * (its deps are [ready, redrawOverlays], neither of which changes), so before
 * the fix a deleted area's `.ito-highlight-area` box lingered until the next
 * scroll. The fix: HighlightEditPopover's delete handlers call an injected
 * `redrawOverlays` AFTER the Workbench delete resolves.
 *
 * This test wires a faithful copy of SourcePane.redrawOverlays (clear every
 * `.ito-highlight` from each page stage, then re-draw from the CURRENT
 * Workbench annotations) and drives the real HighlightEditPopover delete
 * buttons through the real async Workbench deletion API — asserting the overlay
 * DOM is gone, state is gone, and the popover closed.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InMemoryStorageAdapter } from "../../test/InMemoryStorageAdapter";
import { Workbench } from "../workbench";
import { HighlightEditPopover } from "./AnnotationOverlays";
import { drawAnnotation, cssEscapeId } from "./overlayShared";
import type { RenderedPage } from "../../pdf";
import type { NormalizedRect, Source } from "../../model";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | null = null;
let root: Root | null = null;
/** The page stage the overlays are drawn into (SourcePane's `.pdf-page-stage`). */
let stage: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  stage?.remove();
  root = null;
  container = null;
  stage = null;
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

/** Build the minimal RenderedPage shape drawAnnotation reads (container+stage). */
function makePage(pageIndex: number): { page: RenderedPage; stage: HTMLDivElement } {
  const containerEl = document.createElement("div");
  containerEl.className = "pdf-page";
  containerEl.dataset.pageIndex = String(pageIndex);
  const stageEl = document.createElement("div");
  stageEl.className = "pdf-page-stage";
  containerEl.appendChild(stageEl);
  document.body.appendChild(containerEl);
  // drawAnnotation only touches `.container.dataset.pageIndex` and `.stage`.
  const page = { container: containerEl, stage: stageEl } as unknown as RenderedPage;
  return { page, stage: stageEl };
}

const RECT: NormalizedRect = { x: 0.1, y: 0.1, width: 0.4, height: 0.3 };
const CROP = "data:image/png;base64,AAAA";

function popoverProps(
  wb: Workbench,
  annotationId: string,
  sourceId: string,
  redrawOverlays: () => void,
  onClose: () => void,
) {
  return {
    wb,
    popover: {
      annotationId: annotationId as never,
      sourceId: sourceId as never,
      rect: { left: 100, top: 100, right: 300, bottom: 140, width: 200 },
    },
    onClose,
    bump: () => undefined,
    redrawOverlays,
  };
}

/**
 * A faithful copy of SourcePane.redrawOverlays: clear every `.ito-highlight`
 * from each page stage, then re-draw from the CURRENT Workbench annotations.
 */
function makeRedrawOverlays(wb: Workbench, sourceId: string, pages: RenderedPage[]) {
  return () => {
    const views = wb.annotationsForSource(sourceId as never);
    for (const page of pages) {
      page.stage.querySelectorAll(".ito-highlight").forEach((el) => el.remove());
    }
    for (const view of views) {
      drawAnnotation(view, pages, true, false);
    }
  };
}

describe("M19 — area deletion clears the imperative yellow overlay", () => {
  for (const variant of ["delete-highlight-only", "delete-highlight-and-quotes"] as const) {
    it(`${variant} removes the annotation AND its .ito-highlight-area overlay from the DOM`, async () => {
      const storage = new InMemoryStorageAdapter();
      const wb = await Workbench.open(storage);
      const src = await importOne(wb, "Areas");
      const area = await wb.commitAreaAnnotation(src.id, 0, RECT, "", CROP);
      const annId = area.annotation.id;

      const { page, stage: s } = makePage(0);
      stage = s;
      const pages = [page];
      const redrawOverlays = makeRedrawOverlays(wb, src.id, pages);

      // Initial draw: the yellow area overlay exists in the page DOM.
      redrawOverlays();
      const sel = `.ito-highlight[data-annotation-id="${cssEscapeId(annId)}"]`;
      expect(stage.querySelector(sel)).not.toBeNull();
      expect(stage.querySelector(`${sel}[data-area="true"]`)).not.toBeNull();
      expect(stage.querySelector(".ito-highlight-area")).not.toBeNull();

      // Open the popover and delete via the real foot button.
      let closed = false;
      await render(
        createElement(
          HighlightEditPopover,
          popoverProps(wb, annId, src.id, redrawOverlays, () => {
            closed = true;
          }),
        ),
      );
      await flush();
      await click(document.querySelector(`[data-testid="${variant}"]`)!);

      // 1. Annotation removed from Workbench state.
      expect(wb.rawData().annotations.find((a) => a.id === annId)).toBeUndefined();
      expect(wb.viewFor(annId as never)).toBeNull();

      // 2. The popover closed.
      expect(closed).toBe(true);

      // 3. The yellow overlay is gone from the page DOM — no stale box, label,
      //    or area container remains.
      expect(stage.querySelector(sel)).toBeNull();
      expect(stage.querySelector('.ito-highlight[data-area="true"]')).toBeNull();
      expect(stage.querySelector(".ito-highlight-area")).toBeNull();
      expect(stage.querySelector(".ito-highlight-area-label")).toBeNull();
      // 4. No stale highlight element of any kind lingers.
      expect(stage.querySelectorAll(".ito-highlight").length).toBe(0);
    });
  }
});
