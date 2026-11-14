# Spike: the extractor on the papers' own pages

The benchmark's real-paper tiers hold real equations on pages our own harness
typeset: one equation at a time, in Computer Modern, with nothing around it.
This spike asks what changes on the real thing. It downloads the arXiv PDF of
each of the 60 papers behind those tiers and measures three things: the fonts
the paper is set in, extraction from a box drawn closely round an equation,
and extraction from a box as wide as the text column.

**Result: Phase 3 is not the next thing to build.** On real pages the
structural parser is already about as good as on ours. What breaks real use
is around the equation, not inside it: the equation number, the sentence's
punctuation, and papers whose mathematics is not in Computer Modern.

Reproduce with:

```bash
npx vite-node scripts/spikes/real-pages.ts /path/to/a/cache/directory
```

The PDFs are downloaded into the cache directory (one request every three
seconds) and are not committed. Failures are printed for the 30 development
papers only; the 30 held-out papers are reported in aggregate. Measured with
pdfjs-dist 4.10.38 on the latest arXiv version of each paper.

## How an equation is found on a real page

The harness PDF gives, for each equation of the tiers, the exact sequence of
(font family, slot) that TeX drew. The script looks for that sequence,
contiguous and occurring exactly once, in the paper's own glyph stream. A match
means the paper's TeX run set the equation the same way ours did, so the
source is still the ground truth, and the matched glyphs give the box.

This finds 1,596 of the 2,957 equations (54%). The rest are in papers with
other math fonts, were set differently by the paper (other delimiter sizes, a
line break, the paper's own spacing macros), are shorter than three glyphs, or
occur more than once. The equations found are therefore the ones typeset
plainly, which is a second selection on top of the tiers' own.

## Findings

### 1. Fonts: the mathematics is Computer Modern in 51 of 60 papers

| | Papers |
|---|---|
| Mathematics in the Computer Modern math fonts | 51 |
| of which the text is too (over 90% of glyphs in fonts the slot table covers) | 38 |
| Mathematics in other fonts | 9 |

The nine are Latin Modern (3), MnSymbol (2), MathDesign, Pazo, Libertine and
one I could not name. In those papers the extractor falls back to the
character pdf.js reports, and none of their equations could be located, so
they are unmeasured here.

Thirteen papers set their text in another family (Times and similar) but
their mathematics in Computer Modern. The slot table still identifies the
mathematics there; only words inside formulas fall back.

### 2. dvips draws rules as image masks, and the model missed all of them

Papers converted from PostScript have no paths at all. dvips draws every
fraction bar and radical rule as a one-pixel image mask stretched to size,
which pdf.js reports as `paintSolidColorImageMask`. The page model read
strokes and filled rectangles only, so in those papers every fraction and
radical failed. Reading the mask as a rule is fixed in this commit
(`src/pdf/pageMathModel.ts`) and moved the display result on development
papers from 82.0% to 92.0%.

The generated tiers could not have shown this: they are all pdfLaTeX.

### 3. From a tight box, real pages match our pages

| | Development papers | Held-out papers |
|---|---|---|
| Display, exact | 403 of 438 (92.0%) | 394 of 443 (88.9%) |
| The same tier on harness pages | 91.3% | 88.2% |
| Inline, exact | 320 of 390 (82.1%) | 247 of 325 (76.0%) |
| Inline, exact but for the sentence's punctuation | 58 (14.9%) | 60 (18.5%) |
| Inline, broken across two lines | 7 (1.8%) | 12 (3.7%) |
| Inline, wrong | 5 (1.3%) | 6 (1.8%) |

- **Display equations** come out as they do on harness pages. The remaining
  failures are the ones the plan already lists for Phase 3 (grids, limits,
  several lines).
- **Inline formulas** lose 15 to 18 points to one thing: the comma or full
  stop that ends the clause sits against the formula, inside any box a reader
  would draw, and is extracted with it. The harness tier puts a word space
  after every formula, so it never shows this.
- **A formula broken across two lines** cannot be selected with one rectangle.
  That is a limit of the tool, not of the extractor.

### 4. From a column-wide box, most display equations fail

| | Development papers | Held-out papers |
|---|---|---|
| Display, exact from a box as wide as the column | 147 of 438 (33.6%) | 113 of 443 (25.5%) |

A reader who drags across the whole line takes in the equation number, and
whatever else shares those lines. I did not separate the two causes.

## What this changes

1. **Before Phase 3: trim what is not the formula.** Drop a trailing comma,
   full stop, semicolon or colon set in the text font, and a right-flushed
   `(n)` or `(n.m)` separated from the equation by a wide gap (as `\tag`, or
   dropped, by option). Both are small, both are in the plan's Phase 3 task 7
   or implied by it, and together they are worth more on real pages than the
   whole of the grid work: 15 to 18 points on inline formulas and, for anyone
   who selects generously, most display equations.
2. **Then a Latin Modern slot table.** Three of 60 papers, and the same
   generator should produce it if the fonts are installed. Unverified.
3. **Then Phase 3** in the order the plan gives.
4. **The benchmark needs these cases.** Add an inline tier with punctuation
   against the formula, a display tier with equation numbers and a loose box,
   and a dvips-produced tier, so each of the three is gated rather than found
   by a spike.

## After acting on it

Items 1, 2 and 4 are done, in the commit after this one. The extractor now
drops the sentence's final mark, equation numbers at either edge, and glyphs
of a neighbouring line that the box's top or bottom edge cuts through; Latin
Modern's math fonts are read with the Computer Modern tables. The same script,
with its column-wide box now stopping at the gutter of a two-column page (it
had spanned both columns, which overstated the damage):

| | Development papers | Held-out papers |
|---|---|---|
| Display, tight box, exact | 403 of 438 (92.0%) | 390 of 439 (88.8%) |
| Display, column-wide box, exact | 396 of 438 (90.4%) | 385 of 439 (87.7%) |
| Inline, tight box, exact | 377 of 389 (96.9%) | 307 of 325 (94.5%) |
| Inline, broken across two lines | 7 | 12 |
| Inline, wrong | 5 | 6 |

Of the column-wide results before the gutter fix (33.6% and 25.5%), dropping
right-hand numbers alone gave 66.4% and 59.7%, left-hand numbers 70.5% and
62.4%, the gutter 85.6% and 84.7%, and a smaller gap plus the cut-glyph rule
the figures above. What still fails from a column-wide box on development
papers (7 equations) is a number that touches the equation, and text sharing
the equation's lines.

These rules were written against development failures. The held-out papers
moved by the same amounts, which is the check that they are not fitted. The
three Latin Modern papers are still unmeasured on their own pages (the
locator matches Computer Modern font names); on harness pages Latin Modern
scores exactly what Computer Modern does, on both sets.

After Phase 3's first slice (rows, grids, limits), the same script gives
display from a tight box 97.3% on development papers and 91.8% on held-out
ones, and from a column-wide box 95.7% and 90.7%. The widening difference
between the two sets is the fitting that the plan's Phase 3 status describes.

## Not verified

- **Bias of the located set.** Only equations typeset plainly could be
  located. Figures here are for those, not for all equations in these papers.
- **Papers in other math fonts.** No equation located, so no number.
- **Why column-wide boxes fail.** Equation numbers are the obvious cause, not
  a measured one.
- **Real selections.** Both boxes are constructed, one tight and one as wide
  as the page's text. Nobody drew them.
- **Tuning.** The image-mask fix was made after seeing development failures.
  The held-out figures are after the same fix, so they are a fair check of it.
