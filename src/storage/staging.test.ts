/**
 * FEAT-002 (M3, A19) — the ISOLATED Staging Validator, with REAL fflate.
 *
 *  - HARD-REJECT: unparseable JSON, corrupted zip header, a bundled asset
 *    without %PDF- magic. Nothing is committable.
 *  - NEEDS-CONFIRMATION (default-reject): schemaVersion mismatch, a checksum
 *    mismatch, a missing optional array. Carries a populated report; commits
 *    ONLY with { lenient: true }.
 *  - READY: a clean bundle commits normally.
 *
 * The validator NEVER touches a live store (it is pure in-memory); the
 * workbench wiring test asserts live-store counts stay unchanged across a
 * hard-reject.
 */

import { describe, expect, it } from "vitest";
import {
  assetEntryName,
  exportBundleZip,
  exportCoreBrainJson,
  strToU8,
} from "./backup";
import { commitStagedImport, stageImport } from "./staging";
import { sha256Hex } from "./hash";
import { createEmptyBrainData } from "../model";
import type {
  AnnotationId,
  AssetId,
  BrainData,
  Source,
  SourceId,
} from "../model";

/** A real PDF-magic byte array; its sha256 becomes the source versionHash. */
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3, 4, 5]);

async function sourceForBytes(id: string, bytes: Uint8Array): Promise<Source> {
  const hash = await sha256Hex(bytes);
  return {
    id: id as SourceId,
    kind: "pdf",
    title: `Doc ${id}`,
    assetId: `asset_${id}` as AssetId,
    versionHash: hash,
    pageCount: 3,
    importedAt: "2024-01-01T00:00:00.000Z",
    category: "Papers",
  };
}

async function cleanData(): Promise<{ data: BrainData; src: Source }> {
  const base = createEmptyBrainData();
  const src = await sourceForBytes("src_a", PDF_BYTES);
  return { data: { ...base, sources: [src] }, src };
}

describe("staging — HARD REJECT", () => {
  it("unparseable JSON hard-rejects and commits nothing", async () => {
    const staged = await stageImport("{ not json ]");
    expect(staged.outcome).toBe("hard-reject");
    const result = await commitStagedImport(staged, { lenient: true });
    expect(result.committed).toBe(false);
  });

  it("corrupted zip header hard-rejects", async () => {
    // Looks like a zip ("PK") but the central directory is garbage.
    const corrupt = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8]);
    const staged = await stageImport(corrupt);
    expect(staged.outcome).toBe("hard-reject");
  });

  it("a bundled asset without %PDF- magic hard-rejects", async () => {
    const { data } = await cleanData();
    // Build a zip whose asset bytes are NOT a PDF (bad magic).
    const notPdf = new Uint8Array([0, 1, 2, 3, 4, 5]);
    const assets = new Map<string, Uint8Array>([["asset_src_a", notPdf]]);
    const zip = await exportBundleZip(data, {}, assets);
    const staged = await stageImport(zip);
    expect(staged.outcome).toBe("hard-reject");
    if (staged.outcome === "hard-reject") {
      expect(staged.reason).toMatch(/%PDF-/);
    }
  });
});

