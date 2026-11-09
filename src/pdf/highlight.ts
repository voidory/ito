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
 * Motion is suppressed when either the OS `prefers-reduced-motion` query or the
 * in-app suppress-motion flag is set; the final committed state is identical,
 * so state feedback is preserved (R11) — only the transition is removed.
 */

import type { NormalizedRect } from "../model";

export type OverlayStyleKind = "highlight" | "underline";

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

/** CSS color per named highlight color. */
export const COLOR_CSS: Record<string, string> = {
  yellow: "rgba(255, 221, 87, 0.45)",
  green: "rgba(130, 220, 150, 0.45)",
  blue: "rgba(130, 190, 255, 0.45)",
  pink: "rgba(255, 150, 200, 0.45)",
};

function reducedMotion(suppressMotion: boolean): boolean {
  if (suppressMotion) return true;
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
  return false;
}

/**
 * A lightly-uneven rounded corner spec. Four slightly different radii give the
 * soft, hand-drawn feel the spec asks for without any ribbon curl. Seeded by
 * the fragment index so it is stable across re-renders (not jittering).
 */
function unevenRadius(seed: number): string {
  const base = 6;
  const jitter = (n: number) => base + ((Math.sin(seed * 12.9898 + n * 78.233) + 1) * 2.5);
  return `${jitter(1).toFixed(1)}px ${jitter(2).toFixed(1)}px ${jitter(3).toFixed(1)}px ${jitter(4).toFixed(1)}px`;
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
  if (opts.pageBorder) container.dataset.pageBorder = "true";
  Object.assign(container.style, {
    position: "absolute",
    inset: "0",
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>);

  const animate = opts.animate && !reducedMotion(opts.suppressMotion);
  const cssColor = COLOR_CSS[opts.color] ?? COLOR_CSS["yellow"]!;

  if (opts.areaBox && opts.rects[0]) {
    container.dataset.area = "true";
    const r = opts.rects[0];
    const box = document.createElement("div");
    box.className = "ito-highlight-area";
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
    opts.rects.forEach((r, i) => {
      const box = document.createElement("div");
      box.className = "ito-highlight-fragment";
      const isUnderline = opts.kind === "underline";
      Object.assign(box.style, {
        position: "absolute",
        left: `${r.x * 100}%`,
        top: isUnderline ? `${(r.y + r.height) * 100}%` : `${r.y * 100}%`,
        width: `${r.width * 100}%`,
        height: isUnderline ? "0" : `${r.height * 100}%`,
        background: isUnderline ? "transparent" : cssColor,
        borderBottom: isUnderline ? `2px solid ${solidify(opts.color)}` : "none",
        borderRadius: isUnderline ? "0" : unevenRadius(i),
        pointerEvents: "auto",
        // Keep glyphs legible: the overlay sits behind the text layer.
        zIndex: "0",
      } satisfies Partial<CSSStyleDeclaration>);

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
