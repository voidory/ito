/**
 * Production MVP — public API of carbon-skeleton recognition.
 *
 * The bounded, reliable product feature: given a reasonably clean cropped 2D
 * skeletal structure, recognise its carbon skeleton and return the basic
 * molecular graph / topology, or fail EXPLICITLY when the input is outside the
 * supported class. Reuses the deterministic engine in `src/science/skeleton/`;
 * does not expose the research benchmark machinery
 * (`src/science/research/skeleton/`).
 *
 * Typical browser usage:
 *   const result = await recognizeCarbonSkeletonFromDataUrl(areaAnchor.imageDataUrl);
 *   if (result.success) { // result.skeleton.carbons / bonds / topology }
 *   else { // result.reason }
 *
 * In Node / tests: build a GrayImage and call recognizeCarbonSkeleton directly.
 */

export { recognizeCarbonSkeleton } from "./recognizeCarbonSkeleton";
export type { RecognizeCarbonSkeletonOptions } from "./recognizeCarbonSkeleton";
export { recognizeCarbonSkeletonFromDataUrl } from "./recognizeCarbonSkeletonFromDataUrl";
export type {
  CarbonSkeletonRecognition,
  RecognizedSkeleton,
  RecognizedCarbon,
  RecognizedBond,
  SkeletonTopology,
  RecognitionStatus as CarbonSkeletonRecognitionStatus,
} from "./types";
