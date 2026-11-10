/**
 * FEAT-005B — a minimal, dependency-light PNG decoder for the REAL-WORLD
 * benchmark.
 *
 * Why this exists: the deterministic pipeline consumes a {@link GrayImage}. In a
 * browser, {@link import("../imageIo").decodeImageDataUrlToGray} uses a DOM
 * canvas to decode a PNG crop. Under vitest/jsdom there is no usable canvas 2D
 * context (`getContext` is not implemented), so to run a REPRODUCIBLE benchmark
 * over *actual PNG files* we need to decode PNG bytes to RGBA ourselves, in
 * pure JS, without a DOM.
 *
 * This decoder handles the subset of PNG that our corpus renderer emits:
 *   - 8-bit depth,
 *   - colour types 0 (grayscale), 2 (truecolour RGB), 4 (gray+alpha),
 *     6 (truecolour + alpha) and 3 (palette / indexed),
 *   - the five standard scanline filters (None/Sub/Up/Average/Paeth),
 *   - a single zlib (DEFLATE) IDAT stream, inflated with `fflate.unzlibSync`
 *     (already a project dependency — no new runtime dependency is added).
 *
 * It is NOT a general-purpose PNG decoder (no interlacing, no 16-bit, no tRNS
 * on non-palette). That is deliberate: it is a test harness for a fixed corpus,
 * not production code. It is isolated here so the core algorithm stays
 * environment-independent.
 */

import { unzlibSync } from "fflate";
import { grayFromRgba } from "../imageIo";
import type { GrayImage } from "../types";

export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  /** Interleaved RGBA, length = width * height * 4. */
  readonly rgba: Uint8ClampedArray;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] as number) << 24) |
    ((bytes[offset + 1] as number) << 16) |
    ((bytes[offset + 2] as number) << 8) |
    (bytes[offset + 3] as number)
  ) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Decode PNG bytes to RGBA. Throws on an unsupported / malformed PNG. */
export function decodePng(bytes: Uint8Array): DecodedImage {
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error("not a PNG (bad signature)");
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  const idatChunks: Uint8Array[] = [];

  let offset = 8;
  while (offset < bytes.length) {
    const length = readUint32BE(bytes, offset);
    const type = String.fromCharCode(
      bytes[offset + 4] as number,
      bytes[offset + 5] as number,
      bytes[offset + 6] as number,
      bytes[offset + 7] as number,
    );
    const dataStart = offset + 8;
    if (type === "IHDR") {
      width = readUint32BE(bytes, dataStart);
      height = readUint32BE(bytes, dataStart + 4);
      bitDepth = bytes[dataStart + 8] as number;
      colorType = bytes[dataStart + 9] as number;
      interlace = bytes[dataStart + 12] as number;
    } else if (type === "PLTE") {
      palette = bytes.slice(dataStart, dataStart + length);
    } else if (type === "IDAT") {
      idatChunks.push(bytes.slice(dataStart, dataStart + length));
    } else if (type === "IEND") {
      break;
    }
    offset = dataStart + length + 4; // skip data + CRC
  }

  if (bitDepth !== 8) {
    throw new Error(`unsupported PNG bit depth ${bitDepth} (only 8 supported)`);
  }
  if (interlace !== 0) throw new Error("interlaced PNG is not supported");

  const channelsByColorType: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsByColorType[colorType];
  if (channels === undefined) {
    throw new Error(`unsupported PNG colour type ${colorType}`);
  }

  // Concatenate IDAT chunks and inflate (PNG wraps DEFLATE in a zlib stream).
  let total = 0;
  for (const c of idatChunks) total += c.length;
  const zlibData = new Uint8Array(total);
  let pos = 0;
  for (const c of idatChunks) {
    zlibData.set(c, pos);
    pos += c.length;
  }
  const raw = unzlibSync(zlibData);

  const bytesPerPixel = channels; // 8-bit depth => 1 byte per channel
  const stride = width * bytesPerPixel;
  const unfiltered = new Uint8Array(height * stride);

  // Reverse the per-scanline PNG filters.
  for (let y = 0; y < height; y++) {
    const filterType = raw[y * (stride + 1)] as number;
    const inRow = y * (stride + 1) + 1;
    const outRow = y * stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[inRow + x] as number;
      const a = x >= bytesPerPixel ? (unfiltered[outRow + x - bytesPerPixel] as number) : 0;
      const b = y > 0 ? (unfiltered[outRow - stride + x] as number) : 0;
      const c =
        y > 0 && x >= bytesPerPixel
          ? (unfiltered[outRow - stride + x - bytesPerPixel] as number)
          : 0;
      let value: number;
      switch (filterType) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = rawByte + a;
          break;
        case 2:
          value = rawByte + b;
          break;
        case 3:
          value = rawByte + ((a + b) >> 1);
          break;
        case 4:
          value = rawByte + paeth(a, b, c);
          break;
        default:
          throw new Error(`unsupported PNG filter ${filterType}`);
      }
      unfiltered[outRow + x] = value & 0xff;
    }
  }

  // Expand to RGBA.
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const src = i * bytesPerPixel;
    let r: number;
    let g: number;
    let bch: number;
    let a = 255;
    if (colorType === 0) {
      r = g = bch = unfiltered[src] as number;
    } else if (colorType === 2) {
      r = unfiltered[src] as number;
      g = unfiltered[src + 1] as number;
      bch = unfiltered[src + 2] as number;
    } else if (colorType === 4) {
      r = g = bch = unfiltered[src] as number;
      a = unfiltered[src + 1] as number;
    } else if (colorType === 6) {
      r = unfiltered[src] as number;
      g = unfiltered[src + 1] as number;
      bch = unfiltered[src + 2] as number;
      a = unfiltered[src + 3] as number;
    } else {
      // Palette (colour type 3).
      const idx = (unfiltered[src] as number) * 3;
      const pal = palette as Uint8Array;
      r = pal[idx] as number;
      g = pal[idx + 1] as number;
      bch = pal[idx + 2] as number;
    }
    const d = i * 4;
    rgba[d] = r;
    rgba[d + 1] = g;
    rgba[d + 2] = bch;
    rgba[d + 3] = a;
  }

  return { width, height, rgba };
}

/** Decode PNG bytes directly to the {@link GrayImage} the pipeline consumes. */
export function decodePngToGray(bytes: Uint8Array): GrayImage {
  const { width, height, rgba } = decodePng(bytes);
  return grayFromRgba(rgba, width, height);
}
