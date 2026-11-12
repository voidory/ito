/**
 * Production MVP — carbon-skeleton recognition RESULT view.
 *
 * A small, self-contained, independently testable component. It is a PURE VIEW
 * over a {@link CarbonSkeletonRecognition} already produced by the deterministic
 * recogniser — it never decodes images, never calls the recogniser, never
 * touches the network/backend, and never persists anything. All it does is
 * display what the recogniser returned:
 *
 *  - on success: the original crop with a lightweight SVG overlay of the
 *    reconstructed carbon graph (one line per C–C bond, one marker per carbon,
 *    branch/ring vertices visually distinguished), plus a concise structural
 *    summary and a qualitative confidence badge (NOT a raw probability);
 *  - on failure: the explicit failure message + a smaller diagnostic reason,
 *    with NO graph drawn.
 *
 * Coordinate correctness: the recogniser returns carbon coordinates in the
 * analysed image's pixel space (`skeleton.imageWidth` × `skeleton.imageHeight`).
 * The overlay SVG uses exactly that as its `viewBox` and is stretched over the
 * `<img>` with `preserveAspectRatio="none"`, so the browser scales image and
 * graph together with a single implicit transform — no hand-rolled rescaling,
 * no drift.
 */

import type { JSX } from "react";
import type {
  CarbonSkeletonRecognition,
  RecognizedCarbon,
} from "../../science/recognition/carbonSkeleton";

export interface CarbonSkeletonResultProps {
  /** The recognition outcome to display (success or explicit failure). */
  readonly result: CarbonSkeletonRecognition;
  /** The original crop data URL shown beneath the overlay. */
  readonly imageDataUrl?: string | undefined;
  /** Called when the user dismisses the result. */
  readonly onDismiss: () => void;
}

/** Qualitative confidence band — we never surface the raw number as a %. */
function confidenceLabel(confidence: number): string {
  if (confidence >= 0.85) return "High confidence";
  if (confidence >= 0.6) return "Moderate confidence";
  return "Low confidence";
}

/** Human-readable name for the coarse topology shape. */
function shapeLabel(shape: "linear-chain" | "branched-chain" | "monocyclic"): string {
  switch (shape) {
    case "linear-chain":
      return "Straight chain";
    case "branched-chain":
      return "Branched chain";
    case "monocyclic":
      return "Single ring";
  }
}

/** Pluralise a count: `1 carbon`, `2 carbons`. */
function count(n: number, singular: string): string {
  return `${n} ${singular}${n === 1 ? "" : "s"}`;
}

/** Marker radius (in image-pixel units) sized relative to the crop. */
function markerRadius(imageWidth: number, imageHeight: number): number {
  const min = Math.min(imageWidth, imageHeight);
  // ~1.6% of the smaller dimension, clamped to a sensible pixel range.
  return Math.max(2, Math.min(9, min * 0.016));
}

function carbonClass(c: RecognizedCarbon): string {
  if (c.inRing) return "ito-cs-carbon ito-cs-carbon--ring";
  if (c.isBranch) return "ito-cs-carbon ito-cs-carbon--branch";
  if (c.isEndpoint) return "ito-cs-carbon ito-cs-carbon--endpoint";
  return "ito-cs-carbon";
}

export function CarbonSkeletonResult({
  result,
  imageDataUrl,
  onDismiss,
}: CarbonSkeletonResultProps): JSX.Element {
  return (
    <div data-testid="carbon-skeleton-result" className="ito-recognition-verify ito-cs-result">
      {result.success ? (
        <SuccessView result={result} imageDataUrl={imageDataUrl} />
      ) : (
        <FailureView result={result} imageDataUrl={imageDataUrl} />
      )}

      <div className="ito-annot-popover-actions">
        <button
          type="button"
          data-testid="carbon-skeleton-dismiss-btn"
          className="ito-ctx-item"
          onClick={onDismiss}
        >
          <span className="ito-ctx-item-label">Dismiss</span>
        </button>
      </div>
    </div>
  );
}

function SuccessView({
  result,
  imageDataUrl,
}: {
  result: Extract<CarbonSkeletonRecognition, { success: true }>;
  imageDataUrl?: string | undefined;
}): JSX.Element {
  const { carbons, bonds, topology, imageWidth, imageHeight } = result.skeleton;
  const r = markerRadius(imageWidth, imageHeight);
  // Index carbons by id so bond endpoints resolve to coordinates.
  const byId = new Map<number, RecognizedCarbon>();
  for (const c of carbons) byId.set(c.id, c);

  return (
    <>
      <div className="ito-cs-figure">
        {imageDataUrl && (
          <img
            data-testid="carbon-skeleton-crop"
            src={imageDataUrl}
            alt="Original crop"
            className="ito-cs-figure-img"
          />
        )}
        {/* The overlay shares the crop's coordinate space via viewBox; the
            browser scales image + SVG together, so the graph stays aligned. */}
        <svg
          data-testid="carbon-skeleton-svg"
          className="ito-cs-overlay"
          viewBox={`0 0 ${imageWidth} ${imageHeight}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="Reconstructed carbon skeleton overlaid on the crop"
        >
          <g className="ito-cs-bonds">
            {bonds.map((b, i) => {
              const a = byId.get(b.source);
              const c = byId.get(b.target);
              if (!a || !c) return null;
              return (
                <line
                  key={`bond-${i}`}
                  data-testid="carbon-skeleton-bond"
                  className="ito-cs-bond"
                  x1={a.x}
                  y1={a.y}
                  x2={c.x}
                  y2={c.y}
                />
              );
            })}
          </g>
          <g className="ito-cs-carbons">
            {carbons.map((c) => (
              <circle
                key={`carbon-${c.id}`}
                data-testid="carbon-skeleton-carbon"
                className={carbonClass(c)}
                cx={c.x}
                cy={c.y}
                r={r}
              />
            ))}
          </g>
        </svg>
      </div>

      <div data-testid="carbon-skeleton-success" className="ito-cs-summary">
        <div className="ito-cs-summary-title">Carbon skeleton recognised</div>
        <div data-testid="carbon-skeleton-counts" className="ito-cs-summary-counts">
          {count(topology.carbonCount, "carbon")} ·{" "}
          {count(topology.bondCount, "bond")} · {count(topology.ringCount, "ring")}
        </div>
        <div data-testid="carbon-skeleton-topology" className="ito-cs-summary-topology">
          {shapeLabel(topology.shape)}
        </div>
        <div data-testid="carbon-skeleton-confidence" className="ito-cs-summary-confidence">
          {confidenceLabel(result.confidence)}
        </div>
        <p className="ito-cs-summary-note">
          Analysis preview — nothing is saved to the annotation.
        </p>
      </div>
    </>
  );
}

function FailureView({
  result,
  imageDataUrl,
}: {
  result: Extract<CarbonSkeletonRecognition, { success: false }>;
  imageDataUrl?: string | undefined;
}): JSX.Element {
  return (
    <>
      {imageDataUrl && (
        <img
          data-testid="carbon-skeleton-crop"
          src={imageDataUrl}
          alt="Original crop"
          className="ito-area-figure-preview"
        />
      )}
      <div data-testid="carbon-skeleton-failure" className="ito-recognition-error">
        <div className="ito-cs-failure-title">
          Could not reliably recognise a carbon skeleton.
        </div>
        <div data-testid="carbon-skeleton-reason" className="ito-cs-failure-reason">
          {result.reason}
        </div>
      </div>
    </>
  );
}
