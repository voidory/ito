/**
 * Scanned-page highlighting: turn a pointer drag over a page that has no
 * selectable text under it into line-shaped highlight strips.
 *
 * A scanned PDF page is a single image, so there is no text layer to select
 * and a Highlight/Underline drag used to do nothing. Here the drag is resolved
 * against the page raster itself:
 *
 *  - INK MODE. With the page's pixels available, dark pixels (luminance below
 *    {@link SCANNED_INK_LUMA_THRESHOLD}) are counted per pixel row around the
 *    drag. The runs of inked rows are the printed text lines, and the strips
 *    snap to them: a drag along one line is trimmed to the dragged x-range at
 *    that line's exact ink height; a drag across several lines flows like a
 *    text selection (first line from the start point to the line's right ink
 *    margin, whole middle lines, last line from its left ink margin to the end
 *    point).
 *  - GEOMETRIC MODE. Without pixels (no canvas backend, an unreadable canvas),
 *    or where the dragged region has no line structure (blank paper, a
 *    photograph, a solid block), the drag is decomposed into strips of a
 *    standard reading line height ({@link SCANNED_LINE_HEIGHT_NORM}).
 *
 * Everything is in NORMALIZED page coordinates (0..1 of the page stage) so the
 * result can be stored on a `TextAnchor` exactly like native text rects.
 * {@link analyzeScannedDrag} and {@link detectScannedLineRects} are pure.
 */

import type { NormalizedRect } from "../model";
import { isOcrPlaceholderSpan } from "./textCache";

/** Standard reading line height, as a fraction of the page height. */
export const SCANNED_LINE_HEIGHT_NORM = 0.022;
/** Pixels darker than this luminance (0..255) are ink. */
export const SCANNED_INK_LUMA_THRESHOLD = 200;
/** The quote stored for a scanned highlight that has no recognized text. */
export const SCANNED_PASSAGE_TEXT = "[Scanned passage]";

/** Strips narrower than this fraction of the page width are dropped. */
const MIN_STRIP_WIDTH_NORM = 0.004;
/** An inked run taller than this is a figure or a solid block, not a line. */
const MAX_TEXT_ROW_NORM = 0.07;
/** An inked run shorter than this is a speck, a rule or a row of i-dots. */
const MIN_TEXT_ROW_NORM = 0.004;
/** A blank run of columns wider than this separates two text blocks. */
const GUTTER_NORM = 0.018;
/** A row needs ink in at least this fraction of the block's columns. */
const MIN_ROW_INK_FRACTION = 0.003;

