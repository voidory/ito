/**
 * jsdom render coverage for the Reader M3 surfaces (A17/D02). The full Reader
 * renders live pdf.js (browser-only), so this targets the two M3 pieces in
 * isolation against a REAL Workbench (in-memory storage, nothing mocked):
 *
 *  - AssociationMenu exposes the two-mode deletion controls
 *    (delete-highlight-only / delete-highlight-and-quotes) and each invokes the
 *    matching Workbench method (D02).
 *  - BinaryOffloadedPopover renders data-return-resolution='binary-offloaded'
 *    with the stored quote/comment/page/title and an attach-pdf-binary control
 *    that re-hydrates the source via sha256-verified attach (A17).
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { sha256Hex } from "../storage";
import { Workbench } from "./workbench";
import {
  AssociationMenu,
  BinaryOffloadedPopover,
  type MenuState,
  type OffloadedPopover,
} from "./Reader";
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
    title: "Hashed Doc",
    bytes: PDF_BYTES,
    versionHash,
    pageCount: 3,
    category: "Papers",
  });
}

/**
 * jsdom's File does not implement `arrayBuffer()`, so build a File and attach a
 * working async `arrayBuffer` that returns the exact bytes (the component reads
 * them via `await file.arrayBuffer()`).
 */
function fileWithBytes(bytes: Uint8Array, name: string): File {
  const file = new File([], name, { type: "application/pdf" });
  const copy = new Uint8Array(bytes);
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => copy.buffer.slice(0, copy.byteLength),
    configurable: true,
  });
  return file;
}

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

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

