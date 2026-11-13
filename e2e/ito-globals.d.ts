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
  // -- M13 (§2.1) spatial Subject basins + promote-to-node ------------------
  promoteAnnotationToNode(
    annotationId: string,
    opts?: { title?: string; includeComment?: boolean },
  ): Promise<{ pageId: string; evidenceId: string }>;
  getOrCreateSubjectBasinPage(categoryId: string): Promise<string>;
  subjectBasinPageId(categoryId: string): string | null;
  isSubjectBasinPage(pageId: string): boolean;
  subjectBasin(
    categoryId: string,
  ): { x: number; y: number; rx: number; ry: number } | null;
  setSubjectBasin(
    categoryId: string,
    basin: { x: number; y: number; rx: number; ry: number },
  ): Promise<void>;
  pointInSubjectBasin(
    pos: { x: number; y: number },
    basin: { x: number; y: number; rx: number; ry: number },
  ): boolean;
  syncNodeBasinMembership(
    pageId: string,
    pos: { x: number; y: number },
  ): Promise<string[]>;
  placeNodeInSubjects(
    pageId: string,
    categoryIds: string[],
  ): Promise<{ x: number; y: number }>;
  // -- M13 (§2.2, FEAT-003) 4-tier hit-testing + workspace routing ----------
  hitTestCanvas(
    point: { x: number; y: number },
    opts?: { pickRadius?: number },
  ):
    | { kind: "node"; pageId: string; distance: number }
    | { kind: "hub"; relationshipId: string; distance: number }
    | { kind: "overlap"; subjectIds: string[] }
    | { kind: "basin"; subjectId: string }
    | { kind: "none" };
  topCitedSourcesForNode(pageId: string): { sourceId: string; count: number }[];
  topCitedSourcesForRelationship(
    relationshipId: string,
  ): { sourceId: string; count: number }[];
  openNodeWorkspace(pageId: string): string[];
  openRelationshipWorkspace(relationshipId: string): Promise<string>;
  getOrCreateRelationshipPage(relationshipId: string): Promise<string>;
  getOrCreateSubjectIntersectionPage(sortedSubjectIds: string[]): Promise<string>;
  openPageKind(): string | null;
  intersectionAspects(): {
    subjects: { categoryId: string; name: string }[];
    corePill: { subjectIds: string[]; label: string; kind: string };
    pairwisePills: { subjectIds: string[]; label: string; kind: string }[];
    relationshipKind: string;
    nodesInside: { pageId: string; title: string }[];
  } | null;
  citedSourceRankingForOpenWorkspace(): {
    sourceId: string;
    title: string;
    count: number;
  }[];
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
  // -- M7 linked history, checkpoints & reflection (H01-H07, D13, D14) ------
  /** Commit any buffered coalesced prose-edit revision immediately (H01). */
  flushPendingRevision(): Promise<void>;
  reflections(): { id: string; startDateKey: string; endDateKey: string }[];
  recordRevisionAt(isoTime: string, summary: string): Promise<string>;
  /** The recorded revisions (oldest first) as serializable rows. */
  revisions(): {
    id: string;
    kind: string;
    label: string;
    summary: string;
    createdAt: string;
    dateKey: string;
    affectedObjectIds: string[];
  }[];
  /** The periodic history checkpoints (H06) as serializable rows. */
  checkpoints(): { id: string; revisionIndex: number; afterRevisionId: string; createdAt: string }[];
  /** Reconstruct the structured state as of a revision (H05). */
  reconstructRevisionState(revId: string): { status: string; missingIds: string[]; hasState: boolean };
  /** Restore the brain to the state as of a revision; returns the new forward revision id (H05). */
  restoreRevision(revId: string): Promise<string | null>;
  /** The history overhead probe (H07). */
  measureHistoryOverhead(): {
    revisionCount: number;
    checkpointCount: number;
    deltaBytes: number;
    checkpointBytes: number;
    replayDurationMs: number;
  };
  /** Create a multi-span reflection over cherry-picked revisions (H04, D14). */
  createReflection(input: { text: string; linkedRevisionIds: string[] }): Promise<{
    id: string;
    text: string;
    linkedRevisionIds: string[];
    startDateKey: string;
    endDateKey: string;
  }>;
  /** Attach/replace a per-change comment on a revision (H04). */
  addRevisionComment(revId: string, text: string): Promise<void>;
  // -- M6 zotero / website / area (A15, A24, D01, D10, D11) ------------------
  /** Idempotently import a Zotero/BetterBibTeX/RDF bundle; returns a summary (A24, D10). */
  importZoteroBundle(json: string): Promise<{
    sourcesAdded: number;
    sourcesUpdated: number;
    annotationsAdded: number;
    annotationsUpdated: number;
  }>;
  /** Import a website snapshot source (URL + snapshot bytes required) (A15, D11). */
  importWebsiteSource(input: {
    url: string;
    snapshot: number[];
    title?: string;
    category?: string;
  }): Promise<{ sourceId: string; kind: string; availabilityStatus: string | null }>;
  /** Commit a rectangular area annotation over a page (D01); returns its id. */
  commitAreaAnnotation(
    sourceId: string,
    pageIndex: number,
    rect: { x: number; y: number; width: number; height: number },
    comment?: string,
    imageDataUrl?: string,
  ): Promise<string>;
  /**
   * Draft LaTeX for a box on a page of a stored PDF via the reader's own
   * render + crop + extraction path (no annotation is created).
   */
  extractLatexAt(
    sourceId: string,
    pageIndex: number,
    rect: { x: number; y: number; width: number; height: number },
    options?: { scale?: number },
  ): Promise<string>;
  // -- §3.3 interactive 2D canvas -------------------------------------------
  /** Persist a node's dragged OFFSET (D19); records NO history revision. */
  setDragOffset(pageId: string, offset: { dx: number; dy: number }): Promise<void>;
  // -- M4 Koofr sync + M5 mobile captures (§15, §16.2, §16.3, A20-A23, H06) --
  /**
   * M4 (§15, A20, H06) publish the live brain to the internal deterministic
   * in-memory Koofr remote (pointer-last). `opts` may name a {baseUrl,
   * username?, appPassword?} but the transport is always the internal fake so
   * the e2e specs round-trip without real network. Returns the serializable
   * sync status after the attempt.
   */
  publishToRemote(opts?: {
    baseUrl?: string;
    username?: string;
    appPassword?: string;
  }): Promise<{ state: string; lastSyncedRevision: number | null; reason?: string }>;
  /**
   * M4 (§15, A20) refresh the live brain FROM the internal deterministic Koofr
   * remote. On an interrupted/corrupted/invalid update the local copy is
   * retained (A20) and the returned status is stale/offline with a reason.
   */
  refreshFromRemote(opts?: {
    baseUrl?: string;
    username?: string;
    appPassword?: string;
    /** Test-only: simulate a dropped/invalid refresh so A20 retain-local holds. */
    corrupt?: boolean;
  }): Promise<{ state: string; lastSyncedRevision: number | null; reason?: string }>;
  /** The current remote-sync status: { state, lastSyncedRevision, reason? }. */
  syncStatus(): { state: string; lastSyncedRevision: number | null; reason?: string };
  /**
   * M5 (§16.2, A23) create a loose mobile capture saved locally immediately.
   * Creating a capture NEVER creates a Page/Category/Relationship. Returns the
   * created capture id.
   */
  createMobileCapture(input: {
    content: string;
    sourceId?: string;
    targetPageId?: string;
    originDevice?: string;
    queueForUpload?: boolean;
  }): Promise<string>;
  /** M5 (§16.2) upload every local/pending capture to the internal remote. */
  uploadPendingCaptures(): Promise<{ captureId: string; status: string; error?: string }[]>;
  /**
   * M5 (§16.2, A22) pull captures FROM the internal remote, deduped strictly by
   * CaptureId so repeated/out-of-order pulls incorporate each at most once.
   * Returns the capture ids newly pulled on THIS call.
   */
  pullRemoteCaptures(): Promise<string[]>;
  /**
   * M5 (§16.3, A22) process a capture with one of the four dispositions:
   * "insert-into-page" | "create-subject" | "dismiss". Idempotent by CaptureId.
   * Returns the recorded disposition (or null when the capture is absent /
   * cannot be incorporated).
   */
  handleCapture(
    captureId: string,
    action: "insert-into-page" | "create-subject" | "dismiss",
  ): Promise<string | null>;
  /** M5 (§16.2/§16.3) the local captures as serializable rows. */
  captures(): {
    id: string;
    content: string;
    text: string;
    status: string;
    sourceId: string | null;
    targetPageId: string | null;
  }[];
}

declare global {
  interface Window {
    __ito: ItoTestApi;
  }
}

export {};
