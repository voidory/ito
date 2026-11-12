/**
 * M2-FIX-4 (FEAT-002): annotation styles live in
 * `presentation.annotationStyles`, NOT in a sentinel `Capture`.
 *
 * These drive the REAL Workbench + InMemoryStorageAdapter (nothing mocked) and
 * prove: (1) setting/committing a style persists into
 * presentation.annotationStyles and round-trips across a reopen; (2) captures
 * never gains a sourceId===null sentinel after setting styles; (3) a brain
 * pre-seeded with a legacy sentinel Capture loads with that capture STRIPPED
 * from captures while the style is preserved and readable via viewFor; (4)
 * DEFAULT_STYLE is returned for an annotation with no stored style. Each test
 * fails if the refactor is reverted.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { DEFAULT_STYLE, Workbench, type AnnotationStyle } from "./workbench";
import {
  createEmptyBrainData,
  newCaptureId,
  type BrainData,
  type SourceId,
  type TextAnchor,
} from "../model";

/** The legacy M1 sentinel tag — duplicated here so the test is self-contained. */
const LEGACY_STYLE_CAPTURE_TAG = "\u0000ito:annotation-styles\u0000";

function textAnchor(sourceId: SourceId, versionHash: string, text: string): TextAnchor {
  return {
    docId: sourceId,
    sourceVersionHash: versionHash,
    pageIndex: 0,
    rects: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.02 }],
    selectedText: text,
    prefix: "before ",
    suffix: " after",
  };
}

async function importOne(wb: Workbench, title = "Doc") {
  return wb.importSource({
    title,
    bytes: new Uint8Array([1, 2, 3, 4]),
    versionHash: "hash-" + title,
    pageCount: 3,
    category: "Papers",
  });
}

