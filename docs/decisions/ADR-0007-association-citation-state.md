# ADR-0007: Association / citation state + accessible control (D15)

- Status: PROPOSED DEFAULT
- Spec references: section 6 (source association table), section 4.2;
  requirements R05, R07, R15; D15 decision checklist for M1 reading completion.

## Context

M1 introduces the reader-side source-association state machine and the controls
that drive it. Two remaining D15 items must be decided before the interaction is
declared complete:

4. Last-citation deletion policy — when the final citing quote for a pair is
   removed, does the relationship revert to tentative (dotted) or disappear?
5. Accessible association control — the non-right-click equivalent of the
   context menu (R15).

Background invariant (unchanged, enforced in `src/model/citation.ts`): citation
status is DERIVED per `(annotation, destinationPage)` pair from the live sets of
`EvidenceInstance` (provenance-bearing → "cited"/solid) and `SubjectAssociation`
(reader intent, no provenance → "tentative"/dotted). There is no stored boolean.

## Decision

### 4. Last-citation deletion policy: REVERT-TO-TENTATIVE iff an association remains, else NONE

The status of a pair is purely a function of the live records:

- while ANY `EvidenceInstance` links the pair → `cited` (solid);
- else if a `SubjectAssociation` links the pair → `tentative` (dotted);
- else → `none` (no line drawn).

Therefore removing the LAST citing quote does NOT, by itself, choose a policy —
the derived status simply recomputes. The deliberate policy we adopt is: we do
NOT auto-delete the `SubjectAssociation` when evidence is removed. Consequently:

- If the pair still has a tentative association, it reverts to DOTTED (the
  reader's stated intent survives losing the quote). 
- If there was never a separate association (the dotted link was only ever
  implied by the quote), the relationship DISAPPEARS (status `none`).

This is implemented and tested: removing one of two quotes keeps `cited`;
removing the only quote with an association yields `tentative`; removing the
only quote with no association yields `none`.

Rationale: reverting to tentative rather than silently deleting respects that an
association is an explicit, separately-recorded act of intent. A relationship
that only ever existed because of a now-deleted quote has no remaining evidence
or intent to justify a line, so it correctly disappears. This keeps the graph
honest: a line is shown only when something live justifies it.

### 5. Accessible association control: a menu-button with `aria-haspopup="menu"`

Every highlight exposes the association actions by TWO independent paths:

- a right-click context menu on the highlight overlay (pointer users), and
- an accessible, keyboard-reachable menu-button (`aria-haspopup="menu"`,
  `aria-label="Annotation actions"`) on each row in the highlights tab
  (`row-actions` in `Reader.tsx`). Activating it opens the same menu with
  "Associate with subject…" and "Insert into subject page…", each backed by a
  searchable subject picker.

Rationale: a context menu alone is inaccessible to keyboard and assistive-tech
users and is awkward on touch. A standards-based menu-button in the always-
reachable highlights list guarantees an equivalent, non-pointer path (R15)
without duplicating the action logic.

## Consequences

- Citation status is never stored; it recomputes from live records, so the
  "remove one quote of several keeps it cited" and "independent per subject"
  guarantees (R07) are structural, not bookkeeping.
- Associating or citing NEVER moves or deletes the source annotation, and
  commenting alone never creates a dotted link (associations are a distinct
  explicit action).
- There are two equal paths to the actions; neither is primary, satisfying R15.

## OPEN

- Whether a "pin" could keep a dotted association visible after the subject page
  is archived is a graph-view (M5) question, out of M1 scope.
