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
    categories: {
      categoryId: string;
      name: string;
      colorCode: string;
      masterPageId: string | null;
    }[];
  };
  activeNodeCount(): number;
  is3DUnlocked(): boolean;
  active3D(): boolean;
  setActive3D(on: boolean): Promise<void>;
  webglAvailable(): boolean;
  nodePlaceholderFor(sourceId: string): { sourceId: string; title: string; transient: boolean };
  /** One descriptor per open UNCONNECTED source (N06 open-together). */
  openUnconnectedPlaceholders(): { sourceId: string; title: string; transient: boolean }[];
  createCategory(name: string, colorCode?: string): Promise<string>;
  createRelationship(endpointPageIds: string[], kind?: string, label?: string): Promise<string>;
  hideNode(pageId: string): Promise<void>;
  hideRelationship(relationshipId: string): Promise<void>;
  nodesViewActive(): boolean;
  setNodesView(active: boolean): void;
  viewMode(): string;
  setViewMode(mode: string): void;
  sourceIsConnected(sourceId: string): boolean;
  setRelationshipLabel(relationshipId: string, label: string): Promise<void>;
  relationshipLabel(relationshipId: string): string;
  /** A13-M2: develop a relationship's connection into a full Connecting Page. */
  developRelationshipPage(relationshipId: string): Promise<string>;
  /** The explanatory (Connecting) page id of a relationship, or null (A13-M2). */
  relationshipExplanatoryPageId(relationshipId: string): string | null;
  /** The explicit Nodes-view locate target (N04/N05), or null. */
  focusedPageId(): string | null;
  /** Set/clear the explicit Nodes-view locate target (N04/N05, view state). */
  setFocusedPageId(pageId: string | null): void;
  /** The subject page ids an annotation is cited into (N04/N05/N07 branching). */
  citedSubjectPagesForAnnotation(annotationId: string): string[];
  /** Cite an annotation into a subject Page (N04/N05 setup); returns evidence id. */
  citeAnnotationIntoPage(annotationId: string, destinationPageId: string): Promise<string>;
  /**
   * Case-insensitive substring search across Page titles + body text, Category
   * names, and Annotation anchor + comment (M2-FIX-2). An optional categoryId
   * restricts page hits to that category's members.
   */
  search(
    query: string,
    opts?: { categoryId?: string },
  ): {
    kind: string;
    id: string;
    matchedField: string;
    title?: string;
    name?: string;
    sourceId?: string;
    anchorText?: string;
    comment?: string;
  }[];
  /** The 1-hop graph neighbourhood of a page: connected pages + relationships. */
  neighborhood(pageId: string): { pageIds: string[]; relationshipIds: string[] };
  /** The master page id of a category (A14-M2), or null if none created. */
  categoryMasterPageId(categoryId: string): string | null;
  /** Get or create a category's master page (A14-M2); returns the page id. */
  getOrCreateCategoryMasterPage(categoryId: string): Promise<string>;
  /** Connect two categories at their boundaries (A14-M2); returns the rel id. */
  connectCategoryBoundaries(fromCategoryId: string, toCategoryId: string): Promise<string>;
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
      linkKind: "master" | "member";
      from: { x: number; y: number };
      to: { x: number; y: number };
    }[];
  };
  squircleContainsPoint(categoryId: string, x: number, y: number): boolean;
  /**
   * Export the live brain as a backup (A18, D09). Returns a serializable
   * summary: the stamped omission tokens, the backupMode 'full'|'targeted',
   * and the byte length. The bytes are held internally for stageLastExport.
   */
  exportBackup(options?: {
    presentation?: boolean;
    captures?: boolean;
    revisions?: boolean;
    sourceBinaries?: boolean;
  }): Promise<{ omissions: string[]; backupMode: string; byteLength: number }>;
  /** Stage the bytes of the LAST exportBackup back through the validator. */
  stageLastExport(): Promise<{ outcome: string; findings: string[]; reason: string | null }>;
  /**
   * Stage an incoming backup for validation WITHOUT touching the live store
   * (A19). Accepts a serializable bundle: a number[] of bytes (a Lane-2
   * `.ito.zip`) or a JSON string (a bare Lane-1 payload), converted to a
   * Uint8Array inside. Returns a serializable staging summary.
   */
  stageImport(
    bundle: number[] | string,
  ): Promise<{ outcome: string; findings: string[]; reason: string | null }>;
  /** The currently staged outcome, or null (mirrors the UI staging report). */
  stagedImportState(): { outcome: string; findings: string[]; reason: string | null } | null;
  /** Commit the held staged import; `lenient` is the 'Try Import Anyway' path. */
  commitStagedImport(opts?: { lenient?: boolean }): Promise<{ committed: boolean; reason: string | null }>;
  /** Offload a source's PDF binary locally (A17); records stay intact. */
  offloadSourceBinary(sourceId: string): Promise<void>;
  /** Re-attach a PDF binary (A17); accepts number[] bytes, sha256-verified. */
  attachSourceBinary(
    sourceId: string,
    bytes: number[],
  ): Promise<{ attached: boolean; reason: string | null }>;
  /** Whether a source's binary is locally available ('cached'|'binary-offloaded'). */
  sourceBinaryStatus(sourceId: string): string;
  /** The stored PDF bytes of a source as a serializable number[] (null if gone). */
  readSourceBytes(sourceId: string): Promise<number[] | null>;
  /** D02 "delete highlight only": remove the annotation, keep every quote. */
  deleteAnnotationOnly(annotationId: string): Promise<void>;
  /** D02 "delete highlight and its quotes": remove the annotation + its quotes. */
  deleteAnnotationAndQuotes(annotationId: string): Promise<void>;
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
