/**
 * Pointer-driven text selection for pdf.js text layers.
 *
 * The browser's native drag-selection over a pdf.js text layer is greedy: a
 * press in a blank margin snaps to the nearest text, and dragging through the
 * gap between two lines (or past the end of a line) extends the selection to
 * the whole next line or block. That is the "over-highlighting" users see.
 *
 * Here the selection only ever reaches text the pointer has actually been AT:
 *  - the anchor is the first glyph run the pointer reaches (a press far out in
 *    blank space anchors nothing and selects nothing);
 *  - while dragging, the focus moves only when the pointer resolves to a glyph
 *    run of the SAME page; over open blank space the selection holds still.
 *
 * v2-m1 makes "at" forgiving without making it greedy:
 *  - MAGNETIC LINE BAND. A point that misses every span's tight box is
 *    resolved against a padded band around each line: {@link LINE_PAD_Y} px
 *    across the line and {@link MARGIN_PAD_X} px along it. A press just inside
 *    the left margin lands on the line's leading edge, just past its end on
 *    the trailing edge, and a press in the leading between two lines goes to
 *    the nearer one. Beyond the pads nothing is captured.
 *  - 35% / 65% GLYPH HYSTERESIS. A caret is resolved from the pointer's
 *    fraction `u` through the glyph it is in, with a threshold that depends on
 *    the role (see {@link resolveCharOffsetWithHysteresis}), so the first and
 *    last letters of a drag are included once the pointer is a third of the
 *    way into them, instead of needing the exact outer edge.
 *
 * Nothing here snaps to words: every offset is a single-character decision.
 *
 * The selection is still a real DOM Selection (setBaseAndExtent) over the real
 * text nodes, so copy, the live preview and anchor creation work unchanged.
 */

import { isOcrPlaceholderSpan } from "./textCache";

/** Across-line capture pad (px): how far above/below a line still counts. */
export const LINE_PAD_Y = 6;
/** Along-line capture pad (px): how far into a margin / gap still counts. */
export const MARGIN_PAD_X = 16;
/**
 * Pointer travel (px) before a press becomes a drag. Under the 35/65 rule a
 * press between 35% and 65% of a glyph would otherwise select that glyph on
 * the first pixel of hand jitter, turning plain clicks into 1-char selections.
 */
export const DRAG_SLOP_PX = 3;

/**
 * Which end of the selection a pointer position is being resolved for.
 * `anchor` is the press point of a forward drag (and the default before the
 * direction is known); `anchor-backward` is its mirror image, used once the
 * drag turns out to run right-to-left so the letter under the press is kept.
 */
export type HysteresisRole = "anchor" | "anchor-backward" | "focus-forward" | "focus-backward";

/**
 * Map the pointer's fraction through a glyph (`0` = leading edge, `1` =
 * trailing edge) to a caret side: `0` puts the caret BEFORE the glyph
 * (offset `i`), `1` AFTER it (offset `i + 1`).
 *
 *  - `anchor`: before the glyph while `u < 0.65`, so a forward drag that
 *    starts anywhere in the first two thirds of a letter includes it.
 *  - `focus-forward`: after the glyph once `u >= 0.35`.
 *  - `focus-backward`: before the glyph while `u <= 0.65`, i.e. a leftward
 *    drag includes a glyph once the pointer has crossed 35% of it from the
 *    right.
 *  - `anchor-backward`: after the glyph once `u > 0.35` (mirror of `anchor`).
 *
 * Pure and character-level: it never looks at word boundaries.
 */
export function resolveCharOffsetWithHysteresis(
  glyphFraction: number,
  role: HysteresisRole,
): 0 | 1 {
  const u = Number.isFinite(glyphFraction) ? Math.min(1, Math.max(0, glyphFraction)) : 0;
  switch (role) {
    case "anchor":
      return u < 0.65 ? 0 : 1;
    case "anchor-backward":
      return u > 0.35 ? 1 : 0;
    case "focus-forward":
      return u >= 0.35 ? 1 : 0;
    case "focus-backward":
      return u <= 0.65 ? 0 : 1;
  }
}

