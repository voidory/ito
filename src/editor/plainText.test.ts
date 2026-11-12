/**
 * Unit coverage for the `plainText` body-text extractor (FEAT-005). It powers
 * the Workbench search index: it must flatten a doc's prose AND each evidence
 * node's captured quote into plain text in document order, with NO structural
 * markers (unlike `outline`) and NO mark wrappers — so search matches raw words.
 */

import { describe, expect, it } from "vitest";
import { plainText, subjectSchema, outline } from ".";
import type { EvidenceAttrs } from ".";
import type {
  AnnotationId,
  EvidenceInstanceId,
  SourceId,
  TextAnchor,
} from "../model";

function anchor(text: string): TextAnchor {
  return {
    docId: "src" as SourceId,
    sourceVersionHash: "v1",
    pageIndex: 0,
    rects: [],
    selectedText: text,
    prefix: "",
    suffix: "",
  };
}

describe("plainText — flatten doc body text for search", () => {
  it("returns prose across blocks joined by spaces, with no markers", () => {
    const schema = subjectSchema;
    const heading = schema.nodes.heading!.create({ level: 2 }, [
      schema.text("Title Here"),
    ]);
    const para = schema.nodes.paragraph!.create(null, [
      schema.text("Some "),
      schema.text("bold", [schema.marks.strong!.create()]),
      schema.text(" words."),
    ]);
    const doc = schema.nodes.doc!.create(null, [heading, para]);

    const text = plainText(doc);
    expect(text).toBe("Title Here Some bold words.");
    // No heading prefix / mark wrappers that `outline` emits.
    expect(text).not.toContain("h2:");
    expect(text).not.toContain("strong(");
    // `outline` by contrast DOES carry the structural markers.
    expect(outline(doc).join(" ")).toContain("h2:");
  });

  it("includes an evidence node's captured quotedText (not a marker token)", () => {
    const schema = subjectSchema;
    const ev: EvidenceAttrs = {
      evidenceId: "e1" as EvidenceInstanceId,
      sourceId: "src" as SourceId,
      annotationId: "a1" as AnnotationId,
      quotedText: "natural selection",
      anchor: anchor("natural selection"),
      mode: "live",
    };
    const para = schema.nodes.paragraph!.create(null, [
      schema.text("He cites "),
      schema.nodes.evidence!.create(ev),
      schema.text(" directly."),
    ]);
    const doc = schema.nodes.doc!.create(null, [para]);

    const text = plainText(doc);
    expect(text).toContain("natural selection");
    expect(text).not.toContain("⟦evidence");
    expect(text).toBe("He cites natural selection directly.");
  });

  it("returns an empty string for an empty document", () => {
    const schema = subjectSchema;
    const doc = schema.nodes.doc!.create(null, [schema.nodes.paragraph!.create()]);
    expect(plainText(doc)).toBe("");
  });
});
