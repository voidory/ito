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
  `\leq`, `\left(` equals `(`. Anything visible on the page does count: fonts
  (`\mathbf`, `\mathbb`, `\mathrm`), variant letters (`\varepsilon`), accents.
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
`BENCHMARK.md`. Both build the app and take about two minutes.

| Variable | Effect |
|---|---|
| `ITO_CHROMIUM_PATH` | Use an already-installed Chromium instead of Playwright's pinned build |
| `ITO_LATEX_BENCH_TIERS=a,b` | Only these tiers (no report, no gate) |
| `ITO_LATEX_BENCH_LIMIT=n` | First `n` selections per tier (no report, no gate) |
| `ITO_LATEX_BENCH_DUMP=file.json` | Write every selection's expected and drafted LaTeX |

## Target and gate

`thresholds.json` holds a `target` and a `floor` per tier.

- The **target** for every TeX tier is 99.9% exact match.
- The **floor** is what CI enforces (`.github/workflows/latex-benchmark.yml`).
  It sits one point under the measured baseline and should only be raised.

A 99.9% claim needs a large corpus: with zero failures in `n` selections, the
95% upper bound on the true failure rate is about `3/n`. The display tier has
3,460 selections so that the bound can fall under 0.1%; the smaller tiers
cannot show 99.9% on their own, only pooled.

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

- **Real-paper tier.** Open-licence arXiv PDFs with hand-drawn boxes. Needs a
  per-paper licence check and manual labelling.
- **Other-producer tier.** Word and LibreOffice exports.

Both go in `corpus/manual-tiers.json` (`{ "equations": {...}, "tiers": {...} }`,
same shape as the manifest), which the generator merges and never overwrites.
Add a matching entry to `thresholds.json`.
