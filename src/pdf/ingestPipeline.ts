/**
 * M18 (FEAT-PDF-CACHE §4, §5, §6, §15, §16) the ONE-PASS PDF ingestion pipeline.
 *
 * ------------------------------------------------------------------------
 * What it does
 * ------------------------------------------------------------------------
 * When no valid cache exists (or only a partial one), this pipeline analyses the
 * pages that still need analysis EXACTLY ONCE each, with BOUNDED concurrency,
 * persisting every page incrementally and advancing the manifest status as it
 * goes. It is the engine behind a cold open; a warm open skips it entirely.
 *
 * ------------------------------------------------------------------------
 * Complexity (§5)
 * ------------------------------------------------------------------------
 * The pipeline is O(number of pages to analyse). For each page it invokes the
 * caller's `analyzePage` callback ONCE and persists the result ONCE — there is
 * NO page×page, item×item, or page×annotation nested scan anywhere in this file.
 * The per-page analysis cost (text + geometry + annotations) is inherently
 * O(items on that page), so the whole first-import pass is
 * O(pages + Σ items + Σ annotations) = O(n), with n the total PDF content.
 *
 * ------------------------------------------------------------------------
 * Bounded concurrency + prioritisation (§15)
 * ------------------------------------------------------------------------
 * It does NOT fan every page out at once (that turns a large PDF into a CPU /
 * memory spike). A fixed worker pool (default {@link DEFAULT_ANALYSIS_CONCURRENCY}
 * = 3, isolated so it can be benchmarked / tuned) pulls page numbers off a
 * PRIORITISED queue: the current + nearby pages first, then outward. A page is
 * never analysed twice (the queue is a set-backed ordered list), the whole run
 * is cancellable (document switch, §20 case 15), and only completed pages are
 * held — temporary extraction structures are released by the caller's callback.
 *
 * ------------------------------------------------------------------------
 * Incremental persistence + resume (§6, §16)
 * ------------------------------------------------------------------------
 * Each analysed page is written through the {@link PdfAnalysisStore} immediately
 * and the manifest's `analyzedPages` is advanced, so an interruption leaves a
 * valid PARTIAL cache. The next open validates that partial cache and resumes
 * only the missing pages. The manifest only reaches `"complete"` after every
 * required page has been persisted.
 *
 * This module is DOM-free + pdf.js-free: the browser supplies an `analyzePage`
 * callback that does the actual pdf.js work, so the SCHEDULING logic here is
 * unit-testable with a synthetic analyzer.
 */

import type { PdfAnalysisStore } from "../storage/pdfAnalysisStore";
import {
  pagesToAnalyze,
  validateCache,
  withPageAnalyzed,
  withProcessing,
  type CacheValidation,
  type PdfAnalysisManifest,
  type PdfPageAnalysis,
} from "./analysisCache";

/**
 * Bounded page-analysis concurrency (§15). Three concurrent pdf.js page
 * analyses balances throughput against CPU/memory on a single worker. ISOLATED
 * as a named constant so it can be benchmarked and tuned without hunting
 * through the scheduler.
 */
export const DEFAULT_ANALYSIS_CONCURRENCY = 3 as const;

/** A cancellation handle for an in-flight ingestion run (§15, §20 case 15). */
export interface IngestionController {
  /** Cancel the run; in-flight page callbacks finish but no new ones start. */
  cancel(): void;
  /** True once {@link cancel} has been called. */
  readonly cancelled: boolean;
}

/** Create a fresh cancellation controller. */
export function createIngestionController(): IngestionController {
  let cancelled = false;
  return {
    cancel() {
      cancelled = true;
    },
    get cancelled() {
      return cancelled;
    },
  };
}

/**
 * Order a set of page numbers by proximity to the current page (§9, §15), so
 * the scheduler analyses the visible page and its neighbours FIRST and distant
 * pages last. Stable + deterministic: the current page, then alternating
 * forward/backward neighbours (1, +1, -1, +2, -2, …), then any remainder in
 * ascending order. Pure — unit-testable.
 */
