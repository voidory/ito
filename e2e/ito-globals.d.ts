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
  conceptGraph(): {
    nodes: { pageId: string; title: string; hidden: boolean }[];
    links: {
      relationshipId: string;
      endpointPageIds: string[];
      topology: string;
      blendColor: string;
      hidden: boolean;
    }[];
    categories: { categoryId: string; name: string; colorCode: string }[];
  };
  activeNodeCount(): number;
  is3DUnlocked(): boolean;
  setActive3D(on: boolean): Promise<void>;
  nodePlaceholderFor(sourceId: string): { sourceId: string; title: string; transient: boolean };
  createCategory(name: string, colorCode?: string): Promise<string>;
  createRelationship(endpointPageIds: string[], kind?: string, label?: string): Promise<string>;
  hideNode(pageId: string): Promise<void>;
  hideRelationship(relationshipId: string): Promise<void>;
  nodesViewActive(): boolean;
  setNodesView(active: boolean): void;
  setRelationshipLabel(relationshipId: string, label: string): Promise<void>;
  relationshipLabel(relationshipId: string): string;
  addPageToCategory(categoryId: string, pageId: string): Promise<void>;
  sceneGeometry(): {
    nodes: { pageId: string; x: number; y: number }[];
    hubs: {
      relationshipId: string;
      kind: string;
      endpointCount: number;
      center: { x: number; y: number };
      endpoints: { x: number; y: number }[];
    }[];
    squircles: {
      categoryId: string;
      bounds: { cx: number; cy: number; rx: number; ry: number };
    }[];
    categoryLinks: {
      fromCategoryId: string;
      toCategoryId: string;
      from: { x: number; y: number };
      to: { x: number; y: number };
    }[];
  };
  squircleContainsPoint(categoryId: string, x: number, y: number): boolean;
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
