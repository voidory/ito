/**
 * FEAT-005B — failure-mode classification.
 *
 * Rather than reporting "wrong graph", we classify WHY a reconstruction failed,
 * using the ground-truth structure + the geometric diagnostics (vertex/bond
 * matching). The categories are exactly the ones the spec asks us to
 * investigate, and each carries a REMEDY class so the report says what kind of
 * fix the failure would need — never an arbitrary heuristic to game the score.
 */

import { degrees, minimumCycleBasis, type Edge } from "../graphAnalysis";
import type { CarbonSkeletonResult, Point } from "../types";
import type { EvaluationMetrics, GroundTruthGraph } from "./metrics";

export type FailureCategory =
  | "rounded-corners"
  | "closely-spaced-vertices"
  | "degree-four-ambiguity"
  | "crossing-bonds"
  | "fused-rings"
  | "very-small-rings"
  | "thick-antialiased-lines"
  | "labels-touching-bonds"
  | "multiple-disconnected-structures"
  | "rotation-skew-staircase"
  | "noise-contrast-compression"
  | "uncategorised";

export type RemedyClass =
  | "preprocessing"
  | "geometric-graph-extraction"
  | "topology-reconstruction"
  | "explicit-ambiguity-detection"
  | "different-recognition-method"
  | "none";

export interface FailureClassification {
  readonly category: FailureCategory;
  readonly remedy: RemedyClass;
  readonly evidence: string;
}

/** The minimum distance between any two ground-truth atoms, in pixels. */
function minVertexSpacing(atoms: readonly Point[]): number {
  let min = Infinity;
  for (let i = 0; i < atoms.length; i++) {
    for (let j = i + 1; j < atoms.length; j++) {
      const a = atoms[i] as Point;
      const b = atoms[j] as Point;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < min) min = d;
    }
  }
  return min;
}

/** True if any ground-truth atom has degree >= 4. */
function hasDegreeFour(gt: GroundTruthGraph): boolean {
  const edges: Edge[] = gt.bonds.map(([a, b]) => ({ a, b }));
  return degrees(gt.atoms.length, edges).some((d) => d >= 4);
}

/** True if the ground-truth has at least one ring of <= 4 atoms. */
function hasVerySmallRing(gt: GroundTruthGraph): boolean {
  const edges: Edge[] = gt.bonds.map(([a, b]) => ({ a, b }));
  return minimumCycleBasis(gt.atoms.length, edges).some((c) => c.length <= 4);
}

/** True if the ground truth has two or more rings sharing an edge (fused). */
function isFused(gt: GroundTruthGraph): boolean {
  return gt.expectedCycleRank >= 2;
}

export interface FailureContext {
  readonly transform: string;
  readonly hasLabels: boolean;
  readonly lineWidth: number;
}

/**
 * Classify a single failing evaluation. Returns the single MOST LIKELY cause,
 * decided by a priority order from the most specific structural signal to the
 * most generic transform signal. This is diagnostic, not a tuning input.
 */
