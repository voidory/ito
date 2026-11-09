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

import type {
  AnnotationId,
  CaptureId,
  CategoryId,
  NormalizedRect,
  PageId,
  RelationshipId,
  RelationshipKind,
  SourceId,
} from "../model";
import type { SyncStatus } from "./workbench";
import {
  hydrateState,
  outline,
  evidenceInOrder,
  compositionStatsFromJson,
  type DocumentJson,
} from "../editor";
import { buildScene, squircleContains, type SceneGraphInput } from "../network";
import { KoofrStorageAdapter, type StagedImport } from "../storage";
import { isWebGLAvailable } from "./ThreeScene";
import { Workbench } from "./workbench";

/**
 * Flatten a StagedImport into the serializable summary the e2e spec asserts:
 * the discriminated outcome, the human-readable finding messages (empty for a
 * clean 'ready'), and the abort reason for a hard-reject (null otherwise).
 */
function serializeStaged(staged: StagedImport): {
  outcome: string;
  findings: string[];
  reason: string | null;
} {
  if (staged.outcome === "hard-reject") {
    return { outcome: staged.outcome, findings: [], reason: staged.reason };
  }
  if (staged.outcome === "needs-confirmation") {
    return {
      outcome: staged.outcome,
      findings: staged.findings.map((f) => `${f.kind}: ${f.message}`),
      reason: null,
    };
  }
  return { outcome: staged.outcome, findings: [], reason: null };
}

/** Flatten a SyncStatus into the serializable shape the e2e specs assert. */
function serializeSync(status: SyncStatus): {
  state: string;
  lastSyncedRevision: number | null;
  reason?: string;
} {
  return {
    state: status.state,
    lastSyncedRevision: status.lastSyncedRevision,
    ...(status.reason != null ? { reason: status.reason } : {}),
  };
}

