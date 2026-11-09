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
  // The engine resolved to the element (or a neighbour): fall back to the
  // span's first text node, choosing the nearer end by x.
  const text = firstTextNode(span);
  if (!text) return null;
  const r = span.getBoundingClientRect();
  return { node: text, offset: x < r.left + r.width / 2 ? 0 : text.data.length };
}

function firstTextNode(el: Node): Text | null {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  return walker.nextNode() as Text | null;
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
