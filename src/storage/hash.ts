/**
 * Pure hashing + PDF magic-byte helpers for the storage / backup / staging
 * layer (M3). These deliberately import NOTHING browser-only: unlike
 * `hashBytes` in src/pdf/render.ts (which pulls in the pdf.js worker and so can
 * only run in a real browser), this module is usable from the storage adapter,
 * the backup/staging codec, and jsdom/Node unit tests.
 *
 * `sha256Hex` computes the SAME digest/format as `hashBytes` (SHA-256, lower
 * case hex) so a source's versionHash can be recomputed and compared when a PDF
 * binary is re-attached after an offline eviction (A17).
 */

/** Compute a lower-case hex SHA-256 digest of the given bytes via crypto.subtle. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a plain ArrayBuffer so the argument type is BufferSource and the
  // input is never a SharedArrayBuffer slice.
  const buf = bytes.slice().buffer as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The leading bytes every PDF file begins with: the ASCII sequence "%PDF-". */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;

/**
 * Return true when `bytes` begins with the PDF magic marker "%PDF-". Used to
 * reject non-PDF files before attaching them as a source binary (A17) and in
 * the staging validator's lenient coercion path.
 */
export function hasPdfMagic(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_MAGIC.length) return false;
  for (let i = 0; i < PDF_MAGIC.length; i += 1) {
    if (bytes[i] !== PDF_MAGIC[i]) return false;
  }
  return true;
}