export function prioritizePages(
  pages: readonly number[],
  currentPage: number,
): number[] {
  const set = new Set(pages);
  const ordered: number[] = [];
  const take = (p: number): void => {
    if (set.has(p)) {
      ordered.push(p);
      set.delete(p);
    }
  };
  take(currentPage);
  const maxSpread = Math.max(
    currentPage - Math.min(...pages, currentPage),
    Math.max(...pages, currentPage) - currentPage,
  );
  for (let d = 1; d <= maxSpread; d++) {
    take(currentPage + d);
    take(currentPage - d);
  }
  // Any leftovers (defensive; e.g. pages far outside the spread estimate).
  for (const p of [...set].sort((a, b) => a - b)) ordered.push(p);
  return ordered;
}

/**
 * Analyse ONE page: the browser supplies this. Must be deterministic and must
 * NOT hold runtime state after it returns (release pdf.js page objects + temp
 * extraction structures). Receiving an {@link IngestionController} lets a
 * long-running analyzer bail out early on cancellation.
 */
export type PageAnalyzer = (
  pageNumber: number,
  controller: IngestionController,
) => Promise<PdfPageAnalysis>;

/** Progress callback invoked after each page is persisted (§18 instrumentation). */
export interface IngestionProgress {
  onPageAnalyzed?(pageNumber: number, analyzedCount: number, total: number): void;
  onComplete?(manifest: PdfAnalysisManifest): void;
  onCancelled?(manifest: PdfAnalysisManifest): void;
}

export interface RunIngestionArgs {
  readonly store: PdfAnalysisStore;
  /** The manifest to resume/fill. Must already exist in the store. */
  readonly manifest: PdfAnalysisManifest;
  /** Pages still needing analysis (from {@link pagesToAnalyze}). */
  readonly pages: readonly number[];
  readonly analyzePage: PageAnalyzer;
  readonly controller: IngestionController;
  readonly currentPage?: number;
  readonly concurrency?: number;
  readonly progress?: IngestionProgress;
  /** Clock injection for deterministic manifest timestamps in tests. */
  readonly now?: () => string;
}

/**
 * Run the one-pass ingestion (§4, §6, §15, §16). Returns the FINAL manifest
 * (complete, or partial if cancelled). The algorithm:
 *   1. mark the manifest `processing` (persist),
 *   2. prioritise the pages-to-analyse around `currentPage`,
 *   3. run a fixed worker pool pulling pages off the shared cursor — each page
 *      analysed once, persisted immediately, manifest advanced immediately,
 *   4. stop starting new pages once cancelled; finish in-flight ones.
 *
 * There is a SINGLE shared cursor over the prioritised page list, so no page is
 * ever claimed by two workers (no duplicate work, §15) and the total callback
 * count equals the number of pages to analyse (O(n), §5).
 */
