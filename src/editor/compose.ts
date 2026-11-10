/**
 * Composition helpers for the continuous subject editor (FEAT-004, spec
 * sections 4.2, 9, 10). These are deliberately DOM-free and operate on the
 * structured ProseMirror model (EditorState / Node / Transaction) so the same
 * transitions are exercised by Vitest and by the live editor in the browser.
 *
 * The invariant that governs this file (spec section 20): the ProseMirror
 * document JSON is the durable SOURCE OF TRUTH. Inserting a quote means adding a
 * typed `evidence` node at an explicit cursor position; reordering means moving
 * whole blocks; neither relies on rendered HTML/DOM coordinates. The provenance
 * (annotation id, source id, portable anchor, live/copy mode) travels in the
 * node's attrs so it survives a full discard + re-hydrate.
 */

import { EditorState, TextSelection } from "prosemirror-state";
import { Node as PMNode, Fragment } from "prosemirror-model";
import { subjectSchema, type EvidenceAttrs } from "./schema";
import { serializeState, hydrateState, type DocumentJson } from "./serialize";

/**
 * How an inserted quote renders alongside writing (spec section 4.3). A quote
 * node is always visually distinguishable from writing; the optional annotation
 * comment, when carried in, is CLEARLY MARKED as copied and is never allowed to
 * overwrite the surrounding page writing.
 */
export interface InsertEvidenceOptions {
  /** The evidence provenance to embed in the typed node. */
  readonly attrs: EvidenceAttrs;
  /**
   * Optional copied annotation comment. When present it is inserted as its own
   * trailing paragraph, marked as copied — never merged into existing writing.
   */
  readonly copiedComment?: string | null;
}

/**
 * Insert a typed `evidence` node at the given document position within an
 * EditorState, returning the next EditorState. The evidence lands at exactly
 * the requested position (the explicit cursor), proving there is no mandatory
 * evidence/commentary section or template: a quote can be placed before,
 * between, or after any writing.
 *
 * When `copiedComment` is supplied a dedicated paragraph is appended after the
 * quote's block, tagged so the UI can render it as "copied from annotation".
 */
export function insertEvidenceAt(
  state: EditorState,
  pos: number,
  options: InsertEvidenceOptions,
): EditorState {
  const node = subjectSchema.nodes.evidence!.create(options.attrs);
  let tr = state.tr.insert(pos, node);

  const comment = options.copiedComment?.trim();
  if (comment) {
    // Append the copied comment as its own paragraph AFTER the block that now
    // contains the quote, so it never overwrites existing page writing. When
    // the insertion landed at the very end (outside any block), append the
    // comment paragraph at the end of the document instead.
    const mapped = Math.min(tr.mapping.map(pos), tr.doc.content.size);
    const $pos = tr.doc.resolve(mapped);
    const insertAt = $pos.depth > 0 ? $pos.after($pos.depth) : tr.doc.content.size;
    const para = subjectSchema.nodes.paragraph!.create(
      { copiedComment: true },
      subjectSchema.text(comment),
    );
    tr = tr.insert(insertAt, para);
  }

  return state.apply(tr);
}

/**
 * M14–M16 (FEAT-001/003) insert an informal BRIDGING-NOTE commentary paragraph
 * at the given document position (typically between two cited evidence quote
 * atoms). The paragraph carries `bridgingNote: true` so it renders as a
 * distinguishable commentary block and survives a full round-trip. `text` may
 * be empty (an empty bridge the user then types into) or seeded with a prompt.
 * Returns the next EditorState. DOM-free + deterministic.
 */
