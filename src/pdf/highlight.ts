/**
 * Highlight overlay rendering (browser-only) for the reading workbench.
 *
 * The overlay is drawn as absolutely-positioned boxes over a rendered page,
 * positioned from a portable anchor's NORMALIZED rects (0..1) so it tracks the
 * page across zoom/resize exactly like the text layer. The commit animation is
 * a soft, lightly-uneven rounded overlay that hugs the ACTUAL per-line glyph
 * fragments (one box per line fragment, never a single big bubble), with
 * rounded ends and NO ribbon curl. Glyphs stay legible and stationary because
 * the overlay sits BEHIND the transparent text layer and never moves them.
 *
 * v2-m1: the overlay is SUBTRACTIVE. It still paints above the opaque page
 * `<canvas>`, but with `mix-blend-mode: multiply` inside the page stage's own
 * isolated stacking context, so each channel of the result is
 * `pigment x canvas`: white paper takes the full tint while black glyphs stay
 * black (0 x anything = 0). The former `source-over` alpha fill averaged the
 * tint INTO the glyphs and lifted black text to a washed-out grey-yellow.
 *
 * Motion is suppressed when either the OS `prefers-reduced-motion` query or the
 * in-app suppress-motion flag is set; the final committed state is identical,
 * so state feedback is preserved (R11) — only the transition is removed.
 */

import type { NormalizedRect } from "../model";

export type OverlayStyleKind = "highlight" | "underline";

// ---------------------------------------------------------------------------
// M13 (§1.3) live quote-to-rect re-anchoring
// ---------------------------------------------------------------------------

/**
 * M13 (§1.3) normalize a quote / text-node run for a whitespace-insensitive
 * substring match: lowercase + collapse every whitespace run (incl. newlines)
 * to a single space. Mirrors `normalizeForMatch` in src/app/workbench.ts so the
 * DOM re-anchoring and the pure workbench re-anchoring agree on what "matches".
 * Unlike the workbench helper this does NOT trim, so character offsets stay
 * aligned with the normalized concatenation of the text nodes.
 */
function normalizeForMatch(text: string): string {
  return (text ?? "").toLowerCase().replace(/\s+/g, " ");
}

/** A single text-node run inside a `.textLayer`, with its offset span in the
 * whitespace-normalized concatenation of the layer's text. */
interface QuoteRun {
  readonly node: Text;
  readonly start: number;
  readonly end: number;
}

/**
 * M13 (§1.3) re-derive on-page NORMALIZED rects (0..1 relative to
 * `pageStageEl`) for a stored `quote` by locating it in the LIVE `.textLayer`
 * DOM of the stage and measuring a DOM Range over the matched characters.
 *
 * This is the DOM counterpart to the model/anchor layer's `resolveAnchor`: it
 * is pure (reads the DOM, mutates nothing) and lets a revised PDF whose
 * paragraph shifted to a new vertical position re-anchor its highlight to the
 * glyphs' NEW coordinates instead of replaying stale stored rects.
 *
 * Matching is whitespace-normalized (see {@link normalizeForMatch}) so a quote
 * captured at one zoom/line-wrap matches text re-flowed at another. The build
 * walks the text nodes in document order, records each node's offset span in
 * the normalized concatenation, finds the quote's start offset, and builds a
 * `Range` spanning exactly those characters.
 *
 * jsdom has no layout engine, so `range.getClientRects()` returns 0×0 rects.
 * In that case this falls back to the matched `.textLayer span`'s
 * bounding/style box; if even that is unavailable it returns `[]` so the caller
 * keeps the annotation's existing rects (never clobbering good geometry with an
 * empty set).
 */
