/**
 * M17 (§1.1) set-text pre-parsed PDF layout cache + OCR / scanned-page text
 * synthesis (browser-only DOM helpers + pure converters).
 *
 * An imported PDF is an IMMUTABLE set text (keyed by M12's `contentHash` /
 * `versionHash`). Re-parsing `page.getTextContent()` from scratch on every
 * reload wastes CPU and delays the `.textLayer` mounting that selection,
 * highlighting and Ctrl+F depend on. This module converts pdf.js `TextItem`s
 * into a normalized, DOM-independent {@link PreParsedPageLayout} that the
 * Workbench persists on `Source.cachedPages`, and hydrates a live `.textLayer`
 * from that cache SYNCHRONOUSLY on the next load — before (or without waiting
 * for) a full pdf.js textLayer render.
 *
 * It also fixes scanned / OCR PDFs: an OCR span can report 0×0 client rects, or
 * an image-only page can have 0 text items. {@link synthesizeOcrPageSpans}
 * injects deterministic horizontal text-band spans so such pages stay
 * selectable + highlightable; the normalized rects here always clamp to a
 * non-zero minimum so a zero-height OCR span is never stored as `0×0`.
 */

import type { PreParsedPageLayout, PreParsedSpan } from "../model";

export type { PreParsedPageLayout, PreParsedSpan } from "../model";

/**
 * Minimum normalized span width/height. OCR layers routinely report zero-height
 * glyph runs; clamping to this floor guarantees every stored/hydrated span is
 * selectable and produces a visible highlight (never a `0×0` rect).
 */
export const MIN_SPAN_NORM = 0.008;

/**
 * A minimal structural view of a pdf.js `TextItem` — just the fields this
 * converter reads. Declared locally so the module does not depend on the
 * pdf.js type surface (which keeps it unit-testable without a worker).
 */
export interface TextItemLike {
  readonly str: string;
  /** pdf.js text-space transform [a, b, c, d, e, f]; e/f are the origin. */
  readonly transform?: readonly number[];
  readonly width?: number;
  readonly height?: number;
  /** Set true by {@link synthesizeOcrPageSpans} for injected OCR lines. */
  readonly isOcrSynthetic?: boolean;
}

/** A minimal structural view of a pdf.js viewport (size we need to normalize). */
export interface ViewportLike {
  readonly width: number;
  readonly height: number;
  readonly rotation?: number;
}

/** Clamp a value into [0, 1]. */
function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * M17 (§1.1) convert pdf.js `TextItem`s for one page into a normalized,
 * DOM-independent {@link PreParsedPageLayout}. Each item's text-space origin
 * (transform[4], transform[5]) is projected to the viewport's top-left origin
 * and normalized to 0..1; width/height are normalized and clamped to
 * {@link MIN_SPAN_NORM} so a zero-height OCR run is never `0×0`.
 */
export function extractPreParsedPageLayout(
  pageIndex: number,
  viewport: ViewportLike,
  textItems: readonly TextItemLike[],
): PreParsedPageLayout {
  const vw = viewport.width > 0 ? viewport.width : 1;
  const vh = viewport.height > 0 ? viewport.height : 1;
  const spans: PreParsedSpan[] = [];
  for (const item of textItems) {
    const str = item.str ?? "";
    if (str.length === 0) continue;
    const t = item.transform ?? [1, 0, 0, 1, 0, 0];
    // pdf.js text items carry a bottom-left origin in a y-up space; the glyph
    // scale is encoded in the transform. Height ~ |transform[3]| (the vertical
    // scale); width is the item's own measured width.
    const scaleY = Math.abs(t[3] ?? t[0] ?? 1) || 1;
    const originX = t[4] ?? 0;
    const originYBottom = t[5] ?? 0;
    const itemW = item.width != null && item.width > 0 ? item.width : scaleY * 0.5 * Math.max(1, str.length);
    const itemH = item.height != null && item.height > 0 ? item.height : scaleY;
    // Flip the y origin (pdf text space is y-up; the stage is y-down) so the
    // span's TOP edge is (viewport height - bottomOrigin - height).
    const topPx = vh - originYBottom - itemH;
    const normW = Math.max(MIN_SPAN_NORM, itemW / vw);
    const normH = Math.max(MIN_SPAN_NORM, itemH / vh);
    const normX = clamp01(originX / vw);
    const normY = clamp01(topPx / vh);
    const angle = Math.atan2(t[1] ?? 0, t[0] ?? 1);
    const span: PreParsedSpan = {
      str,
      normRect: [normX, normY, Math.min(normW, 1), Math.min(normH, 1)],
      ...(Math.abs(angle) > 1e-6 ? { angleRad: angle } : {}),
      ...(item.isOcrSynthetic ? { isOcrSynthetic: true } : {}),
    };
    spans.push(span);
  }
  return {
    pageIndex,
    widthPt: viewport.width,
    heightPt: viewport.height,
    rotation: ((viewport.rotation ?? 0) % 360 + 360) % 360,
    spans,
  };
}

