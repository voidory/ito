/**
 * FEAT-002 (M3, D09) — the batch PdfIngestionQueue on the Workbench.
 *
 *  - enqueuePdfBinaries validates %PDF- magic (rejects non-PDFs), enforces a
 *    per-file size guard (injected small value), computes the sha256
 *    versionHash, HYDRATES a matching existing Source or CREATES a new one,
 *    and processes at a bounded concurrency.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { ingestPdfBinaries, sha256Hex } from "../storage";
import { Workbench } from "./workbench";
import type { Source } from "../model";

function pdf(...tail: number[]): Uint8Array {
  return new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, ...tail]);
}

describe("Workbench.enqueuePdfBinaries (D09)", () => {
  let storage: InMemoryStorageAdapter;
  let wb: Workbench;
  beforeEach(async () => {
    storage = new InMemoryStorageAdapter();
    wb = await Workbench.open(storage);
  });

  it("creates a new Source for an unmatched PDF and persists it", async () => {
    const bytes = pdf(1, 2, 3);
    const results = await wb.enqueuePdfBinaries([{ name: "new.pdf", bytes }]);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("created");
    expect(wb.rawData().sources).toHaveLength(1);
    // The created Source's versionHash is the sha256 of the bytes and its
    // binary is cached (written through the adapter).
    const created = wb.rawData().sources[0]!;
    expect(created.versionHash).toBe(await sha256Hex(bytes));
    expect(wb.sourceBinaryStatus(created.id)).toBe("cached");
  });

  it("hydrates an existing offloaded Source when the sha256 matches", async () => {
    const bytes = pdf(4, 5, 6);
    const versionHash = await sha256Hex(bytes);
    const src: Source = await wb.importSource({
      title: "Existing",
      bytes,
      versionHash,
      pageCount: 2,
    });
    await wb.offloadSourceBinary(src.id);
    expect(wb.sourceBinaryStatus(src.id)).toBe("binary-offloaded");

    const results = await wb.enqueuePdfBinaries([{ name: "again.pdf", bytes }]);
    expect(results[0]!.status).toBe("hydrated");
    expect(results[0]!.sourceId).toBe(src.id);
    // No new Source; the existing one is re-cached.
    expect(wb.rawData().sources).toHaveLength(1);
    expect(wb.sourceBinaryStatus(src.id)).toBe("cached");
  });

  it("rejects a non-PDF (bad magic) without creating a Source", async () => {
    const notPdf = new Uint8Array([0, 1, 2, 3, 4]);
    const results = await wb.enqueuePdfBinaries([{ name: "x.txt", bytes: notPdf }]);
    expect(results[0]!.status).toBe("rejected");
    expect(results[0]!.reason).toBeTruthy();
    expect(wb.rawData().sources).toHaveLength(0);
  });

  it("rejects an oversize file using an injected small size guard", async () => {
    const big = pdf(1, 2, 3, 4, 5, 6, 7, 8, 9, 10);
    const results = await wb.enqueuePdfBinaries([{ name: "big.pdf", bytes: big }], {
      maxBytes: 8,
    });
    expect(results[0]!.status).toBe("rejected");
    expect(results[0]!.reason).toMatch(/size guard/);
    expect(wb.rawData().sources).toHaveLength(0);
  });

  it("retains every created Source + assetIndex entry for a batch of >= 2 new PDFs at concurrency 2", async () => {
    // Three DISTINCT new PDFs ingested concurrently. Under the old
    // read-modify-write hydrator two "created" callbacks captured the same
    // `this.data` snapshot across their `await writeAsset`, and the later
    // reassignment clobbered the earlier one, dropping a Source + assetIndex
    // entry. The fix accumulates created records and applies them atomically.
    const batch = [
      { name: "a.pdf", bytes: pdf(1, 1, 1) },
      { name: "b.pdf", bytes: pdf(2, 2, 2) },
      { name: "c.pdf", bytes: pdf(3, 3, 3) },
    ];
    const results = await wb.enqueuePdfBinaries(batch, { concurrency: 2 });
    expect(results.map((r) => r.status)).toEqual(["created", "created", "created"]);

    const data = wb.rawData();
    // Every created Source and its assetIndex entry must survive.
    expect(data.sources).toHaveLength(3);
    expect(data.manifest.assetIndex).toHaveLength(3);

    // Each created source's binary is cached and the versionHash matches.
    for (const file of batch) {
      const hash = await sha256Hex(file.bytes);
      const source = data.sources.find((s) => s.versionHash === hash);
      expect(source).toBeDefined();
      expect(wb.sourceBinaryStatus(source!.id)).toBe("cached");
      expect(
        data.manifest.assetIndex.some((e) => e.assetId === source!.assetId),
      ).toBe(true);
    }
  });

  it("processes a mixed batch (create + hydrate + reject) preserving input order", async () => {
    const existingBytes = pdf(7, 7, 7);
    const existing = await wb.importSource({
      title: "Existing",
      bytes: existingBytes,
      versionHash: await sha256Hex(existingBytes),
      pageCount: 1,
    });
    await wb.offloadSourceBinary(existing.id);

    const batch = [
      { name: "new1.pdf", bytes: pdf(1) },
      { name: "bad.txt", bytes: new Uint8Array([0, 0, 0]) },
      { name: "existing.pdf", bytes: existingBytes },
      { name: "new2.pdf", bytes: pdf(2) },
    ];
    const results = await wb.enqueuePdfBinaries(batch, { concurrency: 2 });
    expect(results.map((r) => r.status)).toEqual([
      "created",
      "rejected",
      "hydrated",
      "created",
    ]);
  });
});

describe("ingestPdfBinaries — pure queue (concurrency + RAM release)", () => {
  it("never exceeds the configured concurrency", async () => {
    let active = 0;
    let peak = 0;
    const files = Array.from({ length: 6 }, (_, i) => ({
      name: `f${i}.pdf`,
      bytes: pdf(i),
    }));
    const results = await ingestPdfBinaries(
      files,
      async ({ versionHash }) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return { status: "created", sourceId: `s_${versionHash.slice(0, 4)}` };
      },
      { concurrency: 2 },
    );
    expect(peak).toBeLessThanOrEqual(2);
    expect(results).toHaveLength(6);
    expect(results.every((r) => r.status === "created")).toBe(true);
  });
});
