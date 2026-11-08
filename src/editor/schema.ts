/**
 * ProseMirror schema for subject-page composition (ADR-0002, spec section 9).
 *
 * The schema is deliberately small for the M0 spike: `doc`, `paragraph`,
 * `text`, a handful of formatting marks, and — the point of the spike — a typed
 * `evidence` node whose attributes carry an `EvidenceInstance`'s provenance.
 *
 * The invariant being proven (spec section 20): evidence serialization is
 * INDEPENDENT of DOM coordinates. The evidence node stores the annotation id, a
 * quoted-text snapshot, the portable anchor and a live/copy flag — never pixel
 * or DOM offsets. The ProseMirror document JSON is the durable source of truth.
 */

import { Schema } from "prosemirror-model";
import type { NodeSpec, MarkSpec } from "prosemirror-model";
import type {
  AnnotationId,
  EvidenceInstanceId,
  SourceId,
  TextAnchor,
} from "../model";

/**
 * Provenance carried by an `evidence` node. Mirrors the model's
 * `EvidenceInstance` plus the portable anchor and a live/copy flag:
 *
 *  - `live`  : the evidence re-resolves against the live source/annotation.
 *  - `copy`  : the evidence is a frozen snapshot, decoupled from the source.
 *
 * NOTE: this is intentionally free of any DOM/pixel coordinates.
 */
export interface EvidenceAttrs {
  readonly evidenceId: EvidenceInstanceId;
  readonly sourceId: SourceId;
  readonly annotationId: AnnotationId;
  /** Visible quoted-text snapshot captured at insertion time. */
  readonly quotedText: string;
  /** Portable anchor (ADR-0003) — DOM-independent. */
  readonly anchor: TextAnchor;
  /** Whether this instance tracks the live source or is a frozen copy. */
  readonly mode: "live" | "copy";
}

const evidenceNode: NodeSpec = {
  group: "inline",
  inline: true,
  // Atom: the editor treats it as an opaque unit; its content is provenance,
  // not editable character data. This is what keeps the node's meaning in the
  // JSON attrs rather than in rendered text.
  atom: true,
  selectable: true,
  draggable: true,
  attrs: {
    evidenceId: {},
    sourceId: {},
    annotationId: {},
    quotedText: {},
    anchor: {},
    mode: { default: "live" },
  },
  toDOM(node) {
    const attrs = node.attrs as unknown as EvidenceAttrs;
    // The DOM rendering is a convenience view only; the data-* attributes are
    // NOT the source of truth (the doc JSON is). We serialize the full anchor
    // so that even a DOM-only consumer could re-hydrate, but the round-trip
    // test asserts fidelity from the JSON model alone.
    return [
      "span",
      {
        class: "evidence",
        "data-evidence-id": attrs.evidenceId,
        "data-source-id": attrs.sourceId,
        "data-annotation-id": attrs.annotationId,
        "data-mode": attrs.mode,
      },
      attrs.quotedText,
    ];
  },
  parseDOM: [
    {
      tag: "span.evidence",
      getAttrs(dom) {
        const el = dom as HTMLElement;
        return {
          evidenceId: el.getAttribute("data-evidence-id"),
          sourceId: el.getAttribute("data-source-id"),
          annotationId: el.getAttribute("data-annotation-id"),
          quotedText: el.textContent ?? "",
          mode: el.getAttribute("data-mode") ?? "live",
          anchor: null,
        };
      },
    },
  ],
};

const nodes: Record<string, NodeSpec> = {
  doc: { content: "block+" },
  paragraph: {
    group: "block",
    content: "inline*",
    // `copiedComment` marks a paragraph that was copied in from an annotation
    // comment at insertion time (spec section 4.3). It is CLEARLY distinguished
    // from ordinary page writing and never silently merged into it. The flag
    // lives in the JSON (source of truth), not only in the rendered DOM.
    attrs: { copiedComment: { default: false } },
    toDOM(node) {
      return node.attrs.copiedComment
        ? ["p", { class: "copied-comment", "data-copied-comment": "true" }, 0]
        : ["p", 0];
    },
    parseDOM: [
      {
        tag: "p",
        getAttrs(dom) {
          const el = dom as HTMLElement;
          return { copiedComment: el.getAttribute("data-copied-comment") === "true" };
        },
      },
    ],
  },
  heading: {
    group: "block",
    content: "inline*",
    attrs: { level: { default: 1 } },
    defining: true,
    toDOM(node) {
      return [`h${node.attrs.level as number}`, 0];
    },
    parseDOM: [1, 2, 3].map((level) => ({ tag: `h${level}`, attrs: { level } })),
  },
  text: { group: "inline" },
  evidence: evidenceNode,
};

const marks: Record<string, MarkSpec> = {
  strong: {
    toDOM() {
      return ["strong", 0];
    },
    parseDOM: [{ tag: "strong" }, { tag: "b" }],
  },
  em: {
    toDOM() {
      return ["em", 0];
    },
    parseDOM: [{ tag: "em" }, { tag: "i" }],
  },
};

/** The subject-page composition schema. */
export const subjectSchema = new Schema({ nodes, marks });
