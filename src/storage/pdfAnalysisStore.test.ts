import { describe, expect, it } from "vitest";
import { InMemoryPdfAnalysisStore, pageKey } from "./pdfAnalysisStore";
import { createManifest, type PdfPageAnalysis } from "../pdf/analysisCache";

function page(n: number): PdfPageAnalysis {
  return {
    pageNumber: n,
    width: 600,
    height: 800,
    rotation: 0,
    text: { content: `p${n}`, items: [] },
    geometry: { textRects: [] },
  };
}

describe("pageKey", () => {
  it("is unique per (document, page)", () => {
    expect(pageKey("doc", 1)).toBe("doc#1");
    expect(pageKey("doc", 2)).not.toBe(pageKey("doc", 1));
    expect(pageKey("a", 1)).not.toBe(pageKey("b", 1));
  });
});

describe("InMemoryPdfAnalysisStore (§14)", () => {
  it("stores and reads a manifest + pages independently", async () => {
    const store = new InMemoryPdfAnalysisStore();
    const m = createManifest({
      documentId: "d1",
      sourceFingerprint: "fp",
      fileSize: 1,
      pageCount: 3,
    });
    await store.writeManifest(m);
    await store.writePage("d1", page(1));
    await store.writePage("d1", page(2));

    expect((await store.readManifest("d1"))?.pageCount).toBe(3);
    expect((await store.readPage("d1", 1))?.text?.content).toBe("p1");
    expect(await store.readPage("d1", 3)).toBeNull(); // not yet written
  });

  it("deep-clones on read so stored state cannot be mutated in place", async () => {
    const store = new InMemoryPdfAnalysisStore();
    await store.writePage("d1", page(1));
    const a = await store.readPage("d1", 1);
    (a as { pageNumber: number }).pageNumber = 999;
    const b = await store.readPage("d1", 1);
    expect(b?.pageNumber).toBe(1);
  });

  it("readPages batches and returns null for absent pages", async () => {
    const store = new InMemoryPdfAnalysisStore();
    await store.writePage("d1", page(1));
    await store.writePage("d1", page(3));
    const got = await store.readPages("d1", [1, 2, 3]);
    expect(got.map((p) => p?.pageNumber ?? null)).toEqual([1, null, 3]);
  });

  it("deleteDocument removes the manifest and every page", async () => {
    const store = new InMemoryPdfAnalysisStore();
    const m = createManifest({ documentId: "d1", sourceFingerprint: "fp", fileSize: 1, pageCount: 2 });
    await store.writeManifest(m);
    await store.writePage("d1", page(1));
    await store.writePage("d1", page(2));
    await store.deleteDocument("d1");
    expect(await store.readManifest("d1")).toBeNull();
    expect(await store.readPage("d1", 1)).toBeNull();
    expect(store._pageCount()).toBe(0);
  });

  it("keeps separate documents isolated (§20 case 8)", async () => {
    const store = new InMemoryPdfAnalysisStore();
    await store.writeManifest(
      createManifest({ documentId: "a", sourceFingerprint: "fa", fileSize: 1, pageCount: 1 }),
    );
    await store.writeManifest(
      createManifest({ documentId: "b", sourceFingerprint: "fb", fileSize: 1, pageCount: 1 }),
    );
    await store.writePage("a", page(1));
    await store.writePage("b", page(1));
    await store.deleteDocument("a");
    expect(await store.readManifest("a")).toBeNull();
    expect(await store.readManifest("b")).not.toBeNull();
    expect(await store.readPage("b", 1)).not.toBeNull();
  });
});
