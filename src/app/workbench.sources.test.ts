/**
 * M6 (A15, D01) Workbench source-feature coverage against a REAL Workbench
 * (in-memory storage, nothing mocked):
 *
 *  - importWebsiteSource: URL-only is rejected; a URL + snapshot stores the
 *    sanitized bytes via the adapter and tags the Source kind/type "website" +
 *    availabilityStatus "snapshot-cached".
 *  - commitAreaAnnotation: creates a kind "area" annotation that is citable
 *    into a Subject Page via the ordinary evidence path.
 *  - updateSourcePageCount: backfills only when the stored pageCount is 0.
 */

import { describe, expect, it } from "vitest";
import { Workbench } from "./workbench";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { sha256Hex } from "../storage";
import type { SourceId } from "../model";

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("Workbench.importWebsiteSource (A15, D11)", () => {
  it("rejects a URL-only import (no snapshot)", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    await expect(
      wb.importWebsiteSource({ url: "https://example.com", snapshot: new Uint8Array() }),
    ).rejects.toThrow(/snapshot/i);
    expect(wb.rawData().sources).toHaveLength(0);
  });

  it("rejects an empty URL", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    await expect(
      wb.importWebsiteSource({ url: "   ", snapshot: enc("<p>hi</p>") }),
    ).rejects.toThrow(/URL/i);
  });

  it("stores the sanitized snapshot and tags a website source", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const src = await wb.importWebsiteSource({
      url: "https://example.com/article",
      snapshot: enc("<p>hello</p><script>alert(1)</script>"),
      title: "Example Article",
    });
    expect(src.kind).toBe("website");
    expect(src.type).toBe("website");
    expect(src.availabilityStatus).toBe("snapshot-cached");
    expect(src.url).toBe("https://example.com/article");

    const bytes = await wb.readSourceBytes(src.id);
    expect(bytes).not.toBeNull();
    const html = new TextDecoder().decode(bytes!);
    // The <script> block was stripped at import time.
    expect(html).not.toContain("<script>");
    expect(html).toContain("hello");
  });
});

describe("Workbench.commitAreaAnnotation (D01)", () => {
  it("creates a kind 'area' annotation that is citable into a subject page", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const versionHash = await sha256Hex(PDF_BYTES);
    const src = await wb.importSource({
      title: "Scanned Doc",
      bytes: PDF_BYTES,
      versionHash,
      pageCount: 2,
      category: "Papers",
    });

    const view = await wb.commitAreaAnnotation(
      src.id,
      1,
      { x: 0.1, y: 0.2, width: 0.5, height: 0.1 },
      "a figure",
    );
    expect(view.annotation.scope.kind).toBe("area");
    expect(wb.rawData().annotations).toHaveLength(1);

    const page = await wb.createSubjectPage("Subject");
    const evidence = await wb.insertEvidenceIntoPage(view.annotation.id, page.id, {
      pos: null,
    });
    expect(
      wb.rawData().evidenceInstances.some((e) => e.id === evidence.id),
    ).toBe(true);
    // The area is cited into the subject page.
    expect(wb.citedSubjectPagesForAnnotation(view.annotation.id)).toContain(page.id);
  });
});

describe("Workbench.updateSourcePageCount (3.1 / D01 backfill)", () => {
  it("backfills pageCount only when the stored value is 0", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    // Batch ingest leaves a fresh source with pageCount 0.
    const results = await wb.enqueuePdfBinaries([{ name: "batch.pdf", bytes: PDF_BYTES }]);
    const created = results.find((r) => r.status === "created")!;
    const id = created.sourceId as SourceId;
    expect(wb.rawData().sources.find((s) => s.id === id)!.pageCount).toBe(0);

    await wb.updateSourcePageCount(id, 7);
    expect(wb.rawData().sources.find((s) => s.id === id)!.pageCount).toBe(7);

    // A second call does NOT clobber the now-nonzero count.
    await wb.updateSourcePageCount(id, 99);
    expect(wb.rawData().sources.find((s) => s.id === id)!.pageCount).toBe(7);
  });

  it("is a no-op for a source that already has a real pageCount", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const versionHash = await sha256Hex(PDF_BYTES);
    const src = await wb.importSource({
      title: "Doc",
      bytes: PDF_BYTES,
      versionHash,
      pageCount: 3,
    });
    await wb.updateSourcePageCount(src.id, 50);
    expect(wb.rawData().sources.find((s) => s.id === src.id)!.pageCount).toBe(3);
  });
});