/** Map the live Workbench graph to the scene mapper's input shape. */
function graphToSceneInput(wb: Workbench): SceneGraphInput {
  const g = wb.conceptGraph();
  return {
    nodes: g.nodes.map((n) => ({
      pageId: n.pageId,
      title: n.title,
      hidden: n.hidden,
      position: n.position,
    })),
    links: g.links.map((l) => ({
      relationshipId: l.relationshipId,
      endpointPageIds: l.endpointPageIds,
      label: l.label,
      blendColor: l.blendColor,
      hidden: l.hidden,
    })),
    categories: g.categories.map((c) => ({
      categoryId: c.categoryId,
      name: c.name,
      colorCode: c.colorCode,
      memberPageIds: c.memberPageIds,
      ...(c.masterPageId != null ? { masterPageId: c.masterPageId } : {}),
    })),
  };
}

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
  /** Open a subject page for composition alongside the reader. */
  openSubject(pageId: string): void;
  /** The currently open subject page id, or null. */
  openSubjectId(): string | null;
  /** Linear outline of a subject page composition (writing + ⟦evidence⟧). */
  subjectOutline(pageId: string): string[];
  /** Evidence-node ids in exact composition order for a subject page. */
  subjectEvidenceOrder(pageId: string): string[];
  /** The id of the first annotation for the first source (test convenience). */
  firstAnnotationId(): string | null;
  /** Structural detail counts for a subject page composition. */
  subjectStats(pageId: string): {
    blockCount: number;
    paragraphCount: number;
    headingCount: number;
    quoteCount: number;
    sourceCount: number;
  };
  /** Count of evidence instances whose destination is the given page. */
  pageEvidenceCount(pageId: string): number;
  /** Resolve the source-return state for an evidence instance. */
  evidenceResolution(evidenceId: string): string;
  /** The ordered open source ids, the flex-grow weights per pane slot. */
  paneWidths(): Record<string, number>;
  /** Whether passage-to-evidence lines are currently set visible. */
  linesVisible(): boolean;
  /** Toggle passage-to-evidence line visibility (presentation only). */
  setLinesVisible(visible: boolean): void;
  /** The passage-to-evidence line DATA (independent of whether drawn). */
  passageLineData(): {
    evidenceId: string;
    sourceId: string;
    sourcePageIndex: number;
  }[];
  /** The active library category scope (or null for all). */
  categoryScope(): string | null;
  /** Set the active library category scope. */
  setCategoryScope(category: string | null): void;
  /** Switch a reader pane from one source to another (third-paper swap). */
  switchReaderPane(fromSourceId: string, toSourceId: string): void;
  /** All distinct library category names. */
  categories(): string[];
  /** Count of Page + Relationship + Category records (invariant probe). */
  graphRecordCount(): { pages: number; relationships: number; categories: number };
  /** The derived concept-network graph snapshot (nodes/links/categories). */
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
  /** Count of non-hidden pages participating in the network (§3.4). */
  activeNodeCount(): number;
  /** Whether the Nodes (concept-network) view is active. */
  nodesViewActive(): boolean;
  /** Activate/deactivate the Nodes view (presentation only, FEAT-004). */
  setNodesView(active: boolean): void;
  /** The top-level Files/Nodes view mode (§3.3, FEAT-005). */
  viewMode(): string;
  /** Switch the top-level Files/Nodes view (session view state, no record). */
  setViewMode(mode: string): void;
  /** Whether a source participates in the network (false = N06 placeholder). */
  sourceIsConnected(sourceId: string): boolean;
  /** Set a relationship's label (connecting-page surface). */
  setRelationshipLabel(relationshipId: string, label: string): Promise<void>;
  /** The durable label of a relationship. */
  relationshipLabel(relationshipId: string): string;
  /**
   * Develop a relationship's short connection into a full Connecting Page
   * (A13-M2); lazily creates/returns the explanatory subject Page, opens it,
   * and returns its id. Idempotent.
   */
  developRelationshipPage(relationshipId: string): Promise<string>;
  /** The explanatory (Connecting) page id of a relationship, or null (A13-M2). */
  relationshipExplanatoryPageId(relationshipId: string): string | null;
  /** The explicit Nodes-view locate target (N04/N05), or null. */
  focusedPageId(): string | null;
  /** Set/clear the explicit Nodes-view locate target (N04/N05, view state). */
  setFocusedPageId(pageId: string | null): void;
  /** The subject page ids an annotation is cited into (N04/N05/N07 branching). */
  citedSubjectPagesForAnnotation(annotationId: string): string[];
  /**
   * Cite an existing annotation into an existing subject Page (test setup for
   * N04/N05): inserts a real EvidenceInstance via the SAME transition the UI
   * uses (`insertEvidenceIntoPage`), so the annotation becomes "cited" into
   * that subject page. Returns the created evidence id.
   */
  citeAnnotationIntoPage(annotationId: string, destinationPageId: string): Promise<string>;
  /**
   * Case-insensitive substring search across Page titles + body text, Category
   * names, and Annotation anchor + comment (M2-FIX-2). Returns serializable
   * discriminated results; an optional categoryId restricts page hits.
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
  /** Add a page to a category's membership (never duplicates the Page). */
  addPageToCategory(categoryId: string, pageId: string): Promise<void>;
  /**
   * Geometry probe for the Nodes view (A09/A10/A13/A14-M2): the resolved scene
   * from the SAME live graph + the SAME layout engine the canvas renders. Lets
   * the e2e spec assert containment (squircleContains), hub vertex direction,
   * and category-link endpoints against REAL positions — nothing mocked.
   */
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
  /** True iff a point is inside a category's squircle bounds (A10-M2 probe). */
  squircleContainsPoint(categoryId: string, x: number, y: number): boolean;
  /** Whether the 3D presentation is unlocked (activeNodeCount >= 35). */
  is3DUnlocked(): boolean;
  /** Whether the 3D presentation is currently active (user opted in). */
  active3D(): boolean;
  /** Set the active-3D flag (presentation only). */
  setActive3D(on: boolean): Promise<void>;
  /** Whether a WebGL context can be acquired here (3D vs 2D-fallback branch). */
  webglAvailable(): boolean;
  /** The transient N06 "not connected yet" placeholder for a source id. */
  nodePlaceholderFor(sourceId: string): { sourceId: string; title: string; transient: boolean };
  /**
   * The transient N06 placeholders for EVERY currently open UNCONNECTED source
   * (open-together). One descriptor per open source whose annotations are not
   * yet cited — the headless mirror of what NodesView renders. Pure/ephemeral:
   * creates ZERO durable records.
   */
  openUnconnectedPlaceholders(): { sourceId: string; title: string; transient: boolean }[];
  /** The master page id of a category (A14-M2), or null if none created. */
  categoryMasterPageId(categoryId: string): string | null;
  /** Get or create a category's master page (A14-M2); returns the page id. */
  getOrCreateCategoryMasterPage(categoryId: string): Promise<string>;
  /** Connect two categories at their boundaries (A14-M2); returns the rel id. */
  connectCategoryBoundaries(fromCategoryId: string, toCategoryId: string): Promise<string>;
  /** Create a category with a watercolor color (test setup convenience). */
  createCategory(name: string, colorCode?: string): Promise<string>;
  /** Create a relationship across N>=2 endpoints; returns the relationship id. */
  createRelationship(endpointPageIds: string[], kind?: string, label?: string): Promise<string>;
  /** Hide a node (presentation only; never deletes the Page). */
  hideNode(pageId: string): Promise<void>;
  /** Hide a relationship (presentation only; never deletes the Relationship). */
  hideRelationship(relationshipId: string): Promise<void>;
  /**
   * Export the live brain as a backup (A18, D09). Returns a SERIALIZABLE
   * summary the spec can assert (the stamped omission tokens, the backupMode
   * 'full'|'targeted', and the byte length). The produced bytes are held
   * internally so `stageLastExport` can round-trip the export straight back
   * through the staging validator without the spec having to marshal bytes.
   */
  exportBackup(options?: {
    presentation?: boolean;
    captures?: boolean;
    revisions?: boolean;
    sourceBinaries?: boolean;
  }): Promise<{ omissions: string[]; backupMode: string; byteLength: number }>;
  /** Stage the bytes of the LAST `exportBackup` back through the validator. */
  stageLastExport(): Promise<{ outcome: string; findings: string[]; reason: string | null }>;
  /**
   * Stage an incoming backup bundle for validation WITHOUT touching the live
   * store (A19). Accepts a serializable bundle: a number[] of bytes (a Lane-2
   * `.ito.zip`) or a JSON string (a bare Lane-1 payload); it is converted to a
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
  /** Test-only: force the next N persist() calls to fail (R12). */
  forceNextSaveFailures(count: number): void;
  /** Test-only: drift a source's stored version hash to trigger A17 mismatch. */
  forceSourceVersionDrift(sourceId: string): Promise<void>;
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
  // -- M7 linked history, checkpoints & reflection (H01-H07, D13, D14) ------
  /** Commit any buffered coalesced prose-edit revision immediately (H01). */
  flushPendingRevision(): Promise<void>;
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
  /**
   * Reconstruct the structured state as of a revision (H05). Returns the
   * discriminated status plus the missing ids for a broken chain (the opaque
   * state itself is not marshalled — the status + ids are what tests assert).
   */
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
    rect: NormalizedRect,
    comment?: string,
    imageDataUrl?: string,
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

