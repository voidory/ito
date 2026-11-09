/**
 * Zotero bundle parser (M6, A24, D10). PURE, in-memory, DOM-free: it turns a
 * raw Zotero export string into a normalized, storage-agnostic shape the
 * Workbench maps onto Sources + source-local Annotations.
 *
 * Three input dialects are accepted, auto-detected from the payload:
 *
 *  - Zotero JSON: the native `zotero export -> JSON` array of items, where a
 *    parent item (an attachment/regular item) carries `key`, `title`, `url`,
 *    and child `annotations` with `annotationText`/`annotationComment`,
 *    `annotationPageLabel`, and an `annotationPosition` (rects on a page).
 *  - BetterBibTeX JSON: the `{ "items": [...] }` wrapper BetterBibTeX emits;
 *    items use `citationKey`/`itemID` as the stable id and the same annotation
 *    child shape.
 *  - RDF annotation bundle: a lightweight `{ "@graph": [...] }` JSON
 *    representation of a Zotero RDF export where annotation nodes reference
 *    their parent item by id. (We parse the JSON-ified RDF rather than raw XML
 *    so the parser stays dependency-free and deterministic.)
 *
 * Every mapped Source carries a stable `externalId` (the Zotero item key) and
 * every mapped Annotation carries its own `externalId` (the Zotero annotation
 * key) PLUS the parent item's `externalId`, so the Workbench can re-import
 * idempotently: matching on `externalId` updates in place with zero duplicates.
 *
 * This module imports ONLY from src/model (allowed); it never touches the app
 * or storage-adapter layer, so it is unit-testable in isolation.
 */

import type { NormalizedRect } from "../model";

/** A parsed Source stub (pre-record): the external id + descriptive fields. */
export interface ParsedZoteroSource {
  /** Stable Zotero item key; the Source.externalId. */
  readonly externalId: string;
  readonly title: string;
  readonly url?: string;
  /** Optional library collection name used as the Source category. */
  readonly category?: string;
}

/** A parsed Annotation stub (pre-record): external ids + anchor + comment. */
export interface ParsedZoteroAnnotation {
  /** Stable Zotero annotation key; the Annotation.externalId. */
  readonly externalId: string;
  /** The parent item's external id (links the annotation to its Source). */
  readonly sourceExternalId: string;
  /** 0-based page index derived from the Zotero page label/index. */
  readonly pageIndex: number;
  /** Normalized rect (0..1) of the highlight/area. */
  readonly rect: NormalizedRect;
  /** Highlight text + note folded into one comment (empty string allowed). */
  readonly comment: string;
}

/** The normalized result of parsing a Zotero bundle. */
export interface ParsedZoteroBundle {
  readonly sources: readonly ParsedZoteroSource[];
  readonly annotations: readonly ParsedZoteroAnnotation[];
}

/** Thrown when a Zotero payload cannot be parsed at all. */
export class ZoteroParseError extends Error {
  constructor(detail: string) {
    super(`Cannot parse Zotero bundle: ${detail}`);
    this.name = "ZoteroParseError";
  }
}

const UNIT = { x: 0, y: 0, width: 1, height: 1 } as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Derive a 0-based page index from a Zotero page label/index. Zotero stores a
 * `pageLabel` (often "1"-based) or a position with a 0-based `pageIndex`.
 */
function pageIndexFrom(annotation: Record<string, unknown>): number {
  const position = annotation["annotationPosition"] ?? annotation["position"];
  if (isObject(position) && typeof position["pageIndex"] === "number") {
    return Math.max(0, Math.floor(position["pageIndex"]));
  }
  const label = annotation["annotationPageLabel"] ?? annotation["pageLabel"];
  if (typeof label === "string") {
    const n = Number.parseInt(label, 10);
    if (Number.isFinite(n) && n > 0) return n - 1;
  }
  if (typeof annotation["pageIndex"] === "number") {
    return Math.max(0, Math.floor(annotation["pageIndex"] as number));
  }
  return 0;
}

/**
 * Derive a normalized rect from a Zotero annotation position. Zotero's
 * `rects` are `[x1, y1, x2, y2]` quads in PDF user space; without the page
 * dimensions we cannot perfectly normalize, so we clamp any already-normalized
 * values and otherwise fall back to the full-page unit rect (the annotation
 * still carries its page + comment, which is what citations rely on).
 */
function rectFrom(annotation: Record<string, unknown>): NormalizedRect {
  const position = annotation["annotationPosition"] ?? annotation["position"];
  if (isObject(position)) {
    const rects = position["rects"];
    if (Array.isArray(rects) && rects.length > 0 && Array.isArray(rects[0])) {
      const quad = rects[0] as unknown[];
      const [x1, y1, x2, y2] = quad.map((n) => (typeof n === "number" ? n : 0));
      // Only treat as normalized when every value is already within [0, 1].
      if ([x1, y1, x2, y2].every((n) => n! >= 0 && n! <= 1)) {
        const x = Math.min(x1!, x2!);
        const y = Math.min(y1!, y2!);
        return {
          x,
          y,
          width: Math.max(0, Math.abs(x2! - x1!)),
          height: Math.max(0, Math.abs(y2! - y1!)),
        };
      }
    }
    // A direct normalized rect form: { x, y, width, height } in [0,1].
    const nr = position["rect"];
    if (isObject(nr) && typeof nr["x"] === "number") {
      return {
        x: nr["x"] as number,
        y: (nr["y"] as number) ?? 0,
        width: (nr["width"] as number) ?? 0,
        height: (nr["height"] as number) ?? 0,
      };
    }
  }
  return { ...UNIT };
}

