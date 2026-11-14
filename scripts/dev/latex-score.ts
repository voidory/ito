// Score the pure extraction path over corpus tiers, in Node, and optionally
// print failures. A development aid: the benchmark of record is the browser
// run (`npm run benchmark:latex:report`).
//
//   npx vite-node scripts/dev/latex-score.ts [dev|heldout] [tier ...]
//   ITO_SHOW=20 ...       print that many failures per tier (development set only)
//   ITO_TAG=matrix ...    only equations with that construct tag
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildPageMathModel, type OpsTable, type PageMathModel } from "../../src/pdf/pageMathModel";
import { extractLatexFromModel } from "../../src/pdf/scienceOcr";
import { constructsOf, parseLatex } from "../../src/science/research/latex/normalize";
import { scoreEquation } from "../../src/science/research/latex/score";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/science/research/latex");
const args = process.argv.slice(2);
const set = args[0] === "heldout" ? "heldout" : "dev";
const names = args.filter((a) => a !== "dev" && a !== "heldout");
const dir = set === "heldout" ? "corpus-heldout" : "corpus";
const manifest = JSON.parse(readFileSync(resolve(ROOT, dir, "manifest.json"), "utf8"));
const show = set === "dev" ? Number(process.env.ITO_SHOW ?? 0) : 0;
const tag = process.env.ITO_TAG;

for (const name of names.length > 0 ? names : Object.keys(manifest.tiers)) {
  const tier = manifest.tiers[name];
  if (!tier || name === "scanned") continue;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(resolve(ROOT, dir, tier.pdf))), verbosity: 0 }).promise;
  const models = new Map<number, PageMathModel>();
  let n = 0;
  let exact = 0;
  const failures: string[] = [];
  const byTag = new Map<string, [number, number]>();
  for (const [id, pageIndex, x0, y0, x1, y1] of tier.placements) {
    const truth = manifest.equations[id];
    const tags = constructsOf(parseLatex(truth));
    if (tag && !tags.includes(tag)) continue;
    let model = models.get(pageIndex);
    if (!model) {
      const page = await doc.getPage(pageIndex + 1);
      model = buildPageMathModel(await page.getOperatorList(), (f) => page.commonObjs.get(f), pdfjs.OPS as unknown as OpsTable, page.getViewport({ scale: 1 }));
      models.set(pageIndex, model);
    }
    const got = extractLatexFromModel(model, {
      x: x0 / tier.pageWidth,
      y: (tier.pageHeight - y1) / tier.pageHeight,
      width: (x1 - x0) / tier.pageWidth,
      height: (y1 - y0) / tier.pageHeight,
    });
    const ok = scoreEquation(truth, got).exact;
    n++;
    if (ok) exact++;
    else failures.push(`${id}\n  E: ${truth}\n  G: ${got}`);
    for (const t of tags) {
      const c = byTag.get(t) ?? [0, 0];
      c[0]++;
      if (ok) c[1]++;
      byTag.set(t, c);
    }
  }
  await doc.destroy();
  console.log(`${set} ${name}: ${exact} of ${n} (${((100 * exact) / Math.max(1, n)).toFixed(2)}%)`);
  if (process.env.ITO_TAGS) for (const [t, [a, b]] of [...byTag].sort((p, q) => q[1][0] - q[1][1] - (p[1][0] - p[1][1]))) console.log(`    ${t.padEnd(20)} ${b}/${a}  fail ${a - b}`);
  for (const f of failures.slice(0, show)) console.log(f);
}
