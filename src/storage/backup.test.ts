/**
 * FEAT-002 (M3, D09) — the PURE two-lane backup codec, exercised with REAL
 * fflate (no mocks). Covers:
 *
 *  - A18 omission stamping: full -> backupMode='full' + omissions=[]; unticking
 *    any box -> 'targeted' + the EXACT unticked tokens.
 *  - Lane-1 vs Lane-2 content gating (captures/revisions/presentation sections).
 *  - D19 device-local presentation split: paneWidths/zoom/active3D/suppressMotion
 *    NEVER appear in the export; only the shared fields do.
 *  - Lane-2 .ito.zip round-trip: export then parse yields byte-identical PDFs
 *    keyed assets/<sourceId>-<versionHash>.pdf.
 */

import { describe, expect, it } from "vitest";
import {
  assetEntryName,
  computeOmissions,
  exportBundleZip,
  exportCoreBrainJson,
  parseBundleZip,
  resolveBackupOptions,
} from "./backup";
import { createEmptyBrainData } from "../model";
import type {
  AssetId,
  BrainData,
  Capture,
  CaptureId,
  Revision,
  RevisionId,
  Source,
  SourceId,
} from "../model";

const PDF_A = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3, 4, 5]);
const PDF_B = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 9, 8, 7, 6]);

function sourceOf(id: string, assetId: string, hash: string): Source {
  return {
    id: id as SourceId,
    kind: "pdf",
    title: `Doc ${id}`,
    assetId: assetId as AssetId,
    versionHash: hash,
    pageCount: 3,
    importedAt: "2024-01-01T00:00:00.000Z",
    category: "Papers",
  };
}

function sampleData(): BrainData {
  const base = createEmptyBrainData();
  const sources = [
    sourceOf("src_a", "asset_a", "hash-a"),
    sourceOf("src_b", "asset_b", "hash-b"),
  ];
  const captures: Capture[] = [
    { id: "cap_1" as CaptureId, sourceId: null, text: "note", createdAt: "2024" },
  ];
  const revisions: Revision[] = [
    { id: "rev_1" as RevisionId, publicationRevision: 1, label: "v1", createdAt: "2024" },
  ];
  return {
    ...base,
    sources,
    captures,
    revisions,
    presentation: {
      ...base.presentation,
      // Shared fields (DO export):
      nodePositions: { page_1: { x: 10, y: 20 } },
      dragOffsets: { page_1: { x: 1, y: 2 } },
      hiddenPageIds: [],
      hiddenRelationshipIds: [],
      annotationStyles: {},
      // Device-local fields (NEVER export):
      zoom: 2.5,
      active3D: true,
    },
  };
}

describe("backup codec — A18 omission stamping", () => {
  it("a full export stamps backupMode='full' + omissions=[]", () => {
    const { manifest } = exportCoreBrainJson(sampleData());
    expect(manifest.backupMode).toBe("full");
    expect(manifest.omissions).toEqual([]);
  });

  it("unticking sourceBinaries stamps 'targeted' + omissions=['sourceBinaries']", () => {
    const { manifest } = exportCoreBrainJson(sampleData(), { sourceBinaries: false });
    expect(manifest.backupMode).toBe("targeted");
    expect(manifest.omissions).toEqual(["sourceBinaries"]);
  });

  it("unticking revisions + captures records exactly those tokens in stable order", () => {
    const { manifest } = exportCoreBrainJson(sampleData(), {
      captures: false,
      revisions: false,
    });
    expect(manifest.backupMode).toBe("targeted");
    expect(manifest.omissions).toEqual(["captures", "revisions"]);
  });

  it("computeOmissions orders tokens by the checklist order", () => {
    expect(
      computeOmissions(
        resolveBackupOptions({
          presentation: false,
          captures: false,
          revisions: false,
          sourceBinaries: false,
        }),
      ),
    ).toEqual(["presentation", "captures", "revisions", "sourceBinaries"]);
  });
});

