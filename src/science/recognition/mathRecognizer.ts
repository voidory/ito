/**
 * M18 FEAT-003 (spec Phase 3, pipeline per spec Step 4.2) — equation recognizer.
 *
 * Visual -> structured ONLY. The pipeline is:
 *
 *   backend.infer(image)  ->  raw LaTeX
 *                         ->  normalizeToLatex  (REUSED from scienceOcr.ts)
 *                         ->  convertLatexToMathML  (validates it compiles)
 *                         ->  MathRecognitionResult
 *
 * It does NOT render anything itself: structured -> visual stays the job of the
 * existing scienceOcr.ts engine. It NEVER stores bad LaTeX: if the normalized
 * LaTeX compiles to empty MathML, the result is 'invalid' with errors. With the
 * default {@link notConfiguredBackend}, recognize() deterministically returns
 * 'unsupported' and no latex.
 */

import { convertLatexToMathML, normalizeToLatex } from "../../pdf/scienceOcr";
import {
  isEquationBackend,
  imageModelAsEquationBackend,
  type EquationBackend,
  type EquationBackendOutput,
  type EquationInput,
  type EquationModality,
  type PageRegion,
} from "./equationBackend";
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  notConfiguredBackend,
  type ImageModelBackend,
  type RecognitionInput,
  type RecognitionResult,
} from "./types";

/** An equation recognition result, extended with the recognized LaTeX. */
export interface MathRecognitionResult extends RecognitionResult {
  kind: "equation";
  /** Normalized LaTeX that compiles to MathML (present only on success). */
  latex?: string;
  /** Which backend produced it, and what that backend reads. */
  backend?: { id: string; modality: EquationModality };
  /** What the backend measured (see `equationEvidence.ts` for the geometric one). */
  evidence?: unknown;
}

/**
 * A MathML body is "empty" (nothing was recognized) when its only content is an
 * empty `<mrow></mrow>` — this is exactly what convertLatexToMathML emits for
 * input that normalizes to nothing / fails to tokenize into any node.
 */
function isEmptyMathML(mathml: string): boolean {
  const body = mathml
    .replace(/^<math[^>]*>/, "")
    .replace(/<\/math>$/, "")
    .trim();
  return body === "" || body === "<mrow></mrow>";
}

type BackendLike = EquationBackend | ImageModelBackend;

/**
 * Recognize an equation. Backends are asked in order and the first that has
 * something to say wins, so a deterministic reader of the page can come ahead
 * of a model that only sees a picture. With no configured backend, the result
 * is a deterministic 'unsupported'.
 */
export class MathRecognizer {
  private readonly backends: readonly EquationBackend[];
  private readonly confidenceThreshold: number;

  constructor(
    backends: BackendLike | readonly BackendLike[] = notConfiguredBackend,
    confidenceThreshold: number = DEFAULT_CONFIDENCE_THRESHOLD,
  ) {
    const list: readonly BackendLike[] = Array.isArray(backends) ? backends : [backends as BackendLike];
    this.backends = list.map((b) => (isEquationBackend(b) ? b : imageModelAsEquationBackend(b)));
    this.confidenceThreshold = confidenceThreshold;
  }

  /** The RecognitionService entry point: a picture of the box, and the page too when it is known. */
  async recognize(input: RecognitionInput & { page?: PageRegion }): Promise<MathRecognitionResult> {
    const { page, ...image } = input;
    return this.recognizeEquation({ image, ...(page ? { page } : {}) });
  }

  async recognizeEquation(input: EquationInput): Promise<MathRecognitionResult> {
    const base = { kind: "equation" as const };
    const usable = this.backends.filter((b) => b.isConfigured() && b.supports(input));

    if (usable.length === 0) {
      return {
        ...base,
        status: "unsupported",
        errors: ["No equation recognition backend is configured in this environment."],
      };
    }

    let answered: { backend: EquationBackend; out: EquationBackendOutput } | null = null;
    const failures: string[] = [];
    for (const backend of usable) {
      try {
        const out = await backend.recognize(input);
        if (out && out.text.trim().length > 0) {
          answered = { backend, out };
          break;
        }
      } catch (err) {
        failures.push(`Equation backend '${backend.id}' failed: ${String(err)}`);
      }
    }

    if (!answered) {
      if (failures.length > 0) return { ...base, status: "error", errors: failures };
      return {
        ...base,
        status: "invalid",
        errors: ["The equation backend returned no LaTeX."],
      };
    }

    const { backend, out } = answered;
    const rawLatex = out.text;
    // A model's raw LaTeX goes through the SAME normalization as text-layer
    // extraction. A backend that already produces canonical LaTeX is not
    // normalized again, since that could change what it measured.
    const latex = out.verbatim ? rawLatex.trim() : normalizeToLatex(rawLatex);
    const mathml = convertLatexToMathML(latex);
    const identity = { backend: { id: backend.id, modality: backend.modality }, ...(out.evidence !== undefined ? { evidence: out.evidence } : {}) };

    if (latex.length === 0 || isEmptyMathML(mathml)) {
      return {
        ...base,
        ...identity,
        status: "invalid",
        rawOutput: rawLatex,
        errors: ["The recognized LaTeX did not compile to valid MathML."],
      };
    }

    const trustAt = backend.trustAt ?? this.confidenceThreshold;
    const confidence = out.confidence;
    const status = confidence !== undefined && confidence < trustAt ? "low-confidence" : "success";

    return {
      ...base,
      ...identity,
      status,
      latex,
      rawOutput: rawLatex,
      ...(confidence !== undefined ? { confidence } : {}),
      ...(out.doubts && out.doubts.length > 0 ? { warnings: [...out.doubts] } : {}),
    };
  }
}
