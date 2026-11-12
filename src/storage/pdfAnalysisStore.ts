/**
 * M18 (FEAT-PDF-CACHE §14) persistent storage for the PDF analysis cache.
 *
 * ------------------------------------------------------------------------
 * Why a dedicated store (and NOT localStorage or the brain payload)
 * ------------------------------------------------------------------------
 * Per-page PDF analysis is potentially large and must be retrievable PAGE BY
 * PAGE so opening page 1 of a 900-page document never deserializes the whole
 * analysis (§14). The brain payload is a single JSON blob rewritten on every
 * keystroke-save — wholly unsuitable. `localStorage` is a small synchronous
 * string store — unsuitable for structured, large, binary-ish data. So the
 * analysis cache gets its OWN IndexedDB object stores:
 *
 *   - `pdfAnalysisManifests` — one small {@link PdfAnalysisManifest} per
 *     document, keyed by `documentId`. O(1) to read on open.
 *   - `pdfAnalysisPages` — one {@link PdfPageAnalysis} per PAGE, keyed by
 *     `${documentId}#${pageNumber}` so a single page is fetched independently.
 *
 * ------------------------------------------------------------------------
 * The {@link PdfAnalysisStore} abstraction
 * ------------------------------------------------------------------------
 * Callers (the ingestion pipeline, the reader fast-path) talk ONLY to this
 * interface — never to IndexedDB directly — mirroring the project's existing
 * StorageAdapter boundary (ADR-0004). `IndexedDbPdfAnalysisStore` is the browser
 * implementation; `InMemoryPdfAnalysisStore` backs unit tests. Kept as a
 * SEPARATE interface from StorageAdapter so adding the cache does not force a
 * change on every existing StorageAdapter implementation / mock.
 */

import { openDB, type IDBPDatabase } from "idb";
import type { PdfAnalysisManifest, PdfPageAnalysis } from "../pdf/analysisCache";

/**
 * The persistence boundary for the PDF analysis cache (§14). Pages are read /
 * written individually; the manifest is the small document-level index.
 */
export interface PdfAnalysisStore {
  /** Read a document's manifest. Null when no analysis exists for it. */
  readManifest(documentId: string): Promise<PdfAnalysisManifest | null>;
  /** Write (create or replace) a document's manifest. */
  writeManifest(manifest: PdfAnalysisManifest): Promise<void>;
  /** Read ONE page's analysis without deserializing the rest of the document (§14). */
  readPage(documentId: string, pageNumber: number): Promise<PdfPageAnalysis | null>;
  /** Persist ONE page's analysis incrementally (§6). */
  writePage(documentId: string, page: PdfPageAnalysis): Promise<void>;
  /** Read several pages at once (nearby-page prefetch); each absent page is null. */
  readPages(
    documentId: string,
    pageNumbers: readonly number[],
  ): Promise<(PdfPageAnalysis | null)[]>;
  /** Delete a document's manifest + every page (full invalidation / rebuild). */
  deleteDocument(documentId: string): Promise<void>;
  /** All document ids currently holding an analysis manifest (diagnostics / size). */
  listDocumentIds(): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

const DB_NAME = "ito-pdf-analysis";
const DB_VERSION = 1;
const STORE_MANIFESTS = "pdfAnalysisManifests";
const STORE_PAGES = "pdfAnalysisPages";

/** The per-page record key. `#` is safe: documentIds never contain it. */
export function pageKey(documentId: string, pageNumber: number): string {
  return `${documentId}#${pageNumber}`;
}

/** The inclusive key range covering every page of one document (for deletes). */
function pageKeyRange(documentId: string): IDBKeyRange {
  return IDBKeyRange.bound(`${documentId}#`, `${documentId}#\uffff`);
}

// ---------------------------------------------------------------------------
// IndexedDB implementation (browser)
// ---------------------------------------------------------------------------

/**
 * The browser {@link PdfAnalysisStore} (§14). Uses a SEPARATE IndexedDB database
 * from the brain store so analysis cache growth / eviction never interferes with
 * the brain payload, and so the cache can be cleared wholesale (e.g. on a schema
 * bump) without touching user data.
 */
export class IndexedDbPdfAnalysisStore implements PdfAnalysisStore {
  private dbPromise: Promise<IDBPDatabase> | null = null;

