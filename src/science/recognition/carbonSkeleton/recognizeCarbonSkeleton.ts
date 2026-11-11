/**
 * Production MVP — `recognizeCarbonSkeleton`.
 *
 * Given a reasonably clean cropped 2D skeletal chemical structure, recognise
 * its carbon skeleton and return its basic molecular graph / topology. This is
 * a thin, bounded wrapper over the shared deterministic engine in
 * `src/science/skeleton/`. It adds exactly one thing the raw engine does not:
 * an explicit SCOPE GATE. If the reconstructed graph falls outside the small
 * class the MVP commits to (simple / branched chains and simple single rings),
 * or the engine's own confidence is too weak, the MVP fails explicitly rather
 * than returning an unreliable graph.
 *
 * Pure and deterministic: no RDKit, no Python, no network, no external APIs,
 * no research corpus. The only input is pixels.
 */

import {
  reconstructCarbonSkeleton,
  type CarbonSkeletonResult,
  type GrayImage,
  type SkeletonPipelineOptions,
} from "../../skeleton";
import type {
  CarbonSkeletonRecognition,
  RecognizedBond,
  RecognizedCarbon,
  SkeletonTopology,
} from "./types";

/** Options for the MVP recogniser. All optional; sensible defaults apply. */
export interface RecognizeCarbonSkeletonOptions {
  /**
   * Minimum engine confidence to accept a result as `success`. The engine's
   * confidence is a deterministic geometric heuristic, not a model
   * probability. Below this the MVP reports `unsupported` rather than guess.
   */
  readonly minConfidence?: number;
  /** Advanced: override the underlying engine pipeline options. */
  readonly pipeline?: Partial<SkeletonPipelineOptions>;
}

const DEFAULT_MIN_CONFIDENCE = 0.6;

/**
 * Recognise the carbon skeleton of a clean cropped skeletal structure.
 *
 * Accepts the pure {@link GrayImage} the engine consumes. In a browser, decode
 * a crop's data URL first with
 * {@link import("./recognizeCarbonSkeletonFromDataUrl").recognizeCarbonSkeletonFromDataUrl}.
 */
export function recognizeCarbonSkeleton(
  image: GrayImage,
  options: RecognizeCarbonSkeletonOptions = {},
): CarbonSkeletonRecognition {
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;

  let engine: CarbonSkeletonResult;
  try {
    engine = reconstructCarbonSkeleton(image, options.pipeline ?? {});
  } catch (err) {
    return {
      success: false,
      status: "invalid",
      confidence: 0,
      reason: `recognition engine failed: ${String(err)}`,
      notes: [],
    };
  }

  const notes = [...engine.notes];

  // 1. The engine already fails explicitly for blank / undecodable / all-noise
  //    inputs. Propagate those as the MVP's explicit failure.
  if (engine.status === "unsupported") {
    return fail("unsupported", reasonForEngineStatus(engine), 0, notes);
  }
  if (engine.atoms.length === 0 || engine.bonds.length === 0) {
    return fail(
      "invalid",
      "no connected carbon graph could be reconstructed from the image",
      engine.confidence,
      notes,
    );
  }

  // 2. SCOPE GATE — reject anything outside the MVP's bounded class.

  // 2a. A single clean structure must be one connected drawing. Multiple
  //     components means fragmentation (noise) or multiple molecules — both
  //     outside the MVP.
  if (engine.connectedComponents.length > 1) {
    return fail(
      "unsupported",
      `the image contains ${engine.connectedComponents.length} disconnected pieces; ` +
        "the MVP recognises a single connected carbon skeleton only",
      engine.confidence,
      notes,
    );
  }

  // 2b. A degree-≥4 vertex almost always means two strokes crossing, not a real
  //     single-point branch in clean skeletal notation. The MVP will not guess.
  const crossing = engine.atoms.find((a) => a.degree >= 4);
  if (crossing) {
    return fail(
      "unsupported",
      "a vertex with 4+ bonds was found (likely crossing strokes); " +
        "the MVP does not resolve crossing or overlapping bonds",
      engine.confidence,
      notes,
    );
  }

  // 2c. Fused / polycyclic / bridged ring systems are out of scope. The MVP
  //     supports acyclic or exactly-one-ring (monocyclic) structures.
  if (engine.cycleRank >= 2) {
    return fail(
      "unsupported",
      `the structure has ${engine.cycleRank} rings (fused/polycyclic); ` +
        "the MVP supports acyclic or simple single-ring structures only",
      engine.confidence,
      notes,
    );
  }

  // 3. Confidence gate — never upgrade a weak geometric reconstruction.
  if (engine.confidence < minConfidence) {
    return fail(
      "unsupported",
      `reconstruction confidence ${engine.confidence.toFixed(2)} is below the ` +
        `required ${minConfidence.toFixed(2)}; the input is too noisy or ambiguous`,
      engine.confidence,
      notes,
    );
  }

  // 4. Success — build the bounded MVP payload.
  const carbons: RecognizedCarbon[] = engine.atoms.map((a) => ({
    id: a.id,
    x: a.x,
    y: a.y,
    degree: a.degree,
    isEndpoint: a.isEndpoint,
    isBranch: a.isJunction,
    inRing: a.belongsToCycle,
  }));

  const bonds: RecognizedBond[] = engine.bonds.map((b) => ({
    source: b.source,
    target: b.target,
  }));

  const topology = buildTopology(engine);

  return {
    success: true,
    status: "success",
    confidence: engine.confidence,
    skeleton: { carbons, bonds, topology },
    notes,
  };
}

function buildTopology(engine: CarbonSkeletonResult): SkeletonTopology {
  const ringCount = engine.cycleRank;
  const hasBranch = engine.atoms.some((a) => a.degree >= 3);

  const shape: SkeletonTopology["shape"] =
    ringCount === 1 ? "monocyclic" : hasBranch ? "branched-chain" : "linear-chain";

  const ring =
    ringCount === 1 && engine.cycles.length >= 1
      ? [...(engine.cycles[0] ?? [])]
      : undefined;

  return {
    carbonCount: engine.atoms.length,
    bondCount: engine.bonds.length,
    ringCount,
    ...(ring ? { ring } : {}),
    shape,
  };
}

function reasonForEngineStatus(engine: CarbonSkeletonResult): string {
  // The engine records the specific blank/noise reason in its notes.
  return engine.notes[0] ?? "the image could not be interpreted as a skeletal structure";
}

function fail(
  status: "unsupported" | "invalid",
  reason: string,
  confidence: number,
  notes: string[],
): CarbonSkeletonRecognition {
  return { success: false, status, confidence, reason, notes };
}
