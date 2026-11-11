# Carbon-skeleton recognition (production MVP)

A small, stable, **shippable** product feature:

> Given a reasonably clean cropped 2D skeletal chemical structure, recognise its
> carbon skeleton and return its basic molecular graph / topology.

It is a thin, bounded wrapper over the shared deterministic engine in
[`src/science/skeleton/`](../../skeleton). The ongoing research / benchmark work
lives separately in [`src/science/research/skeleton/`](../../research/skeleton)
and is **not** a prerequisite for this MVP.

## API

```ts
import {
  recognizeCarbonSkeleton,          // (GrayImage) -> CarbonSkeletonRecognition  (pure, sync)
  recognizeCarbonSkeletonFromDataUrl, // (dataUrl) -> Promise<CarbonSkeletonRecognition>  (browser)
} from "../recognition"; // or ".../recognition/carbonSkeleton"
```

The result is a discriminated union on `success`:

- **success** — `{ success: true, status: "success", confidence, skeleton, notes }`
  where `skeleton` has `carbons`, `bonds`, `topology`
  (`carbonCount`, `bondCount`, `ringCount`, optional `ring`, and a coarse
  `shape`: `linear-chain` | `branched-chain` | `monocyclic`), and
  `imageWidth`/`imageHeight` — the pixel dimensions of the image the recogniser
  analysed. The carbon `x`/`y` coordinates live in that space, so a UI overlay
  can use `viewBox="0 0 imageWidth imageHeight"` to stay aligned with the crop.
- **failure** — `{ success: false, status: "unsupported" | "invalid", confidence, reason, notes }`
  with a single human-readable `reason`.

## Scope (what it claims to do)

- simple linear carbon chains
- branched carbon chains
- simple monocyclic structures
- ordinary bond/vertex geometry
- modest rotation and rasterisation (stroke-thickness) variation

## Out of scope — fails **explicitly** rather than guessing

Heteroatoms, atom labels, stereochemistry, charges, aromaticity interpretation
beyond the bare carbon graph, fused/polycyclic/bridged ring systems, SMILES
generation, reactions, mechanisms, electron-flow arrows, full molecule
identification, textbook/scanned-page OCR, and sophisticated uncertainty
resolution.

The scope gate (in `recognizeCarbonSkeleton.ts`) rejects: blank/undecodable
images, fragmented drawings (multiple connected components), crossing strokes
(a degree ≥ 4 vertex), polycyclic structures (cycle rank ≥ 2), and
reconstructions whose geometric confidence is below the threshold.

## Guarantees

Pure and deterministic. **No RDKit, no Python, no network, no external APIs, no
research corpus.** The only input is pixels.

## Tests

Deterministic algorithmic regression tests (the MVP acceptance criteria) live in
[`recognizeCarbonSkeleton.mvp.test.ts`](./recognizeCarbonSkeleton.mvp.test.ts):
straight chain, branched chain, simple ring, another branched structure, rotated
input, stroke-thickness variation, and explicit failure on unsupported input.
The UI integration is covered by
[`../../../app/reader/identifyCarbonSkeleton.render.test.ts`](../../../app/reader/identifyCarbonSkeleton.render.test.ts).

These are distinct from the larger research benchmarks (synthetic / FEAT-005B
real-world / FEAT-005C independent), which measure algorithm accuracy and are
**not** evidence that this MVP recognises arbitrary real-world chemistry.
