# Box-selection LaTeX extraction: plan to professional grade

Status: Phases 1 and 2 and the real-paper tiers are built. A check on the
papers' own PDFs (`docs/spikes/real-pages.md`) put four things ahead of Phase
3, all now done: the sentence's punctuation and the equation number are
dropped from a selection, Latin Modern is read with the Computer Modern
tables, and each of these, and dvips-produced PDFs, has a gated tier.
Phase 3 is in progress. Phases 4 to 6 are proposals.

## Target

**99.9% exact match on PDFs produced by pdfLaTeX with Computer Modern and AMS
fonts**, measured by the benchmark in `src/science/research/latex/` (see its
`README.md` and the generated `BENCHMARK.md`).

The scope is deliberate. Other font families (Times, Palatino, STIX), other
engines (XeLaTeX and LuaLaTeX with OpenType math) and old bitmap-font PDFs are
different problems; each gets its own tier and its own target once its baseline
is understood. The Times tier already exists and has no target yet.

Measured, pooled over 6,825 selections on the three target tiers:

| | Display | Inline | ToUnicode | Pooled |
|---|---|---|---|---|
| Before Phase 2 | 19.19% | 18.96% | 21.97% | 19.41% |
| After Phase 2 | 69.16% | 83.45% | 73.16% | 75.06% |

Outside the target: Times 41.58% (was 22.76%), scanned pages 0%.

What the target means in practice:

- It is a claim about at most 1 failure in 1,000 selections. The display tier
  holds 3,460 selections so that such a claim is testable at all: with zero
  failures, the 95% upper bound on the failure rate is about 3 divided by the
  number of selections.
- "Exact" is structural, not textual (`normalize.ts`). It requires recovering
  fonts, variant letters, accents and the word spaces inside text, none of
  which the current extractor attempts. It does not require delimiter height
  (`\left(` equals `(`) or spacing commands.
- The corpus is 160 real formulas plus a seeded grammar. Reaching the target on
  it is necessary, not sufficient, for real papers; that needs the real-paper
  tier below.
- A rule-based extractor tuned against a fixed corpus will fit it. A held-out
  set, drawn from the same grammar with another seed and reported only in
  aggregate, is measured at each phase gate to catch that
  (`BENCHMARK-HELDOUT.md`).
- At this failure rate the benchmark's own defects matter. Every residual
  failure near the target has to be triaged as an extractor error or a
  benchmark error.

## Where we are

Dragging the Area tool over an equation drafts LaTeX from the PDF text inside
the box (`src/pdf/mathLayout.ts`, wired through `extractLatexFromRegion` in
`src/pdf/scienceOcr.ts`). It rebuilds scripts, fractions, radicals, limits and
line breaks from glyph positions, and reads fraction bars from the crop's
pixels.

It is validated on one synthetic fixture (`src/test/fixtures/sample-math.pdf`,
Times and Symbol fonts drawn with pdf-lib). It has never been run on a
TeX-produced PDF. Known gaps:

| Gap | Cause |
|---|---|
| Matrices, cases, aligned equations, accents, nth roots, pre-scripts | Not modelled |
| `cost` read as `\cos t`; words versus variables guessed | No font identity |
| Display `∑`, big delimiters placed by character class | Operator fonts report odd baselines |
| Fraction bars depend on a stored crop and zoom | Read from pixels, not the PDF |
| Scanned pages, fonts with broken Unicode maps | No text to read |
| Unknown LaTeX commands render silently as identifiers | Hand-written MathML compiler |
| Rotated text skipped | Not handled |

## Principles

1. Measure before tuning. No heuristic changes without a benchmark delta.
2. Prefer exact data from the PDF over inference from pixels or the DOM.
3. The extractor drafts; the user confirms. Nothing is stored unsaved.
4. The default build makes no network call (existing rule in
   `src/science/recognition/types.ts`).

## Order and dependencies

