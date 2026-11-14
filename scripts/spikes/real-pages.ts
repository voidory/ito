// How does the extractor do on the papers' OWN pages?
// (docs/spikes/real-pages.md has the findings; this script produces the numbers.)
//
// The real-paper tiers of the benchmark typeset each equation alone, in
// Computer Modern, by our own harness. This script goes to the real thing: it
// downloads the arXiv PDF of each of those papers and asks three questions.
//
//   1. Fonts. Which font families is the paper set in, and what share of its
//      glyphs are in a family the slot table covers?
//   2. Tight boxes. Where an equation of the tier can be found on the paper's
//      page, is it extracted correctly from a box drawn closely around it?
//   3. Loose boxes. And from a box as wide as the text column, which takes in
//      the equation number and anything else on those lines?
//
// An equation is "found" when the exact sequence of (font family, slot) that
// our harness produced for it occurs exactly once, contiguously, in the
// paper's glyph stream. That needs the paper to be in the same fonts, so it
// locates equations only in Computer Modern papers, and only equations the
// paper's own TeX run set the same way ours did.
//
//   npx vite-node scripts/spikes/real-pages.ts <cache dir> [dev|heldout|all]
//
// PDFs are downloaded into <cache dir> (one request every three seconds) and
// never committed. Failures are listed for development papers only; held-out
// papers are reported in aggregate.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildPageMathModel, type ModelGlyph, type OpsTable, type PageMathModel } from "../../src/pdf/pageMathModel";
import { extractLatexFromModel } from "../../src/pdf/scienceOcr";
import { hasSlotTable, inkOf } from "../../src/pdf/texGlyphs";
import { scoreEquation } from "../../src/science/research/latex/score";

const HERE = dirname(fileURLToPath(import.meta.url));
const LATEX = resolve(HERE, "../../src/science/research/latex");
const cache = process.argv[2];
const which = process.argv[3] ?? "all";
if (!cache) throw new Error("usage: vite-node scripts/spikes/real-pages.ts <cache dir> [dev|heldout|all]");
mkdirSync(cache, { recursive: true });

interface Paper { id: string; title: string; set: string; split: "dev" | "heldout" }
interface Manifest {
  equations: Record<string, string>;
  tiers: Record<string, { pdf: string; pageWidth: number; pageHeight: number; placements: [string, number, number, number, number, number][] }>;
}
const store = JSON.parse(readFileSync(resolve(HERE, "../math-corpus/real-papers.json"), "utf8")) as {
  papers: Paper[];
  equations: { paper: string; kind: "display" | "inline"; latex: string }[];
};
const paperOf = new Map(store.equations.map((e) => [e.latex, e.paper]));

async function models(bytes: Uint8Array, maxPages = 80): Promise<PageMathModel[]> {
  const doc = await pdfjs.getDocument({ data: bytes, verbosity: 0 }).promise;
  const out: PageMathModel[] = [];
  for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
    const page = await doc.getPage(n);
    out.push(
      buildPageMathModel(
        await page.getOperatorList(),
        (id) => {
          try {
            return page.commonObjs.get(id);
          } catch {
            return null;
          }
        },
        pdfjs.OPS as unknown as OpsTable,
        page.getViewport({ scale: 1 }),
      ),
    );
    page.cleanup();
  }
  await doc.destroy();
  return out;
}

const keyOf = (g: ModelGlyph): string => `${g.family}:${g.slot}`;

