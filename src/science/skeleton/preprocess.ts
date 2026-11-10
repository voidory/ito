/**
 * FEAT-005 — deterministic preprocessing pipeline.
 *
 * Stages (each exported and independently testable):
 *   1. {@link toGrayscale}         — collapse RGBA to luminance.
 *   2. {@link otsuThreshold} /
 *      {@link thresholdBinary}     — separate ink strokes from background.
 *   3. {@link removeSmallComponents} — drop isolated noise blobs.
 *   4. {@link morphClose}/{@link morphOpen} — morphological cleanup.
 *   5. {@link zhangSuenThin}       — thin strokes to ~1px width.
 *
 * All operators are PURE (return new buffers) and dependency-free. Foreground
 * (ink) is encoded as 1, background as 0 throughout.
 */

import type { BinaryImage, GrayImage } from "./types";

/** Convert interleaved RGBA bytes (length = w*h*4) to a {@link GrayImage}. */
export function rgbaToGrayscale(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): GrayImage {
  const n = width * height;
  const data = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4] ?? 255;
    const g = rgba[i * 4 + 1] ?? 255;
    const b = rgba[i * 4 + 2] ?? 255;
    const a = rgba[i * 4 + 3] ?? 255;
    // Composite onto white so transparent pixels read as background, then
    // ITU-R BT.601 luma.
    const af = a / 255;
    const rr = r * af + 255 * (1 - af);
    const gg = g * af + 255 * (1 - af);
    const bb = b * af + 255 * (1 - af);
    data[i] = Math.round(0.299 * rr + 0.587 * gg + 0.114 * bb);
  }
  return { width, height, data };
}

/** Alias kept for readability where the source is already a gray-ish source. */
export const toGrayscale = rgbaToGrayscale;

/**
 * Compute Otsu's optimal global threshold (0..255) for a grayscale image.
 * Returns the cutoff that maximises between-class variance.
 */
export function otsuThreshold(img: GrayImage): number {
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < img.data.length; i++) {
    const v = img.data[i] as number;
    hist[v] = (hist[v] as number) + 1;
  }
  const total = img.data.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * (hist[t] as number);
  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t] as number;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * (hist[t] as number);
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      threshold = t;
    }
  }
  return threshold;
}

/**
 * Threshold a grayscale image into a {@link BinaryImage}. Pixels with luminance
 * at or below `cutoff` are foreground (dark ink on a light background). Using
 * `<=` (rather than `<`) matters for crisp, near-bimodal images where Otsu's
 * cutoff can land exactly on the ink's luminance.
 * When `cutoff` is omitted, {@link otsuThreshold} is used.
 */
export function thresholdBinary(img: GrayImage, cutoff?: number): BinaryImage {
  const t = cutoff ?? otsuThreshold(img);
  const data = new Uint8Array(img.width * img.height);
  for (let i = 0; i < data.length; i++) data[i] = (img.data[i] as number) <= t ? 1 : 0;
  return { width: img.width, height: img.height, data };
}

/** Count of foreground pixels — small helper used by guards and tests. */
export function foregroundCount(img: BinaryImage): number {
  let c = 0;
  for (let i = 0; i < img.data.length; i++) c += img.data[i] as number;
  return c;
}

/**
 * Label 8-connected foreground components. Returns a labels array (0 =
 * background, 1..n = component id) and the per-component pixel counts.
 */
export function labelComponents(img: BinaryImage): {
  labels: Int32Array;
  counts: number[];
} {
  const { width, height, data } = img;
  const labels = new Int32Array(width * height);
  const counts: number[] = [0]; // index 0 = background sentinel
  const stack: number[] = [];
  let next = 1;
  for (let start = 0; start < data.length; start++) {
    if (data[start] === 0 || labels[start] !== 0) continue;
    const id = next++;
    let count = 0;
    stack.push(start);
    labels[start] = id;
    while (stack.length > 0) {
      const p = stack.pop() as number;
      count++;
      const px = p % width;
      const py = (p - px) / width;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = px + dx;
          const ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const q = ny * width + nx;
          if (data[q] === 1 && labels[q] === 0) {
            labels[q] = id;
            stack.push(q);
          }
        }
      }
    }
    counts[id] = count;
  }
  return { labels, counts };
}

/** Remove 8-connected foreground components smaller than `minPixels`. */
export function removeSmallComponents(
  img: BinaryImage,
  minPixels: number,
): BinaryImage {
  const { labels, counts } = labelComponents(img);
  const data = new Uint8Array(img.data.length);
  for (let i = 0; i < img.data.length; i++) {
    const l = labels[i] as number;
    if (l !== 0 && (counts[l] ?? 0) >= minPixels) data[i] = 1;
  }
  return { width: img.width, height: img.height, data };
}