/** The slice of `ImageData` this module reads: RGBA, row-major. */
export interface ScannedImageData {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

export interface NormPoint {
  readonly x: number;
  readonly y: number;
}

export interface ScannedLineDetection {
  readonly rects: NormalizedRect[];
  /** `ink` when the strips were snapped to detected text rows. */
  readonly mode: "ink" | "geometric";
}

export interface ScannedDragOptions {
  /**
   * When the pointer ran along the leading BETWEEN two printed rows, snap to
   * the nearer one (default). Turn off to accept only rows the drag actually
   * crossed, which is what a page with its own text layer wants: there the
   * nearby row is usually real, selectable text the pointer deliberately missed.
   */
  readonly snapToNearestRow?: boolean;
}

/** A detected printed text row: pixel rows `[top, bottom)`. */
interface InkRow {
  readonly top: number;
  readonly bottom: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function clampInt(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * The two ends of a drag in READING order: the upper point first, and for a
 * drag that stays on one line the left point first.
 */
function readingOrder(
  dragBoxNorm: NormalizedRect,
  startNorm: NormPoint | undefined,
  endNorm: NormPoint | undefined,
): { from: NormPoint; to: NormPoint; left: number; right: number } {
  const a = startNorm ?? { x: dragBoxNorm.x, y: dragBoxNorm.y };
  const b = endNorm ?? {
    x: dragBoxNorm.x + dragBoxNorm.width,
    y: dragBoxNorm.y + dragBoxNorm.height,
  };
  const p = { x: clamp01(a.x), y: clamp01(a.y) };
  const q = { x: clamp01(b.x), y: clamp01(b.y) };
  const [from, to] = p.y <= q.y ? [p, q] : [q, p];
  // The swept box can be wider than the two end points (the pointer went out
  // to a line end and came back); it is what stands in for the text margins.
  const boxLeft = clamp01(dragBoxNorm.x);
  const boxRight = clamp01(dragBoxNorm.x + dragBoxNorm.width);
  return {
    from,
    to,
    left: Math.min(from.x, to.x, boxLeft),
    right: Math.max(from.x, to.x, boxRight),
  };
}

/**
 * Geometric fallback: decompose the drag into strips one standard line high.
 * A drag that stays within half a line is ONE strip trimmed to the dragged
 * x-range; a taller drag becomes evenly pitched strips that flow like a text
 * selection between the swept left and right extents.
 */
function geometricLineRects(
  dragBoxNorm: NormalizedRect,
  startNorm: NormPoint | undefined,
  endNorm: NormPoint | undefined,
): NormalizedRect[] {
  const { from, to, left, right } = readingOrder(dragBoxNorm, startNorm, endNorm);
  const lineH = SCANNED_LINE_HEIGHT_NORM;
  const span = to.y - from.y;
  const strip = (x0: number, x1: number, centerY: number, height: number): NormalizedRect | null => {
    const x = Math.min(x0, x1);
    const width = Math.abs(x1 - x0);
    if (width < MIN_STRIP_WIDTH_NORM) return null;
    const y = clamp01(Math.min(centerY - height / 2, 1 - height));
    return { x, y, width, height };
  };

  if (span < lineH / 2) {
    const one = strip(from.x, to.x, (from.y + to.y) / 2, lineH);
    return one ? [one] : [];
  }

  const count = Math.max(2, Math.round(span / lineH) + 1);
  const pitch = span / (count - 1);
  const height = Math.min(lineH, pitch);
  const out: NormalizedRect[] = [];
  for (let i = 0; i < count; i++) {
    const centerY = from.y + pitch * i;
    // First line runs from the start point to the right extent, last line from
    // the left extent to the end point. Two bare end points carry no margin
    // information, so a degenerate first/last strip falls back to the extents.
    const flow =
      i === 0
        ? strip(from.x, right, centerY, height)
        : i === count - 1
          ? strip(left, to.x, centerY, height)
          : null;
    const rect = flow ?? strip(left, right, centerY, height);
    if (rect) out.push(rect);
  }
  return out;
}

/** True when the pixel at byte offset `i` reads as ink over white paper. */
function isInk(data: Uint8ClampedArray, i: number): boolean {
  const alpha = (data[i + 3] ?? 255) / 255;
  if (alpha === 0) return false;
  const luma = 0.299 * (data[i] ?? 255) + 0.587 * (data[i + 1] ?? 255) + 0.114 * (data[i + 2] ?? 255);
  return luma * alpha + 255 * (1 - alpha) < SCANNED_INK_LUMA_THRESHOLD;
}

/** True when any pixel of rows `[top, bottom)` x columns `[left, right]` is ink. */
function regionHasInk(
  image: ScannedImageData,
  top: number,
  bottom: number,
  left: number,
  right: number,
): boolean {
  const { data, width } = image;
  for (let y = top; y < bottom; y++) {
    const rowStart = y * width;
    for (let x = left; x <= right; x++) {
      if (isInk(data, (rowStart + x) * 4)) return true;
    }
  }
  return false;
}

/**
 * Grow `[seedLeft, seedRight]` outwards over the columns that hold ink in the
 * pixel rows `[top, bottom)`, stopping at the first blank run wider than a
 * gutter. The result is the text block (column) the drag is in.
 */
function blockExtent(
  image: ScannedImageData,
  top: number,
  bottom: number,
  seedLeft: number,
  seedRight: number,
): { left: number; right: number } {
  const { data, width } = image;
  const gutter = Math.max(4, Math.round(GUTTER_NORM * width));
  const columnHasInk = (x: number): boolean => {
    for (let y = top; y < bottom; y++) {
      if (isInk(data, (y * width + x) * 4)) return true;
    }
    return false;
  };
  let left = seedLeft;
  for (let x = seedLeft - 1, blank = 0; x >= 0 && blank <= gutter; x--) {
    if (columnHasInk(x)) {
      left = x;
      blank = 0;
    } else {
      blank++;
    }
  }
  let right = seedRight;
  for (let x = seedRight + 1, blank = 0; x < width && blank <= gutter; x++) {
    if (columnHasInk(x)) {
      right = x;
      blank = 0;
    } else {
      blank++;
    }
  }
  return { left, right };
}

/**
 * The printed text rows around pixel rows `[top, bottom)` within the columns
 * `[left, right]`: maximal runs of rows whose ink count clears the noise
 * floor. A run cut by either edge of the window is followed out to its real
 * end (for at most `reach` rows), so a row is always reported whole. Runs too
 * short to be a line are absorbed into a touching neighbour (a row of i-dots,
 * an accent) or dropped (a speck, a ruled line).
 */
function inkRows(
  image: ScannedImageData,
  top: number,
  bottom: number,
  left: number,
  right: number,
  reach: number,
): InkRow[] {
  const { data, width, height } = image;
  const minInk = Math.max(1, Math.floor((right - left + 1) * MIN_ROW_INK_FRACTION));
  const rowHasInk = (y: number): boolean => {
    let ink = 0;
    const rowStart = y * width;
    for (let x = left; x <= right; x++) {
      if (isInk(data, (rowStart + x) * 4) && ++ink >= minInk) return true;
    }
    return false;
  };

  let from = top;
  if (rowHasInk(from)) {
    while (from > 0 && top - from < reach && rowHasInk(from - 1)) from--;
  }
  let to = bottom;
  if (rowHasInk(to - 1)) {
    while (to < height && to - bottom < reach && rowHasInk(to)) to++;
  }

  const runs: InkRow[] = [];
  let runTop = -1;
  for (let y = from; y <= to; y++) {
    if (y < to && rowHasInk(y)) {
      if (runTop < 0) runTop = y;
    } else if (runTop >= 0) {
      runs.push({ top: runTop, bottom: y });
      runTop = -1;
    }
  }

  const minRow = Math.max(2, Math.round(MIN_TEXT_ROW_NORM * height));
  const joinGap = Math.max(1, Math.round(0.002 * height));
  const rows: InkRow[] = [];
  for (const run of runs) {
    const previous = rows[rows.length - 1];
    const thin = run.bottom - run.top < minRow;
    const previousThin = previous ? previous.bottom - previous.top < minRow : false;
    if (previous && (thin || previousThin) && run.top - previous.bottom <= joinGap) {
      rows[rows.length - 1] = { top: previous.top, bottom: run.bottom };
    } else {
      rows.push(run);
    }
  }
  return rows.filter((row) => row.bottom - row.top >= minRow);
}

/** Leftmost / rightmost inked column of a row within `[left, right]`. */
function rowInkExtent(
  image: ScannedImageData,
  row: InkRow,
  left: number,
  right: number,
): { left: number; right: number } | null {
  const { data, width } = image;
  const columnHasInk = (x: number): boolean => {
    for (let y = row.top; y < row.bottom; y++) {
      if (isInk(data, (y * width + x) * 4)) return true;
    }
    return false;
  };
  let inkLeft = -1;
  for (let x = left; x <= right; x++) {
    if (columnHasInk(x)) {
      inkLeft = x;
      break;
    }
  }
  if (inkLeft < 0) return null;
  let inkRight = inkLeft;
  for (let x = right; x > inkLeft; x--) {
    if (columnHasInk(x)) {
      inkRight = x;
      break;
    }
  }
  return { left: inkLeft, right: inkRight };
}

/** Ink-mode strips for a drag, or null when the region has no line structure. */
function inkLineRects(
  image: ScannedImageData,
  dragBoxNorm: NormalizedRect,
  startNorm: NormPoint | undefined,
  endNorm: NormPoint | undefined,
  options: ScannedDragOptions,
): NormalizedRect[] | null {
  const { width, height } = image;
  const { from, to, left, right } = readingOrder(dragBoxNorm, startNorm, endNorm);
  const yTop = clampInt(Math.floor(from.y * height), 0, height - 1);
  const yBottom = clampInt(Math.ceil(to.y * height), yTop + 1, height);
  const linePx = Math.max(2, Math.round(SCANNED_LINE_HEIGHT_NORM * height));

  // Look one line beyond the drag so a row the pointer only clipped is found
  // whole, then find the text block and its rows.
  const searchTop = Math.max(0, yTop - linePx);
  const searchBottom = Math.min(height, yBottom + linePx);
  const seedLeft = clampInt(Math.floor(left * width), 0, width - 1);
  const seedRight = clampInt(Math.ceil(right * width) - 1, seedLeft, width - 1);
  const bandTop = Math.max(0, yTop - (linePx >> 1));
  const bandBottom = Math.min(height, yBottom + (linePx >> 1));
  // The drag has to be OVER ink. A sweep through blank paper beside a text
  // block must not borrow that block's rows and paint the margin.
  if (!regionHasInk(image, bandTop, bandBottom, seedLeft, seedRight)) return null;
  const block = blockExtent(image, bandTop, bandBottom, seedLeft, seedRight);
  // A "row" taller than this is a figure or a solid block: uniform density,
  // not printed lines.
  const maxRow = Math.max(linePx, Math.round(MAX_TEXT_ROW_NORM * height));
  const rows = inkRows(image, searchTop, searchBottom, block.left, block.right, maxRow + 1);
  if (rows.length === 0) return null;

  let selected = rows.filter((row) => row.bottom > yTop && row.top < yBottom);
  if (selected.length === 0) {
    // The pointer ran along the leading between two rows: take the nearer one
    // if it is close (about a third of a line).
    if (options.snapToNearestRow === false) return null;
    const mid = (yTop + yBottom) / 2;
    const distance = (row: InkRow): number =>
      mid < row.top ? row.top - mid : mid > row.bottom ? mid - row.bottom : 0;
    const nearest = rows.reduce((best, row) => (distance(row) < distance(best) ? row : best));
    if (distance(nearest) > Math.max(2, linePx * 0.3)) return null;
    selected = [nearest];
  }
  if (selected.some((row) => row.bottom - row.top > maxRow)) return null;

  const rect = (x0: number, x1: number, row: InkRow): NormalizedRect | null => {
    if (x1 - x0 < MIN_STRIP_WIDTH_NORM) return null;
    return {
      x: x0,
      y: row.top / height,
      width: x1 - x0,
      height: (row.bottom - row.top) / height,
    };
  };

  if (selected.length === 1) {
    const one = rect(Math.min(from.x, to.x), Math.max(from.x, to.x), selected[0]!);
    return one ? [one] : [];
  }

  const out: NormalizedRect[] = [];
  selected.forEach((row, i) => {
    const ink = rowInkExtent(image, row, block.left, block.right);
    if (!ink) return;
    const inkLeft = ink.left / width;
    const inkRight = (ink.right + 1) / width;
    const strip =
      i === 0
        ? rect(Math.max(from.x, inkLeft), inkRight, row)
        : i === selected.length - 1
          ? rect(inkLeft, Math.min(to.x, inkRight), row)
          : rect(inkLeft, inkRight, row);
    if (strip) out.push(strip);
  });
  return out;
}

/**
 * Resolve a drag on a scanned page into highlight strips, reporting whether
 * they were snapped to detected ink rows or laid out geometrically.
 *
 * `imageData` must cover the WHOLE page (normalized coordinates are mapped
 * onto its full width/height). `dragBoxNorm` is the box the pointer swept;
 * `startNorm` / `endNorm` are where the drag began and where it is now, and
 * default to the box's top-left and bottom-right corners.
 */
export function analyzeScannedDrag(
  dragBoxNorm: NormalizedRect,
  imageData?: ScannedImageData | null,
  startNorm?: NormPoint,
  endNorm?: NormPoint,
  options: ScannedDragOptions = {},
): ScannedLineDetection {
  const usable =
    imageData != null &&
    imageData.width > 0 &&
    imageData.height > 0 &&
    imageData.data.length >= imageData.width * imageData.height * 4;
  if (usable) {
    const rects = inkLineRects(imageData, dragBoxNorm, startNorm, endNorm, options);
    if (rects) return { rects, mode: "ink" };
  }
  return { rects: geometricLineRects(dragBoxNorm, startNorm, endNorm), mode: "geometric" };
}

/**
 * The highlight strips for a drag on a scanned page (see
 * {@link analyzeScannedDrag}). Pure; always returns line-shaped strips for a
 * drag wider than a sliver, with or without page pixels.
 */
export function detectScannedLineRects(
  dragBoxNorm: NormalizedRect,
  imageData?: ScannedImageData | null,
  startNorm?: NormPoint,
  endNorm?: NormPoint,
): NormalizedRect[] {
  return analyzeScannedDrag(dragBoxNorm, imageData, startNorm, endNorm).rects;
}

/**
 * Read a rendered page `<canvas>` into a whole-page RGBA buffer for
 * {@link analyzeScannedDrag}, downsampled to at most `maxWidth` pixels wide
 * (row detection needs line structure, not print resolution). Returns null
 * when the canvas is empty or cannot be read (jsdom has no 2d backend), which
 * sends the caller down the geometric path.
 */
export function captureCanvasImageData(
  canvas: HTMLCanvasElement | null | undefined,
  maxWidth = 1400,
): ScannedImageData | null {
  if (!canvas || canvas.width <= 0 || canvas.height <= 0) return null;
  try {
    const scale = Math.min(1, maxWidth / canvas.width);
    const width = Math.max(1, Math.round(canvas.width * scale));
    const height = Math.max(1, Math.round(canvas.height * scale));
    const scratch = document.createElement("canvas");
    scratch.width = width;
    scratch.height = height;
    const ctx = scratch.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(canvas, 0, 0, width, height);
    const image = ctx.getImageData(0, 0, width, height);
    return { data: image.data, width: image.width, height: image.height };
  } catch {
    return null;
  }
}

/**
 * Recognized text lying under a set of scanned strips: the text of every
 * `.textLayer` span that carries real (non-placeholder) OCR text and whose
 * `data-norm-rect` centre falls inside a strip. Empty when the page has no
 * recognized text there, in which case the caller stores
 * {@link SCANNED_PASSAGE_TEXT}.
 */
export function ocrTextInRects(
  textLayer: HTMLElement,
  rects: readonly NormalizedRect[],
): string {
  const parts: string[] = [];
  for (const span of Array.from(textLayer.querySelectorAll<HTMLElement>("span[data-norm-rect]"))) {
    if (isOcrPlaceholderSpan(span)) continue;
    const text = (span.textContent ?? "").trim();
    if (!text) continue;
    const box = (span.getAttribute("data-norm-rect") ?? "").split(",").map(Number);
    if (box.length !== 4 || box.some((v) => !Number.isFinite(v))) continue;
    const cx = box[0]! + box[2]! / 2;
    const cy = box[1]! + box[3]! / 2;
    if (rects.some((r) => cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height)) {
      parts.push(text);
    }
  }
  return parts.join(" ");
}