/** What our harness drew for each equation of the real tiers: its glyph sequence. */
async function references(dir: string): Promise<{ id: string; kind: string; latex: string; paper: string; seq: string[] }[]> {
  const manifest = JSON.parse(readFileSync(resolve(LATEX, dir, "manifest.json"), "utf8")) as Manifest;
  const out = [];
  for (const kind of ["display", "inline"]) {
    const tier = manifest.tiers[`real-${kind}`]!;
    const pages = await models(new Uint8Array(readFileSync(resolve(LATEX, dir, tier.pdf))), 10_000);
    for (const [id, page, x0, y0, x1, y1] of tier.placements) {
      const top = tier.pageHeight - y1;
      const bottom = tier.pageHeight - y0;
      const seq = pages[page]!.glyphs
        .filter((g) => {
          const ink = inkOf(g.family, g.slot);
          const cy = g.y - ((ink ? ink[0] + ink[1] : 0.5) / 2) * g.size;
          const cx = g.x + g.advance / 2;
          return cx >= x0 && cx <= x1 && cy >= top && cy <= bottom;
        })
        .map(keyOf);
      const latex = manifest.equations[id]!;
      out.push({ id, kind, latex, paper: paperOf.get(latex) ?? "", seq });
    }
  }
  return out;
}

let last = 0;
function download(id: string): Uint8Array | null {
  const path = join(cache!, `${id}.pdf`);
  if (!existsSync(path)) {
    const wait = last + 3000 - Date.now();
    if (wait > 0) execFileSync("sleep", [String(Math.ceil(wait / 1000))]);
    last = Date.now();
    try {
      execFileSync("curl", ["-sS", "-L", "--fail", "--max-time", "180", "-A", "math-corpus-builder/1.0", "-o", path, `https://arxiv.org/pdf/${id}`]);
    } catch {
      return null;
    }
  }
  const bytes = new Uint8Array(readFileSync(path));
  return String.fromCharCode(...bytes.subarray(0, 4)) === "%PDF" ? bytes : null;
}

/** Start index of `seq` in `stream` if it occurs exactly once, else -1 (absent) or -2 (ambiguous). */
function locate(stream: string[], seq: string[]): number {
  let found = -1;
  outer: for (let i = 0; i + seq.length <= stream.length; i++) {
    for (let j = 0; j < seq.length; j++) if (stream[i + j] !== seq[j]) continue outer;
    if (found >= 0) return -2;
    found = i;
  }
  return found;
}

const pct = (a: number, b: number): string => (b === 0 ? "n/a" : `${((100 * a) / b).toFixed(1)}%`);

const refs = [...(await references("corpus")), ...(await references("corpus-heldout"))];
const totals = new Map<string, { papers: number; cm: number; eq: number; found: number; tight: number; loose: number; looseN: number }>();
const bump = (split: string) => {
  let t = totals.get(split);
  if (!t) totals.set(split, (t = { papers: 0, cm: 0, eq: 0, found: 0, tight: 0, loose: 0, looseN: 0 }));
  return t;
};
const failures: string[] = [];
const kindTotals = new Map<string, [number, number]>();

