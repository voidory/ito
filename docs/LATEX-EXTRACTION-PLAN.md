# Box-selection LaTeX extraction: plan to professional grade

Status: Phase 1 is built. Phases 2 to 6 are proposals.

## Target

**99.9% exact match on TeX-produced PDFs**, measured by the benchmark in
`src/science/research/latex/` (see its `README.md` and the generated
`BENCHMARK.md`).

Measured baseline, before any Phase 2 work: **19.75%** exact match pooled over
7,585 selections on four TeX tiers (display 19.19%, inline 18.96%, Times
22.76%, ToUnicode 21.97%), and 0% on scanned pages.

What the target means in practice:

- It is a claim about at most 1 failure in 1,000 selections. The display tier
  holds 3,460 selections so that such a claim is testable at all: with zero
  failures, the 95% upper bound on the failure rate is about 3 divided by the
  number of selections.
- "Exact" is structural, not textual (`normalize.ts`). It still requires
  recovering fonts, variant letters and accents, none of which the current
  extractor attempts.
- The corpus is 160 real formulas plus a seeded grammar. Reaching the target on
  it is necessary, not sufficient, for real papers; that needs the real-paper
  tier below.

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
Phase 1 (benchmark) ──┬─> Phase 2 (PDF geometry) ──┐
                      └─> Phase 6 (foundations) ───┴─> re-measure ─┬─> Phase 3 (parser)
                                                                   └─> Phase 4 (image model)
Phase 5a (renderer swap) is independent and can start any time.
Phase 5b/5c (verification UI) follow Phase 4's confidence signal.
```

The re-measure after Phases 2 and 6 decides whether Phase 3 or Phase 4 comes
next: mostly structural failures point to 3, mostly bad or absent text to 4.

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
| 1. Real-paper tier | **Not built.** Needs a licence check per paper and hand labelling. |
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

Goal: replace the three lossy inputs (pixel rules, DOM-measured glyph extents,
no font identity) with exact data from pdf.js. Installed version: 4.10.38.

### Tasks

1. **Spike** (two days, `docs/spikes/pdf-glyph-geometry.md`). Confirm what
   `page.getOperatorList()` and `page.commonObjs` expose in 4.10.38: per-glyph
   advances, font names and flags, and path operators with the current
   transform. Everything below depends on this; none of it has been verified.
2. **Page math model** (`src/pdf/pageMathModel.ts`, new). One pass over the
   operator list producing, in viewport coordinates:
   - `glyphs`: character, origin, advance, font size, font id;
   - `rules`: thin axis-aligned strokes and thin filled rectangles (TeX draws
     fraction bars as filled rectangles);
   - `fonts`: per font id, name and classification (math italic, upright,
     symbol, extension, bold, blackboard, calligraphic).
3. **Wire it in.** `RenderedPage` gains `mathModel()`, computed lazily and
   cached per page. `extractLatexFromRegion` takes the model when present and
   falls back to today's DOM path when not.
4. **Use font identity in `mathLayout.ts`.**
   - Upright multi-letter runs become `\mathrm{}` or a function name; italic
     letters stay variables. Removes the word-length heuristic.
   - Extension-font glyphs get baseline-independent placement by font, not by
     the hard-coded character list.
   - Blackboard, calligraphic and bold map to `\mathbb`, `\mathcal`,
     `\mathbf`.
5. **Remove the pixel path for born-digital pages.** Keep
   `detectHorizontalRules` only as the fallback for pages with no operator
   rules (scanned pages overlaid with OCR text).
6. **Rotation.** The model is in viewport coordinates, so runs at 90, 180 and
   270 degrees can be rotated into a horizontal frame before layout rather
   than skipped.

### Acceptance

- TeX tier exact-match rises against the Phase 1 baseline; the target is set
  once the baseline is known.
- Extraction result is identical at 50%, 100% and 200% zoom.
- Extraction no longer depends on `AreaAnchor.imageDataUrl`.
- Existing unit tests and `e2e/latex-extract.spec.ts` pass unchanged.

### Risks

- The operator list is a less stable pdf.js surface than `getTextContent`.
  Isolate it behind `pageMathModel.ts` and pin the version.
- Type 3 fonts and fonts without usable names give no classification; fall
  back to today's heuristics per glyph.
- Cost: one extra pass per page. Compute on first extraction, not on render.

---

## Phase 3: structural parser

Goal: replace the fixed-threshold cascade with a scored search, and cover the
constructs it cannot express. Start only if the post-Phase-2 benchmark shows
structural failures dominate.

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
| Real-paper tier: which papers, licence check | Phase 1 | Open-licence arXiv only |
| Renderer: KaTeX or Temml | Phase 5a | Decide on the Word paste test |
| Structured math editor dependency | Phase 5c | Spike before committing |
| Accuracy target on TeX PDFs | Decided | 99.9% exact match |
| Accuracy targets for other tiers | After their baselines | Set from measured numbers |

## Not in scope

- Handwritten math.
- Chemistry extraction (separate pipeline in `src/science/recognition`).
- Training a model.
