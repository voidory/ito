/**
 * jsdom render coverage for the HistoryReflectionPanel (M7, H03/H04/D14). It
 * mounts the REAL component against a REAL Workbench (in-memory storage) and
 * asserts the DOM contract the Playwright spec polls:
 *  - the day-grouped timeline renders a group + revision-item per revision;
 *  - the single-day picker and the date-range filter testids are present;
 *  - each revision row carries a selection checkbox, a comment input, and a
 *    before/after diff view (expanded on demand);
 *  - selecting revisions spanning two days + saving a reflection surfaces the
 *    reflection-date-span (because startDateKey !== endDateKey).
 *
 * The sandbox cannot run Playwright Chromium, so this proves the DOM contract
 * headlessly in jsdom.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { Workbench } from "./workbench";
import { HistoryReflectionPanel } from "./HistoryReflectionPanel";
import type { DocumentJson } from "../editor";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

function doc(text: string): DocumentJson {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

async function mount(wb: Workbench): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(HistoryReflectionPanel, { wb }));
  });
  return container;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** Seed two revisions on two different days so the timeline has 2 groups. */
async function seedTwoDayHistory(wb: Workbench): Promise<void> {
  const page = await wb.createSubjectPage("S");
  await wb.recordProseEdit(page.id, doc("day one"), "2024-05-01T10:00:00.000Z");
  await wb.flushPendingRevision();
  await wb.recordProseEdit(page.id, doc("day ten"), "2024-05-10T10:00:00.000Z");
  await wb.flushPendingRevision();
}

describe("HistoryReflectionPanel — day-grouped timeline + filters (H03)", () => {
  it("renders the panel with the single-day and date-range filter testids", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    await seedTwoDayHistory(wb);
    const el = await mount(wb);

    expect(el.querySelector('[data-testid="history-reflection-panel"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="review-date-picker"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="review-range-start"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="review-range-end"]')).not.toBeNull();
  });

  it("groups revisions by day and renders a revision-item per revision", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    await seedTwoDayHistory(wb);
    const el = await mount(wb);

    const groups = el.querySelectorAll('[data-testid="revision-day-group"]');
    expect(groups.length).toBe(2);
    const items = el.querySelectorAll('[data-testid="revision-item"]');
    expect(items.length).toBe(2);
    // Each row has a selection checkbox + a comment input.
    expect(el.querySelectorAll('[data-testid="revision-select-checkbox"]').length).toBe(2);
    expect(el.querySelectorAll('[data-testid="revision-comment-input"]').length).toBe(2);
  });

  it("expands a before/after diff view on demand", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    await seedTwoDayHistory(wb);
    const el = await mount(wb);

    expect(el.querySelector('[data-testid="revision-diff-view"]')).toBeNull();
    await click(el.querySelector('[data-testid="revision-diff-toggle"]')!);
    expect(el.querySelector('[data-testid="revision-diff-view"]')).not.toBeNull();
  });

  it("renders the reflection editor and shows the date-span across selected days", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    await seedTwoDayHistory(wb);
    const el = await mount(wb);

    expect(el.querySelector('[data-testid="reflection-editor"]')).not.toBeNull();
    // No span before anything is selected.
    expect(el.querySelector('[data-testid="reflection-date-span"]')).toBeNull();

    // Select BOTH revisions (they span 2024-05-01 .. 2024-05-10).
    const boxes = el.querySelectorAll('[data-testid="revision-select-checkbox"]');
    await click(boxes[0]!);
    await click(boxes[1]!);

    const span = el.querySelector('[data-testid="reflection-date-span"]');
    expect(span).not.toBeNull();
    expect(span!.textContent).toContain("2024-05-01");
    expect(span!.textContent).toContain("2024-05-10");
  });

  it("saving a reflection with multi-day selection persists a ReflectionEntry", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    await seedTwoDayHistory(wb);
    const el = await mount(wb);

    const boxes = el.querySelectorAll('[data-testid="revision-select-checkbox"]');
    await click(boxes[0]!);
    await click(boxes[1]!);
    await click(el.querySelector('[data-testid="reflection-save"]')!);

    const reflections = wb.reflections();
    expect(reflections).toHaveLength(1);
    expect(reflections[0]!.startDateKey).toBe("2024-05-01");
    expect(reflections[0]!.endDateKey).toBe("2024-05-10");
  });
});
