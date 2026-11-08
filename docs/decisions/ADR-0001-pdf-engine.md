# ADR-0001: PDF engine = pdfjs-dist

- Status: PROPOSED DEFAULT
- Spec references: section 5 (PDF rendering & annotation layer), section 24

## Context

The reader must render research PDFs with a *real* selectable text layer so
that text selections can be captured as portable anchors with stable per-glyph
geometry. An alternative sometimes used is embedding the PDF in an `<iframe>`
(e.g. the browser's native viewer) and drawing a fake-HTML highlight layer on
top. That approach cannot read reliable glyph geometry, cannot reconstruct
selections across zoom/scroll, and breaks the portable-anchor requirement.

## Decision

Use `pdfjs-dist` (Mozilla pdf.js). Render each page to a canvas and build the
pdf.js text layer so selections map to real text runs and normalized rects.
Explicitly REJECT the `iframe` + fake-HTML annotation-layer approach.

## Consequences

- We own page rendering, the text layer, and worker setup (Vite copies the
  pdf.worker from pdfjs-dist).
- Per-glyph geometry is available, enabling normalized-rect anchors (ADR-0003).
- Larger bundle and more integration code than an iframe, accepted as the cost
  of correct anchoring.

## OPEN

- Exact pdf.js version pinning / worker bundling strategy for production hosting.
- Handling of scanned/image-only PDFs with no text layer (out of M0-M1 scope).
