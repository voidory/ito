/**
 * M0 RISK SPIKE — editor evidence serialization (FEAT-002, spec sections
 * 9/22/26; ADR-0002).
 *
 * This proves the spec invariant that evidence serialization is INDEPENDENT of
 * DOM coordinates: a composed document (writing interspersed with typed
 * evidence nodes) is serialized to the structured JSON model, the editor is
 * DISCARDED, and a fresh editor is re-hydrated from the JSON ALONE. The test
 * asserts composition order, quote identities, full provenance, and inline
 * formatting all survive EXACTLY — with no reliance on rendered HTML/DOM.
 */

import { describe, expect, it } from "vitest";
import { EditorState } from "prosemirror-state";
import { Node as PMNode } from "prosemirror-model";
import {
  collectEvidence,
  hydrateState,
  outline,
  serializeState,
  subjectSchema,
  type DocumentJson,
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
    pageIndex: 2,
    rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }],
    selectedText: text,
    prefix: "…before ",
    suffix: " after…",
  };
}

function evidenceNode(attrs: EvidenceAttrs): PMNode {
  return subjectSchema.nodes.evidence!.create(attrs);
}

/**
 * Build a composition: a heading, a paragraph mixing plain + bold + italic
 * text with an inline evidence node, and a second paragraph with another
 * evidence node. Writing and evidence interleave so order matters.
 */
function buildComposition(): { state: EditorState; evidence: EvidenceAttrs[] } {
  const { schema } = { schema: subjectSchema };
  const strong = schema.marks.strong!;
  const em = schema.marks.em!;

  const e1: EvidenceAttrs = {
    evidenceId: "evi_one" as EvidenceInstanceId,
    sourceId: "src_alpha" as SourceId,
    annotationId: "ann_alpha" as AnnotationId,
    quotedText: "the quick brown fox",
    anchor: anchor("src_alpha", "the quick brown fox"),
    mode: "live",
  };
  const e2: EvidenceAttrs = {
    evidenceId: "evi_two" as EvidenceInstanceId,
    sourceId: "src_beta" as SourceId,
    annotationId: "ann_beta" as AnnotationId,
    quotedText: "jumps over the lazy dog",
    anchor: anchor("src_beta", "jumps over the lazy dog"),
    mode: "copy",
  };

  const heading = schema.nodes.heading!.create({ level: 2 }, [
    schema.text("On foxes and dogs"),
  ]);

  const para1 = schema.nodes.paragraph!.create(null, [
    schema.text("As noted, "),
    schema.text("the author", [strong.create()]),
    schema.text(" argues "),
    evidenceNode(e1),
    schema.text(" and later "),
    schema.text("qualifies it", [em.create()]),
    schema.text("."),
  ]);

  const para2 = schema.nodes.paragraph!.create(null, [
    schema.text("Then the subject "),
    evidenceNode(e2),
    schema.text(" to close."),
  ]);

  const doc = schema.nodes.doc!.create(null, [heading, para1, para2]);
  const state = EditorState.create({ schema, doc });
  return { state, evidence: [e1, e2] };
}

describe("editor evidence serialization round-trip (JSON is source of truth)", () => {
  it("round-trips order, quotes, provenance and formatting from JSON alone", () => {
    const { state, evidence } = buildComposition();

    // Snapshot the composed document BEFORE serialization.
    const beforeOutline = outline(state.doc);
    const beforeEvidence = collectEvidence(state.doc);

    // Serialize to the structured JSON model (what Page.documentJson stores).
    const json: DocumentJson = serializeState(state);

    // Prove the JSON really is plain data (round-trips through a string) and
    // carries no DOM/pixel coordinates — only logical provenance + anchor.
    const roundTrippedJson = JSON.parse(JSON.stringify(json)) as DocumentJson;
    const jsonText = JSON.stringify(roundTrippedJson);
    expect(jsonText).not.toMatch(/clientX|clientY|offsetTop|offsetLeft|getBoundingClientRect|px"/);

    // DISCARD the editor entirely: nothing from the old EditorState is used
    // past this point except the serialized JSON.
    // (Simulated by only passing `roundTrippedJson` into a fresh editor.)
    const rehydrated = hydrateState(roundTrippedJson);

    // 1) Composition ORDER survives exactly (writing interleaved with evidence).
    const afterOutline = outline(rehydrated.doc);
    expect(afterOutline).toEqual(beforeOutline);
    expect(afterOutline).toEqual([
      "h2: On foxes and dogs",
      "As noted, strong(the author) argues ⟦evidence:evi_one⟧ and later em(qualifies it).",
      "Then the subject ⟦evidence:evi_two⟧ to close.",
    ]);

    // 2) Evidence identities + full provenance survive exactly.
    const afterEvidence = collectEvidence(rehydrated.doc);
    expect(afterEvidence).toHaveLength(2);
    expect(afterEvidence).toEqual(beforeEvidence);

    // Spell out each provenance field so a regression is obvious.
    expect(afterEvidence.map((e) => e.evidenceId)).toEqual(["evi_one", "evi_two"]);
    expect(afterEvidence.map((e) => e.annotationId)).toEqual(["ann_alpha", "ann_beta"]);
    expect(afterEvidence.map((e) => e.sourceId)).toEqual(["src_alpha", "src_beta"]);
    expect(afterEvidence.map((e) => e.mode)).toEqual(["live", "copy"]);
    expect(afterEvidence.map((e) => e.quotedText)).toEqual([
      "the quick brown fox",
      "jumps over the lazy dog",
    ]);

    // 3) The portable anchor survives intact and is DOM-independent.
    for (let i = 0; i < evidence.length; i++) {
      expect(afterEvidence[i]!.anchor).toEqual(evidence[i]!.anchor);
      // Normalized rects only (0..1), never pixel coordinates.
      for (const r of afterEvidence[i]!.anchor.rects) {
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.x).toBeLessThanOrEqual(1);
        expect(r.width).toBeLessThanOrEqual(1);
      }
    }

    // 4) Inline FORMATTING survives: marks re-hydrate on the same text runs.
    const marks = new Set<string>();
    rehydrated.doc.descendants((node) => {
      for (const m of node.marks) marks.add(m.type.name);
      return true;
    });
    expect(marks).toEqual(new Set(["strong", "em"]));
  });

  it("re-serializing the re-hydrated doc yields byte-identical JSON (stable)", () => {
    const { state } = buildComposition();
    const json1 = JSON.stringify(serializeState(state));
    const rehydrated = hydrateState(JSON.parse(json1) as DocumentJson);
    const json2 = JSON.stringify(serializeState(rehydrated));
    expect(json2).toBe(json1);
  });

  it("evidence node is an atom carrying data, not editable child text", () => {
    // Guards the invariant that the node's meaning lives in attrs (JSON), not
    // in editable character content that the DOM could diverge from.
    expect(subjectSchema.nodes.evidence!.spec.atom).toBe(true);
    expect(subjectSchema.nodes.evidence!.isInline).toBe(true);
  });
});