/** 3x3 dilation (8-connectivity). */
export function dilate(img: BinaryImage): BinaryImage {
  const { width, height, data } = img;
  const out = new Uint8Array(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let on = 0;
      for (let dy = -1; dy <= 1 && !on; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (data[ny * width + nx]) {
            on = 1;
            break;
          }
        }
      }
      out[y * width + x] = on;
    }
  }
  return { width, height, data: out };
}

/** 3x3 erosion (8-connectivity). */
export function erode(img: BinaryImage): BinaryImage {
  const { width, height, data } = img;
  const out = new Uint8Array(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let all = 1;
      for (let dy = -1; dy <= 1 && all; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          // Treat outside-image as background => border erodes.
          if (nx < 0 || ny < 0 || nx >= width || ny >= height || !data[ny * width + nx]) {
            all = 0;
            break;
          }
        }
      }
      out[y * width + x] = all;
    }
  }
  return { width, height, data: out };
}

/** Morphological close (dilate then erode) — bridges tiny gaps. */
export function morphClose(img: BinaryImage): BinaryImage {
  return erode(dilate(img));
}

/** Morphological open (erode then dilate) — removes tiny protrusions/specks. */
export function morphOpen(img: BinaryImage): BinaryImage {
  return dilate(erode(img));
}

// --- Zhang-Suen thinning ---------------------------------------------------

/** 8-neighbours of (x,y) in fixed P2..P9 order (clockwise from north). */
function neighbours8(
  data: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
): [number, number, number, number, number, number, number, number] {
  const at = (nx: number, ny: number): number => {
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) return 0;
    return data[ny * width + nx] as number;
  };
  // P2 N, P3 NE, P4 E, P5 SE, P6 S, P7 SW, P8 W, P9 NW
  return [
    at(x, y - 1),
    at(x + 1, y - 1),
    at(x + 1, y),
    at(x + 1, y + 1),
    at(x, y + 1),
    at(x - 1, y + 1),
    at(x - 1, y),
    at(x - 1, y - 1),
  ];
}

/** Number of 0->1 transitions in the ordered neighbour sequence (A(P1)). */
function transitions(
  n: readonly [number, number, number, number, number, number, number, number],
): number {
  let count = 0;
  for (let i = 0; i < 8; i++) {
    const cur = n[i] as number;
    const nxt = n[(i + 1) % 8] as number;
    if (cur === 0 && nxt === 1) count++;
  }
  return count;
}

/**
 * Zhang-Suen thinning: reduce foreground strokes to a ~1px-wide skeleton while
 * preserving connectivity and endpoints. Deterministic and idempotent once the
 * skeleton is reached.
 *
 * Reference: T. Y. Zhang and C. Y. Suen, "A fast parallel algorithm for
 * thinning digital patterns", CACM 1984.
 */
export function zhangSuenThin(img: BinaryImage): BinaryImage {
  const { width, height } = img;
  const data = new Uint8Array(img.data); // working copy, mutated in place
  let changed = true;

  const collectMarks = (subIter: 0 | 1): number[] => {
    const marks: number[] = [];
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x;
        if (data[idx] === 0) continue;
        const n = neighbours8(data, width, height, x, y);
        const [p2, p3, p4, p5, p6, p7, p8, p9] = n;
        const bp1 = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (bp1 < 2 || bp1 > 6) continue;
        if (transitions(n) !== 1) continue;
        if (subIter === 0) {
          if (p2 * p4 * p6 !== 0) continue;
          if (p4 * p6 * p8 !== 0) continue;
        } else {
          if (p2 * p4 * p8 !== 0) continue;
          if (p2 * p6 * p8 !== 0) continue;
        }
        marks.push(idx);
      }
    }
    return marks;
  };

  while (changed) {
    changed = false;
    for (const subIter of [0, 1] as const) {
      const marks = collectMarks(subIter);
      if (marks.length > 0) {
        changed = true;
        for (const idx of marks) data[idx] = 0;
      }
    }
  }
  return { width, height, data };
}

/**
 * Run the full deterministic preprocessing pipeline on a grayscale image:
 * threshold -> remove small components -> morphological close -> thin.
 * Returns the intermediate stages too so each can be inspected / tested.
 */
export function preprocess(
  gray: GrayImage,
  opts: { fixedThreshold?: number | undefined; minComponentPixels: number },
): {
  threshold: number;
  binary: BinaryImage;
  denoised: BinaryImage;
  cleaned: BinaryImage;
  skeleton: BinaryImage;
} {
  const threshold = opts.fixedThreshold ?? otsuThreshold(gray);
  const binary = thresholdBinary(gray, threshold);
  const denoised = removeSmallComponents(binary, opts.minComponentPixels);
  // Close tiny gaps from anti-aliasing before thinning; open is intentionally
  // NOT applied here because it can erase thin strokes.
  const cleaned = morphClose(denoised);
  const skeleton = zhangSuenThin(cleaned);
  return { threshold, binary, denoised, cleaned, skeleton };
}
