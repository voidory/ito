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

/**
 * Recognize an equation from an image crop. The backend defaults to the
 * not-configured backend, so the default behavior is a deterministic
 * 'unsupported'. Inject a backend to exercise the deterministic boundary.
 */
export class MathRecognizer {
  private readonly backend: ImageModelBackend;
  private readonly confidenceThreshold: number;

  constructor(
    backend: ImageModelBackend = notConfiguredBackend,
    confidenceThreshold: number = DEFAULT_CONFIDENCE_THRESHOLD,
  ) {
    this.backend = backend;
    this.confidenceThreshold = confidenceThreshold;
  }

  async recognize(input: RecognitionInput): Promise<MathRecognitionResult> {
    const base = { kind: "equation" as const };

    if (!this.backend.isConfigured()) {
      return {
        ...base,
        status: "unsupported",
        errors: ["No equation recognition backend is configured in this environment."],
      };
    }

    let inferred: { text: string; confidence?: number } | null;
    try {
      inferred = await this.backend.infer(input);
    } catch (err) {
      return {
        ...base,
        status: "error",
        errors: [`Equation backend '${this.backend.id}' failed: ${String(err)}`],
      };
    }

    if (!inferred || inferred.text.trim().length === 0) {
      return {
        ...base,
        status: "invalid",
        rawOutput: inferred?.text,
        errors: ["The equation backend returned no LaTeX."],
      };
    }

    const rawLatex = inferred.text;
    // Route the model's raw LaTeX through the SAME normalization as text-layer
    // extraction, then validate it compiles to non-empty MathML.
    const latex = normalizeToLatex(rawLatex);
    const mathml = convertLatexToMathML(latex);

    if (latex.length === 0 || isEmptyMathML(mathml)) {
      return {
        ...base,
        status: "invalid",
        rawOutput: rawLatex,
        errors: ["The recognized LaTeX did not compile to valid MathML."],
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
      latex,
      rawOutput: rawLatex,
      ...(confidence !== undefined ? { confidence } : {}),
    };
  }
}
