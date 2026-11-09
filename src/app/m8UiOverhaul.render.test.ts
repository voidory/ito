/**
 * jsdom render coverage for the m8 data-integrity + import UX surfaces, driven
 * against a REAL Workbench (in-memory storage, nothing mocked):
 *
 *  - Library "+ Import PDF" button + hidden input import a PDF (sha256
 *    versionHash + numPages fallback 1) via wb.importSource;
 *  - the library-pdf-dropzone handles onDrop without navigating and imports;
 *  - the Subjects launcher lists existing subject pages and opens them, and
 *    create-standalone-subject creates + opens a new subject page;
 *  - the save-error banner renders when a save fails and Retry clears it;
 *  - CommentSurface resets its draft when annotation.id changes.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { Workbench } from "./workbench";
import { Library } from "./Library";
import { SubjectsLauncher, SaveErrorBanner } from "./App";
import { CommentSurface } from "./Reader";
import type { AnnotationId } from "../model";

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

async function rerender(node: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root!.render(node);
  });
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    await act(async () => {
      await Promise.resolve();
      ok = predicate();
    });
    if (ok) return;
    if (Date.now() >= deadline) throw new Error("waitFor: condition not met");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A fake PDF File whose arrayBuffer yields the given bytes (jsdom lacks it). */
function pdfFile(bytes: Uint8Array, name: string): File {
  const file = new File([], name, { type: "application/pdf" });
  const copy = new Uint8Array(bytes);
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => copy.buffer.slice(0, copy.byteLength),
    configurable: true,
  });
  return file;
}

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3]); // "%PDF-" + junk

function libraryEl(wb: Workbench): ReturnType<typeof createElement> {
  return createElement(Library, {
    wb,
    categoryScope: null,
    onScopeChange: () => undefined,
    onOpen: () => undefined,
    onOpenTogether: () => undefined,
    onImported: () => undefined,
  });
}

describe("m8 Library import affordances", () => {
  it("exposes the + Import PDF button, hidden input and dropzone", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const el = await render(libraryEl(wb));
    expect(el.querySelector('[data-testid="import-pdf-btn"]')).not.toBeNull();
    const input = el.querySelector('[data-testid="import-pdf-input"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.accept).toContain("pdf");
    expect(input.multiple).toBe(true);
    expect(el.querySelector('[data-testid="library-pdf-dropzone"]')).not.toBeNull();
  });

  it("imports a selected PDF with a sha256 versionHash and numPages fallback 1", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const el = await render(libraryEl(wb));
    const input = el.querySelector('[data-testid="import-pdf-input"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [pdfFile(PDF_BYTES, "paper.pdf")], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() => wb.rawData().sources.length === 1);
    const src = wb.rawData().sources[0]!;
    expect(src.title).toBe("paper");
    expect(src.versionHash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
    expect(src.pageCount).toBe(1); // jsdom has no pdf.js worker -> fallback
  });

  it("imports a PDF dropped on the dropzone without navigating", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const el = await render(libraryEl(wb));
    const zone = el.querySelector('[data-testid="library-pdf-dropzone"]') as HTMLElement;
    const file = pdfFile(PDF_BYTES, "dropped.pdf");
    const dataTransfer = { files: [file], dropEffect: "" } as unknown as DataTransfer;
    const drop = new Event("drop", { bubbles: true, cancelable: true }) as unknown as DragEvent;
    Object.defineProperty(drop, "dataTransfer", { value: dataTransfer, configurable: true });
    await act(async () => {
      zone.dispatchEvent(drop);
    });
    expect(drop.defaultPrevented).toBe(true); // never navigates the tab away
    await waitFor(() => wb.rawData().sources.length === 1);
    expect(wb.rawData().sources[0]!.title).toBe("dropped");
  });
});

describe("m8 Subjects launcher", () => {
  it("lists existing subject pages and opens one via openSubjectPage", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const page = await wb.createSubjectPage("Thesis");
    const el = await render(createElement(SubjectsLauncher, { wb, bump: () => undefined }));
    await click(el.querySelector('[data-testid="subjects-launcher-toggle"]')!);
    const item = el.querySelector('[data-testid="subjects-launcher-item"]') as HTMLElement;
    expect(item.textContent).toBe("Thesis");
    await click(item);
    expect(wb.snapshot().openSubjectPageId).toBe(page.id);
  });

  it("create-standalone-subject creates and opens a new subject page", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const el = await render(createElement(SubjectsLauncher, { wb, bump: () => undefined }));
    await click(el.querySelector('[data-testid="subjects-launcher-toggle"]')!);
    await click(el.querySelector('[data-testid="create-standalone-subject"]')!);
    await waitFor(() => wb.rawData().pages.some((p) => p.kind === "subject"));
    const created = wb.rawData().pages.find((p) => p.kind === "subject")!;
    expect(wb.snapshot().openSubjectPageId).toBe(created.id);
  });
});

describe("m8 save-error banner", () => {
  it("renders on save failure and Retry clears the error", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const src = await wb.importSource({
      title: "Doc",
      bytes: new Uint8Array([1]),
      versionHash: "h1",
      pageCount: 1,
    });
    const ann = await wb.commitTextAnnotation({
      sourceId: src.id,
      anchor: {
        docId: src.id,
        sourceVersionHash: "h1",
        pageIndex: 0,
        rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.02 }],
        selectedText: "x",
        prefix: "",
        suffix: "",
      },
    });
    // Force the NEXT save to fail, then trigger a mutation.
    wb.forceNextSaveFailures(1);
    await wb.setComment(ann.annotation.id, "note").catch(() => undefined);
    expect(wb.snapshot().saveError).not.toBeNull();

    const banner = () => createElement(SaveErrorBanner, { wb, bump: () => void rerender(banner()) });
    const el = await render(banner());
    expect(el.querySelector('[data-testid="save-error-banner"]')).not.toBeNull();
    await click(el.querySelector('[data-testid="retry-save-btn"]')!);
    await waitFor(() => wb.snapshot().saveError === null);
    expect(el.querySelector('[data-testid="save-error-banner"]')).toBeNull();
  });
});

describe("m8 comment draft reset on highlight switch", () => {
  it("resets the draft when annotation.id changes", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const src = await wb.importSource({
      title: "Doc",
      bytes: new Uint8Array([1]),
      versionHash: "h1",
      pageCount: 1,
    });
    const anchor = (text: string) => ({
      docId: src.id,
      sourceVersionHash: "h1",
      pageIndex: 0,
      rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.02 }],
      selectedText: text,
      prefix: "",
      suffix: "",
    });
    const a = await wb.commitTextAnnotation({ sourceId: src.id, anchor: anchor("alpha") });
    const b = await wb.commitTextAnnotation({ sourceId: src.id, anchor: anchor("beta") });
    await wb.setComment(b.annotation.id, "beta comment");

    const surface = (id: AnnotationId) =>
      createElement(CommentSurface, { wb, annotationId: id, onClose: () => undefined, bump: () => undefined });
    const el = await render(surface(a.annotation.id));
    const input = () => el.querySelector('[data-testid="comment-input"]') as HTMLTextAreaElement;
    // Type an unsaved draft on annotation A.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(input(), "leaked draft for A");
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input().value).toBe("leaked draft for A");

    // Switch to annotation B: the draft must reset to B's stored comment, not
    // leak A's unsaved text.
    await rerender(surface(b.annotation.id));
    expect(input().value).toBe("beta comment");
    // A's unsaved draft was never saved onto A.
    expect(wb.viewFor(a.annotation.id)!.annotation.comment).toBe("");
  });
});