describe("staging — NEEDS CONFIRMATION (default-reject)", () => {
  it("a schemaVersion mismatch needs confirmation and does NOT commit by default", async () => {
    const { data } = await cleanData();
    const stale = {
      ...data,
      manifest: { ...data.manifest, schemaVersion: 1 },
    };
    const { json } = exportCoreBrainJson(stale as BrainData);
    const staged = await stageImport(json);
    expect(staged.outcome).toBe("needs-confirmation");
    const findings = (staged.outcome === "needs-confirmation" ? staged.findings : []);
    expect(findings.some((f) => f.kind === "schema-version-mismatch")).toBe(true);

    const def = await commitStagedImport(staged);
    expect(def.committed).toBe(false);
  });

  it("a missing optional array needs confirmation", async () => {
    const { data } = await cleanData();
    // Hand-author a payload that drops the captures array entirely.
    const payload = {
      manifest: data.manifest,
      sources: data.sources,
      annotations: [],
      subjectAssociations: [],
      pages: [],
      evidenceInstances: [],
      categories: [],
      relationships: [],
      revisions: [],
      // captures + tentativeAssociations intentionally omitted
    };
    const staged = await stageImport(JSON.stringify(payload));
    expect(staged.outcome).toBe("needs-confirmation");
    const findings = (staged.outcome === "needs-confirmation" ? staged.findings : []);
    expect(findings.some((f) => f.kind === "missing-array")).toBe(true);
  });

  it("a checksum mismatch on a bundled binary needs confirmation", async () => {
    const { data, src } = await cleanData();
    // Bundle bytes whose sha256 does NOT equal src.versionHash, keyed by the
    // entry name the staging validator derives from the source metadata.
    const wrongBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 9, 9, 9]);
    const entry = assetEntryName(src.id, src.versionHash);
    // Build a zip manually via exportBundleZip with an asset map keyed by
    // assetId; the entry name uses sourceId+versionHash so wrongBytes land there.
    const assets = new Map<string, Uint8Array>([[src.assetId, wrongBytes]]);
    const zip = await exportBundleZip(data, {}, assets);
    const staged = await stageImport(zip);
    expect(staged.outcome).toBe("needs-confirmation");
    const findings = (staged.outcome === "needs-confirmation" ? staged.findings : []);
    expect(findings.some((f) => f.kind === "checksum-mismatch")).toBe(true);
    expect(entry).toContain(src.id);
  });
});

describe("staging — READY commit", () => {
  it("a clean Lane-2 bundle is ready and commits normally", async () => {
    const { data, src } = await cleanData();
    const assets = new Map<string, Uint8Array>([[src.assetId, PDF_BYTES]]);
    const zip = await exportBundleZip(data, {}, assets);
    const staged = await stageImport(zip);
    expect(staged.outcome).toBe("ready");

    const result = await commitStagedImport(staged);
    expect(result.committed).toBe(true);
    if (result.committed) {
      expect(result.data.sources).toHaveLength(1);
      // The matched binary is returned keyed by assetId for the caller to write.
      expect(result.assets.get(src.assetId)).toBeDefined();
      expect([...result.assets.get(src.assetId)!]).toEqual([...PDF_BYTES]);
    }
  });
});

