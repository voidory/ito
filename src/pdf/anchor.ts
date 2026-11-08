/**
 * Portable text-anchor create/resolve (ADR-0003, spec section 10.1).
 *
 * The anchor model (`TextAnchor` in src/model) is deliberately free of any DOM
 * or pixel coordinates: it stores normalized rects (0..1 per page box),
 * `selectedText`, and short `prefix`/`suffix` context. This module is the
 * bridge between a live pdf.js text layer (DOM) and that portable model:
 *
 *  - `createAnchor` reads a browser `Selection` inside a rendered pdf.js text
 *    layer and PRODUCES a portable anchor (normalized rects + text context).
 *  - `resolveAnchor` takes a portable anchor and a (possibly re-rendered, re-
 *    zoomed, resized) text layer and RE-DERIVES on-page rects by matching the
 *    text content, using prefix/suffix to disambiguate repeated strings.
 *
 * Because resolution works off the extracted text + normalized geometry rather
 * than stored pixel offsets, an anchor round-trips across reload, zoom change
 * and page resize. See docs/spikes/pdf-anchor.md for the executed result.
 */

import type {
  AnchorResolution,
  NormalizedRect,
  SourceId,
  SourceVersionHash,
  TextAnchor,
} from "../model";

/** Number of context characters captured on each side for re-anchoring. */
export const CONTEXT_LENGTH = 32;

/**
 * The geometry a text layer reports for a resolved anchor. `rects` are the
 * normalized highlight boxes (0..1); `text` is the glyph text they cover.
 */
export interface ResolvedAnchor {
  readonly resolution: AnchorResolution;
  readonly rects: readonly NormalizedRect[];
  readonly text: string;
}

/**
 * Inputs that identify the surrounding page box so DOM client rects can be
 * normalized to 0..1. The box is the CSS-pixel bounding rect of the page
 * container (same element the text layer is positioned within).
 */
export interface PageBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** A single glyph-run div inside the text layer, with its on-screen rect. */
export interface TextRun {
  readonly text: string;
  readonly rect: DOMRect;
}

function normalizeRect(rect: DOMRect, box: PageBox): NormalizedRect {
  return {
    x: (rect.left - box.left) / box.width,
    y: (rect.top - box.top) / box.height,
    width: rect.width / box.width,
    height: rect.height / box.height,
  };
}

/**
 * Collapse a set of normalized rects into per-line boxes. Client rects from a
 * DOM Range are already one-per-line, so we just copy them; this indirection
 * exists so callers can treat the output uniformly.
 */
function clientRectsToNormalized(
  rects: readonly DOMRect[],
  box: PageBox,
): NormalizedRect[] {
  return rects
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => normalizeRect(r, box));
}

export interface CreateAnchorParams {
  readonly docId: SourceId;
  readonly sourceVersionHash: SourceVersionHash;
  readonly pageIndex: number;
  /** The live browser selection; must be non-empty and inside the text layer. */
  readonly selection: Selection;
  /** Bounding box of the page container, in CSS pixels. */
  readonly pageBox: PageBox;
  /** Full extracted page text, used to capture prefix/suffix context. */
  readonly pageText: string;
}

/**
 * Build a portable `TextAnchor` from a live selection inside a pdf.js text
 * layer. Throws if the selection is empty.
 */
export function createAnchor(params: CreateAnchorParams): TextAnchor {
  const { selection, pageBox, pageText } = params;
  if (selection.rangeCount === 0) {
    throw new Error("createAnchor: selection has no range");
  }
  const range = selection.getRangeAt(0);
  const selectedText = selection.toString();
  if (selectedText.length === 0) {
    throw new Error("createAnchor: selection is empty");
  }

  const clientRects = Array.from(range.getClientRects());
  const rects = clientRectsToNormalized(clientRects, pageBox);

  const { prefix, suffix } = computeContext(pageText, selectedText);

  return {
    docId: params.docId,
    sourceVersionHash: params.sourceVersionHash,
    pageIndex: params.pageIndex,
    rects,
    selectedText,
    prefix,
    suffix,
  };
}

