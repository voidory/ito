# Deterministic Carbon-Skeleton Reconstruction (FEAT-005 / M19)

A standalone, deterministic computer-vision + graph-theory pipeline that
reconstructs the **carbon skeleton** of a clean skeletal organic structure from
an image crop. It produces a carbon **graph**, not SMILES, and runs entirely in
TypeScript in the browser — **no external AI, no cloud inference, no network**.

This milestone is deliberately restricted to the carbon skeleton. Heteroatoms,
functional groups, bond orders, charges, stereochemistry and SMILES generation
are later milestones and are intentionally **not** implemented here.

## Where it lives and why

- Module: `src/science/skeleton/` — a new, **independent** module.
- It does **not** modify or depend on the existing M18 recognition pipeline
  (`src/science/recognition/*`: `RecognitionService`, the molecule / reaction /
  math recognizers, `chemGraph`, `chemistryValidation`). The Identify workflow
  is untouched; this recogniser is kept separate from the rendering pipeline.
- It consumes the **same crop representation** the rest of Ito already uses: the
  `imageDataUrl` captured on an `AreaAnchor` (see `cropCanvasRegionToDataUrl` and
  `AreaAnchor` in `src/model/types.ts`). In a browser,
  `decodeImageDataUrlToGray` turns that data URL into the pure `GrayImage` the
  pipeline operates on. The original crop is never mutated.
- Local TypeScript execution was chosen over any OCSR model (DECIMER /
  MolScribe) or a Python service: the problem — recovering a graph from clean
  line art — is tractable with classical CV + graph theory, needs no large
  dependency, and keeps the default build network-free. No new runtime
  dependency was added.

## Pipeline

```
image crop (data URL / RGBA)
  └─ imageIo        → GrayImage              (grayscale, white-composited)
  └─ preprocess     → BinaryImage            (Otsu threshold, denoise, morph close)
                    → BinaryImage (skeleton) (Zhang-Suen thinning, ~1px)
  └─ graphExtraction→ GeometricGraph         (vertices + edges + paths)
  └─ carbonSkeleton → CarbonSkeletonResult   (carbons, bonds, cycles, components)
```

Every stage is a pure function and is **independently unit-tested**.

### 1. Preprocessing (`preprocess.ts`)

- **Grayscale**: RGBA → BT.601 luma, compositing transparency onto white so
  transparent pixels read as background.
- **Threshold**: Otsu's method (global, between-class variance) by default, or a
  fixed cutoff. Foreground is `luminance <= cutoff` (`<=`, not `<`, so crisp
  near-bimodal images whose Otsu cutoff lands exactly on the ink value still
  register the ink).
- **Denoise**: 8-connected component labelling; components below
  `minComponentPixels` are removed.
- **Morphological close** (dilate→erode): bridges 1px anti-aliasing gaps.
  (Open is intentionally *not* applied before thinning — it can erase thin
  strokes.)
- **Zhang-Suen thinning**: the classic two-sub-iteration parallel thinning
  algorithm, reducing strokes to a ~1px skeleton while preserving connectivity
  and endpoints. Deterministic and idempotent on a 1px input.

### 2. Geometric graph extraction (`graphExtraction.ts`)

The hard part: turning a pixel skeleton into a clean graph without inventing
atoms.

- **Connectivity number, not raw neighbour count.** A pixel's significance is
  decided by its *connectivity number* (Rutovitz crossing number / 2 — the
  number of distinct 8-connected foreground arcs meeting it), **not** its raw
  8-neighbour count. This is the single most important design decision: a raw
  neighbour count classifies almost every pixel of a near-horizontal/vertical
  line as a "junction" because the diagonal staircase of such a line touches 3
  neighbour cells. Connectivity number gives a line pixel 2, a terminal 1, and a
  genuine branch ≥ 3 — regardless of orientation.
- **Path tracing** walks each 1px strand between significant pixels exactly
  once, consuming interior pixels. Pure rings (no endpoint/junction) are traced
  separately as closed loops. The walk prefers orthogonal steps over diagonal to
  follow a staircase medial line, and is guarded against infinite loops.
- **Line-angle vertex recovery.** Each traced strand is simplified with
  **Douglas-Peucker**; an interior polyline point is kept as a carbon vertex only
  when its turn angle exceeds a threshold **and** both adjacent segments are a
  meaningful fraction of the bond length. This distinguishes a genuine skeletal
  bend from a 1-step staircase jog, anti-aliasing wiggle, or scanning artefact.
- **Scale invariance.** A bond-length scale is estimated from the median segment
  length of a cheap first-pass simplification. The simplify tolerance, minimum
  segment length and vertex-merge radius are all derived from that scale, so the
  algorithm works on a 60px or a 600px crop without re-tuning.
- **Vertex merging.** Vertices closer than a scale-derived radius are merged, so
  a single corner/junction is never counted multiple times and so corner
  rounding (anti-aliasing + thinning rounding a sharp apex into a short arc) does
  not split one vertex into two. The radius stays well below half the bond
  length, so genuinely distinct carbons are never merged.
- **Spur rejection.** Short dangling fragments left by thinning are dropped
  (shorter than both an absolute floor and a fraction of the median bond length,
  and incident to a degree-1 endpoint).
