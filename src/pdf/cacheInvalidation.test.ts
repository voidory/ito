import { describe, expect, it, vi } from "vitest";
import { InMemoryPdfAnalysisStore } from "../storage/pdfAnalysisStore";
import { createManifest, validateCache, type PdfPageAnalysis } from "./analysisCache";
import { createIngestionController, openWithCache, type PageAnalyzer } from "./ingestPipeline";
import { PdfPerfCollector } from "./instrumentation";

function pageAnalysis(n: number): PdfPageAnalysis {
  return { pageNumber: n, width: 600, height: 800, rotation: 0, text: { content: `p${n}`, items: [] }, geometry: { textRects: [] } };
}

const manifest = (id: string, pages: number) =>
  createManifest({ documentId: id, sourceFingerprint: `fp-${id}`, fileSize: 1, pageCount: pages });

describe("zoom / scroll / reopen do NOT re-analyse (§12/§20 cases 13/14)", () => {
  it("re-validating a complete cache is a pure O(1) read with no analysis", async () => {
    const store = new InMemoryPdfAnalysisStore();
    const analyze = vi.fn<PageAnalyzer>(async (n) => pageAnalysis(n));
    const m = manifest("doc-Z", 4);
    await openWithCache({
      store,
      documentId: "doc-Z",
      freshManifest: m,
      analyzePage: analyze,
      controller: createIngestionController(),
    });
    expect(analyze).toHaveBeenCalledTimes(4);

    const pageWritesAfterCold = store.counts.pageWrites;
    analyze.mockClear();

    // Simulate many "reopen / zoom / scroll" re-validations. Semantic analysis
    // is keyed on identity + version, which are unchanged, so every one is a
    // HIT with ZERO analyzer calls and ZERO new page writes.
    for (let i = 0; i < 10; i++) {
      const stored = await store.readManifest("doc-Z");
      const v = validateCache(stored, { sourceFingerprint: m.sourceFingerprint, pageCount: 4 });
      expect(v.kind).toBe("hit");
    }
    expect(analyze).toHaveBeenCalledTimes(0);
    expect(store.counts.pageWrites).toBe(pageWritesAfterCold);
  });

  it("a changed analysis version forces reprocessing but unchanged identity does not (§13)", async () => {
    const store = new InMemoryPdfAnalysisStore();
    const m = manifest("doc-V", 2);
    await openWithCache({
      store,
      documentId: "doc-V",
      freshManifest: m,
      analyzePage: async (n) => pageAnalysis(n),
      controller: createIngestionController(),
    });
    const stored = await store.readManifest("doc-V");
    // Same identity + current versions -> hit.
    expect(validateCache(stored, { sourceFingerprint: m.sourceFingerprint, pageCount: 2 }).kind).toBe("hit");
    // Pretend a future build bumped the analysis algorithm version.
    expect(
      validateCache(stored, {
        sourceFingerprint: m.sourceFingerprint,
        pageCount: 2,
        analysisVersion: "99.0.0",
      }).kind,
    ).toBe("miss");
  });
});

describe("performance instrumentation (§18)", () => {
  it("records cold/warm open kind, spans and a hit rate", () => {
    let t = 0;
    const perf = new PdfPerfCollector({ enabled: true, clock: () => (t += 5) });
    perf.setOpenKind("cold");
    perf.time("page-analysis", () => void 0);
    perf.setPagesAnalyzed(4);
    perf.setColdOpenMs(42);
    const snap = perf.snapshot();
    expect(snap.openKind).toBe("cold");
    expect(snap.pagesAnalyzed).toBe(4);
    expect(snap.spans.some((s) => s.name === "page-analysis")).toBe(true);
    expect(perf.hitRate()).toBe(0); // 0 hits / 1 miss

    perf.setOpenKind("warm");
    expect(perf.hitRate()).toBeCloseTo(0.5, 5); // 1 hit / 2 opens
  });

  it("is a cheap no-op when disabled", () => {
    const perf = new PdfPerfCollector({ enabled: false });
    const result = perf.time("page-analysis", () => 123);
    expect(result).toBe(123);
    expect(perf.snapshot().spans).toHaveLength(0);
    expect(perf.isEnabled()).toBe(false);
  });
});
