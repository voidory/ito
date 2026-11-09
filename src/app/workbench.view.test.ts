/**
 * FEAT-005 — Files / Nodes view-switch + N06 placeholder domain tests (Vitest).
 *
 * These assert, through the real Workbench + in-memory storage (nothing mocked)
 * and the pure `filterGraphToScope` helper the NodesCanvas renders from, the
 * headless logic behind the §3.3 view switch so correctness is provable without
 * a browser (the Playwright spec covers the real DOM in the publishing env):
 *
 *  - `setViewMode` round-trips in the snapshot and defaults to 'files';
 *  - `categoryScope` is shared across a Files<->Nodes switch (one source of
 *    truth on the Workbench, carried unchanged);
 *  - N06: `sourceIsConnected` is false for a freshly imported, never-cited PDF
 *    and `nodePlaceholderFor` creates ZERO Page/Relationship/Category records
 *    and performs no mutation — the unit-level N06 guarantee;
 *  - the category-scope graph filter keeps only the scoped category's members
 *    plus overlapping categories (the Nodes-with-a-category view).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { Workbench } from "./workbench";
import { filterGraphToScope } from "./NodesCanvas";
import type { AnnotationId, PageId, Source, SourceId, TextAnchor } from "../model";

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

async function importOne(wb: Workbench, title: string, category = "Papers"): Promise<Source> {
  return wb.importSource({
    title,
    bytes: new Uint8Array([1, 2, 3, 4]),
    versionHash: "hash-" + title,
    pageCount: 3,
    category,
  });
}

describe("FEAT-005 — top-level Files/Nodes view mode", () => {
  let wb: Workbench;
  beforeEach(async () => {
    wb = await Workbench.open(new InMemoryStorageAdapter());
  });

  it("defaults to 'files' and round-trips setViewMode in the snapshot", () => {
    expect(wb.viewMode()).toBe("files");
    expect(wb.snapshot().viewMode).toBe("files");
    expect(wb.snapshot().nodesViewActive).toBe(false);

    wb.setViewMode("nodes");
    expect(wb.viewMode()).toBe("nodes");
    expect(wb.snapshot().viewMode).toBe("nodes");
    // The transient FEAT-004 flag now derives from the formal view mode.
    expect(wb.snapshot().nodesViewActive).toBe(true);

    wb.setViewMode("files");
    expect(wb.snapshot().viewMode).toBe("files");
    expect(wb.snapshot().nodesViewActive).toBe(false);
  });

  it("keeps the legacy setNodesViewActive in lockstep with viewMode", () => {
    wb.setNodesViewActive(true);
    expect(wb.viewMode()).toBe("nodes");
    wb.setNodesViewActive(false);
    expect(wb.viewMode()).toBe("files");
  });

  it("shares categoryScope across a Files<->Nodes switch (no record change)", async () => {
    await importOne(wb, "Alpha", "Papers");
    const before = wb.snapshot();

    wb.setCategoryScope("Papers");
    wb.setViewMode("nodes");
    expect(wb.snapshot().categoryScope).toBe("Papers");
    expect(wb.snapshot().viewMode).toBe("nodes");

    // Switching back to Files must carry the SAME scope (single source of truth).
    wb.setViewMode("files");
    expect(wb.snapshot().categoryScope).toBe("Papers");

    // The view switch + scope carry wrote NO durable records.
    const after = wb.snapshot();
    expect({ pages: after.pages.length }).toEqual({ pages: before.pages.length });
    const d = wb.rawData();
    expect(d.pages.length).toBe(0);
    expect(d.relationships.length).toBe(0);
    expect(d.categories.length).toBe(0);
  });
});

describe("FEAT-005 — N06 unconnected-PDF placeholder (zero records)", () => {
  let wb: Workbench;
  beforeEach(async () => {
    wb = await Workbench.open(new InMemoryStorageAdapter());
  });

  it("a freshly imported PDF is unconnected and its placeholder is transient", async () => {
    const source = await importOne(wb, "Lonely Paper");
    expect(wb.sourceIsConnected(source.id)).toBe(false);

    const placeholder = wb.nodePlaceholderFor(source.id);
    expect(placeholder.transient).toBe(true);
    expect(placeholder.sourceId).toBe(source.id);
    expect(placeholder.title).toContain("Lonely Paper");
    expect(placeholder.title.toLowerCase()).toContain("not connected");
  });

  it("nodePlaceholderFor creates ZERO Page/Relationship/Category records and no DB write", async () => {
    const source = await importOne(wb, "Lonely Paper");
    const before = { ...wb.rawData() };
    const beforeCounts = {
      pages: before.pages.length,
      relationships: before.relationships.length,
      categories: before.categories.length,
    };

    // Produce the placeholder repeatedly — it is pure/ephemeral.
    wb.nodePlaceholderFor(source.id);
    wb.nodePlaceholderFor(source.id);
    wb.setViewMode("nodes");
    wb.nodePlaceholderFor(source.id);

    const after = wb.rawData();
    expect({
      pages: after.pages.length,
      relationships: after.relationships.length,
      categories: after.categories.length,
    }).toEqual(beforeCounts);
    expect(after.pages.length).toBe(0);
    expect(after.relationships.length).toBe(0);
    expect(after.categories.length).toBe(0);
    // No persistence happened: the publication revision is unchanged by reads.
    expect(after.manifest.publicationRevision).toBe(before.manifest.publicationRevision);
  });

  it("a PDF becomes connected once one of its annotations is cited into a subject", async () => {
    const source = await importOne(wb, "Cited Paper");
    expect(wb.sourceIsConnected(source.id)).toBe(false);

    const view = await wb.commitTextAnnotation({
      sourceId: source.id,
      anchor: textAnchor(source.id, source.versionHash, "quick brown fox"),
    });
    // An annotation ALONE does not connect the source (no participating page).
    expect(wb.sourceIsConnected(source.id)).toBe(false);

    await wb.createSubjectFromAnnotation("Subject", view.annotation.id as AnnotationId);
    // Now there is an EvidenceInstance pointing at a Page: the source participates.
    expect(wb.sourceIsConnected(source.id)).toBe(true);
  });
});

describe("FEAT-005 — category-scope graph filter (Nodes with a category)", () => {
  let wb: Workbench;
  beforeEach(async () => {
    wb = await Workbench.open(new InMemoryStorageAdapter());
  });

  it("no scope returns the whole graph; a scope keeps members + overlapping categories", async () => {
    // Build three subject pages (nodes) and three categories:
    //  - Ecology: {p1, p2}
    //  - Economics: {p2, p3}  (overlaps Ecology via p2)
    //  - History: {p4}        (disjoint from Ecology)
    const p1 = await wb.createSubjectPage("Species");
    const p2 = await wb.createSubjectPage("Climate");
    const p3 = await wb.createSubjectPage("Markets");
    const p4 = await wb.createSubjectPage("Rome");

    const ecology = await wb.createCategory("Ecology", undefined, [p1.id, p2.id] as PageId[]);
    const economics = await wb.createCategory("Economics", undefined, [
      p2.id,
      p3.id,
    ] as PageId[]);
    const history = await wb.createCategory("History", undefined, [p4.id] as PageId[]);

    const graph = wb.conceptGraph();

    // No scope: the GLOBAL network (everything).
    const all = filterGraphToScope(graph, null);
    expect(all.nodes.length).toBe(4);
    expect(all.categories.length).toBe(3);

    // Scope = Ecology: keep Ecology + Economics (overlap via p2), drop History.
    const scoped = filterGraphToScope(graph, "Ecology");
    const keptCatIds = scoped.categories.map((c) => c.categoryId).sort();
    expect(keptCatIds).toEqual([ecology.id, economics.id].sort());
    expect(keptCatIds).not.toContain(history.id);
    // Nodes kept = members of Ecology + Economics = {p1, p2, p3}; History's p4 is out.
    const keptNodeIds = scoped.nodes.map((n) => n.pageId).sort();
    expect(keptNodeIds).toEqual([p1.id, p2.id, p3.id].sort());
    expect(keptNodeIds).not.toContain(p4.id);
  });

  it("an unknown scope yields an empty graph rather than the global one", async () => {
    await wb.createSubjectPage("Only");
    const graph = wb.conceptGraph();
    const scoped = filterGraphToScope(graph, "DoesNotExist");
    expect(scoped.nodes.length).toBe(0);
    expect(scoped.categories.length).toBe(0);
    expect(scoped.links.length).toBe(0);
  });
});

describe("Ruling 2 (N06, §7.2) — a placeholder per open UNCONNECTED source", () => {
  let wb: Workbench;
  beforeEach(async () => {
    wb = await Workbench.open(new InMemoryStorageAdapter());
  });

  /** The headless mirror of what NodesView renders: one placeholder per open
   *  unconnected source. */
  function openUnconnectedPlaceholders(bench: Workbench): ReturnType<Workbench["nodePlaceholderFor"]>[] {
    return bench
      .snapshot()
      .openSourceIds.filter((id) => !bench.sourceIsConnected(id))
      .map((id) => bench.nodePlaceholderFor(id));
  }

  function graphRecordCount(bench: Workbench): {
    pages: number;
    relationships: number;
    categories: number;
  } {
    const d = bench.rawData();
    return {
      pages: d.pages.length,
      relationships: d.relationships.length,
      categories: d.categories.length,
    };
  }

  it("renders a placeholder for EVERY unconnected source opened together (not just one)", async () => {
    const s1 = await importOne(wb, "First");
    const s2 = await importOne(wb, "Second");
    const s3 = await importOne(wb, "Third");
    wb.openTogether([s1.id, s2.id, s3.id]);
    wb.setViewMode("nodes");

    const placeholders = openUnconnectedPlaceholders(wb);
    expect(placeholders).toHaveLength(3);
    expect(placeholders.map((p) => p.sourceId).sort()).toEqual(
      [s1.id, s2.id, s3.id].sort(),
    );
    for (const p of placeholders) expect(p.transient).toBe(true);
    // Producing placeholders creates ZERO durable records.
    expect(graphRecordCount(wb)).toEqual({ pages: 0, relationships: 0, categories: 0 });
  });

  it("still yields exactly one placeholder for a single open unconnected source", async () => {
    const s1 = await importOne(wb, "Solo");
    wb.openSource(s1.id);
    wb.setViewMode("nodes");
    const placeholders = openUnconnectedPlaceholders(wb);
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0]!.sourceId).toBe(s1.id);
  });

  it("connecting ONE source drops its placeholder while the other remains; zero records during the placeholder flow", async () => {
    const s1 = await importOne(wb, "Will Connect");
    const s2 = await importOne(wb, "Stays Unconnected");
    wb.openTogether([s1.id, s2.id]);
    wb.setViewMode("nodes");

    // Both are unconnected: two placeholders, zero durable records so far.
    expect(openUnconnectedPlaceholders(wb).map((p) => p.sourceId).sort()).toEqual(
      [s1.id, s2.id].sort(),
    );
    expect(graphRecordCount(wb)).toEqual({ pages: 0, relationships: 0, categories: 0 });

    // Explicitly connect s1 by citing one of its annotations into a subject
    // page (this is a DELIBERATE user action that DOES create a Page — the N06
    // placeholder flow itself created nothing).
    const view = await wb.commitTextAnnotation({
      sourceId: s1.id,
      anchor: textAnchor(s1.id, s1.versionHash, "quick brown fox"),
    });
    await wb.createSubjectFromAnnotation("Subject", view.annotation.id as AnnotationId);

    // s1 is now connected => its placeholder is gone; s2 still shows one.
    const remaining = openUnconnectedPlaceholders(wb);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.sourceId).toBe(s2.id);
    expect(wb.sourceIsConnected(s1.id)).toBe(true);
    expect(wb.sourceIsConnected(s2.id)).toBe(false);

    // Re-producing the placeholder for the still-unconnected source creates no
    // NEW records (count only changed by the deliberate citation, +1 page).
    const before = graphRecordCount(wb);
    openUnconnectedPlaceholders(wb);
    expect(graphRecordCount(wb)).toEqual(before);
  });
});
