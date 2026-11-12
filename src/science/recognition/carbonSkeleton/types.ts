/**
 * Production MVP — carbon-skeleton recognition result types.
 *
 * This is the SMALL, STABLE, user-facing surface of carbon-skeleton
 * recognition. It is deliberately narrower than the research engine's
 * {@link import("../../skeleton/types").CarbonSkeletonResult}: the MVP commits
 * to a bounded class of inputs (simple/branched carbon chains and simple
 * single-ring structures) and reports an explicit failure for anything outside
 * that class, rather than surfacing an unreliable graph.
 *
 * Scope (what the MVP claims to do):
 *   - simple linear carbon chains
 *   - branched carbon chains
 *   - simple monocyclic structures
 *   - ordinary bond/vertex geometry
 *   - modest rotation / rasterisation (stroke-thickness) variation
 *
 * Explicitly OUT of scope (returns a failure, not a guess):
 *   - heteroatoms, explicit atom labels, stereochemistry, charges
 *   - aromaticity interpretation beyond the bare carbon graph
 *   - fused / polycyclic / bridged ring systems
 *   - SMILES generation, reactions, mechanisms, electron-flow arrows
 *   - full molecule identification, textbook / scanned-page OCR
 *   - sophisticated uncertainty resolution
 *
 * The underlying computer-vision + graph-theory engine lives in
 * `src/science/skeleton/` and is shared with the research benchmarks in
 * `src/science/research/skeleton/`. This module reuses that engine; it does not
 * reimplement it. No RDKit, no Python, no network, no corpus.
 */

/** A recognised carbon atom (vertex) in the reconstructed skeleton. */
export interface RecognizedCarbon {
  /** Stable id within this result (0-based). */
  readonly id: number;
  /** Pixel coordinate in the (upright) input image. */
  readonly x: number;
  readonly y: number;
  /** Number of carbon–carbon bonds incident to this carbon. */
  readonly degree: number;
  /** A chain terminus (degree 1). */
  readonly isEndpoint: boolean;
  /** A branch point (degree ≥ 3). */
  readonly isBranch: boolean;
  /** True when this carbon lies on the ring (for monocyclic inputs). */
  readonly inRing: boolean;
}

/** A recognised carbon–carbon bond (undirected; `source` < `target`). */
export interface RecognizedBond {
  readonly source: number;
  readonly target: number;
}

/**
 * Basic topology of the recognised skeleton — enough to describe the bounded
 * class the MVP supports, and no more.
 */
export interface SkeletonTopology {
  readonly carbonCount: number;
  readonly bondCount: number;
  /** Number of independent rings (cycle rank). 0 = acyclic, 1 = monocyclic. */
  readonly ringCount: number;
  /** The single ring's atom ids, when the structure is monocyclic. */
  readonly ring?: readonly number[];
  /** Coarse shape of the supported structure. */
  readonly shape: "linear-chain" | "branched-chain" | "monocyclic";
}

/**
 * Outcome status for the MVP.
 *  - `success`     — a reliable carbon graph within the supported class.
 *  - `unsupported` — the input is outside the MVP's bounded scope (e.g. fused
 *                    rings, fragmented drawing, crossing strokes, blank image).
 *                    This is an EXPLICIT failure, not a low-quality guess.
 *  - `invalid`     — drawing-like content but no coherent carbon graph.
 */
export type RecognitionStatus = "success" | "unsupported" | "invalid";

/** The successful payload. */
export interface RecognizedSkeleton {
  readonly carbons: readonly RecognizedCarbon[];
  readonly bonds: readonly RecognizedBond[];
  readonly topology: SkeletonTopology;
  /**
   * The pixel dimensions of the image the recogniser actually analysed. The
   * {@link RecognizedCarbon} `x`/`y` coordinates live in THIS space (origin
   * top-left). A UI overlay should use these as its SVG `viewBox` so the graph
   * stays geometrically aligned with the crop regardless of display size —
   * note the engine may have down-scaled a very large crop, so these are NOT
   * necessarily the `<img>`'s intrinsic/natural dimensions.
   */
  readonly imageWidth: number;
  readonly imageHeight: number;
}

/**
 * The result of {@link import("./recognizeCarbonSkeleton").recognizeCarbonSkeleton}.
 * A discriminated union on `success` so callers must handle both paths.
 */
export type CarbonSkeletonRecognition =
  | {
      readonly success: true;
      readonly status: "success";
      /** Heuristic geometric confidence in [0, 1] (NOT a model probability). */
      readonly confidence: number;
      readonly skeleton: RecognizedSkeleton;
      /** Non-fatal caveats, if any. */
      readonly notes: readonly string[];
    }
  | {
      readonly success: false;
      readonly status: "unsupported" | "invalid";
      readonly confidence: number;
      /** A single, human-readable reason the input could not be recognised. */
      readonly reason: string;
      /** Additional diagnostic notes from the engine. */
      readonly notes: readonly string[];
    };