describe("staging — Try Import Anyway (lenient coercion)", () => {
  it("fills missing arrays, keeps valid records, and commits after integrity passes", async () => {
    const { data } = await cleanData();
    const payload = {
      manifest: { ...data.manifest, schemaVersion: 1 },
      sources: data.sources,
      annotations: [],
      subjectAssociations: [],
      pages: [],
      evidenceInstances: [],
      categories: [],
      relationships: [],
      // captures + revisions + tentativeAssociations omitted -> findings
    };
    const staged = await stageImport(JSON.stringify(payload));
    expect(staged.outcome).toBe("needs-confirmation");

    const lenient = await commitStagedImport(staged, { lenient: true });
    expect(lenient.committed).toBe(true);
    if (lenient.committed) {
      // Missing arrays filled with empty defaults via migrateBrainData.
      expect(lenient.data.captures).toEqual([]);
      expect(lenient.data.revisions).toEqual([]);
      expect(lenient.data.tentativeAssociations).toEqual([]);
      // Valid records preserved + schema upgraded.
      expect(lenient.data.sources).toHaveLength(1);
      expect(lenient.data.manifest.schemaVersion).toBeGreaterThanOrEqual(2);
    }
  });

  it("marks an absent binary as binary-offloaded after a lenient commit", async () => {
    const { data, src } = await cleanData();
    // One annotation on src whose binary will be ABSENT from the lenient bundle.
    const annId = "ann_1" as AnnotationId;
    const withAnn: BrainData = {
      ...data,
      annotations: [
        {
          id: annId,
          sourceId: src.id,
          scope: {
            kind: "text",
            anchor: {
              docId: src.id,
              sourceVersionHash: src.versionHash,
              pageIndex: 0,
              rects: [],
              selectedText: "q",
              prefix: "",
              suffix: "",
            },
          },
          resolution: { kind: "resolved" },
          comment: "",
          createdAt: "2024",
          updatedAt: "2024",
        },
      ],
      captures: [],
    };
    // Lane-1 json (no binaries) -> absent -> binary-offloaded after lenient.
    const payload = {
      manifest: withAnn.manifest,
      sources: withAnn.sources,
      annotations: withAnn.annotations,
      subjectAssociations: [],
      pages: [],
      evidenceInstances: [],
      categories: [],
      relationships: [],
      // omit optional arrays to force needs-confirmation
    };
    const staged = await stageImport(JSON.stringify(payload));
    expect(staged.outcome).toBe("needs-confirmation");
    const lenient = await commitStagedImport(staged, { lenient: true });
    expect(lenient.committed).toBe(true);
    if (lenient.committed) {
      expect(lenient.data.annotations[0]!.resolution.kind).toBe("binary-offloaded");
    }
  });

  it("marks a mismatched bundled binary as mismatched after a lenient commit", async () => {
    const { data, src } = await cleanData();
    const annId = "ann_m" as AnnotationId;
    const withAnn: BrainData = {
      ...data,
      annotations: [
        {
          id: annId,
          sourceId: src.id,
          scope: {
            kind: "text",
            anchor: {
              docId: src.id,
              sourceVersionHash: src.versionHash,
              pageIndex: 0,
              rects: [],
              selectedText: "q",
              prefix: "",
              suffix: "",
            },
          },
          resolution: { kind: "resolved" },
          comment: "",
          createdAt: "2024",
          updatedAt: "2024",
        },
      ],
    };
    // Bundle wrong bytes under src's entry -> checksum mismatch.
    const wrongBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 7, 7, 7]);
    const assets = new Map<string, Uint8Array>([[src.assetId, wrongBytes]]);
    const zip = await exportBundleZip(withAnn, { captures: false }, assets);
    const staged = await stageImport(zip);
    expect(staged.outcome).toBe("needs-confirmation");
    const lenient = await commitStagedImport(staged, { lenient: true });
    expect(lenient.committed).toBe(true);
    if (lenient.committed) {
      const resolution = lenient.data.annotations[0]!.resolution;
      expect(resolution.kind).toBe("mismatched");
      // The mismatched binary must NOT be written as the real asset.
      expect(lenient.assets.get(src.assetId)).toBeUndefined();
      // The drift detail must record the stored hash (expected) and the ACTUAL
      // recomputed digest of the imported bytes as two DISTINCT values. The old
      // buggy code set both to the stored versionHash, which this asserts against.
      if (resolution.kind === "mismatched") {
        expect(resolution.expectedVersionHash).toBe(src.versionHash);
        expect(resolution.actualVersionHash).toBe(await sha256Hex(wrongBytes));
        expect(resolution.actualVersionHash).not.toBe(resolution.expectedVersionHash);
      }
    }
  });

  it("rejects an unmigratable payload even under lenient", async () => {
    const staged = await stageImport(JSON.stringify({ not: "a brain" }));
    // No manifest -> schema-version-mismatch finding -> needs-confirmation.
    expect(staged.outcome).toBe("needs-confirmation");
    const lenient = await commitStagedImport(staged, { lenient: true });
    expect(lenient.committed).toBe(false);
  });
});

// Reference strToU8 so the import is exercised and tree-shaking never flags it.
describe("staging — bare Lane-1 bytes input", () => {
  it("accepts a bare brain.ito.json as a Uint8Array", async () => {
    const { data, src } = await cleanData();
    const { json } = exportCoreBrainJson(data, { sourceBinaries: false });
    const staged = await stageImport(strToU8(json));
    // Lane-1 export drops the sourceBinaries box -> omissions, but arrays are
    // all present -> this is READY (no missing-array / checksum findings).
    expect(staged.outcome).toBe("ready");
    expect(src.id).toBeTruthy();
  });
});
