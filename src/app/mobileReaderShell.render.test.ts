/**
 * jsdom render coverage for the M4/M5 MobileReaderSheet (§16.1, A21). It mounts
 * the REAL shell against a REAL Workbench (in-memory storage, nothing mocked)
 * and asserts the A21 phone-reading contract:
 *  - the shell renders with its data-testid;
 *  - mobile-inspect-writing opens the related-writing bottom sheet showing the
 *    linked Subject Page prose;
 *  - mobile-return-to-reading closes the sheet and PRESERVES the reader's scroll
 *    position and zoom scale (the reader body is not remounted);
 *  - the offline cache controls reflect wb.sourceBinaryStatus and offloading
 *    flips the badge.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { sha256Hex } from "../storage";
import { Workbench } from "./workbench";
import { MobileReaderSheet } from "./MobileReaderSheet";
import type { Source, SourceId, TextAnchor } from "../model";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 10, 9, 8, 7]);

function textAnchor(sourceId: SourceId, versionHash: string, text: string): TextAnchor {
  return {
    docId: sourceId,
    sourceVersionHash: versionHash,
    pageIndex: 1,
    rects: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.02 }],
    selectedText: text,
    prefix: "before ",
    suffix: " after",
  };
}

async function importHashed(wb: Workbench): Promise<Source> {
  const versionHash = await sha256Hex(PDF_BYTES);
  return wb.importSource({
    title: "Phone Doc",
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
});

async function mount(wb: Workbench, sourceId: SourceId): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const rerender = async () =>
    act(async () => {
      root!.render(
        createElement(MobileReaderSheet, {
          wb,
          sourceId,
          onBackToLibrary: () => undefined,
          onChange: () => void rerender(),
        }),
      );
    });
  await act(async () => {
    root!.render(
      createElement(MobileReaderSheet, {
        wb,
        sourceId,
        onBackToLibrary: () => undefined,
        onChange: () => void rerender(),
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

/** Seed a source + a cited annotation into a subject page (A21 target). */
async function seedCitedAnnotation(wb: Workbench): Promise<{ sourceId: SourceId }> {
  const src = await importHashed(wb);
  const a = await wb.commitTextAnnotation({
    sourceId: src.id,
    anchor: textAnchor(src.id, src.versionHash, "quote me"),
  });
  const page = await wb.createSubjectPage("Linked Subject");
  await wb.saveSubjectDoc(page.id, {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "The linked prose body." }] }],
  } as never);
  await wb.insertEvidenceIntoPage(a.annotation.id, page.id, { pos: null });
  return { sourceId: src.id };
}

describe("MobileReaderSheet — phone reading flow (A21)", () => {
  it("renders the mobile reader shell with the offline cache controls", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const { sourceId } = await seedCitedAnnotation(wb);
    const el = await mount(wb, sourceId);

    expect(el.querySelector('[data-testid="mobile-reader-shell"]')).not.toBeNull();
    const status = el.querySelector('[data-testid="source-binary-status"]')!;
    expect(status.getAttribute("data-status")).toBe("cached");
    expect(el.querySelector('[data-testid="offload-pdf-binary"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="attach-pdf-binary"]')).not.toBeNull();
  });

  it("inspect-writing opens the related-writing sheet; return-to-reading closes it and preserves scroll + zoom", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const { sourceId } = await seedCitedAnnotation(wb);
    const el = await mount(wb, sourceId);

    // Bump the zoom so we can assert it is preserved across the sheet round-trip.
    await click(el.querySelector('[data-testid="mobile-zoom-in"]')!);
    const zoomBefore = el.querySelector('[data-testid="mobile-zoom-scale"]')!.textContent;
    expect(zoomBefore).toBe("1.1×");

    // Simulate a reader scroll position before opening the sheet.
    const body = el.querySelector('[data-testid="mobile-reader-body"]') as HTMLElement;
    Object.defineProperty(body, "scrollTop", { value: 240, writable: true, configurable: true });

    // Open the related-writing bottom sheet.
    await click(el.querySelector('[data-testid="mobile-inspect-writing"]')!);
    const sheet = el.querySelector('[data-testid="mobile-related-writing-sheet"]');
    expect(sheet).not.toBeNull();
    expect(el.querySelector('[data-testid="related-writing-prose"]')!.textContent).toContain(
      "The linked prose body.",
    );

    // Close it: the sheet is gone, zoom is preserved, scroll is restored.
    await click(el.querySelector('[data-testid="mobile-return-to-reading"]')!);
    expect(el.querySelector('[data-testid="mobile-related-writing-sheet"]')).toBeNull();
    expect(el.querySelector('[data-testid="mobile-zoom-scale"]')!.textContent).toBe("1.1×");
    const bodyAfter = el.querySelector('[data-testid="mobile-reader-body"]') as HTMLElement;
    expect(bodyAfter.scrollTop).toBe(240);
  });

  it("offloading the PDF binary flips the source-binary-status badge", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const { sourceId } = await seedCitedAnnotation(wb);
    const el = await mount(wb, sourceId);

    await click(el.querySelector('[data-testid="offload-pdf-binary"]')!);

    expect(wb.sourceBinaryStatus(sourceId)).toBe("binary-offloaded");
    expect(
      el.querySelector('[data-testid="source-binary-status"]')!.getAttribute("data-status"),
    ).toBe("binary-offloaded");
  });
});
