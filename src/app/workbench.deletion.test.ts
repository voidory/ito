/**
 * FEAT-001 (M3) — two-mode right-click highlight deletion (D02). These drive
 * the REAL Workbench + in-memory StorageAdapter:
 *
 *  - deleteAnnotationOnly removes the Annotation record but PRESERVES the
 *    quoting EvidenceInstance AND the inline evidence atom (the quote text
 *    survives in the page); the pair then resolves "unresolved".
 *  - deleteAnnotationAndQuotes records a pre-mutation Revision snapshot of each
 *    affected page, then removes the Annotation + matching EvidenceInstance +
 *    ONLY the matching inline atom, preserving surrounding prose and any OTHER
 *    unrelated quote in the same page.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { Workbench } from "./workbench";
import {
  evidenceInOrder,
  hydrateState,
  plainText,
  type DocumentJson,
} from "../editor";
import type { Source, SourceId, TextAnchor } from "../model";

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

async function importOne(wb: Workbench): Promise<Source> {
  return wb.importSource({
    title: "Doc",
    bytes: new Uint8Array([1, 2, 3, 4]),
    versionHash: "hash-Doc",
    pageCount: 3,
    category: "Papers",
  });
}

async function annotate(wb: Workbench, src: Source, text: string) {
  return wb.commitTextAnnotation({
    sourceId: src.id,
    anchor: textAnchor(src.id, src.versionHash, text),
  });
}

describe("D02 — deleteAnnotationOnly preserves the quote", () => {
  let wb: Workbench;
  let src: Source;
  beforeEach(async () => {
    wb = await Workbench.open(new InMemoryStorageAdapter());
    src = await importOne(wb);
  });

  it("removes the annotation but keeps the EvidenceInstance + inline atom; pair resolves unresolved", async () => {
    const a = await annotate(wb, src, "the surviving quote");
    const page = await wb.createSubjectPage("S");
    const e = await wb.insertEvidenceIntoPage(a.annotation.id, page.id, { pos: null });

    await wb.deleteAnnotationOnly(a.annotation.id);

    // Annotation gone, evidence preserved.
    expect(wb.rawData().annotations.some((x) => x.id === a.annotation.id)).toBe(false);
    expect(wb.rawData().evidenceInstances.some((x) => x.id === e.id)).toBe(true);

    // The inline atom (and its quoted text) survives in the page document.
    const doc = hydrateState(wb.subjectDocJson(page.id) as DocumentJson).doc;
    const atoms = evidenceInOrder(doc);
    expect(atoms.map((x) => x.attrs.evidenceId)).toEqual([e.id]);
    expect(atoms[0]!.attrs.quotedText).toBe("the surviving quote");

    // The pair now resolves "unresolved" (the annotation record is gone).
    const resolved = wb.resolveEvidenceSource(e.id)!;
    expect(resolved.resolution.kind).toBe("unresolved");
  });
});

describe("D02 — deleteAnnotationAndQuotes snapshots then removes only the matching atom", () => {
  let wb: Workbench;
  let src: Source;
  beforeEach(async () => {
    wb = await Workbench.open(new InMemoryStorageAdapter());
    src = await importOne(wb);
  });

  it("records a pre-mutation Revision snapshot and removes annotation + matching evidence + only the matching atom", async () => {
    const target = await annotate(wb, src, "DOOMED QUOTE");
    const other = await annotate(wb, src, "KEEP THIS QUOTE");
    const page = await wb.createSubjectPage("S");

    // Give the page some surrounding prose, plus both quotes in the same page.
    await wb.saveSubjectDoc(page.id, {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "surrounding prose" }] }],
    } satisfies DocumentJson);
    const eTarget = await wb.insertEvidenceIntoPage(target.annotation.id, page.id, {
      pos: null,
    });
    const eOther = await wb.insertEvidenceIntoPage(other.annotation.id, page.id, {
      pos: null,
    });

    const revisionsBefore = wb.rawData().revisions.length;

    await wb.deleteAnnotationAndQuotes(target.annotation.id);

    // (1) A reconstructable Revision snapshot of the affected page was recorded
    // BEFORE the mutation (its beforeSnapshot still holds the doomed atom).
    const revisions = wb.rawData().revisions;
    expect(revisions.length).toBe(revisionsBefore + 1);
    const rev = revisions[revisions.length - 1]!;
    expect(rev.affectedObjectIds).toEqual([page.id]);
    expect(rev.summary).toContain(target.annotation.id);
    const snap = rev.beforeSnapshot as { pageId: string; documentJson: DocumentJson }[];
    const snapAtoms = evidenceInOrder(hydrateState(snap[0]!.documentJson).doc);
    expect(snapAtoms.map((x) => x.attrs.evidenceId).sort()).toEqual(
      [eTarget.id, eOther.id].sort(),
    );

    // (2) The annotation + its matching evidence are gone; the OTHER survives.
    expect(wb.rawData().annotations.some((x) => x.id === target.annotation.id)).toBe(false);
    expect(wb.rawData().annotations.some((x) => x.id === other.annotation.id)).toBe(true);
    expect(wb.rawData().evidenceInstances.some((x) => x.id === eTarget.id)).toBe(false);
    expect(wb.rawData().evidenceInstances.some((x) => x.id === eOther.id)).toBe(true);

    // (3) Only the matching inline atom was stripped; the other quote + prose stay.
    const doc = hydrateState(wb.subjectDocJson(page.id) as DocumentJson).doc;
    const atoms = evidenceInOrder(doc);
    expect(atoms.map((x) => x.attrs.evidenceId)).toEqual([eOther.id]);
    expect(plainText(doc)).toContain("surrounding prose");
  });

  it("is a no-op for an unknown annotation id (records no revision)", async () => {
    const before = wb.rawData().revisions.length;
    await wb.deleteAnnotationAndQuotes("ann_does_not_exist" as never);
    expect(wb.rawData().revisions.length).toBe(before);
  });
});

describe("deleteSource removes the document but never the quotes already written", () => {
  it("drops the source, its binary, annotations and associations; keeps evidence + atoms", async () => {
    const storage = new InMemoryStorageAdapter();
    const wb = await Workbench.open(storage);
    const doomed = await importOne(wb);
    const other = await wb.importSource({
      title: "Other",
      bytes: new Uint8Array([9, 9, 9]),
      versionHash: "hash-Other",
      pageCount: 1,
    });
    const a = await annotate(wb, doomed, "a quote that outlives its pdf");
    const page = await wb.createSubjectPage("S");
    const e = await wb.insertEvidenceIntoPage(a.annotation.id, page.id, { pos: null });
    wb.openSource(doomed.id);

    await wb.deleteSource(doomed.id);

    const data = wb.rawData();
    expect(data.sources.map((s) => s.id)).toEqual([other.id]);
    expect(data.annotations.some((x) => x.sourceId === doomed.id)).toBe(false);
    expect(data.manifest.assetIndex.some((x) => x.assetId === doomed.assetId)).toBe(false);
    expect(await storage.readAsset(data.manifest.brainId, doomed.assetId)).toBeNull();
    expect(wb.snapshot().openSourceIds).not.toContain(doomed.id);

    // The quote stays in the page, with its text.
    expect(data.evidenceInstances.some((x) => x.id === e.id)).toBe(true);
    const doc = hydrateState(wb.subjectDocJson(page.id) as DocumentJson).doc;
    expect(evidenceInOrder(doc)[0]!.attrs.quotedText).toBe("a quote that outlives its pdf");
  });

  it("is a no-op for an unknown source id", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const before = wb.rawData().sources.length;
    await wb.deleteSource("nope" as SourceId);
    expect(wb.rawData().sources.length).toBe(before);
  });
});
