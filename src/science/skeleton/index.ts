/**
 * FEAT-005 (M19) — the SHARED, deterministic carbon-skeleton reconstruction
 * ENGINE.
 *
 * This is the stable, pure computer-vision + graph-theory core. It is depended
 * on by BOTH:
 *   - the production MVP (`src/science/recognition/carbonSkeleton/`), which
 *     wraps it in a small, bounded, reliable product surface; and
 *   - the research benchmarks (`src/science/research/skeleton/`), which
 *     exercise it against synthetic / real-world / independent corpora.
 *
 * It takes a clean skeletal-structure image crop and reconstructs the
 * underlying carbon skeleton as a graph. It produces a
 * {@link CarbonSkeletonResult}, NOT SMILES. No AI, no network, no corpus.
 *
 * This barrel intentionally exports ONLY the engine (types, preprocessing,
 * graph extraction/analysis, reconstruction, image I/O, and the pure
 * rasteriser used by the engine's own unit tests). The benchmark-only helpers
 * (synthetic corpus `fixtures`, isomorphism scoring `graphCompare`) now live
 * with the research area and are NOT re-exported here, so production code never
 * pulls in benchmark machinery.
 *
 * Typical browser usage:
 *   const gray = await decodeImageDataUrlToGray(areaAnchor.imageDataUrl);
 *   const result = reconstructCarbonSkeleton(gray);
 *
 * In Node / tests, build a GrayImage directly (grayFromRgba / rasterizeSegments)
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
