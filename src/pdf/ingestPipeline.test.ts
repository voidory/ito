import { describe, expect, it, vi } from "vitest";
import { InMemoryPdfAnalysisStore } from "../storage/pdfAnalysisStore";
import {
  createManifest,
  type PdfPageAnalysis,
} from "./analysisCache";
import {
  createIngestionController,
  openWithCache,
  prioritizePages,
  runIngestion,
  type PageAnalyzer,
} from "./ingestPipeline";

/** A trivial deterministic page analysis for page N. */
function pageAnalysis(n: number): PdfPageAnalysis {
  return {
    pageNumber: n,
    width: 600,
    height: 800,
    rotation: 0,
    text: { content: `page ${n}`, items: [] },
    geometry: { textRects: [] },
  };
}

function manifest(documentId: string, pageCount: number) {
  return createManifest({
    documentId,
    sourceFingerprint: `fp-${documentId}`,
    fileSize: 100,
    pageCount,
    now: "2026-01-01T00:00:00.000Z",
  });
}

describe("prioritizePages (§9/§15)", () => {
  it("orders current page first then outward neighbours", () => {
    expect(prioritizePages([1, 2, 3, 4, 5], 3)).toEqual([3, 4, 2, 5, 1]);
  });

  it("handles current page outside the set", () => {
    expect(prioritizePages([5, 6, 7], 1)).toEqual([5, 6, 7]);
  });
});

