/**
 * FEAT-005 — image I/O helpers that bridge a crop (data URL / RGBA buffer) to
 * the pure {@link GrayImage} the deterministic pipeline consumes.
 *
 * Two entry points:
 *   - {@link grayFromRgba}            — pure; build a GrayImage from RGBA bytes
 *                                       (used in tests and after any decoder).
 *   - {@link decodeImageDataUrlToGray} — browser-only; uses createImageBitmap +
 *                                       an OffscreenCanvas / <canvas> to decode
 *                                       a PNG/SVG data URL to RGBA, then gray.
 *
 * The browser path is isolated here so the core algorithm stays environment
 * independent and jsdom-testable. Nothing here touches the network.
 */

import { rgbaToGrayscale } from "./preprocess";
import type { GrayImage } from "./types";

/** Build a {@link GrayImage} from interleaved RGBA bytes. Pure. */
export function grayFromRgba(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): GrayImage {
  return rgbaToGrayscale(rgba, width, height);
}

/** True when a DOM canvas 2D context is actually usable in this environment. */
export function canDecodeImagesInDom(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const c = document.createElement("canvas");
    const ctx = c.getContext("2d");
    return ctx !== null && typeof ctx.drawImage === "function";
  } catch {
    return false;
  }
}

/**
 * Decode a PNG/SVG data URL to a {@link GrayImage} in a browser. Rejects when no
 * usable canvas exists (e.g. jsdom) — callers in such environments should build
 * a GrayImage directly via {@link grayFromRgba}.
 *
 * `maxDimension` optionally downscales very large crops to keep the pipeline
 * fast; aspect ratio is preserved.
 */
export async function decodeImageDataUrlToGray(
  dataUrl: string,
  maxDimension = 1200,
): Promise<GrayImage> {
  if (!canDecodeImagesInDom()) {
    throw new Error("image decoding requires a DOM canvas 2D context");
  }

  const bitmap = await loadBitmap(dataUrl);
  const srcW = bitmap.width;
  const srcH = bitmap.height;
  const scale = Math.min(1, maxDimension / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable");
  // White backdrop so transparency reads as background.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap as CanvasImageSource, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  return grayFromRgba(data, w, h);
}

async function loadBitmap(
  dataUrl: string,
): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    return createImageBitmap(blob);
  }
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("failed to load image data URL"));
    img.src = dataUrl;
  });
}
