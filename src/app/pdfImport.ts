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

/** Import a single PDF File as a Source. Resolves to the import result. */
export async function importPdfFile(
  wb: Workbench,
  file: File,
): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const versionHash = await sha256Hex(bytes);
  const pageCount = await readPdfPageCount(bytes);
  await wb.importSource({
    title: titleFromFileName(file.name),
    bytes,
    versionHash,
    pageCount,
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