```
Phase 1 (benchmark) ──> Phase 2 (PDF geometry, font slots) ──> Phase 3 (parser) ──> the tail
Phases 4 (image model), 5 (verification) and 6 (foundations) do not serve the
TeX target and are deferred. Phase 5a (renderer swap) is independent.
```

The baseline settles the order. Splitting the display tier's 3,460 equations by
what each one needs (a rough classification by construct tag; tall delimiters
and accents really need both):

| Equation needs | Equations | Exact today |
|---|---|---|
| Neither of the below | 863 | 585 |
| Font decoding only (big operators, integrals, bold, blackboard, calligraphic, upright) | 871 | 11 |
| Structure the extractor does not model (matrix, cases, binomial, accent, root index, tall delimiter, stacked symbol, aligned lines) | 910 | 68 |
| Both | 816 | 0 |

If Phase 2 fixed every equation in the first two rows, the display tier would
reach 52% and the inline tier 65%. That is a ceiling, not a forecast. Phase 3
is therefore required for the target, not conditional on a re-measure.

---

## Phase 1: benchmark

Goal: a number that says how good the extractor is, gated in CI.

### Tasks

1. **Corpus builder** (`scripts/gen-math-corpus.mjs`, new). For each entry it
   records the PDF, page, box in PDF points, and ground-truth LaTeX in
   `src/science/research/latex/corpus/manifest.json`.
   - *TeX tier:* compile a set of standalone equations with a TeX engine and
     record each equation's box. Ground truth is the source. Needs a TeX
     install in the generation environment only; the PDFs are committed.
   - *Real-paper tier:* 10 to 20 open-licence arXiv PDFs with hand-drawn boxes
     and ground truth taken from the paper source. Licence must be checked per
     paper before committing.
   - *Other producers:* Word and LibreOffice exports of the same equations.
   - *Scanned tier:* the TeX tier rasterised into image-only PDFs.
2. **Structural normaliser** (`src/science/research/latex/normalize.ts`, new).
   Parses LaTeX to a tree and canonicalises it: brace-insensitive, script
   order fixed, spacing commands dropped, synonym commands folded (`\le` and
   `\leq`). Unit-tested on equivalent pairs.
3. **Scorer** (`src/science/research/latex/score.ts`, new). Exact tree match
   and normalised tree edit distance per equation.
4. **Runner.** A Playwright spec (`e2e/latex-benchmark.spec.ts`, new) that
   opens each PDF in the real reader and calls the extractor over each box
   through a new `window.__ito.extractLatexAt(sourceId, pageIndex, rect)` test
   hook in `src/app/testApi.ts`. It must run in a browser because extraction
   depends on the rendered text layer.
5. **Report** (`src/science/research/latex/BENCHMARK.md`, generated). Accuracy
   by tier and by construct (scripts, fractions, radicals, limits, matrices,
   multi-line, prose mix), with the failing cases listed. Same shape as
   `src/science/research/skeleton/BENCHMARK.md`.
6. **CI gate.** Add a job to `.github/workflows/` that runs the benchmark and
   fails below a per-tier floor stored in the manifest. Floors start at the
   measured baseline and only move up.

### Acceptance

- At least 300 equations across the four tiers, every construct represented
  at least 15 times.
- The report is reproducible: two runs give identical numbers.
- A baseline number exists for the current extractor.

### Status: built, with two tiers outstanding

| Task | State |
|---|---|
| 1. Corpus builder | Done for TeX (four tiers) and scanned. `scripts/gen-math-corpus.mjs`. |
| 1. Held-out set | Done. `corpus-heldout/`: 3,259 unseen grammar equations in three tiers, one of them 12pt. |
| 1. Real-paper tier | Done, with limits: see below. `real-display` and `real-inline`, 60 papers split between the two sets. |
| 1. Other-producer tier | **Not built.** Word and LibreOffice exports. |
| 2. Structural normaliser | Done. `normalize.ts`, with its own parser. |
| 3. Scorer | Done. `score.ts`: exact match, tree edit distance, confidence bound. |
| 4. Runner | Done. `e2e/latex-benchmark.bench.ts` and `window.__ito.extractLatexAt`. |
| 5. Report | Done. `BENCHMARK.md`, generated. |
| 6. CI gate | Done. `.github/workflows/latex-benchmark.yml`, floors in `thresholds.json`. |

