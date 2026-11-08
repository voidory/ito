/**
 * FEAT-005 — integrated workspace + context-preserving layout state domain
 * tests (Vitest). These assert, through the real Workbench + in-memory storage,
 * the presentation-only view state the integrated three-pane workspace owns and
 * that context-preserving transitions must carry (spec sections 7.3, 8.2; R19,
 * N08, A08/R08 foundation):
 *
 *  - adjustable pane widths (flex-grow weights) are view state, clamped, and
 *    carried across a third-paper pane swap;
 *  - switching one reader pane to a third paper keeps the subject and the other
 *    panes (section 8.2 note);
 *  - the passage-to-evidence line DATA relates OPEN sources to the OPEN
 *    subject's evidence, and the line-visibility toggle changes presentation
 *    only and never deletes a relationship (A08/R08);
 *  - the library category scope is a view filter preserved across transitions.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { Workbench } from "./workbench";
import type { Source, SourceId, TextAnchor } from "../model";

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

async function importOne(
  wb: Workbench,
  title: string,
  category = "Papers",
): Promise<Source> {
  return wb.importSource({
    title,
    bytes: new Uint8Array([1, 2, 3, 4]),
    versionHash: "hash-" + title,
    pageCount: 3,
    category,
  });
}

describe("FEAT-005 — adjustable pane widths (section 8.2)", () => {
  let wb: Workbench;
  beforeEach(async () => {
    wb = await Workbench.open(new InMemoryStorageAdapter());
  });

  it("defaults every pane slot to weight 1 and stores explicit weights", () => {
    expect(wb.paneWidth("subject")).toBe(1);
    wb.setPaneWidth("subject", 2.5);
    expect(wb.paneWidth("subject")).toBe(2.5);
    expect(wb.snapshot().workspaceLayout.paneWidths.subject).toBe(2.5);
  });

  it("clamps a pane to a minimum so it is never collapsed away", () => {
    wb.setPaneWidth("subject", 0.01);
    expect(wb.paneWidth("subject")).toBeGreaterThanOrEqual(0.15);
  });

  it("setting pane widths touches NO durable records (presentation only)", async () => {
    const src = await importOne(wb, "A");
    const before = wb.rawData();
    wb.setPaneWidth(src.id, 3);
    const after = wb.rawData();
    expect(after.pages.length).toBe(before.pages.length);
    expect(after.relationships.length).toBe(0);
    expect(after.categories.length).toBe(0);
  });
});

describe("FEAT-005 — switch a reader pane to a third paper (section 8.2 note)", () => {
  let wb: Workbench;
  beforeEach(async () => {
    wb = await Workbench.open(new InMemoryStorageAdapter());
  });

  it("swaps one pane while preserving order, the other pane, and the subject", async () => {
    const a = await importOne(wb, "A");
    const b = await importOne(wb, "B");
    const c = await importOne(wb, "C");
    wb.openTogether([a.id, b.id]);
    const page = await wb.createSubjectPage("S");
    wb.openSubjectPage(page.id);

    wb.switchReaderPane(b.id, c.id);

    expect(wb.snapshot().openSourceIds).toEqual([a.id, c.id]);
    // The subject page stays open alongside (never replaced).
    expect(wb.snapshot().openSubjectPageId).toBe(page.id);
  });

  it("carries the swapped pane's width weight onto the new source (R19)", async () => {
    const a = await importOne(wb, "A");
    const b = await importOne(wb, "B");
    const c = await importOne(wb, "C");
    wb.openTogether([a.id, b.id]);
    wb.setPaneWidth(b.id, 2.2);
    wb.switchReaderPane(b.id, c.id);
    expect(wb.paneWidth(c.id)).toBeCloseTo(2.2);
  });

  it("is a no-op when the from-source is not open", async () => {
    const a = await importOne(wb, "A");
    const b = await importOne(wb, "B");
    wb.openSource(a.id);
    wb.switchReaderPane(b.id, a.id);
    expect(wb.snapshot().openSourceIds).toEqual([a.id]);
  });
});

describe("FEAT-005 — passage-to-evidence line data + non-destructive toggle (A08/R08)", () => {
  let wb: Workbench;
  beforeEach(async () => {
    wb = await Workbench.open(new InMemoryStorageAdapter());
  });

  it("relates OPEN sources to the OPEN subject's evidence", async () => {
    const a = await importOne(wb, "A");
    const view = await wb.commitTextAnnotation({
      sourceId: a.id,
      anchor: textAnchor(a.id, a.versionHash, "quick brown fox"),
    });
    const { page } = await wb.createSubjectFromAnnotation("S", view.annotation.id);
    wb.openSource(a.id);
    wb.openSubjectPage(page.id);

    const lines = wb.passageEvidenceLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.sourceId).toBe(a.id);
    expect(lines[0]!.sourcePageIndex).toBe(1); // the anchor's page index
  });

  it("omits lines whose source pane is not open (no dangling endpoints)", async () => {
    const a = await importOne(wb, "A");
    const view = await wb.commitTextAnnotation({
      sourceId: a.id,
      anchor: textAnchor(a.id, a.versionHash, "quick brown fox"),
    });
    const { page } = await wb.createSubjectFromAnnotation("S", view.annotation.id);
    // Subject open, but the source pane is NOT open.
    wb.openSubjectPage(page.id);
    expect(wb.passageEvidenceLines()).toHaveLength(0);
  });

  it("toggling line visibility changes presentation only and never deletes a relationship", async () => {
    const a = await importOne(wb, "A");
    const view = await wb.commitTextAnnotation({
      sourceId: a.id,
      anchor: textAnchor(a.id, a.versionHash, "quick brown fox"),
    });
    const { page, evidence } = await wb.createSubjectFromAnnotation(
      "S",
      view.annotation.id,
    );
    wb.openSource(a.id);
    wb.openSubjectPage(page.id);

    expect(wb.linesVisible()).toBe(true);
    const linesWhenVisible = wb.passageEvidenceLines().map((l) => l.evidenceId);

    wb.setLinesVisible(false);
    expect(wb.linesVisible()).toBe(false);
    // The DATA is unchanged: the evidence instance and its line survive.
    expect(wb.passageEvidenceLines().map((l) => l.evidenceId)).toEqual(linesWhenVisible);
    expect(wb.rawData().evidenceInstances.some((e) => e.id === evidence.id)).toBe(true);

    wb.setLinesVisible(true);
    expect(wb.passageEvidenceLines().map((l) => l.evidenceId)).toEqual(linesWhenVisible);
  });
});

describe("FEAT-005 — library category scope preserved across transitions (N03, N08)", () => {
  let wb: Workbench;
  beforeEach(async () => {
    wb = await Workbench.open(new InMemoryStorageAdapter());
  });

  it("scopes the library sections to one category and lists all categories", async () => {
    await importOne(wb, "A", "Papers");
    await importOne(wb, "B", "References");
    expect(wb.categories()).toEqual(["Papers", "References"]);
    expect(wb.librarySections().length).toBe(2);

    wb.setCategoryScope("References");
    const scoped = wb.librarySections();
    expect(scoped).toHaveLength(1);
    expect(scoped[0]!.category).toBe("References");
    expect(scoped[0]!.sources[0]!.title).toBe("B");
  });

  it("the scope survives opening + closing the reader workspace", async () => {
    const a = await importOne(wb, "A", "Papers");
    await importOne(wb, "B", "References");
    wb.setCategoryScope("Papers");
    wb.openSource(a.id);
    expect(wb.categoryScope()).toBe("Papers");
    wb.closeWorkspace();
    expect(wb.categoryScope()).toBe("Papers");
  });
});
