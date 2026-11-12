/**
 * FEAT-005 — a tiny, pure, deterministic line rasterizer.
 *
 * It draws straight anti-aliased-ish strokes between 2D points onto a grayscale
 * canvas, so test fixtures (skeletal structures defined as atom coordinates +
 * bonds) can be rasterised to a {@link GrayImage} WITHOUT a DOM canvas. This
 * keeps the whole pipeline testable under jsdom / Node and fully reproducible.
 *
 * Strokes are dark (low luminance) on a white (255) background, matching the
 * "dark ink on light paper" convention the preprocessor expects. We draw a
 * filled disc of the given radius along each segment (Bresenham-ish sampling),
 * giving ~2*radius+1 px wide lines that the thinning stage reduces back to 1px.
 */

import type { GrayImage, Point } from "./types";

export interface RasterStyle {
  /** Stroke half-width in pixels (line is ~2*radius+1 wide). Default 1.6. */
  readonly radius?: number;
  /** Ink luminance (0 = black). Default 20. */
  readonly ink?: number;
  /** Background luminance (255 = white). Default 255. */
  readonly background?: number;
  /** Optional light Gaussian-ish blur radius to mimic anti-aliasing. */
  readonly antialias?: boolean;
}

/** A line segment between two points. */
export interface Segment {
  readonly from: Point;
  readonly to: Point;
}

/**
 * Rasterise a set of line segments onto a new {@link GrayImage}. Pure: returns
 * a fresh buffer, mutating nothing.
 */
export function rasterizeSegments(
  width: number,
  height: number,
  segments: readonly Segment[],
  style: RasterStyle = {},
): GrayImage {
  const radius = style.radius ?? 1.6;
  const ink = style.ink ?? 20;
  const bg = style.background ?? 255;
  const data = new Uint8ClampedArray(width * height).fill(bg);

  const stamp = (cx: number, cy: number): void => {
    const r = Math.ceil(radius);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const px = Math.round(cx) + dx;
        const py = Math.round(cy) + dy;
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        const d = Math.hypot(dx, dy);
        if (d > radius + 0.5) continue;
        // Solid core; softened rim when antialias requested.
        let value = ink;
        if (style.antialias && d > radius - 0.5) {
          const t = Math.min(1, d - (radius - 0.5));
          value = Math.round(ink * (1 - t) + bg * t);
        }
        const i = py * width + px;
        if (value < (data[i] as number)) data[i] = value;
      }
    }
  };

  for (const seg of segments) {
    const { from, to } = seg;
    const len = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.ceil(len * 2));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      stamp(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    }
  }

  return { width, height, data: data };
}