export function recomputeRectsFromQuote(
  pageStageEl: HTMLElement,
  quote: string,
): NormalizedRect[] {
  const textLayer = pageStageEl.querySelector<HTMLElement>(".textLayer");
  if (!textLayer) return [];

  const normQuote = normalizeForMatch(quote);
  if (normQuote.trim().length === 0) return [];

  // Walk text nodes in document order, concatenating the whitespace-normalized
  // text and recording each node's [start, end) span in that concatenation.
  const runs: QuoteRun[] = [];
  let text = "";
  const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text;
    const content = normalizeForMatch(node.data);
    if (content.length === 0) continue;
    runs.push({ node, start: text.length, end: text.length + content.length });
    text += content;
  }

  const matchStart = text.indexOf(normQuote);
  if (matchStart < 0) return [];
  const matchEnd = matchStart + normQuote.length;

  const startRun = runs.find((r) => matchStart >= r.start && matchStart < r.end);
  const endRun = runs.find((r) => matchEnd > r.start && matchEnd <= r.end);
  if (!startRun || !endRun) return [];

  const stageBox = pageStageEl.getBoundingClientRect();

  // Primary path: a DOM Range over the matched characters → per-line rects.
  try {
    const range = document.createRange();
    range.setStart(startRun.node, matchStart - startRun.start);
    range.setEnd(endRun.node, matchEnd - endRun.start);
    const clientRects = Array.from(range.getClientRects()).filter(
      (r) => r.width > 0 && r.height > 0,
    );
    if (clientRects.length > 0 && stageBox.width > 0 && stageBox.height > 0) {
      return clientRects.map((r) => normalizeDomRect(r, stageBox));
    }
  } catch {
    // Fall through to the span-box fallback below.
  }

  // jsdom fallback: measure the matched spans' bounding/style box. Walk the
  // ancestor spans that the matched text nodes live inside and union them.
  const spans = new Set<HTMLElement>();
  for (const run of runs) {
    if (run.end <= matchStart || run.start >= matchEnd) continue;
    const span = run.node.parentElement?.closest<HTMLElement>("span");
    if (span) spans.add(span);
  }
  const fallback: NormalizedRect[] = [];
  for (const span of spans) {
    // M17 (§1.2): a cached / synthesized OCR span carries its NORMALIZED rect
    // on data-norm-rect, which is usable directly (no stage-box math) and never
    // zero-area — the strongest fallback for a scanned layer.
    const fromNorm = normRectFromDataset(span);
    if (fromNorm) {
      fallback.push(fromNorm);
      continue;
    }
    const box = spanBox(span);
    if (!box) continue;
    const norm = normalizeBox(box, stageBox);
    if (norm) fallback.push(norm);
  }
  return fallback;
}

/**
 * M17 (§1.2) read a `.textLayer` span's `data-norm-rect` (set by the set-text
 * layout cache + the synthetic OCR injector as `"x,y,w,h"` in 0..1) into a
 * guaranteed non-zero {@link NormalizedRect}. Returns null when the attribute
 * is absent or malformed. Exported so the anchor-fallback path can reuse it.
 */
export function normRectFromDataset(el: HTMLElement): NormalizedRect | null {
  const raw = el.dataset?.normRect ?? el.getAttribute?.("data-norm-rect");
  if (!raw) return null;
  const parts = raw.split(",").map((p) => parseFloat(p));
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) return null;
  const [x, y, w, h] = parts as [number, number, number, number];
  if (w <= 0 || h <= 0) return null;
  return { x, y, width: w, height: h };
}

/**
 * M17 (§1.2) scanned / zero-height OCR highlight fallback. Given a DOM `Range`
 * (as created from a selection over OCR text) and the page stage element,
 * produce valid NON-ZERO normalized rects even when `range.getClientRects()`
 * is empty or reports `0×0` boxes (the hallmark of a broken scanned OCR layer):
 *
 *  1. Prefer real client rects with positive area (normalized against the
 *     stage box).
 *  2. Else union the `.textLayer` spans the range touches, reading each span's
 *     `data-norm-rect` (cached / synthesized OCR geometry) — always non-zero.
 *  3. Else measure the spans' style/bounding box.
 *
 * Returns `[]` only when no geometry at all is recoverable, so a caller never
 * clobbers good rects with an empty set. Deterministic + DOM-reading-only.
 */
export function createAnchorRectsWithOcrFallback(
  pageStageEl: HTMLElement,
  range: Range,
): NormalizedRect[] {
  const stageBox = pageStageEl.getBoundingClientRect();
  // 1) Real client rects with positive area.
  try {
    const clientRects = Array.from(range.getClientRects()).filter(
      (r) => r.width > 0 && r.height > 0,
    );
    if (clientRects.length > 0 && stageBox.width > 0 && stageBox.height > 0) {
      return clientRects.map((r) => normalizeDomRect(r, stageBox));
    }
  } catch {
    // fall through
  }

  // Collect the spans the range intersects (ancestor spans of its text nodes).
  const touched = new Set<HTMLElement>();
  const collect = (node: Node | null): void => {
    if (!node) return;
    const el =
      node.nodeType === Node.TEXT_NODE
        ? (node.parentElement?.closest<HTMLElement>("span") ?? null)
        : (node as HTMLElement).closest?.<HTMLElement>("span") ?? null;
    if (el) touched.add(el);
  };
  collect(range.startContainer);
  collect(range.endContainer);
  // Also walk any spans fully enclosed by the range's common ancestor.
  const common =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? (range.commonAncestorContainer as HTMLElement)
      : range.commonAncestorContainer.parentElement;
  if (common) {
    common.querySelectorAll<HTMLElement>("span").forEach((span) => {
      try {
        if (range.intersectsNode(span)) touched.add(span);
      } catch {
        // intersectsNode may be unavailable; startContainer/endContainer cover it.
      }
    });
  }

  const out: NormalizedRect[] = [];
  for (const span of touched) {
    const fromNorm = normRectFromDataset(span);
    if (fromNorm) {
      out.push(fromNorm);
      continue;
    }
    const box = spanBox(span);
    if (!box) continue;
    const norm = normalizeBox(box, stageBox);
    if (norm && norm.width > 0 && norm.height > 0) out.push(norm);
  }
  return out;
}

