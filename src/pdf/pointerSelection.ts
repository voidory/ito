/**
 * Pointer-driven text selection for pdf.js text layers.
 *
 * The browser's native drag-selection over a pdf.js text layer is greedy: a
 * press in a blank margin snaps to the nearest text, and dragging through the
 * gap between two lines (or past the end of a line) extends the selection to
 * the whole next line or block. That is the "over-highlighting" users see.
 *
 * Here the selection only ever reaches text the pointer has actually been OVER:
 *  - the anchor is the first glyph run the pointer touches (a press on blank
 *    space anchors nothing and selects nothing);
 *  - while dragging, the focus moves only when the pointer is over a glyph run
 *    of the SAME page; over blank space the selection simply holds still.
 *
 * The selection is still a real DOM Selection (setBaseAndExtent) over the real
 * text nodes, so copy, the live preview and anchor creation work unchanged.
 */

export interface CaretPoint {
  readonly node: Text;
  readonly offset: number;
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

/** The text span (inside `layer`) whose own box contains the point, if any. */
export function spanUnderPoint(
  layer: HTMLElement,
  x: number,
  y: number,
  tolerance = 1.5,
): HTMLElement | null {
  const stack = document.elementsFromPoint(x, y);
  for (const el of stack) {
    if (!(el instanceof HTMLElement)) continue;
    if (el === layer || !layer.contains(el)) continue;
    if (el.tagName !== "SPAN" || !el.textContent) continue;
    const r = el.getBoundingClientRect();
    if (
      x >= r.left - tolerance &&
      x <= r.right + tolerance &&
      y >= r.top - tolerance &&
      y <= r.bottom + tolerance
    ) {
      return el;
    }
  }
  return null;
}

/**
 * The caret position for a point, but ONLY when the point is over a glyph run
 * of `layer` (otherwise null: blank margins and inter-line gaps select nothing).
 */
export function glyphCaretAtPoint(layer: HTMLElement, x: number, y: number): CaretPoint | null {
  const span = spanUnderPoint(layer, x, y);
  if (!span) return null;
  const caret = rawCaretFromPoint(x, y);
  if (caret && caret.node.nodeType === Node.TEXT_NODE && span.contains(caret.node)) {
    return { node: caret.node as Text, offset: caret.offset };
  }
  // Some browser engines cannot resolve a caret reliably inside transformed
  // PDF.js spans. Resolve it from per-character client geometry instead. The
  // baseline axis comes from the span's transform, so 90°/270° text advances
  // along Y rather than incorrectly comparing the pointer's X coordinate.
  const text = firstTextNode(span);
  if (!text) return null;
  return { node: text, offset: textOffsetAtPoint(span, text, x, y) };
}

function firstTextNode(el: Node): Text | null {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  return walker.nextNode() as Text | null;
}

function textBaselineAxis(span: HTMLElement): { x: number; y: number } {
  const style = getComputedStyle(span);
  if (style.transform !== "none" && typeof DOMMatrixReadOnly !== "undefined") {
    try {
      // A CSS matrix maps the text run's local X/baseline axis to (a, b).
      const matrix = new DOMMatrixReadOnly(style.transform);
      const length = Math.hypot(matrix.a, matrix.b);
      if (length > 1e-6) return { x: matrix.a / length, y: matrix.b / length };
    } catch {
      // Fall through to writing-mode defaults on engines without DOMMatrix parsing.
    }
  }
  return style.writingMode.startsWith("vertical")
    ? { x: 0, y: 1 }
    : { x: 1, y: 0 };
}

function distanceToInterval(value: number, min: number, max: number): number {
  return value < min ? min - value : value > max ? value - max : 0;
}

/** Resolve a text-node offset using the visual geometry of each character. */
function textOffsetAtPoint(span: HTMLElement, text: Text, x: number, y: number): number {
  const axis = textBaselineAxis(span);
  const normal = { x: -axis.y, y: axis.x };
  const pointAlong = x * axis.x + y * axis.y;
  const pointAcross = x * normal.x + y * normal.y;
  let bestOffset = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let i = 0; i < text.data.length; i++) {
    const range = document.createRange();
    range.setStart(text, i);
    range.setEnd(text, i + 1);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;

    const corners = [
      [rect.left, rect.top],
      [rect.right, rect.top],
      [rect.left, rect.bottom],
      [rect.right, rect.bottom],
    ] as const;
    const along = corners.map(([cx, cy]) => cx * axis.x + cy * axis.y);
    const across = corners.map(([cx, cy]) => cx * normal.x + cy * normal.y);
    const minAlong = Math.min(...along);
    const maxAlong = Math.max(...along);
    const minAcross = Math.min(...across);
    const maxAcross = Math.max(...across);
    const distance = Math.hypot(
      distanceToInterval(pointAlong, minAlong, maxAlong),
      distanceToInterval(pointAcross, minAcross, maxAcross),
    );

    if (distance < bestDistance) {
      bestDistance = distance;
      bestOffset = pointAlong < (minAlong + maxAlong) / 2 ? i : i + 1;
    }
  }

  if (bestDistance < Number.POSITIVE_INFINITY) return bestOffset;

  // Last-resort fallback when a browser reports no character client rects.
  const rect = span.getBoundingClientRect();
  const corners = [
    [rect.left, rect.top],
    [rect.right, rect.top],
    [rect.left, rect.bottom],
    [rect.right, rect.bottom],
  ] as const;
  const projections = corners.map(([cx, cy]) => cx * axis.x + cy * axis.y);
  return pointAlong < (Math.min(...projections) + Math.max(...projections)) / 2
    ? 0
    : text.data.length;
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
  let anchor: CaretPoint | null = null;
  let active = false;

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
    anchor = glyphCaretAtPoint(layer, e.clientX, e.clientY);
  };

  const onMove = (e: MouseEvent): void => {
    if (!active || !layer || (e.buttons & 1) === 0) return;
    const here = glyphCaretAtPoint(layer, e.clientX, e.clientY);
    if (!here) return; // over blank space: hold the current selection
    if (!anchor) {
      anchor = here; // first glyph the pointer crossed
      return;
    }
    const sel = window.getSelection();
    sel?.setBaseAndExtent(anchor.node, anchor.offset, here.node, here.offset);
  };

  const onUp = (): void => {
    active = false;
    layer = null;
    anchor = null;
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
