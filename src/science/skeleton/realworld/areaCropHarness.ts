/**
 * FEAT-005B §6 — DEVELOPMENT-ONLY Area-crop harness.
 *
 * This is explicitly NOT wired into the normal Identify workflow. It is a
 * standalone probe that takes an EXISTING {@link AreaAnchor} crop (the same
 * representation the rest of Ito captures) and runs carbon-skeleton
 * reconstruction on it, verifying the integration contract:
 *
 *   - an actual PNG crop (data URL) can be DECODED to pixels,
 *   - browser image processing works (via the injected decoder),
 *   - recognition does NOT modify the original crop,
 *   - the result can be VISUALISED (an SVG debug overlay is produced),
 *   - FAILURES are reported explicitly (never a silent fabricated graph).
 *
 * The decoder is injected so this harness is environment-agnostic: in a browser
 * pass {@link import("../imageIo").decodeImageDataUrlToGray}; in a Node/vitest
 * test pass a data-URL→GrayImage decoder built on {@link decodePngToGray}.
 */

import type { AreaAnchor } from "../../../model/types";
import { reconstructCarbonSkeleton } from "../carbonSkeleton";
import type { CarbonSkeletonResult, GrayImage } from "../types";
import { pipelineStages } from "./visualize";

export interface AreaCropProbeResult {
  /** Whether a usable crop image could be decoded. */
  readonly decoded: boolean;
  /** The reconstructed skeleton (always present; status carries the outcome). */
  readonly result: CarbonSkeletonResult;
  /** A self-contained SVG string visualising the reconstruction, or null. */
  readonly debugSvg: string | null;
  /** True iff the original crop's imageDataUrl was byte-for-byte unchanged. */
  readonly cropUnmodified: boolean;
  /** Explicit, human-readable outcome message. */
  readonly message: string;
}

export type DataUrlDecoder = (dataUrl: string) => Promise<GrayImage> | GrayImage;

/**
 * Run carbon-skeleton reconstruction over an Area crop. `decode` turns the
 * crop's data URL into a {@link GrayImage}. Pure w.r.t. the anchor: the crop is
 * never mutated, and we assert that explicitly.
 */
export async function probeAreaCrop(
  anchor: AreaAnchor,
  decode: DataUrlDecoder,
): Promise<AreaCropProbeResult> {
  const originalDataUrl = anchor.imageDataUrl;

  if (!originalDataUrl) {
    return {
      decoded: false,
      result: {
        atoms: [],
        bonds: [],
        cycles: [],
        connectedComponents: [],
        cycleRank: 0,
        confidence: 0,
        status: "unsupported",
        notes: ["Area anchor has no imageDataUrl crop to analyse"],
      },
      debugSvg: null,
      cropUnmodified: true,
      message: "No crop image present on this Area anchor; nothing to reconstruct.",
    };
  }

  // Snapshot the crop so we can prove recognition did not mutate it.
  const snapshot = originalDataUrl;

  let gray: GrayImage;
  try {
    gray = await decode(originalDataUrl);
  } catch (err) {
    return {
      decoded: false,
      result: {
        atoms: [],
        bonds: [],
        cycles: [],
        connectedComponents: [],
        cycleRank: 0,
        confidence: 0,
        status: "unsupported",
        notes: [`crop could not be decoded: ${(err as Error).message}`],
      },
      debugSvg: null,
      cropUnmodified: anchor.imageDataUrl === snapshot,
      message: `Crop decode failed: ${(err as Error).message}`,
    };
  }

  const result = reconstructCarbonSkeleton(gray);

  // Build a visual-debug SVG even on failure (so a human can inspect WHY).
  let debugSvg: string | null = null;
  try {
    debugSvg = buildStandaloneSvg(gray, result);
  } catch {
    debugSvg = null;
  }

  const cropUnmodified = anchor.imageDataUrl === snapshot;

  const message = explain(result, cropUnmodified);

  return { decoded: true, result, debugSvg, cropUnmodified, message };
}

function explain(result: CarbonSkeletonResult, cropUnmodified: boolean): string {
  const base =
    result.status === "success"
      ? `Reconstructed ${result.atoms.length} carbons / ${result.bonds.length} bonds (μ=${result.cycleRank}).`
      : result.status === "low-confidence"
        ? `Low-confidence reconstruction (${result.atoms.length} carbons); ${result.notes.join("; ")}.`
        : result.status === "invalid"
          ? `Invalid: ${result.notes.join("; ")}.`
          : `Unsupported crop: ${result.notes.join("; ")}.`;
  return cropUnmodified ? base : `${base} WARNING: crop was modified (contract violation).`;
}

/**
 * A minimal standalone overlay (skeleton + atoms + bonds + cycles) for the
 * harness, independent of the benchmark's ground-truth-aware visualiser.
 */
function buildStandaloneSvg(gray: GrayImage, result: CarbonSkeletonResult): string {
  const { skeleton } = pipelineStages(gray);
  const w = gray.width;
  const h = gray.height;
  const skelRects: string[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (skeleton.data[y * w + x] === 1) skelRects.push(`<rect x="${x}" y="${y}" width="1" height="1"/>`);
    }
  }
  const bonds = result.bonds
    .map((b) => {
      const a = result.atoms[b.source] as { x: number; y: number };
      const c = result.atoms[b.target] as { x: number; y: number };
      return `<line x1="${a.x}" y1="${a.y}" x2="${c.x}" y2="${c.y}" stroke="#2ca02c" stroke-width="1.5"/>`;
    })
    .join("");
  const atoms = result.atoms
    .map((a) => `<circle cx="${a.x}" cy="${a.y}" r="3" fill="${a.isJunction ? "#d62728" : "#1f77b4"}"/>`)
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="100%" height="100%" fill="white"/>` +
    `<g fill="#bbb">${skelRects.join("")}</g>` +
    bonds +
    atoms +
    `</svg>`
  );
}
