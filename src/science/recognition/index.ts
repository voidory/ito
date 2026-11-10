/**
 * M18 FEAT-003 — public API of the scientific-recognition layer.
 *
 * The UI should import from here and depend ONLY on the model-agnostic
 * abstraction (types + the RecognitionService factory). No model is referenced
 * directly; backends are injected through {@link createRecognitionService}.
 */

export type {
  ScienceRecognitionKind,
  RecognitionStatus,
  RecognitionInput,
  RecognitionResult,
  ImageModelBackend,
} from "./types";
export { notConfiguredBackend, DEFAULT_CONFIDENCE_THRESHOLD } from "./types";

export { MathRecognizer, type MathRecognitionResult } from "./mathRecognizer";
export { MoleculeRecognizer, type MoleculeRecognitionResult } from "./moleculeRecognizer";
export { ReactionRecognizer, type ReactionRecognitionResult } from "./reactionRecognizer";

export {
  RecognitionService,
  createRecognitionService,
  type RecognitionServiceOptions,
} from "./recognitionService";
