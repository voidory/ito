/**
 * FEAT-002 (M3, D09/A18/A19) — the Workbench-facing backup engine wiring:
 * exportBackup, stageImport, commitStagedImport. These drive the REAL Workbench
 * + the in-memory StorageAdapter and real fflate end to end.
 *
 *  - exportBackup pulls live asset bytes and returns an omission-stamped
 *    manifest + round-trippable .ito.zip bytes (A18).
 *  - stageImport NEVER mutates the live store: a hard-reject leaves live-store
 *    counts unchanged (A19).
 *  - commitStagedImport replaces the in-memory BrainData only on a successful
 *    (ready or lenient) commit and writes the matched asset bytes.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { assetEntryName, parseBundleZip, sha256Hex } from "../storage";
import { Workbench } from "./workbench";
import type { Source } from "../model";

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3, 4, 5]);

async function importHashed(wb: Workbench, title = "Doc"): Promise<Source> {
  const versionHash = await sha256Hex(PDF_BYTES);
  return wb.importSource({ title, bytes: PDF_BYTES, versionHash, pageCount: 3 });
}

describe("Workbench.exportBackup (A18, D09)", () => {
  let storage: InMemoryStorageAdapter;
  let wb: Workbench;
  let src: Source;
  beforeEach(async () => {
    storage = new InMemoryStorageAdapter();
    wb = await Workbench.open(storage);
    src = await importHashed(wb);
  });

  it("a full export stamps 'full' and bundles byte-identical binaries", async () => {
    const { bytes, manifest } = await wb.exportBackup();
    expect(manifest.backupMode).toBe("full");
    expect(manifest.omissions).toEqual([]);

    const parsed = parseBundleZip(bytes);
    const entry = assetEntryName(src.id, src.versionHash);
    expect(parsed.assets.has(entry)).toBe(true);
    expect([...parsed.assets.get(entry)!]).toEqual([...PDF_BYTES]);
  });

  it("unticking sourceBinaries stamps 'targeted' and emits Lane-1 bytes only", async () => {
    const { bytes, manifest } = await wb.exportBackup({ sourceBinaries: false });
    expect(manifest.backupMode).toBe("targeted");
    expect(manifest.omissions).toEqual(["sourceBinaries"]);
    // Lane-1 bytes are a bare JSON object, not a zip ("PK" header).
    expect(bytes[0]).not.toBe(0x50);
    const text = new TextDecoder().decode(bytes);
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it("an offloaded source contributes no asset entry to the bundle", async () => {
    await wb.offloadSourceBinary(src.id);
    const { bytes } = await wb.exportBackup();
    const parsed = parseBundleZip(bytes);
    expect(parsed.assets.size).toBe(0);
  });
});

describe("Workbench.stageImport / commitStagedImport (A19)", () => {
  let storage: InMemoryStorageAdapter;
  let wb: Workbench;

  beforeEach(async () => {
    storage = new InMemoryStorageAdapter();
    wb = await Workbench.open(storage);
    await importHashed(wb, "Original");
  });

  it("a hard-reject leaves the live store untouched (counts unchanged)", async () => {
    const before = wb.rawData().sources.length;
    const staged = await wb.stageImport("{ not json ]");
    expect(staged.outcome).toBe("hard-reject");
    // Live store never mutated by staging.
    expect(wb.rawData().sources).toHaveLength(before);
    const result = await wb.commitStagedImport({ lenient: true });
    expect(result.committed).toBe(false);
    expect(wb.rawData().sources).toHaveLength(before);
  });

  it("a ready bundle commits and replaces the in-memory BrainData + assets", async () => {
    // Export a backup from this brain, then import it into a FRESH workbench.
    const { bytes } = await wb.exportBackup();

    const storage2 = new InMemoryStorageAdapter();
    const wb2 = await Workbench.open(storage2);
    expect(wb2.rawData().sources).toHaveLength(0);

    const staged = await wb2.stageImport(bytes);
    expect(staged.outcome).toBe("ready");
    const result = await wb2.commitStagedImport();
    expect(result.committed).toBe(true);
    expect(wb2.rawData().sources).toHaveLength(1);

    // The matched binary was written through the adapter and is cached.
    const importedSource = wb2.rawData().sources[0]!;
    expect(wb2.sourceBinaryStatus(importedSource.id)).toBe("cached");
    expect(await wb2.readSourceBytes(importedSource.id)).not.toBeNull();
    // Staged state cleared after a successful commit.
    expect(wb2.stagedImportState()).toBeNull();
  });

  it("needs-confirmation does NOT commit by default, commits with lenient", async () => {
    // A Lane-1 payload with a stale schemaVersion -> needs-confirmation.
    const base = wb.rawData();
    const stalePayload = JSON.stringify({
      manifest: { ...base.manifest, schemaVersion: 1 },
      sources: base.sources,
      annotations: [],
      subjectAssociations: [],
      pages: [],
      evidenceInstances: [],
      categories: [],
      relationships: [],
      captures: [],
      revisions: [],
      tentativeAssociations: [],
    });

    const storage2 = new InMemoryStorageAdapter();
    const wb2 = await Workbench.open(storage2);
    const staged = await wb2.stageImport(stalePayload);
    expect(staged.outcome).toBe("needs-confirmation");

    const def = await wb2.commitStagedImport();
    expect(def.committed).toBe(false);
    expect(wb2.rawData().sources).toHaveLength(0);

    const lenient = await wb2.commitStagedImport({ lenient: true });
    expect(lenient.committed).toBe(true);
    expect(wb2.rawData().sources).toHaveLength(1);
    expect(wb2.rawData().manifest.schemaVersion).toBeGreaterThanOrEqual(2);
  });

  it("retains prior live data if the commit write fails", async () => {
    const { bytes } = await wb.exportBackup();
    const storage2 = new InMemoryStorageAdapter();
    const wb2 = await Workbench.open(storage2);
    await wb2.stageImport(bytes);
    // Force the next writeBrain to throw.
    storage2.failNextWrites = 1;
    await expect(wb2.commitStagedImport()).rejects.toThrow();
    // Prior (empty) live data retained.
    expect(wb2.rawData().sources).toHaveLength(0);
  });
});
