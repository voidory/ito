/**
 * M6 (A24, D10) Zotero bundle parser + idempotent Workbench import.
 *
 * Part 1 exercises the PURE parser (`parseZoteroBundle`) against the three
 * accepted dialects (native Zotero JSON, BetterBibTeX JSON, RDF-as-JSON),
 * asserting each maps parent items -> Source stub (externalId) and
 * highlights/notes -> Annotation stub (externalId + parent + pageIndex + rect +
 * comment).
 *
 * Part 2 exercises `Workbench.importZoteroBundle` end-to-end against a REAL
 * Workbench (in-memory storage, nothing mocked) and proves idempotency: a
 * second import of the same bundle adds ZERO duplicate Source/Annotation
 * records and creates ZERO graph nodes (pages/relationships/categories).
 */

import { describe, expect, it } from "vitest";
import { parseZoteroBundle } from "./zotero";
import { Workbench } from "../app/workbench";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";

const ZOTERO_JSON = JSON.stringify([
  {
    key: "ITEMKEY1",
    title: "A Paper on Things",
    url: "https://example.com/paper",
    collection: "Reading",
    annotations: [
      {
        key: "ANN1",
        annotationText: "an important passage",
        annotationComment: "note about it",
        annotationPageLabel: "3",
        annotationPosition: { pageIndex: 2, rects: [[0.1, 0.1, 0.4, 0.15]] },
      },
      {
        key: "ANN2",
        annotationText: "second highlight",
        annotationPageLabel: "1",
      },
    ],
  },
]);

const BBT_JSON = JSON.stringify({
  items: [
    {
      citationKey: "smith2020",
      title: "BetterBibTeX Item",
      annotations: [
        {
          key: "BBTANN1",
          annotationText: "bbt passage",
          annotationPosition: { pageIndex: 0, rects: [[0.2, 0.2, 0.5, 0.3]] },
        },
      ],
    },
  ],
});

const RDF_JSON = JSON.stringify({
  "@graph": [
    { type: "item", id: "rdf-item-1", title: "RDF Source", url: "https://rdf.example" },
    {
      type: "annotation",
      id: "rdf-ann-1",
      parentItem: "rdf-item-1",
      annotationText: "rdf highlight",
      annotationPageLabel: "2",
    },
  ],
});

describe("parseZoteroBundle - dialects", () => {
  it("parses native Zotero JSON into Source + Annotation stubs with externalId", () => {
    const parsed = parseZoteroBundle(ZOTERO_JSON);
    expect(parsed.sources).toHaveLength(1);
    expect(parsed.sources[0]!.externalId).toBe("ITEMKEY1");
    expect(parsed.sources[0]!.title).toBe("A Paper on Things");
    expect(parsed.sources[0]!.url).toBe("https://example.com/paper");

    expect(parsed.annotations).toHaveLength(2);
    const a1 = parsed.annotations.find((a) => a.externalId === "ANN1")!;
    expect(a1.sourceExternalId).toBe("ITEMKEY1");
    expect(a1.pageIndex).toBe(2);
    expect(a1.comment).toContain("an important passage");
    expect(a1.comment).toContain("note about it");
    expect(a1.rect.width).toBeGreaterThan(0);
    // Page label "1" -> 0-based index 0 when no explicit position.
    const a2 = parsed.annotations.find((a) => a.externalId === "ANN2")!;
    expect(a2.pageIndex).toBe(0);
  });

  it("parses BetterBibTeX JSON { items: [...] }", () => {
    const parsed = parseZoteroBundle(BBT_JSON);
    expect(parsed.sources).toHaveLength(1);
    expect(parsed.sources[0]!.externalId).toBe("smith2020");
    expect(parsed.annotations).toHaveLength(1);
    expect(parsed.annotations[0]!.externalId).toBe("BBTANN1");
    expect(parsed.annotations[0]!.sourceExternalId).toBe("smith2020");
  });

  it("parses an RDF annotation bundle ({ @graph: [...] })", () => {
    const parsed = parseZoteroBundle(RDF_JSON);
    expect(parsed.sources).toHaveLength(1);
    expect(parsed.sources[0]!.externalId).toBe("rdf-item-1");
    expect(parsed.annotations).toHaveLength(1);
    expect(parsed.annotations[0]!.externalId).toBe("rdf-ann-1");
    expect(parsed.annotations[0]!.sourceExternalId).toBe("rdf-item-1");
    expect(parsed.annotations[0]!.pageIndex).toBe(1);
  });

  it("throws on unparseable / empty payloads", () => {
    expect(() => parseZoteroBundle("{not json")).toThrow();
    expect(() => parseZoteroBundle("[]")).toThrow();
  });
});

describe("Workbench.importZoteroBundle - idempotency (A24, D10)", () => {
  it("maps items -> Source(externalId) and highlights -> Annotation(externalId)", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const result = await wb.importZoteroBundle(ZOTERO_JSON);

    expect(result.sourcesAdded).toBe(1);
    expect(result.annotationsAdded).toBe(2);
    const data = wb.rawData();
    expect(data.sources).toHaveLength(1);
    expect(data.sources[0]!.externalId).toBe("ITEMKEY1");
    expect(data.annotations).toHaveLength(2);
    expect(data.annotations.every((a) => a.externalId != null)).toBe(true);
    expect(data.annotations.every((a) => a.scope.kind === "area")).toBe(true);
  });

  it("re-importing the same bundle creates ZERO duplicates and ZERO graph nodes", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    await wb.importZoteroBundle(ZOTERO_JSON);
    const graphBefore = {
      pages: wb.rawData().pages.length,
      relationships: wb.rawData().relationships.length,
      categories: wb.rawData().categories.length,
    };

    const second = await wb.importZoteroBundle(ZOTERO_JSON);
    expect(second.sourcesAdded).toBe(0);
    expect(second.annotationsAdded).toBe(0);
    expect(second.sourcesUpdated).toBe(1);
    expect(second.annotationsUpdated).toBe(2);

    const data = wb.rawData();
    // No duplicate Source / Annotation records.
    expect(data.sources).toHaveLength(1);
    expect(data.annotations).toHaveLength(2);
    // Zero auto-created graph nodes.
    expect(data.pages).toHaveLength(graphBefore.pages);
    expect(data.relationships).toHaveLength(graphBefore.relationships);
    expect(data.categories).toHaveLength(graphBefore.categories);
  });
});