/**
 * Compute prefix/suffix context around the FIRST occurrence of `selectedText`
 * in `pageText`. If the selection text is not found verbatim (whitespace
 * differences), context is empty; resolution still works off `selectedText`.
 */
export function computeContext(
  pageText: string,
  selectedText: string,
): { prefix: string; suffix: string } {
  const idx = pageText.indexOf(selectedText);
  if (idx < 0) {
    return { prefix: "", suffix: "" };
  }
  const prefix = pageText.slice(Math.max(0, idx - CONTEXT_LENGTH), idx);
  const end = idx + selectedText.length;
  const suffix = pageText.slice(end, end + CONTEXT_LENGTH);
  return { prefix, suffix };
}

/**
 * Locate the character offset of an anchor's selection within the page text,
 * disambiguating repeated occurrences using prefix/suffix context.
 *
 * Returns the start offset, or -1 if not found. Exported for testability.
 */
export function locateInText(pageText: string, anchor: TextAnchor): number {
  const { selectedText, prefix, suffix } = anchor;
  if (selectedText.length === 0) return -1;

  let searchFrom = 0;
  // Collect all occurrences, then pick the one whose surrounding context best
  // matches the stored prefix/suffix.
  const candidates: number[] = [];
  for (;;) {
    const idx = pageText.indexOf(selectedText, searchFrom);
    if (idx < 0) break;
    candidates.push(idx);
    searchFrom = idx + 1;
  }
  if (candidates.length === 0) return -1;
  if (candidates.length === 1) return candidates[0]!;

  let best = candidates[0]!;
  let bestScore = -1;
  for (const idx of candidates) {
    const before = pageText.slice(Math.max(0, idx - prefix.length), idx);
    const after = pageText.slice(
      idx + selectedText.length,
      idx + selectedText.length + suffix.length,
    );
    const score = commonSuffixLen(before, prefix) + commonPrefixLen(after, suffix);
    if (score > bestScore) {
      bestScore = score;
      best = idx;
    }
  }
  return best;
}

function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function commonSuffixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

export interface ResolveAnchorParams {
  readonly anchor: TextAnchor;
  readonly currentVersionHash: SourceVersionHash;
  /** Full extracted page text of the (possibly re-rendered) page. */
  readonly pageText: string;
  /** Bounding box of the current page container, in CSS pixels. */
  readonly pageBox: PageBox;
  /**
   * Maps a [startOffset, endOffset) character range in `pageText` to the DOM
   * client rects covering those glyphs. Supplied by the renderer, which owns
   * the text-layer DOM. Returned rects are in CSS pixels.
   */
  readonly rangeToClientRects: (
    startOffset: number,
    endOffset: number,
  ) => readonly DOMRect[];
}

/**
 * Re-derive on-page rects for a portable anchor against a current render.
 *
 * Resolution is explicit: a version-hash mismatch yields a `mismatched`
 * resolution, a missing selection yields `unresolved`, and a successful match
 * yields `resolved` with freshly computed normalized rects (never the stored
 * ones — proving the geometry is re-derived, not replayed).
 */
export function resolveAnchor(params: ResolveAnchorParams): ResolvedAnchor {
  const { anchor, currentVersionHash, pageText, pageBox, rangeToClientRects } =
    params;

  if (anchor.sourceVersionHash !== currentVersionHash) {
    return {
      resolution: {
        kind: "mismatched",
        reason: "source version hash changed since anchor was created",
        expectedVersionHash: anchor.sourceVersionHash,
        actualVersionHash: currentVersionHash,
      },
      rects: [],
      text: "",
    };
  }

  const start = locateInText(pageText, anchor);
  if (start < 0) {
    return {
      resolution: {
        kind: "unresolved",
        reason: "selected text not found in current page render",
      },
      rects: [],
      text: "",
    };
  }

  const end = start + anchor.selectedText.length;
  const clientRects = Array.from(rangeToClientRects(start, end));
  const rects = clientRectsToNormalized(clientRects, pageBox);

  return {
    resolution: { kind: "resolved" },
    rects,
    text: pageText.slice(start, end),
  };
}
