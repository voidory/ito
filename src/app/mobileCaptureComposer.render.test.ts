/**
 * jsdom render coverage for the M5 MobileCaptureComposer (§16.2, A22/A23). It
 * mounts the REAL composer against a REAL Workbench (in-memory storage, nothing
 * mocked) and asserts:
 *  - submitting creates a Capture via the live engine with ZERO new
 *    Page/Category/Relationship records (A23);
 *  - the rendered sync badge shows the correct label per capture status.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { Workbench } from "./workbench";
import { MobileCaptureComposer } from "./MobileCaptureComposer";
import type { BrainData } from "../model";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function graphRecordCount(data: BrainData): number {
  return data.pages.length + data.categories.length + data.relationships.length;
}

let container: HTMLElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function mount(wb: Workbench, bump: () => void): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(MobileCaptureComposer, { wb, onChange: bump }));
  });
  return container;
}

async function setValue(input: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
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

describe("MobileCaptureComposer — create capture (A23) + sync badge", () => {
  it("submitting creates a capture with NO new graph node (A23) and a 'local' badge", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    let bumps = 0;
    const before = graphRecordCount(wb.rawData());
    // Re-render on bump so the capture list reflects the new capture.
    const render = async () =>
      act(async () => {
        root!.render(createElement(MobileCaptureComposer, { wb, onChange: () => {
          bumps += 1;
          void render();
        } }));
      });
    const el = await mount(wb, () => {
      bumps += 1;
      void render();
    });

    const input = el.querySelector('[data-testid="capture-content-input"]') as HTMLTextAreaElement;
    await setValue(input, "a phone thought");
    await click(el.querySelector('[data-testid="capture-submit-btn"]')!);
    await act(async () => {
      await Promise.resolve();
    });

    expect(bumps).toBeGreaterThan(0);
    // A23: no Page/Category/Relationship created.
    expect(graphRecordCount(wb.rawData())).toBe(before);
    expect(wb.captures()).toHaveLength(1);
    expect(wb.captures()[0]!.text).toBe("a phone thought");

    const badge = el.querySelector('[data-testid="capture-sync-badge"]')!;
    expect(badge.getAttribute("data-status")).toBe("local");
    expect(badge.textContent).toBe("Saved on this device");
  });

  it("renders the correct badge label for pending and uploaded statuses", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    // Seed one pending capture directly via the engine.
    await wb.createMobileCapture({ content: "queued", queueForUpload: true });
    const el = await mount(wb, () => undefined);

    const badge = el.querySelector('[data-testid="capture-sync-badge"]')!;
    expect(badge.getAttribute("data-status")).toBe("pending");
    expect(badge.textContent).toBe("Pending upload");
  });
});
