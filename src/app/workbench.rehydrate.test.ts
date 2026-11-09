/**
 * M12 (FEAT-001) — Universal PDF identity engine + slot re-hydration +
 * highlight re-anchoring domain tests (Vitest).
 *
 * These drive the REAL Workbench + in-memory storage through the five mandatory
 * invariants from the M12 handoff: exact offload round-trip, prepended-cover
 * page shift, textbook format invariance, revised-draft paragraph move, and the
 * sequence-collision veto. All page texts are supplied directly (no pdf.js),
 * exercising the pure fingerprint engine end-to-end.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { Workbench } from "./workbench";
import type { Annotation, Source, SourceId, TextAnchor } from "../model";

/** Deterministic bytes from a string so two imports can differ byte-wise. */
function bytesFrom(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function textAnchor(
  sourceId: SourceId,
  versionHash: string,
  text: string,
  pageIndex: number,
): TextAnchor {
  return {
    docId: sourceId,
    sourceVersionHash: versionHash,
    pageIndex,
    rects: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.02 }],
    selectedText: text,
    prefix: "",
    suffix: "",
  };
}

async function annotate(
  wb: Workbench,
  src: Source,
  text: string,
  pageIndex: number,
) {
  return wb.commitTextAnnotation({
    sourceId: src.id,
    anchor: textAnchor(src.id, src.versionHash, text, pageIndex),
  });
}

/** Read the (single) text annotation's current page index for a source. */
function textAnnotationPage(wb: Workbench, sourceId: SourceId): number {
  const ann = wb
    .rawData()
    .annotations.find((a: Annotation) => a.sourceId === sourceId && a.scope.kind === "text")!;
  if (ann.scope.kind !== "text") throw new Error("expected text anchor");
  return ann.scope.anchor.pageIndex;
}

/** 20 pages of prose with a `seed` and optional per-page OCR mutations. */
function book(seed: string, prefacePages: number, mutateMid: boolean): string[] {
  const pages: string[] = [];
  for (let p = 0; p < prefacePages; p++) {
    pages.push(`${seed} preface page ${p} table of contents acknowledgements foreword`);
  }
  for (let p = 0; p < 20; p++) {
    const lines: string[] = [];
    for (let l = 0; l < 20; l++) {
      let line = `chapter body paragraph ${p} sentence ${l} discusses thermodynamics entropy enthalpy gibbs free energy equilibrium reaction kinetics.`;
      // Simulate ~5% OCR word mutations only in the middle pages.
      if (mutateMid && p >= 7 && p <= 12 && l % 20 === 0) {
        line = line.replace("thermodynamics", "thermodynamlcs");
      }
      lines.push(line);
    }
    pages.push(lines.join("\n"));
  }
  return pages;
}

