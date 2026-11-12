/**
 * M18 FEAT-003 (spec Phase 3) — the RecognitionService.
 *
 * The SINGLE entry point the UI calls. It dispatches a recognition request to
 * the per-kind recognizer and returns the common {@link RecognitionResult}. The
 * UI depends ONLY on this service and the shared types — never on a model.
 *
 * Every model backend is PLUGGABLE and defaults to {@link notConfiguredBackend},
 * so the out-of-the-box service makes no network call and deterministically
 * reports 'unsupported'. Tests (and, later, a configured deployment) inject
 * real/fake backends to exercise the success / invalid / low-confidence paths.
 */

import { MathRecognizer } from "./mathRecognizer";
import { MoleculeRecognizer } from "./moleculeRecognizer";
import { ReactionRecognizer } from "./reactionRecognizer";
import {
  notConfiguredBackend,
  type ImageModelBackend,
  type RecognitionInput,
  type RecognitionResult,
  type ScienceRecognitionKind,
} from "./types";

/** Options for {@link createRecognitionService}; every backend is optional. */
export interface RecognitionServiceOptions {
  /** Backend for equation recognition (default: not configured). */
  mathBackend?: ImageModelBackend;
  /** Backend for molecule recognition (default: not configured). */
  moleculeBackend?: ImageModelBackend;
  /** Backend for reaction recognition (default: not configured; deferred). */
  reactionBackend?: ImageModelBackend;
  /** Confidence threshold below which a valid result is 'low-confidence'. */
  confidenceThreshold?: number;
}

/**
 * Dispatches recognition requests to the per-kind recognizers. Construct via
 * {@link createRecognitionService} so backends default to not-configured.
 */
export class RecognitionService {
  private readonly math: MathRecognizer;
  private readonly molecule: MoleculeRecognizer;
  private readonly reaction: ReactionRecognizer;

  constructor(opts: RecognitionServiceOptions = {}) {
    const mathBackend = opts.mathBackend ?? notConfiguredBackend;
    const moleculeBackend = opts.moleculeBackend ?? notConfiguredBackend;
    const reactionBackend = opts.reactionBackend ?? notConfiguredBackend;
    this.math = new MathRecognizer(mathBackend, opts.confidenceThreshold);
    this.molecule = new MoleculeRecognizer(moleculeBackend, opts.confidenceThreshold);
    this.reaction = new ReactionRecognizer(reactionBackend);
  }

  /** Dispatch to the recognizer for `kind`. The single UI entry point. */
  async recognize(
    kind: ScienceRecognitionKind,
    input: RecognitionInput,
  ): Promise<RecognitionResult> {
    switch (kind) {
      case "equation":
        return this.math.recognize(input);
      case "molecule":
        return this.molecule.recognize(input);
      case "reaction":
        return this.reaction.recognize(input);
      default: {
        // Exhaustiveness guard: a new kind must be wired up here explicitly.
        const unreachable: never = kind;
        return {
          kind: unreachable,
          status: "unsupported",
          errors: [`Unknown recognition kind: ${String(kind)}`],
        };
      }
    }
  }
}

/**
 * Create a {@link RecognitionService}. With no options every backend defaults
 * to {@link notConfiguredBackend}, so recognize() returns 'unsupported' for
 * every kind and nothing touches the network.
 */
export function createRecognitionService(
  opts: RecognitionServiceOptions = {},
): RecognitionService {
  return new RecognitionService(opts);
}
