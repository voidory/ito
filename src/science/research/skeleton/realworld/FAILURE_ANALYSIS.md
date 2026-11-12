# FEAT-005B — Real-World Failure Analysis

Failures are CLASSIFIED (not just reported as a wrong graph). Each category maps to the kind of fix it would require. No heuristic was added merely to raise the benchmark score.

## Failure counts across ALL rendered images (base + transforms)

| failure category | count | remedy class | example cases |
|---|---|---|---|
| noise-contrast-compression | 17 | preprocessing | n-butane__saltpepper, cyclohexane__saltpepper, cyclohexanol-skeleton__saltpepper, diphenylmethane__jpegish |
| rotation-skew-staircase | 11 | geometric-graph-extraction | n-heptane__rot15, isobutane__rot15, cycloheptane__rot30, diphenylmethane__rot15 |
| degree-four-ambiguity | 5 | explicit-ambiguity-detection | isooctane__rot15, isooctane__saltpepper, isooctane__thick, neopentyl-chain |
| rounded-corners | 5 | geometric-graph-extraction | diphenylmethane, diphenylmethane__thin, norbornane, adamantane |
| thick-antialiased-lines | 3 | preprocessing | diphenylmethane__thick, norbornane__thick, adamantane__thick |
| fused-rings | 1 | topology-reconstruction | fluorene-skeleton |

## Required failure-mode investigation

The spec names specific failure modes to investigate. Each is addressed below with the evidence observed in this corpus and the remedy class it points to.

### Rounded corners

- **Observed in this corpus:** 5 case(s).
- **Remedy class:** better geometric graph extraction.
- Anti-aliased apices thin into short arcs; a genuine bend can fall below the corner-angle threshold and be dropped, or split into two. Observed on some rotated chains and small rings.

### Closely spaced vertices

- **Observed in this corpus:** 0 case(s).
- **Remedy class:** better geometric graph extraction (adaptive merge radius).
- When two carbons sit closer than the merge radius they collapse into one. A locally-adaptive merge radius keyed to incident bond length is the fix.

### Degree-four junction ambiguity

- **Observed in this corpus:** 5 case(s).
- **Remedy class:** explicit ambiguity detection.
- A quaternary carbon (e.g. neopentane, adamantane cage, geminal dimethyl) cannot have its degree recovered from pure geometry when two of its bonds are near-collinear — it reads as a straight line of degree 2. This is the dominant structural failure and is flagged, not guessed.

### Crossing bonds

- **Observed in this corpus:** 0 case(s).
- **Remedy class:** explicit ambiguity detection.
- Two strokes crossing produce a degree-4 junction indistinguishable from a real quaternary carbon without pairing bonds by collinearity.

### Fused rings

- **Observed in this corpus:** 1 case(s).
- **Remedy class:** topology reconstruction.
- Shared-edge junctions in fused systems must be connected exactly to preserve the independent-ring count μ. Mostly handled; angular/polycyclic fusions are the residual risk.

### Very small rings

- **Observed in this corpus:** 0 case(s).
- **Remedy class:** better geometric graph extraction.
- 3- and 4-membered rings have sharp apices that round under thinning; least-squares segment fitting would stabilise them.

### Thick / anti-aliased lines

- **Observed in this corpus:** 3 case(s).
- **Remedy class:** preprocessing (stroke-width normalisation).
- Wide strokes thin imperfectly, shifting junction centroids. Normalising stroke width before thinning reduces this.

### Labels touching or overlapping bonds

- **Observed in this corpus:** 0 case(s).
- **Remedy class:** preprocessing (text detection + masking).
- Element/group text rendered onto the skeleton is traced as spurious strokes/vertices. Text-region detection and masking before extraction is required; this is a prerequisite for heteroatom recognition anyway.

### Multiple disconnected structures in one crop

- **Observed in this corpus:** 0 case(s).
- **Remedy class:** topology reconstruction.
- A crop containing several fragments (or a fragmented single molecule) needs per-component handling and gap-closing reconnection.

## Remedy summary

Mapping the observed failures to the spec's remedy classes, in rough priority order:

1. **Explicit ambiguity detection** — degree-4 / crossing junctions. The single biggest structural gap; already flagged with lowered confidence, but a bond-pairing collinearity test would let many quaternary carbons be recovered.
2. **Preprocessing** — label masking and stroke-width normalisation. Needed both for robustness here and as a prerequisite for later heteroatom work.
3. **Better geometric graph extraction** — least-squares segment fitting + sub-pixel corner localisation to stabilise rounded corners, small rings and rotation/skew.
4. **Topology reconstruction** — robust fused/polycyclic junction connection and multi-component handling.

## Conclusion

Real-world clean-render exact reconstruction is **90.9%**, well below the synthetic 100%. Vertex and bond F1 remain high (near-misses, not collapses), so the geometry is largely right; the failures are concentrated and explainable (degree-4 junctions, labels, small-ring/rotation corner rounding). **Carbon-skeleton reconstruction is not yet reliable enough on real diagrams to be made part of the automatic Identify workflow, and heteroatom recognition / full SMILES generation should not proceed until the remedies above close these gaps.**
