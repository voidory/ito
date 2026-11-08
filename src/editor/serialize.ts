/**
 * Serialize / re-hydrate a subject-page ProseMirror document to and from the
 * structured JSON data model (spec section 9, 20; ADR-0002).
 *
 * `serializeDoc` turns an EditorState's doc into plain JSON suitable for
 * `Page.documentJson`. `hydrateDoc` rebuilds a ProseMirror doc from that JSON
 * using the schema. The JSON — not the editor's HTML/DOM — is the source of
 * truth; the editor-serialization spike proves a composition survives a full
 * discard + re-hydrate with order, quotes, provenance and formatting intact.
 */

import { EditorState } from "prosemirror-state";
import { Node as PMNode } from "prosemirror-model";
import { subjectSchema } from "./schema";
import type { EvidenceAttrs } from "./schema";

/** Opaque JSON shape of a serialized document (ProseMirror's node JSON). */
export type DocumentJson = Record<string, unknown>;

/** Serialize an editor's current document to plain JSON. */
export function serializeState(state: EditorState): DocumentJson {
  return state.doc.toJSON() as DocumentJson;
}

/** Serialize a bare doc node to plain JSON. */
export function serializeDoc(doc: PMNode): DocumentJson {
  return doc.toJSON() as DocumentJson;
}

/** Re-hydrate a ProseMirror doc node from JSON using the subject schema. */
export function hydrateDoc(json: DocumentJson): PMNode {
  return PMNode.fromJSON(subjectSchema, json);
}

/**
 * Re-hydrate a full EditorState from JSON. Discarding the previous editor and
 * calling this models closing and re-opening a subject page from storage.
 */
export function hydrateState(json: DocumentJson): EditorState {
  return EditorState.create({ schema: subjectSchema, doc: hydrateDoc(json) });
}

/**
 * Walk a doc and extract every evidence node's provenance in document order.
 * Used to assert composition order + provenance identity across a round-trip.
 */
export function collectEvidence(doc: PMNode): EvidenceAttrs[] {
  const out: EvidenceAttrs[] = [];
  doc.descendants((node) => {
    if (node.type.name === "evidence") {
      out.push(node.attrs as unknown as EvidenceAttrs);
    }
    return true;
  });
  return out;
}

/**
 * Produce a linear, human-readable outline of a doc's block + inline content in
 * document order. Evidence nodes render as `⟦evidence:<id>⟧` so the test can
 * assert that writing and evidence interleave in the EXACT composed order
 * without depending on any DOM coordinates.
 */
export function outline(doc: PMNode): string[] {
  const lines: string[] = [];
  doc.forEach((block) => {
    const parts: string[] = [];
    block.forEach((inline) => {
      if (inline.type.name === "evidence") {
        const a = inline.attrs as unknown as EvidenceAttrs;
        parts.push(`⟦evidence:${a.evidenceId}⟧`);
      } else if (inline.isText) {
        const markNames = inline.marks.map((m) => m.type.name).sort();
        const wrapped = markNames.length
          ? `${markNames.join("+")}(${inline.text ?? ""})`
          : (inline.text ?? "");
        parts.push(wrapped);
      }
    });
    const prefix =
      block.type.name === "heading"
        ? `h${block.attrs.level as number}: `
        : "";
    lines.push(prefix + parts.join(""));
  });
  return lines;
}
