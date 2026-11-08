/**
 * Ambient type for the PDF-anchor spike harness API exposed on `window` by
 * spikes/pdf-anchor/main.ts. Used by e2e/pdf-anchor.spec.ts so the Playwright
 * `page.evaluate` callbacks stay type-checked.
 */
import type { TextAnchor } from "../src/model";

interface SpikeApi {
  render(
    pageNumber: number,
    scale?: number,
  ): Promise<{ pageText: string; versionHash: string; numPages: number }>;
  findOffset(needle: string): number;
  createAnchorForRange(start: number, end: number): TextAnchor;
  resolve(anchor: TextAnchor): {
    kind: string;
    rects: { x: number; y: number; width: number; height: number }[];
    text: string;
  };
  zoom(scale: number): Promise<void>;
  resizeMount(cssWidth: number): void;
  pageText(): string;
}

declare global {
  interface Window {
    __spike: SpikeApi;
  }
}

export {};
