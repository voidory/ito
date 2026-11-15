/**
 * The equation-recognition backend interface, neutral about what a backend
 * looks at.
 *
 * An equation can be recognized from a picture of it (a model such as
 * pix2text-mfr) or read from the page that was drawn (the glyphs and rules in
 * a born-digital PDF). Those are different inputs with different failure
 * modes, but the same question: what is the LaTeX, and how sure are you? The
 * recognizer asks every configured backend in order, takes the first that has
 * something to say, and reports its answer with that backend's own account of
 * its doubt.
 *
 * A backend returns `null` when it cannot say anything for this input. It
 * never invents an answer to avoid returning `null`.
 */

import type { NormalizedRect } from "../../model";
import type { PageMathModel } from "../../pdf/pageMathModel";
import type { ImageModelBackend, RecognitionInput } from "./types";

/** What kind of evidence a backend reads. */
export type EquationModality = "geometry" | "image";

/** A box on a page whose drawing instructions are known. */
export interface PageRegion {
  readonly model: PageMathModel;
  /** The box, normalized to the page (0..1, y down). */
  readonly rect: NormalizedRect;
}

/** Everything a backend might use. A backend takes what it understands and ignores the rest. */
export interface EquationInput {
  /** A picture of the box. */
  readonly image?: RecognitionInput;
  /** The page the box is on, when it came from a PDF whose drawing is known. */
  readonly page?: PageRegion;
}

/** What a backend says about an equation. */
export interface EquationBackendOutput {
  /** The LaTeX. */
  readonly text: string;
  /**
   * The probability, in [0, 1], that `text` is exactly right, when the backend
   * can say. Absent means the backend has no account of its own accuracy.
   */
  readonly confidence?: number;
  /**
   * `text` is already in the form the rest of Ito expects. Normalizing it
   * again could change it, so it is only validated.
   */
  readonly verbatim?: boolean;
  /** Plain reasons the backend doubts its answer, for the person verifying it. */
  readonly doubts?: readonly string[];
  /** Whatever the backend measured, kept for diagnostics and calibration. */
  readonly evidence?: unknown;
}

export interface EquationBackend {
  /** Stable identifier for diagnostics and badges. */
  readonly id: string;
  readonly modality: EquationModality;
  /**
   * The confidence at or above which this backend's answer is trusted without
   * a caveat. Calibrated per backend: a number is only comparable to the same
   * backend's other numbers. Falls back to the recognizer's default.
   */
  readonly trustAt?: number;
  /** Whether the backend can run at all in this environment. */
  isConfigured(): boolean;
  /** Whether the backend has an input it understands. Cheap; no inference. */
  supports(input: EquationInput): boolean;
  /** `null` when there is nothing to say for this input. Must not throw for being unconfigured. */
  recognize(input: EquationInput): Promise<EquationBackendOutput | null>;
}

/** Whether a value is an {@link EquationBackend} rather than the older image-only seam. */
export function isEquationBackend(b: EquationBackend | ImageModelBackend): b is EquationBackend {
  return "modality" in b && "supports" in b;
}

/** Present an image model (the existing {@link ImageModelBackend} seam) as an equation backend. */
export function imageModelAsEquationBackend(model: ImageModelBackend): EquationBackend {
  return {
    id: model.id,
    modality: "image",
    isConfigured: () => model.isConfigured(),
    supports: (input) => input.image != null,
    async recognize(input) {
      if (!input.image) return null;
      const out = await model.infer(input.image);
      return out ? { text: out.text, ...(out.confidence !== undefined ? { confidence: out.confidence } : {}) } : null;
    },
  };
}
