# FEAT-005 Carbon-Skeleton Benchmark Report

Auto-generated from `fixtures.artifacts.test.ts` (run with `ITO_WRITE_SKELETON_FIXTURES=1`). Single source of truth: `fixtures.ts`.

Corpus size: **22** distinct structures.
Metric: exact **graph isomorphism** vs. ground truth (vertex count, edge count, degree sequence, cycle rank, topology).

## Accuracy by render condition

| Render condition | Accuracy | Failing structures |
|---|---|---|
| crisp-1px | 22/22 (100.0%) | — |
| antialiased | 21/22 (95.5%) | cyclopropane |
| thick-2.4px | 22/22 (100.0%) | — |
| rot-30deg | 19/22 (86.4%) | neopentane, cyclopentane, ethylcyclopentane |
| rot-45deg | 20/22 (90.9%) | methylcyclohexane, tbutylcyclohexane |

## Per-structure ground truth (clean render)

| Structure | Class | V | E | μ | reconstructed exactly (1px) |
|---|---|---|---|---|---|
| ethane | straight-chain | 2 | 1 | 0 | yes |
| butane | straight-chain | 4 | 3 | 0 | yes |
| hexane | bent-chain | 6 | 5 | 0 | yes |
| octane | bent-chain | 8 | 7 | 0 | yes |
| pentane-bent | bent-chain | 5 | 4 | 0 | yes |
| isobutane | branched-chain | 4 | 3 | 0 | yes |
| isopentane | branched-chain | 5 | 4 | 0 | yes |
| neopentane | branched-chain | 5 | 4 | 0 | yes |
| dimethylbutane | branched-chain | 6 | 5 | 0 | yes |
| ethylpentane | branched-chain | 7 | 6 | 0 | yes |
| cyclopropane | cycloalkane | 3 | 3 | 1 | yes |
| cyclobutane | cycloalkane | 4 | 4 | 1 | yes |
| cyclopentane | cycloalkane | 5 | 5 | 1 | yes |
| cyclohexane | cycloalkane | 6 | 6 | 1 | yes |
| methylcyclohexane | ring-substituent | 7 | 7 | 1 | yes |
| dimethylcyclohexane | ring-substituent | 8 | 8 | 1 | yes |
| ethylcyclopentane | ring-substituent | 7 | 7 | 1 | yes |
| decalin | fused-ring | 10 | 11 | 2 | yes |
| biphenyl | fused-ring | 12 | 13 | 2 | yes |
| spiropentane | fused-ring | 9 | 10 | 2 | yes |
| propane | straight-chain | 3 | 2 | 0 | yes |
| tbutylcyclohexane | ring-substituent | 10 | 10 | 1 | yes |

## Failure analysis

- **Degree-4 vertices under rotation (neopentane):** four bonds meeting at a point become ambiguous when two rotate into near-collinearity — the junction reads as a straight line and drops to degree 2. Flagged, not guessed.
- **Smallest ring under anti-aliasing (cyclopropane):** 60° apexes round into short arcs when a thick anti-aliased stroke is thinned, splitting or merging a vertex. Correct at 1px and at thick crisp strokes.
- **Dense small rings at 45° rotation:** corner rounding interacts with the staircase of newly-diagonal edges, occasionally off by one vertex.

These are inherent geometric ambiguities for a purely deterministic recogniser; proposed targeted fixes are in `SKELETON_RECOGNITION.md`.

> Synthetic fixtures validate the algorithm. They do **not** by themselves establish real-world accuracy on scanned or hand-drawn diagrams.