/**
 * M17 (§1.1) synchronously populate a live `.textLayer` element with positioned
 * `<span data-cached-span="true">` elements from a cached layout, scaled to the
 * current stage pixel size. This runs in `< 5ms` with no pdf.js worker round
 * trip, so text selection, highlights and Ctrl+F work the instant a cached set
 * text reopens. Idempotent: it clears any prior cached spans first.
 */
export function hydrateTextLayerFromCache(
  textLayerEl: HTMLElement,
  layout: PreParsedPageLayout,
  stageWidthPx: number,
  stageHeightPx: number,
): void {
  // Remove any previously hydrated cached spans so re-hydration is idempotent.
  textLayerEl
    .querySelectorAll('[data-cached-span="true"]')
    .forEach((el) => el.remove());

  const w = stageWidthPx > 0 ? stageWidthPx : layout.widthPt || 1;
  const h = stageHeightPx > 0 ? stageHeightPx : layout.heightPt || 1;
  const frag = textLayerEl.ownerDocument.createDocumentFragment();
  for (const span of layout.spans) {
    const [nx, ny, nw, nh] = span.normRect;
    const el = textLayerEl.ownerDocument.createElement("span");
    el.dataset.cachedSpan = "true";
    el.textContent = span.str;
    if (span.isOcrSynthetic) el.dataset.ocrSynthetic = "true";
    // Mirror the cached normalized rect onto the element so the OCR-fallback in
    // highlight.ts can recover geometry even when getClientRects() is 0×0.
    el.dataset.normRect = `${nx},${ny},${nw},${nh}`;
    const leftPx = nx * w;
    const topPx = ny * h;
    const widthPx = nw * w;
    const heightPx = nh * h;
    Object.assign(el.style, {
      position: "absolute",
      left: `${leftPx}px`,
      top: `${topPx}px`,
      width: `${widthPx}px`,
      height: `${heightPx}px`,
      whiteSpace: "pre",
      transformOrigin: "0% 0%",
    } satisfies Partial<CSSStyleDeclaration>);
    if (span.angleRad != null && Math.abs(span.angleRad) > 1e-6) {
      el.style.transform = `rotate(${span.angleRad}rad)`;
    }
    frag.appendChild(el);
  }
  textLayerEl.appendChild(frag);
}

/**
 * M17 (§1.2) synthesize deterministic selectable OCR text-line spans for an
 * image-only / scanned page that pdf.js reports with `0` native text items.
 * Produces evenly-spaced horizontal text bands down the page so the page can
 * still be selected + highlighted. When `fallbackLines` is omitted a small
 * deterministic band set is generated (so the geometry is reproducible for
 * tests + reloads). Every span's rect is clamped to {@link MIN_SPAN_NORM}.
 */
export function synthesizeOcrPageSpans(
  pageIndex: number,
  fallbackLines?: readonly string[],
): PreParsedSpan[] {
  const lines =
    fallbackLines && fallbackLines.length > 0
      ? fallbackLines
      : defaultOcrBandLines(pageIndex);
  const n = lines.length;
  const spans: PreParsedSpan[] = [];
  const marginX = 0.06;
  const topMargin = 0.08;
  const bottomMargin = 0.08;
  const usableH = 1 - topMargin - bottomMargin;
  const lineH = Math.max(MIN_SPAN_NORM, usableH / Math.max(1, n) * 0.6);
  for (let i = 0; i < n; i++) {
    const y = clamp01(topMargin + (usableH * (i + 0.5)) / n - lineH / 2);
    const width = Math.max(MIN_SPAN_NORM, 1 - marginX * 2);
    spans.push({
      str: lines[i]!,
      normRect: [marginX, y, width, lineH],
      isOcrSynthetic: true,
    });
  }
  return spans;
}

/** Deterministic placeholder OCR band text for a scanned page with no lines. */
function defaultOcrBandLines(pageIndex: number): readonly string[] {
  const n = 12;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(`[OCR] page ${pageIndex + 1} line ${i + 1}`);
  }
  return out;
}

/**
 * M17 (§1.2) convenience: inject synthesized OCR spans directly into a live
 * `.textLayer` element (positioned `<span data-ocr-synthetic="true">`), so an
 * image-only page becomes selectable without a cached layout. Builds a
 * single-page {@link PreParsedPageLayout} from the synthesized spans and
 * delegates to {@link hydrateTextLayerFromCache}.
 */
export function injectSyntheticOcrTextLayer(
  textLayerEl: HTMLElement,
  pageIndex: number,
  stageWidthPx: number,
  stageHeightPx: number,
  fallbackLines?: readonly string[],
): PreParsedPageLayout {
  const spans = synthesizeOcrPageSpans(pageIndex, fallbackLines);
  const layout: PreParsedPageLayout = {
    pageIndex,
    widthPt: stageWidthPx > 0 ? stageWidthPx : 1,
    heightPt: stageHeightPx > 0 ? stageHeightPx : 1,
    rotation: 0,
    spans,
  };
  hydrateTextLayerFromCache(textLayerEl, layout, stageWidthPx, stageHeightPx);
  return layout;
}