/**
 * A deterministic in-memory Koofr remote for the e2e runtime suite. It mirrors
 * the WebDAV surface (PUT/GET/PROPFIND/MKCOL) over a single shared Map so a
 * publish and a later refresh (or an upload and a later pull) see the SAME
 * store without any real network. `corrupt` flips GETs of snapshots to an
 * unparseable body so the A20 retain-local path can be exercised.
 */
interface InternalRemote {
  store: Map<string, Uint8Array>;
  fetchImpl: typeof fetch;
  corrupt: boolean;
  baseUrl: string;
}

function makeInternalRemote(): InternalRemote {
  const store = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  const baseUrl = "https://dav.internal/Koofr";
  const remote: InternalRemote = {
    store,
    corrupt: false,
    baseUrl,
    fetchImpl: null as unknown as typeof fetch,
  };

  const bodyToBytes = (body: unknown): Uint8Array => {
    if (typeof body === "string") return enc.encode(body);
    if (body instanceof Uint8Array) return body;
    if (body && typeof (body as ArrayBuffer).byteLength === "number") {
      return new Uint8Array(body as ArrayBuffer);
    }
    return enc.encode(String(body ?? ""));
  };

  const resp = (status: number, body: string | Uint8Array): Response => {
    const bytes = typeof body === "string" ? enc.encode(body) : body;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: `status ${status}`,
      async text() {
        return new TextDecoder().decode(bytes);
      },
      async arrayBuffer() {
        return bytes.slice().buffer;
      },
    } as unknown as Response;
  };

  remote.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.replace(baseUrl + "/", "");
    if (method === "PUT") {
      store.set(path, bodyToBytes(init?.body));
      return resp(201, "");
    }
    if (method === "GET") {
      const bytes = store.get(path);
      if (!bytes) return resp(404, "");
      // A20 fault injection: corrupt snapshot reads so the integrity check
      // fails and the refresh retains the local working copy untouched.
      if (remote.corrupt && path.startsWith("snapshots/")) {
        return resp(200, enc.encode("{ corrupted-not-json"));
      }
      return resp(200, bytes);
    }
    if (method === "MKCOL") return resp(201, "");
    if (method === "PROPFIND") {
      const children = [...store.keys()].filter((k) => k.startsWith(path + "/"));
      const hrefs = children
        .map((k) => `<d:response><d:href>/Koofr/${k}</d:href></d:response>`)
        .join("");
      return resp(207, `<d:multistatus xmlns:d="DAV:">${hrefs}</d:multistatus>`);
    }
    return resp(405, "");
  }) as unknown as typeof fetch;

  return remote;
}

