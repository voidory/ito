/**
 * FEAT-005 (M19) — public API of the deterministic carbon-skeleton
 * reconstruction module.
 *
 * This module is intentionally STANDALONE and independent of the M18
 * recognition rendering pipeline. It takes a clean skeletal-structure image
 * crop and reconstructs the underlying carbon skeleton as a graph. It produces
 * a {@link CarbonSkeletonResult}, NOT SMILES. No AI, no network.
 *
 * Typical browser usage:
 *   const gray = await decodeImageDataUrlToGray(areaAnchor.imageDataUrl);
 *   const result = reconstructCarbonSkeleton(gray);
 *
 * In Node / tests, build a GrayImage directly (grayFromRgba / rasterizeFixture)
 * and call reconstructCarbonSkeleton.
 */

export type {
  GrayImage,
  BinaryImage,
  Point,
  GeometricGraph,
  GeometricVertex,
  GeometricEdge,
  CarbonAtom,
  CarbonBond,
  CarbonSkeletonStatus,
  CarbonSkeletonResult,
  SkeletonPipelineOptions,
} from "./types";
export { DEFAULT_PIPELINE_OPTIONS } from "./types";

export {
  rgbaToGrayscale,
  toGrayscale,
  otsuThreshold,
  thresholdBinary,
  foregroundCount,
  labelComponents,
  removeSmallComponents,
  dilate,
  erode,
  morphClose,
  morphOpen,
  zhangSuenThin,
  preprocess,
} from "./preprocess";

export {
  classifySkeletonPixels,
  tracePaths,
  douglasPeucker,
  extractGeometricGraph,
  type GraphExtractionOptions,
} from "./graphExtraction";

export {
  adjacency,
  connectedComponents,
  componentCount,
  cycleRank,
  dedupeEdges,
  minimumCycleBasis,
  verticesInCycles,
  degrees,
  branchVertices,
  endpointVertices,
  ringSubstituentChains,
  type Edge,
} from "./graphAnalysis";

export {
  geometricGraphToCarbonSkeleton,
  reconstructCarbonSkeleton,
} from "./carbonSkeleton";

export {
  grayFromRgba,
  canDecodeImagesInDom,
  decodeImageDataUrlToGray,
} from "./imageIo";

export {
  rasterizeSegments,
  type RasterStyle,
  type Segment,
} from "./raster";

export {
  isIsomorphic,
  compareGraphs,
  invariants,
  type SimpleGraph,
  type GraphComparison,
  type GraphInvariants,
} from "./graphCompare";

export {
  CARBON_SKELETON_CORPUS,
  rasterizeFixture,
  fixtureToSvg,
  fixtureGroundTruth,
  type SkeletonFixture,
} from "./fixtures";
