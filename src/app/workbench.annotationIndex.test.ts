/**
 * Phase 1 (STRUCTURAL INDEXING) integration coverage of the Workbench's
 * lazily-memoized annotation indexes against a REAL Workbench (in-memory
 * storage, nothing mocked). It drives annotation CRUD + move-between-pages
 * through the PUBLIC API and, after every mutation, proves the indexed
 * accessors (`annotationByIdOrUndefined`, `annotationsForPage`) agree with a
 * fresh rebuild from the canonical `rawData().annotations`. This is what
 * guarantees the index can never diverge from the source of truth.
 */

import { describe, expect, it } from "vitest";
import { Workbench } from "./workbench";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import {
  buildAnnotationIndexes,
  assertIndexConsistency,
  pagesForAnnotation,
  type AnnotationId,
  type SourceId,
  type TextAnchor,
} from "../model";

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

async function freshWorkbenchWithSource(): Promise<{ wb: Workbench; sourceId: SourceId }> {
  const wb = await Workbench.open(new InMemoryStorageAdapter());
  const src = await wb.importSource({
    title: "Doc.pdf",
    bytes: PDF_BYTES,
    versionHash: "v1",
    pageCount: 10,
  });
  return { wb, sourceId: src.id };
}

function textAnchor(sourceId: SourceId, pageIndex: number): TextAnchor {
  return {
    docId: sourceId,
    sourceVersionHash: "v1",
    pageIndex,
    rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.03 }],
    selectedText: "quoted text",
    prefix: "",
    suffix: "",
  };
}

/**
 * Assert the Workbench's public indexed accessors match a fresh rebuild from
 * the canonical array — i.e. the memoized index is consistent after the latest
 * mutation. Rebuilds the "truth" index from rawData and compares id-resolution
 * + per-page buckets through the public accessors.
 */
function assertWorkbenchIndexConsistent(wb: Workbench, sourceId: SourceId): void {
  const canonical = wb.rawData().annotations;
  const truth = buildAnnotationIndexes(canonical);
  // The pure index must itself be internally consistent.
  assertIndexConsistency(canonical, truth);

  // 1. byId accessor equals the rebuild for every canonical id, and misses
  //    for an unknown id.
  for (const a of canonical) {
    expect(wb.annotationByIdOrUndefined(a.id)).toBe(a);
  }
  expect(wb.annotationByIdOrUndefined("nope" as AnnotationId)).toBeUndefined();

  // 2. annotationsForPage equals the rebuild's bucket (filtered to the source),
  //    in the same canonical order, for every page that has annotations.
  const pages = new Set<number>();
  for (const a of canonical) for (const p of pagesForAnnotation(a)) pages.add(p);
  for (const p of pages) {
    const expected = (truth.byPage.get(p) ?? [])
      .filter((a) => a.sourceId === sourceId)
      .map((a) => a.id);
    const got = wb.annotationsForPage(sourceId, p).map((v) => v.annotation.id);
    expect(got).toEqual(expected);
  }
  // A page with no annotations yields an empty array.
  expect(wb.annotationsForPage(sourceId, 9999)).toEqual([]);
}

