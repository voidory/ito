import { describe, expect, it } from "vitest";
import {
  PDF_ANALYSIS_SCHEMA_VERSION,
  PDF_ANALYSIS_VERSION,
  computeDocumentId,
  computeHeadTailHash,
  computeSourceFingerprint,
  createManifest,
  pagesToAnalyze,
  validateCache,
  withInvalidated,
  withPageAnalyzed,
  withProcessing,
  type PdfAnalysisManifest,
} from "./analysisCache";

function fresh(pageCount: number): PdfAnalysisManifest {
  return createManifest({
    documentId: "doc-1",
    sourceFingerprint: "fp-1",
    fileSize: 1000,
    pageCount,
    now: "2026-01-01T00:00:00.000Z",
  });
}

describe("document identity (§3)", () => {
  it("head+tail hash is deterministic and sensitive to size", () => {
    const a = computeHeadTailHash(new Uint8Array([1, 2, 3, 4, 5]));
    const b = computeHeadTailHash(new Uint8Array([1, 2, 3, 4, 5]));
    expect(a).toBe(b);
    const c = computeHeadTailHash(new Uint8Array([1, 2, 3, 4, 5, 6]));
    expect(a).not.toBe(c);
  });

  it("head+tail hash does not scan the whole file for a large input", () => {
    // Two large buffers identical at head+tail+length but different in the
    // middle still collide on head+tail (documented assumption). The point is
    // it is O(window): we only assert determinism + size sensitivity here.
    const big = new Uint8Array(500_000);
    const same = computeHeadTailHash(big);
    const same2 = computeHeadTailHash(big.slice());
    expect(same).toBe(same2);
  });

  it("documentId prefers the strongest cheap signal", () => {
    expect(computeDocumentId({ fileSize: 10, contentHash: "abc" })).toBe("c:abc");
    expect(computeDocumentId({ fileSize: 10, pdfId: "PID" })).toBe("p:PID:10");
    expect(computeDocumentId({ fileSize: 10, headTailHash: "ht" })).toBe("h:ht");
    expect(computeDocumentId({ fileSize: 10 })).toBe("s:10");
  });

  it("sourceFingerprint binds every available signal", () => {
    const fp = computeSourceFingerprint({ fileSize: 10, contentHash: "abc", pdfId: "P" });
    expect(fp).toContain("size=10");
    expect(fp).toContain("content=abc");
    expect(fp).toContain("id=P");
  });

  it("same bytes -> same id; different bytes -> different id (§20 cases 1/3/4)", () => {
    const idA = computeDocumentId({ fileSize: 10, contentHash: "aaaa" });
    const idASecond = computeDocumentId({ fileSize: 10, contentHash: "aaaa" });
    const idB = computeDocumentId({ fileSize: 10, contentHash: "bbbb" });
    expect(idA).toBe(idASecond); // same PDF reopened -> cache hit key
    expect(idA).not.toBe(idB); // modified PDF -> cache miss key
  });
});

