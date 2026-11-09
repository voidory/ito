import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// Use the legacy build so pdf.js runs under Node/jsdom without a DOM worker.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "fixtures");

async function extractPageTexts(file: string): Promise<string[]> {
  const bytes = new Uint8Array(await readFile(resolve(FIXTURES, file)));
  const doc = await getDocument({ data: bytes, useSystemFonts: false }).promise;
  const texts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");
    texts.push(text);
  }
  return texts;
}

describe("PDF fixtures have real selectable text", () => {
  it("sample-3page.pdf has >= 3 pages of extractable text", async () => {
    const texts = await extractPageTexts("sample-3page.pdf");
    expect(texts.length).toBeGreaterThanOrEqual(3);
    for (const t of texts) {
      expect(t.trim().length).toBeGreaterThan(0);
    }
    expect(texts.join(" ")).toContain("quick brown fox");
  });

  it("sample-12page-figure.pdf has 12 pages of extractable two-column text", async () => {
    const bytes = new Uint8Array(await readFile(resolve(FIXTURES, "sample-12page-figure.pdf")));
    const doc = await getDocument({ data: bytes, useSystemFonts: false }).promise;
    expect(doc.numPages).toBe(12);
    const texts = await extractPageTexts("sample-12page-figure.pdf");
    for (const t of texts) {
      expect(t.trim().length).toBeGreaterThan(0);
    }
    expect(texts[0]).toContain("Figure 1");
  });
});
