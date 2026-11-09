/**
 * FEAT-005 (M2-FIX-2) — Workbench search / retrieval / neighbourhood tests.
 *
 * These drive the REAL Workbench + in-memory StorageAdapter (nothing mocked):
 * the Workbench builds the search index from live BrainData — page body text
 * extracted from the stored ProseMirror doc via the editor layer, category
 * membership, and annotation anchor + comment — and delegates matching to the
 * pure src/network/search.ts. We assert every searchable field matches, the
 * categoryId filter restricts page hits, and neighborhood(pageId) returns the
 * correct 1-hop pages + relationships on a small built graph.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { Workbench } from "./workbench";
import type { DocumentJson } from "../editor";
import type { PageId, SourceId, TextAnchor } from "../model";

/** A minimal single-paragraph doc carrying `text` as body content. */
function docWithText(text: string): DocumentJson {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function textAnchor(sourceId: SourceId, selectedText: string): TextAnchor {
  return {
    docId: sourceId,
    sourceVersionHash: "v1",
    pageIndex: 0,
    rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.03 }],
    selectedText,
    prefix: "",
    suffix: "",
  };
}

async function seedSource(wb: Workbench, title: string): Promise<SourceId> {
  const src = await wb.importSource({
    title,
    bytes: new Uint8Array([1, 2, 3, 4]),
    versionHash: "v1",
    pageCount: 3,
  });
  return src.id;
}

describe("Workbench.search — matches each searchable field from live data", () => {
  let wb: Workbench;
  beforeEach(async () => {
    wb = await Workbench.open(new InMemoryStorageAdapter());
  });

  it("finds a page by its title (case-insensitive)", async () => {
    const page = await wb.createSubjectPage("Evolutionary Biology");
    const hits = wb.search("BIOLOGY");
    const hit = hits.find((h) => h.kind === "page" && h.id === page.id);
    expect(hit).toBeDefined();
    if (hit && hit.kind === "page") expect(hit.matchedField).toBe("title");
  });

  it("finds a page by its composed ProseMirror body text", async () => {
    const page = await wb.createSubjectPage("Untitled");
    await wb.saveSubjectDoc(page.id, docWithText("supply and demand curves intersect"));
    const hits = wb.search("supply and demand");
    const hit = hits.find((h) => h.kind === "page" && h.id === page.id);
    expect(hit).toBeDefined();
    if (hit && hit.kind === "page") expect(hit.matchedField).toBe("body");
  });

  it("finds a category by its name", async () => {
    const cat = await wb.createCategory("Ecology", "#4b5578");
    const hits = wb.search("ecolo");
    expect(hits.some((h) => h.kind === "category" && h.id === cat.id)).toBe(true);
  });

  it("finds an annotation by its anchor (selected) text", async () => {
    const src = await seedSource(wb, "Paper");
    wb.openSource(src);
    const view = await wb.commitTextAnnotation({
      sourceId: src,
      anchor: textAnchor(src, "natural selection"),
    });
    const hits = wb.search("natural selection");
    const hit = hits.find((h) => h.kind === "annotation" && h.id === view.annotation.id);
    expect(hit).toBeDefined();
    if (hit && hit.kind === "annotation") expect(hit.matchedField).toBe("anchor");
  });

  it("finds an annotation by its comment text", async () => {
    const src = await seedSource(wb, "Paper");
    wb.openSource(src);
    const view = await wb.commitTextAnnotation({
      sourceId: src,
      anchor: textAnchor(src, "a passage"),
    });
    await wb.setComment(view.annotation.id, "Darwin's central thesis");
    const hits = wb.search("darwin");
    const hit = hits.find((h) => h.kind === "annotation" && h.id === view.annotation.id);
    expect(hit).toBeDefined();
    if (hit && hit.kind === "annotation") expect(hit.matchedField).toBe("comment");
  });

  it("returns [] for an empty query", () => {
    expect(wb.search("")).toEqual([]);
    expect(wb.search("   ")).toEqual([]);
  });

  it("restricts page results to a category via the categoryId filter", async () => {
    const inCat = await wb.createSubjectPage("Alpha one");
    const outCat = await wb.createSubjectPage("Alpha two");
    const cat = await wb.createCategory("Theme", "#4b5578", [inCat.id]);

    const unfiltered = wb
      .search("alpha")
      .filter((h) => h.kind === "page")
      .map((h) => h.id);
    expect(unfiltered).toContain(inCat.id);
    expect(unfiltered).toContain(outCat.id);

    const filtered = wb
      .search("alpha", { categoryId: cat.id })
      .filter((h) => h.kind === "page")
      .map((h) => h.id);
    expect(filtered).toEqual([inCat.id]);
  });

  it("is deterministic — identical input yields an identical result array", async () => {
    await wb.createSubjectPage("Beta page");
    await wb.createCategory("Beta cat", "#4b5578");
    expect(wb.search("beta")).toEqual(wb.search("beta"));
  });
});

describe("Workbench.neighborhood — 1-hop connected pages + relationships", () => {
  let wb: Workbench;
  let ids: PageId[];
  beforeEach(async () => {
    wb = await Workbench.open(new InMemoryStorageAdapter());
    ids = [];
    for (const t of ["P0", "P1", "P2", "P3"]) {
      ids.push((await wb.createSubjectPage(t)).id);
    }
  });

  it("returns the direct neighbour + relationship for an N=2 edge", async () => {
    const rel = await wb.createRelationship([ids[0]!, ids[1]!]);
    const n = wb.neighborhood(ids[0]!);
    expect(n.pageIds).toEqual([ids[1]!]);
    expect(n.relationshipIds).toEqual([rel.id]);
  });

  it("returns all other endpoints for an N>=3 star edge in one hop", async () => {
    const rel = await wb.createRelationship([ids[0]!, ids[1]!, ids[2]!]);
    const n = wb.neighborhood(ids[0]!);
    expect(n.pageIds.sort()).toEqual([ids[1]!, ids[2]!].sort());
    expect(n.relationshipIds).toEqual([rel.id]);
  });

  it("excludes pages that are 2+ hops away", async () => {
    await wb.createRelationship([ids[0]!, ids[1]!]); // p0 - p1
    await wb.createRelationship([ids[1]!, ids[2]!]); // p1 - p2 (2 hops from p0)
    const n = wb.neighborhood(ids[0]!);
    expect(n.pageIds).toEqual([ids[1]!]);
    expect(n.pageIds).not.toContain(ids[2]!);
  });

  it("returns empty arrays for an unconnected page", () => {
    const n = wb.neighborhood(ids[3]!);
    expect(n.pageIds).toEqual([]);
    expect(n.relationshipIds).toEqual([]);
  });
});
