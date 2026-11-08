# ADR-0006: Range-annotation interactions (D15)

- Status: PROPOSED DEFAULT
- Spec references: section 6 ("annotation at two scales"), requirements R03,
  R16, R17; D15 decision checklist for M1 reading completion.

## Context

M1 introduces a page-range annotation ("Comment on page range") that is ONE
logical annotation spanning a continuous page range. Before the interaction can
be declared complete, D15 requires explicit decisions on three range-related
questions:

1. Range boundary gesture granularity — how precisely a user picks the range.
2. Whole-page highlight border styling + hit area — how the per-page marking
   looks and how it is clicked.
3. Range-citation representation — how a range annotation is represented when it
   is cited into a subject page.

## Decision

### 1. Range boundary gesture granularity: WHOLE-PAGE

The range selector operates at WHOLE-PAGE granularity: the user picks a start
page and an end page from a visible start/end selector (two page dropdowns in
`Reader.tsx`), and the annotation spans every page in `[start, end]` inclusive.
Sub-page (text-offset) boundaries are explicitly NOT part of the range gesture —
that is what the text-level micro-highlight is for. The model reflects this: a
range uses `ScopeAnchor { startPageIndex, endPageIndex }` (whole pages), while a
precise selection uses `TextAnchor` (normalized rects).

Rationale: a page-range comment is a coarse "this whole stretch is about X"
gesture; mixing in sub-page endpoints would blur it with micro-highlighting and
make the single shared comment ambiguous. Whole-page boundaries are also trivial
to render deterministically and to re-resolve across editions.

### 2. Whole-page border styling + hit area: INSET BORDER, border is the hit target

Each included page shows a highlight BORDER (never a tint wash that would dim the
page text): a 3px solid rounded rectangle inset ~2% from the page box
(`.ito-highlight-border` in `src/pdf/highlight.ts`). The BORDER element is the
click/hit target (`pointer-events: auto`); the page interior stays fully
interactive for ordinary text selection and micro-highlighting. Clicking any
page's border opens the shared comment surface for the whole range.

Rationale: a border communicates "this page participates in a range" without
competing with the per-line micro-highlight tint and without obscuring glyphs
(accessibility / legibility). Making only the thin border the hit area keeps the
page interior free for independent micro-highlights (R04).

### 3. Range-citation representation: one evidence pair per (annotation, subject), labelled "pp. X-Y"

When a range annotation is cited into a subject page, it is represented like any
other annotation: one or more `EvidenceInstance` records keyed by
`(annotationId, destinationPageId)`. The quoted-text snapshot for a range uses
the human "pp. X-Y" label (derived from the scope) rather than a glyph run,
because a range has no single contiguous text run. Derived citation status for a
range therefore follows the exact same machine as a text annotation
(`deriveSubjectReferenceStatus`): dotted when only a `SubjectAssociation`
exists, solid once any `EvidenceInstance` exists.

Rationale: keeping range citations on the same derived state machine means the
"removing one quote never demotes while another remains" and "independent per
subject" invariants (R07) hold uniformly for both scales with no special-casing.

## Consequences

- Range gestures are deterministic and edition-portable (whole-page indices).
- Page interiors remain free for independent micro-highlights (R04 preserved).
- Range and text annotations share one citation state machine, so the derived-
  status invariants apply identically to both.
- A finer (sub-page) range boundary is deferred; if a future need appears it
  would be a NEW scope kind, not a mutation of the whole-page range.

## OPEN

- Drag-to-select-range directly on the page rail (vs the dropdown selector) is a
  future ergonomic refinement; the logical model is unaffected.