/** Normalize a DOMRect against a stage box into 0..1 coordinates. */
function normalizeDomRect(rect: DOMRect, box: DOMRect): NormalizedRect {
  return {
    x: (rect.left - box.left) / box.width,
    y: (rect.top - box.top) / box.height,
    width: rect.width / box.width,
    height: rect.height / box.height,
  };
}

/** Normalize a plain left/top/width/height box against a stage box (0..1). */
function normalizeBox(
  r: { left: number; top: number; width: number; height: number },
  box: DOMRect,
): NormalizedRect | null {
  const boxW = box.width || 0;
  const boxH = box.height || 0;
  if (boxW <= 0 || boxH <= 0) return null;
  return {
    x: (r.left - box.left) / boxW,
    y: (r.top - box.top) / boxH,
    width: r.width / boxW,
    height: r.height / boxH,
  };
}

/**
 * Best-effort bounding box of a `.textLayer` span in jsdom, where
 * `getClientRects()` is 0×0. Prefers a real getBoundingClientRect when it has
 * size, else reads the absolute left/top/width/height the pdf.js TextLayer sets
 * as inline styles (the fixture builder in tests sets these too), so a page's
 * live glyph position is recoverable without a layout engine.
 */
function spanBox(
  span: HTMLElement,
): { left: number; top: number; width: number; height: number } | null {
  const rect = span.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }
  const style = span.style;
  const left = parseFloat(style.left || "");
  const top = parseFloat(style.top || "");
  const width = parseFloat(style.width || "");
  const height = parseFloat(style.height || "");
  if ([left, top, width, height].some((v) => Number.isNaN(v))) return null;
  return { left, top, width, height };
}

export interface OverlayOptions {
  readonly kind: OverlayStyleKind;
  readonly color: string;
  /** Normalized line-fragment rects (0..1). One box is drawn per fragment. */
  readonly rects: readonly NormalizedRect[];
  /** Animate the commit unless motion is suppressed. */
  readonly animate: boolean;
  /** In-app suppress-motion flag (combined with prefers-reduced-motion). */
  readonly suppressMotion: boolean;
  /** Logical annotation id, used for data-attributes + hit testing. */
  readonly annotationId: string;
  /** A whole-page BORDER style (range annotations) instead of a line hug. */
  readonly pageBorder?: boolean;
  /**
   * M6 (D01) a rectangular AREA box drawn from a single normalized rect, shown
   * with a labeled region border. Mutually exclusive with pageBorder; the
   * single rect comes through `rects[0]`.
   */
  readonly areaBox?: boolean;
  /** M6 (D01) label text shown on an area box. */
  readonly areaLabel?: string;
}

/** The blend mode every highlight surface composites with (see module doc). */
export const HIGHLIGHT_BLEND_MODE = "multiply";

/**
 * Watercolour pigment per named highlight color, tuned for `multiply`.
 *
 * Under multiply a fill is a FILTER, not a veil: the paper shows exactly this
 * colour and ink is untouched, so the pigments are OPAQUE and high-luminance
 * (a light wash that lets the paper glow) rather than a saturated colour
 * diluted with alpha. They sit close to what the previous 45%-alpha fills
 * produced on white paper, a touch warmer.
 */
export const COLOR_CSS: Record<string, string> = {
  yellow: "rgb(255, 236, 153)",
  green: "rgb(200, 240, 196)",
  blue: "rgb(196, 226, 255)",
  pink: "rgb(255, 208, 226)",
};

/** The multiply pigment for a named colour (yellow when unknown). */
export function pigmentCss(color: string): string {
  return COLOR_CSS[color] ?? COLOR_CSS["yellow"]!;
}

function reducedMotion(suppressMotion: boolean): boolean {
  if (suppressMotion) return true;
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
  return false;
}

/**
 * Create (or replace) the overlay element for an annotation inside `layer`,
 * which must be positioned (relative/absolute) and sized to the page box.
 * Returns the created container element.
 */