Differences from the tasks as first written:

- The corpus is far larger than 300 equations (3,460), because the 99.9%
  target is not testable on fewer than about 3,000.
- The runner renders each page itself through the reader's `renderPage` and
  extraction functions instead of scrolling the reader UI, and lives in its own
  Playwright config so `npm run test:e2e` stays a behaviour suite.
- Floors sit one point under the baseline, not at it: glyph positions are
  measured against the browser's fallback fonts, which differ between machines.
- Manual tiers go in `corpus/manual-tiers.json`, which the generator merges.
- The metric counts word spaces inside text (`\text{is even}` is not
  `\text{iseven}`); a space at either end of a text run is still ignored. This
  changed no result for the current extractor.

The held-out set. A second corpus drawn from the same grammar by the same rule
with another seed (`node scripts/gen-math-corpus.mjs heldout`), measured with
`npm run benchmark:latex:heldout` at phase gates only. Its report lists no
individual failures and the runner refuses to dump them. What it reports is the
gap to the development corpus, with a 95% interval:

- Same typesetting, unseen equations: has the extractor been fitted to the
  corpus? Baseline: +1.50 points on display (interval -0.30 to +3.31) and +1.20
  on inline (-0.89 to +3.30). No detectable gap, as expected of an extractor
  that was written before the corpus existed.
- The same 760 equations at 12pt, which uses font design sizes the development
  corpus never shows: does the extractor depend on the fonts it was developed
  on? Baseline: 0.00 points (-0.36 to +0.36).

Equations that both draws produce are removed from both sides of the
comparison. Removing them from the held-out side only made that set harder
(the twins are short and easy) and showed a spurious 2.5-point gap in the first
build.

The real-paper tiers (`scripts/gen-real-paper-tier.mjs`, sources credited in
`src/science/research/latex/SOURCES.md`) hold equations from the LaTeX source of
60 arXiv papers under CC BY 4.0 or CC0, with the authors' simple macros
expanded: 611 display and 889 inline formulas from 30 papers in the development
corpus, 595 and 862 from 30 other papers in the held-out set. Each equation is
typeset alone by the benchmark's harness, so the tiers measure real
mathematics on our pages, not the papers' own pages; and equations that rest on
macros or packages outside the benchmark's vocabulary are left out. Boxes on
the papers' own PDFs remain unbuilt.

Measured after Phase 2:

| | Development | Held-out |
|---|---|---|
| `real-display` | 91.33% of 611 | 88.24% of 595 |
| `real-inline` | 99.33% of 889 | 98.61% of 862 |

The held-out papers score lower by 3.1 points on display (95% interval -0.3 to
+6.6) and 0.7 on inline (-0.3 to +1.8). Neither interval excludes zero, but
both lean the same way, the intervals are too narrow because a paper's
equations fail together, and six small fixes were made after looking at the
development tier's failures. Treat the held-out figures as the honest ones.

What real papers say about the generated tiers: the grammar over-weights the
hard constructs. A matrix, cases, binomial or stacked symbol is in 26.2% of the
generated display tier and 3.1% of the real one; a root index in 2.1% and in
none. That is why real display equations score 91% where generated ones score
69%. The generated tiers remain the right place to test coverage of each
construct; the real tiers say how much each one matters.

What the baseline says about priorities (display tier, exact match by
construct): big operators, integrals, accents, binomials, matrices, cases and
every font change score 0%; tall delimiters 2%; radicals 4%. Display `\sum`
and `\int` arrive from the text layer as `X` and `Z`, big delimiters arrive as
nothing, and `\neq` arrives as `=`. These are font-encoding problems, which is
what Phase 2 addresses, so the order of the plan stands.

### Risks

