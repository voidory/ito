/**
 * M18 FEAT-003 (spec Phase 3, pipeline per spec Step 5.2) — molecule recognizer.
 *
 * Visual -> structured ONLY. The pipeline is:
 *
 *   backend.infer(image)  ->  raw SMILES
 *                         ->  validateSmiles  (REUSED from chemistryValidation.ts)
 *                         ->  MoleculeRecognitionResult
 *
 * On a valid SMILES it carries the validator's `normalizedSmiles` (aromaticity
 * preserved — c1ccccc1 is NOT uppercased, per FEAT-002). An invalid SMILES is
 * NEVER accepted silently: the result is 'invalid' with the validator's errors.
 * With the default {@link notConfiguredBackend}, recognize() deterministically
 * returns 'unsupported'.
 */

import { validateSmiles } from "./chemistryValidation";
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  notConfiguredBackend,
  type ImageModelBackend,
  type RecognitionInput,
  type RecognitionResult,
} from "./types";

/** A molecule recognition result, extended with the recognized SMILES. */
export interface MoleculeRecognitionResult extends RecognitionResult {
  kind: "molecule";
  /** The raw SMILES the backend produced (present once inference ran). */
  smiles?: string;
  /** The deterministic normalized SMILES (present only on success). */
  normalizedSmiles?: string;
}

/**
 * Recognize a molecule (SMILES) from an image crop. The backend defaults to the
 * not-configured backend, so the default behavior is a deterministic
 * 'unsupported'. Inject a backend to exercise the deterministic boundary.
 */
export class MoleculeRecognizer {
  private readonly backend: ImageModelBackend;
  private readonly confidenceThreshold: number;

  constructor(
    backend: ImageModelBackend = notConfiguredBackend,
    confidenceThreshold: number = DEFAULT_CONFIDENCE_THRESHOLD,
  ) {
    this.backend = backend;
    this.confidenceThreshold = confidenceThreshold;
  }

  async recognize(input: RecognitionInput): Promise<MoleculeRecognitionResult> {
    const base = { kind: "molecule" as const };

    if (!this.backend.isConfigured()) {
      return {
        ...base,
        status: "unsupported",
        errors: ["No molecule recognition backend is configured in this environment."],
      };
    }

    let inferred: { text: string; confidence?: number } | null;
    try {
      inferred = await this.backend.infer(input);
    } catch (err) {
      return {
        ...base,
        status: "error",
        errors: [`Molecule backend '${this.backend.id}' failed: ${String(err)}`],
      };
    }

    if (!inferred || inferred.text.trim().length === 0) {
      return {
        ...base,
        status: "invalid",
        rawOutput: inferred?.text,
        errors: ["The molecule backend returned no SMILES."],
      };
    }

    const rawSmiles = inferred.text.trim();
    // Route the model's raw SMILES through the SAME validation layer the rest
    // of the chemistry engine uses (FEAT-002). Aromaticity is preserved there.
    const validation = validateSmiles(rawSmiles);

    if (!validation.valid) {
      return {
        ...base,
        status: "invalid",
        smiles: rawSmiles,
        rawOutput: rawSmiles,
        errors: validation.errors,
        ...(validation.warnings.length > 0 ? { warnings: validation.warnings } : {}),
      };
    }

    const confidence = inferred.confidence;
    const status =
      confidence !== undefined && confidence < this.confidenceThreshold
        ? "low-confidence"
        : "success";

    return {
      ...base,
      status,
      smiles: rawSmiles,
      rawOutput: rawSmiles,
      ...(validation.normalizedSmiles !== undefined
        ? { normalizedSmiles: validation.normalizedSmiles }
        : {}),
      ...(confidence !== undefined ? { confidence } : {}),
      ...(validation.warnings.length > 0 ? { warnings: validation.warnings } : {}),
    };
  }
}
