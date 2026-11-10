/**
 * M18 FEAT-003 (spec Phase 3) — reaction recognizer placeholder.
 *
 * This file exists to keep the recognition abstraction COMPLETE per the spec's
 * required file list, but it deliberately does NOT implement full reaction
 * recognition. Reaction segmentation (detecting reactants / arrow / products,
 * per-structure OCSR, and assembling a reaction) is spec Phases 6–8 and is
 * DEFERRED. Implementing it now would require the forbidden monolithic
 * image -> AI -> ChemicalMechanismSpec operation, so recognize() returns an
 * explicit 'unsupported' instead.
 *
 * When Phases 6–8 land, this recognizer will compose the existing
 * MoleculeRecognizer over segmented sub-regions and route the assembled
 * reaction SMILES through the chemistry validation layer — never a single
 * end-to-end model call.
 */

import {
  notConfiguredBackend,
  type ImageModelBackend,
  type RecognitionInput,
  type RecognitionResult,
} from "./types";

/** A reaction recognition result, extended with a reaction SMILES. */
export interface ReactionRecognitionResult extends RecognitionResult {
  kind: "reaction";
  /** The recognized reaction SMILES (reactants>agents>products), when supported. */
  reactionSmiles?: string;
}

/**
 * Recognize a reaction from an image crop. Always 'unsupported' for now:
 * full reaction segmentation is a later phase (spec Phases 6–8).
 */
export class ReactionRecognizer {
  // A backend is accepted for interface symmetry with the other recognizers,
  // but reaction recognition is deferred, so it is never invoked yet.
  constructor(private readonly backend: ImageModelBackend = notConfiguredBackend) {}

  async recognize(_input: RecognitionInput): Promise<ReactionRecognitionResult> {
    void this.backend;
    return {
      kind: "reaction",
      status: "unsupported",
      errors: [
        "Reaction recognition is not yet supported; full reaction segmentation is a later phase (spec Phases 6–8).",
      ],
    };
  }
}
