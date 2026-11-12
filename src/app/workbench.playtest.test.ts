/**
 * Regressions for domain bugs found while playtesting the running app
 * (m8 data-integrity merge). Each test reproduces a confirmed failure at the
 * headless level so it cannot silently return.
 */
import { describe, expect, it } from "vitest";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { Workbench } from "./workbench";
import { appendText } from "../test/docHelpers";
import type { BrainData, SourceId, TextAnchor } from "../model";
import type { DocumentJson } from "../editor";

function textAnchor(sourceId: SourceId, versionHash: string, text: string): TextAnchor {
  return {
    docId: sourceId,
    sourceVersionHash: versionHash,
    pageIndex: 0,
    rects: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.02 }],
    selectedText: text,
    prefix: "",
    suffix: "",
  };
}

async function setup(storage = new InMemoryStorageAdapter()) {
  const wb = await Workbench.open(storage);
  const src = await wb.importSource({
    title: "Doc",
    bytes: new Uint8Array([1, 2, 3]),
    versionHash: "h1",
    pageCount: 3,
  });
  const a = await wb.commitTextAnnotation({
    sourceId: src.id,
    anchor: textAnchor(src.id, "h1", "alpha"),
  });
  const b = await wb.commitTextAnnotation({
    sourceId: src.id,
    anchor: textAnchor(src.id, "h1", "beta"),
  });
  return { wb, storage, src, a: a.annotation.id, b: b.annotation.id };
}

function evidenceIds(json: DocumentJson): string[] {
  const out: string[] = [];
  const walk = (n: { type?: string; attrs?: Record<string, unknown>; content?: unknown[] }) => {
    if (n.type === "evidence") out.push(String(n.attrs?.evidenceId));
    for (const c of (n.content ?? []) as (typeof n)[]) walk(c);
  };
  walk(json as never);
  return out;
}

/** Remove every evidence node from a doc JSON (what Backspace on a chip does). */
function stripEvidence(json: DocumentJson): DocumentJson {
  const strip = (n: { type?: string; content?: unknown[] }): unknown => ({
    ...n,
    ...(n.content
      ? {
          content: (n.content as (typeof n)[])
            .filter((c) => c.type !== "evidence")
            .map((c) => strip(c)),
        }
      : {}),
  });
  return strip(json as never) as DocumentJson;
}

describe("playtest regressions - persistence", () => {
  it("concurrent mutations are never lost when writes complete out of order", async () => {
    const storage = new InMemoryStorageAdapter();
    const { wb, a, b } = await setup(storage);
    // Make the FIRST write slow and the second fast, so they finish reversed.
    const realWrite = storage.writeBrain.bind(storage);
    let call = 0;
    storage.writeBrain = async (data: BrainData) => {
      const mine = call++;
      await new Promise((r) => setTimeout(r, mine === 0 ? 30 : 0));
      return realWrite(data);
    };
    const p1 = wb.setComment(a, "first");
    const p2 = wb.setComment(b, "second");
    await Promise.all([p1, p2]);
    const mem = wb.rawData().annotations;
    expect(mem.find((x) => x.id === a)!.comment).toBe("first");
    expect(mem.find((x) => x.id === b)!.comment).toBe("second");
    const stored = await storage.readBrain(wb.rawData().manifest.brainId);
    expect(stored!.annotations.find((x) => x.id === a)!.comment).toBe("first");
    expect(stored!.annotations.find((x) => x.id === b)!.comment).toBe("second");
    // Revisions stay strictly increasing.
    expect(stored!.manifest.publicationRevision).toBe(wb.rawData().manifest.publicationRevision);
  });

  it("a failed save is retried by retrySave() and clears the error", async () => {
    const { wb, src } = await setup();
    wb.forceNextSaveFailures(1);
    await expect(
      wb.commitTextAnnotation({ sourceId: src.id, anchor: textAnchor(src.id, "h1", "gamma") }),
    ).rejects.toThrow();
    expect(wb.snapshot().saveError).not.toBeNull();
    await wb.retrySave();
    expect(wb.snapshot().saveError).toBeNull();
  });

  it("opening without a brain id picks the most recently updated brain", async () => {
    // Two brains exist (e.g. created by a double-mounted startup). The one
    // holding the user's work was updated last and must win regardless of id
    // order in the store.
    const storage = new InMemoryStorageAdapter();
    const base = (await storage.readBrain(
      (await Workbench.open(storage)).rawData().manifest.brainId,
    ))!;
    const newer = "brain_zzzz" as never;
    const older = "brain_0000" as never;
    await storage.writeBrain({
      ...base,
      manifest: { ...base.manifest, brainId: older, updatedAt: "2000-01-01T00:00:00.000Z" },
    });
    await storage.writeBrain({
      ...base,
      manifest: { ...base.manifest, brainId: newer, updatedAt: "2999-01-01T00:00:00.000Z" },
    });
    const opened = await Workbench.open(storage);
    expect(opened.rawData().manifest.brainId).toBe(newer);
  });
});

