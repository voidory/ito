import { describe, expect, it } from "vitest";
import {
  computeByteHash,
  computeTextShingles,
  extractCanonicalId,
  extractDocStem,
  extractDocumentSignature,
  matchExistingSource,
  parseDocStem,
  shingleOverlap,
} from "./fingerprint";

describe("computeByteHash", () => {
  it("is deterministic and 16 hex chars", () => {
    const a = computeByteHash(new Uint8Array([1, 2, 3, 4]));
    const b = computeByteHash(new Uint8Array([1, 2, 3, 4]));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("differs for different bytes", () => {
    const a = computeByteHash(new Uint8Array([1, 2, 3, 4]));
    const b = computeByteHash(new Uint8Array([1, 2, 3, 5]));
    expect(a).not.toBe(b);
  });

  it("handles empty input", () => {
    expect(computeByteHash(new Uint8Array([]))).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("extractDocStem", () => {
  it("drops .pdf and revision suffixes, converging draft/final", () => {
    const draft = extractDocStem("CH2101_Lab1_draft.pdf");
    const final = extractDocStem("CH2101_Lab1_final.pdf");
    expect(draft.stem).toBe(final.stem);
    expect(draft.seqToken).toBe("lab:1");
    expect(final.seqToken).toBe("lab:1");
    expect(draft.docStem).toBe("ch2101_lab::seq=lab:1");
  });

  it("distinguishes different sequence numbers", () => {
    expect(extractDocStem("CH2101_Lab1_draft.pdf").seqToken).toBe("lab:1");
    expect(extractDocStem("CH2101_Lab2_draft.pdf").seqToken).toBe("lab:2");
  });

  it("strips ISO dates and (1) copy markers", () => {
    const a = extractDocStem("Report_2026-01-02.pdf");
    const b = extractDocStem("Report (1).pdf");
    expect(a.stem).toBe("report");
    expect(b.stem).toBe("report");
  });

  it("normalizes tut/lec aliases", () => {
    expect(extractDocStem("Tut 3.pdf").seqToken).toBe("tutorial:3");
    expect(extractDocStem("Lec_4.pdf").seqToken).toBe("lecture:4");
  });
});

describe("extractCanonicalId", () => {
  it("extracts and lowercases a DOI", () => {
    const id = extractCanonicalId(["See DOI 10.1000/XyZ-123 for details."]);
    expect(id).toBe("doi:10.1000/xyz-123");
  });

  it("strips trailing punctuation from a DOI", () => {
    const id = extractCanonicalId(["doi:10.1234/abcd."]);
    expect(id).toBe("doi:10.1234/abcd");
  });

  it("extracts an ISBN-13 stripped of hyphens", () => {
    const id = extractCanonicalId(["ISBN 978-0-13-468599-1"]);
    expect(id).toBe("isbn:9780134685991");
  });

  it("prefers metadata and returns undefined when absent", () => {
    expect(extractCanonicalId(["nothing here"])).toBeUndefined();
    expect(extractCanonicalId([], "10.5555/meta")).toBe("doi:10.5555/meta");
  });
});

/** Build N pages of lorem-ish prose for shingle tests. */
function prose(seed: string, n: number): string[] {
  const out: string[] = [];
  for (let p = 0; p < n; p++) {
    const lines: string[] = [];
    for (let l = 0; l < 20; l++) {
      lines.push(
        `${seed} paragraph ${p} line ${l} discusses quantum entanglement coherence information theory measurement.`,
      );
    }
    out.push(lines.join("\n"));
  }
  return out;
}

describe("computeTextShingles", () => {
  it("produces deterministic hex hashes", () => {
    const a = computeTextShingles(prose("alpha", 20));
    const b = computeTextShingles(prose("alpha", 20));
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThanOrEqual(4);
    for (const h of a) expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it("yields few shingles for a scanned/empty PDF", () => {
    expect(computeTextShingles(["", "", ""]).length).toBeLessThan(4);
  });
});

describe("shingleOverlap", () => {
  it("is 1 for identical sets and 0 for disjoint", () => {
    expect(shingleOverlap(["a", "b"], ["a", "b"]).jaccard).toBe(1);
    expect(shingleOverlap(["a"], ["b"]).jaccard).toBe(0);
  });
});

describe("parseDocStem", () => {
  it("round-trips a compound docStem", () => {
    expect(parseDocStem("ch2101_lab::seq=lab:1")).toEqual({
      stem: "ch2101_lab",
      seqToken: "lab:1",
    });
    expect(parseDocStem("report")).toEqual({ stem: "report", seqToken: null });
  });
});

describe("matchExistingSource", () => {
  it("Tier 1: exact bytes match", () => {
    const d = matchExistingSource(
      { contentHash: "abc", stem: "x", seqToken: null },
      { contentHash: "abc" },
    );
    expect(d.matched).toBe(true);
    expect(d.tier).toBe("exact-bytes");
  });

  it("Tier 2: canonical id match", () => {
    const d = matchExistingSource(
      { canonicalId: "doi:10.1/x", stem: "x", seqToken: null },
      { canonicalId: "doi:10.1/x" },
    );
    expect(d.matched).toBe(true);
    expect(d.tier).toBe("canonical-id");
  });

  it("HARD VETO 1: sequence collision beats boilerplate overlap", () => {
    const shared = ["h1", "h2", "h3", "h4", "h5", "h6", "h7", "h8"];
    const d = matchExistingSource(
      { stem: "ch2101_lab", seqToken: "lab:1", textShingles: shared },
      { stem: "ch2101_lab", seqToken: "lab:2", textShingles: shared },
    );
    expect(d.matched).toBe(false);
    expect(d.reason).toMatch(/sequence collision/);
  });

  it("HARD VETO 2: never match on fuzzy shingles alone with < 4 shingles", () => {
    const d = matchExistingSource(
      { stem: "x", seqToken: null, textShingles: ["a", "b"] },
      { stem: "y", seqToken: null, textShingles: ["a", "b"] },
    );
    expect(d.matched).toBe(false);
  });

  it("Tier 3: textbook fuzzy overlap", () => {
    const base = Array.from({ length: 16 }, (_, i) => `h${i}`);
    const incoming = [...base.slice(0, 12), "x1", "x2", "x3", "x4"];
    const candidate = [...base.slice(0, 12), "y1", "y2", "y3", "y4"];
    const d = matchExistingSource(
      { stem: "book", seqToken: null, textShingles: incoming },
      { stem: "book", seqToken: null, textShingles: candidate },
    );
    expect(d.matched).toBe(true);
    expect(d.tier).toBe("textbook");
  });

  it("Tier 4: revised draft via shared stem + offloaded binary", () => {
    const d = matchExistingSource(
      { stem: "ch2101_lab", seqToken: "lab:1" },
      { stem: "ch2101_lab", seqToken: "lab:1", binaryOffloaded: true },
    );
    expect(d.matched).toBe(true);
    expect(d.tier).toBe("revised-draft");
  });

  it("no match for unrelated docs", () => {
    const d = matchExistingSource(
      { stem: "alpha", seqToken: null },
      { stem: "beta", seqToken: null },
    );
    expect(d.matched).toBe(false);
  });
});

describe("extractDocumentSignature", () => {
  it("assembles all available signals", () => {
    const sig = extractDocumentSignature({
      bytes: new Uint8Array([1, 2, 3]),
      titleOrFilename: "CH2101_Lab1_draft.pdf",
      pageTexts: prose("alpha", 20),
      metaStr: "10.1000/abc",
    });
    expect(sig.contentHash).toMatch(/^[0-9a-f]{16}$/);
    expect(sig.canonicalId).toBe("doi:10.1000/abc");
    expect(sig.seqToken).toBe("lab:1");
    expect(sig.docStem).toBe("ch2101_lab::seq=lab:1");
    expect((sig.textShingles ?? []).length).toBeGreaterThanOrEqual(4);
  });
});
