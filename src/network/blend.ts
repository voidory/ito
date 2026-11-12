/**
 * Pure color helpers implementing watercolor MULTIPLY semantics (§3.2).
 *
 * PURE: no DOM, no React, no Three.js.
 *
 * A multiplicative blend models overlapping translucent pigment: each channel
 * is multiplied in normalized [0,1] space, so overlaps are always darker-or-
 * equal than any single input. Because multiplication is commutative, the blend
 * is order-independent. These are used later to derive a Relationship/hub
 * `blendColor` from the category colors its endpoints belong to.
 */

/** An {r,g,b} triple with each channel in [0,255]. */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

function clampByte(v: number): number {
  if (v < 0) return 0;
  if (v > 255) return 255;
  return Math.round(v);
}

/**
 * Parse a hex color (`#rgb`, `#rrggbb`, or without the leading `#`) into an Rgb
 * triple. Throws on malformed input so callers fail loudly rather than blending
 * garbage.
 */
export function parseHex(hex: string): Rgb {
  let h = hex.trim();
  if (h.startsWith("#")) h = h.slice(1);
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h)) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/** Format an Rgb triple back into a lowercase `#rrggbb` string. */
export function toHex(rgb: Rgb): string {
  const part = (v: number): string => clampByte(v).toString(16).padStart(2, "0");
  return `#${part(rgb.r)}${part(rgb.g)}${part(rgb.b)}`;
}

/**
 * Multiplicatively blend N hex colors (watercolor multiply). Each channel is
 * multiplied in normalized [0,1] space. The result is darker-or-equal to every
 * input on every channel, and the operation is order-independent. A single
 * color returns itself; an empty list returns white (the multiplicative
 * identity).
 */
export function blendColors(hexColors: readonly string[]): string {
  if (hexColors.length === 0) return "#ffffff";
  let r = 1;
  let g = 1;
  let b = 1;
  for (const hex of hexColors) {
    const c = parseHex(hex);
    r *= c.r / 255;
    g *= c.g / 255;
    b *= c.b / 255;
  }
  return toHex({ r: r * 255, g: g * 255, b: b * 255 });
}

/**
 * Derive a hub / Relationship `blendColor` from the set of category colors its
 * endpoints belong to. Duplicate category colors are collapsed first so a hub
 * is not darkened merely because several endpoints share one category; the
 * blend reflects the DISTINCT categories spanned by the hub.
 */
export function deriveHubBlendColor(categoryColors: readonly string[]): string {
  const distinct = Array.from(new Set(categoryColors.map((c) => c.trim().toLowerCase())));
  return blendColors(distinct);
}
