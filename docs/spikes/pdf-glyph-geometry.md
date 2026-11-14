# Spike: glyph identity and geometry from pdf.js

Phase 2 of `docs/LATEX-EXTRACTION-PLAN.md` rests on one unverified assumption:
that pdf.js can tell us, for every glyph on a page, which font slot it is and
where it sits, and for every rule, where it is drawn. This spike tested that
against the benchmark's development corpus.

**Result: go.** pdf.js 4.10.38 exposes all of it, in Node and in the reader's
own browser setup, and on TeX output it is enough to identify every symbol and
style checked here with no error.

Every number below comes from two scripts, which are kept so the result can be
re-run:

```bash
node scripts/spikes/pdf-glyph-geometry.mjs
```

```bash
node scripts/spikes/pdf-glyph-geometry.browser.mjs
```

Measured with pdfjs-dist 4.10.38 and Node 22.23 on the development corpus
(`src/science/research/latex/corpus/`). The held-out set was not opened.

## What pdf.js exposes

`page.getOperatorList()` returns the page's drawing operations. The ones that
matter:

| Operation | Carries |
|---|---|
| `setFont [id, size]` | Font id and size. `page.commonObjs.get(id)` gives the font: `name` (for example `HWMSQP+CMMI10`), `fontMatrix`, `ascent`, `descent`, `bbox`, `type`, `isType3Font`, `vertical`. |
| `showText [glyphs]` | Per glyph: `originalCharCode` (the font slot), `unicode`, `width` (advance, in thousandths of the font size), `isSpace`, `accent`. Numbers between glyphs are kerning adjustments. |
| `moveText`, `setTextMatrix`, `transform`, `save`, `restore` and the text-state operators | Everything needed to place each glyph in page coordinates. |
| `constructPath [ops, args]` then `stroke` or `fill` | Rules, with `setLineWidth` giving the thickness of a stroked one. |

The reader calls `pdfjs.getDocument({ data })` with default options
(`src/pdf/render.ts`), and that is sufficient: nothing here needs
`fontExtraProperties` or any other non-default setting.

## Findings

### 1. Positions computed from the operator list are right

A walk over the operator list that tracks the transform and text state
(`pageModel` in the spike script, about 150 lines) places each glyph. Checked
three ways on the display tier (3,460 equations, 198 pages, 73,793 glyphs):

| Check | Result |
|---|---|
| Every glyph falls inside exactly one equation's recorded box (the boxes come from TeX's own `\pdfsavepos`) | 73,793 of 73,793 |
| Boxes with no glyph | 0 of 3,460 |
| Leftmost glyph origin equals TeX's box edge to within 0.02pt | 3,280 of 3,460 |
| Text runs from `getTextContent()` that start at a computed glyph origin (every tenth page) | 5,298 of 5,302 |

The exceptions are understood, not noise:

- The 180 equations whose first glyph is not at the box edge start with a
  centred or shifted element: `\frac` (148), `\begin` (14), `\psi` (8),
  `\left` (6), `\vec` (2), `\sqrt` (2).
- The 4 text runs that disagree are all a letter under `\vec`. TeX sets the
  arrow, kerns back and sets the letter in one text operation. The operator
  list puts the letter where TeX's own spacing says it is. **pdf.js's text
  layer puts it 4.98pt to the left**, because it gives the combining arrow no
  width. So today's extractor, which reads the text layer, has every `\vec`
  letter misplaced by half an em.

The inline, ToUnicode and Times tiers behave the same (0 empty boxes; 2 of
4,383, 0 of 1,377 and 0 of 1,569 text runs disagree).

### 2. A TeX font slot identifies the symbol exactly

For 26 symbols and styles, the script asks of every equation: is the slot that
TeX uses for it on the page, and does the ground truth contain it? On the three
Computer Modern tiers the two always agree.

| Tier | Agreements | Slot present, not in truth | In truth, slot absent |
|---|---|---|---|
| `tex-display` | 5,828 | 0 | 0 |
| `tex-inline` | 4,408 | 0 | 0 |
| `tex-tounicode` | 1,137 | 0 | 0 |

The checks, with their display-tier counts:

| What | Slot | Equations |
|---|---|---|
| `\sum`, `\prod`, `\int`, `\oint`, `\bigcup`, `\bigcap` | CMEX, text and display sizes | 266, 58, 244, 52, 16, 17 |
| Radical sign, any size | CMSY 0x70, CMEX 0x70 to 0x76 | 703 |
| `\neq` | CMSY 0x36 (the negation slash) | 176 |
| `\setminus` | CMSY 0x6E | 13 |
| `\epsilon` / `\varepsilon` | CMMI 0x0F / 0x22 | 125 / 108 |
| `\theta` / `\vartheta` | CMMI 0x12 / 0x23 | 160 / 102 |
| `\phi` / `\varphi` | CMMI 0x1E / 0x27 | 215 / 117 |
| `\mathbb` letter | any letter in MSBM | 360 |
| `\mathbf` | any glyph in CMBX | 419 |
| `\mathcal` letter | CMSY 0x41 to 0x5A | 150 |
| Upright letters (`\mathrm`, `\text`, `\sin`) | any letter in CMR | 1,796 |
| `\hat`, `\tilde`, `\bar`, `\dot`, `\ddot`, `\vec` | CMR and CMMI accent slots, CMEX wide forms | 190, 84, 100, 106, 119, 109 |
| `\notin` | `\in` (CMSY 0x32) with a slash (CMMI 0x3D) drawn over it | 23 |

Three things follow.

- **Font style comes for free.** Bold, blackboard, calligraphic and upright
  are separate fonts, so the word-versus-variable guess in `mathLayout.ts`
  (the cause of `ab\cos` being read as text) is unnecessary on TeX output.
