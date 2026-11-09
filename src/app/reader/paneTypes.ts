import type { PDFDocumentProxy } from "pdfjs-dist";
import type { AnchorResolution, SourceId, TextAnchor } from "../../model";
import type { NormalizedRect } from "../../model";

/**
 * Shared reader-pane types + the rAF scroll coalescer, extracted from
 * Reader.tsx during the FEAT-002 decomposition so SourcePane / EvidenceLines
 * can import them WITHOUT importing Reader.tsx (which would be circular, since
 * Reader.tsx imports those modules). Reader.tsx re-exports PaneCommands,
 * ScrollCoalescer and createScrollCoalescer as a barrel so every existing
 * import (tests + testApi.ts) keeps resolving unchanged.
 */

/**
 * Imperative commands the single reader toolbar drives on the primary source
 * pane (zoom / paging / find). The pane registers an implementation via
 * `registerCommands`; the shell calls them from the toolbar buttons.
 */
export interface PaneCommands {
  readonly zoomIn: () => void;
  readonly zoomOut: () => void;
  readonly resetZoom: () => void;
  readonly fitWidth: () => void;
  readonly goToPage: (pageNumber: number) => void;
  readonly openFind: () => void;
  /** The live pdf.js document for the left-sidebar thumbnails/outline. */
  readonly getDoc: () => PDFDocumentProxy | null;
}

/** A pending source-return request (spec section 8.2, A17). */
export interface ReturnTarget {
  readonly sourceId: SourceId;
  readonly anchor: TextAnchor | null;
  readonly pageIndex: number;
  readonly resolution: AnchorResolution;
  /** Monotonic nonce so repeat returns to the same quote re-trigger the scroll. */
  readonly nonce: number;
}

/** FEAT-002 (2.4b) the live rubber-band box while dragging an area selection. */
export interface AreaDragState {
  readonly pageIndex: number;
  /** Normalized (0..1) rect relative to the originating pdf-page-stage. */
  readonly rect: NormalizedRect;
}

/**
 * FEAT-003 (3.3) a requestAnimationFrame scroll coalescer. Scrolling the
 * SourcePane used to call the root bump() on EVERY scroll tick, which forces a
 * whole-app re-render (every open pane, the subject editor, the network search)
 * on each wheel/touch frame. The inter-pane evidence lines already recompute
 * themselves from a local, rAF-coalesced scroll listener (PassageEvidenceLines)
 * and the per-page highlight overlays are painted directly into the DOM, so the
 * scroll handler never needs to go through React at all.
 *
 * This helper keeps at most ONE frame scheduled at a time: repeated schedule()
 * calls within a single frame collapse into a single `onFrame` invocation, and
 * cancel() tears the pending frame down on unmount. It is pure (no React) so it
 * can be unit-tested headlessly, and it NEVER calls bump().
 */
export interface ScrollCoalescer {
  /** Request an `onFrame` run on the next animation frame (coalesced). */
  readonly schedule: () => void;
  /** Cancel any pending frame (call on unmount). */
  readonly cancel: () => void;
}

export function createScrollCoalescer(onFrame: () => void): ScrollCoalescer {
  let frame = 0;
  const raf =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (cb: FrameRequestCallback): number => setTimeout(() => cb(0), 16) as unknown as number;
  const caf =
    typeof cancelAnimationFrame === "function"
      ? cancelAnimationFrame
      : (handle: number): void => clearTimeout(handle);
  const schedule = (): void => {
    // A frame is already pending: coalesce this tick into it (do not stack).
    if (frame !== 0) return;
    frame = raf(() => {
      frame = 0;
      onFrame();
    });
  };
  const cancel = (): void => {
    if (frame !== 0) {
      caf(frame);
      frame = 0;
    }
  };
  return { schedule, cancel };
}