export interface CaretPoint {
  readonly node: Text;
  readonly offset: number;
}

/** How a pointer position reached the span it was resolved against. */
export type SpanCaptureKind =
  /** The point is inside the span's own (tight) box. */
  | "direct"
  /** On the span's row, within {@link MARGIN_PAD_X} of one of its ends. */
  | "margin"
  /** In the leading above/below the span, within {@link LINE_PAD_Y}. */
  | "line-band";

export interface SpanCapture {
  readonly span: HTMLElement;
  readonly kind: SpanCaptureKind;
}

/** A pointer position resolved to one glyph of a text-layer span. */
export interface GlyphHit {
  readonly span: HTMLElement;
  readonly node: Text;
  /** The glyph is `node.data[index]`, i.e. the offsets `[index, index + 1)`. */
  readonly index: number;
  /** How far through the glyph the pointer is along the baseline, 0..1. */
  readonly fraction: number;
  readonly capture: SpanCaptureKind;
}

/** Text-node caret nearest to a viewport point, using whichever API exists. */
function rawCaretFromPoint(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (typeof doc.caretPositionFromPoint === "function") {
    const p = doc.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  if (typeof doc.caretRangeFromPoint === "function") {
    const r = doc.caretRangeFromPoint(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }
  return null;
}

/**
 * A span the pointer may select: a non-empty text span of `layer`. The
 * placeholder bands injected on image-only pages ("[OCR] page 1 line 3") are
 * excluded: they are not the page's text, so a drag over a scanned page must
 * fall through to the ink-band highlighter instead of selecting them.
 */
function isSelectableSpan(layer: HTMLElement, el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el === layer || !layer.contains(el)) return false;
  if (el.tagName !== "SPAN" || !el.textContent) return false;
  return !isOcrPlaceholderSpan(el);
}

interface SpanRect {
  readonly span: HTMLElement;
  readonly rect: DOMRect;
}

interface SpanRectCache {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly count: number;
  readonly entries: readonly SpanRect[];
}

const spanRectCaches = new WeakMap<HTMLElement, SpanRectCache>();

/**
 * Viewport boxes of every selectable span of `layer`. Reused between pointer
 * events for as long as the layer has not moved, resized or been rebuilt, so a
 * drag through the leading between lines does not re-measure the whole page on
 * every mousemove.
 */
function spanRects(layer: HTMLElement): readonly SpanRect[] {
  const box = layer.getBoundingClientRect();
  const count = layer.childElementCount;
  const cached = spanRectCaches.get(layer);
  if (
    cached &&
    cached.left === box.left &&
    cached.top === box.top &&
    cached.width === box.width &&
    cached.height === box.height &&
    cached.count === count &&
    (cached.entries.length === 0 || cached.entries[0]!.span.isConnected)
  ) {
    return cached.entries;
  }
  const entries: SpanRect[] = [];
  for (const el of Array.from(layer.querySelectorAll("span"))) {
    if (!isSelectableSpan(layer, el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    entries.push({ span: el, rect });
  }
  // A layer without layout (zero box) gives nothing to key the cache on.
  if (box.width > 0 && box.height > 0) {
    spanRectCaches.set(layer, {
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
      count,
      entries,
    });
  }
  return entries;
}

function rectContains(r: DOMRect, x: number, y: number, tolerance: number): boolean {
  return (
    x >= r.left - tolerance &&
    x <= r.right + tolerance &&
    y >= r.top - tolerance &&
    y <= r.bottom + tolerance
  );
}

/** The text span (inside `layer`) whose own box contains the point, if any. */
export function spanUnderPoint(
  layer: HTMLElement,
  x: number,
  y: number,
  tolerance = 1.5,
): HTMLElement | null {
  if (typeof document.elementsFromPoint === "function") {
    for (const el of document.elementsFromPoint(x, y)) {
      if (!isSelectableSpan(layer, el)) continue;
      if (rectContains(el.getBoundingClientRect(), x, y, tolerance)) return el;
    }
    return null;
  }
  // No hit-testing API (jsdom): fall back to the span boxes themselves.
  for (const { span, rect } of spanRects(layer)) {
    if (rectContains(rect, x, y, tolerance)) return span;
  }
  return null;
}

function distanceToInterval(value: number, min: number, max: number): number {
  return value < min ? min - value : value > max ? value - max : 0;
}

/** True when the page is rotated a quarter turn, so its lines run vertically. */
function linesRunVertically(layer: HTMLElement): boolean {
  const rotation = Number(layer.getAttribute("data-main-rotation") ?? "0");
  return rotation === 90 || rotation === 270;
}

/** Two span boxes share a line when they overlap across it by half a line. */
function onSameLine(a: DOMRect, b: DOMRect, vertical: boolean): boolean {
  const [aMin, aMax, bMin, bMax] = vertical
    ? [a.left, a.right, b.left, b.right]
    : [a.top, a.bottom, b.top, b.bottom];
  const overlap = Math.min(aMax, bMax) - Math.max(aMin, bMin);
  return overlap >= Math.min(aMax - aMin, bMax - bMin) * 0.5;
}

/**
 * Resolve a viewport point to a span of `layer`.
 *
 * A point inside a span's tight box is a `direct` hit. Otherwise every span is
 * tested against its padded band ({@link MARGIN_PAD_X} along the line,
 * {@link LINE_PAD_Y} across it) and the nearest one wins, with one ordering
 * rule: a span whose row the point is ON (a margin or an inter-word gap)
 * always beats a span the point is merely above or below. Null when the point
 * is outside every band.
 *
 * `hold` is the span the drag's focus is currently on. In the leading between
 * two lines the focus stays on its line until the pointer is strictly nearer
 * another one, so brushing the gap below a line does not pull in the next.
 */
export function captureSpanAtPoint(
  layer: HTMLElement,
  x: number,
  y: number,
  hold?: HTMLElement | null,
): SpanCapture | null {
  const direct = spanUnderPoint(layer, x, y);
  if (direct) return { span: direct, kind: "direct" };

  const vertical = linesRunVertically(layer);
  let best: { span: HTMLElement; rect: DOMRect; across: number; score: number } | null = null;
  for (const { span, rect } of spanRects(layer)) {
    const dx = distanceToInterval(x, rect.left, rect.right);
    const dy = distanceToInterval(y, rect.top, rect.bottom);
    const along = vertical ? dy : dx;
    const across = vertical ? dx : dy;
    if (along > MARGIN_PAD_X || across > LINE_PAD_Y) continue;
    const score =
      (across > 0 ? 2 : 0) + Math.hypot(along / MARGIN_PAD_X, across / LINE_PAD_Y);
    if (!best || score < best.score) best = { span, rect, across, score };
  }
  if (!best) return null;
  if (best.across === 0) return { span: best.span, kind: "margin" };

  if (hold && hold !== best.span && hold.isConnected) {
    const held = hold.getBoundingClientRect();
    const heldAcross = vertical
      ? distanceToInterval(x, held.left, held.right)
      : distanceToInterval(y, held.top, held.bottom);
    if (!onSameLine(held, best.rect, vertical) && heldAcross <= best.across) return null;
  }
  return { span: best.span, kind: "line-band" };
}

function firstTextNode(el: Node): Text | null {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  return walker.nextNode() as Text | null;
}

/** A glyph's extent along / across its line, in viewport pixels. */
interface GlyphBox {
  readonly minAlong: number;
  readonly maxAlong: number;
  readonly minAcross: number;
  readonly maxAcross: number;
}

interface GlyphGeometry {
  readonly key: string;
  readonly axis: { readonly x: number; readonly y: number };
  /** One entry per character; null where the browser reports no box. */
  readonly boxes: readonly (GlyphBox | null)[];
  readonly measured: boolean;
}

const glyphGeometryCache = new WeakMap<Text, GlyphGeometry>();

function projectRect(
  rect: DOMRect,
  axis: { readonly x: number; readonly y: number },
): GlyphBox {
  const normal = { x: -axis.y, y: axis.x };
  const corners = [
    [rect.left, rect.top],
    [rect.right, rect.top],
    [rect.left, rect.bottom],
    [rect.right, rect.bottom],
  ] as const;
  const along = corners.map(([cx, cy]) => cx * axis.x + cy * axis.y);
  const across = corners.map(([cx, cy]) => cx * normal.x + cy * normal.y);
  return {
    minAlong: Math.min(...along),
    maxAlong: Math.max(...along),
    minAcross: Math.min(...across),
    maxAcross: Math.max(...across),
  };
}

/**
 * Per-character geometry of a span, measured from the actual post-transform
 * client rects (so it is correct inside pdf.js's scaleX'd spans and on rotated
 * pages, where the browser caret APIs are not). Cached per text node until the
 * span moves or its text changes.
 */
function glyphGeometry(span: HTMLElement, text: Text): GlyphGeometry {
  const spanRect = span.getBoundingClientRect();
  const key = `${spanRect.left},${spanRect.top},${spanRect.width},${spanRect.height},${text.data.length}`;
  const cached = glyphGeometryCache.get(text);
  if (cached && cached.key === key) return cached;

  const rects: (DOMRect | null)[] = [];
  let first: { x: number; y: number } | null = null;
  let last: { x: number; y: number } | null = null;
  // jsdom implements Range but not its geometry; there every glyph is unmeasured.
  const canMeasure = typeof Range.prototype.getBoundingClientRect === "function";
  for (let i = 0; i < text.data.length; i++) {
    if (!canMeasure) {
      rects.push(null);
      continue;
    }
    const range = document.createRange();
    range.setStart(text, i);
    range.setEnd(text, i + 1);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      rects.push(null);
      continue;
    }
    rects.push(rect);
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    first ??= center;
    last = center;
  }

  // Infer the baseline from the first/last character centres: those are
  // already in viewport coordinates and include every ancestor transform,
  // which getComputedStyle(span).transform does not.
  let axis: { x: number; y: number } | null = null;
  if (first && last) {
    const dx = last.x - first.x;
    const dy = last.y - first.y;
    const length = Math.hypot(dx, dy);
    if (length > 1e-6) axis = { x: dx / length, y: dy / length };
  }
  if (!axis) {
    // A one-character run has no measurable progression: fall back to the
    // span's own CSS transform, then to the writing-mode default.
    const style = getComputedStyle(span);
    const transform = style.transform;
    if (transform && transform !== "none" && typeof DOMMatrixReadOnly !== "undefined") {
      try {
        const matrix = new DOMMatrixReadOnly(transform);
        const length = Math.hypot(matrix.a, matrix.b);
        if (length > 1e-6) axis = { x: matrix.a / length, y: matrix.b / length };
      } catch {
        // Fall through to the writing-mode default.
      }
    }
    axis ??= (style.writingMode ?? "").startsWith("vertical") ? { x: 0, y: 1 } : { x: 1, y: 0 };
  }

  const resolvedAxis = axis;
  const geometry: GlyphGeometry = {
    key,
    axis: resolvedAxis,
    boxes: rects.map((r) => (r ? projectRect(r, resolvedAxis) : null)),
    measured: rects.some((r) => r !== null),
  };
  // Only cache real measurements: an unlaid-out span has nothing stable to key on.
  if (geometry.measured) glyphGeometryCache.set(text, geometry);
  return geometry;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * The glyph of `text` nearest to a viewport point, and how far through it the
 * point is. A point before the first glyph resolves to fraction 0 of it and a
 * point past the last to fraction 1, which is what turns a margin capture into
 * the line's leading / trailing edge.
 */
function nearestGlyph(
  span: HTMLElement,
  text: Text,
  x: number,
  y: number,
): { index: number; fraction: number } {
  const { axis, boxes, measured } = glyphGeometry(span, text);
  const pointAlong = x * axis.x + y * axis.y;
  const pointAcross = -x * axis.y + y * axis.x;

  if (measured) {
    let bestIndex = 0;
    let bestBox: GlyphBox | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    boxes.forEach((box, i) => {
      if (!box) return;
      const distance = Math.hypot(
        distanceToInterval(pointAlong, box.minAlong, box.maxAlong),
        distanceToInterval(pointAcross, box.minAcross, box.maxAcross),
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
        bestBox = box;
      }
    });
    const box = bestBox as GlyphBox | null;
    if (box) {
      const width = box.maxAlong - box.minAlong;
      const fraction = width > 0 ? clamp01((pointAlong - box.minAlong) / width) : 0;
      return { index: bestIndex, fraction };
    }
  }

  // No per-character boxes (no layout engine): spread the characters evenly
  // over the span's own box.
  const box = projectRect(span.getBoundingClientRect(), axis);
  const extent = box.maxAlong - box.minAlong;
  const length = text.data.length;
  if (extent <= 0 || length === 0) return { index: 0, fraction: 0 };
  const position = clamp01((pointAlong - box.minAlong) / extent) * length;
  const index = Math.min(length - 1, Math.floor(position));
  return { index, fraction: clamp01(position - index) };
}

/**
 * Fast path for an untransformed span: ask the browser for the caret, then
 * measure only the two glyphs either side of it to find which one the pointer
 * is in. Null when the span is transformed (pdf.js scaleX, rotated pages),
 * where the caret APIs can report a plausible but visually wrong position.
 */
function glyphFromCaretApi(
  span: HTMLElement,
  x: number,
  y: number,
): { node: Text; index: number; fraction: number } | null {
  const style = getComputedStyle(span);
  const transform = style.transform;
  if ((transform && transform !== "none") || (style.writingMode ?? "").startsWith("vertical")) {
    return null;
  }
  const caret = rawCaretFromPoint(x, y);
  if (!caret || caret.node.nodeType !== Node.TEXT_NODE || !span.contains(caret.node)) return null;
  const node = caret.node as Text;
  const length = node.data.length;
  if (length === 0) return null;

  let best: { index: number; fraction: number; distance: number } | null = null;
  for (const index of [caret.offset - 1, caret.offset]) {
    if (index < 0 || index >= length) continue;
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + 1);
    const rect = range.getBoundingClientRect();
    if (rect.width <= 0) continue;
    const distance = distanceToInterval(x, rect.left, rect.right);
    if (!best || distance < best.distance) {
      best = { index, fraction: clamp01((x - rect.left) / rect.width), distance };
    }
  }
  return best ? { node, index: best.index, fraction: best.fraction } : null;
}

/**
 * Resolve a viewport point to a glyph of `layer`, through the padded line band
 * (see {@link captureSpanAtPoint}). Null when the point is outside every band:
 * open blank space selects nothing.
 */
export function glyphHitAtPoint(
  layer: HTMLElement,
  x: number,
  y: number,
  hold?: HTMLElement | null,
): GlyphHit | null {
  const captured = captureSpanAtPoint(layer, x, y, hold);
  if (!captured) return null;
  const { span, kind } = captured;
  if (kind === "direct") {
    const fast = glyphFromCaretApi(span, x, y);
    if (fast) return { span, ...fast, capture: kind };
  }
  const text = firstTextNode(span);
  if (!text || text.data.length === 0) return null;
  return { span, node: text, ...nearestGlyph(span, text, x, y), capture: kind };
}

/** The caret a glyph hit resolves to for one end of the selection. */
export function caretForHit(hit: GlyphHit, role: HysteresisRole): CaretPoint {
  return {
    node: hit.node,
    offset: hit.index + resolveCharOffsetWithHysteresis(hit.fraction, role),
  };
}

/**
 * The caret position for a point, resolved through the padded line band and
 * the glyph hysteresis for `role`. Null when the point is outside every band.
 */
export function glyphCaretAtPoint(
  layer: HTMLElement,
  x: number,
  y: number,
  role: HysteresisRole = "anchor",
): CaretPoint | null {
  const hit = glyphHitAtPoint(layer, x, y);
  return hit ? caretForHit(hit, role) : null;
}

/** True when `focus` is at or after `anchor` in document order. */
function runsForward(anchor: GlyphHit, focus: GlyphHit): boolean {
  if (anchor.node === focus.node) {
    return focus.index + focus.fraction >= anchor.index + anchor.fraction;
  }
  return (
    (anchor.node.compareDocumentPosition(focus.node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
  );
}

export interface PointerSelectionOptions {
  /** The text layers currently rendered (one per page). */
  readonly getLayers: () => readonly HTMLElement[];
  /** When false the controller steps aside (area tool, range mode...). */
  readonly enabled: () => boolean;
}

/**
 * Install the controller on `root` (an element containing the pages). Returns a
 * cleanup function.
 */
export function installPointerSelection(
  root: HTMLElement,
  opts: PointerSelectionOptions,
): () => void {
  let layer: HTMLElement | null = null;
  let anchor: GlyphHit | null = null;
  let focusSpan: HTMLElement | null = null;
  let active = false;
  let dragging = false;
  let downX = 0;
  let downY = 0;

  const layerAt = (target: EventTarget | null): HTMLElement | null => {
    if (!(target instanceof Element)) return null;
    return opts.getLayers().find((l) => l.contains(target) || l === target) ?? null;
  };

  const onDown = (e: MouseEvent): void => {
    if (e.button !== 0 || !opts.enabled()) return;
    // Word / line selection (double / triple click) stays native.
    if (e.detail > 1) return;
    const hit = opts.getLayers().find((l) => {
      const r = l.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    });
    layer = hit ?? layerAt(e.target);
    if (!layer) return;
    // Take over from the native, greedy selection.
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    active = true;
    dragging = false;
    downX = e.clientX;
    downY = e.clientY;
    anchor = glyphHitAtPoint(layer, e.clientX, e.clientY);
    focusSpan = anchor?.span ?? null;
  };

  const onMove = (e: MouseEvent): void => {
    if (!active || !layer || (e.buttons & 1) === 0) return;
    if (!dragging) {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) < DRAG_SLOP_PX) return;
      dragging = true;
    }
    const here = glyphHitAtPoint(layer, e.clientX, e.clientY, focusSpan);
    if (!here) return; // outside every line band: hold the current selection
    focusSpan = here.span;
    if (!anchor) {
      anchor = here; // first glyph the pointer reached
      return;
    }
    // The thresholds depend on which way the drag runs, and so does the side
    // of the pressed glyph the anchor takes: either way the letter under the
    // press and the letter under the pointer are both kept once the pointer is
    // a third of the way into them.
    const forward = runsForward(anchor, here);
    const from = caretForHit(anchor, forward ? "anchor" : "anchor-backward");
    const to = caretForHit(here, forward ? "focus-forward" : "focus-backward");
    let focusOffset = to.offset;
    if (from.node === to.node) {
      // Never let the two thresholds cross into an inverted sliver.
      focusOffset = forward
        ? Math.max(from.offset, focusOffset)
        : Math.min(from.offset, focusOffset);
    }
    window.getSelection()?.setBaseAndExtent(from.node, from.offset, to.node, focusOffset);
  };

  const onUp = (): void => {
    active = false;
    dragging = false;
    layer = null;
    anchor = null;
    focusSpan = null;
  };

  root.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  return () => {
    root.removeEventListener("mousedown", onDown);
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
}
