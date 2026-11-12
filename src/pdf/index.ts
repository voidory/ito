/**
 * PDF integration barrel. `anchor.ts` holds the DOM-independent portable anchor
 * create/resolve logic (unit-testable); `render.ts` holds the browser-only
 * pdf.js rendering + text-layer wiring exercised by the Playwright spike.
 */

export * from "./anchor";
export * from "./render";
export * from "./highlight";
export * from "./pointerSelection";
export * from "./scannedHighlight";
export * from "./textCache";
export * from "./scienceOcr";
export * from "./glyphMap";
export * from "./analysisCache";
export * from "./ingestPipeline";
export * from "./instrumentation";
export * from "./pageAnalyzer";