- **Script level is exact.** A 10pt document renders at exactly three sizes
  per family (9.96, 6.97 and 4.98pt), so script depth is a lookup, not a
  threshold.
- **Not every command is one slot.** `\notin` is two overlapping glyphs, and
  only geometry tells it from `\in /`. The first version of this check assumed
  it used the negation slash, and failed on all 23. Composite symbols need
  their own rule each.

The display tier uses 311 distinct (family, slot) pairs, and every one has a
name in TeX's own font metric files (`cmex10.afm`: `C 88 ; N summationdisplay`),
which are on any TeX installation. The lookup table can therefore be generated
from those files, not typed by hand.

### 3. Unicode cannot do this, with or without ToUnicode maps

What pdf.js reports as the character for some of the same slots:

| Slot | TeX's name | pdf.js `unicode` |
|---|---|---|
| CMEX 88 | `summationdisplay` | `X` |
| CMEX 90 | `integraldisplay` | `Z` |
| CMEX 18 | `parenleftbigg` | U+0012, a control character |
| CMEX 48 | `parenlefttp` | empty string |
| CMEX 112 | `radicalbig` | `p` |
| MSBM 82 | `R` (blackboard) | `R` |
| CMBX 120 | `x` (bold) | `x` |
| CMMI 15 / 34 | `epsilon1` / `epsilon` | `ϵ` / `ε` (correct) |

The ToUnicode tier (`\input{glyphtounicode}`) reports the same values for the
CMEX slots: that standard table has no entries for the extension font's glyph
names. Style is not in Unicode at all.

One row cuts the other way. pdf.js already distinguishes `ϵ` from `ε`, yet the
extractor returns `\epsilon` for both. That is a bug in today's symbol table,
not a limit of the text layer, and it can be fixed without Phase 2.

### 4. Rules are exact, with two surprises

Counting the thin horizontal rules inside each box and comparing with
fractions + radicals + over/underlines in the ground truth:

| Tier | Equations where the counts agree |
|---|---|
| `tex-display` | 3,460 of 3,460 |
| `tex-inline` | 2,605 of 2,605 |
| `tex-tounicode` | 760 of 760 |
| `tex-times` | 760 of 760 |

- **pdfTeX strokes them.** All 2,842 rules in the display tier are a
  `moveTo`/`lineTo` stroke of width 0.398pt. None is a filled rectangle, which
  is what the plan assumed. The model must accept both.
- **One path can arrive in pieces.** pdf.js splits a path across two
  `constructPath` operations where an operator-list chunk ends. A walker that
  starts a new path at each `constructPath` loses those rules: the first run
  found 3,456 of 3,460 for this reason. Accumulate until the path is painted.

### 5. It is the same in the reader, and cheap

The browser script loads a corpus PDF through `loadDocument` in
`src/pdf/render.ts`, in headless Chromium, with the real worker.

| Check | Result |
|---|---|
| Pages whose glyph stream (font name, slot, width) is identical to Node's | 40 of 40 (14,221 glyphs) |
| Fonts not yet resolved when `getOperatorList()` returns | 0 of 408 |
| `getOperatorList()`, first call per page | median 2.0ms, mean 3.9ms |
| `getOperatorList()`, repeat call | 0.0ms (cached) |
| `getTextContent()` per page, for comparison | median 3.7ms, mean 4.5ms |

So the model can be built on first extraction for less than the text layer
already costs.

### 6. Other font families need their own tables

The Times tier (`mathptmx`) mixes Nimbus Roman, Standard Symbols, `rsfs10` and
four Computer Modern fonts. Geometry and rules work unchanged. The Computer
Modern slot checks find what is still set in those fonts (`\int`, radicals,
`\neq`, `\mathbb`) and miss what is not: `\sum` (59 equations, from the Symbol
font), all Greek, bold, calligraphic, upright letters and most accents. This is
expected, and it is why the 99.9% target is claimed for Computer Modern and AMS
fonts only. Each further family is a table, not new code.

## What this changes in Phase 2

1. The centre of the phase is a **slot table**: (font family, slot) to LaTeX
   command and class (letter, operator, delimiter piece, accent, radical
   piece), generated from the AFM files for the Computer Modern and AMS
   families and committed. The glyph's Unicode from pdf.js is the fallback for
   a family with no table.
2. Glyph extents come from PDF advances, not from DOM measurement. This should
   remove the cross-machine drift in the benchmark (CI and local differ by two
   selections today), so "identical results locally and in CI" becomes an
   acceptance criterion.
3. Rules come from strokes and fills, accumulated across `constructPath`
   operations. The pixel detector stays only for scanned pages.
4. Composite symbols (`\notin`, and whatever else the benchmark turns up) are
   recognised by overlap, one rule each.

## Not verified

- **Other TeX engines and drivers.** XeLaTeX, LuaLaTeX and dvipdfmx embed fonts
  differently, and the slot may be a glyph id, not a TeX slot. Out of the
  claimed scope; untested.
- **Type 3 fonts** (bitmap fonts in old dvips output). They have no usable
  names. Untested; the fallback is today's heuristics.
- **Latin Modern.** Widely used and, as far as I know, laid out like Computer
  Modern in its Type 1 math fonts, so it should need only aliases. Not
  checked.
- **Per-glyph ink boxes.** pdf.js gives font-wide `ascent`, `descent` and
  `bbox`, not per-glyph extents. The AFM files have them (`B` field), so the
  generated table can carry them. Whether Phase 3 needs them is open.
- **Other pdf.js versions.** The operator list is not a stable public surface.
  This is confirmed for 4.10.38 only; keep the walker in one module and
  re-run both scripts on any upgrade.
