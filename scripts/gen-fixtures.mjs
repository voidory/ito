// Generate reproducible real PDF fixtures for tests (spec section 24).
//
// Produces, under src/test/fixtures/:
//   - sample-3page.pdf          : 3+ pages of ordinary selectable text
//   - sample-multicol.pdf       : a two-column layout page
//   - sample-rotated.pdf        : pages with 90/180/270 rotation
//   - sample-math.pdf           : typeset equations (scripts, a fraction bar,
//                                 a radical, limits) for LaTeX extraction
//   - sample-12page-figure.pdf  : a 12-page TWO-COLUMN document whose first
//                                 page embeds a raster figure (PNG via
//                                 embedPng) — exercises the reader's area /
//                                 figure thumbnail + thumbnail/outline sidebar.
//
// These PDFs have a REAL selectable text layer (drawn with embedded standard
// fonts), so pdf.js can extract text from them. Run `npm run gen-fixtures` to
// regenerate. The generated PDFs are committed for test stability.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "../src/test/fixtures");

const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;
const MARGIN = 54;

function paragraph(index) {
  return (
    `Section ${index}. This is ordinary selectable body text used as a test ` +
    `fixture for the ito research reader. It exists so that pdf.js can extract ` +
    `a real text layer and so anchor creation and resolution can be exercised ` +
    `against stable content. The quick brown fox jumps over the lazy dog.`
  );
}

function drawWrapped(page, font, text, { x, y, size, maxWidth, lineGap }) {
  const words = text.split(/\s+/);
  let line = "";
  let cursorY = y;
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && line) {
      page.drawText(line, { x, y: cursorY, size, font, color: rgb(0.1, 0.1, 0.1) });
      cursorY -= size + lineGap;
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) {
    page.drawText(line, { x, y: cursorY, size, font, color: rgb(0.1, 0.1, 0.1) });
    cursorY -= size + lineGap;
  }
  return cursorY;
}

async function makeThreePage() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  for (let p = 1; p <= 3; p++) {
    const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    page.drawText(`Sample Document — Page ${p}`, {
      x: MARGIN,
      y: PAGE_HEIGHT - MARGIN,
      size: 18,
      font: bold,
      color: rgb(0, 0, 0),
    });
    let y = PAGE_HEIGHT - MARGIN - 36;
    for (let s = 1; s <= 4; s++) {
      y = drawWrapped(page, font, paragraph((p - 1) * 4 + s), {
        x: MARGIN,
        y,
        size: 12,
        maxWidth: PAGE_WIDTH - MARGIN * 2,
        lineGap: 4,
      });
      y -= 12;
    }
  }
  return pdf.save();
}

async function makeMultiColumn() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);

  page.drawText("Multi-Column Layout Fixture", {
    x: MARGIN,
    y: PAGE_HEIGHT - MARGIN,
    size: 18,
    font: bold,
  });

  const colWidth = (PAGE_WIDTH - MARGIN * 2 - 24) / 2;
  const topY = PAGE_HEIGHT - MARGIN - 36;

  drawWrapped(page, font, `${paragraph(1)} ${paragraph(2)} ${paragraph(3)}`, {
    x: MARGIN,
    y: topY,
    size: 11,
    maxWidth: colWidth,
    lineGap: 4,
  });
  drawWrapped(page, font, `${paragraph(4)} ${paragraph(5)} ${paragraph(6)}`, {
    x: MARGIN + colWidth + 24,
    y: topY,
    size: 11,
    maxWidth: colWidth,
    lineGap: 4,
  });
  return pdf.save();
}

/* --------------------------------------------------------------------- */
/* Minimal in-script PNG encoder (so no binary asset is checked in and the */
/* fixture stays fully reproducible from source).                          */
/* --------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBytes, data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * Build a small W×H 24-bit RGB PNG with a simple two-tone gradient + grid so the
 * embedded figure is visibly a raster image rather than vector content.
 */
function makePng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // color type 2 = truecolor RGB
  // bytes 10..12 default 0 (deflate / adaptive filtering / no interlace)

  // Raw scanlines: each row prefixed with a 0 filter byte.
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const grid = x % 8 === 0 || y % 8 === 0;
      const r = grid ? 40 : Math.round((x / width) * 255);
      const g = grid ? 60 : Math.round((y / height) * 255);
      const b = grid ? 120 : 160;
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
    }
  }
  const idat = deflateSync(raw);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG signature
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * A 12-page TWO-COLUMN research-style PDF. Page 1 embeds a raster figure (PNG)
 * with a caption; every page carries real two-column selectable text so pdf.js
 * can build a text layer and an outline consumer has pages to thumbnail.
 */
