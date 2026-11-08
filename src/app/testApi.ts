/**
 * Imperative test API exposed on `window.__ito` for the Playwright runtime
 * suite (spec section 24). It drives the SAME Workbench the UI uses and the
 * SAME rendered pdf.js text layers in the DOM — it mocks nothing. The helpers
 * exist so tests can perform deterministic real-text selections (find a glyph
 * offset, build a DOM Range over the live text nodes, apply it to the window
 * Selection) and read back real state.
 *
 * Selecting via this API dispatches a real `mouseup` on the pane so the app's
 * ordinary selection→toolbar path runs exactly as a human's would.
 */

import type { AnnotationId, PageId, SourceId } from "../model";
import type { Workbench } from "./workbench";

interface ItoTestApi {
  /** Current open source ids. */
  openSourceIds(): string[];
  /** Page text of a rendered page (0-based index) within the first/given pane. */
  pageText(pageIndex: number, sourceId?: string): string;
  /** Select [needle] in the given page's live text layer and fire mouseup. */
  selectText(needle: string, pageIndex?: number, sourceId?: string): boolean;
  /** Current annotation count for a source (or all). */
  annotationCount(sourceId?: string): number;
  /** Derived reference status for an (annotation, destination) pair. */
  referenceStatus(annotationId: string, destinationPageId: string): string;
  /** Create a subject page and return its id (test setup convenience). */
  createSubject(title: string): Promise<string>;
  /** Count of Page + Relationship + Category records (invariant probe). */
  graphRecordCount(): { pages: number; relationships: number; categories: number };
  /** Test-only: force the next N persist() calls to fail (R12). */
  forceNextSaveFailures(count: number): void;
  /** Raw counts for assertions. */
  counts(): {
    sources: number;
    annotations: number;
    evidence: number;
    associations: number;
    pages: number;
    relationships: number;
    categories: number;
  };
}

function findPane(sourceId?: string): HTMLElement | null {
  if (sourceId) {
    return document.querySelector(`[data-testid="source-pane"][data-source-id="${sourceId}"]`);
  }
  return document.querySelector('[data-testid="source-pane"]');
}

function findPageContainer(pane: HTMLElement, pageIndex: number): HTMLElement | null {
  const mount = pane.querySelector('[data-testid="pdf-mount"]');
  if (!mount) return null;
  return mount.querySelector(`.pdf-page[data-page-index="${pageIndex}"]`);
}

function textLayerOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector(".textLayer");
}

/** Flatten a text layer to a string + per-node offset spans (live DOM). */
function glyphMap(layer: HTMLElement): { text: string; runs: { node: Text; start: number; end: number }[] } {
  const runs: { node: Text; start: number; end: number }[] = [];
  let text = "";
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  let n = walker.nextNode();
  while (n) {
    const node = n as Text;
    runs.push({ node, start: text.length, end: text.length + node.data.length });
    text += node.data;
    n = walker.nextNode();
  }
  return { text, runs };
}

export function installTestApi(wb: Workbench, bump: () => void): void {
  const api: ItoTestApi = {
    openSourceIds() {
      return [...wb.snapshot().openSourceIds];
    },
    pageText(pageIndex, sourceId) {
      const pane = findPane(sourceId);
      if (!pane) return "";
      const container = findPageContainer(pane, pageIndex);
      if (!container) return "";
      const layer = textLayerOf(container);
      return layer ? glyphMap(layer).text : "";
    },
    selectText(needle, pageIndex = 0, sourceId) {
      const pane = findPane(sourceId);
      if (!pane) return false;
      const container = findPageContainer(pane, pageIndex);
      if (!container) return false;
      const layer = textLayerOf(container);
      if (!layer) return false;
      const map = glyphMap(layer);
      const start = map.text.indexOf(needle);
      if (start < 0) return false;
      const end = start + needle.length;
      const startRun = map.runs.find((r) => start >= r.start && start < r.end);
      const endRun = map.runs.find((r) => end > r.start && end <= r.end);
      if (!startRun || !endRun) return false;
      const range = document.createRange();
      range.setStart(startRun.node, start - startRun.start);
      range.setEnd(endRun.node, end - endRun.start);
      const selection = window.getSelection();
      if (!selection) return false;
      selection.removeAllRanges();
      selection.addRange(range);
      // Fire the real mouseup the app listens for.
      pane.querySelector('[data-testid="pdf-mount"]')?.dispatchEvent(
        new MouseEvent("mouseup", { bubbles: true }),
      );
      return true;
    },
    annotationCount(sourceId) {
      const data = wb.rawData();
      return sourceId
        ? data.annotations.filter((a) => a.sourceId === (sourceId as SourceId)).length
        : data.annotations.length;
    },
    referenceStatus(annotationId, destinationPageId) {
      return wb.referenceStatus(annotationId as AnnotationId, destinationPageId as PageId);
    },
    async createSubject(title) {
      const page = await wb.createSubjectPage(title);
      bump();
      return page.id;
    },
    graphRecordCount() {
      const d = wb.rawData();
      return {
        pages: d.pages.length,
        relationships: d.relationships.length,
        categories: d.categories.length,
      };
    },
    forceNextSaveFailures(count) {
      wb.forceNextSaveFailures(count);
    },
    counts() {
      const d = wb.rawData();
      return {
        sources: d.sources.length,
        annotations: d.annotations.length,
        evidence: d.evidenceInstances.length,
        associations: d.subjectAssociations.length,
        pages: d.pages.length,
        relationships: d.relationships.length,
        categories: d.categories.length,
      };
    },
  };

  (window as unknown as { __ito: ItoTestApi }).__ito = api;
  document.body.setAttribute("data-ito-ready", "true");
}
