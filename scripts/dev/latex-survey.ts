// Rank what the extractor gets wrong on the survey set by how many papers it
// goes wrong in. A failure class met in one paper is that author's habit; one
// met in thirty is the notation of a field, and worth a rule.
//
//   npx vite-node scripts/dev/latex-survey.ts            the ranking
//   ITO_CLASS='matrix' ...   list the failures of the classes containing that text
//   ITO_GREP='underbrace' ... list the failures whose source matches that pattern
//   ITO_SHOW=12 ...          how many to list (default 8)
//   ITO_WRITE=1 ...          write SURVEY.md beside the benchmark reports
//   ITO_IDS=file ...         append `tier id` for every exact match, to compare two runs
//
// Each failure is classified by where its tree first departs from the truth:
// the kind of node the truth has there and the kind the draft has. That is
// mechanical, so the ranking does not depend on anyone's reading.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildPageMathModel, type OpsTable, type PageMathModel } from "../../src/pdf/pageMathModel";
import { extractLatexFromModel } from "../../src/pdf/scienceOcr";
import { parseLatex, serialize, type TexNode } from "../../src/science/research/latex/normalize";
import { clusterInterval } from "../../src/science/research/latex/score";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/science/research/latex");
const manifest = JSON.parse(readFileSync(resolve(ROOT, "corpus-survey/manifest.json"), "utf8"));
const paperOf: Record<string, string> = manifest.paperOf;

/** A coarse name for a node: what kind of thing it is, not which one. */
function kind(n: TexNode | undefined): string {
  if (!n) return "nothing";
  if (n.c.length > 0) return n.t;
  if (n.t === "empty" || n.t === "unparsed") return n.t;
  if (n.t.startsWith("fn:")) return "function name";
  if (/^\\[A-Za-z]+$/.test(n.t)) return n.t;
  if (/^[A-Za-z]$/.test(n.t)) return "letter";
  if (/^[0-9]$/.test(n.t)) return "digit";
  return `'${n.t}'`;
}

/** The first place the draft's tree departs from the truth's, as `truth -> draft`. */
function departure(a: TexNode, b: TexNode, where: string): string | null {
  if (serialize(a) === serialize(b)) return null;
  const inside = (t: string): string => (t === "row" ? where : t);
  if (a.t === b.t && a.c.length === b.c.length && a.c.length > 0) {
    for (let i = 0; i < a.c.length; i++) {
      const d = departure(a.c[i]!, b.c[i]!, inside(a.t));
      if (d) return d;
    }
    return null;
  }
  if (a.t === b.t && (a.t === "row" || a.t.startsWith("font:"))) {
    // Different lengths: skip what agrees at the start, then compare what is there.
    let i = 0;
    while (i < a.c.length && i < b.c.length && serialize(a.c[i]!) === serialize(b.c[i]!)) i++;
    const x = a.c[i];
    const y = b.c[i];
    if (x && y && x.t === y.t && x.c.length > 0) {
      const d = departure(x, y, inside(a.t));
      if (d) return d;
    }
    return `${kind(x)} -> ${kind(y)}${where ? ` (in ${inside(a.t)})` : a.t !== "row" ? ` (in ${a.t})` : ""}`;
  }
  if (a.t === b.t) return `${a.t} of ${a.c.length} -> ${b.c.length}`;
  return `${kind(a)} -> ${kind(b)}${where ? ` (in ${where})` : ""}`;
}

interface Failure {
  readonly tier: string;
  readonly id: string;
  readonly truth: string;
  readonly got: string;
  readonly cls: string;
}

