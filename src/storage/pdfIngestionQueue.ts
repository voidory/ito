/**
 * Batch PDF ingestion queue (M3, D09). PURE and DOM-free: it validates and
 * hashes raw PDF bytes with a bounded concurrency so a large drag-drop batch
 * never blocks the UI thread and never holds every file's bytes in RAM at once.
 *
 * The RAW byte processing lives here (validate %PDF- magic, enforce a per-file
 * size guard, compute the sha256 versionHash) so it is unit-testable without a
 * workbench. The caller (the workbench) supplies a `process` callback that
 * HYDRATES a matching Source or CREATES a new one and writes the bytes through
 * the StorageAdapter; the queue releases each file's bytes reference as soon as
 * its callback resolves so memory is freed before the next file starts.
 */

import { hasPdfMagic, sha256Hex } from "./hash";

/** One file handed to the queue: a name + its raw bytes. */
export interface IngestFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** The disposition of a single processed file. */
export interface IngestResult {
  readonly name: string;
  readonly status: "hydrated" | "created" | "rejected";
  readonly reason?: string;
  readonly versionHash?: string;
  /** The hydrated/created Source id ("" for a rejected file). */
  readonly sourceId: string;
}

/** What a hydrator reports back for one accepted file. */
export interface HydrateOutcome {
  readonly status: "hydrated" | "created";
  /** The id of the hydrated/created Source. */
  readonly sourceId: string;
}

/**
 * The hydration callback: given a validated file's name + bytes + computed
 * versionHash, hydrate a matching existing Source (status 'hydrated') or create
 * a new one (status 'created'), returning the resulting Source id. The queue
 * awaits this and then releases the bytes reference. The caller persists after
 * the batch.
 */
export type IngestHydrator = (input: {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly versionHash: string;
}) => Promise<HydrateOutcome>;

/** Tunable queue options; defaults match the D09 spec (2 / 100 MB). */
export interface IngestOptions {
  /** Max files processed in parallel. Default 2. */
  readonly concurrency?: number;
  /** Per-file size guard in bytes. Default 100 MB. */
  readonly maxBytes?: number;
}

/** The default per-file size guard: 100 MB. */
export const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
/** The default batch concurrency. */
export const DEFAULT_CONCURRENCY = 2;

/**
 * Process a batch of PDF files with bounded concurrency. Each file is validated
 * (%PDF- magic + size guard), hashed (sha256 -> versionHash), then handed to
 * the hydrator. Rejected files never reach the hydrator. Results preserve the
 * INPUT order regardless of completion order.
 */
export async function ingestPdfBinaries(
  files: readonly IngestFile[],
  hydrate: IngestHydrator,
  options?: IngestOptions,
): Promise<IngestResult[]> {
  const concurrency = Math.max(1, options?.concurrency ?? DEFAULT_CONCURRENCY);
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;

  const results: IngestResult[] = new Array(files.length);
  // A mutable copy so we can null out each slot's bytes after processing to let
  // the GC reclaim them before the batch finishes (RAM release, D09).
  const pending: (IngestFile | null)[] = files.slice();
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= files.length) return;
      const file = pending[index];
      if (!file) continue;

      if (!hasPdfMagic(file.bytes)) {
        results[index] = {
          name: file.name,
          status: "rejected",
          reason: "not a PDF (missing %PDF- magic)",
          sourceId: "",
        };
        pending[index] = null;
        continue;
      }
      if (file.bytes.byteLength > maxBytes) {
        results[index] = {
          name: file.name,
          status: "rejected",
          reason: `file exceeds the ${maxBytes}-byte per-file size guard`,
          sourceId: "",
        };
        pending[index] = null;
        continue;
      }

      const versionHash = await sha256Hex(file.bytes);
      const outcome = await hydrate({
        name: file.name,
        bytes: file.bytes,
        versionHash,
      });
      results[index] = {
        name: file.name,
        status: outcome.status,
        versionHash,
        sourceId: outcome.sourceId,
      };
      // Release the bytes reference so memory is freed before the next file.
      pending[index] = null;
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, files.length); i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}
