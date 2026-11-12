/**
 * Automatic History logging is opt-in (the app turns it on). When on, the
 * user-meaningful mutations each leave a Revision so the History timeline is
 * never empty after real use; when off, a Workbench records only what it is
 * explicitly asked to.
 */
import { describe, expect, it } from "vitest";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { Workbench } from "./workbench";

describe("auto history", () => {
  it("records nothing by default", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    await wb.createSubjectPage("A");
    await wb.createCategory("C");
    expect(wb.revisions()).toHaveLength(0);
  });

  it("logs pages, categories, connections and comments when enabled", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    wb.enableAutoHistory();
    const a = await wb.createSubjectPage("Alpha");
    const b = await wb.createSubjectPage("Beta");
    const cat = await wb.createCategory("Theme");
    await wb.addPageToCategory(cat.id, a.id);
    await wb.createRelationship([a.id, b.id]);

    const kinds = wb.revisions().map((r) => r.kind);
    expect(kinds).toEqual(["other", "other", "category", "category", "relationship"]);
    expect(wb.revisions()[0]!.summary).toContain("Alpha");
    // Every revision is stamped with a day key so the timeline can group it.
    expect(wb.revisions().every((r) => !!r.dateKey)).toBe(true);
  });

  it("does not log a comment save that changes nothing", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const src = await wb.importSource({
      title: "D",
      bytes: new Uint8Array([1, 2, 3]),
      versionHash: "h",
      pageCount: 1,
    });
    const ann = await wb.commitAreaAnnotation(src.id, 0, { x: 0, y: 0, width: 0.1, height: 0.1 });
    wb.enableAutoHistory();
    await wb.setComment(ann.annotation.id, "");
    expect(wb.revisions()).toHaveLength(0);
    await wb.setComment(ann.annotation.id, "note");
    expect(wb.revisions().map((r) => r.kind)).toEqual(["annotation-comment"]);
  });
});