  private db(): Promise<IDBPDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openDB(DB_NAME, DB_VERSION, {
        upgrade(db) {
          if (!db.objectStoreNames.contains(STORE_MANIFESTS)) {
            db.createObjectStore(STORE_MANIFESTS, { keyPath: "documentId" });
          }
          if (!db.objectStoreNames.contains(STORE_PAGES)) {
            // Keyed out-of-line by `${documentId}#${pageNumber}` so a single
            // page is fetched by key without scanning the document.
            db.createObjectStore(STORE_PAGES);
          }
        },
      });
    }
    return this.dbPromise;
  }

  async readManifest(documentId: string): Promise<PdfAnalysisManifest | null> {
    const db = await this.db();
    const m = (await db.get(STORE_MANIFESTS, documentId)) as
      | PdfAnalysisManifest
      | undefined;
    return m ?? null;
  }

  async writeManifest(manifest: PdfAnalysisManifest): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE_MANIFESTS, "readwrite");
    await tx.store.put(manifest);
    await tx.done;
  }

  async readPage(documentId: string, pageNumber: number): Promise<PdfPageAnalysis | null> {
    const db = await this.db();
    const p = (await db.get(STORE_PAGES, pageKey(documentId, pageNumber))) as
      | PdfPageAnalysis
      | undefined;
    return p ?? null;
  }

  async writePage(documentId: string, page: PdfPageAnalysis): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE_PAGES, "readwrite");
    await tx.store.put(page, pageKey(documentId, page.pageNumber));
    await tx.done;
  }

  async readPages(
    documentId: string,
    pageNumbers: readonly number[],
  ): Promise<(PdfPageAnalysis | null)[]> {
    const db = await this.db();
    const tx = db.transaction(STORE_PAGES, "readonly");
    const out = await Promise.all(
      pageNumbers.map(async (n) => {
        const p = (await tx.store.get(pageKey(documentId, n))) as
          | PdfPageAnalysis
          | undefined;
        return p ?? null;
      }),
    );
    await tx.done;
    return out;
  }

  async deleteDocument(documentId: string): Promise<void> {
    const db = await this.db();
    {
      const tx = db.transaction(STORE_PAGES, "readwrite");
      await tx.store.delete(pageKeyRange(documentId));
      await tx.done;
    }
    {
      const tx = db.transaction(STORE_MANIFESTS, "readwrite");
      await tx.store.delete(documentId);
      await tx.done;
    }
  }

  async listDocumentIds(): Promise<string[]> {
    const db = await this.db();
    return (await db.getAllKeys(STORE_MANIFESTS)) as string[];
  }
}

// ---------------------------------------------------------------------------
// In-memory implementation (tests)
// ---------------------------------------------------------------------------

/**
 * A deterministic in-memory {@link PdfAnalysisStore} for unit tests. Mirrors the
 * per-page independence of the IndexedDB store (pages live in a flat map keyed
 * exactly like IndexedDB) and deep-clones on read/write so a test can never
 * mutate stored state in place. It also COUNTS reads per store so a test can
 * assert that opening one page did not deserialize the whole document (§14, §20
 * case 9) and that zoom/scroll did not re-read analysis (§20 cases 13/14).
 */
export class InMemoryPdfAnalysisStore implements PdfAnalysisStore {
  private manifests = new Map<string, PdfAnalysisManifest>();
  private pages = new Map<string, PdfPageAnalysis>();

  /** Instrumentation counters (test-only). */
  readonly counts = {
    manifestReads: 0,
    manifestWrites: 0,
    pageReads: 0,
    pageWrites: 0,
  };

  async readManifest(documentId: string): Promise<PdfAnalysisManifest | null> {
    this.counts.manifestReads += 1;
    const m = this.manifests.get(documentId);
    return m ? structuredClone(m) : null;
  }

  async writeManifest(manifest: PdfAnalysisManifest): Promise<void> {
    this.counts.manifestWrites += 1;
    this.manifests.set(manifest.documentId, structuredClone(manifest));
  }

  async readPage(documentId: string, pageNumber: number): Promise<PdfPageAnalysis | null> {
    this.counts.pageReads += 1;
    const p = this.pages.get(pageKey(documentId, pageNumber));
    return p ? structuredClone(p) : null;
  }

  async writePage(documentId: string, page: PdfPageAnalysis): Promise<void> {
    this.counts.pageWrites += 1;
    this.pages.set(pageKey(documentId, page.pageNumber), structuredClone(page));
  }

  async readPages(
    documentId: string,
    pageNumbers: readonly number[],
  ): Promise<(PdfPageAnalysis | null)[]> {
    return Promise.all(pageNumbers.map((n) => this.readPage(documentId, n)));
  }

  async deleteDocument(documentId: string): Promise<void> {
    this.manifests.delete(documentId);
    const prefix = `${documentId}#`;
    for (const key of [...this.pages.keys()]) {
      if (key.startsWith(prefix)) this.pages.delete(key);
    }
  }

  async listDocumentIds(): Promise<string[]> {
    return [...this.manifests.keys()];
  }

  /** Test helper: corrupt a stored manifest to exercise the corrupt-cache path. */
  _corruptManifest(documentId: string, patch: Record<string, unknown>): void {
    const m = this.manifests.get(documentId);
    if (m) this.manifests.set(documentId, { ...m, ...patch } as PdfAnalysisManifest);
  }

  /** Test helper: total page records held (independent of any document). */
  _pageCount(): number {
    return this.pages.size;
  }
}
