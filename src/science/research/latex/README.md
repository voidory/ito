# LaTeX extraction benchmark

Measures how well the reader drafts LaTeX from a box drawn over an equation
(Phase 1 of `docs/LATEX-EXTRACTION-PLAN.md`). Current numbers are in
[`BENCHMARK.md`](BENCHMARK.md), which is generated.

## What it does

For every equation in the corpus it draws the recorded box on the real page, in
real Chromium, through the same render, crop and extraction path as the Area
tool, and compares the drafted LaTeX with the ground truth.

- **Exact match** means the two strings have the same canonical structure tree
  (`normalize.ts`). Spelling does not count: `x^{2}` equals `x^2`, `\le` equals
  `\leq`. Neither do size and spacing: `\left(` equals `(`, `\,` is dropped,
  and a space at either end of a text run is ignored (`\text{if }x` equals
  `\text{if}x`). What a reader would call a different formula does count:
  fonts (`\mathbf`, `\mathbb`, `\mathrm`), variant letters (`\varepsilon`),
  accents, and word spaces inside text (`\text{is even}` is not
  `\text{iseven}`).
- **Mean similarity** is 1 minus the normalised tree edit distance (`score.ts`),
  so a nearly-right draft scores higher than an empty one.

## Running it

```bash
npm run benchmark:latex
```

```bash
npm run benchmark:latex:report
```

The first measures and enforces the floors; the second also rewrites
`BENCHMARK.md` and `BENCHMARK.json` (the counts the held-out report compares
with). Both build the app and take about two minutes.

| Variable | Effect |
|---|---|
| `ITO_CHROMIUM_PATH` | Use an already-installed Chromium instead of Playwright's pinned build |
| `ITO_LATEX_BENCH_TIERS=a,b` | Only these tiers (no report, no gate) |
| `ITO_LATEX_BENCH_LIMIT=n` | First `n` selections per tier (no report, no gate) |
| `ITO_LATEX_BENCH_DUMP=file.json` | Write every selection's expected and drafted LaTeX |

## Target and gate

`thresholds.json` holds a `target` and a `floor` per tier.

- The **target** is 99.9% exact match, claimed for pdfLaTeX with Computer
  Modern and AMS fonts: the `tex-display`, `tex-inline` and `tex-tounicode`
  tiers. Tiers in other fonts (`tex-times`) and scanned pages have no target
  until their baselines are understood.
- The **floor** is what CI enforces (`.github/workflows/latex-benchmark.yml`).
  It sits one point under the measured baseline and should only be raised.

A 99.9% claim needs a large corpus: with zero failures in `n` selections, the
95% upper bound on the true failure rate is about `3/n`. The display tier has
3,460 selections so that the bound can fall under 0.1%; the smaller tiers
cannot show 99.9% on their own, only pooled.

## Held-out set

A rule-based extractor that is tuned against a fixed corpus will fit that
corpus. `corpus-heldout/` is the check: 3,259 equations drawn from the same
grammar by the same rule with another seed, none of them in the development
corpus.

```bash
npm run benchmark:latex:heldout
```

It writes [`BENCHMARK-HELDOUT.md`](BENCHMARK-HELDOUT.md). Rules of use:

- **Run it at phase gates only**, straight after `npm run benchmark:latex:report`
  (it compares against the `BENCHMARK.json` that run writes). Not during
  development.
- **Do not look at individual failures.** The report holds aggregates only and
  the runner refuses `ITO_LATEX_BENCH_DUMP` for this set. Opening the PDFs to
  see what failed defeats the purpose.
- It has targets but no floors, and is not part of the push gate. The CI
  workflow runs it on manual dispatch with the `heldout` box ticked, and
  uploads the three report files.

What the report shows is a gap with a 95% interval, and whether that interval
excludes zero:

| Held-out tier | Compared with | A gap means |
|---|---|---|
| `tex-display`, `tex-inline` | The same tier of the development corpus | The extractor has been fitted to the development equations |
| `tex-display-12pt` | The same 760 equations in held-out `tex-display` | The extractor depends on the font design sizes it was developed on (10pt uses `cmr10/7/5`, 12pt uses `cmr12/8/6`) |

The comparison leaves out, on both sides, the 41 equations that both draws
produced. They are short and easy; dropping them from one side only makes that
side look worse.

Regenerate with `node scripts/gen-math-corpus.mjs heldout`. Doing so after
looking at results spends the set: a new seed is then a new, unseen set.

## Corpus

`corpus/manifest.json` lists the equations (`id -> LaTeX`) and, per tier, each
selection as `[id, page, x0, y0, x1, y1]` in PDF points from the bottom-left.

| Tier | Source |
|---|---|
| `tex-display` | pdfLaTeX, Computer Modern, display style |
| `tex-inline` | pdfLaTeX, Computer Modern, text style inside a line of prose |
| `tex-times` | pdfLaTeX, Times math (`mathptmx`) |
| `tex-tounicode` | pdfLaTeX, Computer Modern with ToUnicode maps |
| `scanned` | Image-only pages rasterised from the display tier |

160 equations are hand-picked real formulas (`scripts/math-corpus/curated.mjs`);
the rest come from a seeded grammar (`scripts/math-corpus/grammar.mjs`) that
produces valid but not meaningful mathematics. Treat a number on this corpus as
a statement about TeX typesetting, not about real papers.

### Regenerating

```bash
npm run gen-math-corpus
```

Needs `pdflatex` (Debian: `texlive-latex-base texlive-fonts-recommended`),
`pdftoppm` (`poppler-utils`) and Node 22.18 or later. Output is deterministic:
the same seed and TeX version give byte-identical files. Changing the corpus
changes the baseline, so rerun the report and revisit the floors in the same
commit.

### Not built yet

- **Real-paper tier.** The plan is to harvest ground truth from the LaTeX
  source of arXiv papers, compiled with the same position markers this corpus
  uses, and to commit only papers under CC BY or CC0. Authors' macros must be
  expanded first, which is the open problem.
- **Other-producer tier.** Word and LibreOffice exports.

Both go in `corpus/manual-tiers.json` (`{ "equations": {...}, "tiers": {...} }`,
same shape as the manifest), which the generator merges and never overwrites.
Add a matching entry to `thresholds.json`.
