import { expect, test, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  failureRateUpperBound,
  scoreEquation,
  tally,
  tallyByConstruct,
  type EquationScore,
  type Tally,
} from "../src/science/research/latex/score";

/**
 * LaTeX-extraction benchmark (docs/LATEX-EXTRACTION-PLAN.md, Phase 1).
 *
 * For every equation in the corpus it draws the recorded box on the real page,
 * in real Chromium, through the reader's own render -> crop -> extract path,
 * and compares the drafted LaTeX with the ground truth structurally.
 *
 *   npm run benchmark:latex           measure and enforce the floors
 *   npm run benchmark:latex:report    also rewrite BENCHMARK.md
 *
 * ITO_LATEX_BENCH_TIERS=a,b limits the tiers and ITO_LATEX_BENCH_LIMIT=n the
 * equations per tier, for quick local runs; a partial run never writes the
 * report and never enforces floors. ITO_LATEX_BENCH_DUMP=file.json writes every
 * selection's expected and drafted LaTeX, for digging into failures.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../src/science/research/latex");

interface Manifest {
  seed: number;
  equations: Record<string, string>;
  tiers: Record<
    string,
    {
      pdf: string;
      description: string;
      pageWidth: number;
      pageHeight: number;
      placements: [string, number, number, number, number, number][];
    }
  >;
}
interface Thresholds {
  extractionScale: number;
  tiers: Record<string, { target: number | null; floor: number }>;
}
interface Result {
  id: string;
  expected: string;
  got: string;
  score: EquationScore;
}

const manifest = JSON.parse(readFileSync(resolve(ROOT, "corpus/manifest.json"), "utf8")) as Manifest;
const thresholds = JSON.parse(readFileSync(resolve(ROOT, "thresholds.json"), "utf8")) as Thresholds;

const onlyTiers = process.env.ITO_LATEX_BENCH_TIERS?.split(",").map((s) => s.trim()).filter(Boolean);
const limit = Number(process.env.ITO_LATEX_BENCH_LIMIT ?? 0);
const partial = Boolean(onlyTiers?.length) || limit > 0;
const tierNames = Object.keys(manifest.tiers).filter((t) => !onlyTiers || onlyTiers.includes(t));
const results = new Map<string, Result[]>();

async function importPdf(page: Page, pdf: string): Promise<string> {
  await page.goto("/");
  await expect(page.getByTestId("app-status")).toHaveAttribute("data-state", "ready", {
    timeout: 30_000,
  });
  await page.getByTestId("import-pdf-input").setInputFiles(resolve(ROOT, "corpus", pdf));
  const item = page.getByTestId("library-item").filter({ hasText: pdf.replace(/\.pdf$/, "") });
  await expect(item).toBeVisible({ timeout: 120_000 });
  const id = await item.getAttribute("data-source-id");
  if (!id) throw new Error(`no source id for ${pdf}`);
  return id;
}

test.describe.configure({ mode: "serial" });

for (const name of tierNames) {
  test(`measure ${name}`, async ({ page }) => {
    const tier = manifest.tiers[name]!;
    const placements = limit > 0 ? tier.placements.slice(0, limit) : tier.placements;
    const sourceId = await importPdf(page, tier.pdf);

    const byPage = new Map<number, typeof placements>();
    for (const p of placements) {
      const list = byPage.get(p[1]);
      if (list) list.push(p);
      else byPage.set(p[1], [p]);
    }
    const out: Result[] = [];
    for (const [pageIndex, boxes] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
      // PDF points (origin bottom-left) -> normalized page rect (origin top-left).
      const rects = boxes.map(([, , x0, y0, x1, y1]) => ({
        x: x0 / tier.pageWidth,
        y: (tier.pageHeight - y1) / tier.pageHeight,
        width: (x1 - x0) / tier.pageWidth,
        height: (y1 - y0) / tier.pageHeight,
      }));
      const drafted = await page.evaluate(
        async ({ id, index, list, scale }) => {
          const acc: string[] = [];
          for (const rect of list) acc.push(await window.__ito.extractLatexAt(id, index, rect, { scale }));
          return acc;
        },
        { id: sourceId, index: pageIndex, list: rects, scale: thresholds.extractionScale },
      );
      boxes.forEach(([id], i) => {
        const expected = manifest.equations[id]!;
        const got = drafted[i] ?? "";
        out.push({ id, expected, got, score: scoreEquation(expected, got) });
      });
    }
    results.set(name, out);
    const t = tally(out.map((r) => r.score));
    console.log(`${name}: ${t.exact}/${t.n} exact (${pct(t.exactRate)}), mean similarity ${t.meanSimilarity.toFixed(3)}`);
  });
}

test("report and gate", async () => {
  expect([...results.keys()]).toEqual(tierNames);
  const report = renderReport();
  if (process.env.ITO_WRITE_LATEX_BENCHMARK === "1" && !partial) {
    writeFileSync(resolve(ROOT, "BENCHMARK.md"), report);
  }
  // Every selection's outcome, for digging into failures (not committed).
  const dump = process.env.ITO_LATEX_BENCH_DUMP;
  if (dump) {
    const all = Object.fromEntries(
      [...results.entries()].map(([tier, list]) => [
        tier,
        list.map((r) => ({ id: r.id, exact: r.score.exact, similarity: r.score.similarity, constructs: r.score.constructs, expected: r.expected, got: r.got })),
      ]),
    );
    writeFileSync(dump, JSON.stringify(all, null, 1));
  }
  if (partial) return;
  for (const name of tierNames) {
    const t = tally(results.get(name)!.map((r) => r.score));
    const floor = thresholds.tiers[name]?.floor ?? 0;
    expect(t.exactRate, `${name} exact-match rate fell below its floor`).toBeGreaterThanOrEqual(floor);
  }
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function pct(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

function row(label: string, t: Tally, extra: string[] = []): string {
  return `| ${label} | ${t.n} | ${t.exact} | ${pct(t.exactRate)} | ${t.meanSimilarity.toFixed(3)} |${extra.map((e) => ` ${e} |`).join("")}`;
}

function renderReport(): string {
  const lines: string[] = [];
  const all = (name: string): Result[] => results.get(name) ?? [];
  const texTiers = tierNames.filter((t) => t.startsWith("tex-"));
  const pooled = texTiers.flatMap(all);

  lines.push("# Box-selection LaTeX extraction benchmark", "");
  lines.push(
    "Auto-generated by `npm run benchmark:latex:report`. Do not edit by hand.",
    "",
    `Corpus: **${Object.keys(manifest.equations).length}** distinct equations (seed ${manifest.seed}), ` +
      `**${tierNames.reduce((n, t) => n + all(t).length, 0)}** box selections across ${tierNames.length} tiers. ` +
      `Pages rendered at scale ${thresholds.extractionScale} in headless Chromium.`,
    "",
    "Metric: **exact match** of the canonical structure tree (`normalize.ts`), so spelling " +
      "differences such as `x^{2}` vs `x^2` do not count as errors. **Mean similarity** is " +
      "1 minus the normalised tree edit distance, for partial credit.",
    "",
    "## Accuracy by tier",
    "",
    "| Tier | Selections | Exact | Exact rate | Mean similarity | Target | CI floor | Best provable |",
    "|---|---|---|---|---|---|---|---|",
  );
  for (const name of tierNames) {
    const t = tally(all(name).map((r) => r.score));
    const th = thresholds.tiers[name];
    lines.push(
      row(`\`${name}\``, t, [
        th?.target != null ? pct(th.target) : "n/a",
        pct(th?.floor ?? 0),
        pct(1 - failureRateUpperBound(t.n, 0)),
      ]),
    );
  }
  if (texTiers.length > 1) {
    const t = tally(pooled.map((r) => r.score));
    lines.push(row("**all TeX tiers**", t, ["99.90%", "", pct(1 - failureRateUpperBound(t.n, 0))]));
  }
  lines.push(
    "",
    "*Best provable* is the highest success rate a tier of that size could demonstrate at 95% " +
      "confidence with zero failures. A tier must be larger than about 3,000 selections before " +
      "a 99.9% claim is even testable.",
    "",
  );
  for (const name of tierNames) {
    lines.push(`- \`${name}\`: ${manifest.tiers[name]!.description}`);
  }

  for (const name of tierNames) {
    const list = all(name);
    const empty = list.filter((r) => r.got.trim().length === 0).length;
    lines.push("", `## \`${name}\` by construct`, "");
    lines.push(`Empty extractions: ${empty} of ${list.length}.`, "");
    lines.push("| Construct | Selections | Exact | Exact rate | Mean similarity |", "|---|---|---|---|---|");
    for (const [construct, t] of tallyByConstruct(list.map((r) => r.score))) {
      lines.push(row(construct, t));
    }
  }

  // Worked failures for the main tier: the first few per construct, by id.
  const main = all(tierNames.includes("tex-display") ? "tex-display" : tierNames[0]!);
  const failures = main.filter((r) => !r.score.exact);
  lines.push("", "## Sample failures (`tex-display`)", "");
  lines.push(
    `${failures.length} of ${main.length} selections fail. Up to three per construct, lowest id first; ` +
      "an equation appears under each construct it exercises.",
    "",
  );
  const byConstruct = new Map<string, Result[]>();
  for (const f of failures) {
    for (const c of f.score.constructs) {
      const g = byConstruct.get(c);
      if (g) g.push(f);
      else byConstruct.set(c, [f]);
    }
  }
  const clip = (s: string): string => (s.length > 140 ? `${s.slice(0, 140)}…` : s);
  for (const [construct, list] of [...byConstruct.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`### ${construct} (${list.length} failing)`, "");
    for (const f of list.slice(0, 3)) {
      lines.push(`- \`${f.id}\` expected \`${clip(f.expected)}\``);
      lines.push(`  - got \`${clip(f.got) || "(empty)"}\` (similarity ${f.score.similarity.toFixed(2)})`);
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}