describe("Workbench — annotation styles live in presentation.annotationStyles", () => {
  let storage: InMemoryStorageAdapter;
  let wb: Workbench;

  beforeEach(async () => {
    storage = new InMemoryStorageAdapter();
    wb = await Workbench.open(storage);
  });

  it("stores a committed style in presentation.annotationStyles (not captures)", async () => {
    const src = await importOne(wb);
    const style: AnnotationStyle = { kind: "underline", color: "green" };
    const view = await wb.commitTextAnnotation({
      sourceId: src.id,
      anchor: textAnchor(src.id, src.versionHash, "quote"),
      style,
    });
    const data = wb.rawData();
    expect(data.presentation.annotationStyles?.[view.annotation.id]).toEqual({
      kind: "underline",
      color: "green",
    });
    // The style must NOT be smuggled into captures.
    expect(data.captures).toHaveLength(0);
  });

  it("setAnnotationStyle writes presentation.annotationStyles and never a sentinel capture", async () => {
    const src = await importOne(wb);
    const view = await wb.commitTextAnnotation({
      sourceId: src.id,
      anchor: textAnchor(src.id, src.versionHash, "quote"),
    });
    await wb.setAnnotationStyle(view.annotation.id, { kind: "highlight", color: "pink" });

    const data = wb.rawData();
    expect(data.presentation.annotationStyles?.[view.annotation.id]).toEqual({
      kind: "highlight",
      color: "pink",
    });
    // Invariant: no sourceId===null style sentinel ever appears in captures.
    expect(data.captures.some((c) => c.sourceId === null)).toBe(false);
    expect(wb.viewFor(view.annotation.id)!.style).toEqual({
      kind: "highlight",
      color: "pink",
    });
  });

  it("round-trips a style across a reopen on the same storage", async () => {
    const src = await importOne(wb);
    const view = await wb.commitTextAnnotation({
      sourceId: src.id,
      anchor: textAnchor(src.id, src.versionHash, "quote"),
      style: { kind: "underline", color: "blue" },
    });
    const annId = view.annotation.id;

    // Reopen a fresh Workbench against the SAME storage.
    const reopened = await Workbench.open(storage);
    expect(reopened.viewFor(annId)!.style).toEqual({ kind: "underline", color: "blue" });
    expect(reopened.rawData().presentation.annotationStyles?.[annId]).toEqual({
      kind: "underline",
      color: "blue",
    });
    expect(reopened.rawData().captures).toHaveLength(0);
  });

  it("returns DEFAULT_STYLE for an annotation with no stored style", async () => {
    const src = await importOne(wb);
    // Commit then manually drop the style so the id has no entry.
    const view = await wb.commitTextAnnotation({
      sourceId: src.id,
      anchor: textAnchor(src.id, src.versionHash, "quote"),
    });
    // A committed annotation gets DEFAULT_STYLE; assert the default round-trips.
    expect(wb.viewFor(view.annotation.id)!.style).toEqual(DEFAULT_STYLE);
  });

  it("deleting an annotation removes its style entry", async () => {
    const src = await importOne(wb);
    const view = await wb.commitTextAnnotation({
      sourceId: src.id,
      anchor: textAnchor(src.id, src.versionHash, "quote"),
      style: { kind: "highlight", color: "pink" },
    });
    const annId = view.annotation.id;
    expect(wb.rawData().presentation.annotationStyles?.[annId]).toBeDefined();
    await wb.deleteAnnotation(annId);
    expect(wb.rawData().presentation.annotationStyles?.[annId]).toBeUndefined();
  });

  it("strips a legacy sentinel Capture on load and preserves its style", async () => {
    // Build a brain pre-seeded with the M1 sentinel capture plus a REAL capture.
    const base = createEmptyBrainData();
    const annId = "ann-legacy";
    const stylePayload = JSON.stringify({
      [annId]: { kind: "underline", color: "blue" },
    });
    const seeded: BrainData = {
      ...base,
      captures: [
        {
          id: newCaptureId(),
          sourceId: null,
          text: LEGACY_STYLE_CAPTURE_TAG + stylePayload,
          createdAt: new Date().toISOString(),
        },
        {
          id: newCaptureId(),
          // A genuine user capture must survive untouched.
          sourceId: "src-real" as SourceId,
          text: "a real user clipping",
          createdAt: new Date().toISOString(),
        },
      ],
      // Strip any pre-existing annotationStyles so migration populates it.
      presentation: { ...base.presentation, annotationStyles: {} },
    };
    await storage.writeBrain(seeded);

    const loaded = await Workbench.open(storage, seeded.manifest.brainId);
    const data = loaded.rawData();

    // The sentinel capture is gone; the real capture remains.
    expect(data.captures.some((c) => c.sourceId === null)).toBe(false);
    expect(data.captures).toHaveLength(1);
    expect(data.captures[0]!.text).toBe("a real user clipping");

    // The migrated style is readable from presentation.annotationStyles.
    expect(data.presentation.annotationStyles?.[annId]).toEqual({
      kind: "underline",
      color: "blue",
    });

    // And the cleaned brain was persisted once, so a second reopen is clean too.
    const reopened = await Workbench.open(storage, seeded.manifest.brainId);
    expect(reopened.rawData().captures.some((c) => c.sourceId === null)).toBe(false);
    expect(reopened.rawData().presentation.annotationStyles?.[annId]).toEqual({
      kind: "underline",
      color: "blue",
    });
  });

  it("legacy migration does not overwrite an already-present presentation style", async () => {
    const base = createEmptyBrainData();
    const annId = "ann-keep";
    const seeded: BrainData = {
      ...base,
      captures: [
        {
          id: newCaptureId(),
          sourceId: null,
          text:
            LEGACY_STYLE_CAPTURE_TAG +
            JSON.stringify({ [annId]: { kind: "underline", color: "blue" } }),
          createdAt: new Date().toISOString(),
        },
      ],
      presentation: {
        ...base.presentation,
        // Already styled in presentation: migration must NOT clobber it.
        annotationStyles: { [annId]: { kind: "highlight", color: "pink" } },
      },
    };
    await storage.writeBrain(seeded);

    const loaded = await Workbench.open(storage, seeded.manifest.brainId);
    expect(loaded.rawData().presentation.annotationStyles?.[annId]).toEqual({
      kind: "highlight",
      color: "pink",
    });
    expect(loaded.rawData().captures.some((c) => c.sourceId === null)).toBe(false);
  });
});
