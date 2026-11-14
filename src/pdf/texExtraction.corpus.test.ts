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

/** What the extractor drafts for some equations of a tier, by id. */
async function drafts(name: string, ids: readonly string[]): Promise<Map<string, string>> {
  const tier = manifest.tiers[name]!;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(resolve(ROOT, "corpus", tier.pdf))), verbosity: 0 }).promise;
  const out = new Map<string, string>();
  for (const [id, pageIndex, x0, y0, x1, y1] of tier.placements) {
    if (!ids.includes(id)) continue;
    const page = await doc.getPage(pageIndex + 1);
    const model = buildPageMathModel(
      await page.getOperatorList(),
      (fontId) => page.commonObjs.get(fontId),
      pdfjs.OPS as unknown as OpsTable,
      page.getViewport({ scale: 1 }),
    );
    out.set(id, extractLatexFromModel(model, {
      x: x0 / tier.pageWidth,
      y: (tier.pageHeight - y1) / tier.pageHeight,
      width: (x1 - x0) / tier.pageWidth,
      height: (y1 - y0) / tier.pageHeight,
    }));
  }
  await doc.destroy();
  return out;
}

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
  for (const name of ["tex-display", "tex-inline", "tex-tounicode", "tex-times", "real-display", "real-inline", "real-inline-punct", "real-display-numbered", "real-display-dvips", "real-display-lm"]) {
    it(`${name}: the same count as the browser benchmark reported`, async () => {
      const { n, exact } = await exactCount(name);
      expect({ n, exact }).toEqual({ n: reported.tiers[name]!.n, exact: reported.tiers[name]!.exact });
    }, 120_000);
  }
});

describe("structure that spans lines (Phase 3)", () => {
  it("reads matrices, cases and binomials as grids", async () => {
    const got = await drafts("tex-display", ["c040", "c042", "c048", "c004"]);
    expect(got.get("c040")).toBe("A=\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}");
    expect(got.get("c042")).toBe("\\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix}=ad-bc");
    expect(got.get("c048")).toBe("|x|=\\begin{cases} x & \\mathrm{if}x\\geq 0 \\\\ -x & \\mathrm{if}x<0 \\end{cases}");
    expect(got.get("c004")).toBe("(a+b)^n=\\sum_{k=0}^n\\binom{n}{k}a^{n-k}b^k");
  }, 60_000);

  it("keeps a fraction inside its own row, a script on its grid, an index on its root", async () => {
    const ids = ["g1755", "g0094", "c029", "g0857", "g0222"];
    const got = await drafts("tex-display", ids);
    for (const id of ids) expect(scoreEquation(manifest.equations[id]!, got.get(id)!).exact, `${id}: ${got.get(id)}`).toBe(true);
    expect(got.get("g1755")).toContain(" \\\\ ");
    expect(got.get("g0094")).toMatch(/\\end\{pmatrix\}\^T$/);
    expect(got.get("c029")).toMatch(/^\\sqrt\[n\]\{/);
    expect(got.get("g0857")).toContain("\\overset{!}{=}");
  }, 60_000);

  it("gives each of two neighbouring operators its own limits", async () => {
    const got = await drafts("real-display", ["rd0124", "rd0013", "rd0356"]);
    expect(got.get("rd0124")).toContain("\\sum_{y=1}^g\\prod_{i=1}^k");
    expect(got.get("rd0013")).toMatch(/^\\liminf_\{\\epsilon\\searrow 0\}/);
    expect(got.get("rd0356")).toContain("\\int_{x_1}^{x_2}\\int_{y_1}^{y_2}");
  }, 60_000);
});
