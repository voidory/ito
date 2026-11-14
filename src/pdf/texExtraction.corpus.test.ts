// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import { scoreEquation } from "../science/research/latex/score";
import { buildPageMathModel, type OpsTable, type PageMathModel } from "./pageMathModel";
import { extractLatexFromModel } from "./scienceOcr";

/**
 * The extraction path is pure: page model -> identified glyphs -> layout. So
 * Node must get, selection for selection, what the reader gets in Chromium.
 * This runs the development corpus through the pure path and compares the
 * counts with BENCHMARK.json, which the browser benchmark wrote. A difference
 * means either the extractor changed without the benchmark being re-run
 * (`npm run benchmark:latex:report`), or something in the path has started to
 * depend on the environment.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../science/research/latex");
const manifest = JSON.parse(readFileSync(resolve(ROOT, "corpus/manifest.json"), "utf8")) as {
  equations: Record<string, string>;
  tiers: Record<string, { pdf: string; pageWidth: number; pageHeight: number; placements: [string, number, number, number, number, number][] }>;
};
const reported = JSON.parse(readFileSync(resolve(ROOT, "BENCHMARK.json"), "utf8")) as {
  tiers: Record<string, { n: number; exact: number }>;
};

async function exactCount(name: string): Promise<{ n: number; exact: number }> {
  const tier = manifest.tiers[name]!;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(resolve(ROOT, "corpus", tier.pdf))), verbosity: 0 }).promise;
  const models = new Map<number, PageMathModel>();
  let exact = 0;
  for (const [id, pageIndex, x0, y0, x1, y1] of tier.placements) {
    let model = models.get(pageIndex);
    if (!model) {
      const page = await doc.getPage(pageIndex + 1);
      model = buildPageMathModel(
        await page.getOperatorList(),
        (fontId) => page.commonObjs.get(fontId),
        pdfjs.OPS as unknown as OpsTable,
        page.getViewport({ scale: 1 }),
      );
      models.set(pageIndex, model);
    }
    const got = extractLatexFromModel(model, {
      x: x0 / tier.pageWidth,
      y: (tier.pageHeight - y1) / tier.pageHeight,
      width: (x1 - x0) / tier.pageWidth,
      height: (y1 - y0) / tier.pageHeight,
    });
    if (scoreEquation(manifest.equations[id]!, got).exact) exact++;
  }
  await doc.destroy();
  return { n: tier.placements.length, exact };
}

describe("LaTeX extraction over the development corpus, in Node", () => {
  for (const name of ["tex-display", "tex-inline", "tex-tounicode", "tex-times", "real-display", "real-inline"]) {
    it(`${name}: the same count as the browser benchmark reported`, async () => {
      const { n, exact } = await exactCount(name);
      expect({ n, exact }).toEqual({ n: reported.tiers[name]!.n, exact: reported.tiers[name]!.exact });
    }, 120_000);
  }
});
