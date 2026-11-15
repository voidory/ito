/**
 * The geometric extractor as an equation-recognition backend: it reads the
 * glyphs and rules a born-digital page was drawn with, not a picture of them.
 *
 * It claims only what it can read. With no page model, or no glyph in the box
 * (a scanned page, a figure), it says nothing and the recognizer tries the
 * next backend. Its draft is exactly what `extractLatexFromModel` returns:
 * wrapping it as a backend changes nothing about the LaTeX, only adds the
 * account of how sure the extraction was.
 */

import type { EquationBackend, EquationInput } from "../science/recognition/equationBackend";
import { analyzeModelRegion, type EquationEvidence } from "./equationEvidence";

/** How a backend turns its evidence into a probability and reasons for doubt. */
export type EvidenceAssessor = (evidence: EquationEvidence) => { confidence: number; doubts: readonly string[] };

export interface GeometryBackendOptions {
  /** Without one the backend reports no confidence, and every draft counts as confident. */
  readonly assess?: EvidenceAssessor;
  /** Confidence at or above which a draft is trusted without a caveat. */
  readonly trustAt?: number;
}

export function createGeometryEquationBackend(options: GeometryBackendOptions = {}): EquationBackend {
  return {
    id: "pdf-geometry",
    modality: "geometry",
    ...(options.trustAt !== undefined ? { trustAt: options.trustAt } : {}),
    isConfigured: () => true,
    supports: (input: EquationInput) => input.page != null,
    async recognize(input: EquationInput) {
      if (!input.page) return null;
      const { latex, evidence } = analyzeModelRegion(input.page.model, input.page.rect);
      if (latex.length === 0) return null;
      const assessment = options.assess?.(evidence);
      return {
        text: latex,
        verbatim: true,
        evidence,
        ...(assessment ? { confidence: assessment.confidence, doubts: assessment.doubts } : {}),
      };
    },
  };
}
