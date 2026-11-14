import { expect, test, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  failureRateUpperBound,
  pairedGapInterval,
  rateGapInterval,
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
 *   npm run benchmark:latex:report    also rewrite BENCHMARK.md and BENCHMARK.json
 *   npm run benchmark:latex:heldout   measure the held-out set (phase gates only)
 *
 * The held-out set (corpus-heldout/, ITO_LATEX_BENCH_SET=heldout) holds
 * equations the extractor was never developed against. Its report,
 * BENCHMARK-HELDOUT.md, is aggregate only and a dump is refused, so the
 * extractor cannot be tuned to it; what it shows is the gap to the
 * development corpus.
 *
 * ITO_LATEX_BENCH_TIERS=a,b limits the tiers and ITO_LATEX_BENCH_LIMIT=n the
 * equations per tier, for quick local runs; a partial run never writes the
 * report and never enforces floors. ITO_LATEX_BENCH_DUMP=file.json writes every
 * selection's expected and drafted LaTeX, for digging into failures.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../src/science/research/latex");

interface Manifest {
  set?: string;
  seed: number;
  /** Held-out set only: the development equations it also drew (see the corpus builder). */
  comparison?: { drawn: number; excludedDevIds: string[] };
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
  heldout: Record<string, { target: number | null }>;
}
/** BENCHMARK.json: the development numbers the held-out report compares with. */
interface DevResults {
  note: string;
  tiers: Record<string, { n: number; exact: number; comparable: { n: number; exact: number } }>;
}
interface Result {
  id: string;
  expected: string;
  got: string;
  score: EquationScore;
}

const heldout = process.env.ITO_LATEX_BENCH_SET === "heldout";
const CORPUS = resolve(ROOT, heldout ? "corpus-heldout" : "corpus");
if (heldout && process.env.ITO_LATEX_BENCH_DUMP) {
  throw new Error("The held-out set is reported in aggregate only: ITO_LATEX_BENCH_DUMP is refused.");
}
const manifest = JSON.parse(readFileSync(resolve(CORPUS, "manifest.json"), "utf8")) as Manifest;
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
  await page.getByTestId("import-pdf-input").setInputFiles(resolve(CORPUS, pdf));
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
  const write = process.env.ITO_WRITE_LATEX_BENCHMARK === "1" && !partial;
  if (heldout) {
    // Aggregate report only, and no floors: this set is a check, not a gate.
    if (write) writeFileSync(resolve(ROOT, "BENCHMARK-HELDOUT.md"), renderHeldoutReport());
    return;
  }
  if (write) {
    writeFileSync(resolve(ROOT, "BENCHMARK.md"), renderReport());
    writeFileSync(resolve(ROOT, "BENCHMARK.json"), JSON.stringify(devResults(), null, 1) + "\n");
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

const all = (name: string): Result[] => results.get(name) ?? [];

/**
 * Per-tier counts, overall and for the part the held-out set is comparable
 * with: generated equations, less the ones the held-out draw also produced
 * (which that set dropped, so this side must drop them too).
 */
function devResults(): DevResults {
  let twins = new Set<string>();
  try {
    const other = JSON.parse(readFileSync(resolve(ROOT, "corpus-heldout/manifest.json"), "utf8")) as Manifest;
    twins = new Set(other.comparison?.excludedDevIds ?? []);
  } catch {
    twins = new Set();
  }
  const tiers: DevResults["tiers"] = {};
  for (const name of tierNames) {
    const list = all(name);
    const comparable = list.filter((r) => r.id.startsWith("g") && !twins.has(r.id));
    tiers[name] = {
      n: list.length,
      exact: list.filter((r) => r.score.exact).length,
      comparable: { n: comparable.length, exact: comparable.filter((r) => r.score.exact).length },
    };
  }
  return {
    note: "Generated by `npm run benchmark:latex:report`. `comparable` counts generated equations only, less those the held-out draw also produced; BENCHMARK-HELDOUT.md compares against it.",
    tiers,
  };
}

function constructTables(lines: string[]): void {
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
}

function renderHeldoutReport(): string {
  const lines: string[] = [];
  let dev: DevResults | null = null;
  try {
    dev = JSON.parse(readFileSync(resolve(ROOT, "BENCHMARK.json"), "utf8")) as DevResults;
  } catch {
    dev = null;
  }
  const points = (v: number): string => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}`;

  lines.push("# Box-selection LaTeX extraction: held-out check", "");
  lines.push(
    "Auto-generated by `npm run benchmark:latex:heldout`. Do not edit by hand.",
    "",
    `Held-out set: **${Object.keys(manifest.equations).length}** grammar equations (seed ${manifest.seed}), none of ` +
      `them in the development corpus, **${tierNames.reduce((n, t) => n + all(t).length, 0)}** box selections ` +
      `across ${tierNames.length} tiers. Pages rendered at scale ${thresholds.extractionScale} in headless Chromium.`,
    "",
    "Only aggregates are reported. Individual failures are deliberately left out, and the runner " +
      "refuses to dump them, so the extractor cannot be tuned to this set. Run it at phase gates, " +
      "right after `npm run benchmark:latex:report`, not during development.",
    "",
    "## Accuracy by tier",
    "",
    "| Tier | Selections | Exact | Exact rate | Mean similarity | Target | Best provable |",
    "|---|---|---|---|---|---|---|",
  );
  for (const name of tierNames) {
    const t = tally(all(name).map((r) => r.score));
    const target = thresholds.heldout[name]?.target;
    lines.push(row(`\`${name}\``, t, [target != null ? pct(target) : "n/a", pct(1 - failureRateUpperBound(t.n, 0))]));
  }
  lines.push("");
  for (const name of tierNames) {
    lines.push(`- \`${name}\`: ${manifest.tiers[name]!.description}`);
  }

  lines.push(
    "",
    "## Gap to what the extractor was developed against",
    "",
    "| Held-out tier | Compared with | Its rate | Held-out rate | Gap | 95% interval | Reading |",
    "|---|---|---|---|---|---|---|",
  );
  const reading = (g: { lower: number; upper: number }): string =>
    g.lower > 0 ? "**worse on unseen**" : g.upper < 0 ? "better on unseen" : "no detectable gap";
  for (const name of tierNames) {
    const list = all(name);
    const t = tally(list.map((r) => r.score));
    const d = dev?.tiers[name]?.comparable;
    if (d && d.n > 0) {
      // Same typesetting, different equations: has the extractor been fitted
      // to the development corpus?
      const g = rateGapInterval(d.exact, d.n, t.exact, t.n);
      lines.push(
        `| \`${name}\` | development \`${name}\`, ${d.n} comparable equations | ${pct(d.exact / d.n)} | ${pct(t.exactRate)} | ` +
          `${points(g.gap)} pts | ${points(g.lower)} to ${points(g.upper)} | ${reading(g)} |`,
      );
      continue;
    }
    // A tier with no development counterpart (12pt) is compared with the same
    // equations in the held-out 10pt tier: same equations, different fonts.
    const base = name.replace(/-\d+pt$/, "");
    const twin = new Map(all(base).map((r) => [r.id, r.score.exact]));
    const pairs = list.filter((r) => twin.has(r.id));
    if (base === name || pairs.length === 0) continue;
    const baseExact = pairs.filter((r) => twin.get(r.id)).length;
    const onlyBase = pairs.filter((r) => twin.get(r.id) && !r.score.exact).length;
    const onlyHere = pairs.filter((r) => !twin.get(r.id) && r.score.exact).length;
    const g = pairedGapInterval(onlyBase, onlyHere, pairs.length);
    lines.push(
      `| \`${name}\` | the same ${pairs.length} equations in held-out \`${base}\` | ${pct(baseExact / pairs.length)} | ` +
        `${pct(t.exactRate)} | ${points(g.gap)} pts | ${points(g.lower)} to ${points(g.upper)} | ${reading(g)} |`,
    );
  }
  lines.push(
    "",
    "*Gap* is the compared rate minus the held-out rate. For the 10pt tiers the comparison is the " +
      "same extractor on the development corpus, read from `BENCHMARK.json`: generated equations " +
      "only, less the ones this set's draw also produced, so both sides were drawn by the same " +
      "rule and lost the same equations. The interval is Newcombe's for two independent " +
      "proportions. An interval wholly above zero means the extractor does better on equations " +
      "it was developed against than on unseen ones: it has been fitted to the corpus. For the " +
      "12pt tier the comparison is paired: identical equations set in other font design sizes, " +
      "so a gap there is about fonts, not about which equations were seen.",
  );
  constructTables(lines);
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function renderReport(): string {
  const lines: string[] = [];
  // The tiers the 99.9% claim is made for (thresholds.json).
  const targetTiers = tierNames.filter((t) => thresholds.tiers[t]?.target != null);
  const pooled = targetTiers.flatMap(all);

  lines.push("# Box-selection LaTeX extraction benchmark", "");
  lines.push(
    "Auto-generated by `npm run benchmark:latex:report`. Do not edit by hand.",
    "",
    `Corpus: **${Object.keys(manifest.equations).length}** distinct equations (seed ${manifest.seed}), ` +
      `**${tierNames.reduce((n, t) => n + all(t).length, 0)}** box selections across ${tierNames.length} tiers. ` +
      `Pages rendered at scale ${thresholds.extractionScale} in headless Chromium.`,
    "",
    "Metric: **exact match** of the canonical structure tree (`normalize.ts`), so spelling " +
      "differences such as `x^{2}` vs `x^2` do not count as errors, while fonts, variant letters, " +
      "accents and word spaces inside text do. **Mean similarity** is " +
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
  if (targetTiers.length > 1) {
    const t = tally(pooled.map((r) => r.score));
    lines.push(row("**all target tiers**", t, ["", "", pct(1 - failureRateUpperBound(t.n, 0))]));
  }
  lines.push(
    "",
    "The **target** of 99.9% exact match is claimed for pdfLaTeX with Computer Modern and AMS " +
      "fonts only; other font families and scanned pages get their own targets once their " +
      "baselines are understood. *Best provable* is the highest success rate a tier of that size " +
      "could demonstrate at 95% confidence with zero failures. A tier must be larger than about " +
      "3,000 selections before a 99.9% claim is even testable.",
    "",
  );
  for (const name of tierNames) {
    lines.push(`- \`${name}\`: ${manifest.tiers[name]!.description}`);
  }

  constructTables(lines);

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
