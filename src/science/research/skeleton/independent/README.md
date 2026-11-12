# FEAT-005C — Independent-renderer validation

This benchmark is deliberately separate from FEAT-005B.

The evaluation structures are sourced from PubChem records (CID + SMILES) and rendered with RDKit's independent MolDraw2DSVG layout engine. Ground-truth carbon atoms and carbon-carbon bonds are derived from the molecular graph, not from Ito's renderer or from the raster image.

The locked source bundle contains 30 hydrocarbon structures spanning chains, branches, rings, fused/connected rings and polycyclic/bridged systems. All cases are evaluation cases; there is no development split and no tuning against these examples.

The benchmark then rasterises the RDKit SVG bond paths deterministically in TypeScript and runs the existing carbon-skeleton reconstruction pipeline unchanged.

This is stronger evidence of renderer/style transfer than the FEAT-005B corpus, but it is **not yet the final external-image validation**. It does not contain scanned textbook pages, lecture slides, photographs, or independently produced raster screenshots. That remains the next validation layer.

The evaluation uses the corrected one-to-one geometric vertex matching in realworld/metrics.ts. The reported edit metric is explicitly a mapped edit count, not unrestricted minimum graph-edit distance.

## Reproduction

No network or Python dependency is required at evaluation time. The locked source bundle is committed in corpusBundle.ts.

To regenerate the source bundle, use the development-only RDKit script documented in scripts/gen-independent-corpus.py (requires RDKit).

## Source provenance

Each structure records its PubChem CID and source SMILES. PubChem is the structure source; RDKit is the independent drawing engine.
