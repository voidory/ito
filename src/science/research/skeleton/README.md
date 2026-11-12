# Carbon-skeleton recognition — research / experimental

This directory holds the **ongoing research and validation** work for carbon-
skeleton recognition. It is deliberately separated from the shippable product
feature so research can keep advancing without destabilising production code.

- **Shared engine** (stable, pure): [`src/science/skeleton/`](../../skeleton)
- **Production MVP** (bounded, shippable): [`src/science/recognition/carbonSkeleton/`](../../recognition/carbonSkeleton)
- **Research / experimental** (this directory): benchmarks, corpora, metrics,
  failure analysis, visual debugging, and the increasingly ambitious graph-
  reconstruction / chemical-vision experiments.

Everything here depends on the shared engine via `../../skeleton`. The engine
does **not** depend on anything here — production never imports research.

## Contents

| Area | What it is | Default suite |
| --- | --- | --- |
| `fixtures.ts`, `fixtures.artifacts.test.ts` | FEAT-005 synthetic corpus + artifact checks | ✅ runs & passes |
| `graphCompare.ts`, `graphCompare.test.ts` | Graph-isomorphism scoring used by benchmarks | ✅ runs & passes |
| `benchmark.test.ts` | FEAT-005 synthetic accuracy benchmark | ✅ runs & passes |
| `realworld/` | FEAT-005B real-world-style raster benchmark | ✅ runs & passes |
| `independent/` | FEAT-005C independent-renderer validation | ⛔ gated (unfinished) |

## FEAT-005C is gated out of the default build

The FEAT-005C independent-renderer validation (`independent/`) is **unfinished**:
its bundled RDKit-rendered corpus and optimal-matching metric are not yet green,
and it does not type-check under the repo's strict settings. It is **preserved**
here for continued work but kept OUT of the default `typecheck` / `test` / `build`
so research instability never blocks the product MVP.

Run it explicitly:

```bash
npm run research:independent:test        # vitest (expected: currently failing)
npm run research:independent:typecheck   # tsc against tsconfig.research.json
```

## Honesty note on validation

Synthetic (FEAT-005), real-world-style (FEAT-005B), and independent-renderer
(FEAT-005C) benchmarks measure the **algorithm** against rendered line art. None
of them — and especially not FEAT-005B/005C — should be cited as evidence that
the production MVP reliably recognises **scanned textbook pages, photographs, or
hand-drawn** structures. True external raster-image validation remains future
work. The product MVP only claims the bounded class documented in its own
README, and fails explicitly outside it.