export function insertBridgingNoteAt(
  state: EditorState,
  pos: number,
  text = "",
): EditorState {
  const trimmed = text.trim();
  const para =
    trimmed.length > 0
      ? subjectSchema.nodes.paragraph!.create(
          { bridgingNote: true },
          subjectSchema.text(trimmed),
        )
      : subjectSchema.nodes.paragraph!.create({ bridgingNote: true });
  const clamped = Math.max(0, Math.min(pos, state.doc.content.size));
  // Insert at the nearest block boundary at/after the requested position so the
  // bridging note lands as its own block (never inside an inline run).
  const $pos = state.doc.resolve(clamped);
  const insertAt = $pos.depth > 0 ? $pos.after($pos.depth) : clamped;
  const tr = state.tr.insert(Math.min(insertAt, state.doc.content.size), para);
  return state.apply(tr);
}

/**
 * M17 (§3.2) insert a live LaTeX EQUATION block (`paragraph` carrying
 * `latexFormula`) at the given document position. The paragraph holds the raw
 * LaTeX in its attr (the durable source of truth); the SubjectEditor renders a
 * formatted preview + a "Copy for Word (MathML)" affordance from it. Returns
 * the next EditorState. DOM-free + deterministic.
 */
export function insertLatexBlockAt(
  state: EditorState,
  pos: number,
  latex: string,
): EditorState {
  const para = subjectSchema.nodes.paragraph!.create({ latexFormula: latex });
  const clamped = Math.max(0, Math.min(pos, state.doc.content.size));
  const $pos = state.doc.resolve(clamped);
  const insertAt = $pos.depth > 0 ? $pos.after($pos.depth) : clamped;
  const tr = state.tr.insert(Math.min(insertAt, state.doc.content.size), para);
  return state.apply(tr);
}

/**
 * M17 (§3.2) insert a live CHEM-MECHANISM block (`paragraph` carrying
 * `chemMechanismJson`, a JSON-serialized `ChemicalMechanismSpec`) at the given
 * position. The SubjectEditor renders the interactive curly-arrow vector `<svg>`
 * + a "Copy SVG for Word" affordance from it. `spec` is any JSON-serializable
 * object (the model's `ChemicalMechanismSpec`). Returns the next EditorState.
 */
export function insertChemMechanismBlockAt(
  state: EditorState,
  pos: number,
  spec: unknown,
): EditorState {
  const json = JSON.stringify(spec);
  const para = subjectSchema.nodes.paragraph!.create({ chemMechanismJson: json });
  const clamped = Math.max(0, Math.min(pos, state.doc.content.size));
  const $pos = state.doc.resolve(clamped);
  const insertAt = $pos.depth > 0 ? $pos.after($pos.depth) : clamped;
  const tr = state.tr.insert(Math.min(insertAt, state.doc.content.size), para);
  return state.apply(tr);
}

/** Insert evidence at the END of the document (used when no cursor is given). */
export function appendEvidence(
  state: EditorState,
  options: InsertEvidenceOptions,
): EditorState {
  return insertEvidenceAt(state, state.doc.content.size, options);
}

/**
 * Move a top-level block from index `from` to index `to`, preserving every
 * other block's content, formatting, and the identities of any evidence nodes
 * inside them (spec section 9, A04). Returns a new EditorState.
 */
export function moveBlock(state: EditorState, from: number, to: number): EditorState {
  const blocks: PMNode[] = [];
  state.doc.forEach((block) => blocks.push(block));
  if (from < 0 || from >= blocks.length || to < 0 || to >= blocks.length) {
    return state;
  }
  const next = blocks.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  const doc = subjectSchema.nodes.doc!.create(null, Fragment.fromArray(next));
  return EditorState.create({ schema: subjectSchema, doc });
}

/**
 * Remove every `evidence` node whose `evidenceId` matches, anywhere in the
 * document. Writing around it is preserved. Returns a new EditorState. This is
 * the composition-side half of removing a quote; the model-side EvidenceInstance
 * deletion is the workbench's job, and status is re-derived from the live set.
 */