- **Crossing lines.** A 4-way crossing drawn as two straight strokes becomes a
  single degree-4 junction. The pipeline does **not** silently split it into a
  connected vertex pair; it keeps it as one junction and flags it (degree ≥ 4
  lowers confidence and adds a note), because without further evidence a
  crossing and a real quaternary carbon are indistinguishable.

### 3. Carbon-skeleton reconstruction (`carbonSkeleton.ts`)

Applies conventional skeletal-notation rules:

1. An unlabelled endpoint is a carbon.
2. An unlabelled line-angle vertex is a carbon.
3. An unlabelled junction is a carbon.
4. A line between two vertices is a carbon–carbon bond.
5. Every branch is traced independently; tracing continues through rings.

The result records, per carbon: image coordinates, degree, endpoint/junction
flags, and cycle membership. Connected components and the cycle rank are
computed over the whole graph.

### 4. Ring and branch detection (`graphAnalysis.ts`)

Ring detection is **graph-based**, not visual:

- **Cycle rank** `μ = E − V + C` (first Betti number) tells you how many
  independent rings exist.
- A **cycle basis** (fundamental cycle of each non-tree edge of a BFS spanning
  forest) enumerates the rings. Fused systems yield one ring per independent
  cycle (decalin → 2); a connected (biphenyl) or spiro system likewise.
- **Branch** vertices are degree ≥ 3; **endpoints** are degree 1.
- Ring membership, ring-attached branches and **substituent chains** traced from
  ring vertices are all available.

## Output: `CarbonSkeletonResult`

```ts
interface CarbonSkeletonResult {
  atoms: { id; x; y; degree; isEndpoint; isJunction; belongsToCycle }[];
  bonds: { source; target }[];
  cycles: number[][];            // ring atom-id lists (minimum cycle basis)
  connectedComponents: number[][];
  cycleRank: number;             // μ = E − V + C
  confidence: number;            // heuristic geometric confidence in [0,1]
  status: "success" | "low-confidence" | "invalid" | "unsupported";
  notes: string[];               // explicit reasons / caveats, never silent
}
```

Following the M18 conventions, a result is **never silently fabricated**: a
blank or undecodable crop is `unsupported`, vertices with no bonds are
`invalid`, weak geometry is `low-confidence`, and every outcome carries an
explicit status plus human-readable `notes`.

## Accuracy and limitations

See `BENCHMARK.md` for the full table. On the controlled corpus of 22 synthetic
structures, scored by exact **graph isomorphism** (vertices, edges, degree
sequence, cycle rank, topology):

- **Clean 1px render: 22/22 (100%).**
- **Thick 2.4px render: 22/22 (100%).**
- **Anti-aliased render: 21/22 (95%)** — only `cyclopropane` misses.
- **Rotated 30°/45°: 19–20/22** — documented misses below.

### Known failure modes (documented, not hidden)

- **Degree-4 vertices under rotation (e.g. neopentane).** A quaternary carbon
  where four bonds meet at a point is geometrically ambiguous: when two of the
  bonds rotate into near-collinearity, the junction reads as a single straight
  line passing through, dropping it to degree 2. This is inherent to recovering
  a 4-valent vertex from pure geometry; the pipeline flags degree-4 vertices and
  lowers confidence rather than guessing.
- **Smallest rings under heavy anti-aliasing (cyclopropane).** A 3-membered
  ring's 60° apexes round into short arcs when a thick anti-aliased stroke is
  thinned, which can split one apex into two near-vertices or merge two. At 1px
  and at thick crisp strokes it reconstructs correctly; at an intermediate
  anti-aliased width it can miss by one vertex.
- **Dense small rings under large rotation.** Five-membered rings and some
  ring-substituent structures at 45° occasionally gain/lose a vertex from corner
  rounding interacting with the staircase of newly-diagonal edges.

### Proposed targeted improvements (future work)

- Replace Douglas-Peucker corner recovery with a **least-squares line fit per
  segment** and merge collinear segments by residual, which would stabilise the
  small-ring and rotation cases.
- Detect degree-4 vertices and test the two candidate bond-pairings for
  collinearity to disambiguate a crossing from a quaternary carbon.
- Add sub-pixel corner localisation (e.g. Harris / Shi-Tomasi on the original
  gray image) to refine vertex positions before merging.

### Important caveat

The corpus is **synthetic**: fixtures are generated from known ground-truth
graphs and rasterised. Passing them validates the *algorithm*, but does **not**
by itself establish real-world recognition accuracy on scanned textbooks or
hand-drawn structures. Real diagrams add label text (which this milestone does
not yet mask), double/triple bonds (parallel lines that will currently read as
extra edges), varying line weight, and noise. Evaluating on clean real-world
diagrams is the recommended next validation step before relying on the output.

## Usage

```ts
import {
  decodeImageDataUrlToGray,
  reconstructCarbonSkeleton,
} from "../science/skeleton";

// Browser (from an AreaAnchor crop):
const gray = await decodeImageDataUrlToGray(areaAnchor.imageDataUrl);
const result = reconstructCarbonSkeleton(gray);
if (result.status === "success") {
  // result.atoms / result.bonds / result.cycles ...
}

// Node / tests: build a GrayImage directly, e.g. via rasterizeFixture or
// grayFromRgba, then call reconstructCarbonSkeleton(gray).
```