const failures: Failure[] = [];
const lines: string[] = [];
for (const name of ["real-display", "real-inline"]) {
  const tier = manifest.tiers[name];
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(resolve(ROOT, "corpus-survey", tier.pdf))), verbosity: 0 }).promise;
  const models = new Map<number, PageMathModel>();
  const perPaper = new Map<string, [number, number]>();
  for (const [id, pageIndex, x0, y0, x1, y1] of tier.placements) {
    const truth: string = manifest.equations[id];
    let model = models.get(pageIndex);
    if (!model) {
      const page = await doc.getPage(pageIndex + 1);
      model = buildPageMathModel(await page.getOperatorList(), (f) => page.commonObjs.get(f), pdfjs.OPS as unknown as OpsTable, page.getViewport({ scale: 1 }));
      models.set(pageIndex, model);
      if (models.size > 4) models.delete(models.keys().next().value!);
    }
    const got = extractLatexFromModel(model, {
      x: x0 / tier.pageWidth,
      y: (tier.pageHeight - y1) / tier.pageHeight,
      width: (x1 - x0) / tier.pageWidth,
      height: (y1 - y0) / tier.pageHeight,
    });
    const a = parseLatex(truth);
    const b = parseLatex(got);
    const ok = serialize(a) === serialize(b);
    const tallyOf = perPaper.get(paperOf[id]!) ?? [0, 0];
    tallyOf[0]++;
    if (ok) tallyOf[1]++;
    perPaper.set(paperOf[id]!, tallyOf);
    if (ok && process.env.ITO_IDS) appendFileSync(process.env.ITO_IDS, `${name} ${id}\n`);
    if (!ok) failures.push({ tier: name, id, truth, got, cls: got.trim() === "" ? "no draft at all" : departure(a, b, "") ?? "?" });
  }
  await doc.destroy();
  const clusters = [...perPaper.values()].map(([n, exact]) => ({ n, exact }));
  const n = clusters.reduce((s, c) => s + c.n, 0);
  const exact = clusters.reduce((s, c) => s + c.exact, 0);
  const interval = clusterInterval(clusters);
  const clean = clusters.filter((c) => c.exact === c.n).length;
  lines.push(`| \`${name}\` | ${n} | ${exact} | ${((100 * exact) / n).toFixed(2)}% | ${(100 * interval.lower).toFixed(2)}% to ${(100 * interval.upper).toFixed(2)}% | ${clean} of ${clusters.length} |`);
}

const byClass = new Map<string, Failure[]>();
for (const f of failures) byClass.set(f.cls, [...(byClass.get(f.cls) ?? []), f]);
const papersOf = (list: readonly Failure[]): number => new Set(list.map((f) => paperOf[f.id])).size;
const ranked = [...byClass].sort((p, q) => papersOf(q[1]) - papersOf(p[1]) || q[1].length - p[1].length);
const allPapers = new Set(Object.values(paperOf)).size;

const report = [
  "# Box-selection LaTeX extraction: survey of real papers",
  "",
  "Auto-generated by `npm run survey:latex`. Do not edit by hand.",
  "",
  `Survey set: **${Object.keys(manifest.equations).length}** equations from the source of **${allPapers}** openly licensed arXiv papers that no other set uses. Scored in Node on the pure extraction path.`,
  "",
  "This set is read and developed against, so its rate says nothing about unseen papers; the sealed set does that. What it is for is the second table: what goes wrong, ranked by how many papers it goes wrong in.",
  "",
  "| Tier | Selections | Exact | Exact rate | 95% interval, by paper | Papers all exact |",
  "|---|---|---|---|---|---|",
  ...lines,
  "",
  "## Failure classes, by papers",
  "",
  "A class is where a draft's tree first departs from the truth's: the kind of node the truth has there, then the kind the draft has. Classes met in one paper only are counted in the last row.",
  "",
  "| Class (truth -> draft) | Papers | Equations |",
  "|---|---|---|",
  ...ranked.filter(([, list]) => papersOf(list) > 1).map(([cls, list]) => `| \`${cls.replace(/\|/g, "\\|")}\` | ${papersOf(list)} | ${list.length} |`),
  `| *${ranked.filter(([, list]) => papersOf(list) === 1).length} classes in one paper each* | | ${ranked.filter(([, list]) => papersOf(list) === 1).reduce((s, [, list]) => s + list.length, 0)} |`,
  "",
];
if (process.env.ITO_WRITE) writeFileSync(resolve(ROOT, "SURVEY.md"), report.join("\n"));

if (process.env.ITO_GREP) {
  const pattern = new RegExp(process.env.ITO_GREP);
  const hits = failures.filter((f) => pattern.test(f.truth));
  console.log(`${hits.length} failures in ${papersOf(hits)} papers match ${pattern}`);
  for (const f of hits.slice(0, Number(process.env.ITO_SHOW ?? 8))) console.log(`${f.id} [${paperOf[f.id]}] ${f.cls}\n  E: ${f.truth}\n  G: ${f.got}`);
  process.exit(0);
}
const want = process.env.ITO_CLASS;
if (want != null) {
  const show = Number(process.env.ITO_SHOW ?? 8);
  for (const [cls, list] of ranked) {
    if (!cls.includes(want)) continue;
    console.log(`\n== ${cls}: ${papersOf(list)} papers, ${list.length} equations`);
    const seen = new Set<string>();
    // One per paper first, so the list shows the class and not one author.
    const order = [...list.filter((f) => !seen.has(paperOf[f.id]!) && seen.add(paperOf[f.id]!)), ...list];
    for (const f of [...new Set(order)].slice(0, show)) console.log(`${f.id} [${paperOf[f.id]}]\n  E: ${f.truth}\n  G: ${f.got}`);
  }
} else console.log(report.slice(8).join("\n"));