export function renderHighlightOverlay(
  layer: HTMLElement,
  opts: OverlayOptions,
): HTMLElement {
  // Remove any prior overlay for this annotation so re-renders are idempotent.
  layer
    .querySelectorAll(`[data-annotation-id="${cssEscape(opts.annotationId)}"]`)
    .forEach((el) => el.remove());

  const container = document.createElement("div");
  container.className = "ito-highlight";
  container.dataset.annotationId = opts.annotationId;
  container.dataset.kind = opts.kind;
  container.dataset.style = opts.kind;
  if (opts.pageBorder) container.dataset.pageBorder = "true";
  Object.assign(container.style, {
    position: "absolute",
    inset: "0",
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  // Subtractive ink: the whole overlay multiplies against the page canvas.
  // Also declared in editor.css; set inline so an overlay is never drawn as a
  // source-over veil even where that stylesheet has not been applied.
  container.style.setProperty("mix-blend-mode", HIGHLIGHT_BLEND_MODE);

  const animate = opts.animate && !reducedMotion(opts.suppressMotion);
  const cssColor = pigmentCss(opts.color);

  if (opts.areaBox && opts.rects[0]) {
    container.dataset.area = "true";
    const r = opts.rects[0];
    const box = document.createElement("div");
    box.className = "ito-highlight-area";
    // M14–M16 (FEAT-001): area highlights are also drag-linkable.
    box.draggable = true;
    Object.assign(box.style, {
      position: "absolute",
      left: `${r.x * 100}%`,
      top: `${r.y * 100}%`,
      width: `${r.width * 100}%`,
      height: `${r.height * 100}%`,
      border: `2px solid ${solidify(opts.color)}`,
      background: cssColor,
      borderRadius: "4px",
      pointerEvents: "auto",
      boxSizing: "border-box",
    } satisfies Partial<CSSStyleDeclaration>);
    if (opts.areaLabel) {
      const label = document.createElement("span");
      label.className = "ito-highlight-area-label";
      label.textContent = opts.areaLabel;
      Object.assign(label.style, {
        position: "absolute",
        left: "0",
        top: "-1.1em",
        fontSize: "0.7rem",
        color: solidify(opts.color),
        background: "rgba(255,255,255,0.85)",
        padding: "0 0.2rem",
        borderRadius: "3px",
        whiteSpace: "nowrap",
        pointerEvents: "none",
      } satisfies Partial<CSSStyleDeclaration>);
      box.appendChild(label);
    }
    container.appendChild(box);
  } else if (opts.pageBorder) {
    const border = document.createElement("div");
    border.className = "ito-highlight-border";
    Object.assign(border.style, {
      position: "absolute",
      inset: "2%",
      border: `3px solid ${solidify(opts.color)}`,
      borderRadius: "10px",
      pointerEvents: "auto",
    } satisfies Partial<CSSStyleDeclaration>);
    container.appendChild(border);
  } else {
    opts.rects.forEach((r) => {
      const box = document.createElement("div");
      box.className = "ito-highlight-fragment";
      // M14–M16 (FEAT-001): fragments are draggable so one highlight can be
      // dropped onto another to link them into an Observation Node (the drop
      // handler lives on the SourcePane mount).
      box.draggable = true;
      const isUnderline = opts.kind === "underline";
      box.dataset.style = opts.kind;
      Object.assign(box.style, {
        position: "absolute",
        left: `${r.x * 100}%`,
        top: isUnderline ? `${(r.y + r.height) * 100}%` : `${r.y * 100}%`,
        width: `${r.width * 100}%`,
        height: isUnderline ? "0" : `${r.height * 100}%`,
        // An underline is a crisp pigment stroke on the baseline with nothing
        // behind the glyphs; a highlight is a wash (its wet-edge rim and
        // corner radius come from .ito-highlight-fragment in editor.css).
        background: isUnderline ? "transparent" : cssColor,
        borderBottom: isUnderline ? `2.5px solid ${solidify(opts.color)}` : "none",
        borderRadius: isUnderline ? "0" : "3px",
        pointerEvents: "auto",
        // Keep glyphs legible: the overlay sits behind the text layer.
        zIndex: "0",
      } satisfies Partial<CSSStyleDeclaration>);
      box.style.setProperty("mix-blend-mode", HIGHLIGHT_BLEND_MODE);

      if (animate && !isUnderline) {
        box.style.transformOrigin = "left center";
        box.style.transform = "scaleX(0)";
        box.style.transition = "transform 320ms cubic-bezier(0.22, 1, 0.36, 1)";
        // Force a reflow then flip so the transition actually runs.
        void box.offsetWidth;
        requestAnimationFrame(() => {
          box.style.transform = "scaleX(1)";
        });
        box.dataset.animated = "true";
      } else {
        box.dataset.animated = "false";
      }
      container.appendChild(box);
    });
  }

  // The overlay must sit ABOVE the opaque canvas but BENEATH the transparent
  // text layer so glyphs stay legible + selectable. When drawn into the stage
  // (which holds canvas, then overlays, then .textLayer), insert the overlay
  // just before the text layer; otherwise fall back to first-child (legacy
  // text-layer host) so it still sits beneath the text spans.
  const textLayerEl = layer.querySelector(":scope > .textLayer");
  if (textLayerEl) {
    layer.insertBefore(container, textLayerEl);
  } else {
    layer.insertBefore(container, layer.firstChild);
  }
  return container;
}

function solidify(color: string): string {
  switch (color) {
    case "green":
      return "rgb(46, 160, 87)";
    case "blue":
      return "rgb(40, 120, 220)";
    case "pink":
      return "rgb(220, 60, 140)";
    default:
      return "rgb(210, 160, 20)";
  }
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// FEAT-002 (2.2) coordinate hit-testing on the page stage
// ---------------------------------------------------------------------------

/**
 * A single hit-testable annotation rectangle on a page. The rects are
 * NORMALIZED (0..1) relative to the pdf-page-stage box, so a pointer event's
 * normalized stage coordinate can be tested against them without touching the
 * DOM overlay geometry (which stays pointer-events:none during drags).
 */
export interface HitTestTarget {
  readonly id: string;
  readonly rects: readonly NormalizedRect[];
}

/**
 * Test a normalized stage point (nx, ny in 0..1) against a list of annotation
 * targets and return the id of the FIRST target whose any rect contains the
 * point (last-painted-on-top order is the caller's responsibility; callers pass
 * targets in the order they want matched). Returns null when nothing is hit.
 *
 * A small tolerance pads each rect so clicks on thin underline/line-fragment
 * boxes still register. Deterministic and DOM-free so it unit-tests cleanly.
 */
export function hitTestAnnotations(
  targets: readonly HitTestTarget[],
  nx: number,
  ny: number,
  tolerance = 0.004,
): string | null {
  for (const target of targets) {
    for (const r of target.rects) {
      if (
        nx >= r.x - tolerance &&
        nx <= r.x + r.width + tolerance &&
        ny >= r.y - tolerance &&
        ny <= r.y + r.height + tolerance
      ) {
        return target.id;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// FEAT-002 (2.4) Zotero-style figure cropper
// ---------------------------------------------------------------------------

/**
 * Crop the exact pixel region described by a NORMALIZED rect (0..1 relative to
 * the page) out of a rendered page `<canvas>` into a PNG data URL, using an
 * offscreen canvas `drawImage` + `toDataURL("image/png")`.
 *
 * In jsdom `getContext("2d")` returns null (there is no 2d backend), so this
 * returns a DETERMINISTIC inline SVG data URL fallback that encodes the crop's
 * pixel size. Tests therefore never require a real 2d canvas; callers always
 * receive a usable data URL for the annotation's imageDataUrl.
 */
export function cropCanvasRegionToDataUrl(
  canvas: HTMLCanvasElement | null | undefined,
  normRect: NormalizedRect,
): string {
  const srcW = canvas?.width ?? 0;
  const srcH = canvas?.height ?? 0;
  const sx = Math.max(0, Math.round(normRect.x * srcW));
  const sy = Math.max(0, Math.round(normRect.y * srcH));
  const sw = Math.max(1, Math.round(normRect.width * srcW));
  const sh = Math.max(1, Math.round(normRect.height * srcH));

  if (canvas && srcW > 0 && srcH > 0) {
    try {
      const out = document.createElement("canvas");
      out.width = sw;
      out.height = sh;
      const ctx = out.getContext("2d");
      if (ctx) {
        ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
        return out.toDataURL("image/png");
      }
    } catch {
      // Fall through to the deterministic SVG fallback below.
    }
  }

  return svgFallbackDataUrl(sw, sh);
}

/**
 * A deterministic inline SVG data URL used when a real 2d canvas crop is not
 * available (jsdom). It encodes the cropped pixel size so the stored
 * imageDataUrl is stable and renderable as an <img> src.
 */
function svgFallbackDataUrl(width: number, height: number): string {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="${w}" height="${h}" fill="#f8f5ee" stroke="#2c4a6f" stroke-width="2"/>` +
    `<text x="${w / 2}" y="${h / 2}" font-size="12" fill="#2c4a6f" text-anchor="middle" dominant-baseline="middle">figure ${w}x${h}</text>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
