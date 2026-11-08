// Generate reproducible real PDF fixtures for tests (spec section 24).
//
// Produces, under src/test/fixtures/:
//   - sample-3page.pdf    : 3+ pages of ordinary selectable text
//   - sample-multicol.pdf : a two-column layout page
//   - sample-rotated.pdf  : pages with 90/180/270 rotation
//
// These PDFs have a REAL selectable text layer (drawn with embedded standard
// fonts), so pdf.js can extract text from them. Run `npm run gen-fixtures` to
// regenerate. The generated PDFs are committed for test stability.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const outputs = [
    ["sample-3page.pdf", await makeThreePage()],
    ["sample-multicol.pdf", await makeMultiColumn()],
    ["sample-rotated.pdf", await makeRotated()],
  ];
  for (const [name, bytes] of outputs) {
    const path = resolve(OUT_DIR, name);
    await writeFile(path, bytes);
    console.log(`wrote ${path} (${bytes.length} bytes)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
