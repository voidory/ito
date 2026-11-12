/**
 * M18 (FEAT-PDF-CACHE §2, §3, §12, §13) the versioned, ITO-specific PERSISTENT
 * PDF ANALYSIS CACHE schema + its PURE identity / validation / invalidation
 * logic.
 *
 * ------------------------------------------------------------------------
 * Why this exists
 * ------------------------------------------------------------------------
 * ITO pays an expensive, deterministic analysis cost the FIRST time a PDF is
 * imported: pdf.js text extraction, normalized text geometry, annotation
 * extraction, page metadata. Re-doing all of that every time the same document
 * is reopened is pure waste. This module defines the serializable representation
 * of that one-time analysis so a subsequent open is an O(1) manifest lookup plus
 * O(k) work for the pages actually displayed.
 *
 * ------------------------------------------------------------------------
 * What is (and is NOT) persisted (§2, §7)
 * ------------------------------------------------------------------------
 * PERSIST — deterministic, reusable, serializable information ONLY:
 *   - page metadata (width / height / rotation),
 *   - extracted + normalized text (content string + normalized text items),
 *   - normalized text geometry (document-coordinate rects, 0..1),
 *   - normalized annotations.
 * NEVER PERSIST — non-serializable runtime state:
 *   - pdf.js PDFDocumentProxy / PDFPageProxy, canvases, text-layer DOM nodes,
 *     selection / viewport / zoom. Rendering stays a runtime concern.
 *
 * ------------------------------------------------------------------------
 * Versioning (§12, §13)
 * ------------------------------------------------------------------------
 * Two INDEPENDENT version axes gate a cache hit:
 *   - `schemaVersion`  — the SHAPE of the persisted records. Bump when the
 *                        serialized layout changes (fields added/removed/retyped).
 *   - `analysisVersion`— the ALGORITHM that produced the content. Bump (semver)
 *                        when an extraction/geometry algorithm changes so cached
 *                        results would differ from a fresh analysis.
 * A manifest is only a valid HIT when BOTH match the running build AND the
 * document fingerprint matches (same bytes / same document). Any mismatch is a
 * MISS that forces reanalysis — never a silent stale read.
 *
 * This module is PURE + SYNCHRONOUS + DOM-free (no pdf.js, no IndexedDB), so it
 * runs identically in jsdom unit tests and the browser. Persistence lives in
 * `src/storage/pdfAnalysisStore.ts`; the one-pass ingestion that fills a cache
 * lives in `src/pdf/ingestPipeline.ts`.
 */

import { computeByteHash } from "./fingerprint";
import type { NormalizedRect } from "../model";

export type { NormalizedRect } from "../model";

// ---------------------------------------------------------------------------
// Version constants
// ---------------------------------------------------------------------------

/**
 * The SHAPE version of the persisted analysis records. Bump this whenever the
 * serialized {@link PdfAnalysisManifest} / {@link PdfPageAnalysis} layout
 * changes in a way that would make an older record mis-read. A manifest whose
 * `schemaVersion` differs from this value is invalidated on read (§12).
 */
export const PDF_ANALYSIS_SCHEMA_VERSION = 1 as const;

/**
 * The ALGORITHM version of the analysis content (semver). Bump this when an
 * extraction / normalization / geometry algorithm changes so cached output
 * would no longer equal a fresh analysis — even though the record SHAPE is
 * unchanged. A manifest whose `analysisVersion` differs is invalidated (§13).
 *
 * Kept separate from the schema version so a pure algorithm improvement does
 * not require a shape migration, and a shape change does not falsely imply the
 * algorithm changed.
 */
export const PDF_ANALYSIS_VERSION = "1.0.0" as const;

// ---------------------------------------------------------------------------
// Normalized, serializable sub-records (§2, §7, §10)
// ---------------------------------------------------------------------------