describe("playtest regressions - evidence <-> composition consistency", () => {
  it("deleting a quote node in the editor drops its EvidenceInstance (solid -> none)", async () => {
    const { wb, a } = await setup();
    const { page } = await wb.createSubjectFromAnnotation("S", a);
    expect(wb.referenceStatus(a, page.id)).toBe("cited");
    await wb.saveSubjectDoc(page.id, stripEvidence(wb.subjectDocJson(page.id)));
    expect(wb.referenceStatus(a, page.id)).toBe("none");
    expect(wb.rawData().evidenceInstances).toHaveLength(0);
  });

  it("deleting a quote keeps the pair tentative when an association exists", async () => {
    const { wb, a } = await setup();
    const { page } = await wb.createSubjectFromAnnotation("S", a);
    await wb.associateWithSubject(a, page.id);
    await wb.saveSubjectDoc(page.id, stripEvidence(wb.subjectDocJson(page.id)));
    expect(wb.referenceStatus(a, page.id)).toBe("tentative");
  });

  it("re-adding a quote node (cut + paste) restores its EvidenceInstance", async () => {
    const { wb, a } = await setup();
    const { page } = await wb.createSubjectFromAnnotation("S", a);
    const withQuote = wb.subjectDocJson(page.id);
    await wb.saveSubjectDoc(page.id, stripEvidence(withQuote));
    await wb.saveSubjectDoc(page.id, withQuote);
    expect(wb.referenceStatus(a, page.id)).toBe("cited");
    expect(wb.rawData().evidenceInstances).toHaveLength(1);
  });

  it("deleting an annotation also removes its quote nodes from subject pages", async () => {
    const { wb, a, b } = await setup();
    const { page } = await wb.createSubjectFromAnnotation("S", a);
    await wb.insertEvidenceIntoPage(b, page.id, { pos: null });
    await wb.deleteAnnotation(a);
    const ids = evidenceIds(wb.subjectDocJson(page.id));
    expect(ids).toHaveLength(1);
    expect(wb.rawData().evidenceInstances.map((e) => e.id)).toEqual(ids);
  });

  it("a live editor's unsaved text survives an external insert/move on the same page", async () => {
    const { wb, a, b } = await setup();
    const { page } = await wb.createSubjectFromAnnotation("S", a);
    // The editor holds newer, unsaved content than the stored doc.
    let live = appendText(wb.subjectDocJson(page.id), "typed but not yet saved");
    const detach = wb.attachLiveDoc(page.id, () => live);
    await wb.insertEvidenceIntoPage(b, page.id, { pos: null });
    const stored = JSON.stringify(wb.subjectDocJson(page.id));
    expect(stored).toContain("typed but not yet saved");
    expect(evidenceIds(wb.subjectDocJson(page.id))).toHaveLength(2);
    live = appendText(wb.subjectDocJson(page.id), "more");
    await wb.moveSubjectBlock(page.id, 0, 1);
    expect(JSON.stringify(wb.subjectDocJson(page.id))).toContain("more");
    detach();
  });

  it("source-return for a deleted annotation reports unresolved with no bogus source id", async () => {
    const { wb, a, b } = await setup();
    const { page } = await wb.createSubjectFromAnnotation("S", a);
    const ev = await wb.insertEvidence(b, page.id, "beta");
    // Simulate a dangling instance (e.g. data from before the delete fix).
    const data = wb.rawData();
    (wb as unknown as { data: BrainData }).data = {
      ...data,
      annotations: data.annotations.filter((x) => x.id !== b),
    };
    const r = wb.resolveEvidenceSource(ev.id)!;
    expect(r.resolution.kind).toBe("unresolved");
    expect(r.sourceId).toBeNull();
  });

  it("source-return exposes a live mismatched resolution after source drift", async () => {
    // The current branch derives resolution live from the source version hash
    // via resolveEvidenceSource (there is no stored per-annotation resolution
    // to go stale), so drift must surface as an explicit mismatched state.
    const { wb, src, a } = await setup();
    await wb.createSubjectFromAnnotation("S", a);
    const ev = wb.rawData().evidenceInstances.find((e) => e.annotationId === a)!;
    expect(wb.resolveEvidenceSource(ev.id)!.resolution.kind).toBe("resolved");
    await wb.forceSourceVersionDrift(src.id);
    expect(wb.resolveEvidenceSource(ev.id)!.resolution.kind).toBe("mismatched");
  });

  it("source-return into a closed source adds it without closing other panes", async () => {
    const { wb, src } = await setup();
    const other = await wb.importSource({
      title: "Other",
      bytes: new Uint8Array([9]),
      versionHash: "h2",
      pageCount: 1,
    });
    const third = await wb.importSource({
      title: "Third",
      bytes: new Uint8Array([8]),
      versionHash: "h3",
      pageCount: 1,
    });
    wb.openTogether([third.id, other.id]);
    wb.ensureSourceOpen(src.id);
    expect(wb.snapshot().openSourceIds).toEqual([third.id, other.id, src.id]);
    wb.ensureSourceOpen(src.id);
    expect(wb.snapshot().openSourceIds).toHaveLength(3);
  });
});
