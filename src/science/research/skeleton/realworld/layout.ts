/**
 * FEAT-005B — deterministic layout of a corpus structure into PIXEL space.
 *
 * Both the Python renderer and the TypeScript benchmark MUST place a structure
 * identically so the ground-truth atom coordinates line up with the rendered
 * PNG. To guarantee that, the layout math lives here (TypeScript) and is also
 * exported to JSON (`fixtures/realworld/manifest.json`) for the renderer to
 * consume. There is a single source of truth: `corpus.ts` + this function.
 *
 * The layout:
 *   1. scales the layout-unit coordinates by `render.scale`,
 *   2. translates so the drawing's bounding box sits at (PAD, PAD),
 *   3. reserves a uniform PAD margin (also leaving room for labels).
 */

import type { Point } from "../../../skeleton/types";
import type { RealWorldStructure } from "./corpus";

/** Pixel padding around the drawing (also the space labels may occupy). */
export const LAYOUT_PAD = 28;

export interface PixelLayout {
  readonly atoms: Point[];
  readonly bonds: readonly (readonly [number, number])[];
  readonly width: number;
  readonly height: number;
  /** Labels in pixel space (atom position + offset). */
  readonly labels: { x: number; y: number; text: string }[];
}

/** Lay a structure out in pixel space, matching the renderer exactly. */
export function layoutStructure(structure: RealWorldStructure): PixelLayout {
  const scale = structure.render.scale;
  const scaled = structure.atoms.map((p) => ({ x: p.x * scale, y: p.y * scale }));
  const minX = Math.min(...scaled.map((p) => p.x));
  const minY = Math.min(...scaled.map((p) => p.y));
  const atoms = scaled.map((p) => ({ x: p.x - minX + LAYOUT_PAD, y: p.y - minY + LAYOUT_PAD }));

  const labels = structure.labels.map((lab) => {
    const base = atoms[lab.atom] as Point;
    return { x: base.x + lab.dx, y: base.y + lab.dy, text: lab.text };
  });

  // Include label extents in the canvas size so nothing is clipped.
  const allX = [...atoms.map((p) => p.x), ...labels.map((l) => l.x + l.text.length * 10)];
  const allY = [...atoms.map((p) => p.y), ...labels.map((l) => l.y + 14)];
  const width = Math.ceil(Math.max(...allX) + LAYOUT_PAD);
  const height = Math.ceil(Math.max(...allY) + LAYOUT_PAD);

  return { atoms, bonds: structure.bonds, width, height, labels };
}

/**
 * The bond-length scale in pixels for a structure (used to derive the
 * vertex-match tolerance). All corpus bonds have unit length in layout space,
 * so the pixel bond length is exactly `render.scale`.
 */
export function pixelBondLength(structure: RealWorldStructure): number {
  return structure.render.scale;
}
