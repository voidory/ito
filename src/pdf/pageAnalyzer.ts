/**
 * M18 (FEAT-PDF-CACHE §4, §7, §10) the browser-side PAGE ANALYZER: convert ONE
 * pdf.js page into a deterministic, serializable {@link PdfPageAnalysis} for the
 * persistent cache. This is the single place the expensive semantic analysis
 * happens, and it happens ONCE per page during ingestion (§4).
 *
 * It separates PERSISTENT analysis from RUNTIME rendering (§7): it reads pdf.js
 * text content + page annotations + the viewport box, normalizes everything to
 * document coordinates (0..1), and returns a plain object. It touches NO canvas,
 * NO text-layer DOM, and retains NO pdf.js objects after it returns.
 *
 * The NORMALIZATION core ({@link normalizePageAnalysis}) is PURE + pdf.js-free
 * (it takes structural inputs), so geometry correctness is unit-tested without a
 * worker and the SAME math is reused by the live `textCache` extractor. The thin
 * browser wrapper ({@link analyzePdfPage}) pulls the structural inputs off a
 * real pdf.js page.
 */

import {
  PDF_ANALYSIS_VERSION,
  type NormalizedAnnotation,
  type NormalizedRect,
  type NormalizedTextItem,
  type PdfPageAnalysis,
} from "./analysisCache";
import { MIN_SPAN_NORM, type TextItemLike, type ViewportLike } from "./textCache";

/** The analysis-algorithm version this analyzer implements (for the manifest). */
export const PAGE_ANALYZER_VERSION = PDF_ANALYSIS_VERSION;

/** A structural view of a pdf.js annotation (only the fields we normalize). */
export interface AnnotationLike {
  readonly id?: string;
  readonly subtype?: string;
  /** pdf.js annotation rect [x1, y1, x2, y2] in PDF user space (y-up). */
  readonly rect?: readonly number[];
  readonly contents?: string;
  readonly url?: string;
  readonly unsafeUrl?: string;
}

/** Clamp a value into [0, 1]. */
function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * Normalize one pdf.js `TextItem` to a document-coordinate {@link
 * NormalizedTextItem} (§10). Mirrors the projection in `textCache`'s
 * `extractPreParsedPageLayout` (bottom-left y-up origin -> top-left y-down,
 * normalized + clamped to {@link MIN_SPAN_NORM}) so the cache geometry EQUALS
 * the live text-layer geometry (§19/§20 case 10). Pure.
 */
function normalizeTextItem(
  item: TextItemLike,
  vw: number,
  vh: number,
): NormalizedTextItem | null {
  const str = item.str ?? "";
  if (str.length === 0) return null;
  const t = item.transform ?? [1, 0, 0, 1, 0, 0];
  const scaleY = Math.abs(t[3] ?? t[0] ?? 1) || 1;
  const originX = t[4] ?? 0;
  const originYBottom = t[5] ?? 0;
  const itemW =
    item.width != null && item.width > 0 ? item.width : scaleY * 0.5 * Math.max(1, str.length);
  const itemH = item.height != null && item.height > 0 ? item.height : scaleY;
  const topPx = vh - originYBottom - itemH;
  const rect: NormalizedRect = {
    x: clamp01(originX / vw),
    y: clamp01(topPx / vh),
    width: Math.min(Math.max(MIN_SPAN_NORM, itemW / vw), 1),
    height: Math.min(Math.max(MIN_SPAN_NORM, itemH / vh), 1),
  };
  const angle = Math.atan2(t[1] ?? 0, t[0] ?? 1);
  return {
    str,
    rect,
    ...(Math.abs(angle) > 1e-6 ? { angleRad: angle } : {}),
    ...(item.isOcrSynthetic ? { isOcrSynthetic: true } : {}),
  };
}

/**
 * Normalize one pdf.js annotation rect [x1,y1,x2,y2] (PDF user space, y-up) to a
 * document-coordinate {@link NormalizedAnnotation} (§2). Pure. Returns null when
 * the rect is missing/degenerate.
 */
function normalizeAnnotation(
  ann: AnnotationLike,
  index: number,
  vw: number,
  vh: number,
): NormalizedAnnotation | null {
  const r = ann.rect;
  if (!r || r.length < 4) return null;
  const x1 = Math.min(r[0]!, r[2]!);
  const x2 = Math.max(r[0]!, r[2]!);
  const y1 = Math.min(r[1]!, r[3]!);
  const y2 = Math.max(r[1]!, r[3]!);
  const w = x2 - x1;
  const h = y2 - y1;
  // Flip y-up -> y-down: the TOP edge is (vh - y2).
  const rect: NormalizedRect = {
    x: clamp01(x1 / vw),
    y: clamp01((vh - y2) / vh),
    width: Math.min(Math.max(0, w / vw), 1),
    height: Math.min(Math.max(0, h / vh), 1),
  };
  const url = ann.url ?? ann.unsafeUrl;
  return {
    id: ann.id ?? `ann-${index}`,
    subtype: ann.subtype ?? "Unknown",
    rect,
    ...(ann.contents ? { contents: ann.contents } : {}),
    ...(url ? { url } : {}),
  };
}