export async function runIngestion(args: RunIngestionArgs): Promise<PdfAnalysisManifest> {
  const {
    store,
    pages,
    analyzePage,
    controller,
    concurrency = DEFAULT_ANALYSIS_CONCURRENCY,
    currentPage = 1,
    progress,
    now,
  } = args;

  let manifest = withProcessing(args.manifest, now?.());
  await store.writeManifest(manifest);

  if (pages.length === 0) {
    // Nothing to do (already complete). Return as-is.
    progress?.onComplete?.(manifest);
    return manifest;
  }

  const queue = prioritizePages(pages, currentPage);
  const total = manifest.pageCount;
  let cursor = 0;

  // A mutex-free manifest advance: workers await this serially via a promise
  // chain so two concurrent persists never race on the manifest record.
  let manifestChain: Promise<void> = Promise.resolve();
  const advanceManifest = (pageNumber: number): Promise<void> => {
    manifestChain = manifestChain.then(async () => {
      manifest = withPageAnalyzed(manifest, pageNumber, now?.());
      await store.writeManifest(manifest);
      progress?.onPageAnalyzed?.(pageNumber, manifest.analyzedPages.length, total);
    });
    return manifestChain;
  };

  async function worker(): Promise<void> {
    for (;;) {
      if (controller.cancelled) return;
      const index = cursor;
      cursor += 1;
      if (index >= queue.length) return;
      const pageNumber = queue[index]!;
      const analysis = await analyzePage(pageNumber, controller);
      if (controller.cancelled) {
        // Still persist the finished page (it is valid work), but do not pull
        // another: the partial cache stays resumable.
        await store.writePage(manifest.documentId, analysis);
        await advanceManifest(pageNumber);
        return;
      }
      await store.writePage(manifest.documentId, analysis);
      await advanceManifest(pageNumber);
    }
  }

  const poolSize = Math.max(1, Math.min(concurrency, queue.length));
  const workers: Promise<void>[] = [];
  for (let i = 0; i < poolSize; i++) workers.push(worker());
  await Promise.all(workers);
  await manifestChain;

  if (controller.cancelled && manifest.status !== "complete") {
    progress?.onCancelled?.(manifest);
  } else if (manifest.status === "complete") {
    progress?.onComplete?.(manifest);
  }
  return manifest;
}

/**
 * The high-level open path (§8 fast-path). Given the freshly opened document's
 * identity + page count, decide hit / resume / miss against the stored manifest
 * and, when work is needed, run the one-pass ingestion. Returns the validation
 * decision and the final manifest so the caller can log cache hit/miss (§18).
 *
 * On a HIT this does NO page analysis at all — it returns immediately after the
 * O(1) manifest read + validate (§8). On a MISS/RESUME it creates/keeps the
 * manifest and ingests only the pages that still need analysis.
 */
export async function openWithCache(args: {
  readonly store: PdfAnalysisStore;
  readonly documentId: string;
  readonly freshManifest: PdfAnalysisManifest;
  readonly analyzePage: PageAnalyzer;
  readonly controller: IngestionController;
  readonly currentPage?: number;
  readonly concurrency?: number;
  readonly progress?: IngestionProgress;
  readonly now?: () => string;
}): Promise<{ validation: CacheValidation; manifest: PdfAnalysisManifest }> {
  const stored = await args.store.readManifest(args.documentId);
  const validation = validateCache(stored, {
    sourceFingerprint: args.freshManifest.sourceFingerprint,
    pageCount: args.freshManifest.pageCount,
  });

  if (validation.kind === "hit") {
    // Warm open: nothing to analyse. The manifest is the stored one.
    return { validation, manifest: stored! };
  }

  // MISS: a mismatch (schema / analysis / fingerprint / page-count / corrupt /
  // status-invalid). Discard any stale document records and start fresh so a
  // changed PDF never keeps a byte of the previous analysis.
  let manifest: PdfAnalysisManifest;
  if (validation.kind === "miss") {
    await args.store.deleteDocument(args.documentId);
    manifest = args.freshManifest;
    await args.store.writeManifest(manifest);
  } else {
    // RESUME: keep the valid partial manifest (it matched identity + versions);
    // continue the pages it is missing.
    manifest = stored!;
  }

  const pages = pagesToAnalyze(validation, args.freshManifest.pageCount);
  const final = await runIngestion({
    store: args.store,
    manifest,
    pages,
    analyzePage: args.analyzePage,
    controller: args.controller,
    ...(args.currentPage != null ? { currentPage: args.currentPage } : {}),
    ...(args.concurrency != null ? { concurrency: args.concurrency } : {}),
    ...(args.progress ? { progress: args.progress } : {}),
    ...(args.now ? { now: args.now } : {}),
  });
  return { validation, manifest: final };
}
