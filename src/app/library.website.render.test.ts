/**
 * jsdom render coverage for the M6 (A15, D11) "Add website" modal against a
 * REAL Workbench (in-memory storage, nothing mocked):
 *
 *  - the modal exposes website-url-input + website-snapshot-dropzone;
 *  - submitting a URL with NO snapshot file is rejected with
 *    website-snapshot-required-error and imports nothing;
 *  - submitting a URL + snapshot imports a website Source (kind/type "website",
 *    availabilityStatus "snapshot-cached").
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { Workbench } from "./workbench";
import { AddWebsiteModal } from "./Library";

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

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function fileWithBytes(bytes: Uint8Array, name: string): File {
  const file = new File([], name, { type: "text/html" });
  const copy = new Uint8Array(bytes);
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => copy.buffer.slice(0, copy.byteLength),
    configurable: true,
  });
  return file;
}

/** Set a controlled input's value via the native setter so React's onChange fires. */
function setNativeValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
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

describe("AddWebsiteModal (A15, D11)", () => {
  it("renders the url input and snapshot dropzone", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const el = await render(
      createElement(AddWebsiteModal, { wb, onClose: () => undefined, onImported: () => undefined }),
    );
    expect(el.querySelector('[data-testid="add-website-modal"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="website-url-input"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="website-snapshot-dropzone"]')).not.toBeNull();
  });

  it("rejects a URL-only submit with website-snapshot-required-error", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const el = await render(
      createElement(AddWebsiteModal, { wb, onClose: () => undefined, onImported: () => undefined }),
    );
    const input = el.querySelector('[data-testid="website-url-input"]') as HTMLInputElement;
    setNativeValue(input, "https://example.com");
    await act(async () => {
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(el.querySelector('[data-testid="add-website-submit"]')!);

    const err = el.querySelector('[data-testid="website-snapshot-required-error"]');
    expect(err).not.toBeNull();
    expect(err!.textContent).toMatch(/snapshot file is required/i);
    // Nothing was imported.
    expect(wb.rawData().sources).toHaveLength(0);
  });

  it("imports a website source when a URL + snapshot are provided", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    let imported = false;
    const el = await render(
      createElement(AddWebsiteModal, {
        wb,
        onClose: () => undefined,
        onImported: () => {
          imported = true;
        },
      }),
    );
    const input = el.querySelector('[data-testid="website-url-input"]') as HTMLInputElement;
    setNativeValue(input, "https://example.com/post");
    await act(async () => {
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const fileInput = el.querySelector('[data-testid="website-snapshot-input"]') as HTMLInputElement;
    const file = fileWithBytes(new TextEncoder().encode("<p>snapshot body</p>"), "page.html");
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    await act(async () => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click(el.querySelector('[data-testid="add-website-submit"]')!);
    await waitFor(() => imported && wb.rawData().sources.length === 1);

    const src = wb.rawData().sources[0]!;
    expect(src.kind).toBe("website");
    expect(src.type).toBe("website");
    expect(src.availabilityStatus).toBe("snapshot-cached");
    expect(src.url).toBe("https://example.com/post");
  });
});