export function classifyFailure(
  result: CarbonSkeletonResult,
  gt: GroundTruthGraph,
  metrics: EvaluationMetrics,
  ctx: FailureContext,
): FailureClassification {
  const spacing = minVertexSpacing(gt.atoms);
  const bondLen = gt.bonds.length
    ? gt.bonds.reduce((s, [a, b]) => {
        const pa = gt.atoms[a] as Point;
        const pb = gt.atoms[b] as Point;
        return s + Math.hypot(pa.x - pb.x, pa.y - pb.y);
      }, 0) / gt.bonds.length
    : 0;

  // Over-segmentation vs. under-segmentation signals.
  const extraVertices = metrics.predVertices - metrics.gtVertices;
  const extraComponents = result.connectedComponents.length;

  // 1. Degree-4 ambiguity: GT has a quaternary carbon AND a vertex was lost/
  //    its degree dropped (the documented collinearity case).
  if (hasDegreeFour(gt) && (!metrics.branchTopologyCorrect || !metrics.exact)) {
    return {
      category: "degree-four-ambiguity",
      remedy: "explicit-ambiguity-detection",
      evidence:
        "ground truth has a degree-4 (quaternary / crossing) vertex; its degree " +
        "cannot be recovered from pure geometry when two bonds are near-collinear. " +
        "Needs bond-pairing collinearity test at degree-4 junctions.",
    };
  }

  // 2. Very small rings (3-4 membered): corner rounding dominates.
  if (hasVerySmallRing(gt) && !metrics.exact) {
    return {
      category: "very-small-rings",
      remedy: "geometric-graph-extraction",
      evidence:
        "ground truth contains a 3- or 4-membered ring; sharp apices round into " +
        "arcs under thinning, splitting/merging a vertex. Needs least-squares " +
        "segment fitting instead of Douglas-Peucker corner recovery.",
    };
  }

  // 3. Fused rings: cycle rank wrong on a fused system.
  if (isFused(gt) && !metrics.cycleRankCorrect) {
    return {
      category: "fused-rings",
      remedy: "topology-reconstruction",
      evidence:
        "fused/polycyclic ground truth whose independent-ring count (μ) was not " +
        "recovered; the shared-edge junctions were mis-connected. Needs more " +
        "robust junction topology at ring fusions.",
    };
  }

  // 4. Labels touching bonds: a label was present and produced extra vertices /
  //    components near a labelled atom. Only attribute to labels when the image
  //    was NOT photometrically degraded (otherwise noise is the likelier cause
  //    and is handled below), so a noisy labelled image is not mis-blamed on
  //    the label.
  const photometric = ["gauss", "saltpepper", "contrast", "jpegish", "lowres"].includes(
    ctx.transform,
  );
  if (ctx.hasLabels && !photometric && (extraVertices > 0 || extraComponents > 1)) {
    return {
      category: "labels-touching-bonds",
      remedy: "preprocessing",
      evidence:
        "element/group label text was rendered near the skeleton and was traced " +
        "as spurious strokes. Needs text detection + masking before extraction.",
    };
  }

  // 5. Closely-spaced vertices: GT spacing small relative to bond length and a
  //    vertex was merged away (under-segmentation).
  if (spacing < bondLen * 0.55 && metrics.predVertices < metrics.gtVertices) {
    return {
      category: "closely-spaced-vertices",
      remedy: "geometric-graph-extraction",
      evidence:
        "two ground-truth carbons are closer than the merge radius and collapsed " +
        "into one. Needs an adaptive, local merge radius.",
    };
  }

  // 6. Multiple disconnected structures: more components than expected.
  if (extraComponents > Math.max(1, countGtComponents(gt))) {
    return {
      category: "multiple-disconnected-structures",
      remedy: "topology-reconstruction",
      evidence:
        "reconstruction fragmented into more components than ground truth; a single " +
        "structure was split. Needs gap-closing / component-reconnection.",
    };
  }

  // 7. Rotation / skew staircase effects.
  if (ctx.transform === "rot15" || ctx.transform === "rot30" || ctx.transform === "skew") {
    return {
      category: "rotation-skew-staircase",
      remedy: "geometric-graph-extraction",
      evidence:
        "rotation/skew turned axis-aligned strokes into diagonal staircases, " +
        "shifting corner angles. Needs sub-pixel corner localisation.",
    };
  }

  // 8. Thick / anti-aliased lines (the base + thick transform at wide strokes).
  if (ctx.lineWidth >= 5 || ctx.transform === "thick") {
    return {
      category: "thick-antialiased-lines",
      remedy: "preprocessing",
      evidence:
        "wide anti-aliased strokes thinned imperfectly, shifting junction " +
        "positions. Needs stroke-width normalisation before thinning.",
    };
  }

  // 9. Noise / contrast / compression.
  if (["gauss", "saltpepper", "contrast", "jpegish", "lowres"].includes(ctx.transform)) {
    return {
      category: "noise-contrast-compression",
      remedy: "preprocessing",
      evidence:
        "photometric degradation (" + ctx.transform + ") broke strokes or added " +
        "specks that survived denoising. Needs adaptive thresholding + stronger denoise.",
    };
  }

  // 10. Crossing bonds: a degree-4 vertex appeared that is not in GT.
  const predEdges: Edge[] = result.bonds.map((b) => ({ a: b.source, b: b.target }));
  if (degrees(result.atoms.length, predEdges).some((d) => d >= 4) && !hasDegreeFour(gt)) {
    return {
      category: "crossing-bonds",
      remedy: "explicit-ambiguity-detection",
      evidence:
        "a spurious degree-4 junction appeared where ground truth has none — two " +
        "strokes read as crossing. Needs crossing detection.",
    };
  }

  // 11. Rounded corners (generic over-smoothing dropping a real bend).
  if (metrics.predVertices < metrics.gtVertices) {
    return {
      category: "rounded-corners",
      remedy: "geometric-graph-extraction",
      evidence:
        "a genuine skeletal bend was smoothed below the corner-angle threshold and " +
        "lost. Needs least-squares corner recovery / lower angle threshold with " +
        "segment-length gating.",
    };
  }

  // 12. Over-segmentation: MORE vertices than ground truth (a strand split into
  //     spurious corners, typically where a thinned junction wobbles). This is
  //     the dual of rounded corners and also an extraction-stage problem.
  if (extraVertices > 0) {
    return {
      category: "rounded-corners",
      remedy: "geometric-graph-extraction",
      evidence:
        "a straight strand or junction was over-segmented into spurious corner " +
        "vertices (thinning wobble at a bridged/fused junction). Needs least-squares " +
        "segment merging by residual so collinear sub-segments collapse.",
    };
  }

  return {
    category: "uncategorised",
    remedy: "topology-reconstruction",
    evidence: "failure did not match a known signature; inspect the debug SVG.",
  };
}

function countGtComponents(gt: GroundTruthGraph): number {
  // Corpus structures are single connected molecules, so this is 1; kept for
  // generality (a future crop could contain several).
  const n = gt.atoms.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x] as number)));
  for (const [a, b] of gt.bonds) parent[find(a)] = find(b);
  return new Set(Array.from({ length: n }, (_, i) => find(i))).size;
}
