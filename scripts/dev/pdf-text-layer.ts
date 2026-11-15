// How much of a folder of PDFs would the geometry extractor have nothing to
// read? Per page: is there visible text, how much of the page do images cover,
// is there invisible text (the OCR layer a scanner adds)?
//
//   npx vite-node scripts/dev/pdf-text-layer.ts <folder-or-pdf> [...]
//
// It reads only locally and prints counts, never titles or text. Page classes:
//   text      visible text, images cover under half the page
//   scan      images cover half the page or more and there is no visible text
//   scan+ocr  as scan, with an invisible text layer on top (render mode 3)
//   mixed     visible text with images covering half the page or more
//   blank     neither
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const OPS = pdfjs.OPS as Record<string, number>;
type M = [number, number, number, number, number, number];
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];

interface PageFacts { visibleGlyphs: number; invisibleGlyphs: number; imageCover: number }

async function facts(page: pdfjs.PDFPageProxy): Promise<PageFacts> {
  const list = await page.getOperatorList();
  const vp = page.getViewport({ scale: 1 });
  let ctm: M = [1, 0, 0, 1, 0, 0];
  const stack: M[] = [];
  let mode = 0, visible = 0, invisible = 0, covered = 0;
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i]!, args = list.argsArray[i] as unknown[];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = mul(args as unknown as M, ctm);
    else if (fn === OPS.setTextRenderingMode) mode = args[0] as number;
    else if (fn === OPS.showText) {
      const n = ((args[0] as unknown[]) ?? []).length;
      if (mode === 3) invisible += n; else visible += n;
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
      // An image is drawn into the unit square under the current transform.
      covered += Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]);
    }
  }
  return { visibleGlyphs: visible, invisibleGlyphs: invisible, imageCover: Math.min(1, covered / (vp.width * vp.height)) };
}

const classOf = (f: PageFacts): string =>
  f.imageCover >= 0.5 ? (f.visibleGlyphs > 20 ? "mixed" : f.invisibleGlyphs > 20 ? "scan+ocr" : "scan")
  : f.visibleGlyphs > 0 ? "text" : f.invisibleGlyphs > 0 ? "scan+ocr" : "blank";

function pdfsIn(p: string): string[] {
  if (statSync(p).isFile()) return [p];
  return readdirSync(p).flatMap((n) => pdfsIn(join(p, n))).filter((x) => x.endsWith(".pdf"));
}

const files = process.argv.slice(2).flatMap(pdfsIn);
const pages: Record<string, number> = {};
const docs: Record<string, number> = {};
for (const f of files) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(f)), verbosity: 0 }).promise;
  const own: Record<string, number> = {};
  for (let p = 1; p <= doc.numPages; p++) {
    const c = classOf(await facts(await doc.getPage(p)));
    own[c] = (own[c] ?? 0) + 1;
    pages[c] = (pages[c] ?? 0) + 1;
  }
  const dominant = Object.entries(own).sort((a, b) => b[1] - a[1])[0]![0];
  docs[dominant] = (docs[dominant] ?? 0) + 1;
  await doc.destroy();
}
const total = Object.values(pages).reduce((s, n) => s + n, 0);
console.log(`${files.length} files, ${total} pages`);
for (const [c, n] of Object.entries(pages).sort()) console.log(`  pages ${c.padEnd(9)} ${n}  ${((100 * n) / total).toFixed(1)}%`);
for (const [c, n] of Object.entries(docs).sort()) console.log(`  files mostly ${c.padEnd(9)} ${n}`);