export function installTestApi(wb: Workbench, bump: () => void): void {
  // Holds the bytes of the most recent exportBackup so stageLastExport can
  // round-trip a real export straight back through the staging validator.
  let lastExportBytes: Uint8Array | null = null;
  // One shared deterministic in-memory Koofr remote for the whole session so a
  // publish/refresh (and upload/pull) round-trip hits the same store (M4/M5).
  const internalRemote = makeInternalRemote();
  const koofrAdapter = (): KoofrStorageAdapter =>
    new KoofrStorageAdapter({
      baseUrl: internalRemote.baseUrl,
      username: "test",
      appPassword: "test",
      fetchImpl: internalRemote.fetchImpl,
    });
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
    openSubject(pageId) {
      wb.openSubjectPage(pageId as PageId);
      bump();
    },
    openSubjectId() {
      return wb.snapshot().openSubjectPageId;
    },
    subjectOutline(pageId) {
      const json = wb.subjectDocJson(pageId as PageId) as DocumentJson;
      return outline(hydrateState(json).doc);
    },
    subjectEvidenceOrder(pageId) {
      const json = wb.subjectDocJson(pageId as PageId) as DocumentJson;
      return evidenceInOrder(hydrateState(json).doc).map((e) => e.attrs.evidenceId);
    },
    firstAnnotationId() {
      const d = wb.rawData();
      return d.annotations[0]?.id ?? null;
    },
    subjectStats(pageId) {
      const json = wb.subjectDocJson(pageId as PageId) as DocumentJson;
      const s = compositionStatsFromJson(json);
      return {
        blockCount: s.blockCount,
        paragraphCount: s.paragraphCount,
        headingCount: s.headingCount,
        quoteCount: s.quoteCount,
        sourceCount: s.sourceCount,
      };
    },
    pageEvidenceCount(pageId) {
      return wb
        .rawData()
        .evidenceInstances.filter((e) => e.destinationPageId === (pageId as PageId)).length;
    },
    evidenceResolution(evidenceId) {
      const resolved = wb.resolveEvidenceSource(evidenceId);
      return resolved ? resolved.resolution.kind : "missing";
    },
    paneWidths() {
      return { ...wb.snapshot().workspaceLayout.paneWidths };
    },
    linesVisible() {
      return wb.linesVisible();
    },
    setLinesVisible(visible) {
      wb.setLinesVisible(visible);
      bump();
    },
    passageLineData() {
      return wb.passageEvidenceLines().map((l) => ({
        evidenceId: l.evidenceId,
        sourceId: l.sourceId,
        sourcePageIndex: l.sourcePageIndex,
      }));
    },
    categoryScope() {
      return wb.categoryScope();
    },
    setCategoryScope(category) {
      wb.setCategoryScope(category);
      bump();
    },
    switchReaderPane(fromSourceId, toSourceId) {
      wb.switchReaderPane(fromSourceId as SourceId, toSourceId as SourceId);
      bump();
    },
    categories() {
      return wb.categories();
    },
    graphRecordCount() {
      const d = wb.rawData();
      return {
        pages: d.pages.length,
        relationships: d.relationships.length,
        categories: d.categories.length,
      };
    },
    conceptGraph() {
      const g = wb.conceptGraph();
      return {
        nodes: g.nodes.map((n) => ({
          pageId: n.pageId,
          title: n.title,
          hidden: n.hidden,
        })),
        links: g.links.map((l) => ({
          relationshipId: l.relationshipId,
          endpointPageIds: [...l.endpointPageIds],
          topology: l.topology,
          blendColor: l.blendColor,
          hidden: l.hidden,
        })),
        categories: g.categories.map((c) => ({
          categoryId: c.categoryId,
          name: c.name,
          colorCode: c.colorCode,
          masterPageId: c.masterPageId ?? null,
        })),
      };
    },
    activeNodeCount() {
      return wb.activeNodeCount();
    },
    nodesViewActive() {
      return wb.nodesViewActive();
    },
    setNodesView(active) {
      wb.setNodesViewActive(active);
      bump();
    },
    viewMode() {
      return wb.viewMode();
    },
    setViewMode(mode) {
      wb.setViewMode(mode as "files" | "nodes" | "history" | "captures");
      bump();
    },
    sourceIsConnected(sourceId) {
      return wb.sourceIsConnected(sourceId);
    },
    async setRelationshipLabel(relationshipId, label) {
      await wb.setRelationshipLabel(relationshipId as RelationshipId, label);
      bump();
    },
    relationshipLabel(relationshipId) {
      const rel = wb.rawData().relationships.find((r) => r.id === relationshipId);
      return rel?.label ?? "";
    },
    async developRelationshipPage(relationshipId) {
      const id = await wb.developRelationshipPage(relationshipId as RelationshipId);
      bump();
      return id;
    },
    relationshipExplanatoryPageId(relationshipId) {
      return wb.explanatoryPageId(relationshipId as RelationshipId);
    },
    focusedPageId() {
      return wb.focusedPageId();
    },
    setFocusedPageId(pageId) {
      wb.setFocusedPageId(pageId as PageId | null);
      bump();
    },
    citedSubjectPagesForAnnotation(annotationId) {
      return wb.citedSubjectPagesForAnnotation(annotationId as AnnotationId);
    },
    async citeAnnotationIntoPage(annotationId, destinationPageId) {
      const evidence = await wb.insertEvidenceIntoPage(
        annotationId as AnnotationId,
        destinationPageId as PageId,
      );
      bump();
      return evidence.id;
    },
    search(query, opts) {
      const results = wb.search(
        query,
        opts?.categoryId != null ? { categoryId: opts.categoryId as CategoryId } : {},
      );
      return results.map((r) =>
        r.kind === "page"
          ? { kind: r.kind, id: r.id, matchedField: r.matchedField, title: r.title }
          : r.kind === "category"
            ? { kind: r.kind, id: r.id, matchedField: r.matchedField, name: r.name }
            : {
                kind: r.kind,
                id: r.id,
                matchedField: r.matchedField,
                sourceId: r.sourceId,
                anchorText: r.anchorText,
                comment: r.comment,
              },
      );
    },
    neighborhood(pageId) {
      const n = wb.neighborhood(pageId as PageId);
      return { pageIds: [...n.pageIds], relationshipIds: [...n.relationshipIds] };
    },
    async addPageToCategory(categoryId, pageId) {
      await wb.addPageToCategory(categoryId as CategoryId, pageId as PageId);
      bump();
    },
    sceneGeometry() {
      const scene = buildScene(graphToSceneInput(wb), {});
      return {
        nodes: scene.nodes.map((n) => ({ pageId: n.pageId, x: n.x, y: n.y })),
        hubs: scene.hubs.map((h) => ({
          relationshipId: h.relationshipId,
          kind: h.kind,
          endpointCount: h.endpointCount,
          center: { x: h.center.x, y: h.center.y },
          endpoints: h.endpoints.map((p) => ({ x: p.x, y: p.y })),
        })),
        squircles: scene.squircles.map((s) => ({
          categoryId: s.categoryId,
          bounds: {
            cx: s.bounds.cx,
            cy: s.bounds.cy,
            rx: s.bounds.rx,
            ry: s.bounds.ry,
          },
        })),
        categoryLinks: scene.categoryLinks.map((c) => ({
          fromCategoryId: c.fromCategoryId,
          toCategoryId: c.toCategoryId,
          linkKind: c.linkKind,
          from: { x: c.from.x, y: c.from.y },
          to: { x: c.to.x, y: c.to.y },
        })),
      };
    },
    squircleContainsPoint(categoryId, x, y) {
      const scene = buildScene(graphToSceneInput(wb), {});
      const sq = scene.squircles.find((s) => s.categoryId === categoryId);
      if (!sq) return false;
      return squircleContains(sq.bounds, { x, y });
    },
    is3DUnlocked() {
      return wb.is3DUnlocked();
    },
    active3D() {
      return wb.active3D();
    },
    async setActive3D(on) {
      await wb.setActive3D(on);
      bump();
    },
    webglAvailable() {
      return isWebGLAvailable();
    },
    nodePlaceholderFor(sourceId) {
      return wb.nodePlaceholderFor(sourceId);
    },
    openUnconnectedPlaceholders() {
      return wb
        .snapshot()
        .openSourceIds.filter((id) => !wb.sourceIsConnected(id))
        .map((id) => wb.nodePlaceholderFor(id));
    },
    categoryMasterPageId(categoryId) {
      return wb.categoryMasterPageId(categoryId as CategoryId);
    },
    async getOrCreateCategoryMasterPage(categoryId) {
      const id = await wb.getOrCreateCategoryMasterPage(categoryId as CategoryId);
      bump();
      return id;
    },
    async connectCategoryBoundaries(fromCategoryId, toCategoryId) {
      const id = await wb.connectCategoryBoundaries(
        fromCategoryId as CategoryId,
        toCategoryId as CategoryId,
      );
      bump();
      return id;
    },
    async createCategory(name, colorCode) {
      const category = await wb.createCategory(name, colorCode);
      bump();
      return category.id;
    },
    async createRelationship(endpointPageIds, kind, label) {
      const rel = await wb.createRelationship(
        endpointPageIds as PageId[],
        (kind as RelationshipKind | undefined) ?? "relates",
        label ?? "",
      );
      bump();
      return rel.id;
    },
    async hideNode(pageId) {
      await wb.hideNode(pageId as PageId);
      bump();
    },
    async hideRelationship(relationshipId) {
      await wb.hideRelationship(relationshipId as RelationshipId);
      bump();
    },
    async exportBackup(options) {
      const { bytes, manifest } = await wb.exportBackup(options ?? {});
      lastExportBytes = bytes;
      return {
        omissions: [...(manifest.omissions ?? [])],
        backupMode: manifest.backupMode ?? "full",
        byteLength: bytes.byteLength,
      };
    },
    async stageLastExport() {
      if (!lastExportBytes) {
        return { outcome: "hard-reject", findings: [], reason: "no prior export" };
      }
      const staged = await wb.stageImport(lastExportBytes);
      return serializeStaged(staged);
    },
    async stageImport(bundle) {
      const input = typeof bundle === "string" ? bundle : Uint8Array.from(bundle);
      const staged = await wb.stageImport(input);
      return serializeStaged(staged);
    },
    stagedImportState() {
      const staged = wb.stagedImportState();
      return staged ? serializeStaged(staged) : null;
    },
    async commitStagedImport(opts) {
      const result = await wb.commitStagedImport(opts ?? {});
      bump();
      return { committed: result.committed, reason: result.reason ?? null };
    },
    async offloadSourceBinary(sourceId) {
      await wb.offloadSourceBinary(sourceId as SourceId);
      bump();
    },
    async attachSourceBinary(sourceId, bytes) {
      const result = await wb.attachSourceBinary(sourceId as SourceId, Uint8Array.from(bytes));
      bump();
      return { attached: result.attached, reason: result.reason ?? null };
    },
    sourceBinaryStatus(sourceId) {
      return wb.sourceBinaryStatus(sourceId as SourceId);
    },
    async readSourceBytes(sourceId) {
      const bytes = await wb.readSourceBytes(sourceId as SourceId);
      return bytes ? Array.from(bytes) : null;
    },
    async deleteAnnotationOnly(annotationId) {
      await wb.deleteAnnotationOnly(annotationId as AnnotationId);
      bump();
    },
    async deleteAnnotationAndQuotes(annotationId) {
      await wb.deleteAnnotationAndQuotes(annotationId as AnnotationId);
      bump();
    },
    forceNextSaveFailures(count) {
      wb.forceNextSaveFailures(count);
    },
    async forceSourceVersionDrift(sourceId) {
      await wb.forceSourceVersionDrift(sourceId as SourceId);
      bump();
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
    async flushPendingRevision() {
      await wb.flushPendingRevision();
      bump();
    },
    revisions() {
      return wb.revisions().map((r) => ({
        id: r.id,
        kind: r.kind ?? "other",
        label: r.label,
        summary: r.summary ?? "",
        createdAt: r.createdAt,
        dateKey: r.dateKey ?? Workbench.dateKeyOf(r.createdAt),
        affectedObjectIds: [...(r.affectedObjectIds ?? [])],
      }));
    },
    checkpoints() {
      return wb.checkpoints().map((c) => ({
        id: c.id,
        revisionIndex: c.revisionIndex,
        afterRevisionId: c.afterRevisionId,
        createdAt: c.createdAt,
      }));
    },
    reconstructRevisionState(revId) {
      const result = wb.reconstructRevisionState(revId);
      if (result.status === "ok") {
        return { status: result.status, missingIds: [], hasState: result.state != null };
      }
      return {
        status: result.status,
        missingIds: [...result.missingIds],
        hasState: result.fallbackState != null,
      };
    },
    async restoreRevision(revId) {
      const rev = await wb.restoreRevision(revId);
      bump();
      return rev ? rev.id : null;
    },
    measureHistoryOverhead() {
      const o = wb.measureHistoryOverhead();
      return {
        revisionCount: o.revisionCount,
        checkpointCount: o.checkpointCount,
        deltaBytes: o.deltaBytes,
        checkpointBytes: o.checkpointBytes,
        replayDurationMs: o.replayDurationMs,
      };
    },
    async createReflection(input) {
      const entry = await wb.createReflection({
        text: input.text,
        linkedRevisionIds: input.linkedRevisionIds,
      });
      bump();
      return {
        id: entry.id,
        text: entry.text,
        linkedRevisionIds: [...entry.linkedRevisionIds],
        startDateKey: entry.startDateKey,
        endDateKey: entry.endDateKey,
      };
    },
    async addRevisionComment(revId, text) {
      await wb.addRevisionComment(revId, text);
      bump();
    },
    async importZoteroBundle(json) {
      const summary = await wb.importZoteroBundle(json);
      bump();
      return {
        sourcesAdded: summary.sourcesAdded,
        sourcesUpdated: summary.sourcesUpdated,
        annotationsAdded: summary.annotationsAdded,
        annotationsUpdated: summary.annotationsUpdated,
      };
    },
    async importWebsiteSource(input) {
      const source = await wb.importWebsiteSource({
        url: input.url,
        snapshot: Uint8Array.from(input.snapshot),
        ...(input.title != null ? { title: input.title } : {}),
        ...(input.category != null ? { category: input.category } : {}),
      });
      bump();
      return {
        sourceId: source.id,
        kind: source.kind,
        availabilityStatus: source.availabilityStatus ?? null,
      };
    },
    async commitAreaAnnotation(sourceId, pageIndex, rect, comment, imageDataUrl) {
      const view = await wb.commitAreaAnnotation(
        sourceId as SourceId,
        pageIndex,
        rect,
        comment,
        imageDataUrl,
      );
      bump();
      return view.annotation.id;
    },
    async setDragOffset(pageId, offset) {
      await wb.setDragOffset(pageId as PageId, offset.dx, offset.dy);
      bump();
    },
    async publishToRemote() {
      // Clear any prior corrupt-fault flag before a real publish round-trip.
      internalRemote.corrupt = false;
      const status = await wb.publishToRemote(koofrAdapter());
      bump();
      return serializeSync(status);
    },
    async refreshFromRemote(opts) {
      internalRemote.corrupt = Boolean(opts?.corrupt);
      const status = await wb.refreshFromRemote(koofrAdapter());
      internalRemote.corrupt = false;
      bump();
      return serializeSync(status);
    },
    syncStatus() {
      return serializeSync(wb.syncStatus());
    },
    async createMobileCapture(input) {
      const capture = await wb.createMobileCapture({
        content: input.content,
        ...(input.sourceId != null ? { sourceId: input.sourceId as SourceId } : {}),
        ...(input.targetPageId != null ? { targetPageId: input.targetPageId as PageId } : {}),
        ...(input.originDevice != null ? { originDevice: input.originDevice } : {}),
        ...(input.queueForUpload != null ? { queueForUpload: input.queueForUpload } : {}),
      });
      bump();
      return capture.id as string;
    },
    async uploadPendingCaptures() {
      const results = await wb.uploadPendingCaptures(koofrAdapter());
      bump();
      return results.map((r) => ({
        captureId: r.captureId,
        status: r.status,
        ...(r.error != null ? { error: r.error } : {}),
      }));
    },
    async pullRemoteCaptures() {
      const pulled = await wb.pullRemoteCaptures(koofrAdapter());
      bump();
      return pulled;
    },
    async handleCapture(captureId, action) {
      const handling = await wb.handleCapture(captureId as CaptureId, action);
      bump();
      return handling ? handling.disposition : null;
    },
    captures() {
      return wb.rawData().captures.map((c) => ({
        id: c.id as string,
        content: c.text,
        text: c.text,
        status: c.status ?? "local",
        sourceId: (c.sourceId as string | null) ?? null,
        targetPageId: (c.targetPageId as string | undefined) ?? null,
      }));
    },
  };

  (window as unknown as { __ito: ItoTestApi }).__ito = api;
  document.body.setAttribute("data-ito-ready", "true");
}
