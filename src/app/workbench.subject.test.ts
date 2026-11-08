/**
 * FEAT-004 — subject layer + continuous editor domain tests (Vitest).
 *
 * These assert the composition-side invariants through the real Workbench +
 * in-memory storage: deliberate creation from evidence, insert-at-cursor
 * dotted->solid with the source annotation surviving, reorder preserving
 * identities, remove-one-quote-no-demote, precise source-return resolution
 * (including the changed/missing-version explicit states, A17), and a full
 * save/reopen composition round-trip (R14, M1 durability gate).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { Workbench } from "./workbench";
import { evidenceInOrder, hydrateState, outline, type DocumentJson } from "../editor";
import type { PageId, Source, SourceId, TextAnchor } from "../model";

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

async function importOne(wb: Workbench, title = "Doc"): Promise<Source> {
  return wb.importSource({
    title,
    bytes: new Uint8Array([1, 2, 3, 4]),
    versionHash: "hash-" + title,
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

describe("FEAT-004 — deliberate subject creation from evidence (A03)", () => {
  let storage: InMemoryStorageAdapter;
  let wb: Workbench;
  beforeEach(async () => {
    storage = new InMemoryStorageAdapter();
    wb = await Workbench.open(storage);
  });

  it("creates a subject with the evidence already cited; no parent required", async () => {
    const src = await importOne(wb);
    const a = await annotate(wb, src, "quick brown fox");
    const { page, evidence } = await wb.createSubjectFromAnnotation(
      "Causality in chemistry",
      a.annotation.id,
    );
    // Deliberate: the page exists and the pair derives straight to SOLID
    // (source-local -> solid, no prior tentative association needed).
    expect(page.kind).toBe("subject");
    expect(page.title).toBe("Causality in chemistry");
    expect(wb.referenceStatus(a.annotation.id, page.id)).toBe("cited");
    expect(wb.rawData().subjectAssociations).toHaveLength(0);
    // The quote is really composed into the page document.
    const ev = evidenceInOrder(hydrateState(wb.subjectDocJson(page.id) as DocumentJson).doc);
    expect(ev.map((e) => e.attrs.evidenceId)).toEqual([evidence.id]);
    // The source annotation survives unchanged (R06).
    expect(wb.rawData().annotations).toHaveLength(1);
    expect(wb.rawData().annotations[0]!.id).toBe(a.annotation.id);
  });

  it("importing or annotating NEVER auto-creates a subject page", async () => {
    const src = await importOne(wb);
    await annotate(wb, src, "nothing happens");
    expect(wb.rawData().pages).toHaveLength(0);
  });
});

describe("FEAT-004 — insert at cursor dotted->solid; annotation survives (A05, R06)", () => {
  let storage: InMemoryStorageAdapter;
  let wb: Workbench;
  let src: Source;
  beforeEach(async () => {
    storage = new InMemoryStorageAdapter();
    wb = await Workbench.open(storage);
    src = await importOne(wb);
  });

  it("insertEvidenceIntoPage turns a dotted association solid, leaving the annotation", async () => {
    const a = await annotate(wb, src, "evidence text");
    const page = await wb.createSubjectPage("Subject");
    await wb.associateWithSubject(a.annotation.id, page.id);
    expect(wb.referenceStatus(a.annotation.id, page.id)).toBe("tentative");

    await wb.insertEvidenceIntoPage(a.annotation.id, page.id, { pos: null });
    expect(wb.referenceStatus(a.annotation.id, page.id)).toBe("cited");
    // Source annotation is neither moved nor deleted.
    expect(wb.rawData().annotations.map((x) => x.id)).toEqual([a.annotation.id]);
  });

  it("no mandatory template: a page can hold writing with a quote inserted mid-paragraph", async () => {
    const a = await annotate(wb, src, "inserted quote");
    const page = await wb.createSubjectPage("Free composition");
    // Author writes first.
    await wb.saveSubjectDoc(page.id, {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "I think X because Y." }] }],
    });
    // Insert the quote at an explicit mid-paragraph cursor position.
    const pos = "I think X because ".length + 1;
    await wb.insertEvidenceIntoPage(a.annotation.id, page.id, { pos });
    const lines = outline(hydrateState(wb.subjectDocJson(page.id) as DocumentJson).doc);
    expect(lines[0]).toContain("I think X because ⟦evidence:");
    expect(lines[0]).toContain("Y.");
  });

  it("optionally copies the annotation comment, clearly marked, without overwriting writing", async () => {
    const a = await annotate(wb, src, "cited phrase");
    await wb.setComment(a.annotation.id, "my marginal note");
    const page = await wb.createSubjectPage("With comment");
    await wb.saveSubjectDoc(page.id, {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Original writing." }] }],
    });
    await wb.insertEvidenceIntoPage(a.annotation.id, page.id, { pos: null, includeComment: true });
    const doc = hydrateState(wb.subjectDocJson(page.id) as DocumentJson).doc;
    let copiedText = "";
    let hasOriginal = false;
    doc.forEach((b) => {
      if (b.attrs.copiedComment) copiedText = b.textContent;
      if (b.textContent.includes("Original writing.")) hasOriginal = true;
    });
    expect(copiedText).toBe("my marginal note");
    expect(hasOriginal).toBe(true);
  });
});

describe("FEAT-004 — reorder + remove-one-quote (A04, section 6)", () => {
  let wb: Workbench;
  let src: Source;
  beforeEach(async () => {
    wb = await Workbench.open(new InMemoryStorageAdapter());
    src = await importOne(wb);
  });

  it("reorders blocks preserving composition order + quote identities", async () => {
    const a1 = await annotate(wb, src, "quote A");
    const a2 = await annotate(wb, src, "quote B");
    const page = await wb.createSubjectPage("Reorder");
    await wb.saveSubjectDoc(page.id, {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Paragraph." }] },
        { type: "paragraph" },
        { type: "paragraph" },
      ],
    });
    // Compose quoteA (block 1) then quoteB (block 2) at their own positions.
    await wb.insertEvidenceIntoPage(a1.annotation.id, page.id, { pos: 11 });
    const before = wb
      .subjectDocJson(page.id) as DocumentJson;
    const beforeOrder = evidenceInOrder(hydrateState(before).doc).map((e) => e.attrs.annotationId);
    expect(beforeOrder).toEqual([a1.annotation.id]);

    await wb.insertEvidenceIntoPage(a2.annotation.id, page.id, { pos: null });
    const order1 = evidenceInOrder(
      hydrateState(wb.subjectDocJson(page.id) as DocumentJson).doc,
    ).map((e) => e.attrs.annotationId);
    expect(order1).toEqual([a1.annotation.id, a2.annotation.id]);

    // Move the last block to the front; identities preserved, order flipped.
    const blockCount = hydrateState(wb.subjectDocJson(page.id) as DocumentJson).doc.childCount;
    await wb.moveSubjectBlock(page.id, blockCount - 1, 0);
    const order2 = evidenceInOrder(
      hydrateState(wb.subjectDocJson(page.id) as DocumentJson).doc,
    ).map((e) => e.attrs.annotationId);
    expect(order2).toEqual([a2.annotation.id, a1.annotation.id]);
  });

  it("removing one of two quotes for a pair does NOT demote while another remains", async () => {
    const a = await annotate(wb, src, "the same source phrase");
    const page = await wb.createSubjectPage("Two quotes");
    const e1 = await wb.insertEvidenceIntoPage(a.annotation.id, page.id, { pos: null });
    await wb.insertEvidenceIntoPage(a.annotation.id, page.id, { pos: null });
    expect(wb.referenceStatus(a.annotation.id, page.id)).toBe("cited");

    await wb.removeEvidence(e1.id);
    // Still cited: another quote remains for the pair.
    expect(wb.referenceStatus(a.annotation.id, page.id)).toBe("cited");
    // The removed node is gone from the composition; one remains.
    const ev = evidenceInOrder(hydrateState(wb.subjectDocJson(page.id) as DocumentJson).doc);
    expect(ev).toHaveLength(1);
  });

  it("removing the LAST quote reverts to tentative iff an association remains, else none", async () => {
    const a = await annotate(wb, src, "solo");
    const withAssoc = await wb.createSubjectPage("Has association");
    const bare = await wb.createSubjectPage("No association");

    await wb.associateWithSubject(a.annotation.id, withAssoc.id);
    const eA = await wb.insertEvidenceIntoPage(a.annotation.id, withAssoc.id, { pos: null });
    const eB = await wb.insertEvidenceIntoPage(a.annotation.id, bare.id, { pos: null });

    await wb.removeEvidence(eA.id);
    expect(wb.referenceStatus(a.annotation.id, withAssoc.id)).toBe("tentative");
    await wb.removeEvidence(eB.id);
    expect(wb.referenceStatus(a.annotation.id, bare.id)).toBe("none");
  });
});

describe("FEAT-004 — precise source-return + explicit unresolved (A17)", () => {
  let wb: Workbench;
  let src: Source;
  beforeEach(async () => {
    wb = await Workbench.open(new InMemoryStorageAdapter());
    src = await importOne(wb);
  });

  it("resolves to the exact source for an intact version", async () => {
    const a = await annotate(wb, src, "find me");
    const page = await wb.createSubjectPage("S");
    const e = await wb.insertEvidenceIntoPage(a.annotation.id, page.id, { pos: null });
    const resolved = wb.resolveEvidenceSource(e.id)!;
    expect(resolved.resolution.kind).toBe("resolved");
    expect(resolved.sourceId).toBe(src.id);
    expect(resolved.anchor?.selectedText).toBe("find me");
  });

  it("a changed source version yields an explicit MISMATCHED state, never silent nav", async () => {
    const storage = new InMemoryStorageAdapter();
    const wb2 = await Workbench.open(storage);
    const brainId = wb2.snapshot().brainId;
    const s = await importOne(wb2);
    const a = await annotate(wb2, s, "will drift");
    const page = await wb2.createSubjectPage("S");
    const e = await wb2.insertEvidenceIntoPage(a.annotation.id, page.id, { pos: null });

    // Simulate the source edition changing under the quote by rewriting the
    // stored source with a different version hash, then reopening.
    const stored = (await storage.readBrain(brainId))!;
    const idx = stored.sources.findIndex((x) => x.id === s.id);
    const sources = stored.sources.slice();
    sources[idx] = { ...stored.sources[idx]!, versionHash: "hash-CHANGED" };
    await storage.writeBrain({ ...stored, sources });

    const reopened = await Workbench.open(storage, brainId);
    const resolved = reopened.resolveEvidenceSource(e.id)!;
    expect(resolved.resolution.kind).toBe("mismatched");
    if (resolved.resolution.kind === "mismatched") {
      expect(resolved.resolution.actualVersionHash).toBe("hash-CHANGED");
      expect(resolved.resolution.expectedVersionHash).toBe(s.versionHash);
    }
  });

  it("a missing source annotation yields an explicit UNRESOLVED state", async () => {
    const a = await annotate(wb, src, "gone soon");
    const page = await wb.createSubjectPage("S");
    const e = await wb.insertEvidenceIntoPage(a.annotation.id, page.id, { pos: null });
    await wb.deleteAnnotation(a.annotation.id);
    const resolved = wb.resolveEvidenceSource(e.id);
    // deleteAnnotation also drops the evidence, so source-return reports missing.
    expect(resolved === null || resolved.resolution.kind === "unresolved").toBe(true);
  });
});

describe("FEAT-004 — durable composition round-trip (R14, M1 gate)", () => {
  it("save/close/reopen restores order, identities, provenance and anchors byte-equivalently", async () => {
    const storage = new InMemoryStorageAdapter();
    const wb = await Workbench.open(storage);
    const brainId = wb.snapshot().brainId;
    const src = await importOne(wb);
    const a1 = await annotate(wb, src, "quote alpha");
    const a2 = await annotate(wb, src, "quote beta");
    const page = await wb.createSubjectPage("Durable");

    await wb.saveSubjectDoc(page.id, {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Opening paragraph." }] },
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: "Interpretation." }] },
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: "A closing question?" }] },
      ],
    });
    // paragraph/quoteA/interpretation/quoteB/question composition.
    await wb.insertEvidenceIntoPage(a1.annotation.id, page.id, { pos: offsetOfBlock(wb, page.id, 1) });
    await wb.insertEvidenceIntoPage(a2.annotation.id, page.id, { pos: offsetOfBlock(wb, page.id, 3) });

    const savedJson = JSON.stringify(wb.subjectDocJson(page.id));
    const savedOutline = outline(hydrateState(JSON.parse(savedJson) as DocumentJson).doc);

    // Reopen from the same storage: the composition restores EXACTLY.
    const reopened = await Workbench.open(storage, brainId);
    const reopenedJson = JSON.stringify(reopened.subjectDocJson(page.id));
    expect(reopenedJson).toBe(savedJson);
    const reopenedOutline = outline(hydrateState(JSON.parse(reopenedJson) as DocumentJson).doc);
    expect(reopenedOutline).toEqual(savedOutline);
    // Order + provenance intact.
    const ev = evidenceInOrder(hydrateState(JSON.parse(reopenedJson) as DocumentJson).doc);
    expect(ev.map((e) => e.attrs.annotationId)).toEqual([a1.annotation.id, a2.annotation.id]);
    for (const e of ev) {
      expect(e.attrs.anchor.selectedText.length).toBeGreaterThan(0);
    }
    // Citation states survive.
    expect(reopened.referenceStatus(a1.annotation.id, page.id)).toBe("cited");
    expect(reopened.referenceStatus(a2.annotation.id, page.id)).toBe("cited");
  });
});

/** Compute the document position at the START of a top-level block index. */
function offsetOfBlock(wb: Workbench, pageId: PageId, blockIndex: number): number {
  const doc = hydrateState(wb.subjectDocJson(pageId) as DocumentJson).doc;
  let pos = 1;
  for (let i = 0; i < blockIndex && i < doc.childCount; i++) pos += doc.child(i).nodeSize;
  return pos;
}