describe("backup codec — Lane-1 section gating + D19 presentation split", () => {
  it("includes captures/revisions/presentation when ticked", () => {
    const { payload } = exportCoreBrainJson(sampleData());
    expect(payload.captures).toBeDefined();
    expect(payload.revisions).toBeDefined();
    expect(payload.presentation).toBeDefined();
  });

  it("omits each optional section when its box is unticked", () => {
    const { payload } = exportCoreBrainJson(sampleData(), {
      captures: false,
      revisions: false,
      presentation: false,
    });
    expect(payload.captures).toBeUndefined();
    expect(payload.revisions).toBeUndefined();
    expect(payload.presentation).toBeUndefined();
  });

  it("NEVER exports device-local presentation fields; keeps shared ones", () => {
    const { json, payload } = exportCoreBrainJson(sampleData());
    const pres = payload.presentation!;
    // Shared fields present:
    expect(pres["nodePositions"]).toEqual({ page_1: { x: 10, y: 20 } });
    expect(pres["dragOffsets"]).toEqual({ page_1: { x: 1, y: 2 } });
    // Device-local fields absent:
    expect(pres["zoom"]).toBeUndefined();
    expect(pres["active3D"]).toBeUndefined();
    expect(pres["paneWidths"]).toBeUndefined();
    expect(pres["suppressMotion"]).toBeUndefined();
    // And they never leak into the serialized text either.
    expect(json).not.toContain("active3D");
    expect(json).not.toContain("suppressMotion");
    expect(json).not.toContain("paneWidths");
  });
});

describe("backup codec — Lane-2 .ito.zip round-trip (real fflate)", () => {
  it("round-trips manifest.json + brain.json + byte-identical assets", async () => {
    const data = sampleData();
    const assets = new Map<string, Uint8Array>([
      ["asset_a", PDF_A],
      ["asset_b", PDF_B],
    ]);
    const zip = await exportBundleZip(data, {}, assets);

    // Reads back the REAL produced zip bytes (not a hardcoded manifest).
    const parsed = parseBundleZip(zip);
    expect(parsed.manifestJson).not.toBeNull();
    expect(parsed.brainJson).not.toBeNull();

    const manifest = JSON.parse(parsed.manifestJson!);
    expect(manifest.backupMode).toBe("full");

    const nameA = assetEntryName("src_a", "hash-a");
    const nameB = assetEntryName("src_b", "hash-b");
    expect(parsed.assets.has(nameA)).toBe(true);
    expect(parsed.assets.has(nameB)).toBe(true);
    expect([...parsed.assets.get(nameA)!]).toEqual([...PDF_A]);
    expect([...parsed.assets.get(nameB)!]).toEqual([...PDF_B]);
  });

  it("omits assets/ entirely when sourceBinaries is unticked", async () => {
    const data = sampleData();
    const assets = new Map<string, Uint8Array>([
      ["asset_a", PDF_A],
      ["asset_b", PDF_B],
    ]);
    const zip = await exportBundleZip(data, { sourceBinaries: false }, assets);
    const parsed = parseBundleZip(zip);
    expect(parsed.assets.size).toBe(0);
    const manifest = JSON.parse(parsed.manifestJson!);
    expect(manifest.omissions).toEqual(["sourceBinaries"]);
  });

  it("only bundles binaries actually available from the provider", async () => {
    const data = sampleData();
    // Provide only src_a's bytes; src_b's binary is offloaded/missing.
    const assets = new Map<string, Uint8Array>([["asset_a", PDF_A]]);
    const zip = await exportBundleZip(data, {}, assets);
    const parsed = parseBundleZip(zip);
    expect(parsed.assets.has(assetEntryName("src_a", "hash-a"))).toBe(true);
    expect(parsed.assets.has(assetEntryName("src_b", "hash-b"))).toBe(false);
  });
});
