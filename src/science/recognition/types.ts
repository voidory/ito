/**
 * M18 FEAT-003 (spec Phase 3 + Phase 9) — the scientific-recognition
 * ABSTRACTION. These are the model-agnostic types every recognizer and the
 * RecognitionService share. The point of this layer is to DECOUPLE the UI from
 * any particular AI model: the UI calls the service with an image crop and gets
 * back a structured {@link RecognitionResult}; it never knows which (if any)
 * model produced it.
 *
 * Two hard rules from the spec are encoded in these types:
 *
 *  1. Recognition does ONLY visual -> structured conversion. The structured
 *     output (LaTeX / SMILES) is then routed through the EXISTING normalization
 *     (src/pdf/scienceOcr.ts) and validation (chemistryValidation.ts) layers,
 *     which stay responsible for structured -> visual rendering. There is NO
 *     monolithic image -> AI -> ChemicalMechanismSpec operation.
 *
 *  2. A result is NEVER silently fabricated on failure. Every outcome carries an
 *     explicit {@link RecognitionStatus}: an unconfigured model yields
 *     'unsupported', output that fails validation yields 'invalid' (with
 *     errors), and a low model confidence yields 'low-confidence'.
 */

/** The kinds of scientific content the abstraction can recognize. */
export type ScienceRecognitionKind = "equation" | "molecule" | "reaction";

/**
 * Phase 9 explicit confidence / failure status. Every {@link RecognitionResult}
 * carries exactly one of these; there is no "silent" success:
 *
 *  - `success`        — recognized and validated; the structured output is safe to use.
 *  - `low-confidence` — recognized and validated, but the backend's confidence
 *                       was below threshold; surface a caveat / ask to confirm.
 *  - `invalid`        — the backend produced output, but it failed normalization
 *                       / validation; `errors` explains why. Never stored silently.
 *  - `unsupported`    — no configured backend (or the kind is deferred); nothing
 *                       was attempted. This is the DEFAULT in this environment.
 *  - `error`          — an unexpected failure occurred while recognizing.
 */
export type RecognitionStatus =
  | "success"
  | "low-confidence"
  | "invalid"
  | "unsupported"
  | "error";

/** The image crop handed to a recognizer (a rendered Area-annotation region). */
export interface RecognitionInput {
  /** PNG/SVG data URL of the cropped region (see cropCanvasRegionToDataUrl). */
  imageDataUrl: string;
  /** Pixel width of the crop. */
  width: number;
  /** Pixel height of the crop. */
  height: number;
}

/**
 * The common recognition result. Kind-specific recognizers extend this with the
 * structured payload they produce ({@link MathRecognitionResult.latex},
 * {@link MoleculeRecognitionResult.smiles}, …) but the shape below is what the
 * UI / RecognitionService can rely on for every kind.
 */
export interface RecognitionResult {
  kind: ScienceRecognitionKind;
  status: RecognitionStatus;
  /** Backend confidence in [0, 1] when the backend reported one. */
  confidence?: number;
  /** The raw backend output (string/text), kept for diagnostics. */
  rawOutput?: unknown;
  /** Human-readable reasons the result is 'invalid' / 'error' / 'unsupported'. */
  errors?: string[];
  /** Non-fatal caveats (e.g. uncanonicalized stereochemistry). */
  warnings?: string[];
}

/**
 * The model-backend SEAM. Remote inference endpoints (pix2text-mfr for math,
 * DECIMER / MolScribe for molecules, …) must ONLY ever be reached through an
 * implementation of this interface. The rest of Ito depends on this interface,
 * never on a concrete remote API — so swapping, configuring, or disabling a
 * model is a pure composition concern and the default build makes no network
 * call whatsoever.
 */
export interface ImageModelBackend {
  /** Stable identifier for diagnostics / UI badges (e.g. "pix2text-mfr"). */
  readonly id: string;
  /** Whether this backend can actually run inference in this environment. */
  isConfigured(): boolean;
  /**
   * Run inference on the crop, resolving to the model's raw text output (plus
   * an optional confidence in [0, 1]), or `null` when the backend is not
   * configured / produced nothing. MUST NOT throw for the not-configured case.
   */
  infer(input: RecognitionInput): Promise<{ text: string; confidence?: number } | null>;
}

/**
 * The DEFAULT backend used everywhere in this environment: it is deliberately
 * NOT configured, so {@link ImageModelBackend.isConfigured} is `false` and
 * {@link ImageModelBackend.infer} resolves to `null`. Because of this the
 * default RecognitionService deterministically reports 'unsupported' and the
 * rest of Ito never depends on a reachable remote API. Inject a real/fake
 * backend to exercise the success / invalid / low-confidence paths.
 */
export const notConfiguredBackend: ImageModelBackend = {
  id: "not-configured",
  isConfigured(): boolean {
    return false;
  },
  async infer(): Promise<{ text: string; confidence?: number } | null> {
    return null;
  },
};

/**
 * Confidence at or above this threshold is treated as 'success'; a configured
 * backend reporting a lower confidence downgrades a valid result to
 * 'low-confidence'. A backend that reports no confidence is treated as confident.
 */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.5;