export function removeEvidenceNode(state: EditorState, evidenceId: string): EditorState {
  let tr = state.tr;
  const positions: { from: number; to: number }[] = [];
  state.doc.descendants((node, pos) => {
    if (
      node.type.name === "evidence" &&
      (node.attrs as unknown as EvidenceAttrs).evidenceId === evidenceId
    ) {
      positions.push({ from: pos, to: pos + node.nodeSize });
    }
    return true;
  });
  // Delete from the end backwards so earlier positions stay valid.
  for (const { from, to } of positions.reverse()) {
    tr = tr.delete(from, to);
  }
  return state.apply(tr);
}

/**
 * Find the document position of the first `evidence` node with the given id, or
 * null. Used by source-return so following a quote can scroll the editor to it
 * and so tests can assert placement without touching the DOM.
 */
export function findEvidencePos(doc: PMNode, evidenceId: string): number | null {
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (
      found === null &&
      node.type.name === "evidence" &&
      (node.attrs as unknown as EvidenceAttrs).evidenceId === evidenceId
    ) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

/**
 * Collect every evidence node's attrs in document order, paired with the index
 * of the block it sits in. Lets tests assert the EXACT interleaving of writing
 * and quotes (A04) directly from the structured model.
 */
export function evidenceInOrder(doc: PMNode): { attrs: EvidenceAttrs; blockIndex: number }[] {
  const out: { attrs: EvidenceAttrs; blockIndex: number }[] = [];
  let blockIndex = 0;
  doc.forEach((block) => {
    block.descendants((node) => {
      if (node.type.name === "evidence") {
        out.push({ attrs: node.attrs as unknown as EvidenceAttrs, blockIndex });
      }
      return true;
    });
    blockIndex += 1;
  });
  return out;
}

/** A single quote's identity + text, for the structural-details panel. */
export interface QuoteSummary {
  readonly evidenceId: string;
  readonly sourceId: string;
  readonly annotationId: string;
  readonly quotedText: string;
  readonly mode: "live" | "copy";
}

/**
 * Structural details for a composition (spec section 9) — counts + the distinct
 * source documents referenced. These live behind an OPTIONAL control in the UI;
 * computing them never changes the document, so hiding them cannot break source
 * attribution (A07).
 */
export interface CompositionStats {
  readonly blockCount: number;
  readonly paragraphCount: number;
  readonly headingCount: number;
  readonly quoteCount: number;
  readonly sourceCount: number;
  readonly quotes: readonly QuoteSummary[];
}

export function compositionStats(doc: PMNode): CompositionStats {
  let blockCount = 0;
  let paragraphCount = 0;
  let headingCount = 0;
  const quotes: QuoteSummary[] = [];
  const sources = new Set<string>();
  doc.forEach((block) => {
    blockCount += 1;
    if (block.type.name === "paragraph") paragraphCount += 1;
    if (block.type.name === "heading") headingCount += 1;
    block.descendants((node) => {
      if (node.type.name === "evidence") {
        const a = node.attrs as unknown as EvidenceAttrs;
        quotes.push({
          evidenceId: a.evidenceId,
          sourceId: a.sourceId,
          annotationId: a.annotationId,
          quotedText: a.quotedText,
          mode: a.mode,
        });
        sources.add(a.sourceId);
      }
      return true;
    });
  });
  return {
    blockCount,
    paragraphCount,
    headingCount,
    quoteCount: quotes.length,
    sourceCount: sources.size,
    quotes,
  };
}

/** Compute stats directly from stored document JSON (convenience for the UI). */
export function compositionStatsFromJson(json: DocumentJson): CompositionStats {
  return compositionStats(hydrateState(json).doc);
}

/** Round-trip a document JSON through a full discard + re-hydrate (durability). */
export function roundTripJson(json: DocumentJson): DocumentJson {
  return serializeState(hydrateState(json));
}

/** Place the selection cursor at a document position (helper for the editor). */
export function withCursorAt(state: EditorState, pos: number): EditorState {
  const clamped = Math.max(0, Math.min(pos, state.doc.content.size));
  const tr = state.tr.setSelection(TextSelection.create(state.doc, clamped));
  return state.apply(tr);
}
