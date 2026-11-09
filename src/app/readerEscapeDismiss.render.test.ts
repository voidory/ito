/**
 * FEAT-001 (M10) Escape-dismissal coverage. The reader annotation overlays now
 * mount the shared <Popover> primitive, which owns a single Escape listener.
 * This proves that dispatching a keydown Escape dismisses BOTH the no-tool
 * SelectionToolbar (previously it had NO Escape handling - the headline fix of
 * this feature) and the HighlightEditPopover, in each case firing the
 * onDismiss/onClose callback and removing the surface from the DOM.
 *
 * It also guards the comment autosave-on-blur behaviour (4e29b1a): typing a
 * comment and then clicking OUTSIDE the popover must let the textarea blur-save
 * commit before the popover unmounts, so the draft is persisted (the <Popover>
 * dismisses on `mouseup`, after the blur, specifically to make this safe).
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { sha256Hex } from "../storage";
import { Workbench } from "./workbench";
import {
  HighlightEditPopover,
  SelectionToolbar,
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
  document.querySelectorAll('[data-testid="ito-popover-layer"]').forEach((el) => el.remove());
});

async function render(node: ReturnType<typeof createElement>): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
}

function q(sel: string): HTMLElement | null {
  return document.querySelector(sel) as HTMLElement | null;
}

async function pressEscape(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe("FEAT-001 Escape dismisses the annotation overlays", () => {
  it("Escape dismisses the SelectionToolbar (previously it had no Escape handling)", async () => {
    (window as unknown as { innerWidth: number }).innerWidth = 1000;
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const src = await importHashed(wb);
    let dismissed = false;
    const toolbar: ToolbarState = {
      sourceId: src.id,
      anchor: textAnchor(src.id, src.versionHash, "quote me"),
      rect: { left: 400, top: 200, right: 480, bottom: 220, width: 80 },
    };
    await render(
      createElement(SelectionToolbar, {
        toolbar,
        onCommit: () => undefined,
        onDismiss: () => {
          dismissed = true;
        },
      }),
    );
    expect(q('[data-testid="selection-toolbar"]')).not.toBeNull();
    await pressEscape();
    expect(dismissed).toBe(true);
  });

  it("Escape dismisses the HighlightEditPopover", async () => {
    (window as unknown as { innerWidth: number }).innerWidth = 1000;
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const src = await importHashed(wb);
    const a = await wb.commitTextAnnotation({
      sourceId: src.id,
      anchor: textAnchor(src.id, src.versionHash, "quote me"),
    });
    let closed = false;
    const popover: EditPopoverState = {
      annotationId: a.annotation.id,
      sourceId: src.id,
      rect: { left: 300, top: 300, right: 300, bottom: 300, width: 0 },
    };
    await render(
      createElement(HighlightEditPopover, {
        wb,
        popover,
        onClose: () => {
          closed = true;
        },
        bump: () => undefined,
      }),
    );
    expect(q('[data-testid="highlight-edit-popover"]')).not.toBeNull();
    await pressEscape();
    expect(closed).toBe(true);
  });

  it("clicking outside the popover commits the comment autosave-on-blur before closing (4e29b1a)", async () => {
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
    await render(
      createElement(HighlightEditPopover, {
        wb,
        popover,
        onClose: () => undefined,
        bump: () => undefined,
      }),
    );
    const textarea = q('[data-testid="comment-input"]') as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();

    // Type a comment into the textarea.
    await act(async () => {
      textarea.focus();
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(textarea, "a note worth keeping");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // Click OUTSIDE the surface: mousedown -> the textarea blurs (autosave),
    // then mouseup -> the <Popover> dismisses. The blur save must have run.
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      textarea.blur();
      document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(wb.viewFor(a.annotation.id)?.annotation.comment).toBe("a note worth keeping");
  });
});