describe("runIngestion one-pass (§4/§5/§6)", () => {
  it("analyses each page exactly once and persists incrementally (§20 cases 1/2)", async () => {
    const store = new InMemoryPdfAnalysisStore();
    const m = manifest("doc-A", 4);
    await store.writeManifest(m);
    const seen: number[] = [];
    const analyze: PageAnalyzer = async (n) => {
      seen.push(n);
      return pageAnalysis(n);
    };
    const final = await runIngestion({
      store,
      manifest: m,
      pages: [1, 2, 3, 4],
      analyzePage: analyze,
      controller: createIngestionController(),
      now: () => "2026-01-01T00:00:01.000Z",
    });
    // Each page analysed exactly once (O(n), no duplicate work).
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(final.status).toBe("complete");
    expect(final.analyzedPages).toEqual([1, 2, 3, 4]);
    // Pages persisted independently (§14): 4 page records.
    expect(store._pageCount()).toBe(4);
    const p3 = await store.readPage("doc-A", 3);
    expect(p3?.text?.content).toBe("page 3");
  });

  it("respects bounded concurrency (§15/§20 case 16)", async () => {
    const store = new InMemoryPdfAnalysisStore();
    const m = manifest("doc-C", 20);
    await store.writeManifest(m);
    let inFlight = 0;
    let maxInFlight = 0;
    const analyze: PageAnalyzer = async (n) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return pageAnalysis(n);
    };
    await runIngestion({
      store,
      manifest: m,
      pages: Array.from({ length: 20 }, (_, i) => i + 1),
      analyzePage: analyze,
      controller: createIngestionController(),
      concurrency: 3,
    });
    // Never more than the configured 3 concurrent analyses.
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it("cancellation stops starting new pages (§15/§20 case 15)", async () => {
    const store = new InMemoryPdfAnalysisStore();
    const m = manifest("doc-D", 10);
    await store.writeManifest(m);
    const controller = createIngestionController();
    let analysed = 0;
    const analyze: PageAnalyzer = async (n) => {
      analysed += 1;
      if (analysed === 2) controller.cancel();
      return pageAnalysis(n);
    };
    const final = await runIngestion({
      store,
      manifest: m,
      pages: Array.from({ length: 10 }, (_, i) => i + 1),
      analyzePage: analyze,
      controller,
      concurrency: 1,
    });
    // Stopped early: far fewer than 10 analysed, manifest not complete.
    expect(analysed).toBeLessThan(10);
    expect(final.status).not.toBe("complete");
  });
});

describe("openWithCache fast-path (§8)", () => {
  it("cold open -> ingest; warm reopen -> hit with zero analysis (§20 cases 1/3)", async () => {
    const store = new InMemoryPdfAnalysisStore();
    const fresh = manifest("doc-E", 3);
    const analyze = vi.fn<PageAnalyzer>(async (n) => pageAnalysis(n));

    // Cold open.
    const cold = await openWithCache({
      store,
      documentId: "doc-E",
      freshManifest: fresh,
      analyzePage: analyze,
      controller: createIngestionController(),
    });
    expect(cold.validation.kind).toBe("miss");
    expect(cold.manifest.status).toBe("complete");
    expect(analyze).toHaveBeenCalledTimes(3);

    // Warm reopen: identical identity -> hit, NO further analysis.
    analyze.mockClear();
    const warm = await openWithCache({
      store,
      documentId: "doc-E",
      freshManifest: fresh,
      analyzePage: analyze,
      controller: createIngestionController(),
    });
    expect(warm.validation.kind).toBe("hit");
    expect(analyze).toHaveBeenCalledTimes(0);
  });

  it("modified PDF -> fingerprint mismatch -> reanalysis (§20 case 4)", async () => {
    const store = new InMemoryPdfAnalysisStore();
    const analyze = vi.fn<PageAnalyzer>(async (n) => pageAnalysis(n));
    const v1 = manifest("doc-F", 2);
    await openWithCache({
      store,
      documentId: "doc-F",
      freshManifest: v1,
      analyzePage: analyze,
      controller: createIngestionController(),
    });
    analyze.mockClear();
    // Same documentId key but a CHANGED fingerprint (content edited in place).
    const v2 = { ...v1, sourceFingerprint: "fp-doc-F-CHANGED" };
    const r = await openWithCache({
      store,
      documentId: "doc-F",
      freshManifest: v2,
      analyzePage: analyze,
      controller: createIngestionController(),
    });
    expect(r.validation.kind).toBe("miss");
    expect(analyze).toHaveBeenCalledTimes(2); // reanalysed every page
    expect(r.manifest.sourceFingerprint).toBe("fp-doc-F-CHANGED");
  });

  it("partial ingestion resumes missing pages only (§16/§20 case 6)", async () => {
    const store = new InMemoryPdfAnalysisStore();
    const m = manifest("doc-G", 5);
    const controller = createIngestionController();
    let analysed = 0;
    const analyze: PageAnalyzer = async (n) => {
      analysed += 1;
      if (analysed === 2) controller.cancel();
      return pageAnalysis(n);
    };
    const first = await openWithCache({
      store,
      documentId: "doc-G",
      freshManifest: m,
      analyzePage: analyze,
      controller,
      concurrency: 1,
    });
    expect(first.manifest.status).not.toBe("complete");
    const persistedAfterInterrupt = first.manifest.analyzedPages.length;
    expect(persistedAfterInterrupt).toBeGreaterThan(0);
    expect(persistedAfterInterrupt).toBeLessThan(5);

    // Reopen: resume only the missing pages.
    const resumedPages: number[] = [];
    const analyze2: PageAnalyzer = async (n) => {
      resumedPages.push(n);
      return pageAnalysis(n);
    };
    const second = await openWithCache({
      store,
      documentId: "doc-G",
      freshManifest: m,
      analyzePage: analyze2,
      controller: createIngestionController(),
    });
    expect(second.validation.kind).toBe("resume");
    expect(second.manifest.status).toBe("complete");
    // Only the pages not already analysed were re-processed.
    expect(resumedPages.length).toBe(5 - persistedAfterInterrupt);
  });

  it("corrupt cache is safely rebuilt (§20 case 7)", async () => {
    const store = new InMemoryPdfAnalysisStore();
    const m = manifest("doc-H", 2);
    const analyze = vi.fn<PageAnalyzer>(async (n) => pageAnalysis(n));
    await openWithCache({
      store,
      documentId: "doc-H",
      freshManifest: m,
      analyzePage: analyze,
      controller: createIngestionController(),
    });
    // Corrupt the stored manifest.
    store._corruptManifest("doc-H", { sourceFingerprint: undefined });
    analyze.mockClear();
    const r = await openWithCache({
      store,
      documentId: "doc-H",
      freshManifest: m,
      analyzePage: analyze,
      controller: createIngestionController(),
    });
    expect(r.validation.kind).toBe("miss");
    expect(r.manifest.status).toBe("complete");
    expect(analyze).toHaveBeenCalledTimes(2);
  });

  it("multiple PDFs keep independent caches (§20 case 8)", async () => {
    const store = new InMemoryPdfAnalysisStore();
    const analyze: PageAnalyzer = async (n) => pageAnalysis(n);
    await openWithCache({
      store,
      documentId: "doc-X",
      freshManifest: manifest("doc-X", 2),
      analyzePage: analyze,
      controller: createIngestionController(),
    });
    await openWithCache({
      store,
      documentId: "doc-Y",
      freshManifest: manifest("doc-Y", 3),
      analyzePage: analyze,
      controller: createIngestionController(),
    });
    const ids = await store.listDocumentIds();
    expect(ids.sort()).toEqual(["doc-X", "doc-Y"]);
    const mx = await store.readManifest("doc-X");
    const my = await store.readManifest("doc-Y");
    expect(mx?.pageCount).toBe(2);
    expect(my?.pageCount).toBe(3);
  });
});

describe("per-page retrieval independence (§14/§20 case 9)", () => {
  it("reading one page does not read or deserialize other pages", async () => {
    const store = new InMemoryPdfAnalysisStore();
    const m = manifest("doc-P", 50);
    await store.writeManifest(m);
    await runIngestion({
      store,
      manifest: m,
      pages: Array.from({ length: 50 }, (_, i) => i + 1),
      analyzePage: async (n) => pageAnalysis(n),
      controller: createIngestionController(),
    });
    const before = store.counts.pageReads;
    const one = await store.readPage("doc-P", 42);
    expect(one?.pageNumber).toBe(42);
    // Exactly ONE page record read — not all 50.
    expect(store.counts.pageReads - before).toBe(1);
  });
});
