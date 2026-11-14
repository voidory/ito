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
  How a run of one font is grouped does not count, because it does not show:
  `\mathbf{AB}` equals `\mathbf{A}\mathbf{B}`, and a script after a font group
  sits on its last character (`\mathrm{Te}^b` equals `\mathrm{T}\mathrm{e}^b`).
  A comma, full stop, semicolon or colon that ends the formula, or a line of a
  several-line one, belongs to the sentence and does not count: `E = mc^2.`
  equals `E = mc^2`. More than half of the real display equations end in one.
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
| `real-display` | Display equations from the source of 30 arXiv papers, set by the same harness |
| `real-inline` | Inline formulas from the same papers, each inside a line of prose |
| `real-inline-punct` | The same inline formulas with a comma, full stop, semicolon or colon set against each, inside the box |
| `real-display-numbered` | The same display equations centred and numbered as `equation` sets them, with a box as wide as the column |
| `real-display-dvips` | The same display equations through `latex`, `dvips` and Ghostscript, which draw rules as image masks |
| `real-display-lm` | The same display equations in Latin Modern (`lmodern`, T1 text) |

160 equations are hand-picked real formulas (`scripts/math-corpus/curated.mjs`);
the rest come from a seeded grammar (`scripts/math-corpus/grammar.mjs`) that
produces valid but not meaningful mathematics. Treat a number on this corpus as
a statement about TeX typesetting, not about real papers.

### Real-paper tiers

The grammar decides how often each construct appears in the generated tiers,
and it was written to cover constructs, not to match how often authors use
them. The real-paper tiers fix that: their equations and their frequencies are
the authors'.

`scripts/gen-real-paper-tier.mjs harvest` takes 60 arXiv papers under CC BY 4.0
or CC0 (mathematics, physics, computer science, statistics), reads the
equations out of their LaTeX source and expands the authors' own simple macros.
Thirty papers go to this corpus and thirty to the held-out set, so no paper is
in both. The papers and their licences are listed in `SOURCES.md`.

Read the numbers with three limits in mind:

- **The page is ours.** Each equation is typeset alone by the benchmark's
  harness (pdfLaTeX, amsmath, Computer Modern), not cut out of the paper's own
  PDF. The tier tests real mathematics, not real page layout: no equation
  numbers, no surrounding text, no other fonts.
- **Equations on heavy macros are left out.** An equation is kept only if,
  after expansion, every command in it is in the benchmark's vocabulary and it
  compiles in the harness. Of 59,026 formulas found, 5,914 were dropped for a
  command outside the vocabulary, half of them the old font switch `\rm`.
  Another 13,779 were dropped as trivial (a lone symbol) and 14,932 as
  duplicates. What remains leans towards plainly written LaTeX.
- **At most 30 display and 30 inline formulas per paper**, spread evenly
  through it, so one long paper cannot dominate.

### Tiers for what surrounds an equation

Four tiers reset the real tiers' equations the way a reader meets them
(`docs/spikes/real-pages.md` is why they exist). Each should score what its
plain tier scores; a gap is a defect in how the extractor handles the
surroundings, not the mathematics.

- **`real-inline-punct`** does not gate the dropping of the mark itself: the
  metric ignores a final mark either way. A unit test does
  (`mathLayout.test.ts`). The tier catches a mark being read as something
  else, such as a subscript.
- **`real-display-numbered`** scored 0 of 610 before equation numbers were
  dropped. Numbers are `(3)`, `(2.14)`, `(A.1)` and `(12a)` in turn, beside
  the equation or on the next line when it is too wide.
- **`real-display-dvips`** needs `dvips` and `gs` to regenerate.
- **`real-display-lm`** needs the `lmodern` package.

### Regenerating

```bash
npm run gen-math-corpus
```

```bash
node scripts/gen-real-paper-tier.mjs
```

The second command retypesets the real-paper tiers from
`scripts/math-corpus/real-papers.json` and then runs the first for both sets.
Adding `harvest` fetches papers from arXiv again, which needs network access
to `arxiv.org` and `oaipmh.arxiv.org`.

Needs `pdflatex` (Debian: `texlive-latex-base texlive-fonts-recommended`),
`pdftoppm` (`poppler-utils`) and Node 22.18 or later; the real-paper tiers
also need `dvips`, `gs` (`ghostscript`) and `lmodern`. Output is deterministic:
the same seed and TeX version give byte-identical files. Changing the corpus
changes the baseline, so rerun the report and revisit the floors in the same
commit.

### Not built yet

- **Real pages.** The real-paper tiers (below) hold real equations on the
  harness's own pages. Boxes drawn on the papers' own PDFs, with their fonts,
  numbering and line breaks, are not built.
- **Other-producer tier.** Word and LibreOffice exports.

Such tiers go in `corpus/manual-tiers.json` (`{ "equations": {...}, "tiers": {...} }`,
same shape as the manifest), which the generator merges and never overwrites.
Add a matching entry to `thresholds.json`.
