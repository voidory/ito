/**
 * M18 (FEAT-PDF-CACHE §18) development-only performance instrumentation for the
 * PDF analysis cache. Records timings + counters around the pipeline so a claim
 * of "subsequent opens are cheaper" is BACKED BY MEASUREMENT, never asserted
 * blindly.
 *
 * It is DEV-ONLY and side-effect-light: when disabled every method is a cheap
 * no-op, so it can stay wired into the hot path without a production cost. The
 * clock is injected (defaults to `performance.now()` when available, else
 * `Date.now()`), so it runs in jsdom tests too.
 *
 * Phases measured (§18): document identification, pdf.js document loading, cache
 * lookup + hit/miss, per-page analysis (text / geometry / annotation extraction
 * roll up into the page span), cache write, cache hydration, first visible page,
 * first selectable page, full ingestion. Metrics recorded (§18): cold vs warm
 * open time, first-page time, full-analysis time, cache size, pages analysed,
 * cache hit rate.
 */

/** A single completed timing span (name + duration in ms). */
export interface PerfSpan {
  readonly name: string;
  readonly durationMs: number;
  readonly at: number;
}

/** The named phases we instrument (§18). Open-ended string union for clarity. */
export type PerfPhase =
  | "document-identification"
  | "pdfjs-document-load"
  | "cache-lookup"
  | "page-analysis"
  | "text-extraction"
  | "geometry-extraction"
  | "annotation-extraction"
  | "cache-write"
  | "cache-hydration"
  | "first-visible-page"
  | "first-selectable-page"
  | "full-ingestion"
  | (string & {});

/** Aggregated metrics a caller can read / log after an open (§18). */
export interface PerfMetrics {
  /** Whether this open was served from cache (warm) or required analysis (cold). */
  openKind: "cold" | "warm" | "resume" | null;
  /** Milliseconds from open start to the first visible page being usable. */
  firstPageMs: number | null;
  /** Milliseconds for the whole ingestion pass (cold/resume only). */
  fullAnalysisMs: number | null;
  /** Milliseconds for the warm cache hydration path. */
  warmOpenMs: number | null;
  coldOpenMs: number | null;
  pagesAnalyzed: number;
  /** Rolling hit rate across opens recorded by this collector instance. */
  cacheHits: number;
  cacheMisses: number;
  /** Approximate persisted cache size in bytes, when supplied by the caller. */
  cacheSizeBytes: number | null;
  spans: PerfSpan[];
}

/** Injected clock so instrumentation runs deterministically in tests. */
export type Clock = () => number;

function defaultClock(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

/**
 * True when dev instrumentation should be active. Honours an explicit override,
 * else Vite's `import.meta.env.DEV`. Guarded so it is safe under Node/jsdom
 * where `import.meta.env` may be absent.
 */
function devEnabledByDefault(): boolean {
  try {
    const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
    return env?.DEV === true;
  } catch {
    return false;
  }
}

/**
 * A lightweight perf collector for ONE document open (§18). Create one per open,
 * wrap each phase in {@link time} / {@link timeAsync}, record the open kind + a
 * couple of headline durations, then read {@link snapshot}. When `enabled` is
 * false every method is a no-op returning the wrapped value unchanged.
 */
export class PdfPerfCollector {
  private readonly clock: Clock;
  private readonly enabled: boolean;
  private readonly metrics: PerfMetrics = {
    openKind: null,
    firstPageMs: null,
    fullAnalysisMs: null,
    warmOpenMs: null,
    coldOpenMs: null,
    pagesAnalyzed: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheSizeBytes: null,
    spans: [],
  };

  constructor(opts?: { enabled?: boolean; clock?: Clock }) {
    this.enabled = opts?.enabled ?? devEnabledByDefault();
    this.clock = opts?.clock ?? defaultClock;
  }

  /** Time a synchronous phase and record a span. Returns the callback result. */
  time<T>(phase: PerfPhase, fn: () => T): T {
    if (!this.enabled) return fn();
    const start = this.clock();
    try {
      return fn();
    } finally {
      this.record(phase, this.clock() - start);
    }
  }

  /** Time an async phase and record a span. Returns the awaited result. */
  async timeAsync<T>(phase: PerfPhase, fn: () => Promise<T>): Promise<T> {
    if (!this.enabled) return fn();
    const start = this.clock();
    try {
      return await fn();
    } finally {
      this.record(phase, this.clock() - start);
    }
  }

  /** Record a span directly (for phases timed by external callbacks). */
  record(name: PerfPhase, durationMs: number): void {
    if (!this.enabled) return;
    this.metrics.spans.push({ name, durationMs, at: this.clock() });
  }

  /** Record which kind of open this was + roll into the hit/miss rate. */
  setOpenKind(kind: "cold" | "warm" | "resume"): void {
    if (!this.enabled) return;
    this.metrics.openKind = kind;
    if (kind === "warm") this.metrics.cacheHits += 1;
    else this.metrics.cacheMisses += 1;
  }

  setFirstPageMs(ms: number): void {
    if (this.enabled) this.metrics.firstPageMs = ms;
  }
  setFullAnalysisMs(ms: number): void {
    if (this.enabled) this.metrics.fullAnalysisMs = ms;
  }
  setWarmOpenMs(ms: number): void {
    if (this.enabled) this.metrics.warmOpenMs = ms;
  }
  setColdOpenMs(ms: number): void {
    if (this.enabled) this.metrics.coldOpenMs = ms;
  }
  setPagesAnalyzed(count: number): void {
    if (this.enabled) this.metrics.pagesAnalyzed = count;
  }
  setCacheSizeBytes(bytes: number): void {
    if (this.enabled) this.metrics.cacheSizeBytes = bytes;
  }

  /** The rolling cache hit rate in 0..1 (0 when no opens recorded). */
  hitRate(): number {
    const total = this.metrics.cacheHits + this.metrics.cacheMisses;
    return total === 0 ? 0 : this.metrics.cacheHits / total;
  }

  /** A deep-cloned snapshot of the current metrics (safe to log / assert). */
  snapshot(): PerfMetrics {
    return { ...this.metrics, spans: [...this.metrics.spans] };
  }

  /** Whether instrumentation is active (tests / conditional logging). */
  isEnabled(): boolean {
    return this.enabled;
  }
}
