/**
 * Shared Local-PDF import path used by the Library button, the Library/app-shell
 * full-window drag-and-drop, and the Reader header import affordance (m8).
 *
 * It is deliberately DOM-light so it also runs in jsdom render tests: it reads
 * the file bytes, computes a SHA-256 versionHash via the pure `sha256Hex`
 * helper (NOT the browser-only pdf.js hashBytes), reads the page count via
 * pdf.js when a real document can be parsed, and otherwise falls back to 1
 * (headless jsdom has no pdf.js worker). It then records the source through the
 * existing `wb.importSource` transition. Importing a source NEVER creates a
 * Page/Relationship/Category (that invariant lives in the Workbench).
 */
import { sha256Hex } from "../storage";
import type { Workbench } from "./workbench";

/** True when the file looks like a PDF by extension or MIME type. */
export function isPdfFile(file: File): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

/** Strip a trailing ".pdf" so the library title reads cleanly. */
function titleFromFileName(name: string): string {
  return name.replace(/\.pdf$/i, "").trim() || name;
}

/**
 * Best-effort page count. Uses pdf.js when it can parse the bytes; returns 1
 * when pdf.js is unavailable or throws (jsdom has no worker). Never rejects.
 */
export async function readPdfPageCount(bytes: Uint8Array): Promise<number> {
  try {
    // Dynamic import so a jsdom test that never calls this does not pull in the
    // pdf.js worker module graph at import time.
    const { loadDocument } = await import("../pdf/render");
    const doc = await loadDocument(bytes);
    const count = doc.numPages;
    return Number.isFinite(count) && count > 0 ? count : 1;
  } catch {
    return 1;
  }
}

/** The best-effort PDF metadata extracted at import time. */
export interface PdfImportMetadata {
  readonly pageCount: number;
  readonly authors: string | undefined;
  readonly year: string | undefined;
}

/**
 * FEAT-002 best-effort PDF metadata (page count + author + year). Uses pdf.js
 * `getMetadata()` when it can parse the bytes: `info.Author` becomes `authors`
 * (trimmed, only when non-empty), and a 4-digit `year` is parsed from
 * `info.CreationDate` then `info.ModDate` (PDF date format "D:YYYYMMDD..."). It
 * mirrors readPdfPageCount's discipline: it NEVER rejects, so a jsdom import
 * test (no pdf.js worker) simply gets { pageCount: 1, authors/year: undefined }
 * and the Reader backfills the real values later via updateSourceMetadata.
 */
export async function readPdfMetadata(bytes: Uint8Array): Promise<PdfImportMetadata> {
  try {
    const { loadDocument } = await import("../pdf/render");
    const doc = await loadDocument(bytes);
    const count = doc.numPages;
    const pageCount = Number.isFinite(count) && count > 0 ? count : 1;
    let authors: string | undefined;
    let year: string | undefined;
    try {
      const meta = await doc.getMetadata();
      const info = (meta?.info ?? {}) as Record<string, unknown>;
      const rawAuthor = typeof info.Author === "string" ? info.Author.trim() : "";
      authors = rawAuthor.length > 0 ? rawAuthor : undefined;
      year = yearFromPdfDate(info.CreationDate) ?? yearFromPdfDate(info.ModDate);
    } catch {
      // getMetadata unavailable: fall through with page count only.
    }
    return { pageCount, authors, year };
  } catch {
    return { pageCount: 1, authors: undefined, year: undefined };
  }
}

/**
 * Parse a 4-digit year out of a PDF date string ("D:YYYYMMDDHHmmSS").
 *
 * Prefers the leading `D:YYYY` PDF-date form; otherwise falls back to the first
 * 4-digit run anywhere in the string. Either way the result is constrained to a
 * plausible-year range (1500-2099, the same `\b(1[5-9]\d{2}|20\d{2})\b` window
 * Library.tsx's title regex uses) so a malformed date field cannot yield a
 * non-year number — in which case we return `undefined` and the caller's
 * title-regex/em-dash fallback still applies. Best-effort and never throws.
 */
export function yearFromPdfDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const m = value.match(/D:(\d{4})/) ?? value.match(/(\d{4})/);
  if (!m) return undefined;
  const year = m[1]!;
  return /^(1[5-9]\d{2}|20\d{2})$/.test(year) ? year : undefined;
}

/** Import a single PDF File as a Source. Resolves to the import result. */
export async function importPdfFile(
  wb: Workbench,
  file: File,
): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const versionHash = await sha256Hex(bytes);
  const meta = await readPdfMetadata(bytes);
  await wb.importSource({
    title: titleFromFileName(file.name),
    bytes,
    versionHash,
    pageCount: meta.pageCount,
    authors: meta.authors,
    year: meta.year,
  });
}

/**
 * Import a FileList/array of dropped-or-selected files, skipping non-PDFs.
 * Imports sequentially so persistence stays ordered. Returns how many PDFs were
 * imported so a caller can decide whether to re-render.
 */
export async function importPdfFiles(
  wb: Workbench,
  files: Iterable<File>,
): Promise<number> {
  let imported = 0;
  for (const file of files) {
    if (!isPdfFile(file)) continue;
    await importPdfFile(wb, file);
    imported += 1;
  }
  return imported;
}