/**
 * `NormalizedRect` (re-exported from the model) is a rectangle in DOCUMENT
 * coordinates: x / y / width / height in 0..1 relative to the page box (§10
 * semantic geometry). Zoom / scroll / viewport transforms multiply these at
 * render time; they are NEVER re-measured from the DOM on a viewport change.
 *
 * One normalized text item extracted from a page (§2). `str` is the glyph run;
 * `rect` is its normalized document-coordinate box; `angleRad` captures a
 * rotated baseline (rotated scans / sideways tables). `isOcrSynthetic` marks a
 * synthesized OCR band for an image-only page so the runtime can distinguish it.
 */
export interface NormalizedTextItem {
  readonly str: string;
  readonly rect: NormalizedRect;
  readonly angleRad?: number;
  readonly isOcrSynthetic?: boolean;
}

/**
 * A normalized annotation extracted from the PDF itself (links, widget rects,
 * embedded highlights). DOM-independent: `rect` is normalized 0..1. This is the
 * PDF's OWN annotations, distinct from ITO's user annotations (which live on the
 * brain's `annotations` collection). Kept minimal + extensible (§13).
 */
export interface NormalizedAnnotation {
  readonly id: string;
  readonly subtype: string;
  readonly rect: NormalizedRect;
  readonly contents?: string;
  readonly url?: string;
}

/** Deterministic, reusable per-page analysis (§2, §6 incremental unit). */
export interface PdfPageAnalysis {
  /** 1-based page number (matches pdf.js `getPage(n)`). */
  readonly pageNumber: number;
  /** Page viewport width in PDF points (unrotated-independent display size). */
  readonly width: number;
  readonly height: number;
  /** Page `/Rotate` in degrees, normalized to {0,90,180,270}. */
  readonly rotation: number;
  readonly text?: {
    readonly content: string;
    readonly items: readonly NormalizedTextItem[];
  };
  readonly geometry?: {
    /** Normalized document-coordinate text rects (one per text item, ordered). */
    readonly textRects: readonly NormalizedRect[];
  };
  readonly annotations?: readonly NormalizedAnnotation[];
}

/** Optional document-level metadata (pdf.js `getMetadata().info`). */
export interface DocumentMetadata {
  readonly title?: string;
  readonly author?: string;
  readonly creationDate?: string;
  readonly modDate?: string;
}

/**
 * Analysis lifecycle status (§6). A manifest is only ever treated as a valid
 * completed cache when it is `"complete"`; a partially written cache is
 * `"partial"` / `"processing"` and resumed, never treated as done (§16).
 *   not-started — manifest created, no page persisted yet
 *   processing  — ingestion actively running (this session)
 *   partial     — some pages persisted, ingestion interrupted (resume candidate)
 *   complete    — every required page persisted + verified
 *   invalid     — identity/version mismatch or corruption; must be rebuilt
 */
export type AnalysisStatus =
  | "not-started"
  | "processing"
  | "partial"
  | "complete"
  | "invalid";

/**
 * The document-level MANIFEST (§2). Holds identity + version + status + the set
 * of pages already analysed. Pages themselves are stored SEPARATELY (one record
 * per page, see pdfAnalysisStore) so retrieving one page never deserializes the
 * whole document (§14). The manifest is small and O(1) to read on open.
 */
