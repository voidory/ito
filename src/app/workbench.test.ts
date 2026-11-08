import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { Workbench } from "./workbench";
import type { SourceId, TextAnchor } from "../model";

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

async function importOne(wb: Workbench, title = "Doc", pageCount = 3) {
  return wb.importSource({
    title,
    bytes: new Uint8Array([1, 2, 3, 4]),
    versionHash: "hash-" + title,
    pageCount,
    category: "Papers",
  });
}

describe("Workbench — library + annotation invariants", () => {
  let storage: InMemoryStorageAdapter;
  let wb: Workbench;

  beforeEach(async () => {
    storage = new InMemoryStorageAdapter();
    wb = await Workbench.open(storage);
  });

  it("imports sources without creating any page/relationship/category", async () => {
    await importOne(wb, "A");
    await importOne(wb, "B");
    const data = wb.rawData();
    expect(data.sources).toHaveLength(2);
    expect(data.pages).toHaveLength(0);
    expect(data.relationships).toHaveLength(0);
    expect(data.categories).toHaveLength(0);
  });

  it("groups and sorts the library by category", async () => {
    await importOne(wb, "Zebra");
    await importOne(wb, "Apple");
    const sections = wb.librarySections("title");
    expect(sections).toHaveLength(1);
    expect(sections[0]!.category).toBe("Papers");
    expect(sections[0]!.sources.map((s) => s.title)).toEqual(["Apple", "Zebra"]);
  });

  it("'open together' opens a shared workspace with no auto-analysis", async () => {
    const a = await importOne(wb, "A");
    const b = await importOne(wb, "B");
    wb.openTogether([a.id, b.id]);
    const snap = wb.snapshot();
    expect(snap.openSourceIds).toEqual([a.id, b.id]);
    // No analysis side effects: still zero pages/relationships.
    expect(wb.rawData().pages).toHaveLength(0);
    expect(wb.rawData().relationships).toHaveLength(0);
  });

  it("CRITICAL INVARIANT: highlighting creates zero Page/Relationship records", async () => {
    const src = await importOne(wb);
    await wb.commitTextAnnotation({
      sourceId: src.id,
      anchor: textAnchor(src.id, src.versionHash, "quick brown fox"),
    });
    const data = wb.rawData();
    expect(data.annotations).toHaveLength(1);
    expect(data.pages).toHaveLength(0);
    expect(data.relationships).toHaveLength(0);
    expect(data.categories).toHaveLength(0);
    expect(data.evidenceInstances).toHaveLength(0);
    expect(data.subjectAssociations).toHaveLength(0);
  });

  it("highlights save quiet (empty comment) by default", async () => {
    const src = await importOne(wb);
    const view = await wb.commitTextAnnotation({
      sourceId: src.id,
      anchor: textAnchor(src.id, src.versionHash, "fox"),
    });
    expect(view.annotation.comment).toBe("");
    expect(view.style).toEqual({ kind: "highlight", color: "yellow" });
  });

  it("a range annotation is one identity spanning pages with a pp. label", async () => {
    const src = await importOne(wb, "Doc", 3);
    const view = await wb.commitRangeAnnotation({
      sourceId: src.id,
      startPageIndex: 0,
      endPageIndex: 2,
    });
    expect(view.isRange).toBe(true);
    expect(view.rangeLabel).toBe("pp. 1-3");
    expect(wb.rawData().annotations).toHaveLength(1);
  });

  it("micro-highlights inside a range stay independent annotations", async () => {
    const src = await importOne(wb);
    await wb.commitRangeAnnotation({ sourceId: src.id, startPageIndex: 0, endPageIndex: 2 });
    await wb.commitTextAnnotation({
      sourceId: src.id,
      anchor: textAnchor(src.id, src.versionHash, "fox"),
    });
    const views = wb.annotationsForSource(src.id);
    expect(views).toHaveLength(2);
    expect(views.filter((v) => v.isRange)).toHaveLength(1);
    expect(views.filter((v) => !v.isRange)).toHaveLength(1);
  });
});

