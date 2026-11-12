/**
 * jsdom render coverage for the Backup Export Modal (M3, A18). It mounts the
 * REAL component against a REAL Workbench (in-memory storage, nothing mocked)
 * and asserts the Targeted Backup Checklist contract the Playwright spec polls:
 *  - the five checklist items with the exact data-testids render;
 *  - the default badge is "Full Archival Backup" (all optional boxes ticked);
 *  - unticking export-opt-binaries flips the badge to the Targeted text;
 *  - running the export maps the chosen checklist to the expected omissions.
 *
 * The sandbox cannot run Playwright Chromium, so this proves the DOM contract +
 * the options->omissions mapping headlessly in jsdom.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { Workbench } from "./workbench";
import { BackupExportModal } from "./BackupExportModal";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function mount(wb: Workbench): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(BackupExportModal, { wb, onClose: () => undefined }));
  });
  return container;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function toggleCheckbox(el: HTMLInputElement): Promise<void> {
  // The component's onChange flips its own state regardless of e.target.checked,
  // so a real 'click' on the checkbox is the faithful user gesture.
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("BackupExportModal — Targeted Backup Checklist (A18)", () => {
  it("renders the five checklist items with the exact data-testids", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const el = await mount(wb);

    expect(el.querySelector('[data-testid="backup-export-modal"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="export-opt-core"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="export-opt-presentation"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="export-opt-captures"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="export-opt-revisions"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="export-opt-binaries"]')).not.toBeNull();
  });

  it("defaults to the Full Archival Backup badge with every optional box ticked", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const el = await mount(wb);

    const badge = el.querySelector('[data-testid="backup-mode-badge"]')!;
    expect(badge.textContent).toBe("Full Archival Backup");
    expect(badge.getAttribute("data-mode")).toBe("full");
    for (const id of ["presentation", "captures", "revisions", "binaries"]) {
      const box = el.querySelector(`[data-testid="export-opt-${id}"]`) as HTMLInputElement;
      expect(box.checked).toBe(true);
    }
  });

  it("the locked core item cannot be unchecked", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const el = await mount(wb);
    const core = el.querySelector(
      '[data-testid="export-opt-core"] input[type="checkbox"]',
    ) as HTMLInputElement;
    expect(core.checked).toBe(true);
    expect(core.disabled).toBe(true);
  });

  it("unticking export-opt-binaries flips the badge to the Targeted text", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const el = await mount(wb);

    const binaries = el.querySelector('[data-testid="export-opt-binaries"]') as HTMLInputElement;
    await toggleCheckbox(binaries);

    const badge = el.querySelector('[data-testid="backup-mode-badge"]')!;
    expect(badge.textContent).toBe("Targeted Backup (Partial - not a complete archival backup)");
    expect(badge.getAttribute("data-mode")).toBe("targeted");
  });

  it("maps the chosen checklist to the expected omission tokens on export", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const el = await mount(wb);

    // Untick binaries + revisions -> a targeted backup omitting both.
    await toggleCheckbox(el.querySelector('[data-testid="export-opt-binaries"]') as HTMLInputElement);
    await toggleCheckbox(el.querySelector('[data-testid="export-opt-revisions"]') as HTMLInputElement);
    await click(el.querySelector('[data-testid="backup-export-run"]')!);

    const result = el.querySelector('[data-testid="backup-export-result"]')!;
    expect(result.getAttribute("data-backup-mode")).toBe("targeted");
    const omissions = el.querySelector('[data-testid="backup-export-omissions"]')!.textContent ?? "";
    expect(omissions).toContain("sourceBinaries");
    expect(omissions).toContain("revisions");
    expect(omissions).not.toContain("captures");
    expect(omissions).not.toContain("presentation");
  });

  it("a full export reports the full mode with no omissions", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const el = await mount(wb);
    await click(el.querySelector('[data-testid="backup-export-run"]')!);

    const result = el.querySelector('[data-testid="backup-export-result"]')!;
    expect(result.getAttribute("data-backup-mode")).toBe("full");
    expect(el.querySelector('[data-testid="backup-export-omissions"]')).toBeNull();
  });
});