export interface PdfAnalysisManifest {
  readonly schemaVersion: number;
  /** Stable cache key for this document (see {@link computeDocumentId}). */
  readonly documentId: string;
  /** Strong content fingerprint used to detect byte / document changes (§3). */
  readonly sourceFingerprint: string;
  readonly fileSize: number;
  readonly pageCount: number;
  readonly analysisVersion: string;
  readonly documentMetadata?: DocumentMetadata;
  readonly status: AnalysisStatus;
  /** 1-based page numbers already persisted (sorted, deduped). Resume key (§16). */
  readonly analyzedPages: readonly number[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The FULL in-memory cache shape (§2) — the manifest plus every page. This is
 * the conceptual whole; on disk the manifest and pages are stored independently
 * so a reader can fetch just the pages it needs. Used by tests + the correctness
 * equivalence checks; the runtime fast path never materializes all pages.
 */
export interface PdfAnalysisCache {
  readonly schemaVersion: number;
  readonly documentId: string;
  readonly sourceFingerprint: string;
  readonly fileSize: number;
  readonly pageCount: number;
  readonly analysisVersion: string;
  readonly documentMetadata?: DocumentMetadata;
  readonly pages: readonly PdfPageAnalysis[];
}

// ---------------------------------------------------------------------------
// Document identity (§3)
// ---------------------------------------------------------------------------

/**
 * The inputs needed to establish document identity WITHOUT hashing the whole
 * file on every open (§3). A full cryptographic hash of a large PDF on every
 * open would itself defeat fast reopening, so identity layers cheap signals:
 *   - `fileSize`       — O(1); a changed size is always a different document.
 *   - `headTailHash`   — a fast FNV digest over a bounded HEAD+TAIL byte window
 *                        (captures the xref/trailer at the end + header at the
 *                        start, where edits concentrate). O(window), not O(n).
 *   - `pdfId`          — the PDF `/ID` trailer entry (pdf.js `getMetadata()`
 *                        `.fingerprints`) when present: a stable per-document id
 *                        the producer stamped. Strongest cheap signal.
 *   - `contentHash`    — the project's existing full-bytes FNV digest, supplied
 *                        ONLY when it was already computed for another purpose
 *                        (ingest already hashes bytes for the versionHash), so
 *                        we reuse it rather than re-hash.
 */
export interface DocumentIdentityInput {
  readonly fileSize: number;
  /** pdf.js document `/ID` fingerprints (`doc.fingerprints`), when available. */
  readonly pdfId?: string | null;
  /** Precomputed full-bytes content hash, reused if the caller already has it. */
  readonly contentHash?: string | null;
  /** Fast bounded head+tail digest; computed by {@link computeHeadTailHash}. */
  readonly headTailHash?: string | null;
}

/**
 * Number of bytes hashed from the START and END of a PDF for the fast
 * {@link computeHeadTailHash}. 64 KiB each side comfortably covers the header +
 * the trailer/xref (where revisions concentrate) while staying O(window)
 * regardless of file size, so identity never becomes O(n) on reopen (§3).
 */
export const HEAD_TAIL_WINDOW_BYTES = 64 * 1024;

/**
 * Compute a fast, bounded HEAD+TAIL digest of PDF bytes (§3). Hashes the first
 * and last {@link HEAD_TAIL_WINDOW_BYTES} bytes (the whole file when it is
 * smaller than two windows) plus the total length, so the digest is sensitive
 * to the header, the trailer/xref, and the size — the regions a revision almost
 * always touches — WITHOUT scanning the entire file. Deterministic (FNV-1a).
 *
 * Collision assumption: two DIFFERENT documents that share identical head+tail
 * windows AND identical length are astronomically unlikely for real PDFs; and
 * even then the identity is corroborated by `pdfId` / `contentHash` when those
 * are available. A false HIT would surface as a text/geometry mismatch which the
 * correctness equivalence check (§19) is designed to catch; the conservative
 * response to any doubt is a MISS (reanalysis), never a wrong render.
 */
export function computeHeadTailHash(bytes: Uint8Array): string {
  const n = bytes.length;
  if (n <= HEAD_TAIL_WINDOW_BYTES * 2) {
    return `${computeByteHash(bytes)}:${n}`;
  }
  const head = bytes.subarray(0, HEAD_TAIL_WINDOW_BYTES);
  const tail = bytes.subarray(n - HEAD_TAIL_WINDOW_BYTES, n);
  return `${computeByteHash(head)}:${computeByteHash(tail)}:${n}`;
}

/**
 * Derive the STABLE document id used as the cache key (§3). Preference order,
 * strongest cheap signal first:
 *   1. a precomputed full `contentHash` (exact bytes) — strongest, reused only;
 *   2. the PDF `/ID` fingerprint combined with size — a producer-stamped id;
 *   3. the fast head+tail digest (already carries the size).
 * The result is a short, prefixed, deterministic string so two opens of the
 * SAME document always map to the SAME key and a different document does not.
 */
export function computeDocumentId(input: DocumentIdentityInput): string {
  if (input.contentHash) return `c:${input.contentHash}`;
  if (input.pdfId && input.pdfId.length > 0) return `p:${input.pdfId}:${input.fileSize}`;
  if (input.headTailHash) return `h:${input.headTailHash}`;
  // Degenerate last resort (no bytes available, e.g. offloaded binary): size
  // alone. This is a WEAK key; a caller lacking any stronger signal should treat
  // a hit cautiously. Prefixed so it can never collide with a strong key.
  return `s:${input.fileSize}`;
}

/**
 * Compute the strong `sourceFingerprint` stored on the manifest and compared on
 * every open (§3). It binds the identity signals together so ANY change (bytes,
 * size, producer id) flips the fingerprint and forces reanalysis. Distinct from
 * `documentId`: the id is the lookup KEY, the fingerprint is the VALIDATION
 * value re-checked after lookup so a key collision cannot cause a stale read.
 */
export function computeSourceFingerprint(input: DocumentIdentityInput): string {
  const parts = [
    `size=${input.fileSize}`,
    input.contentHash ? `content=${input.contentHash}` : "",
    input.pdfId ? `id=${input.pdfId}` : "",
    input.headTailHash ? `ht=${input.headTailHash}` : "",
  ].filter((p) => p.length > 0);
  return parts.join("|");
}

// ---------------------------------------------------------------------------
// Validation + invalidation (§12)
// ---------------------------------------------------------------------------

/** Why a cache lookup produced a MISS (drives reanalysis / resume decisions). */
export type CacheMissReason =
  | "absent"
  | "schema-version-mismatch"
  | "analysis-version-mismatch"
  | "fingerprint-mismatch"
  | "page-count-mismatch"
  | "status-invalid"
  | "corrupt";

/** The outcome of validating a stored manifest against the current open (§12). */
export type CacheValidation =
  | { readonly kind: "hit"; readonly status: "complete" }
  | { readonly kind: "resume"; readonly analyzedPages: readonly number[] }
  | { readonly kind: "miss"; readonly reason: CacheMissReason };

/**
 * Decide whether a stored manifest is a usable cache for the current open (§12,
 * §16, §19). This is the SINGLE source of truth for invalidation. It is PURE so
 * the policy is pinned by unit tests.
 *
 * Invalidate (MISS) when:
 *   - the manifest is absent,
 *   - the schema version differs (shape drift, §12),
 *   - the analysis version differs (algorithm drift, §13),
 *   - the source fingerprint differs (bytes / document changed, §3/§12),
 *   - the stored page count disagrees with the freshly opened document,
 *   - the manifest is explicitly `"invalid"` or the record is corrupt.
 * A `"complete"` manifest that passes every check is a HIT. A `"partial"` /
 * `"processing"` / `"not-started"` manifest that otherwise matches is a RESUME
 * (continue the missing pages) — never silently treated as complete (§16).
 *
 * NOTE: it deliberately does NOT consider zoom / scroll / viewport / re-render /
 * reopen — those never invalidate analysis (§12).
 */
export function validateCache(
  manifest: PdfAnalysisManifest | null | undefined,
  current: {
    readonly sourceFingerprint: string;
    readonly pageCount: number;
    readonly schemaVersion?: number;
    readonly analysisVersion?: string;
  },
): CacheValidation {
  if (!manifest) return { kind: "miss", reason: "absent" };

  // Corruption guard: a record missing required identity fields is unusable.
  if (
    typeof manifest.sourceFingerprint !== "string" ||
    !Array.isArray(manifest.analyzedPages) ||
    typeof manifest.pageCount !== "number"
  ) {
    return { kind: "miss", reason: "corrupt" };
  }

  const schemaVersion = current.schemaVersion ?? PDF_ANALYSIS_SCHEMA_VERSION;
  const analysisVersion = current.analysisVersion ?? PDF_ANALYSIS_VERSION;

  if (manifest.schemaVersion !== schemaVersion) {
    return { kind: "miss", reason: "schema-version-mismatch" };
  }
  if (manifest.analysisVersion !== analysisVersion) {
    return { kind: "miss", reason: "analysis-version-mismatch" };
  }
  if (manifest.sourceFingerprint !== current.sourceFingerprint) {
    return { kind: "miss", reason: "fingerprint-mismatch" };
  }
  if (manifest.pageCount !== current.pageCount) {
    return { kind: "miss", reason: "page-count-mismatch" };
  }
  if (manifest.status === "invalid") {
    return { kind: "miss", reason: "status-invalid" };
  }

  // Validate the completeness invariant: a "complete" manifest MUST actually
  // carry every page. If it claims complete but is missing pages, treat it as a
  // resume rather than trusting the stale flag (defence in depth for §16).
  const have = new Set(manifest.analyzedPages);
  const missing: number[] = [];
  for (let p = 1; p <= manifest.pageCount; p++) {
    if (!have.has(p)) missing.push(p);
  }

  if (manifest.status === "complete" && missing.length === 0) {
    return { kind: "hit", status: "complete" };
  }
  // Partial / processing / not-started, or complete-but-missing: resume the
  // pages not yet analysed (empty array means "all pages still needed").
  return { kind: "resume", analyzedPages: [...manifest.analyzedPages].sort((a, b) => a - b) };
}

/**
 * The 1-based page numbers still needing analysis given a validation result and
 * the document's page count (§16). For a fresh/absent cache this is every page;
 * for a resume it is only the gaps. Returned sorted ascending so the scheduler
 * processes low pages (likely visible first) earliest.
 */
export function pagesToAnalyze(
  validation: CacheValidation,
  pageCount: number,
): number[] {
  const all: number[] = [];
  for (let p = 1; p <= pageCount; p++) all.push(p);
  if (validation.kind !== "resume") {
    // hit => nothing to do; miss => everything.
    return validation.kind === "hit" ? [] : all;
  }
  const have = new Set(validation.analyzedPages);
  return all.filter((p) => !have.has(p));
}

/**
 * Build a fresh, empty manifest for a first-time analysis (§6). Status starts
 * `"not-started"`; the ingestion pipeline advances it to `"processing"` then
 * `"partial"`/`"complete"` as pages persist.
 */
export function createManifest(input: {
  readonly documentId: string;
  readonly sourceFingerprint: string;
  readonly fileSize: number;
  readonly pageCount: number;
  readonly documentMetadata?: DocumentMetadata;
  readonly now?: string;
}): PdfAnalysisManifest {
  const now = input.now ?? new Date().toISOString();
  return {
    schemaVersion: PDF_ANALYSIS_SCHEMA_VERSION,
    documentId: input.documentId,
    sourceFingerprint: input.sourceFingerprint,
    fileSize: input.fileSize,
    pageCount: input.pageCount,
    analysisVersion: PDF_ANALYSIS_VERSION,
    ...(input.documentMetadata ? { documentMetadata: input.documentMetadata } : {}),
    status: "not-started",
    analyzedPages: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Return a new manifest with `pageNumber` recorded as analysed and the status
 * advanced (§6). Pure: callers persist the returned manifest. The status
 * becomes `"complete"` once every page is present, else `"partial"`. Dedupes
 * and keeps `analyzedPages` sorted so the record stays canonical and resume is
 * cheap. Never regresses a `"complete"` manifest.
 */
export function withPageAnalyzed(
  manifest: PdfAnalysisManifest,
  pageNumber: number,
  now?: string,
): PdfAnalysisManifest {
  const set = new Set(manifest.analyzedPages);
  set.add(pageNumber);
  const analyzedPages = [...set].sort((a, b) => a - b);
  const complete = analyzedPages.length >= manifest.pageCount;
  return {
    ...manifest,
    analyzedPages,
    status: complete ? "complete" : "partial",
    updatedAt: now ?? new Date().toISOString(),
  };
}

/** Mark a manifest as actively processing (this session) without losing pages. */
export function withProcessing(manifest: PdfAnalysisManifest, now?: string): PdfAnalysisManifest {
  if (manifest.status === "complete") return manifest;
  return { ...manifest, status: "processing", updatedAt: now ?? new Date().toISOString() };
}

/** Mark a manifest invalid so the next open rebuilds it (§12). */
export function withInvalidated(manifest: PdfAnalysisManifest, now?: string): PdfAnalysisManifest {
  return { ...manifest, status: "invalid", updatedAt: now ?? new Date().toISOString() };
}
