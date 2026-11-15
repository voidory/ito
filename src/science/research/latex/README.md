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

- There are two targets. **99.9% exact match** is claimed for the generated
  tiers (`tex-display`, `tex-inline`, `tex-tounicode`: pdfLaTeX, Computer
  Modern and AMS fonts, a seeded grammar): a statement about TeX typesetting.
  **95% for display equations and 99% for inline ones** is the target for the
  real-paper tiers, and the number that checks it is the sealed set's, the
  only one on papers the extractor was not developed against. It stood at
  93.4% and 99.0% at the third look. The 99.9% once set for real papers was
  retired: three independent sets of thirty papers sat near 93% before their
  failures were read, and the failures are a long tail of single-paper
  notation (see "Survey set"). Tiers in other fonts (`tex-times`,
  `real-display-times` to `real-display-stix`) and scanned pages have a floor
  and no target: part of what they miss is not on the page (see "Tiers in
  other fonts").
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
- **Do not look at individual failures of the generated tiers.** The report
  holds aggregates only and the runner refuses `ITO_LATEX_BENCH_DUMP` for this
  set. Opening the PDFs to see what failed defeats the purpose. The set's
  real-paper tiers are the exception: they were opened for development when
  the sealed set was made (below), and no longer measure fitting.
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

## Sealed set

`corpus-sealed/` holds 1,579 equations from 30 more arXiv papers (CC BY 4.0
or CC0, another date window), none of them in either other set. It has the
six real-paper tiers and nothing else.

```bash
npm run benchmark:latex:sealed
```

It writes [`BENCHMARK-SEALED.md`](BENCHMARK-SEALED.md). It exists because the
real-paper tiers of the other two sets are no longer unseen:

- **The development papers' failures were read from the start.** By the end of
  Phase 3's first slice the development `real-display` tier stood at 97.9% and
  the held-out one at 92.7%, a gap whose interval excluded zero.
- **The held-out papers' failures were read once this set existed**, and rules
  written against them. Their `real-display` tier went from 92.7% to 97.6%.
- **This set's failures have not been read.** Measured before and after those
  rules it stood at 92.9% and 93.2%. Rules written against one set of papers
  barely carry to the next: what fails is each paper's own notation.
- **Third look**, after the font tables and the survey fixes (rules written
  against 300 other papers, never against these): `real-display` 93.4%
  (89.7% to 96.5% by paper), `real-inline` 99.0%. The survey fixes moved the
  survey by a point and this set by a quarter of one, which is what the
  survey rate overstating unseen papers looks like.
- **Fourth look**, for the confidence model (below), frozen before it:
  display 93.4% exact, of which 69.7% were trusted at 97.2% exact, and the
  30.3% sent for review held 70% of the wrong drafts; inline 99.0% exact,
  99.5% trusted. Aggregates only, as for the others.

Rules of use, stricter than the held-out set's:

- **Gates only, and count the looks.** Four so far, all recorded above.
- **Aggregates only.** No dump, no failures, no breakdown by construct, which
  would say where to look. `scripts/dev/latex-score.ts` gives counts for it
  and refuses anything else.
- **Intervals are by paper.** A paper's equations share its notation and fail
  together, so the report resamples whole papers. On 30 papers the interval
  for `real-display` is about seven points wide; treating its 716 equations
  as independent would claim under four.
- When it is spent, harvest another: `node scripts/gen-real-paper-tier.mjs
  harvest sealed` with a new window in the script, after moving this set's
  papers into the main store.

## Survey set

`corpus-survey/` holds 6,635 display and 8,954 inline equations from 300 more
openly licensed arXiv papers (June 2024), none of them in another set and no
equation shared (`corpus.test.ts` checks both). It is not a measurement. It is
the set that is read: thirty papers show what thirty authors write, and a rule
made for one author seldom helps the next thirty, so this is large enough to
rank what goes wrong by **how many papers it goes wrong in**.

```bash
npm run survey:latex                        # writes SURVEY.md
ITO_CLASS='row -> lines' npx vite-node scripts/dev/latex-survey.ts   # failures of a class, one paper each first
ITO_GREP='underbrace' npx vite-node scripts/dev/latex-survey.ts      # failures whose source matches
```

A failure's class is mechanical: where its tree first departs from the
truth's, as `truth -> draft`. Nobody chooses the classes. `SURVEY.md` lists
them by papers. Since the survey is developed against, its rate overstates
what unseen papers get; the sealed set says that. The harvest also records
each paper's document class and packages (`real-papers-survey.json`), which
shows what papers set their mathematics in: of the 300, 47 load or select a
Times package and 13 load `lmodern`, so the font tiers above are not a corner.

## Confidence

A draft that is right 93% of the time is useful only if the person using it
can tell which 7%. `src/pdf/equationConfidence.ts` gives each draft a
probability of being exactly right and, when it is low, reasons a person can
check ("A script sits almost between a superscript and the main line", "The
box cuts through some of the symbols").

It reads the evidence the extractor already has (`equationEvidence.ts`),
without touching how the draft is made: the draft is byte for byte what it was
(`texExtraction.corpus.test.ts` checks it through the recognizer). Four kinds
of evidence:

- **Stability.** The glyphs are moved by 1% to 6% of their size and the layout
  is run again, six times at each size. A draft that holds is resting on
  decisions made well away from every threshold. This reaches decisions no one
  put a probe on, and is the strongest single signal.
- **Closest calls.** The layout records how near to its threshold it was when
  it decided a script's level, a line break or a word space.
- **Identification.** Whether every symbol came from a font table or some had
  to be guessed from a character.
- **The draft itself.** Size, matrices, rows, stacked symbols, a script with
  nothing to attach to.

A logistic model weighs them (`equationConfidenceModel.json`), fitted on the
survey papers only. The trust line was chosen on predictions made for each
paper by a model that had not seen it, so that trusted drafts are at least
98% exact in display and in inline. Then, frozen, it was scored:

| Set (display) | Exact | Trusted | Exact among trusted | Of the wrong drafts, held for review |
|---|---|---|---|---|
| Survey, out of fold | 94.6% | 68% | 98.1% | 76% |
| Development | 98.0% | 74% | 99.3% | 75% |
| Held-out | 98.0% | 76% | 99.3% | 75% |
| Sealed (one look) | 93.4% | 70% | 97.2% | 70% |

Inline formulas are 99% exact to begin with and 99.5% of them are trusted:
the model has little to add there. The honest summary for display is that
confidence moves 93% to 97% for the 70% that can be trusted and sends the
other 30% for review, which holds 70% of what is wrong. It does not find the
rest: a draft that is stably, systematically wrong (a notation the extractor
does not know) looks like a good one.

What the calibration cannot see: the benchmark draws every box tightly round
its equation, so a box that cuts glyphs or sits against one has no data. Those
raise a doubt of their own and cap the confidence below the trust line; the
cap is a judgement, not a measurement. `docs/spikes/real-pages.md` measures
looser boxes.

Refit with `scripts/dev/latex-evidence.ts` (writes rows; refuses the sealed
set) and `scripts/dev/latex-confidence.ts fit`. `ITO_CURVE=1` prints what each
trust line buys. The model was fitted before one survey equation turned out to
be a duplicate under the corrected metric and was dropped; refitting changes
the weights in the third decimal.

**Metric change, flagged.** After a sizing command (`\left`, `\right`, `\middle`, `\big…`) a bare `<` or `>` now counts as `\langle` / `\rangle`: TeX gives them the same delimiter code and the page cannot tell them apart. This moved 23 equations in 9 papers from wrong to right or merged duplicates (the survey lost one). The sealed report was not regenerated, so its figures are on the old metric; the next sealed look will use the new one.

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
| `real-display-times` | The same display equations with Times text and Computer Modern math (`times`) |
| `real-display-ptm` | ... in Times with `mathptmx` |
| `real-display-tx` | ... in Times with `txfonts` |
| `real-display-newtx` | ... in Times with `newtxtext`, `newtxmath` |
| `real-display-pazo` | ... in Palatino with `mathpazo` |
| `real-display-newpx` | ... in Palatino with `newpxtext`, `newpxmath` |
| `real-display-stix` | ... in STIX Two (`stix2`) |

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

### Tiers in other fonts

Seven tiers set the development papers' display equations in the fonts
papers use besides Computer Modern. The extractor reads them from slot tables
generated the same way as Computer Modern's (`scripts/gen-tex-font-slots.mjs`
asks TeX under each font package), so a font tier should score what
`real-display` scores, less what that font does not show:

- `mathptmx` has one glyph for `\epsilon` and `\varepsilon`, and no bold
  math: `\boldsymbol` prints the symbol three times a hair apart, which is
  read back as bold.
- A font package may lack a glyph an equation asks for (`newpx` has no sans
  Greek capitals); TeX then prints nothing, and the draft cannot have it.

They exist in the development corpus only. The tables come from TeX, not
from reading failures, so a held-out copy would have nothing to catch.
Fonts with no table (Word's Cambria Math, MathTime, Fourier, Libertinus
and others) fall back to the character heuristics and are not measured.

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
also need `dvips`, `gs` (`ghostscript`), `lmodern`, and for the font tiers
`texlive-fonts-extra`, `texlive-latex-extra` and `texlive-plain-generic`. Output is deterministic:
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
