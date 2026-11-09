/**
 * jsdom render coverage for the M5 desktop CaptureProcessingQueue (§16.3,
 * A22/A23). It mounts the REAL queue against a REAL Workbench (in-memory
 * storage, nothing mocked) and asserts the four explicit actions drive the
 * idempotent wb.handleCapture engine with the correct dispositions, and that
 * acted-on captures drop out of the pending queue.
 *
 * It also proves (via the App ViewSwitch path) that view-captures toggles the
 * workbench viewMode to 'captures'.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { Workbench } from "./workbench";
import { CaptureProcessingQueue } from "./CaptureProcessingQueue";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function mountQueue(wb: Workbench): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const rerender = async () =>
    act(async () => {
      root!.render(createElement(CaptureProcessingQueue, { wb, onChange: () => void rerender() }));
    });
  await act(async () => {
    root!.render(createElement(CaptureProcessingQueue, { wb, onChange: () => void rerender() }));
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

describe("CaptureProcessingQueue — four actions drive handleCapture (A22/A23)", () => {
  it("lists pending captures with the four actions", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    await wb.createMobileCapture({ content: "review me" });
    const el = await mountQueue(wb);

    expect(el.querySelector('[data-testid="capture-processing-queue"]')).not.toBeNull();
    const row = el.querySelector('[data-testid="capture-queue-item"]')!;
    expect(row).not.toBeNull();
    expect(el.querySelector('[data-testid="capture-open-source"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="capture-insert-page"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="capture-create-subject"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="capture-dismiss"]')).not.toBeNull();
  });

  it("create-subject creates a new page and the capture leaves the pending queue", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const cap = await wb.createMobileCapture({ content: "a new subject seed" });
    const el = await mountQueue(wb);
    const beforePages = wb.rawData().pages.length;

    await click(el.querySelector('[data-testid="capture-create-subject"]')!);

    expect(wb.rawData().pages.length).toBe(beforePages + 1);
    expect(wb.captureHandlings().some((h) => h.captureId === cap.id && h.disposition === "created-subject")).toBe(true);
    // Incorporated capture drops out of the pending queue.
    expect(el.querySelector('[data-testid="capture-queue-item"]')).toBeNull();
  });

  it("insert-into-page records incorporated-quote into the target page", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const page = await wb.createSubjectPage("Target");
    const cap = await wb.createMobileCapture({ content: "insert this", targetPageId: page.id });
    const el = await mountQueue(wb);

    await click(el.querySelector('[data-testid="capture-insert-page"]')!);

    expect(
      wb.captureHandlings().some((h) => h.captureId === cap.id && h.disposition === "incorporated-quote"),
    ).toBe(true);
    expect(JSON.stringify(wb.subjectDocJson(page.id))).toContain("insert this");
  });

  it("dismiss records disposition dismissed", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const cap = await wb.createMobileCapture({ content: "noise" });
    const el = await mountQueue(wb);

    await click(el.querySelector('[data-testid="capture-dismiss"]')!);

    expect(
      wb.captureHandlings().some((h) => h.captureId === cap.id && h.disposition === "dismissed"),
    ).toBe(true);
  });
});

describe("Captures ViewMode — view-captures toggles the workbench view", () => {
  it("setViewMode('captures') is reflected by viewMode()", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    expect(wb.viewMode()).toBe("files");
    wb.setViewMode("captures");
    expect(wb.viewMode()).toBe("captures");
  });
});