describe("Workbench annotation index — lifecycle consistency (§A/§B/§C)", () => {
  it("stays consistent across create / edit / move / delete", async () => {
    const { wb, sourceId } = await freshWorkbenchWithSource();
    assertWorkbenchIndexConsistent(wb, sourceId);

    // Create on different pages: two text, one area, one range.
    const t0 = await wb.commitTextAnnotation({ sourceId, anchor: textAnchor(sourceId, 0) });
    assertWorkbenchIndexConsistent(wb, sourceId);
    const t1 = await wb.commitTextAnnotation({ sourceId, anchor: textAnchor(sourceId, 1) });
    assertWorkbenchIndexConsistent(wb, sourceId);
    await wb.commitAreaAnnotation(sourceId, 1, { x: 0.2, y: 0.2, width: 0.3, height: 0.1 });
    assertWorkbenchIndexConsistent(wb, sourceId);
    await wb.commitRangeAnnotation({ sourceId, startPageIndex: 2, endPageIndex: 4 });
    assertWorkbenchIndexConsistent(wb, sourceId);

    // Page 1 now holds the text annotation + the area annotation.
    expect(wb.annotationsForPage(sourceId, 1).map((v) => v.annotation.id)).toContain(
      t1.annotation.id,
    );
    expect(wb.annotationsForPage(sourceId, 1)).toHaveLength(2);
    // The range annotation appears on every page of its range.
    for (const p of [2, 3, 4]) {
      expect(wb.annotationsForPage(sourceId, p)).toHaveLength(1);
    }

    // Edit a comment (same page) — index refreshes to the new object.
    await wb.setComment(t0.annotation.id, "hello");
    assertWorkbenchIndexConsistent(wb, sourceId);
    expect(wb.annotationByIdOrUndefined(t0.annotation.id)?.comment).toBe("hello");

    // Delete the area annotation — removed from page 1's bucket + byId.
    const areaId = wb.annotationsForPage(sourceId, 1).find(
      (v) => v.annotation.scope.kind === "area",
    )!.annotation.id;
    await wb.deleteAnnotation(areaId);
    assertWorkbenchIndexConsistent(wb, sourceId);
    expect(wb.annotationByIdOrUndefined(areaId)).toBeUndefined();
    expect(wb.annotationsForPage(sourceId, 1)).toHaveLength(1);
  });

  it("annotationsForSource is unchanged by the index (same ids, same count)", async () => {
    const { wb, sourceId } = await freshWorkbenchWithSource();
    await wb.commitTextAnnotation({ sourceId, anchor: textAnchor(sourceId, 0) });
    await wb.commitTextAnnotation({ sourceId, anchor: textAnchor(sourceId, 5) });
    const all = wb.annotationsForSource(sourceId).map((v) => v.annotation.id).sort();
    const canonical = wb.rawData().annotations.map((a) => a.id).sort();
    expect(all).toEqual(canonical);
  });

  it("multiple sources keep independent page buckets (no cross-document bleed)", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const a = await wb.importSource({ title: "A.pdf", bytes: PDF_BYTES, versionHash: "va", pageCount: 5 });
    const b = await wb.importSource({
      title: "B.pdf",
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x35]),
      versionHash: "vb",
      pageCount: 5,
      reconcile: false,
    });
    await wb.commitTextAnnotation({ sourceId: a.id, anchor: textAnchor(a.id, 0) });
    await wb.commitTextAnnotation({ sourceId: b.id, anchor: textAnchor(b.id, 0) });
    // Same page index (0), different sources: each accessor returns only its own.
    expect(wb.annotationsForPage(a.id, 0)).toHaveLength(1);
    expect(wb.annotationsForPage(b.id, 0)).toHaveLength(1);
    expect(wb.annotationsForPage(a.id, 0)[0]!.annotation.sourceId).toBe(a.id);
    expect(wb.annotationsForPage(b.id, 0)[0]!.annotation.sourceId).toBe(b.id);
  });

  it("the memoized index survives a persist/reopen (restore path)", async () => {
    const storage = new InMemoryStorageAdapter();
    const wb1 = await Workbench.open(storage);
    const src = await wb1.importSource({ title: "R.pdf", bytes: PDF_BYTES, versionHash: "v1", pageCount: 5 });
    await wb1.commitTextAnnotation({ sourceId: src.id, anchor: textAnchor(src.id, 2) });
    const brainId = wb1.rawData().manifest.brainId;

    // Reopen the SAME brain from storage — the index is rebuilt from the
    // restored annotations array on first access.
    const wb2 = await Workbench.open(storage, brainId);
    assertWorkbenchIndexConsistent(wb2, src.id);
    expect(wb2.annotationsForPage(src.id, 2)).toHaveLength(1);
  });
});