async function makeTwelvePageFigure() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const figurePng = await pdf.embedPng(makePng(96, 72));

  const colGap = 24;
  const colWidth = (PAGE_WIDTH - MARGIN * 2 - colGap) / 2;

  for (let p = 1; p <= 12; p++) {
    const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    page.drawText(`Two-Column Study — Page ${p}`, {
      x: MARGIN,
      y: PAGE_HEIGHT - MARGIN,
      size: 16,
      font: bold,
      color: rgb(0, 0, 0),
    });

    let topY = PAGE_HEIGHT - MARGIN - 32;

    // Page 1 hosts the embedded raster figure + caption spanning the top.
    if (p === 1) {
      const figW = 180;
      const figH = figW * (72 / 96);
      const figX = MARGIN + (PAGE_WIDTH - MARGIN * 2 - figW) / 2;
      const figY = topY - figH;
      page.drawImage(figurePng, { x: figX, y: figY, width: figW, height: figH });
      page.drawText("Figure 1. Embedded raster sample (PNG).", {
        x: figX,
        y: figY - 16,
        size: 10,
        font,
        color: rgb(0.2, 0.2, 0.2),
      });
      topY = figY - 40;
    }

    // Two columns of body text on every page.
    drawWrapped(page, font, `${paragraph(p)} ${paragraph(p + 1)} ${paragraph(p + 2)}`, {
      x: MARGIN,
      y: topY,
      size: 10,
      maxWidth: colWidth,
      lineGap: 4,
    });
    drawWrapped(page, font, `${paragraph(p + 3)} ${paragraph(p + 4)} ${paragraph(p + 5)}`, {
      x: MARGIN + colWidth + colGap,
      y: topY,
      size: 10,
      maxWidth: colWidth,
      lineGap: 4,
    });
  }
  return pdf.save();
}

async function makeRotated() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const rotations = [90, 180, 270];
  for (const rot of rotations) {
    const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    page.setRotation(degrees(rot));
    page.drawText(`Rotated page at ${rot} degrees. ${paragraph(rot)}`, {
      x: MARGIN,
      y: PAGE_HEIGHT - MARGIN,
      size: 12,
      font,
      maxWidth: PAGE_WIDTH - MARGIN * 2,
    });
  }
  return pdf.save();
}

// Typeset equations the way a PDF really stores them: no structure, just runs
// of glyphs at different baselines/sizes plus drawn rules (fraction bar,
// radical vinculum). Exercises box-selection LaTeX extraction. The coordinates
// are mirrored in e2e/latex-extract.spec.ts.
async function makeMath() {
  const pdf = await PDFDocument.create();
  const roman = await pdf.embedFont(StandardFonts.TimesRoman);
  const italic = await pdf.embedFont(StandardFonts.TimesRomanItalic);
  const symbol = await pdf.embedFont(StandardFonts.Symbol);
  const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const ink = rgb(0, 0, 0);
  const S = 14; // main size
  const s = 9.8; // script size
  // Draw runs left to right; each run is [text, font, size, baselineShift].
  const typeset = (x, y, runs) => {
    let cur = x;
    for (const [text, font, size = S, shift = 0] of runs) {
      page.drawText(text, { x: cur, y: y + shift, size, font, color: ink });
      cur += font.widthOfTextAtSize(text, size);
    }
    return cur;
  };
  const rule = (x0, x1, y) =>
    page.drawLine({ start: { x: x0, y }, end: { x: x1, y }, thickness: 0.6, color: ink });

  // 1. E = mc^2
  typeset(72, 700, [["E", italic], [" = ", roman], ["mc", italic], ["2", roman, s, 5.6]]);

  // 2. the quadratic formula
  const fx = typeset(72, 630, [["x", italic], [" = ", roman]]);
  const numEnd = typeset(fx + 3, 640, [
    ["\u2212", symbol], ["b", italic], [" \u00b1 ", symbol], ["\u221a", symbol],
  ]);
  const radEnd = typeset(numEnd, 640, [
    ["b", italic], ["2", roman, s, 5.6], [" \u2212 ", symbol], ["4", roman], ["ac", italic],
  ]);
  rule(numEnd - 0.5, radEnd, 652.5);
  rule(fx, radEnd + 3, 634);
  const denW = roman.widthOfTextAtSize("2", S) + italic.widthOfTextAtSize("a", S);
  typeset((fx + radEnd + 3 - denW) / 2, 619, [["2", roman], ["a", italic]]);

  // 3. a sum with limits, and a stacked sub/superscript
  page.drawText("\u2211", { x: 76, y: 555, size: 22, font: symbol, color: ink });
  typeset(75, 542, [["i", italic, s], ["=1", roman, s]]);
  typeset(81, 577, [["n", italic, s]]);
  const sx = typeset(96, 560, [["a", italic], ["i", italic, s, -3]]);
  const bx = typeset(sx + 2, 560, [[" = ", roman], ["\u03b1", symbol], ["x", italic]]);
  typeset(bx, 560, [["k", italic, s, -3]]);
  typeset(bx, 560, [["2", roman, s, 5.6]]);

  // 4. an equation inline in a sentence (the box must cut through text runs)
  typeset(72, 480, [
    ["The energy is ", roman], ["E", italic], [" = ", roman], ["mc", italic],
    ["2", roman, s, 5.6], [" for every mass.", roman],
  ]);
  return pdf.save();
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  // `npm run gen-fixtures -- math` regenerates only the math fixture.
  const only = process.argv[2];
  const outputs = [
    ["sample-3page.pdf", makeThreePage],
    ["sample-multicol.pdf", makeMultiColumn],
    ["sample-rotated.pdf", makeRotated],
    ["sample-12page-figure.pdf", makeTwelvePageFigure],
    ["sample-math.pdf", makeMath],
  ]
    .filter(([name]) => !only || name.includes(only))
    .map(([name, make]) => [name, make()]);
  for (const [name, pending] of outputs) {
    const bytes = await pending;
    const path = resolve(OUT_DIR, name);
    await writeFile(path, bytes);
    console.log(`wrote ${path} (${bytes.length} bytes)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