- TeX is not installed in this environment (unchecked). If unavailable, the
  TeX tier is generated elsewhere and committed.
- Tree comparison needs a LaTeX parser. Options: extend the tokenizer already
  in `scienceOcr.ts`, or use the parser from the renderer chosen in Phase 5a.
  Prefer the latter to avoid two parsers.

---

## Phase 2: geometry from the PDF

**Status: built.** What was done, and where it differs from the tasks below:

- `src/pdf/pageMathModel.ts` walks the operator list; `src/pdf/texGlyphs.ts`
  identifies glyphs; `mathLayout.ts` uses identity where it has it. The reader
  and the benchmark both go through `draftLatexFromStage`, which uses the
  model whenever it has glyphs in the box.
- The slot table (`src/pdf/texFontSlots.ts`, 1,188 slots in 14 families) is
  generated by asking TeX, not from glyph names: `scripts/gen-tex-font-slots.mjs`
  typesets each command on its own page and records which slots appear. That
  needs no hand-written name map, and it also yields the composites (26,
  `\notin`, `\neq`, `\cong`, `\ldots`...) with their exact offsets and the
  built-up delimiters (19). Only ink heights come from the AFM files.
- Accents are attached here, not in Phase 3: with the accent's slot known it
  is a lookup of what lies under it.
- Results, development corpus: display 69.16%, inline 83.45%, ToUnicode
  73.16%, Times 41.58%. On the display tier 3 failures remain outside the
  constructs listed for Phase 3; the other 1,064 involve a binomial, a root
  index, a matrix, cases, a stacked symbol or several lines.
- Held-out set at this gate: display 69.01%, inline 83.29%, 12pt 67.76%. No
  gap whose interval excludes zero (`BENCHMARK-HELDOUT.md`).
- The browser benchmark, a Node run of the same pure code
  (`src/pdf/texExtraction.corpus.test.ts`) and CI give the same counts.
  Extraction is identical at 50%, 100% and 200% zoom
  (`e2e/latex-extract.spec.ts`) and needs no stored crop.
- Not done: rotation (task 7; rotated glyphs are still skipped), and Latin
  Modern and other families (no table, so they fall back to the character
  pdf.js reports, with exact geometry).
- The metric gained one equivalence: neighbouring groups in one font are one
  group, and a script after a font group sits on its last character
  (`\mathrm{Te}^b` equals `\mathrm{T}\mathrm{e}^b`). They print identically.

### Tasks

1. **Spike. Done: go.** `docs/spikes/pdf-glyph-geometry.md`, reproducible with
   the two scripts in `scripts/spikes/`. What it established, on the
   development corpus:
   - The operator list gives every glyph's font name, font slot and advance,
     and every rule, in Node and in the reader's own browser setup (identical
     glyph streams on 40 of 40 pages), for about 2ms a page.
   - On the three Computer Modern tiers, a TeX font slot identifies the symbol
     or style with no error: 11,373 agreements with the ground truth over 26
     checks, no false positive and no miss.
   - Unicode cannot: display `\sum` is reported as `X` and big delimiters as
     control characters or nothing, with or without ToUnicode maps.
   - Rule counts match fractions + radicals + over/underlines in all 7,585
     equations. pdfTeX strokes its rules (the plan had assumed filled
     rectangles), and pdf.js can split one path across two operations.
   - pdf.js's text layer, which today's extractor reads, misplaces every letter
     under `\vec` by half an em. The operator list does not.
2. **Slot table** (`src/pdf/texFontSlots.ts`, new, generated). For the Computer
   Modern and AMS families, (font family, slot) to LaTeX command and class:
   letter, digit, operator, relation, delimiter or delimiter piece, radical
   piece, accent, big operator. Generated by a script from TeX's own font
   metric files (which name every slot) plus one hand-written map from glyph
   name to command, and committed. A font family with no table falls back to
   the Unicode pdf.js reports.
