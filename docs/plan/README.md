# Master plan: reader and app improvements

Entry point. Everything planned lives in this folder; `docs/ARCHITECTURE.md` stays the
living description of the code as it is.

| File | What it is | Status |
|---|---|---|
| `usability-plan.md` | Binding item-level spec (`RU-x.y`), findings F1-F17, tracker (section 10), decisions `RD-n` and deviation log (section 11), **decision and evaluation register (section 12)** | active |
| `architecture-proposal.md` | Brain/Session/Services, slice store, document/text services, tabs and loci, safe persistence. Corrections in section 11 | PROPOSED (nothing accepted) |
| `REVIEW-LOG.md` | Review rounds on the pinned branch | active |

Baseline: `main@9b91ce3` + PR #19 head `b9115ae`. e2e 100 pass / 6 known-red.

## Rules
1. Work by item ID; one commit per item; record deviations in usability-plan section 11.
2. Items name the register IDs (DEC-n, EVAL-n) they wait on; none starts with an open gate.
3. `[read]`/`[run]` facts older than the baseline commit are re-checked when the item starts.
4. Decision IDs: `RD-n` (reader plan), `AD-n` (architecture), `DEC-n`/`EVAL-n` (register); `Dnn` means the master spec.
5. Review protocol: critique one pinned commit (the branch HEAD); findings go to `REVIEW-LOG.md`; corrections are made in place, never as contradicting appendices.

## Open gates (summary; full table in usability-plan section 12)
Start: DEC-1 (PR #19), DEC-2 approved. Next discussion: **DEC-8** (concurrent edits to one entity).
No-loss map from the old files: roadmap -> usability-plan (all phases and items); plan and proposal unchanged apart from path and the corrections commit `fdf7ec4`.