describe("M12 FEAT-001 — slot re-hydration & highlight re-anchoring", () => {
  let storage: InMemoryStorageAdapter;
  let wb: Workbench;
  beforeEach(async () => {
    storage = new InMemoryStorageAdapter();
    wb = await Workbench.open(storage);
  });

  it("Test 1 — exact offload round-trip re-hydrates the same slot", async () => {
    const bytes = bytesFrom("EXACT-PDF-CONTENT-BYTES-123456");
    const src = await wb.importSource({
      title: "Quantum Paper.pdf",
      bytes,
      versionHash: "v1",
      pageCount: 3,
      pageTexts: ["cover", "quantum decoherence in microtubules", "references"],
    });
    const a = await annotate(wb, src, "quantum decoherence in microtubules", 1);

    await wb.offloadSourceBinary(src.id);
    expect(wb.sourceBinaryStatus(src.id)).toBe("binary-offloaded");

    // Re-import the EXACT same bytes.
    const reconciled = await wb.reconcileOrAttachSource({
      title: "Quantum Paper.pdf",
      bytes,
      versionHash: "v1",
      pageCount: 3,
      pageTexts: ["cover", "quantum decoherence in microtubules", "references"],
    });

    expect(reconciled.matched).toBe(true);
    expect(wb.snapshot().sources).toHaveLength(1);
    expect(reconciled.source.id).toBe(src.id);
    expect(wb.sourceBinaryStatus(src.id)).toBe("cached");
    // The highlight survives and stays on its page.
    const anns = wb.rawData().annotations;
    expect(anns).toHaveLength(1);
    expect(anns[0]!.id).toBe(a.annotation.id);
    expect(textAnnotationPage(wb, src.id)).toBe(1);
  });

  it("Test 2 — prepended cover page shifts the highlight by +1", async () => {
    const original = [
      "title page of the paper",
      "quantum decoherence in microtubules orch or penrose hameroff model",
      "concluding remarks and references list",
    ];
    const src = await wb.importSource({
      title: "Penrose Paper.pdf",
      bytes: bytesFrom("ORIGINAL-PAPER-BYTES"),
      versionHash: "v1",
      pageCount: 3,
      pageTexts: original,
    });
    await annotate(
      wb,
      src,
      "quantum decoherence in microtubules orch or penrose hameroff model",
      1,
    );
    expect(textAnnotationPage(wb, src.id)).toBe(1);

    // Re-import with a JSTOR cover sheet prepended (different bytes + page 0).
    const withCover = ["JSTOR Cover Sheet Downloaded 2026", ...original];
    const reconciled = await wb.reconcileOrAttachSource({
      title: "Penrose Paper.pdf",
      bytes: bytesFrom("JSTOR-WRAPPED-PAPER-BYTES"),
      versionHash: "v2",
      pageCount: 4,
      pageTexts: withCover,
    });

    expect(reconciled.matched).toBe(true);
    expect(reconciled.source.id).toBe(src.id);
    expect(wb.snapshot().sources).toHaveLength(1);
    expect(textAnnotationPage(wb, src.id)).toBe(2); // shifted +1
  });

  it("Test 3 — textbook format invariance (different prefaces + OCR noise)", async () => {
    const editionA = book("Edition-A", 1, false);
    const editionB = book("Edition-B", 3, true);

    const src = await wb.importSource({
      title: "Physical Chemistry Textbook.pdf",
      bytes: bytesFrom("EDITION-A-BYTES"),
      versionHash: "a",
      pageCount: editionA.length,
      pageTexts: editionA,
    });

    const reconciled = await wb.reconcileOrAttachSource({
      title: "Physical Chemistry Textbook.pdf",
      bytes: bytesFrom("EDITION-B-BYTES-DIFFERENT"),
      versionHash: "b",
      pageCount: editionB.length,
      pageTexts: editionB,
    });

    expect(reconciled.matched).toBe(true);
    expect(reconciled.source.id).toBe(src.id);
    expect(wb.snapshot().sources).toHaveLength(1);
  });

  it("Test 4 — revised uni doc draft->final moves the highlight's page", async () => {
    const draftPages = [
      "introduction and apparatus list for the titration experiment procedure steps safety goggles pipette burette conical flask",
      "results discussion sources of error and conclusion of the laboratory report",
    ];
    const src = await wb.importSource({
      title: "CH2101_Lab1_draft.pdf",
      bytes: bytesFrom("LAB1-DRAFT-BYTES"),
      versionHash: "draft",
      pageCount: 2,
      pageTexts: draftPages,
    });
    await annotate(
      wb,
      src,
      "introduction and apparatus list for the titration experiment procedure steps safety goggles pipette burette conical flask",
      0,
    );
    expect(textAnnotationPage(wb, src.id)).toBe(0);

    // Final: 50% of prose edited; the highlighted paragraph moved to page 1.
    const finalPages = [
      "completely rewritten abstract and theoretical background section with new equations and rate law derivations for the experiment",
      "introduction and apparatus list for the titration experiment procedure steps safety goggles pipette burette conical flask",
    ];
    const reconciled = await wb.reconcileOrAttachSource({
      title: "CH2101_Lab1_final.pdf",
      bytes: bytesFrom("LAB1-FINAL-BYTES"),
      versionHash: "final",
      pageCount: 2,
      pageTexts: finalPages,
    });

    expect(reconciled.matched).toBe(true);
    expect(reconciled.source.id).toBe(src.id);
    expect(wb.snapshot().sources).toHaveLength(1);
    expect(textAnnotationPage(wb, src.id)).toBe(1); // moved to page 1
  });

  it("Test 5 — sequence veto keeps Lab1 and Lab2 as distinct sources", async () => {
    const template = [
      "CH2101 Physical Chemistry Laboratory course template header boilerplate shared across every lab handout in the module this semester",
      "general safety instructions wear goggles lab coat closed shoes no food or drink standard apparatus cleaning and waste disposal rules",
    ];
    const lab1 = await wb.importSource({
      title: "CH2101_Lab1_draft.pdf",
      bytes: bytesFrom("LAB1-BYTES"),
      versionHash: "l1",
      pageCount: 2,
      pageTexts: [
        ...template,
        "lab 1 specific titration of a strong acid with a strong base measuring the equivalence point",
      ],
    });

    const reconciled = await wb.reconcileOrAttachSource({
      title: "CH2101_Lab2_draft.pdf",
      bytes: bytesFrom("LAB2-BYTES"),
      versionHash: "l2",
      pageCount: 2,
      pageTexts: [
        ...template,
        "lab 2 specific gravimetric analysis of a chloride salt by precipitation and filtration drying to constant mass",
      ],
    });

    expect(reconciled.matched).toBe(false);
    expect(reconciled.source.id).not.toBe(lab1.id);
    expect(wb.snapshot().sources).toHaveLength(2);
  });
});
