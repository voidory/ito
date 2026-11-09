/**
 * FEAT-001 (M3) — offline-first binary eviction + the three resolution states
 * (A17). These drive the REAL Workbench + in-memory StorageAdapter:
 *
 *  - offloadSourceBinary removes ONLY the PDF bytes; Source + Annotation +
 *    EvidenceInstance records are untouched and status flips to
 *    "binary-offloaded".
 *  - resolveEvidenceSource reports "binary-offloaded" for an offloaded source
 *    (carrying the stored quote/page) and "resolved" once the matching binary
 *    is re-attached.
 *  - attachSourceBinary only accepts bytes whose sha256 matches the stored
 *    versionHash; a mismatched file writes nothing and leaves status offloaded.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { sha256Hex } from "../storage";
import { Workbench } from "./workbench";
import type { Source, SourceId, TextAnchor } from "../model";

/** PDF-magic bytes whose sha256 becomes the source's versionHash. */
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 10, 1, 2, 3]);

function textAnchor(sourceId: SourceId, versionHash: string, text: string): TextAnchor {
  return {
    docId: sourceId,
    sourceVersionHash: versionHash,
    pageIndex: 2,
    rects: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.02 }],
    selectedText: text,
    prefix: "before ",
    suffix: " after",
  };
}

/** Import a source whose versionHash is the TRUE sha256 of PDF_BYTES. */
async function importHashed(wb: Workbench): Promise<Source> {
  const versionHash = await sha256Hex(PDF_BYTES);
  return wb.importSource({
    title: "Hashed Doc",
    bytes: PDF_BYTES,
    versionHash,
    pageCount: 3,
    category: "Papers",
  });
}

describe("A17 — offline-first binary eviction", () => {
  let storage: InMemoryStorageAdapter;
  let wb: Workbench;
  let src: Source;
  beforeEach(async () => {
    storage = new InMemoryStorageAdapter();
    wb = await Workbench.open(storage);
    src = await importHashed(wb);
  });

  it("offloadSourceBinary removes bytes but keeps all records + flips status", async () => {
    const a = await wb.commitTextAnnotation({
      sourceId: src.id,
      anchor: textAnchor(src.id, src.versionHash, "keep me"),
    });
    const page = await wb.createSubjectPage("S");
    await wb.insertEvidenceIntoPage(a.annotation.id, page.id, { pos: null });

    const before = wb.rawData();
    const sourceCount = before.sources.length;
    const annCount = before.annotations.length;
    const eviCount = before.evidenceInstances.length;

    expect(wb.sourceBinaryStatus(src.id)).toBe("cached");
    await wb.offloadSourceBinary(src.id);

    // Records intact.
    expect(wb.rawData().sources).toHaveLength(sourceCount);
    expect(wb.rawData().annotations).toHaveLength(annCount);
    expect(wb.rawData().evidenceInstances).toHaveLength(eviCount);
    // Bytes gone; status offloaded.
    expect(await wb.readSourceBytes(src.id)).toBeNull();
    expect(wb.sourceBinaryStatus(src.id)).toBe("binary-offloaded");
  });

  it("resolveEvidenceSource reports binary-offloaded (carrying the quote) then resolved after re-attach", async () => {
    const a = await wb.commitTextAnnotation({
      sourceId: src.id,
      anchor: textAnchor(src.id, src.versionHash, "cited passage"),
    });
    const page = await wb.createSubjectPage("S");
    const e = await wb.insertEvidenceIntoPage(a.annotation.id, page.id, { pos: null });

    await wb.offloadSourceBinary(src.id);
    const offloaded = wb.resolveEvidenceSource(e.id)!;
    expect(offloaded.resolution.kind).toBe("binary-offloaded");
    // The citation still functions: it still points at the real source + anchor.
    expect(offloaded.sourceId).toBe(src.id);
    expect(offloaded.anchor?.selectedText).toBe("cited passage");

    const result = await wb.attachSourceBinary(src.id, PDF_BYTES);
    expect(result.attached).toBe(true);
    expect(wb.sourceBinaryStatus(src.id)).toBe("cached");
    expect(wb.resolveEvidenceSource(e.id)!.resolution.kind).toBe("resolved");
  });

  it("attachSourceBinary rejects mismatched bytes (writes nothing, stays offloaded)", async () => {
    await wb.offloadSourceBinary(src.id);
    expect(wb.sourceBinaryStatus(src.id)).toBe("binary-offloaded");

    const wrong = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 9, 9, 9]);
    const result = await wb.attachSourceBinary(src.id, wrong);
    expect(result.attached).toBe(false);
    expect(result.reason).toBeTruthy();
    // Nothing written; status unchanged; bytes still absent.
    expect(await wb.readSourceBytes(src.id)).toBeNull();
    expect(wb.sourceBinaryStatus(src.id)).toBe("binary-offloaded");
  });

  it("offloaded status survives a reopen (rebuilt from the adapter)", async () => {
    const brainId = wb.snapshot().brainId;
    await wb.offloadSourceBinary(src.id);

    const reopened = await Workbench.open(storage, brainId);
    expect(reopened.sourceBinaryStatus(src.id)).toBe("binary-offloaded");
  });
});
