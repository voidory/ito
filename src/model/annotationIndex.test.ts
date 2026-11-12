import { describe, expect, it } from "vitest";
import type { Annotation, AnnotationId } from "./index";
import {
  assertIndexConsistency,
  annotationsOnPage,
  buildAnnotationById,
  buildAnnotationIndexes,
  buildAnnotationsByPage,
  indexAddAnnotation,
  indexRemoveAnnotation,
  indexUpdateAnnotation,
  pagesForAnnotation,
} from "./annotationIndex";

// ---------------------------------------------------------------------------
// Fixtures — minimal valid annotations of each scope kind.
// ---------------------------------------------------------------------------

let seq = 0;
function id(): AnnotationId {
  seq += 1;
  return `ann_${seq}` as AnnotationId;
}

function textAnn(pageIndex: number, annId: AnnotationId = id()): Annotation {
  return {
    id: annId,
    sourceId: "src_1" as Annotation["sourceId"],
    scope: {
      kind: "text",
      anchor: {
        docId: "src_1" as Annotation["sourceId"],
        sourceVersionHash: "h",
        pageIndex,
        rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.03 }],
        selectedText: "quoted",
        prefix: "",
        suffix: "",
      },
    },
    resolution: { kind: "resolved" },
    comment: "",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

function areaAnn(pageIndex: number, annId: AnnotationId = id()): Annotation {
  return {
    id: annId,
    sourceId: "src_1" as Annotation["sourceId"],
    scope: {
      kind: "area",
      anchor: {
        docId: "src_1" as Annotation["sourceId"],
        sourceVersionHash: "h",
        pageIndex,
        rect: { x: 0.2, y: 0.2, width: 0.3, height: 0.1 },
      },
    },
    resolution: { kind: "resolved" },
    comment: "",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

function rangeAnn(start: number, end: number, annId: AnnotationId = id()): Annotation {
  return {
    id: annId,
    sourceId: "src_1" as Annotation["sourceId"],
    scope: {
      kind: "pages",
      anchor: {
        docId: "src_1" as Annotation["sourceId"],
        sourceVersionHash: "h",
        startPageIndex: start,
        endPageIndex: end,
      },
    },
    resolution: { kind: "resolved" },
    comment: "",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// pagesForAnnotation — the single scope->page resolver (§C)
// ---------------------------------------------------------------------------

describe("pagesForAnnotation", () => {
  it("text scope -> one page", () => {
    expect(pagesForAnnotation(textAnn(3))).toEqual([3]);
  });
  it("area scope -> one page", () => {
    expect(pagesForAnnotation(areaAnn(5))).toEqual([5]);
  });
  it("pages scope -> inclusive range", () => {
    expect(pagesForAnnotation(rangeAnn(2, 5))).toEqual([2, 3, 4, 5]);
  });
  it("single-page range", () => {
    expect(pagesForAnnotation(rangeAnn(4, 4))).toEqual([4]);
  });
  it("degenerate inverted range -> empty", () => {
    expect(pagesForAnnotation(rangeAnn(5, 2))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Build + read (§B/§C)
// ---------------------------------------------------------------------------

describe("buildAnnotationById / byPage", () => {
  it("indexes every annotation by id with object identity", () => {
    const anns = [textAnn(0), areaAnn(1), rangeAnn(2, 3)];
    const byId = buildAnnotationById(anns);
    expect(byId.size).toBe(3);
    for (const a of anns) expect(byId.get(a.id)).toBe(a);
  });

  it("places range annotations in every page bucket of their range", () => {
    const r = rangeAnn(1, 3);
    const t = textAnn(2);
    const byPage = buildAnnotationsByPage([r, t]);
    expect(annotationsOnPage(byPage, 1).map((a) => a.id)).toEqual([r.id]);
    // Page 2 has both; canonical array order (r before t).
    expect(annotationsOnPage(byPage, 2).map((a) => a.id)).toEqual([r.id, t.id]);
    expect(annotationsOnPage(byPage, 3).map((a) => a.id)).toEqual([r.id]);
    expect(annotationsOnPage(byPage, 0)).toEqual([]);
  });

  it("preserves canonical order within a page bucket", () => {
    const a = textAnn(0);
    const b = textAnn(0);
    const c = textAnn(0);
    const byPage = buildAnnotationsByPage([a, b, c]);
    expect(annotationsOnPage(byPage, 0).map((x) => x.id)).toEqual([a.id, b.id, c.id]);
  });

  it("annotationsOnPage returns a copy (never the shared bucket ref)", () => {
    const byPage = buildAnnotationsByPage([textAnn(0)]);
    const first = annotationsOnPage(byPage, 0);
    first.push(textAnn(0));
    expect(annotationsOnPage(byPage, 0)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle via incremental helpers, asserting consistency after EACH
// mutation (§A lifecycle 1-12, §B/§C invariants).
// ---------------------------------------------------------------------------

describe("lifecycle consistency (incremental helpers always match a full rebuild)", () => {
  it("add / retrieve / edit / move / delete keep indexes consistent", () => {
    const canonical: Annotation[] = [];
    const indexes = buildAnnotationIndexes(canonical);

    // 3. Create annotations on different pages.
    const t0 = textAnn(0);
    const a1 = areaAnn(1);
    const r = rangeAnn(2, 4);
    for (const a of [t0, a1, r]) {
      canonical.push(a);
      indexAddAnnotation(indexes, a);
      assertIndexConsistency(canonical, indexes);
    }

    // 4. Retrieve by ID.
    expect(indexes.byId.get(t0.id)).toBe(t0);
    expect(indexes.byId.get(a1.id)).toBe(a1);

    // 5. Retrieve all annotations on one page (page 3 is inside the range only).
    expect(annotationsOnPage(indexes.byPage, 3).map((a) => a.id)).toEqual([r.id]);
    expect(annotationsOnPage(indexes.byPage, 0).map((a) => a.id)).toEqual([t0.id]);

    // 6. Edit an annotation (comment change, same page) — reference refreshes.
    const t0Edited: Annotation = { ...t0, comment: "edited" };
    canonical[0] = t0Edited;
    indexUpdateAnnotation(indexes, t0, t0Edited);
    assertIndexConsistency(canonical, indexes);
    expect(indexes.byId.get(t0.id)).toBe(t0Edited);
    expect(annotationsOnPage(indexes.byPage, 0)[0]).toBe(t0Edited);

    // 7. Move an annotation to another page (page 0 -> page 5).
    const t0Moved: Annotation = {
      ...t0Edited,
      scope: { kind: "text", anchor: { ...(t0Edited.scope as { anchor: { pageIndex: number } }).anchor, pageIndex: 5 } as never },
    };
    canonical[0] = t0Moved;
    indexUpdateAnnotation(indexes, t0Edited, t0Moved);
    assertIndexConsistency(canonical, indexes);
    expect(annotationsOnPage(indexes.byPage, 0)).toEqual([]); // removed from old
    expect(annotationsOnPage(indexes.byPage, 5).map((a) => a.id)).toEqual([t0.id]); // on new

    // Move a RANGE annotation (resize 2..4 -> 3..5): buckets 2 drops, 5 adds.
    const rResized: Annotation = {
      ...r,
      scope: { kind: "pages", anchor: { ...(r.scope as { anchor: object }).anchor, startPageIndex: 3, endPageIndex: 5 } as never },
    };
    canonical[2] = rResized;
    indexUpdateAnnotation(indexes, r, rResized);
    assertIndexConsistency(canonical, indexes);
    expect(annotationsOnPage(indexes.byPage, 2)).toEqual([]);
    expect(annotationsOnPage(indexes.byPage, 3).map((a) => a.id)).toEqual([r.id]);

    // 8. Delete an annotation.
    canonical.splice(1, 1); // remove a1
    indexRemoveAnnotation(indexes, a1);
    assertIndexConsistency(canonical, indexes);
    expect(indexes.byId.has(a1.id)).toBe(false);
    expect(annotationsOnPage(indexes.byPage, 1)).toEqual([]);
  });

  it("deleting one of several annotations on a page keeps the rest (no dup, no stale)", () => {
    const canonical = [textAnn(0), textAnn(0), textAnn(0)];
    const indexes = buildAnnotationIndexes(canonical);
    const middle = canonical[1]!;
    canonical.splice(1, 1);
    indexRemoveAnnotation(indexes, middle);
    assertIndexConsistency(canonical, indexes);
    expect(annotationsOnPage(indexes.byPage, 0).map((a) => a.id)).toEqual([
      canonical[0]!.id,
      canonical[1]!.id,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Invariant violations are detected (proves assertIndexConsistency is real).
// ---------------------------------------------------------------------------

describe("assertIndexConsistency detects divergence", () => {
  it("throws when byId holds a stale id", () => {
    const canonical = [textAnn(0)];
    const indexes = buildAnnotationIndexes(canonical);
    indexes.byId.set("ghost" as AnnotationId, textAnn(9));
    expect(() => assertIndexConsistency(canonical, indexes)).toThrow();
  });

  it("throws when a page bucket is missing an annotation", () => {
    const canonical = [textAnn(0), textAnn(0)];
    const indexes = buildAnnotationIndexes(canonical);
    indexes.byPage.set(0, [canonical[0]!]); // drop the second
    expect(() => assertIndexConsistency(canonical, indexes)).toThrow();
  });

  it("throws on a duplicate within a bucket", () => {
    const canonical = [textAnn(0)];
    const indexes = buildAnnotationIndexes(canonical);
    indexes.byPage.set(0, [canonical[0]!, canonical[0]!]);
    expect(() => assertIndexConsistency(canonical, indexes)).toThrow();
  });
});
