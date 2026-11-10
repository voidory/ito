/**
 * FEAT-005 — carbon-skeleton reconstruction.
 *
 * Interprets a {@link GeometricGraph} under conventional skeletal-notation
 * rules and produces a {@link CarbonSkeletonResult}:
 *   - every unlabelled endpoint, line-angle vertex and junction is a carbon;
 *   - every line between two vertices is a carbon-carbon bond;
 *   - all branches are traced; ring detection does not stop tracing.
 *
 * It then runs the graph analysis (components, cycle rank, cycle basis) and
 * annotates each atom with degree / endpoint / junction / cycle membership.
 *
 * Also provides {@link reconstructCarbonSkeleton}, the full image->result
 * pipeline (preprocess -> extract -> reconstruct).
 */

import {
  connectedComponents,
  cycleRank,
  dedupeEdges,
  degrees,
  minimumCycleBasis,
  verticesInCycles,
  type Edge,
} from "./graphAnalysis";
import { extractGeometricGraph } from "./graphExtraction";
import { preprocess } from "./preprocess";
import {
  DEFAULT_PIPELINE_OPTIONS,
  type CarbonAtom,
  type CarbonBond,
  type CarbonSkeletonResult,
  type CarbonSkeletonStatus,
  type GeometricGraph,
  type GrayImage,
  type SkeletonPipelineOptions,
} from "./types";

/**
 * Convert a geometric graph into a carbon skeleton. Each geometric vertex
 * becomes a carbon atom; each geometric edge becomes a carbon-carbon bond.
 */
export function geometricGraphToCarbonSkeleton(
  graph: GeometricGraph,
  notes: string[] = [],
): CarbonSkeletonResult {
  const vertexCount = graph.vertices.length;

  if (vertexCount === 0) {
    return {
      atoms: [],
      bonds: [],
      cycles: [],
      connectedComponents: [],
      cycleRank: 0,
      confidence: 0,
      status: "unsupported",
      notes: [...notes, "no vertices were extracted from the skeleton"],
    };
  }

  const edges: Edge[] = dedupeEdges(
    graph.edges.map((e) => ({ a: e.source, b: e.target })),
  );

  const bonds: CarbonBond[] = edges.map((e) => ({
    source: Math.min(e.a, e.b),
    target: Math.max(e.a, e.b),
  }));

  const deg = degrees(vertexCount, edges);
  const inCycle = verticesInCycles(vertexCount, edges);
  const cycles = minimumCycleBasis(vertexCount, edges);
  const components = connectedComponents(vertexCount, edges);
  const rank = cycleRank(vertexCount, edges);

  const atoms: CarbonAtom[] = graph.vertices.map((v) => {
    const d = deg[v.id] ?? 0;
    return {
      id: v.id,
      x: round2(v.x),
      y: round2(v.y),
      degree: d,
      isEndpoint: d === 1,
      isJunction: d >= 3,
      belongsToCycle: inCycle.has(v.id),
    };
  });

  const { status, confidence, statusNotes } = assess(atoms, bonds, components.length);

  return {
    atoms,
    bonds,
    cycles,
    connectedComponents: components,
    cycleRank: rank,
    confidence,
    status,
    notes: [...notes, ...statusNotes],
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Derive a status + heuristic confidence from the reconstructed graph. This is
 * deterministic and geometric — NOT a model probability. It never silently
 * upgrades a weak reconstruction.
 */
function assess(
  atoms: readonly CarbonAtom[],
  bonds: readonly CarbonBond[],
  componentCount: number,
): { status: CarbonSkeletonStatus; confidence: number; statusNotes: string[] } {
  const notes: string[] = [];
  const V = atoms.length;
  const E = bonds.length;

  if (V === 0) {
    return { status: "unsupported", confidence: 0, statusNotes: ["empty graph"] };
  }
  if (E === 0) {
    // Isolated vertices with no bonds is not a meaningful carbon skeleton.
    return {
      status: "invalid",
      confidence: 0.1,
      statusNotes: ["vertices found but no carbon-carbon bonds were reconstructed"],
    };
  }

  let confidence = 1;

  // A degree-4+ vertex often indicates two strokes crossing (not a real sp3
  // branch at a single point in clean skeletal notation). Flag and downweight.
  const highDegree = atoms.filter((a) => a.degree >= 4).length;
  if (highDegree > 0) {
    confidence -= 0.15 * highDegree;
    notes.push(
      `${highDegree} vertex(es) of degree >= 4 — possible crossing strokes mis-read as a junction`,
    );
  }

  // Many tiny disconnected components usually mean fragmentation / noise.
  if (componentCount > 1) {
    notes.push(`${componentCount} disconnected components`);
    if (componentCount > 2) confidence -= 0.1 * (componentCount - 2);
  }

  confidence = Math.max(0, Math.min(1, confidence));
  const status: CarbonSkeletonStatus = confidence >= 0.6 ? "success" : "low-confidence";
  return { status, confidence: round2(confidence), statusNotes: notes };
}

/**
 * Full image -> carbon skeleton pipeline. Accepts a grayscale image (produced
 * by {@link import("./imageIo").decodeImageDataUrlToGray} in a browser, or
 * constructed directly in tests) and returns a {@link CarbonSkeletonResult}.
 *
 * The original image is never mutated. No network / AI is used.
 */
export function reconstructCarbonSkeleton(
  gray: GrayImage,
  options: Partial<SkeletonPipelineOptions> = {},
): CarbonSkeletonResult {
  const opts: SkeletonPipelineOptions = { ...DEFAULT_PIPELINE_OPTIONS, ...options };
  const notes: string[] = [];

  if (gray.width === 0 || gray.height === 0) {
    return emptyResult("unsupported", "image has zero dimensions");
  }

  const { skeleton, binary } = preprocess(gray, {
    fixedThreshold: opts.fixedThreshold,
    minComponentPixels: opts.minComponentPixels,
  });

  let foreground = 0;
  for (let i = 0; i < skeleton.data.length; i++) foreground += skeleton.data[i] as number;
  if (foreground === 0) {
    const anyInk = binary.data.some((v) => v === 1);
    return emptyResult(
      "unsupported",
      anyInk ? "all ink removed as noise during preprocessing" : "image appears blank",
    );
  }

  const graph = extractGeometricGraph(skeleton, {
    simplifyTolerance: opts.simplifyTolerance,
    minCornerAngleDeg: opts.minCornerAngleDeg,
    mergeRadius: opts.mergeRadius,
    minEdgeLength: opts.minEdgeLength,
    keepCrossingsAsJunction: true,
  });

  return geometricGraphToCarbonSkeleton(graph, notes);
}

function emptyResult(
  status: CarbonSkeletonStatus,
  note: string,
): CarbonSkeletonResult {
  return {
    atoms: [],
    bonds: [],
    cycles: [],
    connectedComponents: [],
    cycleRank: 0,
    confidence: 0,
    status,
    notes: [note],
  };
}