describe("Workbench — association/citation state machine", () => {
  let storage: InMemoryStorageAdapter;
  let wb: Workbench;

  beforeEach(async () => {
    storage = new InMemoryStorageAdapter();
    wb = await Workbench.open(storage);
  });

  it("associate produces a dotted (tentative) link without composing the page", async () => {
    const src = await importOne(wb);
    const view = await wb.commitTextAnnotation({
      sourceId: src.id,
      anchor: textAnchor(src.id, src.versionHash, "fox"),
    });
    const subject = await wb.createSubjectPage("Subject A");
    await wb.associateWithSubject(view.annotation.id, subject.id);
    expect(wb.referenceStatus(view.annotation.id, subject.id)).toBe("tentative");
    // No evidence => page composition unchanged.
    expect(wb.rawData().evidenceInstances).toHaveLength(0);
  });

  it("commenting alone never creates a dotted connection", async () => {
    const src = await importOne(wb);
    const view = await wb.commitTextAnnotation({
      sourceId: src.id,
      anchor: textAnchor(src.id, src.versionHash, "fox"),
    });
    const subject = await wb.createSubjectPage("Subject A");
    await wb.setComment(view.annotation.id, "a private thought");
    expect(wb.referenceStatus(view.annotation.id, subject.id)).toBe("none");
    expect(wb.rawData().subjectAssociations).toHaveLength(0);
  });

  it("associating never moves or deletes the source annotation", async () => {
    const src = await importOne(wb);
    const view = await wb.commitTextAnnotation({
      sourceId: src.id,
      anchor: textAnchor(src.id, src.versionHash, "fox"),
    });
    const subject = await wb.createSubjectPage("S");
    await wb.associateWithSubject(view.annotation.id, subject.id);
    const annotations = wb.rawData().annotations;
    expect(annotations).toHaveLength(1);
    expect(annotations[0]!.id).toBe(view.annotation.id);
  });

  it("second subject can be tentative while the first stays solid (R07)", async () => {
    const src = await importOne(wb);
    const view = await wb.commitTextAnnotation({
      sourceId: src.id,
      anchor: textAnchor(src.id, src.versionHash, "fox"),
    });
    const first = await wb.createSubjectPage("First");
    const second = await wb.createSubjectPage("Second");
    await wb.insertEvidence(view.annotation.id, first.id, "fox");
    await wb.associateWithSubject(view.annotation.id, second.id);
    expect(wb.referenceStatus(view.annotation.id, first.id)).toBe("cited");
    expect(wb.referenceStatus(view.annotation.id, second.id)).toBe("tentative");
  });

  it("removing one of two quotes keeps the relationship cited", async () => {
    const src = await importOne(wb);
    const view = await wb.commitTextAnnotation({
      sourceId: src.id,
      anchor: textAnchor(src.id, src.versionHash, "fox"),
    });
    const subject = await wb.createSubjectPage("S");
    const e1 = await wb.insertEvidence(view.annotation.id, subject.id, "q1");
    await wb.insertEvidence(view.annotation.id, subject.id, "q2");
    await wb.removeEvidence(e1.id);
    expect(wb.referenceStatus(view.annotation.id, subject.id)).toBe("cited");
  });
});

describe("Workbench — persistence + save failure (R12, R14)", () => {
  it("annotations, comments, ranges, links, and citation states round-trip", async () => {
    const storage = new InMemoryStorageAdapter();
    const wb = await Workbench.open(storage);
    const src = await importOne(wb, "Doc", 3);
    const brainId = wb.snapshot().brainId;

    const hi = await wb.commitTextAnnotation({
      sourceId: src.id,
      anchor: textAnchor(src.id, src.versionHash, "fox"),
    });
    await wb.setComment(hi.annotation.id, "note on the fox");
    await wb.commitRangeAnnotation({ sourceId: src.id, startPageIndex: 0, endPageIndex: 2 });
    const subject = await wb.createSubjectPage("S");
    await wb.associateWithSubject(hi.annotation.id, subject.id);
    await wb.insertEvidence(hi.annotation.id, subject.id, "fox");

    // Reopen from the same storage: everything restores exactly.
    const reopened = await Workbench.open(storage, brainId);
    const views = reopened.annotationsForSource(src.id);
    expect(views).toHaveLength(2);
    const restoredHi = views.find((v) => !v.isRange)!;
    expect(restoredHi.annotation.comment).toBe("note on the fox");
    expect(restoredHi.style).toEqual({ kind: "highlight", color: "yellow" });
    const range = views.find((v) => v.isRange)!;
    expect(range.rangeLabel).toBe("pp. 1-3");
    expect(reopened.referenceStatus(restoredHi.annotation.id, subject.id)).toBe("cited");
  });

  it("a failed save retains the draft comment and surfaces an error (R12)", async () => {
    const storage = new InMemoryStorageAdapter();
    const wb = await Workbench.open(storage);
    const src = await importOne(wb);
    const view = await wb.commitTextAnnotation({
      sourceId: src.id,
      anchor: textAnchor(src.id, src.versionHash, "fox"),
    });
    storage.failNextWrites = 1;
    await expect(wb.setComment(view.annotation.id, "draft that fails to save")).rejects.toThrow();
    // Draft retained in memory; error surfaced; never faked as saved.
    const after = wb.viewFor(view.annotation.id)!;
    expect(after.annotation.comment).toBe("draft that fails to save");
    expect(wb.snapshot().saveError).not.toBeNull();
  });

  it("custom highlight color persists", async () => {
    const storage = new InMemoryStorageAdapter();
    const wb = await Workbench.open(storage);
    const src = await importOne(wb);
    const brainId = wb.snapshot().brainId;
    const view = await wb.commitTextAnnotation({
      sourceId: src.id,
      anchor: textAnchor(src.id, src.versionHash, "fox"),
      style: { kind: "underline", color: "blue" },
    });
    const reopened = await Workbench.open(storage, brainId);
    const restored = reopened.viewFor(view.annotation.id)!;
    expect(restored.style).toEqual({ kind: "underline", color: "blue" });
  });
});