3. **Page math model** (`src/pdf/pageMathModel.ts`, new). One pass over the
   operator list producing, in viewport coordinates:
   - `glyphs`: font family, slot, origin, advance, font size;
   - `rules`: thin axis-aligned strokes and thin filled rectangles, accumulated
     across consecutive `constructPath` operations until painted;
   - `fonts`: per font id, family, design size and style (math italic, upright,
     symbol, extension, bold, blackboard, calligraphic).
4. **Wire it in.** `RenderedPage` gains `mathModel()`, computed lazily and
   cached per page. `extractLatexFromRegion` takes the model when present and
   falls back to today's DOM path when not.
5. **Use slot and font identity in `mathLayout.ts`.**
   - Symbols come from the slot table, not from the character.
   - Upright multi-letter runs become `\mathrm{}` or a function name; italic
     letters stay variables. Removes the word-length heuristic.
   - Extension-font glyphs (big operators, delimiter and radical pieces) are
     placed by class, not by the hard-coded character list.
   - Blackboard, calligraphic and bold map to `\mathbb`, `\mathcal`,
     `\mathbf`.
   - Script level comes from the rendered size (a 10pt document has exactly
     three per family), not from a baseline threshold alone.
   - Composite symbols are recognised by overlap, one rule each (`\notin` is
     `\in` with a slash drawn over it).
6. **Remove the pixel path for born-digital pages.** Keep
   `detectHorizontalRules` only as the fallback for pages with no operator
   rules (scanned pages overlaid with OCR text).
7. **Rotation.** The model is in viewport coordinates, so runs at 90, 180 and
   270 degrees can be rotated into a horizontal frame before layout rather
   than skipped.

### Acceptance