/**
 * Deterministically settle an async handler whose completion we can only
 * observe indirectly (the attach flow is fired via `void onFile(...)` on a
 * change event, so there is no promise to await). The attach chain is
 * genuinely async — `await file.arrayBuffer()` then `sha256Hex`
 * (crypto.subtle.digest) then `attachSourceBinary` — and is not guaranteed to
 * settle within any fixed number of microtask ticks. Instead of guessing a
 * tick count, poll `predicate` (re-draining the microtask queue inside `act`
 * each iteration) until it holds or a short timeout elapses. Flushing stays
 * inside `act` so React state updates are applied before each check.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    await act(async () => {
      await Promise.resolve();
      ok = predicate();
    });
    if (ok) return;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Reader M3 — two-mode deletion menu (D02)", () => {
  it("renders both delete controls in the association menu", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const src = await importHashed(wb);
    const a = await wb.commitTextAnnotation({
      sourceId: src.id,
      anchor: textAnchor(src.id, src.versionHash, "quote me"),
    });
    const menu: MenuState = { annotationId: a.annotation.id, sourceId: src.id, x: 0, y: 0 };
    const el = await render(
      createElement(AssociationMenu, { wb, menu, onClose: () => undefined, bump: () => undefined }),
    );

    expect(el.querySelector('[data-testid="delete-highlight-only"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="delete-highlight-and-quotes"]')).not.toBeNull();
  });

  it("delete-highlight-only removes the annotation but keeps its cited quote", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const src = await importHashed(wb);
    const a = await wb.commitTextAnnotation({
      sourceId: src.id,
      anchor: textAnchor(src.id, src.versionHash, "quote me"),
    });
    const page = await wb.createSubjectPage("Subject");
    const evidence = await wb.insertEvidenceIntoPage(a.annotation.id, page.id, { pos: null });

    const menu: MenuState = { annotationId: a.annotation.id, sourceId: src.id, x: 0, y: 0 };
    const el = await render(
      createElement(AssociationMenu, { wb, menu, onClose: () => undefined, bump: () => undefined }),
    );
    await click(el.querySelector('[data-testid="delete-highlight-only"]')!);

    // Annotation gone; the EvidenceInstance (the quote) is preserved.
    expect(wb.rawData().annotations.some((x) => x.id === a.annotation.id)).toBe(false);
    expect(wb.rawData().evidenceInstances.some((e) => e.id === evidence.id)).toBe(true);
  });

  it("delete-highlight-and-quotes removes the annotation AND its quote", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const src = await importHashed(wb);
    const a = await wb.commitTextAnnotation({
      sourceId: src.id,
      anchor: textAnchor(src.id, src.versionHash, "quote me"),
    });
    const page = await wb.createSubjectPage("Subject");
    const evidence = await wb.insertEvidenceIntoPage(a.annotation.id, page.id, { pos: null });

    const menu: MenuState = { annotationId: a.annotation.id, sourceId: src.id, x: 0, y: 0 };
    const el = await render(
      createElement(AssociationMenu, { wb, menu, onClose: () => undefined, bump: () => undefined }),
    );
    await click(el.querySelector('[data-testid="delete-highlight-and-quotes"]')!);

    expect(wb.rawData().annotations.some((x) => x.id === a.annotation.id)).toBe(false);
    expect(wb.rawData().evidenceInstances.some((e) => e.id === evidence.id)).toBe(false);
    // A pre-mutation revision snapshot was recorded so the removal is reviewable.
    expect(wb.rawData().revisions.length).toBeGreaterThan(0);
  });
});

describe("Reader M3 — binary-offloaded popover + attach (A17)", () => {
  function popoverFor(sourceId: SourceId): OffloadedPopover {
    return {
      evidenceId: "ev-1",
      sourceId,
      sourceTitle: "Hashed Doc",
      quotedText: "a captured passage",
      comment: "my note",
      pageNumber: 2,
      reason: "the PDF binary was offloaded locally; re-attach it to view the page",
    };
  }

  it("renders the popover with data-return-resolution='binary-offloaded' and the stored citation", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const src = await importHashed(wb);
    await wb.offloadSourceBinary(src.id);

    const el = await render(
      createElement(BinaryOffloadedPopover, {
        wb,
        popover: popoverFor(src.id),
        onClose: () => undefined,
        onAttached: () => undefined,
      }),
    );

    const pop = el.querySelector('[data-testid="binary-offloaded-popover"]')!;
    expect(pop.getAttribute("data-return-resolution")).toBe("binary-offloaded");
    expect(el.querySelector('[data-testid="offloaded-source-title"]')!.textContent).toBe("Hashed Doc");
    expect(el.querySelector('[data-testid="offloaded-quote"]')!.textContent).toContain(
      "a captured passage",
    );
    expect(el.querySelector('[data-testid="offloaded-comment"]')!.textContent).toContain("my note");
    expect(el.querySelector('[data-testid="offloaded-page"]')!.textContent).toContain("Page 2");
    expect(el.querySelector('[data-testid="attach-pdf-binary"]')).not.toBeNull();
  });

  it("attaching matching bytes re-hydrates the source back to cached", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const src = await importHashed(wb);
    await wb.offloadSourceBinary(src.id);
    expect(wb.sourceBinaryStatus(src.id)).toBe("binary-offloaded");

    let attached = false;
    const el = await render(
      createElement(BinaryOffloadedPopover, {
        wb,
        popover: popoverFor(src.id),
        onClose: () => undefined,
        onAttached: () => {
          attached = true;
        },
      }),
    );

    const input = el.querySelector('[data-testid="attach-pdf-input"]') as HTMLInputElement;
    const file = fileWithBytes(PDF_BYTES, "doc.pdf");
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() => attached && wb.sourceBinaryStatus(src.id) === "cached");

    expect(attached).toBe(true);
    expect(wb.sourceBinaryStatus(src.id)).toBe("cached");
  });

  it("attaching mismatching bytes is rejected with an inline reason and writes nothing", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const src = await importHashed(wb);
    await wb.offloadSourceBinary(src.id);

    const el = await render(
      createElement(BinaryOffloadedPopover, {
        wb,
        popover: popoverFor(src.id),
        onClose: () => undefined,
        onAttached: () => undefined,
      }),
    );

    const input = el.querySelector('[data-testid="attach-pdf-input"]') as HTMLInputElement;
    const wrong = fileWithBytes(new Uint8Array([0x25, 0x50, 0x44, 0x46, 9, 9, 9]), "wrong.pdf");
    Object.defineProperty(input, "files", { value: [wrong], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() => el.querySelector('[data-testid="attach-pdf-error"]') !== null);

    expect(el.querySelector('[data-testid="attach-pdf-error"]')).not.toBeNull();
    expect(wb.sourceBinaryStatus(src.id)).toBe("binary-offloaded");
  });
});
