/**
 * Pure unit coverage for the search + neighbourhood module (M2-FIX-2,
 * FEAT-005). Everything here runs against the module's OWN structural input
 * types — no DOM, no Workbench — proving case-insensitive substring matching
 * across every searchable field, the empty-query guard, the categoryId filter,
 * the 1-hop neighbourhood for N=2 and N>=3 edges, and determinism.
 */

import { describe, expect, it } from "vitest";
import {
  neighborhood,
  search,
  type SearchEdge,
  type SearchIndex,
} from "./search";

function makeIndex(): SearchIndex {
  return {
    docs: [
      { pageId: "p1", title: "Evolutionary Biology", bodyText: "species adapt over time", categoryIds: ["cEco"] },
      { pageId: "p2", title: "Market Dynamics", bodyText: "supply and demand curves", categoryIds: ["cEcon"] },
      { pageId: "p3", title: "Roman History", bodyText: "the republic and the empire", categoryIds: [] },
    ],
    categories: [
      { categoryId: "cEco", name: "Ecology" },
      { categoryId: "cEcon", name: "Economics" },
    ],
    annotations: [
      { annotationId: "a1", sourceId: "s1", anchorText: "natural selection", comment: "Darwin's key idea" },
      { annotationId: "a2", sourceId: "s2", anchorText: "pp. 1-3", comment: "" },
    ],
  };
}

describe("search — case-insensitive substring matching across fields", () => {
  it("matches a Page by title (case-insensitive)", () => {
    const hits = search("BIOLOGY", makeIndex());
    const page = hits.find((h) => h.kind === "page");
    expect(page).toBeDefined();
    expect(page!.id).toBe("p1");
    if (page && page.kind === "page") expect(page.matchedField).toBe("title");
  });

  it("matches a Page by ProseMirror body text", () => {
    const hits = search("supply and demand", makeIndex());
    const page = hits.find((h) => h.kind === "page" && h.id === "p2");
    expect(page).toBeDefined();
    if (page && page.kind === "page") expect(page.matchedField).toBe("body");
  });

  it("matches a Category by name", () => {
    const hits = search("ecolo", makeIndex());
    const cat = hits.find((h) => h.kind === "category");
    expect(cat).toBeDefined();
    expect(cat!.id).toBe("cEco");
  });

  it("matches an Annotation by anchor text", () => {
    const hits = search("natural selection", makeIndex());
    const ann = hits.find((h) => h.kind === "annotation");
    expect(ann).toBeDefined();
    expect(ann!.id).toBe("a1");
    if (ann && ann.kind === "annotation") expect(ann.matchedField).toBe("anchor");
  });

  it("matches an Annotation by comment text", () => {
    const hits = search("darwin", makeIndex());
    const ann = hits.find((h) => h.kind === "annotation" && h.id === "a1");
    expect(ann).toBeDefined();
    if (ann && ann.kind === "annotation") expect(ann.matchedField).toBe("comment");
  });

  it("returns [] for an empty or whitespace-only query", () => {
    expect(search("", makeIndex())).toEqual([]);
    expect(search("   ", makeIndex())).toEqual([]);
  });

  it("orders results deterministically by kind then id", () => {
    // 'e' hits two pages, two categories, and one annotation comment.
    const first = search("e", makeIndex());
    const kinds = first.map((r) => r.kind);
    // pages first, then categories, then annotations.
    const firstCat = kinds.indexOf("category");
    const firstAnn = kinds.indexOf("annotation");
    const lastPage = kinds.lastIndexOf("page");
    if (firstCat >= 0 && lastPage >= 0) expect(lastPage).toBeLessThan(firstCat);
    if (firstAnn >= 0 && firstCat >= 0) expect(firstCat).toBeLessThan(firstAnn);
    // Identical input => identical output array.
    expect(search("e", makeIndex())).toEqual(first);
  });
});

describe("search — categoryId filter restricts page hits", () => {
  it("only returns pages that are members of the given category", () => {
    // Body text 'over' is in p1 only; but filter to Economics (cEcon) excludes it.
    const idx = makeIndex();
    const unfiltered = search("a", idx).filter((h) => h.kind === "page").map((h) => h.id);
    expect(unfiltered).toContain("p1");
    expect(unfiltered).toContain("p2");

    const filtered = search("a", idx, { categoryId: "cEcon" }).filter(
      (h) => h.kind === "page",
    );
    expect(filtered.map((h) => h.id)).toEqual(["p2"]);
  });

  it("does not filter non-page results", () => {
    const hits = search("ecolo", makeIndex(), { categoryId: "cEcon" });
    // Category 'Ecology' still matches even though we scoped pages to Economics.
    expect(hits.some((h) => h.kind === "category" && h.id === "cEco")).toBe(true);
  });
});

describe("neighborhood — 1-hop connected pages + connecting relationships", () => {
  it("returns the direct pages + relationship for an N=2 edge, excluding the origin", () => {
    const edges: SearchEdge[] = [
      { relationshipId: "r1", endpointPageIds: ["p1", "p2"] },
    ];
    const n = neighborhood("p1", edges);
    expect(n.pageIds).toEqual(["p2"]);
    expect(n.relationshipIds).toEqual(["r1"]);
  });

  it("returns ALL other endpoints of an N>=3 star edge in one hop", () => {
    const edges: SearchEdge[] = [
      { relationshipId: "r1", endpointPageIds: ["p1", "p2", "p3"] },
    ];
    const n = neighborhood("p1", edges);
    expect(n.pageIds).toEqual(["p2", "p3"]);
    expect(n.relationshipIds).toEqual(["r1"]);
  });

  it("excludes pages 2+ hops away and de-dupes across multiple edges", () => {
    const edges: SearchEdge[] = [
      { relationshipId: "r1", endpointPageIds: ["p1", "p2"] },
      { relationshipId: "r2", endpointPageIds: ["p2", "p3"] }, // p3 is 2 hops from p1
      { relationshipId: "r3", endpointPageIds: ["p1", "p2"] }, // duplicate neighbour p2
    ];
    const n = neighborhood("p1", edges);
    expect(n.pageIds).toEqual(["p2"]);
    expect(n.relationshipIds).toEqual(["r1", "r3"]);
    expect(n.pageIds).not.toContain("p3");
  });

  it("returns empty arrays for a page with no edges", () => {
    const n = neighborhood("pX", [{ relationshipId: "r1", endpointPageIds: ["p1", "p2"] }]);
    expect(n.pageIds).toEqual([]);
    expect(n.relationshipIds).toEqual([]);
  });

  it("is deterministic (sorted) regardless of edge order", () => {
    const edgesA: SearchEdge[] = [
      { relationshipId: "r2", endpointPageIds: ["p1", "pz"] },
      { relationshipId: "r1", endpointPageIds: ["p1", "pa"] },
    ];
    const edgesB: SearchEdge[] = [...edgesA].reverse();
    expect(neighborhood("p1", edgesA)).toEqual(neighborhood("p1", edgesB));
    expect(neighborhood("p1", edgesA).pageIds).toEqual(["pa", "pz"]);
    expect(neighborhood("p1", edgesA).relationshipIds).toEqual(["r1", "r2"]);
  });
});