- Target tiers rise against the Phase 1 baseline, and their floors in
  `thresholds.json` are raised to the new numbers. The ceiling for this phase
  alone is about 52% on display and 65% on inline (see "Order and
  dependencies").
- The held-out report shows no gap whose interval excludes zero, on the 10pt
  tiers or the 12pt tier.
- The benchmark gives identical per-selection results locally and in CI. Today
  they differ by two selections on each of the display and inline tiers,
  because glyph extents are measured against the browser's fallback fonts.
- Extraction result is identical at 50%, 100% and 200% zoom.
- Extraction no longer depends on `AreaAnchor.imageDataUrl`.
- Existing unit tests and `e2e/latex-extract.spec.ts` pass unchanged.

### Risks

- The operator list is a less stable pdf.js surface than `getTextContent`, and
  the spike confirms it for 4.10.38 only. Isolate it behind `pageMathModel.ts`,
  pin the version, and re-run both spike scripts on any upgrade.
- Type 3 fonts and fonts without usable names give no classification; fall
  back to today's heuristics per glyph.
- Other TeX engines (XeLaTeX, LuaLaTeX, dvipdfmx) may report a glyph id where
  pdfLaTeX reports a TeX slot. Untested, and outside the claimed scope.
- Cost: one extra pass per page. Compute on first extraction, not on render.

---

## Phase 3: structural parser

Goal: replace the fixed-threshold cascade with a scored search, and cover the
constructs it cannot express. Required for the target: half of the display
tier's equations need a construct the extractor does not model (see "Order and
dependencies"). Order the tasks by what fails on real papers. Of the 53
failures in the development `real-display` tier after Phase 2:

| Failure involves | Failures | Share of real display equations with it |
|---|---|---|
| A grid: matrix, array, cases, binomial, stacked symbol | 19 | 3.1% (all of them fail) |
| Limits under an operator or a function name | 14 | 24.7% |
| Several lines (`aligned`), usually a fraction joining two rows | 12 | 6.4% |
| An accent (over several glyphs, or doubled) | 4 | 13.6% |
| None of these | 4 | 52.2% |

So: the tree (task 1), then rows and grids (5), which also stops fractions
reaching across lines, then limits under function names and neighbouring
operators, then the accent cases. Root indices and pre-scripts come last: they
are in the generated tiers and absent from the real one. The scored search
(2 and 3) only if what remains needs it.

### Tasks

1. **Intermediate tree** (`src/pdf/mathTree.ts`, new). Typed nodes: row,
   fraction, radical with optional index, scripts with pre-scripts, operator
   with limits, accent, delimited group, matrix, cases, aligned lines, text.
   `mathLayout.ts` produces the tree; a separate printer emits LaTeX. This
   split is useful even without the rest of the phase and can land first.
2. **Relation scoring.** Replace each hard cut-off with a score for the
   relation between two boxes (on-line, superscript, subscript, above, below,
   inside), using baseline offset, size ratio and font class. Thresholds
   become parameters fitted on a training split of the corpus.
3. **Search.** Keep the top few hypotheses per sub-expression instead of
   committing to the first; pick the best-scoring full parse.
4. **Delimiter matching.** Pair brackets by nesting and height; emit
   `\left` and `\right` when the delimiter is taller than its content.
5. **Grids.** Detect aligned rows and columns for matrices, `cases` (one tall
   left brace) and aligned equations (a shared relation column).
6. **Accents and indices.** Hats, bars, tildes, dots and vectors from small
   glyphs centred above a base; nth-root index from a small glyph at the
   radical's upper left.
7. **Equation numbers.** Detect a right-flushed `(n)` and emit it as `\tag`
   or drop it, by option.

### Acceptance

- Each new construct has at least 15 corpus cases and passes a stated
  per-construct floor.
- No tier regresses against the post-Phase-2 numbers.
- Parameters are fitted on a training split and reported on a held-out split.

### Risks

- Largest item in the plan. Task 1 is the safe first slice; tasks 5 and 6
  deliver the most visible gains and can ship without tasks 2 and 3.
- Fitting on a small corpus overfits. Hence the held-out split.

---

## Phase 4: image-to-LaTeX fallback

Goal: cover pages geometry cannot read, and get an independent second opinion
for confidence. Start only if the post-Phase-2 benchmark shows text-quality
failures dominate, or scanned support is required.

### Decision needed first

Local model or remote service. A local model keeps the no-network default but
adds a download and slower inference. A remote service is likely more accurate
but sends document crops off the machine. Recommendation: local by default,
remote as an explicit opt-in per library. This is the owner's call.

### Tasks

1. **Spike** (`docs/spikes/math-ocr.md`). Run two or three candidate local
   models and one remote service over the Phase 1 corpus. Record accuracy,
   model size, cold and warm latency in the browser, and licence. The existing
   notes name pix2text-mfr as a candidate; no candidate has been evaluated.
2. **Backend.** Implement `ImageModelBackend`
   (`src/science/recognition/types.ts`) for the chosen model. For a local
   model: run in a Web Worker, download on first use with progress, cache in
   IndexedDB, never bundle in the main chunk.
3. **Text-layer trust score** (`src/pdf/textTrust.ts`, new). Flags a region
   as untrustworthy when it has no glyphs, private-use or replacement
   characters, or glyph coverage far below the ink in the crop.
4. **Router** in `recognitionService.ts`. Trusted text: geometry first.
   Untrusted or empty: model. When both are available, run both.
5. **Agreement.** Compare the two results with the Phase 1 normaliser. Equal
   trees give high confidence; otherwise both are kept for the UI in Phase 5.
6. **Settings.** A per-library toggle for the model, off until the user
   enables it, with the download size or the remote destination stated.

### Acceptance

- Scanned tier reaches a stated floor (set after the spike).
- With the model disabled, the build makes no network request (asserted in an
  e2e test).
- First-use download and inference never block the reader's main thread.

### Risks

- Local models for this task are large and their browser performance is
  unknown until the spike.
- A remote backend changes the app's privacy posture and needs explicit
  consent UI.

---

## Phase 5: verification

Goal: make a wrong draft fast to spot and fix.

### 5a. Renderer swap (independent, can start now)

1. Replace the hand-written compiler in `convertLatexToMathML` with a
   maintained LaTeX renderer that outputs MathML. Candidates: KaTeX (MathML
   output mode) and Temml. Choose on bundle size and on how Word accepts the
   pasted MathML; that paste path must be re-tested by hand in Word, since no
   automated test covers it.
2. Keep the function signature. Existing tests in
   `src/science/recognition/*.test.ts` and `src/app/m17ScientificReflow.test.ts`
   pin specific elements (for example `<msubsup>` for sums); update them
   deliberately, in one commit, with the reason recorded.
3. Surface parse errors. `mathRecognizer.ts` currently treats "compiles to
   non-empty MathML" as valid; switch it to the renderer's real error.

Acceptance: every corpus ground-truth equation renders without error; invalid
LaTeX shows a message in the editor instead of a silent approximation.

### 5b. Side-by-side check

1. Show the crop and the rendered draft at matched scale in the science
   panel (`SciencePanel` in `src/app/reader/AnnotationOverlays.tsx`).
2. Highlight low-confidence sub-expressions: where the geometry and model
   results differ (Phase 4), or where the parser's best and second-best
   scores are close (Phase 3). Requires the tree from Phase 3 task 1 to carry
   source positions.
3. When two candidates exist, let the user switch between them.

### 5c. Editing

1. Spike a structured math field (MathLive is the candidate) against the
   current textarea: bundle size, keyboard behaviour, accessibility.
2. If adopted, keep the raw LaTeX textarea as a toggle.
3. Record corrections locally (draft and saved result) as an opt-in export,
   to grow the corpus from real failures.

Acceptance: a timed task on 20 wrong drafts is faster with the new UI than
with the textarea; measured on at least three people.

---

## Phase 6: foundations

Small, independent fixes. Do alongside Phase 2.

1. **Cached page geometry.** `extractLayout` in `src/pdf/render.ts` passes a
   scaled viewport to `extractPreParsedPageLayout`, which divides unscaled
   text coordinates by it. By reading the code, cached spans are misplaced at
   any render scale other than 1. Not yet confirmed at runtime.
   - Add a failing test first: extract at scale 2, hydrate, compare span
     rects with the live layer.
   - Fix by projecting through `viewport.transform`, as
     `stampBaselineGeometry` already does.
   - Bump the cache version so stale layouts are discarded.
   - Re-check `figureCharsFromSpans` ("Read mechanism from figure"), which
     consumes this cache.
2. **Popover overflow.** The annotation popover can extend past the bottom of
   the window. Clamp it to the viewport and flip above the anchor when there
   is no room, in `src/app/reader/overlayShared.ts`. Add an e2e case with the
   box low on screen.
3. **Rotated text.** Covered by Phase 2 task 6; until then, show "rotated
   text is not supported" instead of an empty draft.
4. **Test tooling.** The repo pins a Playwright version without a matching
   browser in the cloud environment, so e2e runs need a local override. Add
   an environment variable for the browser path to `playwright.config.ts`.
5. **CI.** `.github/workflows/m17-playtest.yml` runs one unit test file. Run
   the full unit suite and the e2e suite on pull requests.

Acceptance: each item has a test that fails before the fix and passes after.

---

## Open decisions

| Decision | Needed by | Recommendation |
|---|---|---|
| Local model, remote service, or neither | Phase 4 | Local default, remote opt-in |
| Real-paper tier: which papers | Before the target is claimed | Done: 60 CC BY 4.0 and CC0 arXiv papers, ground truth harvested from source |
| Renderer: KaTeX or Temml | Phase 5a | Decide on the Word paste test |
| Structured math editor dependency | Phase 5c | Spike before committing |
| Accuracy target on TeX PDFs | Decided | 99.9% exact match |
| What counts as a TeX PDF for that target | Decided | pdfLaTeX with Computer Modern and AMS fonts |
| Metric strictness | Decided | Word spaces inside text count; delimiter height does not |
| Accuracy targets for other tiers | After their baselines | Set from measured numbers |

## Not in scope

- Handwritten math.
- Chemistry extraction (separate pipeline in `src/science/recognition`).
- Training a model.
