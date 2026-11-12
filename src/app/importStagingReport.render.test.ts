/**
 * jsdom render coverage for the Import Staging Report (M3, A19). It mounts the
 * REAL component against a REAL Workbench (in-memory storage, nothing mocked),
 * stages real bundles through the validator, and asserts:
 *  - a 'needs-confirmation' bundle renders import-staging-report with its
 *    findings and a 'try-import-anyway' button that drives the lenient commit;
 *  - a 'ready' bundle commits via the normal Import button;
 *  - a 'hard-reject' shows the abort reason and offers NO override.
 *
 * The sandbox cannot run Playwright Chromium, so this proves the DOM contract +
 * the lenient commit path headlessly in jsdom.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { Workbench } from "./workbench";
import { ImportStagingReport } from "./ImportStagingReport";
import { exportCoreBrainJson } from "../storage";
import { createEmptyBrainData, SCHEMA_VERSION } from "../model";
import type { StagedImport } from "../storage";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function mount(
  wb: Workbench,
  staged: StagedImport,
  cbs: { onDone?: (c: boolean) => void; onCancel?: () => void } = {},
): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      createElement(ImportStagingReport, {
        wb,
        staged,
        onDone: cbs.onDone ?? (() => undefined),
        onCancel: cbs.onCancel ?? (() => undefined),
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
    await Promise.resolve();
  });
}

/** A Lane-1 JSON payload carrying an OLD schema version (a default-reject). */
function staleSchemaBundle(): string {
  const base = createEmptyBrainData();
  const { json } = exportCoreBrainJson(base);
  const parsed = JSON.parse(json) as { manifest: { schemaVersion: number } };
  parsed.manifest.schemaVersion = SCHEMA_VERSION - 1;
  return JSON.stringify(parsed);
}

describe("ImportStagingReport — staging report + Try Import Anyway (A19)", () => {
  it("renders findings + a Try Import Anyway button for a needs-confirmation bundle", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const staged = await wb.stageImport(staleSchemaBundle());
    expect(staged.outcome).toBe("needs-confirmation");

    const el = await mount(wb, staged);
    const report = el.querySelector('[data-testid="import-staging-report"]')!;
    expect(report.getAttribute("data-outcome")).toBe("needs-confirmation");
    expect(el.querySelectorAll('[data-testid="import-staging-finding"]').length).toBeGreaterThan(0);
    expect(el.querySelector('[data-testid="try-import-anyway"]')).not.toBeNull();
    // No plain Import button on a needs-confirmation report.
    expect(el.querySelector('[data-testid="import-staging-commit"]')).toBeNull();
  });

  it("Try Import Anyway drives the lenient commit path and reports success", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const staged = await wb.stageImport(staleSchemaBundle());

    let committed: boolean | null = null;
    const el = await mount(wb, staged, { onDone: (c) => (committed = c) });
    await click(el.querySelector('[data-testid="try-import-anyway"]')!);

    expect(committed).toBe(true);
    // The staged import is consumed after a successful commit.
    expect(wb.stagedImportState()).toBeNull();
  });

  it("a hard-reject shows the abort reason and offers NO override", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const staged = await wb.stageImport("{ not valid json ]");
    expect(staged.outcome).toBe("hard-reject");

    const el = await mount(wb, staged);
    expect(el.querySelector('[data-testid="import-abort-reason"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="try-import-anyway"]')).toBeNull();
    expect(el.querySelector('[data-testid="import-staging-commit"]')).toBeNull();
  });

  it("a ready bundle commits via the normal Import button", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const { json } = exportCoreBrainJson(createEmptyBrainData());
    const staged = await wb.stageImport(json);
    expect(staged.outcome).toBe("ready");

    let committed: boolean | null = null;
    const el = await mount(wb, staged, { onDone: (c) => (committed = c) });
    const importBtn = el.querySelector('[data-testid="import-staging-commit"]')!;
    expect(importBtn).not.toBeNull();
    await click(importBtn);
    expect(committed).toBe(true);
  });
});