describe("validateCache invalidation policy (§12/§13)", () => {
  const current = { sourceFingerprint: "fp-1", pageCount: 3 };

  it("absent manifest is a miss", () => {
    expect(validateCache(null, current)).toEqual({ kind: "miss", reason: "absent" });
  });

  it("complete + matching + all pages present is a hit (warm open, §20 case 3)", () => {
    let m = fresh(3);
    m = withPageAnalyzed(m, 1);
    m = withPageAnalyzed(m, 2);
    m = withPageAnalyzed(m, 3);
    expect(m.status).toBe("complete");
    expect(validateCache(m, current)).toEqual({ kind: "hit", status: "complete" });
  });

  it("fingerprint mismatch invalidates (modified PDF, §20 case 4)", () => {
    let m = fresh(3);
    m = withPageAnalyzed(m, 1);
    m = withPageAnalyzed(m, 2);
    m = withPageAnalyzed(m, 3);
    expect(validateCache(m, { sourceFingerprint: "fp-CHANGED", pageCount: 3 })).toEqual({
      kind: "miss",
      reason: "fingerprint-mismatch",
    });
  });

  it("schema-version mismatch invalidates (§20 case 5)", () => {
    let m = fresh(3);
    m = { ...m, schemaVersion: m.schemaVersion + 1, status: "complete", analyzedPages: [1, 2, 3] };
    expect(validateCache(m, current)).toEqual({
      kind: "miss",
      reason: "schema-version-mismatch",
    });
  });

  it("analysis-version mismatch invalidates (§20 case 5)", () => {
    let m = fresh(3);
    m = { ...m, analysisVersion: "9.9.9", status: "complete", analyzedPages: [1, 2, 3] };
    expect(validateCache(m, current)).toEqual({
      kind: "miss",
      reason: "analysis-version-mismatch",
    });
  });

  it("page-count mismatch invalidates", () => {
    let m = fresh(3);
    m = { ...m, status: "complete", analyzedPages: [1, 2, 3] };
    expect(validateCache(m, { sourceFingerprint: "fp-1", pageCount: 5 })).toEqual({
      kind: "miss",
      reason: "page-count-mismatch",
    });
  });

  it("explicit invalid status invalidates (§20 case 7)", () => {
    let m = fresh(3);
    m = withInvalidated(m);
    expect(validateCache(m, current)).toEqual({ kind: "miss", reason: "status-invalid" });
  });

  it("corrupt manifest is a miss (§20 case 7)", () => {
    const corrupt = { ...fresh(3), sourceFingerprint: undefined } as unknown as PdfAnalysisManifest;
    expect(validateCache(corrupt, current)).toEqual({ kind: "miss", reason: "corrupt" });
  });

  it("partial manifest is a resume, not a hit (§6/§16/§20 case 6)", () => {
    let m = fresh(3);
    m = withPageAnalyzed(m, 1);
    expect(m.status).toBe("partial");
    const v = validateCache(m, current);
    expect(v.kind).toBe("resume");
    if (v.kind === "resume") expect(v.analyzedPages).toEqual([1]);
  });

  it("complete-but-missing-pages degrades to resume (defence in depth §16)", () => {
    const lying = { ...fresh(3), status: "complete", analyzedPages: [1] } as PdfAnalysisManifest;
    const v = validateCache(lying, current);
    expect(v.kind).toBe("resume");
  });
});

describe("pagesToAnalyze (§16 resume)", () => {
  it("hit -> nothing", () => {
    expect(pagesToAnalyze({ kind: "hit", status: "complete" }, 5)).toEqual([]);
  });

  it("miss -> every page", () => {
    expect(pagesToAnalyze({ kind: "miss", reason: "absent" }, 4)).toEqual([1, 2, 3, 4]);
  });

  it("resume -> only the gaps (§20 case 6)", () => {
    expect(pagesToAnalyze({ kind: "resume", analyzedPages: [1, 2, 4] }, 5)).toEqual([3, 5]);
  });
});

describe("manifest state machine (§6)", () => {
  it("advances not-started -> partial -> complete and never regresses", () => {
    let m = fresh(2);
    expect(m.status).toBe("not-started");
    m = withProcessing(m);
    expect(m.status).toBe("processing");
    m = withPageAnalyzed(m, 1);
    expect(m.status).toBe("partial");
    m = withPageAnalyzed(m, 2);
    expect(m.status).toBe("complete");
    // withProcessing on a complete manifest is a no-op (never regress).
    expect(withProcessing(m).status).toBe("complete");
  });

  it("dedupes and sorts analyzedPages", () => {
    let m = fresh(3);
    m = withPageAnalyzed(m, 3);
    m = withPageAnalyzed(m, 1);
    m = withPageAnalyzed(m, 1);
    expect(m.analyzedPages).toEqual([1, 3]);
  });

  it("createManifest stamps the current versions", () => {
    const m = fresh(1);
    expect(m.schemaVersion).toBe(PDF_ANALYSIS_SCHEMA_VERSION);
    expect(m.analysisVersion).toBe(PDF_ANALYSIS_VERSION);
  });
});
