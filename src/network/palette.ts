/**
 * The natural watercolor palette (§3.2): Indigo, Sage Green, Ochre, Terracotta,
 * Teal. A Category's stored `colorCode` is the source of truth for its pigment;
 * this module only provides the named defaults and a stable seeding helper so a
 * category WITHOUT an explicit color still lands on a natural hue (rather than a
 * flat grey) deterministically from its id.
 *
 * PURE: no DOM, no React, no Three.js.
 */

/** The five natural watercolor pigments, as lowercase hex. */
export const NATURAL_PALETTE = {
  indigo: "#4b5578",
  sageGreen: "#8a9a7b",
  ochre: "#c8a15a",
  terracotta: "#b5653f",
  teal: "#3f8f8a",
} as const;

/** The palette as an ordered array for deterministic index seeding. */
export const NATURAL_PALETTE_ORDER: readonly string[] = [
  NATURAL_PALETTE.indigo,
  NATURAL_PALETTE.sageGreen,
  NATURAL_PALETTE.ochre,
  NATURAL_PALETTE.terracotta,
  NATURAL_PALETTE.teal,
];

/** A small stable string hash (FNV-1a) for seeding palette selection. */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Resolve the pigment for a category. If the stored `colorCode` is a concrete
 * natural color (any valid hex other than the generic default grey), it is used
 * verbatim. Otherwise a natural hue is chosen deterministically from the
 * category id so overlapping squircles still pool meaningfully under multiply.
 */
export function categoryPigment(
  categoryId: string,
  colorCode: string | undefined,
  defaultColor = "#9aa7b2",
): string {
  if (colorCode && colorCode.toLowerCase() !== defaultColor.toLowerCase()) {
    return colorCode.toLowerCase();
  }
  const idx = hashString(categoryId) % NATURAL_PALETTE_ORDER.length;
  return NATURAL_PALETTE_ORDER[idx]!;
}