function commentFrom(annotation: Record<string, unknown>): string {
  const text =
    asString(annotation["annotationText"]) ?? asString(annotation["text"]) ?? "";
  const note =
    asString(annotation["annotationComment"]) ?? asString(annotation["comment"]) ?? "";
  if (text && note) return `${text} — ${note}`;
  return text || note;
}

/** Stable external id for an annotation node (key / id / synthesized). */
function annotationExternalId(
  annotation: Record<string, unknown>,
  parentExternalId: string,
  ordinal: number,
): string {
  return (
    asString(annotation["key"]) ??
    asString(annotation["id"]) ??
    asString(annotation["@id"]) ??
    `${parentExternalId}#ann-${ordinal}`
  );
}

/** Parse one item + its child annotations from the native/BBT item shape. */
function parseItem(
  item: Record<string, unknown>,
  sources: ParsedZoteroSource[],
  annotations: ParsedZoteroAnnotation[],
): void {
  const externalId =
    asString(item["key"]) ??
    asString(item["citationKey"]) ??
    asString(item["itemID"]) ??
    asString(item["id"]);
  if (externalId == null) return; // not an addressable parent item

  const source: ParsedZoteroSource = {
    externalId,
    title: asString(item["title"]) ?? externalId,
    ...(asString(item["url"]) != null ? { url: asString(item["url"])! } : {}),
    ...(asString(item["collection"]) != null
      ? { category: asString(item["collection"])! }
      : {}),
  };
  sources.push(source);

  const children = item["annotations"];
  if (Array.isArray(children)) {
    children.forEach((child, i) => {
      if (!isObject(child)) return;
      annotations.push({
        externalId: annotationExternalId(child, externalId, i),
        sourceExternalId: externalId,
        pageIndex: pageIndexFrom(child),
        rect: rectFrom(child),
        comment: commentFrom(child),
      });
    });
  }
}

/**
 * Parse an RDF-as-JSON graph. Nodes with a `type` of "item"/"attachment" (or
 * carrying a `title`) become sources; nodes of type "annotation" reference
 * their parent item via `parentItem`/`isAnnotationOf`.
 */
function parseRdfGraph(
  graph: unknown[],
  sources: ParsedZoteroSource[],
  annotations: ParsedZoteroAnnotation[],
): void {
  const counters = new Map<string, number>();
  for (const node of graph) {
    if (!isObject(node)) continue;
    const type = (asString(node["type"]) ?? asString(node["@type"]) ?? "").toLowerCase();
    const id = asString(node["id"]) ?? asString(node["@id"]) ?? asString(node["key"]);
    if (id == null) continue;
    if (type === "annotation") {
      const parent =
        asString(node["parentItem"]) ??
        asString(node["isAnnotationOf"]) ??
        asString(node["parent"]);
      if (parent == null) continue;
      const ordinal = counters.get(parent) ?? 0;
      counters.set(parent, ordinal + 1);
      annotations.push({
        externalId: id,
        sourceExternalId: parent,
        pageIndex: pageIndexFrom(node),
        rect: rectFrom(node),
        comment: commentFrom(node),
      });
    } else {
      sources.push({
        externalId: id,
        title: asString(node["title"]) ?? id,
        ...(asString(node["url"]) != null ? { url: asString(node["url"])! } : {}),
      });
    }
  }
}

/**
 * Parse a raw Zotero bundle string into the normalized shape. Auto-detects the
 * dialect. Throws ZoteroParseError when the JSON is unparseable or carries no
 * recognizable items.
 */
export function parseZoteroBundle(rawJson: string): ParsedZoteroBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    throw new ZoteroParseError(
      `invalid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  const sources: ParsedZoteroSource[] = [];
  const annotations: ParsedZoteroAnnotation[] = [];

  if (Array.isArray(parsed)) {
    // Native Zotero JSON: a bare array of items.
    for (const item of parsed) {
      if (isObject(item)) parseItem(item, sources, annotations);
    }
  } else if (isObject(parsed)) {
    if (Array.isArray(parsed["items"])) {
      // BetterBibTeX JSON: { items: [...] }.
      for (const item of parsed["items"]) {
        if (isObject(item)) parseItem(item, sources, annotations);
      }
    } else if (Array.isArray(parsed["@graph"])) {
      // RDF-as-JSON bundle: { "@graph": [...] }.
      parseRdfGraph(parsed["@graph"], sources, annotations);
    } else {
      throw new ZoteroParseError("object payload has no `items` or `@graph` array");
    }
  } else {
    throw new ZoteroParseError("payload is neither an array nor an object");
  }

  if (sources.length === 0) {
    throw new ZoteroParseError("no addressable Zotero items found");
  }

  return { sources, annotations };
}
