/**
 * Ambient type for the reading-workbench test API exposed on `window.__ito` by
 * src/app/testApi.ts. Used by e2e/reader-workbench.spec.ts so the Playwright
 * `page.evaluate` callbacks stay type-checked. The API drives the REAL app
 * Workbench and the REAL rendered pdf.js text layers — nothing is mocked.
 */

interface ItoTestApi {
  openSourceIds(): string[];
  pageText(pageIndex: number, sourceId?: string): string;
  selectText(needle: string, pageIndex?: number, sourceId?: string): boolean;
  annotationCount(sourceId?: string): number;
  referenceStatus(annotationId: string, destinationPageId: string): string;
  createSubject(title: string): Promise<string>;
  openSubject(pageId: string): void;
  openSubjectId(): string | null;
  subjectOutline(pageId: string): string[];
  subjectEvidenceOrder(pageId: string): string[];
  firstAnnotationId(): string | null;
  subjectStats(pageId: string): {
    blockCount: number;
    paragraphCount: number;
    headingCount: number;
    quoteCount: number;
    sourceCount: number;
  };
  pageEvidenceCount(pageId: string): number;
  evidenceResolution(evidenceId: string): string;
  paneWidths(): Record<string, number>;
  linesVisible(): boolean;
  setLinesVisible(visible: boolean): void;
  passageLineData(): { evidenceId: string; sourceId: string; sourcePageIndex: number }[];
  categoryScope(): string | null;
  setCategoryScope(category: string | null): void;
  switchReaderPane(fromSourceId: string, toSourceId: string): void;
  categories(): string[];
  graphRecordCount(): { pages: number; relationships: number; categories: number };
  forceNextSaveFailures(count: number): void;
  forceSourceVersionDrift(sourceId: string): Promise<void>;
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

declare global {
  interface Window {
    __ito: ItoTestApi;
  }
}

export {};