console.log("paper       split    pages  glyphs  covered  math fonts            found  tight exact  loose exact");
for (const paper of store.papers) {
  if (which !== "all" && paper.split !== which) continue;
  const bytes = download(paper.id);
  if (!bytes) {
    console.log(`${paper.id}  no PDF`);
    continue;
  }
  const pages = await models(bytes);
  const t = bump(paper.split);
  t.papers++;

  // 1. Fonts.
  const families = new Map<string, number>();
  let glyphs = 0;
  let covered = 0;
  for (const p of pages) {
    for (const g of p.glyphs) {
      glyphs++;
      families.set(g.family, (families.get(g.family) ?? 0) + 1);
      if (hasSlotTable(g.family)) covered++;
    }
  }
  const top = [...families].sort((a, b) => b[1] - a[1]);
  const mathFonts = top.filter(([f]) => /MI|SY|EX|MATH|SYM/i.test(f)).slice(0, 3).map(([f]) => f).join(",") || "(none seen)";
  const isCm = covered / Math.max(1, glyphs) > 0.9;
  if (isCm) t.cm++;

  // 2 and 3. Locate each of the tier's equations and extract it.
  const mine = refs.filter((r) => r.paper === paper.id);
  let found = 0;
  let tight = 0;
  let loose = 0;
  let looseN = 0;
  const streams = pages.map((p) => p.glyphs.map(keyOf));
  for (const r of mine) {
    t.eq++;
    if (r.seq.length < 3) continue; // too short to place with confidence
    let hit: { page: number; at: number } | null = null;
    let ambiguous = false;
    for (let pi = 0; pi < pages.length && !ambiguous; pi++) {
      const at = locate(streams[pi]!, r.seq);
      if (at === -2 || (at >= 0 && hit)) ambiguous = true;
      else if (at >= 0) hit = { page: pi, at };
    }
    if (ambiguous || !hit) continue;
    found++;
    t.found++;
    const model = pages[hit.page]!;
    const part = model.glyphs.slice(hit.at, hit.at + r.seq.length);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const g of part) {
      const ink = inkOf(g.family, g.slot) ?? [-0.2, 0.75];
      x0 = Math.min(x0, g.x);
      x1 = Math.max(x1, g.x + g.advance);
      y0 = Math.min(y0, g.y - ink[1] * g.size);
      y1 = Math.max(y1, g.y - ink[0] * g.size);
    }
    const pad = r.kind === "display" ? 3 : 1.5;
    const rect = (ax0: number, ax1: number) => ({
      x: (ax0 - pad) / model.width,
      y: (y0 - pad) / model.height,
      width: (ax1 - ax0 + 2 * pad) / model.width,
      height: (y1 - y0 + 2 * pad) / model.height,
    });
    const okTight = scoreEquation(r.latex, extractLatexFromModel(model, rect(x0, x1))).exact;
    if (okTight) {
      tight++;
      t.tight++;
    } else if (paper.split === "dev") {
      failures.push(`${paper.id} ${r.kind}\n  E: ${r.latex}\n  G: ${extractLatexFromModel(model, rect(x0, x1))}`);
    }
    const k = kindTotals.get(`${paper.split} ${r.kind}`) ?? [0, 0];
    k[0]++;
    if (okTight) k[1]++;
    kindTotals.set(`${paper.split} ${r.kind}`, k);
    if (r.kind === "display") {
      // As wide as everything on the page: takes in an equation number and margin notes on those lines.
      const px0 = Math.min(...model.glyphs.map((g) => g.x));
      const px1 = Math.max(...model.glyphs.map((g) => g.x + g.advance));
      looseN++;
      t.looseN++;
      if (scoreEquation(r.latex, extractLatexFromModel(model, rect(px0, px1))).exact) {
        loose++;
        t.loose++;
      }
    }
  }
  console.log(
    `${paper.id.padEnd(11)} ${paper.split.padEnd(8)} ${String(pages.length).padStart(5)} ${String(glyphs).padStart(7)}  ${pct(covered, glyphs).padStart(6)}  ${mathFonts.slice(0, 20).padEnd(20)}  ${String(found).padStart(2)}/${String(mine.length).padEnd(3)} ${`${tight}/${found}`.padStart(8)}     ${`${loose}/${looseN}`.padStart(8)}`,
  );
}

console.log("");
for (const [split, t] of totals) {
  console.log(`${split}: ${t.papers} papers, ${t.cm} of them over 90% in fonts the slot table covers`);
  console.log(`  equations of the tier found on the papers' pages: ${t.found} of ${t.eq} (${pct(t.found, t.eq)})`);
  console.log(`  exact from a tight box: ${t.tight} of ${t.found} (${pct(t.tight, t.found)})`);
  console.log(`  exact from a column-wide box (display only): ${t.loose} of ${t.looseN} (${pct(t.loose, t.looseN)})`);
}
for (const [k, [n, ok]] of kindTotals) console.log(`  ${k}: ${ok} of ${n} (${pct(ok, n)})`);
if (failures.length > 0) {
  console.log(`\nfailures from a tight box, development papers (${failures.length}):`);
  for (const f of failures.slice(0, Number(process.env.ITO_SHOW ?? 40))) console.log(f);
}
