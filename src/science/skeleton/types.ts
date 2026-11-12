/**
 * FEAT-005 (M19) — Deterministic carbon-skeleton reconstruction types.
 *
 * This module is a STANDALONE, deterministic computer-vision + graph-theory
 * pipeline that reconstructs the carbon skeleton of a conventional skeletal
 * organic structure from a clean image crop. It is intentionally INDEPENDENT
 * of the existing M18 recognition rendering pipeline (`scienceOcr`,
 * `chemistryValidation`, `chemGraph`): it produces a geometric carbon graph,
 * NOT SMILES. No external AI, no network, no cloud inference.
 *
 * Scope of this milestone (deliberately restricted):
 *   - Carbon endpoints, line-angle vertices, branch junctions.
 *   - Open / branched carbon chains.
 *   - Simple rings, ring substituents, fused / connected ring systems.
 *
 * Explicitly OUT of scope (later milestones): heteroatoms, functional groups,
 * bond orders, charges, stereochemistry, SMILES generation.
 *
 * The pipeline stages are kept independently testable:
 *   image -> {@link GrayImage} (imageIo)
 *         -> {@link BinaryImage} (preprocess: grayscale/threshold/denoise/morph)
 *         -> skeleton {@link BinaryImage} (Zhang-Suen thinning)
 *         -> {@link GeometricGraph} (graph extraction + simplification)
 *         -> {@link CarbonSkeletonResult} (reconstruction + ring/branch detection)
 */

/** A single-channel (grayscale) image. `data[y * width + x]` in 0..255. */
export interface GrayImage {
  readonly width: number;
  readonly height: number;
  /** Row-major luminance, one byte (0..255) per pixel. */
  readonly data: Uint8ClampedArray;
}

/**
 * A binary image. `data[y * width + x]` is 1 for a FOREGROUND (drawing-stroke)
 * pixel and 0 for background. Keeping foreground = 1 makes the morphology /
 * thinning operators read naturally.
 */
export interface BinaryImage {
  readonly width: number;
  readonly height: number;
  /** Row-major: 1 = foreground stroke, 0 = background. */
  readonly data: Uint8Array;
}

/** A 2D point in image pixel coordinates (origin top-left, y down). */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * The geometric graph extracted from a line skeleton, BEFORE chemical
 * interpretation. Vertices are the skeleton's topologically significant
 * points (endpoints, junctions) plus genuine line-angle corners recovered by
 * polyline simplification; edges are the traced stroke paths between them.
 */
export interface GeometricGraph {
  readonly vertices: readonly GeometricVertex[];
  readonly edges: readonly GeometricEdge[];
}

/** A node in the {@link GeometricGraph}. */
export interface GeometricVertex {
  readonly id: number;
  /** Pixel coordinate of the vertex (sub-pixel from averaging/fit). */
  readonly x: number;
  readonly y: number;
  /** Number of incident edges (filled during graph assembly). */
  readonly degree: number;
  /** Raw skeleton classification before line-angle recovery. */
  readonly kind: "endpoint" | "junction" | "corner";
}

/** A connection in the {@link GeometricGraph}. */
export interface GeometricEdge {
  readonly source: number;
  readonly target: number;
  /** The simplified polyline path of skeleton pixels for this edge. */
  readonly path: readonly Point[];
  /** Euclidean length of the (simplified) path, in pixels. */
  readonly length: number;
}

/** A reconstructed carbon atom. */
export interface CarbonAtom {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  /** Number of carbon-carbon bonds incident to this atom. */
  readonly degree: number;
  readonly isEndpoint: boolean;
  readonly isJunction: boolean;
  /** True when this atom participates in at least one ring (cycle). */
  readonly belongsToCycle: boolean;
}

/** A reconstructed carbon-carbon bond (undirected; source < target). */
export interface CarbonBond {
  readonly source: number;
  readonly target: number;
}

/**
 * Outcome status, mirroring the M18 {@link RecognitionStatus} conventions:
 *  - `success`        — a chemically meaningful carbon graph was reconstructed.
 *  - `low-confidence` — a graph was reconstructed but geometric evidence was weak.
 *  - `invalid`        — the input had drawing-like content but no coherent graph.
 *  - `unsupported`    — the input is empty / blank / could not be decoded.
 */
export type CarbonSkeletonStatus =
  | "success"
  | "low-confidence"
  | "invalid"
  | "unsupported";

/**
 * The reconstructed carbon skeleton. This is the immediate output of the
 * milestone — a carbon graph, NOT a SMILES string.
 */
export interface CarbonSkeletonResult {
  readonly atoms: readonly CarbonAtom[];
  readonly bonds: readonly CarbonBond[];
  /**
   * The ring systems found by graph cycle analysis: each entry is the ordered
   * list of atom ids forming one ring of the minimum cycle basis.
   */
  readonly cycles: readonly (readonly number[])[];
  /** Connected components, each a list of atom ids. */
  readonly connectedComponents: readonly (readonly number[])[];
  /** Cycle rank (first Betti number) μ = E − V + C. */
  readonly cycleRank: number;
  /** Heuristic confidence in [0, 1] (geometric, not a model probability). */
  readonly confidence: number;
  readonly status: CarbonSkeletonStatus;
  /** Human-readable notes: failure reasons, caveats, detected artefacts. */
  readonly notes: readonly string[];
}

/** Tunable thresholds for the whole pipeline. Exposed for testing / docs. */
export interface SkeletonPipelineOptions {
  /**
   * Otsu threshold is used by default; set a fixed 0..255 cutoff to override.
   * Pixels darker than the cutoff are treated as foreground (ink on light bg).
   */
  readonly fixedThreshold?: number;
  /** Connected foreground components with fewer pixels than this are removed. */
  readonly minComponentPixels: number;
  /**
   * Douglas-Peucker tolerance (pixels) for simplifying a traced stroke into a
   * polyline. Larger = fewer spurious corners. Scaled by stroke length too.
   */
  readonly simplifyTolerance: number;
  /**
   * Minimum turn angle (degrees) at an interior polyline point for it to count
   * as a genuine line-angle carbon vertex rather than curvature / noise.
   */
  readonly minCornerAngleDeg: number;
  /**
   * Vertices closer than this (pixels) are merged — prevents one corner /
   * junction being counted several times from neighbouring skeleton pixels /
   * anti-aliasing jitter. MUST be kept well below the bond length so that
   * genuinely distinct carbons are never merged; the extractor additionally
   * caps the effective radius at a fraction of the median bond length.
   */
  readonly mergeRadius: number;
  /**
   * Minimum edge length (pixels) for a bond to be kept. Guards against spur
   * fragments left by thinning. Scaled relative to the median bond length.
   */
  readonly minEdgeLength: number;
}

/** Default pipeline options, tuned for clean ~hundreds-of-pixels crops. */
export const DEFAULT_PIPELINE_OPTIONS: SkeletonPipelineOptions = {
  minComponentPixels: 12,
  simplifyTolerance: 2.2,
  minCornerAngleDeg: 24,
  mergeRadius: 4,
  minEdgeLength: 6,
};
