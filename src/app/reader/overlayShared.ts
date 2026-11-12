import { renderHighlightOverlay, type RenderedPage } from "../../pdf";
import type { AnnotationId, SourceId, TextAnchor } from "../../model";
import type { AnnotationView, HighlightColor } from "../workbench";

/**
 * Shared presentation types + pure helpers for the reader annotation overlays,
 * split out of AnnotationOverlays.tsx during the M10 structural unification so
 * the component modules stay small. Everything here is re-exported from
 * AnnotationOverlays.tsx (and Reader.tsx) so existing imports keep resolving.
 */

/* --------------------------------------------------------------------- */
/* Shared types                                                          */
/* --------------------------------------------------------------------- */

export interface OffloadedPopover {
  readonly evidenceId: string;
  readonly sourceId: SourceId;
  readonly sourceTitle: string;
  readonly quotedText: string;
  readonly comment: string;
  readonly pageNumber: number;
  readonly reason: string;
}

export interface ToolbarState {
  readonly sourceId: SourceId;
  readonly anchor: TextAnchor;
  readonly rect: AnchorRect;
}

export interface MenuState {
  readonly annotationId: AnnotationId;
  readonly sourceId: SourceId;
  readonly x: number;
  readonly y: number;
}

/**
 * A viewport-space rectangle used to anchor the fixed-position selection
 * toolbar and highlight edit popover. When a real getBoundingClientRect is
 * unavailable (jsdom returns width 0) the caller falls back to the pointer
 * clientX/clientY, which still yields a sensible anchor.
 */
export interface AnchorRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
}

export interface EditPopoverState {
  readonly annotationId: AnnotationId;
  readonly sourceId: SourceId;
  readonly rect: AnchorRect;
}

export type ContextMenuState =
  | {
      readonly variant: "annotation";
      readonly annotationId: AnnotationId;
      readonly sourceId: SourceId;
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly variant: "page";
      readonly sourceId: SourceId;
      readonly x: number;
      readonly y: number;
    };

/* --------------------------------------------------------------------- */
/* Shared helpers                                                        */
/* --------------------------------------------------------------------- */

/**
 * Clamp an anchor rect into viewport-space fixed coordinates for a floating
 * surface of a given width. The surface is centred over the anchor and clamped
 * 12px from each viewport edge, and sits above the anchor when there is room
 * (anchorTop > 64) otherwise just below it.
 */
export function clampFixedAnchor(
  rect: AnchorRect,
  surfaceWidth: number,
): { left: number; top: number } {
  const viewportWidth = (typeof window !== "undefined" && window.innerWidth) || 1024;
  const anchorCenterX = rect.left + rect.width / 2;
  const left = Math.max(
    12,
    Math.min(anchorCenterX - surfaceWidth / 2, viewportWidth - surfaceWidth - 12),
  );
  const top = rect.top > 64 ? rect.top - 48 : rect.bottom + 12;
  return { left, top };
}

/**
 * Derive an AnchorRect from a DOMRect, falling back to the pointer position
 * when the rect has zero width (jsdom's getBoundingClientRect commonly returns
 * zeros).
 */
export function anchorRectFrom(
  rect: DOMRect | null,
  pointerX: number,
  pointerY: number,
): AnchorRect {
  if (rect && rect.width > 0) {
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
    };
  }
  return {
    left: pointerX,
    top: pointerY,
    right: pointerX,
    bottom: pointerY,
    width: 0,
  };
}

export function swatch(c: HighlightColor): string {
  return { yellow: "#ffdd57", green: "#82dc96", blue: "#82beff", pink: "#ff96c8" }[c];
}

/** Escape an annotation id for use in a CSS attribute selector. */
export function cssEscapeId(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}

/**
 * Draw one annotation's overlay(s) across the rendered pages.
 *
 * Phase 1 (STRUCTURAL INDEXING): callers may pass an O(1) `resolvePage` lookup
 * (backed by the reader's `pageByIndex` map) to avoid the linear `pages.find`
 * per page. The signature is otherwise preserved — when `resolvePage` is
 * omitted the original `pages.find` is used, so existing callers/tests that
 * pass only the array keep working unchanged.
 */
export function drawAnnotation(
  view: AnnotationView,
  pages: readonly RenderedPage[],
  suppressMotion: boolean,
  animate: boolean,
  resolvePage?: (pageIndex: number) => RenderedPage | undefined,
): void {
  const pageAt = (pageIndex: number): RenderedPage | undefined =>
    resolvePage
      ? resolvePage(pageIndex)
      : pages.find((p) => Number(p.container.dataset.pageIndex ?? "-1") === pageIndex);
  if (view.annotation.scope.kind === "text") {
    const anchor = view.annotation.scope.anchor;
    const page = pageAt(anchor.pageIndex);
    if (!page) return;
    renderHighlightOverlay(page.stage, {
      kind: view.style.kind,
      color: view.style.color,
      rects: anchor.rects,
      animate,
      suppressMotion,
      annotationId: view.annotation.id,
    });
  } else if (view.annotation.scope.kind === "area") {
    const anchor = view.annotation.scope.anchor;
    const page = pageAt(anchor.pageIndex);
    if (!page) return;
    renderHighlightOverlay(page.stage, {
      kind: view.style.kind,
      color: view.style.color,
      rects: [anchor.rect],
      animate: false,
      suppressMotion,
      annotationId: view.annotation.id,
      areaBox: true,
      areaLabel: view.annotation.comment || "Area",
    });
  } else {
    const { startPageIndex, endPageIndex } = view.annotation.scope.anchor;
    for (let pi = startPageIndex; pi <= endPageIndex; pi++) {
      const page = pageAt(pi);
      if (!page) continue;
      renderHighlightOverlay(page.stage, {
        kind: view.style.kind,
        color: view.style.color,
        rects: [],
        animate: false,
        suppressMotion,
        annotationId: view.annotation.id,
        pageBorder: true,
      });
    }
  }
}

/**
 * Per-page rerender serializer. At most one rerender runs at a time; if newer
 * requests arrive while one is in flight only the LATEST target scale is
 * rendered next (intermediate targets are dropped).
 */
type RerenderState = { running: Promise<void> | null; pending: number | null };
const rerenderStates = new WeakMap<RenderedPage, RerenderState>();

export function serializedRerender(page: RenderedPage, scale: number): Promise<void> {
  let state = rerenderStates.get(page);
  if (!state) {
    state = { running: null, pending: null };
    rerenderStates.set(page, state);
  }
  if (state.running) {
    state.pending = scale;
    return state.running;
  }
  const run = (target: number): Promise<void> =>
    page.rerender(target).then(() => {
      const next = state!.pending;
      state!.pending = null;
      if (next !== null && next !== target) return run(next);
      state!.running = null;
      return undefined;
    });
  const started = run(scale);
  state.running = started;
  return started;
}

/** FEAT-002 (2.5) zoom bounds: step the PDF scale between 50% and 300%. */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
export function clampZoom(z: number): number {
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
  return next;
}

/**
 * Minimal defense-in-depth sanitizer for a stored website snapshot (A15, D11).
 * Strips <script>/<style> blocks, inline event handlers (quoted or unquoted),
 * and javascript: URLs so a snapshot can never execute script in the reader.
 */
export function sanitizeSnapshotHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/(\s)on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "$1")
    .replace(/javascript:/gi, "");
}
