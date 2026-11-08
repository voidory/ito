/**
 * Unit tests for the continuous-editor composition helpers (FEAT-004, spec
 * sections 4.2, 9, 10). These exercise the structured model directly (no DOM):
 * insert-at-cursor with no mandatory template, reorder preserving identities,
 * remove one of several quotes, copied-comment marking, structural stats, and a
 * full JSON round-trip. The ProseMirror JSON is the durable source of truth.
 */

import { describe, expect, it } from "vitest";
import { EditorState } from "prosemirror-state";
import {
  appendEvidence,
  compositionStats,
  evidenceInOrder,
  findEvidencePos,
  insertEvidenceAt,
  moveBlock,
  outline,
  removeEvidenceNode,
  roundTripJson,
  serializeState,
  subjectSchema,
  type EvidenceAttrs,
} from ".";
import type {
  AnnotationId,
  EvidenceInstanceId,
  SourceId,
  TextAnchor,
} from "../model";

function anchor(docId: string, text: string): TextAnchor {
  return {
    docId: docId as SourceId,
    sourceVersionHash: `hash_${docId}`,
    pageIndex: 0,
    rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }],
    selectedText: text,
    prefix: "before ",
    suffix: " after",
  };
}

function attrs(id: string, text: string): EvidenceAttrs {
  return {
    evidenceId: id as EvidenceInstanceId,
    sourceId: `src_${id}` as SourceId,
    annotationId: `ann_${id}` as AnnotationId,
    quotedText: text,
    anchor: anchor(`src_${id}`, text),
    mode: "live",
  };
}

/** A fresh state with a single paragraph of plain writing. */
function writingState(text: string): EditorState {
  const doc = subjectSchema.nodes.doc!.create(null, [
    subjectSchema.nodes.paragraph!.create(null, subjectSchema.text(text)),
  ]);
  return EditorState.create({ schema: subjectSchema, doc });
}

describe("compose — insert-at-cursor (no mandatory template)", () => {
  it("places evidence at the explicit cursor position inside writing", () => {
    const state = writingState("The author argues  convincingly.");
    // Insert between "argues " and " convincingly" — an explicit mid-paragraph
    // position, proving there is no required evidence section.
    const pos = "The author argues ".length + 1; // +1 for the paragraph open token
    const next = insertEvidenceAt(state, pos, { attrs: attrs("e1", "a bold claim") });
    const lines = outline(next.doc);
    expect(lines[0]).toContain("The author argues ⟦evidence:e1⟧");
    expect(lines[0]).toContain("convincingly.");
    expect(evidenceInOrder(next.doc)).toHaveLength(1);
  });

  it("appends evidence at the end when no cursor is given", () => {
    const state = writingState("Intro.");
    const next = appendEvidence(state, { attrs: attrs("e9", "closing quote") });
    const ev = evidenceInOrder(next.doc);
    expect(ev.map((e) => e.attrs.evidenceId)).toEqual(["e9"]);
  });

  it("copies the annotation comment into its own marked paragraph, never merging writing", () => {
    const state = writingState("My own sentence.");
    const next = insertEvidenceAt(state, 1, {
      attrs: attrs("e2", "quoted bit"),
      copiedComment: "the reader's note",
    });
    // The user's writing paragraph is untouched; a NEW paragraph carries the
    // copied comment, flagged copiedComment=true.
    const copied: boolean[] = [];
    next.doc.forEach((block) => {
      copied.push(Boolean(block.attrs.copiedComment));
    });
    expect(copied).toContain(true);
    const commentBlock = (() => {
      let found = "";
      next.doc.forEach((b) => {
        if (b.attrs.copiedComment) found = b.textContent;
      });
      return found;
    })();
    expect(commentBlock).toBe("the reader's note");
    // The original writing survived verbatim.
    expect(next.doc.child(0).textContent).toContain("My own sentence.");
  });
});

describe("compose — reorder preserves structure + identities (A04)", () => {
  it("moves a block without changing quote identities or formatting", () => {
    const schema = subjectSchema;
    const p1 = schema.nodes.paragraph!.create(null, schema.text("Paragraph one."));
    const p2 = schema.nodes.paragraph!.create(null, [
      schema.text("A quote: "),
      schema.nodes.evidence!.create(attrs("qA", "quote A")),
    ]);
    const p3 = schema.nodes.paragraph!.create(null, [
      schema.text("Interpretation and "),
      schema.text("emphasis", [schema.marks.em!.create()]),
    ]);
    const p4 = schema.nodes.paragraph!.create(null, [
      schema.nodes.evidence!.create(attrs("qB", "quote B")),
      schema.text(" — a question?"),
    ]);
    const doc = schema.nodes.doc!.create(null, [p1, p2, p3, p4]);
    const state = EditorState.create({ schema, doc });

    const before = outline(state.doc);
    expect(before).toEqual([
      "Paragraph one.",
      "A quote: ⟦evidence:qA⟧",
      "Interpretation and em(emphasis)",
      "⟦evidence:qB⟧ — a question?",
    ]);

    // Move the last block (quote B) up to index 1.
    const moved = moveBlock(state, 3, 1);
    const after = outline(moved.doc);
    expect(after).toEqual([
      "Paragraph one.",
      "⟦evidence:qB⟧ — a question?",
      "A quote: ⟦evidence:qA⟧",
      "Interpretation and em(emphasis)",
    ]);
    // Identities preserved, just reordered.
    expect(evidenceInOrder(moved.doc).map((e) => e.attrs.evidenceId)).toEqual([
      "qB",
      "qA",
    ]);

    // Round-trip the reordered doc: order + identities survive the JSON gate.
    const json = roundTripJson(serializeState(moved));
    const rehydrated = subjectSchema.nodeFromJSON(json);
    expect(outline(rehydrated)).toEqual(after);
  });
});

describe("compose — remove one of several quotes", () => {
  it("removing one evidence node leaves the other intact", () => {
    let state = writingState("Start.");
    state = appendEvidence(state, { attrs: attrs("k1", "first") });
    state = appendEvidence(state, { attrs: attrs("k2", "second") });
    expect(evidenceInOrder(state.doc).map((e) => e.attrs.evidenceId)).toEqual([
      "k1",
      "k2",
    ]);
    const next = removeEvidenceNode(state, "k1");
    expect(evidenceInOrder(next.doc).map((e) => e.attrs.evidenceId)).toEqual(["k2"]);
  });
});

describe("compose — structural details + locate", () => {
  it("computes counts and finds an evidence position", () => {
    const schema = subjectSchema;
    const h = schema.nodes.heading!.create({ level: 2 }, schema.text("Title"));
    const p = schema.nodes.paragraph!.create(null, [
      schema.text("x "),
      schema.nodes.evidence!.create(attrs("z1", "q")),
    ]);
    const doc = schema.nodes.doc!.create(null, [h, p]);
    const state = EditorState.create({ schema, doc });
    const stats = compositionStats(state.doc);
    expect(stats.headingCount).toBe(1);
    expect(stats.paragraphCount).toBe(1);
    expect(stats.quoteCount).toBe(1);
    expect(stats.sourceCount).toBe(1);
    expect(findEvidencePos(state.doc, "z1")).not.toBeNull();
    expect(findEvidencePos(state.doc, "nope")).toBeNull();
  });
});
