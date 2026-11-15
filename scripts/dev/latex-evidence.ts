// Collect the extractor's evidence for every box of a tier, with whether the
// draft was exactly right. Raw rows, one JSON object per line, so a
// confidence model can be fitted and examined elsewhere. Refuses the sealed
// set: its rows would say where its failures are.
//
//   npx vite-node scripts/dev/latex-evidence.ts <dev|heldout|survey> <tier> <out.jsonl>
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { analyzeModelRegion } from "../../src/pdf/equationEvidence";
import { buildPageMathModel, type OpsTable, type PageMathModel } from "../../src/pdf/pageMathModel";
import { scoreEquation } from "../../src/science/research/latex/score";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/science/research/latex");
const [set, tierName, out] = process.argv.slice(2);
if (set === "sealed") throw new Error("The sealed set is never dumped. Use latex-confidence.ts, which reports aggregates.");
const dir = set === "heldout" ? "corpus-heldout" : set === "survey" ? "corpus-survey" : "corpus";
const manifest = JSON.parse(readFileSync(resolve(ROOT, dir, "manifest.json"), "utf8"));
const tier = manifest.tiers[tierName!];
const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(resolve(ROOT, dir, tier.pdf))), verbosity: 0 }).promise;
const models = new Map<number, PageMathModel>();
const rows: string[] = [];
for (const [id, pageIndex, x0, y0, x1, y1] of tier.placements) {
  let model = models.get(pageIndex);
  if (!model) {
    const page = await doc.getPage(pageIndex + 1);
    model = buildPageMathModel(await page.getOperatorList(), (f: string) => page.commonObjs.get(f), pdfjs.OPS as unknown as OpsTable, page.getViewport({ scale: 1 }));
    models.set(pageIndex, model);
    if (models.size > 4) models.delete(models.keys().next().value!);
  }
  const { latex, evidence } = analyzeModelRegion(model, {
    x: x0 / tier.pageWidth,
    y: (tier.pageHeight - y1) / tier.pageHeight,
    width: (x1 - x0) / tier.pageWidth,
    height: (y1 - y0) / tier.pageHeight,
  });
  const ok = scoreEquation(manifest.equations[id], latex).exact;
  rows.push(JSON.stringify({ set, tier: tierName, id, paper: manifest.paperOf?.[id] ?? null, ok, evidence }));
}
writeFileSync(out!, rows.join("\n") + "\n");
console.log(`${rows.length} rows, ${rows.filter((r) => JSON.parse(r).ok).length} exact -> ${out}`);