/**
 * PURE normalization core (§10). Given a page's structural inputs — page number,
 * viewport box, text items, raw text, and annotations — produce the serializable
 * {@link PdfPageAnalysis}. No pdf.js, no DOM, so it is unit-tested directly and
 * its output is asserted equal to the live text-layer geometry (§20 case 10/11).
 *
 * Single pass over the text items (O(items)) and a single pass over the
 * annotations (O(annotations)) — no nested scans (§5). `geometry.textRects` is
 * exactly the per-item rects in the SAME order as `text.items`, so an index into
 * one indexes the other (no cross-join needed).
 */
export function normalizePageAnalysis(input: {
  readonly pageNumber: number;
  readonly viewport: ViewportLike;
  readonly textItems: readonly TextItemLike[];
  readonly annotations?: readonly AnnotationLike[];
}): PdfPageAnalysis {
  const vw = input.viewport.width > 0 ? input.viewport.width : 1;
  const vh = input.viewport.height > 0 ? input.viewport.height : 1;

  const items: NormalizedTextItem[] = [];
  const textRects: NormalizedRect[] = [];
  const contentParts: string[] = [];
  for (const raw of input.textItems) {
    const norm = normalizeTextItem(raw, vw, vh);
    if (!norm) continue;
    items.push(norm);
    textRects.push(norm.rect);
    contentParts.push(norm.str);
  }

  const annotations: NormalizedAnnotation[] = [];
  const rawAnns = input.annotations ?? [];
  for (let i = 0; i < rawAnns.length; i++) {
    const norm = normalizeAnnotation(rawAnns[i]!, i, vw, vh);
    if (norm) annotations.push(norm);
  }

  const rotation = (((input.viewport.rotation ?? 0) % 360) + 360) % 360;
  return {
    pageNumber: input.pageNumber,
    width: input.viewport.width,
    height: input.viewport.height,
    rotation,
    text: { content: contentParts.join(""), items },
    geometry: { textRects },
    ...(annotations.length > 0 ? { annotations } : {}),
  };
}

/**
 * The structural shape of the pdf.js objects the browser wrapper reads. Declared
 * locally so this module does not hard-depend on the pdf.js type surface (which
 * keeps the pure core importable in tests).
 */
export interface PdfPageProxyLike {
  getViewport(params: { scale: number; rotation?: number }): {
    width: number;
    height: number;
    rotation?: number;
  };
  rotate: number;
  getTextContent(): Promise<{ items: readonly unknown[] }>;
  getAnnotations(): Promise<readonly unknown[]>;
}

export interface PdfDocumentProxyLike {
  getPage(pageNumber: number): Promise<PdfPageProxyLike>;
}

/**
 * Browser wrapper (§4): analyse ONE page of a live pdf.js document into a
 * serializable {@link PdfPageAnalysis}. Reads the text content + annotations +
 * the unscaled viewport box (scale 1, honouring the page `/Rotate`), delegates
 * all math to {@link normalizePageAnalysis}, and retains NO pdf.js objects after
 * returning (§7, §17). Annotation reads are best-effort: a page whose
 * `getAnnotations()` throws still yields its text/geometry analysis.
 */
export async function analyzePdfPage(
  doc: PdfDocumentProxyLike,
  pageNumber: number,
): Promise<PdfPageAnalysis> {
  const page = await doc.getPage(pageNumber);
  // Scale 1 captures the intrinsic page size in points; rotation honoured so a
  // 90/270 page records its displayed (rotated) box, matching the render path.
  const viewport = page.getViewport({ scale: 1, rotation: page.rotate });
  const textContent = await page.getTextContent();
  let annotations: readonly unknown[] = [];
  try {
    annotations = await page.getAnnotations();
  } catch {
    annotations = [];
  }
  return normalizePageAnalysis({
    pageNumber,
    viewport: {
      width: viewport.width,
      height: viewport.height,
      ...(viewport.rotation != null ? { rotation: viewport.rotation } : {}),
    },
    textItems: textContent.items as unknown as TextItemLike[],
    annotations: annotations as unknown as AnnotationLike[],
  });
}
