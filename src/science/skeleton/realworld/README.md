# FEAT-005B — Real-World Carbon-Skeleton Validation

This module validates the **existing** deterministic carbon-skeleton pipeline
(`../`) against **real molecular structures rendered as genuine anti-aliased
PNGs**, as a benchmark category kept strictly **separate** from the synthetic
SVG fixtures in `../fixtures.ts`. It does **not** modify the algorithm and does
**not** wire recognition into the Identify workflow.

## TL;DR results

| Benchmark | structures | exact reconstruction |
|---|---|---|
| Synthetic SVG fixtures (clean 1px) | 22 | 100.0% |
| **Real-world rendered (clean base)** | 55 | **~91%** |

Full numbers, per-category and per-transform tables, per-structure results and
the failure analysis are in [`REALWORLD_BENCHMARK.md`](./REALWORLD_BENCHMARK.md)
and [`FAILURE_ANALYSIS.md`](./FAILURE_ANALYSIS.md). Both are generated, never
hand-edited.

## What's here

| File | Purpose |
|---|---|
| `corpus.ts` | ≥50 real named structures reduced to carbon skeletons; **manually-verified** ground-truth graphs + layout. Single source of truth. |
| `layout.ts` | Deterministic layout into pixel space (shared by renderer + benchmark). |
| `split.ts` | Deterministic, category-stratified **development / evaluation (held-out)** split. |
| `pngDecode.ts` | Pure-TS PNG decoder (via `fflate`, already a dependency) so real PNGs decode under vitest with **no DOM canvas**. |
| `metrics.ts` | Vertex/bond precision-recall, graph edit distance, cycle-rank accuracy, branch-topology accuracy, exact isomorphism. |
| `failureAnalysis.ts` | Classifies each failure into the spec's categories + a remedy class. |
| `visualize.ts` | Per-structure multi-panel SVG debug overlay. |
| `areaCropHarness.ts` | **Dev-only** probe: run reconstruction over an `AreaAnchor` crop; verify decode, no-mutation, visualisable, explicit failure. |
| `runBenchmark.ts` | Loads PNGs + ground truth, runs the pipeline, scores, classifies, aggregates. |
| `report.ts` | Markdown report builders. |
| `*.test.ts` | Regression tests (run in CI) + opt-in generators. |

Rendered assets live under `../fixtures/realworld/`:
`manifest.json`, `png/*.png` (committed), `variants.json` (committed),
`debug/*.svg` (base renders committed; transform variants regenerable).

## Pipeline (how the corpus is produced)

```
corpus.ts + layout.ts  (TypeScript, single source of truth)
  └─ manifest.test.ts (ITO_WRITE_REALWORLD_MANIFEST=1) → fixtures/realworld/manifest.json
       └─ scripts/gen-realworld-corpus.py (Pillow, 4× supersample)
            → fixtures/realworld/png/*.png        (clean + robustness variants)
            → fixtures/realworld/variants.json    (ground truth per rendered file)
                 └─ runBenchmark.ts (pngDecode → existing pipeline → metrics → failureAnalysis)
                      └─ report.test.ts (ITO_WRITE_REALWORLD_REPORT=1)
                           → REALWORLD_BENCHMARK.md, FAILURE_ANALYSIS.md, debug/*.svg
```

The **committed PNGs + `variants.json` make the benchmark fully reproducible**
in CI without Python: `realworldBenchmark.test.ts` reads them directly.

## Regenerating (only needed if you change `corpus.ts`)

```sh
# 1. write the manifest from the TS source of truth
npm run realworld:manifest

# 2. render PNGs (needs Pillow + numpy in a venv)
python3 -m venv .chemenv && .chemenv/bin/pip install Pillow numpy
.chemenv/bin/python scripts/gen-realworld-corpus.py

# 3. regenerate reports + debug SVGs
npm run realworld:report
```

## Honesty / scope caveat

These are **real structures rendered by a raster engine**, not photographs of
scanned textbook pages or hand-drawn diagrams. They introduce the real-diagram
artefacts the 1px SVG fixtures lack — true anti-aliasing, varied line weights,
element/group labels touching bonds, non-120° angles, varied resolution, and
(on the held-out set) rotation, skew, lossy compression, Gaussian /
salt-and-pepper noise, reduced resolution and contrast — and they exercise the
*actual* PNG-decode path. They do **not** by themselves establish accuracy on
photographed pages; that remains the final validation step, and the report says
so. Per the completion criteria, heteroatom recognition and full SMILES
generation should **not** proceed until the failure-analysis remedies close the
gaps surfaced here.
