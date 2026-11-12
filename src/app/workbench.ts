/**
 * Headless workbench domain logic for the M1 reading workbench (FEAT-003,
 * spec section 6). This module owns ALL state transitions for the library and
 * reader: importing sources, opening documents (single + "open together"),
 * creating highlight/underline/range annotations, editing quiet comments,
 * associating annotations with subjects, and persisting everything through the
 * StorageAdapter.
 *
 * It is deliberately DOM-free and framework-free so it is unit-testable and so
 * the React layer and the Playwright harness drive the exact same transitions.
 * The one invariant that matters most lives here (and is asserted in tests):
 * making annotations NEVER creates a Page / Relationship / Category record and
 * never triggers synthesis.
 */

import {
  DEFAULT_CATEGORY_COLOR,
  createEmptyBrainData,
  deriveSubjectReferenceStatus,
  deriveSubjectReferences,
  migrateBrainData,
  newAnnotationId,
  newAssetId,
  newCaptureId,
  newCategoryId,
  newEvidenceInstanceId,
  newCheckpointId,
  newPageId,
  newReflectionId,
  newRelationshipId,
  newRevisionId,
  newSourceId,
  newSubjectAssociationId,
  relationshipEndpoints,
  type Annotation,
  type AnnotationId,
  type AnnotationScope,
  type AnnotationStyleRecord,
  type AnchorResolution,
  type AreaAnchor,
  type ChemicalMechanismSpec,
  type PreParsedPageLayout,
  type AssetIndexEntry,
  type BrainData,
  type BrainId,
  type BrainManifest,
  type Capture,
  type CaptureHandling,
  type CaptureId,
  type Category,
  type CategoryId,
  type Checkpoint,
  type EvidenceInstance,
  type NormalizedRect,
  type Page,
  type PageId,
  type ReflectionEntry,
  type Relationship,
  type RelationshipId,
  type RelationshipKind,
  type Revision,
  type RevisionId,
  type RevisionKind,
  type ScopeAnchor,
  type Source,
  type SourceId,
  type SubjectAssociation,
  type SubjectReference,
  type SubjectReferenceStatus,
  type TextAnchor,
} from "../model";
import {
  computeByteHash,
  computeTextShingles,
  extractCanonicalId,
  extractDocStem,
  matchExistingSource,
  parseDocStem,
} from "../pdf/fingerprint";
import {
  computeDocumentId,
  computeSourceFingerprint,
  createManifest,
  createIngestionController,
  openWithCache,
  validateCache,
  type DocumentIdentityInput,
  type IngestionController,
  type IngestionProgress,
  type PageAnalyzer,
  type PdfPageAnalysis,
} from "../pdf";
import {
  deriveHubBlendColor,
  neighborhood as computeNeighborhood,
  pointInSubjectBasin,
  resolveBasin,
  search as runSearch,
  type SearchEdge,
  type SearchIndex,
  type SearchOptions,
  type SearchResult,
} from "../network";
import {
  appendEvidence,
  collectEvidence,
  compositionStats,
  findEvidencePos,
  hydrateState,
  insertBridgingNoteAt,
  insertEvidenceAt,
  moveBlock,
  plainText,
  removeEvidenceNode,
  serializeState,
  type CompositionStats,
  type DocumentJson,
  type EvidenceAttrs,
} from "../editor";
import {
  exportBundleZip,
  exportCoreBrainJson,
  ingestPdfBinaries,
  resolveBackupOptions,
  stageImport as stageImportCodec,
  commitStagedImport as commitStagedImportCodec,
  sha256Hex,
  strToU8,
  parseZoteroBundle,
  KoofrStorageAdapter,
  IndexedDbPdfAnalysisStore,
  type BackupOptions,
  type IngestOptions,
  type RemotePointer,
  type StagedImport,
  type StorageAdapter,
  type PdfAnalysisStore,
} from "../storage";

/** An empty subject-page composition: one empty paragraph (never null). */
function emptyDocJson(): DocumentJson {
  return { type: "doc", content: [{ type: "paragraph" }] };
}

/**
 * M12 (FEAT-001) normalize a quote / page text for re-anchoring comparison:
 * lowercase and collapse all whitespace (incl. newlines) to single spaces, then
 * trim. DOM-independent and deterministic so a highlight's stored quote matches
 * the freshly extracted page text regardless of line-wrap/zoom differences.
 */
function normalizeForMatch(text: string): string {
  return (text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Append the capture's text as a new paragraph to a subject page's document
 * JSON (M5, §16.3). Pure + DOM-free: it only adds a paragraph node to the doc's
 * content array, never rewriting existing composition. A missing/empty content
 * array is coerced to a valid single-paragraph doc first.
 */
function appendParagraphToDoc(documentJson: unknown, text: string): DocumentJson {
  const base =
    documentJson && typeof documentJson === "object"
      ? (structuredClone(documentJson) as DocumentJson)
      : emptyDocJson();
  const content = Array.isArray(base.content) ? [...base.content] : [];
  const trimmed = text.trim();
  const paragraph =
    trimmed.length > 0
      ? { type: "paragraph", content: [{ type: "text", text }] }
      : { type: "paragraph" };
  content.push(paragraph);
  return { type: "doc", content };
}

/** Derive a short subject-page title from a capture's text (M5, create-subject). */
function deriveCaptureTitle(text: string): string {
  const firstLine = text.split(/\r?\n/)[0]?.trim() ?? "";
  const cleaned = firstLine.length > 0 ? firstLine : "Captured thought";
  return cleaned.length > 80 ? `${cleaned.slice(0, 77)}...` : cleaned;
}

/**
 * Sanitize a website snapshot's bytes at import time (A15, D11). Decodes as
 * UTF-8, strips script/style blocks, inline event handlers, and javascript:
 * URLs, then re-encodes. Pure + DOM-free so it runs in the headless workbench.
 */
function sanitizeSnapshotBytes(bytes: Uint8Array): Uint8Array {
  const html = new TextDecoder().decode(bytes);
  const clean = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/javascript:/gi, "");
  return new TextEncoder().encode(clean);
}

/**
 * The quoted-text snapshot for an annotation, used when citing it into a
 * subject page. Text annotations quote their selection; range annotations
 * quote their pp. label; M6 (D01) area annotations quote the comment or a
 * default "Area on p. N" label (the box has no selectable text).
 */
function quotedTextForScope(annotation: Annotation): string {
  switch (annotation.scope.kind) {
    case "text":
      return annotation.scope.anchor.selectedText;
    case "pages":
      return `pp. ${annotation.scope.anchor.startPageIndex + 1}-${
        annotation.scope.anchor.endPageIndex + 1
      }`;
    case "area":
      return (
        annotation.comment || `Area on p. ${annotation.scope.anchor.pageIndex + 1}`
      );
  }
}

/**
 * UTF-8 byte length of a string (M7 H07 overhead measurement). Uses TextEncoder
 * when available (browser + Node 22) and falls back to a UTF-8 code-unit count
 * so the measurement works in any runtime the tests use.
 */
function utf8ByteLength(s: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s).length;
  let bytes = 0;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** The highlight style an annotation is committed with. */
export type HighlightStyle = "highlight" | "underline";

/** The available highlight colors (compact selection controls only). */
export const HIGHLIGHT_COLORS = ["yellow", "green", "blue", "pink"] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];

/**
 * Presentation attributes for an annotation. These live OUTSIDE the model's
 * Annotation (which stays the pure section-20 contract) in
 * `PresentationState.annotationStyles`, keyed by annotation id, so save/reopen
 * restores them without polluting `BrainData.captures`. See `AnnotationView`.
 */
export interface AnnotationStyle {
  readonly kind: HighlightStyle;
  readonly color: HighlightColor;
}

/** Default style applied when a selection is committed with no explicit color. */
export const DEFAULT_STYLE: AnnotationStyle = { kind: "highlight", color: "yellow" };

/**
 * M7 (H01) idle window for coalescing same-Page prose typing into a single
 * Revision. Edits to the SAME page within this window fold into one buffered
 * revision; a different page, a structural action, or an explicit
 * `flushPendingRevision()` commits the buffer first. Deterministic in tests:
 * `recordProseEdit` compares `createdAt` timestamps against this window rather
 * than relying on a wall-clock timer so a test can advance "time" by passing an
 * explicit `now`.
 */
export const COALESCE_WINDOW_MS = 2000;

/**
 * M7 (H06) number of revisions between automatic Checkpoints. A validated
 * Checkpoint is written whenever the revision count crosses a multiple of this.
 */
export const CHECKPOINT_INTERVAL = 20;

/** A buffered, not-yet-committed coalesced prose-edit revision (H01). */
interface PendingProseRevision {
  readonly pageId: PageId;
  readonly beforeDocumentJson: unknown;
  afterDocumentJson: unknown;
  readonly firstEditAt: string;
  lastEditAt: string;
}

/** Input to `createReflection` (H04, D14). */
export interface ReflectionInput {
  readonly text: string;
  readonly linkedRevisionIds: readonly string[];
}

/** Shape returned by `measureHistoryOverhead` (H07). */
export interface HistoryOverhead {
  readonly revisionCount: number;
  readonly checkpointCount: number;
  readonly deltaBytes: number;
  readonly checkpointBytes: number;
  readonly replayDurationMs: number;
}

/**
 * Result of `reconstructRevisionState` (H05). On a complete delta chain it
 * returns the reconstructed structured state; when the chain is broken it
 * returns an explicit `missing-segment` result carrying the ids it could not
 * replay and the best-effort fallback state it could still assemble.
 */
export type ReconstructResult =
  | { readonly status: "ok"; readonly state: unknown }
  | {
      readonly status: "missing-segment";
      readonly missingIds: readonly string[];
      readonly fallbackState: unknown;
    };

/**
 * Legacy M1 sentinel tag (read-only migration). M1 smuggled annotation styles
 * into `BrainData.captures` via a reserved Capture whose `sourceId` was null and
 * whose `text` started with this tag. M2.5 (ADR-0010) moves styles into
 * `PresentationState.annotationStyles`; this constant exists ONLY so the one-time
 * load migration can detect and strip such legacy records. It is NEVER written.
 */
const LEGACY_STYLE_CAPTURE_TAG = "\u0000ito:annotation-styles\u0000";

/**
 * Parse the legacy sentinel Capture's style payload into plain
 * {id -> AnnotationStyle} entries (read-only migration helper). Returns an empty
 * object when there is no sentinel or the payload is corrupt (non-fatal).
 */
function parseLegacyStyleCapture(data: BrainData): Record<string, AnnotationStyle> {
  const cap = data.captures.find(
    (c) => c.sourceId === null && c.text.startsWith(LEGACY_STYLE_CAPTURE_TAG),
  );
  if (!cap) return {};
  try {
    const json = cap.text.slice(LEGACY_STYLE_CAPTURE_TAG.length);
    const parsed = JSON.parse(json) as Record<string, AnnotationStyle>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * A denormalized reader-side view of an annotation: the model Annotation plus
 * the workbench-owned presentation style and derived per-destination states.
 */
export interface AnnotationView {
  readonly annotation: Annotation;
  readonly style: AnnotationStyle;
  /** True when the annotation spans a continuous page range (pp. X-Y). */
  readonly isRange: boolean;
  /** Human label for a range annotation, e.g. "pp. 1-3"; null for text. */
  readonly rangeLabel: string | null;
  /** Derived (annotation, destination) references with live status. */
  readonly references: readonly SubjectReference[];
}

/** A persisted save failure: retains the draft so it is never lost (R12). */
export interface SaveError {
  readonly message: string;
  readonly atISO: string;
}

/**
 * Per-pane width weights for the integrated workspace (spec section 8.2). These
 * are PRESENTATION-ONLY view state (pane configuration) that context-preserving
 * transitions must carry across layout changes (R19, N08). They are flex-grow
 * weights, so only their RATIO matters, not absolute pixels — which keeps them
 * independent of zoom and window size. Keyed by a pane slot id (source id for a
 * reader pane, the literal "subject" for the subject-page pane).
 */
export type PaneWidths = Readonly<Record<string, number>>;

/**
 * The integrated-workspace layout configuration the Reader renders from and
 * that transitions must preserve (spec sections 7.3, 8.2, R19). Pane widths and
 * the passage-to-evidence line visibility are presentation-only: changing them
 * never touches durable records, and the line toggle in particular NEVER
 * deletes a relationship (A08/R08 foundation).
 */
export interface WorkspaceLayout {
  /** Flex-grow weights per pane slot id; absent slots default to weight 1. */
  readonly paneWidths: PaneWidths;
  /** Whether passage-to-evidence lines are drawn. Presentation only (A08). */
  readonly linesVisible: boolean;
}

/** The default workspace layout: equal panes, lines visible. */
export const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayout = {
  paneWidths: {},
  linesVisible: true,
};

/**
 * A single passage-to-evidence line relating a source pane to a composed quote
 * in the subject page (spec section 10.2). This is pure DATA — the geometry
 * (routing, margins) is computed in the view from live DOM; here we only relate
 * a source + page + evidence + anchor page index. Toggling visibility changes
 * only whether the view draws these; it never removes them from this set.
 */
export interface PassageEvidenceLine {
  readonly evidenceId: string;
  readonly annotationId: AnnotationId;
  readonly sourceId: SourceId;
  readonly destinationPageId: PageId;
  /** 0-based page index of the source passage the quote came from. */
  readonly sourcePageIndex: number;
  readonly quotedText: string;
}

/**
 * The top-level app view (spec §3.3): the category-organized Files library vs
 * the Nodes concept-network canvas. This is SESSION VIEW STATE (relates D19) —
 * preserved across in-session transitions, writing NO durable record.
 */
export type ViewMode = "files" | "nodes" | "history" | "captures";

/**
 * M4 (§15, A20) remote-sync status surfaced to the UI banner. `publishing`
 * while a publish is in flight, `up-to-date` once a publish/refresh succeeds,
 * `offline`/`stale` on a failure (with a human-readable `reason`).
 * `lastSyncedRevision` is the publicationRevision last known to be live on the
 * remote (null before any successful sync).
 */
export interface SyncStatus {
  readonly state: "stale" | "up-to-date" | "offline" | "publishing";
  readonly lastSyncedRevision: number | null;
  readonly reason?: string;
}

/**
 * M5 (§16.2) input to createMobileCapture. A capture is a loose thought/quote;
 * creating one NEVER creates a Page/Category/Relationship (A23).
 */
export interface MobileCaptureInput {
  readonly content: string;
  readonly sourceId?: SourceId;
  readonly anchor?: TextAnchor | ScopeAnchor | AreaAnchor;
  readonly targetPageId?: PageId;
  readonly originDevice?: string;
  /** When true, the capture is saved as `pending` (queued for upload). */
  readonly queueForUpload?: boolean;
}

/** M5 (§16.3) the disposition the desktop reviewer chose for a capture. */
export type CaptureAction = "insert-into-page" | "create-subject" | "dismiss";

/** Immutable snapshot of workbench state the UI renders from. */
export interface WorkbenchState {
  readonly brainId: BrainId;
  readonly sources: readonly Source[];
  readonly pages: readonly Page[];
  /** Source ids currently open in the reading workspace (1 = single, 2+ = together). */
  readonly openSourceIds: readonly SourceId[];
  /**
   * The subject page currently open for composition, if any. A subject page can
   * be open ALONGSIDE the reader (source-return never replaces it). null = no
   * subject page open.
   */
  readonly openSubjectPageId: PageId | null;
  /** Whether the highlights tab (sidebar) is open; closed reserves ZERO width. */
  readonly highlightsTabOpen: boolean;
  /** Global suppress-motion setting (in-app, independent of OS media query). */
  readonly suppressMotion: boolean;
  /** Whether the Nodes (concept-network) view is active (transient, FEAT-004). */
  readonly nodesViewActive: boolean;
  /**
   * The top-level Files/Nodes view (§3.3). Session view state; default 'files'.
   * This is the formal FEAT-005 switch that supersedes the transient
   * `nodesViewActive` flag (which now derives from it).
   */
  readonly viewMode: ViewMode;
  /**
   * The explicit Nodes-view locate target (N04/N05). Session view state, NOT
   * persisted; set ONLY by explicit locate actions, never by editing (A09-M2).
   */
  readonly focusedPageId: PageId | null;
  /** The integrated-workspace layout (pane widths + line visibility). */
  readonly workspaceLayout: WorkspaceLayout;
  /**
   * The active library category scope (a category name) or null for "all".
   * This is a reader/library VIEW filter that context-preserving transitions
   * must carry between Library, Reader and workspace layouts (N03, N08) — it
   * never changes durable records.
   */
  readonly categoryScope: string | null;
  /** Last save failure, if any; cleared on the next successful save. */
  readonly saveError: SaveError | null;
  /**
   * M13 (§2.2, FEAT-003) which KIND of page the open subject page is, so the
   * Reader/SubjectEditor render the right surface + aspect bar:
   *   - "subject-basin"        — a Subject's overarching Subject Page (P4).
   *   - "subject-intersection" — the unified A∩B∩… overlap page (P3).
   *   - "node-intersection"    — a relationship/hub's Connecting Page (P2).
   *   - "node"                 — an ordinary Observation Node / subject page.
   *   - null                   — no subject page is open.
   * Additive/derived: computed from the open page id + the durable records, so
   * it never adds durable state. See {@link openPageKind}.
   */
  readonly openPageKind: OpenPageKind | null;
  /**
   * M13 (§2.2) the data the Intersection Aspect Selector Bar renders when a
   * subject-intersection page is open, else null. See {@link intersectionAspects}.
   */
  readonly intersectionAspects: IntersectionAspects | null;
}

/** M13 (§2.2) the kind of the open subject page, driving the workspace surface. */
export type OpenPageKind =
  | "subject-basin"
  | "subject-intersection"
  | "node-intersection"
  | "node";

/** M13 (§2.2) one Subject (category) involved in an overlap, with a display name. */
export interface IntersectionSubject {
  readonly categoryId: CategoryId;
  readonly name: string;
}

/** M13 (§2.2) a pill in the Intersection Aspect Selector Bar (core or pairwise). */
export interface IntersectionAspectPill {
  /** The subject ids this aspect spans (sorted); length N for core, 2 pairwise. */
  readonly subjectIds: readonly CategoryId[];
  /** The human label, e.g. "A ∩ B ∩ C" (core) or "A ∩ B" (pairwise). */
  readonly label: string;
  /** "core" = the full overlap; "pairwise" = a 2-subject sub-overlap. */
  readonly kind: "core" | "pairwise";
}

/**
 * M13 (§2.2) the full aspect-bar data for an open Subject-intersection page:
 * the participating Subjects, the CORE pill (A∩B∩C…), each PAIRWISE pill
 * (A∩B, B∩C, A∩C…), the relationship-kind selector value, and the LIVE list of
 * Observation Nodes currently sitting inside the overlap (computed via
 * pointInSubjectBasin over node positions).
 */
export interface IntersectionAspects {
  readonly subjects: readonly IntersectionSubject[];
  readonly corePill: IntersectionAspectPill;
  readonly pairwisePills: readonly IntersectionAspectPill[];
  /** UI-local relationship-kind selector value (not the model RelationshipKind). */
  readonly relationshipKind: IntersectionRelationshipKind;
  /** The Observation Nodes (subject pages) currently inside the overlap. */
  readonly nodesInside: readonly { readonly pageId: PageId; readonly title: string }[];
}

/**
 * M13 (§2.2) the aspect bar's relationship-kind selector values. These are a
 * UI-local vocabulary distinct from the model's `RelationshipKind` — the
 * handoff specifies `relates`/`bridges`/`contrasts`/`synthesizes` for how two
 * Subjects relate at their intersection.
 */
export type IntersectionRelationshipKind =
  | "relates"
  | "bridges"
  | "contrasts"
  | "synthesizes";

/** The ordered aspect-bar relationship-kind options (single source of truth). */
export const INTERSECTION_RELATIONSHIP_KINDS: readonly IntersectionRelationshipKind[] = [
  "relates",
  "bridges",
  "contrasts",
  "synthesizes",
];

/**
 * The node-count threshold at which the §3.4 density reward (3D presentation)
 * unlocks. A named constant so the rule has ONE source of truth and the test
 * asserts the exact boundary.
 */
export const THREE_D_UNLOCK_THRESHOLD = 35;

/** A node in the derived concept-network graph (a page + its view state). */
export interface ConceptNode {
  readonly pageId: PageId;
  readonly title: string;
  readonly kind: Page["kind"];
  /** True when the node is presentation-hidden (still a durable record). */
  readonly hidden: boolean;
  /** 2D canvas position if one has been laid out/dragged, else null. */
  readonly position: { readonly x: number; readonly y: number } | null;
  /**
   * M13 FEAT-001 — the node's maturity tier. A node promoted from a single
   * highlight/note (one cited evidence, no extra synthesis prose) is a
   * "memory" (rendered hollow). A full Observation Node (2+ cited evidence
   * instances, or added synthesis prose) is an "observation" (rendered
   * filled). Non-ordinary subject pages (basins, intersections, masters)
   * always default to "observation".
   */
  readonly nodeTier: "memory" | "observation";
  /** True iff `nodeTier === "memory"` — a convenience flag for renderers. */
  readonly isPromotedMemory?: boolean;
}

/** A link in the derived graph = one Relationship with its normalized endpoints. */
export interface ConceptLink {
  readonly relationshipId: RelationshipId;
  readonly endpointPageIds: readonly PageId[];
  readonly kind: RelationshipKind;
  readonly label: string;
  /** Lens for N=2, star for N>=3 (A13-M2). */
  readonly topology: "lens" | "star";
  /** Derived watercolor-multiply blend of endpoint category colors. */
  readonly blendColor: string;
  readonly hidden: boolean;
}

/** A category in the derived graph with its color + members. */
export interface ConceptCategory {
  readonly categoryId: CategoryId;
  readonly name: string;
  readonly colorCode: string;
  readonly memberPageIds: readonly PageId[];
  /**
   * The category's master page id (A14-M2), if one has been created via
   * `getOrCreateCategoryMasterPage`. Feeds the scene mapper so an explicit
   * master-page -> master-page relationship renders a 'master' category link.
   */
  readonly masterPageId?: PageId;
  /**
   * M13 (§2.1(2)) the Subject's explicit watercolour BASIN geometry, if set.
   * Threaded into `SceneGraphInput`/`buildScene` so a Subject's basin (and the
   * deterministic default for an empty Subject) renders a visible wash on the
   * canvas. Optional/additive.
   */
  readonly basin?: {
    readonly x: number;
    readonly y: number;
    readonly rx: number;
    readonly ry: number;
  };
  /**
   * M13 (§2.1(2)) id of the Subject's overarching Subject Page, if one has been
   * created via `getOrCreateSubjectBasinPage`. Distinct from `masterPageId`.
   */
  readonly subjectPageId?: PageId;
}

/** The full derived concept-network graph the view renders from. */
export interface ConceptGraph {
  readonly nodes: readonly ConceptNode[];
  readonly links: readonly ConceptLink[];
  readonly categories: readonly ConceptCategory[];
}

/**
 * A TRANSIENT "Not connected yet" placeholder for a source node (N06). It is
 * ephemeral: produced on demand, it creates NO Page/Relationship/Category and
 * persists NOTHING. `transient: true` marks it so the view never mistakes it
 * for a durable record.
 */
export interface NodePlaceholder {
  readonly sourceId: string;
  readonly title: string;
  readonly transient: true;
}

/** Inputs for committing a text-level highlight/underline annotation. */
export interface CommitTextAnnotationInput {
  readonly sourceId: SourceId;
  readonly anchor: TextAnchor;
  readonly style?: AnnotationStyle;
}

/** Inputs for a continuous page-range annotation. */
export interface CommitRangeAnnotationInput {
  readonly sourceId: SourceId;
  readonly startPageIndex: number;
  readonly endPageIndex: number;
  readonly style?: AnnotationStyle;
}

/**
 * The Workbench holds a live BrainData, a StorageAdapter, and derives views.
 * All mutating methods persist through the adapter and keep the in-memory copy
 * in sync. Persistence failures are surfaced (never swallowed) and the draft
 * state is retained so nothing is lost.
 */
export class Workbench {
  private data: BrainData;
  private openSourceIds: SourceId[] = [];
  private openSubjectPageId: PageId | null = null;
  /**
   * M13 (§2.2, FEAT-003) the aspect-bar relationship-kind selector value chosen
   * per Subject-intersection page, keyed by page id. Transient UI-local session
   * state (like view state): it writes NO durable record and defaults to
   * "relates" for an intersection page with no explicit choice yet.
   */
  private intersectionRelationshipKinds = new Map<PageId, IntersectionRelationshipKind>();
  private highlightsTabOpen = false;
  private suppressMotion = false;
  private view: ViewMode = "files";
  /**
   * The explicit "locate" camera-focus target in the Nodes view (N04/N05,
   * FEAT-004). TRANSIENT session view state (like `view`): it is NOT persisted
   * and only an explicit locate action ("Show in Nodes" / the destination
   * picker) ever sets it. Ordinary editing transitions MUST NEVER touch it so
   * the camera never jumps during normal editing (A09-M2). null = no target.
   */
  private focusedPage: PageId | null = null;
  private workspaceLayout: WorkspaceLayout = DEFAULT_WORKSPACE_LAYOUT;
  private activeCategoryScope: string | null = null;
  private saveError: SaveError | null = null;
  /**
   * Test-only: when > 0, the next N persist() calls throw AFTER applying the
   * in-memory change, exercising the real draft-retention + error path (R12)
   * without needing to corrupt IndexedDB. Set via `failNextSaves`.
   */
  private failNextSaves = 0;
  /**
   * Tail of the serialized save chain. Every persist() appends to this so
   * writes never resolve out of order and a slow write cannot clobber a newer
   * one. See persist() for the race it defends against.
   */
  private saveQueue: Promise<void> = Promise.resolve();
  /**
   * Live-editor doc providers keyed by subject page id. When a subject page is
   * open in the ProseMirror editor, the editor registers a getter here via
   * attachLiveDoc so external mutations (insert evidence / move block) fold the
   * editor's newest unsaved doc into stored documentJson first, instead of
   * operating on a stale persisted snapshot and wiping unsaved text.
   */
  private liveDocs = new Map<PageId, () => DocumentJson>();
  /**
   * Asset ids whose PDF binary is currently OFFLOADED locally (A17). Kept as a
   * sync-readable cache so `resolveEvidenceSource` (and the node map / search,
   * which read records, not bytes) stay synchronous. It is populated by
   * `offloadSourceBinary`, cleared by `attachSourceBinary`, and rebuilt from
   * the adapter at `open()` so offloaded status survives a reopen.
   */
  private offloadedAssetIds = new Set<string>();
  /** See enableAutoHistory(). */
  private autoHistory = false;
  /**
   * The in-memory staged import held between `stageImport` and
   * `commitStagedImport` (A19). NEVER mutates the live store; it is a parsed +
   * validated candidate the UI can inspect (staging report) and either commit
   * via 'Try Import Anyway' or discard. null = nothing staged.
   */
  private stagedImport: StagedImport | null = null;
  /**
   * M7 (H01) the buffered, not-yet-committed coalesced prose-edit revision.
   * Same-page prose typing within COALESCE_WINDOW_MS folds into this buffer;
   * `flushPendingRevision()` commits it. null = nothing buffered.
   */
  private pendingProse: PendingProseRevision | null = null;

  /**
   * M4 (§15, A20) backing fields for syncStatus(). Updated by publishToRemote /
   * refreshFromRemote. `lastSyncedRevision` is the publicationRevision last
   * known to be live on the remote; null before any successful sync.
   */
  private syncState: SyncStatus["state"] = "stale";
  private lastSyncedRevision: number | null = null;
  private syncReason: string | undefined = undefined;

  private constructor(
    private readonly storage: StorageAdapter,
    data: BrainData,
    /**
     * M18 (FEAT-PDF-CACHE) the persistent PDF analysis cache store. Optional so
     * existing callers / tests that do not exercise the cache can omit it; a
     * browser caller passes an {@link IndexedDbPdfAnalysisStore}. When absent
     * the cache-driving methods are inert (the Reader falls back to the legacy
     * `Source.cachedPages` path, deliberately left unchanged).
     */
    private readonly pdfAnalysis?: PdfAnalysisStore,
  ) {
    this.data = data;
  }

  /** The persistent PDF analysis cache store, when one was provided (§14). */
  pdfAnalysisStore(): PdfAnalysisStore | undefined {
    return this.pdfAnalysis;
  }

  /** Open an existing brain, or create+persist a new empty one. */
  static async open(
    storage: StorageAdapter,
    brainId?: BrainId,
    pdfAnalysis?: PdfAnalysisStore,
  ): Promise<Workbench> {
    let data: BrainData | null = null;
    let createdFresh = false;
    if (brainId) {
      data = await storage.readBrain(brainId);
    } else {
      const ids = await storage.listBrains();
      // A StrictMode double-mount (or a crashed prior boot) can leave more than
      // one brain in the store. Pick the one most recently updated so the
      // user's work wins, tie-breaking on the highest publicationRevision.
      let best: BrainData | null = null;
      for (const id of ids) {
        const candidate = await storage.readBrain(id);
        if (!candidate) continue;
        if (!best) {
          best = candidate;
          continue;
        }
        const a = candidate.manifest;
        const b = best.manifest;
        const aTime = Date.parse(a.updatedAt);
        const bTime = Date.parse(b.updatedAt);
        if (aTime > bTime || (aTime === bTime && a.publicationRevision > b.publicationRevision)) {
          best = candidate;
        }
      }
      data = best;
    }
    if (!data) {
      data = createEmptyBrainData();
      await storage.writeBrain(data);
      createdFresh = true;
    }
    // M18 (FEAT-PDF-CACHE §14): default the analysis cache to IndexedDB in the
    // browser; leave it undefined under jsdom/Node (no indexedDB global) so the
    // Reader falls back to the legacy cachedPages path and tests stay DOM-free.
    const analysis =
      pdfAnalysis ??
      (typeof indexedDB !== "undefined" ? new IndexedDbPdfAnalysisStore() : undefined);
    const wb = new Workbench(storage, data, analysis);
    // One-time M1 -> M2.5 migration (ADR-0010): strip any legacy sentinel
    // Capture (sourceId===null + tagged style payload) out of BrainData.captures
    // and fold its styles into presentation.annotationStyles. A freshly created
    // brain can never carry the sentinel, so skip the extra persist for it.
    if (!createdFresh) await wb.migrateLegacyStyleCaptures();
    // Rebuild the offloaded-binary cache (A17) so a source whose PDF bytes were
    // evicted in a previous session still resolves as "binary-offloaded".
    await wb.refreshBinaryAvailability();
    return wb;
  }

  /**
   * Probe each source's asset availability and rebuild `offloadedAssetIds` so
   * the sync `sourceBinaryStatus` / `resolveEvidenceSource` paths reflect the
   * true adapter state across a reopen (A17). Pure read; changes no records.
   */
  private async refreshBinaryAvailability(): Promise<void> {
    const offloaded = new Set<string>();
    for (const source of this.data.sources) {
      const bytes = await this.storage.readAsset(
        this.data.manifest.brainId,
        source.assetId,
      );
      if (!bytes) offloaded.add(source.assetId);
    }
    this.offloadedAssetIds = offloaded;
  }

  /**
   * Remove any legacy M1 style-sentinel Capture (sourceId===null + tagged text)
   * from `captures` and migrate its parsed styles into
   * `presentation.annotationStyles` (only for annotation ids not already
   * present). Persists ONCE so the sentinel never reaches an M3 export. A no-op
   * (no persist) when no sentinel record is present.
   */
  private async migrateLegacyStyleCaptures(): Promise<void> {
    const hasSentinel = this.data.captures.some(
      (c) => c.sourceId === null && c.text.startsWith(LEGACY_STYLE_CAPTURE_TAG),
    );
    if (!hasSentinel) return;
    const legacyStyles = parseLegacyStyleCapture(this.data);
    const existing = this.data.presentation.annotationStyles ?? {};
    const merged: Record<string, AnnotationStyleRecord> = { ...existing };
    for (const [id, style] of Object.entries(legacyStyles)) {
      // Only adopt a legacy style for ids not already styled in presentation.
      if (!(id in merged)) merged[id] = { kind: style.kind, color: style.color };
    }
    const cleanedCaptures = this.data.captures.filter(
      (c) => !(c.sourceId === null && c.text.startsWith(LEGACY_STYLE_CAPTURE_TAG)),
    );
    this.data = {
      ...this.data,
      captures: cleanedCaptures,
      presentation: { ...this.data.presentation, annotationStyles: merged },
    };
    await this.persist();
  }

  // -- snapshot -------------------------------------------------------------

  snapshot(): WorkbenchState {
    return {
      brainId: this.data.manifest.brainId,
      sources: this.data.sources,
      pages: this.data.pages,
      openSourceIds: [...this.openSourceIds],
      openSubjectPageId: this.openSubjectPageId,
      highlightsTabOpen: this.highlightsTabOpen,
      suppressMotion: this.suppressMotion,
      nodesViewActive: this.view === "nodes",
      viewMode: this.view,
      focusedPageId: this.focusedPage,
      workspaceLayout: this.workspaceLayout,
      categoryScope: this.activeCategoryScope,
      saveError: this.saveError,
      openPageKind: this.openPageKind(),
      intersectionAspects: this.intersectionAspects(),
    };
  }

  /** Raw underlying data (read-only use — tests assert invariants on it). */
  rawData(): BrainData {
    return this.data;
  }

  // -- library --------------------------------------------------------------

  /**
   * Import PDF bytes as a new Source + stored asset. Importing NEVER creates a
   * Page/Relationship/Category — it only adds a Source and an asset blob.
   */
  async importSource(params: {
    title: string;
    bytes: Uint8Array;
    versionHash: string;
    pageCount: number;
    category?: string;
    /** FEAT-002 optional PDF metadata extracted via pdf.js getMetadata(). */
    authors?: string | undefined;
    year?: string | undefined;
    /**
     * M12 (FEAT-001) optional page texts extracted via pdf.js
     * `getTextContent()`, used to compute the canonicalId + textShingles
     * identity signals. Omitted in jsdom (no worker); the Reader backfills them
     * later via `reconcileOrAttachSource` / `updateSourceMetadata`.
     */
    pageTexts?: readonly string[] | undefined;
    /** M12 optional metadata string (joined pdf.js info) to scan for a DOI/ISBN. */
    metaStr?: string | undefined;
    /**
     * M12 when `true`, bypass identity reconciliation and ALWAYS create a new
     * Source (used by internal callers that have already reconciled).
     */
    skipReconcile?: boolean | undefined;
    /**
     * M12 when `true`, force routing through the identity engine even without
     * page texts (used by the real local-PDF import path so a re-import of the
     * exact same bytes re-hydrates its slot). Defaults to reconciling only when
     * `pageTexts` is supplied, so legacy callers that import synthetic fixture
     * bytes keep getting DISTINCT sources (M10 back-compat).
     */
    reconcile?: boolean | undefined;
  }): Promise<Source> {
    // M12 (FEAT-001): route through the universal identity engine so a
    // re-import / cover-sheet / revised draft re-hydrates an existing slot
    // instead of silently duplicating the Source. Only engage when a real
    // identity signal is present (page texts) or a caller explicitly opts in,
    // so the many legacy tests that import identical synthetic fixture bytes
    // under distinct titles still produce distinct sources.
    const shouldReconcile =
      params.skipReconcile !== true &&
      (params.reconcile === true || (params.pageTexts?.length ?? 0) > 0);
    if (shouldReconcile) {
      const reconciled = await this.reconcileOrAttachSource({
        title: params.title,
        bytes: params.bytes,
        versionHash: params.versionHash,
        pageCount: params.pageCount,
        ...(params.category != null ? { category: params.category } : {}),
        ...(params.authors != null ? { authors: params.authors } : {}),
        ...(params.year != null ? { year: params.year } : {}),
        ...(params.pageTexts != null ? { pageTexts: params.pageTexts } : {}),
        ...(params.metaStr != null ? { metaStr: params.metaStr } : {}),
      });
      return reconciled.source;
    }
    const assetId = newAssetId();
    const authors = params.authors?.trim();
    const year = params.year?.trim();
    const contentHash = computeByteHash(params.bytes);
    const { docStem } = extractDocStem(params.title);
    const pageTexts = params.pageTexts ?? [];
    const canonicalId =
      pageTexts.length > 0 || params.metaStr
        ? extractCanonicalId(pageTexts, params.metaStr)
        : undefined;
    const textShingles = pageTexts.length > 0 ? computeTextShingles(pageTexts) : undefined;
    const source: Source = {
      id: newSourceId(),
      kind: "pdf",
      title: params.title,
      assetId,
      versionHash: params.versionHash,
      pageCount: params.pageCount,
      importedAt: new Date().toISOString(),
      category: params.category ?? "Uncategorized",
      ...(authors ? { authors } : {}),
      ...(year ? { year } : {}),
      contentHash,
      docStem,
      ...(canonicalId != null ? { canonicalId } : {}),
      ...(textShingles != null ? { textShingles } : {}),
    };
    await this.storage.writeAsset(this.data.manifest.brainId, assetId, params.bytes);
    this.data = {
      ...this.data,
      sources: [...this.data.sources, source],
      manifest: {
        ...this.data.manifest,
        assetIndex: [
          ...this.data.manifest.assetIndex,
          {
            assetId,
            contentType: "application/pdf",
            byteLength: params.bytes.byteLength,
            contentHash: params.versionHash,
          },
        ],
      },
    };
    await this.persist();
    return source;
  }

  /**
   * M14–M16 (FEAT-003) Local Folder Inbox auto-import. Given the `.pdf` File
   * entries of a chosen local folder (via `showDirectoryPicker`, a
   * `<input webkitdirectory>`, or a direct File[]), import only the BRAND-NEW
   * PDFs under category `defaultCategory` (default "Inbox") and SKIP any that
   * are already in the library. Deduplication goes through M12's universal
   * identity engine (`computeByteHash` + `matchExistingSource` inside
   * `reconcileOrAttachSource`), so re-scanning the same folder imports ZERO
   * duplicates — a repeat scan re-hydrates the existing slot in place and never
   * appends. Non-`.pdf` entries are ignored. Returns the ids of the sources
   * that are present after the scan, in folder order (new + re-hydrated alike),
   * so a caller can reveal them.
   */
  async ingestFolderPdfEntries(
    files: readonly File[],
    defaultCategory = "Inbox",
  ): Promise<SourceId[]> {
    const out: SourceId[] = [];
    for (const file of files) {
      const isPdf =
        file.type === "application/pdf" || /\.pdf$/i.test(file.name ?? "");
      if (!isPdf) continue;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const versionHash = await sha256Hex(bytes);
      const title = (file.name ?? "Document").replace(/\.pdf$/i, "").trim() || "Document";
      // reconcile:true routes every entry through the identity engine so an
      // already-imported PDF in the folder re-hydrates its slot (0 duplicates)
      // while a genuinely new PDF is appended under the Inbox category.
      const source = await this.importSource({
        title,
        bytes,
        versionHash,
        pageCount: 1,
        category: defaultCategory,
        reconcile: true,
      });
      out.push(source.id);
    }
    return out;
  }

  /**
   * M12 (FEAT-001) Universal PDF identity reconciliation + slot re-hydration.
   *
   * Computes the incoming PDF's identity signature (contentHash from bytes,
   * docStem from title, canonicalId + textShingles from page texts) and runs
   * {@link matchExistingSource} against every existing PDF Source. On a match it
   * RE-HYDRATES that existing `Source.id` in place — restores the binary, bumps
   * versionHash/contentHash/canonicalId/docStem/textShingles/pageCount, backfills
   * authors/year, clears the offloaded flag — and NEVER appends a duplicate. On
   * no match it falls through to a fresh `importSource` (skipReconcile).
   *
   * When the matched source's text changed (versionHash/contentHash differ or
   * the page count changed) and `pageTexts` is supplied, it re-anchors every
   * text/range/area annotation on that source (uniform page shift + individual
   * paragraph move) so highlights survive a prepended cover page or a revised
   * draft. Pure/synchronous fingerprinting; one persist at the end.
   */
  async reconcileOrAttachSource(params: {
    title: string;
    bytes: Uint8Array;
    versionHash: string;
    pageCount: number;
    category?: string | undefined;
    authors?: string | undefined;
    year?: string | undefined;
    pageTexts?: readonly string[] | undefined;
    metaStr?: string | undefined;
  }): Promise<{ source: Source; matched: boolean }> {
    const contentHash = computeByteHash(params.bytes);
    const { stem, seqToken, docStem } = extractDocStem(params.title);
    const pageTexts = params.pageTexts ?? [];
    const canonicalId =
      pageTexts.length > 0 || params.metaStr
        ? extractCanonicalId(pageTexts, params.metaStr)
        : undefined;
    const textShingles = pageTexts.length > 0 ? computeTextShingles(pageTexts) : undefined;

    const incoming = {
      contentHash,
      stem,
      seqToken,
      ...(canonicalId != null ? { canonicalId } : {}),
      ...(textShingles != null ? { textShingles } : {}),
    };

    // Find the first existing PDF source that the identity engine accepts.
    let matchIdx = -1;
    for (let i = 0; i < this.data.sources.length; i++) {
      const cand = this.data.sources[i]!;
      if (cand.kind !== "pdf") continue;
      const parsed = parseDocStem(cand.docStem);
      const decision = matchExistingSource(incoming, {
        ...(cand.contentHash != null ? { contentHash: cand.contentHash } : {}),
        ...(cand.canonicalId != null ? { canonicalId: cand.canonicalId } : {}),
        stem: parsed.stem,
        seqToken: parsed.seqToken,
        ...(cand.textShingles != null ? { textShingles: cand.textShingles } : {}),
        binaryOffloaded: this.offloadedAssetIds.has(cand.assetId),
      });
      if (decision.matched) {
        matchIdx = i;
        break;
      }
    }

    if (matchIdx < 0) {
      // No existing slot: create a brand-new Source with its signature baked in.
      const source = await this.importSource({
        title: params.title,
        bytes: params.bytes,
        versionHash: params.versionHash,
        pageCount: params.pageCount,
        skipReconcile: true,
        ...(params.category != null ? { category: params.category } : {}),
        ...(params.authors != null ? { authors: params.authors } : {}),
        ...(params.year != null ? { year: params.year } : {}),
        ...(params.pageTexts != null ? { pageTexts: params.pageTexts } : {}),
        ...(params.metaStr != null ? { metaStr: params.metaStr } : {}),
      });
      return { source, matched: false };
    }

    // ---- Re-hydrate the existing slot in place ----------------------------
    const existing = this.data.sources[matchIdx]!;
    const prevPageCount = existing.pageCount;

    // Restore the binary under the EXISTING assetId (re-hydration, not a new id).
    await this.storage.writeAsset(
      this.data.manifest.brainId,
      existing.assetId,
      params.bytes,
    );
    this.offloadedAssetIds.delete(existing.assetId);

    const authors = params.authors?.trim();
    const year = params.year?.trim();
    // Drop any stale `availabilityStatus` (e.g. a website "snapshot-cached"
    // flag) — a re-hydrated PDF binary is resident. exactOptionalPropertyTypes
    // forbids assigning `undefined`, so we OMIT the key via destructuring.
    const { availabilityStatus: _staleAvailability, ...existingRest } = existing;
    void _staleAvailability;
    const updated: Source = {
      ...existingRest,
      title: existing.title, // keep the original library title
      versionHash: params.versionHash,
      pageCount:
        Number.isFinite(params.pageCount) && params.pageCount > 0
          ? params.pageCount
          : existing.pageCount,
      contentHash,
      docStem,
      ...(canonicalId != null ? { canonicalId } : { canonicalId: existing.canonicalId }),
      ...(textShingles != null ? { textShingles } : {}),
      // Backfill authors/year only when currently absent.
      ...(existing.authors == null && authors ? { authors } : {}),
      ...(existing.year == null && year ? { year } : {}),
    };

    const sources = this.data.sources.slice();
    sources[matchIdx] = updated;

    // Keep the manifest asset-index entry in sync with the new binary.
    const assetIndex = this.data.manifest.assetIndex.map((e) =>
      e.assetId === existing.assetId
        ? {
            ...e,
            byteLength: params.bytes.byteLength,
            contentHash: params.versionHash,
          }
        : e,
    );

    // Re-anchor highlights when the content actually changed and we have text.
    let annotations = this.data.annotations;
    const contentChanged =
      existing.contentHash !== contentHash ||
      existing.versionHash !== params.versionHash ||
      prevPageCount !== updated.pageCount;
    if (contentChanged && pageTexts.length > 0) {
      annotations = this.reanchorAnnotations(
        existing.id,
        params.versionHash,
        pageTexts,
      );
    } else if (existing.versionHash !== params.versionHash) {
      // Even without text, keep stored anchor version hashes consistent.
      annotations = this.restampAnchorVersionHash(existing.id, params.versionHash);
    }

    this.data = {
      ...this.data,
      sources,
      annotations,
      manifest: { ...this.data.manifest, assetIndex },
    };
    await this.persist();
    return { source: updated, matched: true };
  }

  /**
   * M12 re-stamp every annotation's stored anchor `sourceVersionHash` for one
   * source to `versionHash`, without moving any page index. Pure; returns a new
   * annotations array.
   */
  private restampAnchorVersionHash(
    sourceId: SourceId,
    versionHash: string,
  ): Annotation[] {
    return this.data.annotations.map((a) => {
      if (a.sourceId !== sourceId) return a;
      return this.withAnchorPatch(a, versionHash, null, null);
    });
  }

  /**
   * M12 (FEAT-001) re-anchor every annotation on `sourceId` against freshly
   * extracted `pageTexts`:
   *  1. Match each text annotation's normalized quote in the new page texts.
   *  2. If a DOMINANT uniform page shift Δp != 0 emerges (e.g. +1 for a
   *     prepended cover sheet), shift ALL annotations on the source by Δp.
   *  3. For any text annotation whose quote is NOT at oldPageIndex + Δp but IS
   *     uniquely found on another page, move it to that page.
   * All page indices are clamped to [0, pageTexts.length - 1]. Pure; returns a
   * new annotations array.
   */
  private reanchorAnnotations(
    sourceId: SourceId,
    versionHash: string,
    pageTexts: readonly string[],
  ): Annotation[] {
    const normPages = pageTexts.map((t) => normalizeForMatch(t));
    const lastIdx = Math.max(0, normPages.length - 1);

    // Locate each text annotation's quote: all pages it appears on.
    interface Located {
      readonly annotation: Annotation;
      readonly oldPageIndex: number;
      readonly quote: string;
      readonly foundPages: number[];
    }
    const located: Located[] = [];
    for (const a of this.data.annotations) {
      if (a.sourceId !== sourceId) continue;
      if (a.scope.kind !== "text") continue;
      const quote = normalizeForMatch(a.scope.anchor.selectedText);
      if (quote.length < 8) continue; // too short to match reliably
      const foundPages: number[] = [];
      for (let p = 0; p < normPages.length; p++) {
        if (normPages[p]!.includes(quote)) foundPages.push(p);
      }
      located.push({
        annotation: a,
        oldPageIndex: a.scope.anchor.pageIndex,
        quote,
        foundPages,
      });
    }

    // Determine the dominant uniform shift Δp from quotes found on exactly one
    // page (unambiguous), weighting each matched quote equally.
    const shiftVotes = new Map<number, number>();
    for (const loc of located) {
      if (loc.foundPages.length === 1) {
        const delta = loc.foundPages[0]! - loc.oldPageIndex;
        shiftVotes.set(delta, (shiftVotes.get(delta) ?? 0) + 1);
      }
    }
    let dominantShift = 0;
    let bestVotes = 0;
    for (const [delta, votes] of shiftVotes) {
      if (votes > bestVotes || (votes === bestVotes && Math.abs(delta) < Math.abs(dominantShift))) {
        bestVotes = votes;
        dominantShift = delta;
      }
    }

    const clamp = (n: number): number => Math.min(Math.max(n, 0), lastIdx);
    const locatedById = new Map<AnnotationId, Located>();
    for (const loc of located) locatedById.set(loc.annotation.id, loc);

    return this.data.annotations.map((a) => {
      if (a.sourceId !== sourceId) return a;

      // Default: apply the uniform shift to every annotation on this source.
      let pageDelta: number | null = dominantShift !== 0 ? dominantShift : null;
      let absolutePage: number | null = null;

      const loc = locatedById.get(a.id);
      if (loc) {
        const shiftedTarget = loc.oldPageIndex + dominantShift;
        const atShifted =
          shiftedTarget >= 0 &&
          shiftedTarget < normPages.length &&
          normPages[shiftedTarget]!.includes(loc.quote);
        if (!atShifted && loc.foundPages.length === 1) {
          // Individual paragraph move: quote is not where the uniform shift
          // predicts but IS uniquely on another page.
          absolutePage = clamp(loc.foundPages[0]!);
          pageDelta = null;
        }
      }

      const patched = this.withAnchorPatch(a, versionHash, pageDelta, absolutePage, clamp);

      // M13 (§1.3) when a TEXT annotation's pageIndex actually moved due to the
      // content/version-hash change, its stored normalized rects still hold the
      // PREVIOUS draft's coordinates. Mark it `rectsStale: true` so the Reader
      // re-measures the quote against the live text layer on render (then calls
      // updateAnnotationRects to write fresh rects + clear the flag). Omit the
      // key when unchanged — exactOptionalPropertyTypes forbids assigning
      // `undefined` to an optional field.
      if (
        patched.scope.kind === "text" &&
        a.scope.kind === "text" &&
        patched.scope.anchor.pageIndex !== a.scope.anchor.pageIndex
      ) {
        return { ...patched, rectsStale: true };
      }
      return patched;
    });
  }

  /**
   * M13 (§1.3) persist freshly re-measured normalized rects for a text
   * annotation and clear its `rectsStale` flag. Called by the Reader after it
   * re-anchors a quote against the live `.textLayer` (via
   * `recomputeRectsFromQuote`) when a revised PDF shifted the paragraph's
   * coordinates. A no-op for an unknown id, a non-text annotation, or an empty
   * `rects` array (the caller keeps the existing geometry rather than clobbering
   * it with nothing). Follows the anchor-patch + `this.data = {...}` + persist +
   * logChange pattern used by the other annotation mutators.
   */
  async updateAnnotationRects(
    annotationId: AnnotationId,
    rects: readonly NormalizedRect[],
  ): Promise<void> {
    if (rects.length === 0) return;
    const idx = this.data.annotations.findIndex((a) => a.id === annotationId);
    if (idx < 0) return;
    const prev = this.data.annotations[idx]!;
    if (prev.scope.kind !== "text") return;

    // Immutably patch the anchor's rects; drop the now-resolved stale flag via
    // destructuring so the key is OMITTED (exactOptionalPropertyTypes forbids
    // assigning `undefined`).
    const { rectsStale: _wasStale, ...rest } = prev;
    void _wasStale;
    const updated: Annotation = {
      ...rest,
      scope: {
        kind: "text",
        anchor: { ...prev.scope.anchor, rects: rects.map((r) => ({ ...r })) },
      },
      updatedAt: new Date().toISOString(),
    };
    const annotations = this.data.annotations.slice();
    annotations[idx] = updated;
    this.data = { ...this.data, annotations };
    await this.persist();
    await this.logChange(
      "other",
      "annotation-rects",
      "Re-anchored a highlight to its revised page position",
      [annotationId],
    );
  }

  /**
   * M12 immutably patch one annotation's anchor: re-stamp its version hash, and
   * either shift its page index by `pageDelta` OR set it to `absolutePage`
   * (absolute wins when non-null). Range/area anchors shift start/end/page
   * indices; text anchors shift pageIndex. Clamped by `clamp` when supplied.
   */
  private withAnchorPatch(
    a: Annotation,
    versionHash: string,
    pageDelta: number | null,
    absolutePage: number | null,
    clamp: (n: number) => number = (n) => n,
  ): Annotation {
    const scope = a.scope;
    if (scope.kind === "text") {
      const base = scope.anchor.pageIndex;
      const nextPage =
        absolutePage != null
          ? absolutePage
          : pageDelta != null
            ? clamp(base + pageDelta)
            : base;
      return {
        ...a,
        scope: {
          kind: "text",
          anchor: { ...scope.anchor, sourceVersionHash: versionHash, pageIndex: nextPage },
        },
      };
    }
    if (scope.kind === "area") {
      const base = scope.anchor.pageIndex;
      const nextPage =
        absolutePage != null
          ? absolutePage
          : pageDelta != null
            ? clamp(base + pageDelta)
            : base;
      return {
        ...a,
        scope: {
          kind: "area",
          anchor: { ...scope.anchor, sourceVersionHash: versionHash, pageIndex: nextPage },
        },
      };
    }
    // pages (range) anchor: shift both start and end by the same delta.
    const start = scope.anchor.startPageIndex;
    const end = scope.anchor.endPageIndex;
    const nextStart = pageDelta != null ? clamp(start + pageDelta) : start;
    const nextEnd = pageDelta != null ? clamp(end + pageDelta) : end;
    return {
      ...a,
      scope: {
        kind: "pages",
        anchor: {
          ...scope.anchor,
          sourceVersionHash: versionHash,
          startPageIndex: nextStart,
          endPageIndex: nextEnd,
        },
      },
    };
  }

  /** Read the stored PDF bytes for a source (for the reader to render). */
  async readSourceBytes(sourceId: SourceId): Promise<Uint8Array | null> {
    const source = this.data.sources.find((s) => s.id === sourceId);
    if (!source) return null;
    return this.storage.readAsset(this.data.manifest.brainId, source.assetId);
  }

  /**
   * M3 v2 backfill (spec 3.1 / D01): set a Source's `pageCount` ONLY when the
   * stored value is 0. The batch ingest queue (enqueuePdfBinaries) is pure /
   * DOM-free and cannot run pdf.js, so a freshly CREATED source lands with
   * pageCount 0; the Reader runs pdf.js and calls this once `doc.numPages` is
   * known to fill the real count. A no-op for an unknown source, a non-zero
   * stored count (never clobbers a real count), or a non-positive input.
   */
  async updateSourcePageCount(sourceId: SourceId, pageCount: number): Promise<void> {
    const idx = this.data.sources.findIndex((s) => s.id === sourceId);
    if (idx < 0) return;
    const source = this.data.sources[idx]!;
    if (source.pageCount !== 0) return;
    if (!Number.isFinite(pageCount) || pageCount <= 0) return;
    const sources = this.data.sources.slice();
    sources[idx] = { ...source, pageCount };
    this.data = { ...this.data, sources };
    await this.persist();
  }

  /**
   * FEAT-002 backfill a Source's PDF metadata once the Reader has run pdf.js
   * (jsdom has no worker, so import-time extraction returns undefined). Mirrors
   * updateSourcePageCount's "fill only when missing" discipline: pageCount is
   * written only when the stored value is 0, and authors/year are written only
   * when currently absent AND a non-empty value is supplied — a real stored
   * value is never clobbered. Persists once when anything actually changed.
   */
  async updateSourceMetadata(
    sourceId: SourceId,
    meta: {
      pageCount?: number | undefined;
      authors?: string | undefined;
      year?: string | undefined;
      /**
       * M12 (FEAT-001) page texts extracted by the Reader via
       * `page.getTextContent()`. When supplied, the canonicalId + textShingles
       * identity signals are computed and backfilled (only when absent) so a
       * source that was batch-ingested or imported in jsdom gains its fuzzy
       * identity once rendered. The docStem is backfilled from the title.
       */
      pageTexts?: readonly string[] | undefined;
      metaStr?: string | undefined;
    },
  ): Promise<void> {
    const idx = this.data.sources.findIndex((s) => s.id === sourceId);
    if (idx < 0) return;
    const source = this.data.sources[idx]!;
    const next: {
      pageCount?: number;
      authors?: string;
      year?: string;
      docStem?: string;
      canonicalId?: string;
      textShingles?: readonly string[];
    } = {};
    if (
      source.pageCount === 0 &&
      meta.pageCount != null &&
      Number.isFinite(meta.pageCount) &&
      meta.pageCount > 0
    ) {
      next.pageCount = meta.pageCount;
    }
    const authors = meta.authors?.trim();
    if (source.authors == null && authors) next.authors = authors;
    const year = meta.year?.trim();
    if (source.year == null && year) next.year = year;

    // M12 identity-signal backfill (only fill what is missing).
    if (source.docStem == null) {
      const { docStem } = extractDocStem(source.title);
      if (docStem.length > 0) next.docStem = docStem;
    }
    const pageTexts = meta.pageTexts ?? [];
    if (pageTexts.length > 0 || meta.metaStr) {
      if (source.canonicalId == null) {
        const canonicalId = extractCanonicalId(pageTexts, meta.metaStr);
        if (canonicalId != null) next.canonicalId = canonicalId;
      }
      if (
        (source.textShingles == null || source.textShingles.length < 4) &&
        pageTexts.length > 0
      ) {
        const shingles = computeTextShingles(pageTexts);
        if (shingles.length >= 4) next.textShingles = shingles;
      }
    }

    if (Object.keys(next).length === 0) return;
    const sources = this.data.sources.slice();
    sources[idx] = { ...source, ...next };
    this.data = { ...this.data, sources };
    await this.persist();
  }

  /**
   * M18 (FEAT-PDF-CACHE §3) compute the document identity for a source's bytes.
   * Reuses the source's already-computed `contentHash` when present (the ingest
   * path hashes bytes for the versionHash / M12 identity), so identity does NOT
   * re-hash the whole file on reopen. `pdfId` is the pdf.js document fingerprint
   * supplied by the Reader. Returns both the stable `documentId` cache key and
   * the `sourceFingerprint` validation value.
   */
  pdfDocumentIdentity(
    sourceId: SourceId,
    info: { fileSize: number; pdfId?: string | null; headTailHash?: string | null },
  ): { documentId: string; sourceFingerprint: string } | null {
    const source = this.data.sources.find((s) => s.id === sourceId);
    if (!source) return null;
    const input: DocumentIdentityInput = {
      fileSize: info.fileSize,
      ...(source.contentHash ? { contentHash: source.contentHash } : {}),
      ...(info.pdfId != null ? { pdfId: info.pdfId } : {}),
      ...(info.headTailHash != null ? { headTailHash: info.headTailHash } : {}),
    };
    return {
      documentId: computeDocumentId(input),
      sourceFingerprint: computeSourceFingerprint(input),
    };
  }

  /**
   * M18 (FEAT-PDF-CACHE §8) run the fast-path open against the persistent PDF
   * analysis cache. On a warm hit this is an O(1) manifest read; on a miss /
   * resume it drives the one-pass bounded-concurrency ingestion, persisting each
   * analysed page incrementally. A no-op (returns null) when no analysis store
   * is wired (jsdom / legacy path). The caller supplies the pdf.js-backed
   * `analyzePage` callback (see `analyzePdfPage`) and a cancellation controller.
   */
  async openPdfAnalysisCache(args: {
    sourceId: SourceId;
    documentId: string;
    sourceFingerprint: string;
    fileSize: number;
    pageCount: number;
    analyzePage: PageAnalyzer;
    controller: IngestionController;
    currentPage?: number;
    progress?: IngestionProgress;
  }): Promise<Awaited<ReturnType<typeof openWithCache>> | null> {
    const store = this.pdfAnalysis;
    if (!store) return null;
    const freshManifest = createManifest({
      documentId: args.documentId,
      sourceFingerprint: args.sourceFingerprint,
      fileSize: args.fileSize,
      pageCount: args.pageCount,
    });
    return openWithCache({
      store,
      documentId: args.documentId,
      freshManifest,
      analyzePage: args.analyzePage,
      controller: args.controller,
      ...(args.currentPage != null ? { currentPage: args.currentPage } : {}),
      ...(args.progress ? { progress: args.progress } : {}),
    });
  }

  /**
   * M18 (FEAT-PDF-CACHE §8/§9) read a single analysed page from the persistent
   * cache WITHOUT deserializing the whole document (§14). Returns null when no
   * store is wired or the page is not yet analysed. Used by the Reader fast-path
   * to hydrate only the pages it actually displays.
   */
  async readAnalyzedPage(
    documentId: string,
    pageNumber: number,
  ): Promise<PdfPageAnalysis | null> {
    if (!this.pdfAnalysis) return null;
    return this.pdfAnalysis.readPage(documentId, pageNumber);
  }

  /**
   * M18 (FEAT-PDF-CACHE §8) validate the persistent cache for a document without
   * running ingestion — a pure O(1) manifest read + check. Returns the
   * validation decision (hit / resume / miss) or null when no store is wired.
   */
  async checkPdfAnalysisCache(args: {
    documentId: string;
    sourceFingerprint: string;
    pageCount: number;
  }): Promise<ReturnType<typeof validateCache> | null> {
    if (!this.pdfAnalysis) return null;
    const manifest = await this.pdfAnalysis.readManifest(args.documentId);
    return validateCache(manifest, {
      sourceFingerprint: args.sourceFingerprint,
      pageCount: args.pageCount,
    });
  }

  /** Expose a fresh ingestion cancellation controller (document-switch cancel). */
  createPdfIngestionController(): IngestionController {
    return createIngestionController();
  }

  /**
   * M17 (§1.1) persist a source's pre-parsed PDF page layouts on
   * `Source.cachedPages` so an immutable imported set text can hydrate its
   * `.textLayer` synchronously on the next reload (no pdf.js `getTextContent()`
   * re-parse). A no-op for an unknown source or an empty page list. Writes the
   * cache in place (idempotent — a later pass with more pages replaces it) and
   * persists once.
   */
  async cacheParsedPdfPages(
    sourceId: SourceId,
    pages: readonly PreParsedPageLayout[],
  ): Promise<void> {
    const idx = this.data.sources.findIndex((s) => s.id === sourceId);
    if (idx < 0) return;
    if (pages.length === 0) return;
    const source = this.data.sources[idx]!;
    const sources = this.data.sources.slice();
    sources[idx] = { ...source, cachedPages: pages };
    this.data = { ...this.data, sources };
    await this.persist();
  }

  /**
   * M17 (§3.1) set scientific extraction data (`latex` / `smiles` /
   * `mechanism`) on an annotation's AREA anchor. Follows the annotation-patch +
   * `this.data = {...}` + persist discipline. A no-op for an unknown annotation
   * or a non-area scope (science data lives on the AreaAnchor). Fields that are
   * `undefined` are omitted from the write (exactOptional-safe) and a field set
   * to `null` clears any previously stored value. Persists once.
   */
  async setAnnotationScienceData(
    annotationId: AnnotationId,
    data: {
      latex?: string | null;
      smiles?: string | null;
      mechanism?: ChemicalMechanismSpec | null;
    },
  ): Promise<void> {
    const idx = this.data.annotations.findIndex((a) => a.id === annotationId);
    if (idx < 0) return;
    const prev = this.data.annotations[idx]!;
    if (prev.scope.kind !== "area") return;
    const anchor = prev.scope.anchor;
    const nextAnchor: typeof anchor = {
      ...anchor,
      ...(data.latex !== undefined ? { latex: data.latex ?? undefined } : {}),
      ...(data.smiles !== undefined ? { smiles: data.smiles ?? undefined } : {}),
      ...(data.mechanism !== undefined ? { mechanism: data.mechanism ?? undefined } : {}),
    };
    const updated: Annotation = {
      ...prev,
      scope: { kind: "area", anchor: nextAnchor },
      updatedAt: new Date().toISOString(),
    };
    const annotations = this.data.annotations.slice();
    annotations[idx] = updated;
    this.data = { ...this.data, annotations };
    await this.persist();
  }

  /**
   * M6 (A15, D11) import a WEBSITE source. REQUIRES both a URL and a snapshot
   * file (the sanitized HTML/markdown/text); a URL-only import is rejected (the
   * Library modal enforces this too). The snapshot bytes are stored via the
   * StorageAdapter exactly like a PDF binary, the Source is tagged
   * kind/type "website" with availabilityStatus "snapshot-cached", and the URL
   * is recorded. Importing a website creates NO Page/Relationship/Category —
   * only a Source + an asset blob, like importSource. Persists once.
   */
  async importWebsiteSource(params: {
    title?: string;
    url: string;
    snapshot: Uint8Array;
    category?: string;
  }): Promise<Source> {
    const url = params.url?.trim() ?? "";
    if (url === "") {
      throw new Error("importWebsiteSource: a URL is required");
    }
    if (!params.snapshot || params.snapshot.byteLength === 0) {
      throw new Error("importWebsiteSource: a snapshot file is required");
    }
    // Sanitize the snapshot at import time (defense in depth; the reader also
    // sanitizes at render time). Strips script/style blocks, inline event
    // handlers, and javascript: URLs so a stored snapshot can never execute.
    const sanitized = sanitizeSnapshotBytes(params.snapshot);
    const assetId = newAssetId();
    const versionHash = await sha256Hex(sanitized);
    const source: Source = {
      id: newSourceId(),
      kind: "website",
      type: "website",
      title: params.title?.trim() || url,
      assetId,
      versionHash,
      url,
      availabilityStatus: "snapshot-cached",
      // A website renders as a single scrollable snapshot: one logical page.
      pageCount: 1,
      importedAt: new Date().toISOString(),
      category: params.category ?? "Websites",
    };
    await this.storage.writeAsset(this.data.manifest.brainId, assetId, sanitized);
    this.data = {
      ...this.data,
      sources: [...this.data.sources, source],
      manifest: {
        ...this.data.manifest,
        assetIndex: [
          ...this.data.manifest.assetIndex,
          {
            assetId,
            contentType: "text/html",
            byteLength: sanitized.byteLength,
            contentHash: versionHash,
          },
        ],
      },
    };
    await this.persist();
    return source;
  }

  /**
   * M6 (D01) commit a rectangular AREA annotation over one page. Produces an
   * Annotation whose scope.kind is "area" (the spec's `Annotation.kind =
   * "area"`) with an EMPTY comment unless provided, and NO node/page/category.
   * The area is citable into Subject Pages via the ordinary evidence path
   * (insertEvidenceIntoPage). Persists once. Throws for an unknown source.
   *
   * FEAT-002 (2.4): the optional `imageDataUrl` carries the cropped figure
   * image (PNG data URL, or an SVG fallback in jsdom) and is stored on the area
   * anchor so the figure thumbnail renders everywhere the annotation is shown.
   */
  async commitAreaAnnotation(
    sourceId: SourceId,
    pageIndex: number,
    rect: NormalizedRect,
    comment?: string,
    imageDataUrl?: string,
  ): Promise<AnnotationView> {
    const source = this.data.sources.find((s) => s.id === sourceId);
    if (!source) throw new Error("commitAreaAnnotation: unknown source");
    const now = new Date().toISOString();
    const annotation: Annotation = {
      id: newAnnotationId(),
      sourceId,
      scope: {
        kind: "area",
        anchor: {
          docId: sourceId,
          sourceVersionHash: source.versionHash,
          pageIndex,
          rect,
          // FEAT-002 (2.4): persist the cropped figure image on the anchor so
          // the thumbnail survives save/reopen without the live PDF render.
          ...(imageDataUrl != null ? { imageDataUrl } : {}),
        },
      },
      resolution: { kind: "resolved" },
      comment: comment ?? "",
      createdAt: now,
      updatedAt: now,
    };
    this.data = {
      ...this.writeStyle(this.data, annotation.id, DEFAULT_STYLE),
      annotations: [...this.data.annotations, annotation],
    };
    await this.persist();
    return this.viewFor(annotation.id)!;
  }

  /**
   * M6 (A24, D10) import a Zotero bundle (Zotero JSON / BetterBibTeX JSON / RDF
   * annotation bundle). Parent items map to Sources (externalId) and
   * highlights/notes to source-local Annotations (externalId). The import is
   * IDEMPOTENT: it matches existing records on `externalId` and updates them in
   * place, so re-importing the same bundle produces ZERO duplicate Source or
   * Annotation records and ZERO auto-created graph nodes (pages, relationships,
   * categories are untouched). Persists once. Returns a small summary.
   */
  async importZoteroBundle(
    rawJson: string,
  ): Promise<{ sourcesAdded: number; sourcesUpdated: number; annotationsAdded: number; annotationsUpdated: number }> {
    const parsed = parseZoteroBundle(rawJson);
    const now = new Date().toISOString();

    const sources = this.data.sources.slice();
    const annotations = this.data.annotations.slice();
    const assetIndex = this.data.manifest.assetIndex.slice();
    let sourcesAdded = 0;
    let sourcesUpdated = 0;
    let annotationsAdded = 0;
    let annotationsUpdated = 0;

    // Map external source id -> live SourceId (existing or newly created).
    const sourceIdByExternal = new Map<string, SourceId>();
    for (const s of sources) {
      if (s.externalId != null) sourceIdByExternal.set(s.externalId, s.id);
    }

    for (const item of parsed.sources) {
      const existingId = sourceIdByExternal.get(item.externalId);
      if (existingId != null) {
        // Update in place: refresh title/url, keep the same id + assetId.
        const idx = sources.findIndex((s) => s.id === existingId);
        if (idx >= 0) {
          sources[idx] = {
            ...sources[idx]!,
            title: item.title || sources[idx]!.title,
            ...(item.url != null ? { url: item.url } : {}),
          };
          sourcesUpdated += 1;
        }
        continue;
      }
      // A Zotero parent item carries no binary; it still needs an assetId for
      // the Source shape. We create a stable empty asset entry (no bytes
      // written) so the record is well-formed; the PDF can be attached later.
      const assetId = newAssetId();
      const newSource: Source = {
        id: newSourceId(),
        kind: "pdf",
        title: item.title || item.externalId,
        assetId,
        versionHash: "",
        pageCount: 0,
        importedAt: now,
        category: item.category ?? "Zotero",
        externalId: item.externalId,
        ...(item.url != null ? { url: item.url } : {}),
      };
      sources.push(newSource);
      assetIndex.push({
        assetId,
        contentType: "application/pdf",
        byteLength: 0,
        contentHash: "",
      });
      sourceIdByExternal.set(item.externalId, newSource.id);
      sourcesAdded += 1;
    }

    // Index existing annotations by externalId for idempotent updates.
    const annIdxByExternal = new Map<string, number>();
    annotations.forEach((a, i) => {
      if (a.externalId != null) annIdxByExternal.set(a.externalId, i);
    });

    for (const ann of parsed.annotations) {
      const liveSourceId = sourceIdByExternal.get(ann.sourceExternalId);
      if (liveSourceId == null) continue; // orphan annotation: no parent item
      const source = sources.find((s) => s.id === liveSourceId)!;
      const scope: AnnotationScope = {
        kind: "area",
        anchor: {
          docId: liveSourceId,
          sourceVersionHash: source.versionHash,
          pageIndex: ann.pageIndex,
          rect: ann.rect,
        },
      };
      const existingIdx = annIdxByExternal.get(ann.externalId);
      if (existingIdx != null) {
        annotations[existingIdx] = {
          ...annotations[existingIdx]!,
          sourceId: liveSourceId,
          scope,
          comment: ann.comment,
          updatedAt: now,
        };
        annotationsUpdated += 1;
      } else {
        const created: Annotation = {
          id: newAnnotationId(),
          sourceId: liveSourceId,
          scope,
          resolution: { kind: "resolved" },
          comment: ann.comment,
          createdAt: now,
          updatedAt: now,
          externalId: ann.externalId,
        };
        annotations.push(created);
        annIdxByExternal.set(ann.externalId, annotations.length - 1);
        annotationsAdded += 1;
      }
    }

    this.data = {
      ...this.data,
      sources,
      annotations,
      manifest: { ...this.data.manifest, assetIndex },
    };
    await this.persist();
    return { sourcesAdded, sourcesUpdated, annotationsAdded, annotationsUpdated };
  }

  // -- offline-first binary eviction (A17) ----------------------------------

  /**
   * OFFLOAD a source's PDF binary to reclaim local space (A17). Deletes ONLY
   * the stored asset bytes via the adapter; the Source and every Annotation +
   * EvidenceInstance that depends on it stay 100% intact so citations keep
   * functioning from their stored metadata. Persists so the change is durable
   * (the manifest revision advances like any other mutation). A no-op for an
   * unknown source.
   */
  async offloadSourceBinary(sourceId: SourceId): Promise<void> {
    const source = this.data.sources.find((s) => s.id === sourceId);
    if (!source) return;
    await this.storage.deletePdfBinary(this.data.manifest.brainId, source.assetId);
    this.offloadedAssetIds.add(source.assetId);
    await this.persist();
  }

  /**
   * Permanently delete a source (PDF or website snapshot) from the library.
   *
   * Removes the Source record, its stored binary, its manifest asset-index
   * entry, and every Annotation anchored to it (plus those annotations'
   * styles and tentative SubjectAssociations). Quotes ALREADY inserted into
   * Subject pages are deliberately KEPT, exactly as "delete highlight only"
   * does: the quoted text survives verbatim and the (annotation, page) pair
   * then derives as unresolved because the annotation is gone. Captures that
   * pointed at the source are detached (sourceId -> null), not deleted.
   * A no-op for an unknown id.
   */
  async deleteSource(sourceId: SourceId): Promise<void> {
    const source = this.data.sources.find((s) => s.id === sourceId);
    if (!source) return;

    const doomedAnnotationIds = new Set(
      this.data.annotations.filter((a) => a.sourceId === sourceId).map((a) => a.id),
    );
    const remainingStyles = Object.fromEntries(
      Object.entries(this.data.presentation.annotationStyles ?? {}).filter(
        ([id]) => !doomedAnnotationIds.has(id as AnnotationId),
      ),
    );

    // Bytes first: if this throws nothing structured has changed yet.
    await this.storage.deletePdfBinary(this.data.manifest.brainId, source.assetId);
    this.offloadedAssetIds.delete(source.assetId);

    this.data = {
      ...this.data,
      sources: this.data.sources.filter((s) => s.id !== sourceId),
      annotations: this.data.annotations.filter((a) => a.sourceId !== sourceId),
      subjectAssociations: this.data.subjectAssociations.filter(
        (a) => !doomedAnnotationIds.has(a.annotationId),
      ),
      captures: this.data.captures.map((c) =>
        c.sourceId === sourceId ? { ...c, sourceId: null } : c,
      ),
      manifest: {
        ...this.data.manifest,
        assetIndex: this.data.manifest.assetIndex.filter((a) => a.assetId !== source.assetId),
      },
      presentation: { ...this.data.presentation, annotationStyles: remainingStyles },
    };
    this.openSourceIds = this.openSourceIds.filter((id) => id !== sourceId);
    await this.persist();
  }

  /**
   * Whether a source's PDF binary is locally available: "cached" when the
   * adapter still holds the asset bytes, "binary-offloaded" when they were
   * evicted (A17). Synchronous: it reads the `offloadedAssetIds` cache (kept in
   * sync by offload/attach and rebuilt at open) so the UI + resolution paths
   * need no await. Returns "binary-offloaded" for an unknown source.
   */
  sourceBinaryStatus(sourceId: SourceId): "cached" | "binary-offloaded" {
    const source = this.data.sources.find((s) => s.id === sourceId);
    if (!source) return "binary-offloaded";
    return this.offloadedAssetIds.has(source.assetId) ? "binary-offloaded" : "cached";
  }

  /**
   * Re-ATTACH a PDF binary to an offloaded source (A17). Computes sha256Hex of
   * the supplied bytes and ONLY writes them when the digest matches the stored
   * Source.versionHash, transitioning the source back to "cached". A mismatch
   * (wrong file, or a different edition) returns { attached: false, reason }
   * and writes NOTHING, so a drifted edition can never masquerade as the
   * original. Returns { attached: false } for an unknown source.
   */
  async attachSourceBinary(
    sourceId: SourceId,
    bytes: Uint8Array,
  ): Promise<{ attached: boolean; reason?: string }> {
    const source = this.data.sources.find((s) => s.id === sourceId);
    if (!source) {
      return { attached: false, reason: "unknown source" };
    }
    const digest = await sha256Hex(bytes);
    if (digest !== source.versionHash) {
      return {
        attached: false,
        reason: "attached file does not match this source's version hash",
      };
    }
    await this.storage.writeAsset(this.data.manifest.brainId, source.assetId, bytes);
    this.offloadedAssetIds.delete(source.assetId);
    return { attached: true };
  }

  // -- two-lane backup + staged import (D09, A18, A19) ----------------------

  /**
   * Export the live brain as a backup (D09). Reads the live BrainData, pulls
   * each ticked source's binary bytes via `storage.readAsset`, and returns the
   * serialized bytes + the omission-stamped manifest (A18). When the
   * sourceBinaries box is ticked the result is a `.ito.zip` Lane-2 bundle;
   * otherwise it is the Lane-1 `brain.ito.json` text as bytes. This never
   * mutates the store.
   */
  async exportBackup(
    options?: Partial<BackupOptions>,
  ): Promise<{ bytes: Uint8Array; manifest: BrainManifest }> {
    const resolved = resolveBackupOptions(options);
    const { manifest, json } = exportCoreBrainJson(this.data, resolved);
    if (!resolved.sourceBinaries) {
      return { bytes: strToU8(json), manifest };
    }
    // Pull each source's binary bytes so the Lane-2 bundle can embed them. A
    // source whose binary was offloaded simply contributes no asset entry.
    const assets = new Map<string, Uint8Array>();
    for (const source of this.data.sources) {
      const bytes = await this.storage.readAsset(
        this.data.manifest.brainId,
        source.assetId,
      );
      if (bytes) assets.set(source.assetId, bytes);
    }
    const bytes = await exportBundleZip(this.data, resolved, assets);
    return { bytes, manifest };
  }

  /**
   * Stage an incoming backup for validation WITHOUT touching the live store
   * (A19). Delegates to the pure staging validator and HOLDS the staged result
   * in memory so the UI can render the staging report and the user can decide
   * to commit (optionally lenient). Returns the staged outcome for inspection.
   */
  async stageImport(bundle: Uint8Array | string): Promise<StagedImport> {
    const staged = await stageImportCodec(bundle);
    this.stagedImport = staged;
    return staged;
  }

  /** The currently staged import, if any (for the UI staging report). */
  stagedImportState(): StagedImport | null {
    return this.stagedImport;
  }

  /** Discard any held staged import without committing (Cancel). */
  clearStagedImport(): void {
    this.stagedImport = null;
  }

  /**
   * Commit the held staged import (A19). For a 'ready' bundle it commits
   * normally; for 'needs-confirmation' it commits ONLY with `opts.lenient`
   * ('Try Import Anyway'); a 'hard-reject' never commits. On a successful
   * commit it writes the resulting BrainData through `storage.writeBrain` and
   * every asset through `storage.writeAsset`, replaces the in-memory BrainData,
   * rebuilds the offloaded-binary cache, and clears the staged state. If the
   * write throws, the PRIOR live data is retained (write-then-swap).
   */
  async commitStagedImport(opts?: {
    lenient?: boolean;
  }): Promise<{ committed: boolean; reason?: string }> {
    if (!this.stagedImport) {
      return { committed: false, reason: "no staged import" };
    }
    const result = await commitStagedImportCodec(this.stagedImport, opts);
    if (!result.committed) {
      return { committed: false, reason: result.reason };
    }
    const previous = this.data;
    try {
      await this.storage.writeBrain(result.data);
      for (const [assetId, bytes] of result.assets) {
        await this.storage.writeAsset(
          result.data.manifest.brainId,
          assetId,
          bytes,
        );
      }
      this.data = result.data;
      this.saveError = null;
    } catch (err) {
      // Retain the prior live data on any write failure (R12 discipline).
      this.data = previous;
      this.saveError = {
        message: err instanceof Error ? err.message : String(err),
        atISO: new Date().toISOString(),
      };
      throw err;
    }
    await this.refreshBinaryAvailability();
    this.stagedImport = null;
    return { committed: true };
  }

  // -- batch PDF ingestion queue (D09) --------------------------------------

  /**
   * Ingest a batch of PDF files with bounded concurrency (D09). Each file is
   * validated (%PDF- magic + per-file size guard), hashed to a sha256
   * versionHash, then either HYDRATES a matching existing Source (writing the
   * bytes) or CREATES a new Source. Non-PDFs and oversize files are rejected
   * without a Source. The size guard (default 100 MB) and concurrency (default
   * 2) are injectable for tests. Persists ONCE at the end when any new Source
   * was created.
   */
  async enqueuePdfBinaries(
    files: readonly { name: string; bytes: Uint8Array }[],
    options?: IngestOptions,
  ): Promise<
    { sourceId: string; status: "hydrated" | "created" | "rejected"; reason?: string }[]
  > {
    // Accumulate every CREATED source + assetIndex entry here instead of
    // reassigning `this.data` inside each callback. With concurrency >= 2 two
    // concurrent "created" callbacks would otherwise each read the same
    // `this.data` snapshot across their `await writeAsset`, so the second
    // reassignment would clobber the first and drop a Source + assetIndex entry.
    // Writing the bytes is concurrency-safe (each uses a distinct assetId); we
    // apply the data mutations atomically ONCE after the queue drains.
    const createdSources: Source[] = [];
    const createdAssetEntries: AssetIndexEntry[] = [];

    const results = await ingestPdfBinaries(
      files,
      async ({ name, bytes, versionHash }) => {
        const existing = this.data.sources.find((s) => s.versionHash === versionHash);
        if (existing) {
          await this.storage.writeAsset(
            this.data.manifest.brainId,
            existing.assetId,
            bytes,
          );
          this.offloadedAssetIds.delete(existing.assetId);
          return { status: "hydrated", sourceId: existing.id };
        }
        const assetId = newAssetId();
        const source: Source = {
          id: newSourceId(),
          kind: "pdf",
          title: name,
          assetId,
          versionHash,
          // pageCount 0: the batch queue is PURE / DOM-free and cannot run
          // pdf.js to count pages. The queue's primary role is HYDRATING
          // existing Sources (which already carry the real pageCount); a
          // freshly CREATED source is backfilled with the true page count when
          // it is first opened in the Reader (which does run pdf.js). Threading
          // pdf.js into this pure queue would couple it to the DOM and defeat
          // its unit-testability, so 0 is the deliberate placeholder here.
          pageCount: 0,
          importedAt: new Date().toISOString(),
          category: "Uncategorized",
        };
        await this.storage.writeAsset(this.data.manifest.brainId, assetId, bytes);
        createdSources.push(source);
        createdAssetEntries.push({
          assetId,
          contentType: "application/pdf",
          byteLength: bytes.byteLength,
          contentHash: versionHash,
        });
        return { status: "created", sourceId: source.id };
      },
      options,
    );

    if (createdSources.length > 0) {
      this.data = {
        ...this.data,
        sources: [...this.data.sources, ...createdSources],
        manifest: {
          ...this.data.manifest,
          assetIndex: [...this.data.manifest.assetIndex, ...createdAssetEntries],
        },
      };
      await this.persist();
    }
    return results.map((r) =>
      r.reason === undefined
        ? { sourceId: r.sourceId, status: r.status }
        : { sourceId: r.sourceId, status: r.status, reason: r.reason },
    );
  }

  /**
   * Sources grouped by category, sorted for the library list (spec section 5).
   * When the active category scope is set, only that category is returned — the
   * same scope the Reader/workspace carries across transitions (N03, N08).
   */
  librarySections(sortBy: "title" | "importedAt" = "title"): {
    category: string;
    sources: Source[];
  }[] {
    const byCategory = new Map<string, Source[]>();
    for (const s of this.data.sources) {
      if (this.activeCategoryScope != null && s.category !== this.activeCategoryScope)
        continue;
      const list = byCategory.get(s.category) ?? [];
      list.push(s);
      byCategory.set(s.category, list);
    }
    const sections = [...byCategory.entries()].map(([category, sources]) => ({
      category,
      sources: sources.slice().sort((a, b) =>
        sortBy === "title"
          ? a.title.localeCompare(b.title)
          : a.importedAt.localeCompare(b.importedAt),
      ),
    }));
    sections.sort((a, b) => a.category.localeCompare(b.category));
    return sections;
  }

  /** All distinct library category names present, sorted (for scope controls). */
  categories(): string[] {
    return [...new Set(this.data.sources.map((s) => s.category))].sort((a, b) =>
      a.localeCompare(b),
    );
  }

  /** Open one document in the reading workspace (double-click/tap). */
  openSource(sourceId: SourceId): void {
    this.openSourceIds = [sourceId];
  }

  /**
   * Open several documents TOGETHER in a shared workspace. This performs NO
   * automatic analysis — it only places them side by side (spec section 5).
   */
  openTogether(sourceIds: readonly SourceId[]): void {
    this.openSourceIds = [...sourceIds];
  }

  /**
   * Ensure a source is open WITHOUT closing any other pane (used by
   * source-return so following a quote into a not-yet-open source adds it
   * alongside the subject + other sources, never replacing them). Idempotent:
   * a source already open is left in place and not duplicated.
   */
  ensureSourceOpen(sourceId: SourceId): void {
    if (this.openSourceIds.includes(sourceId)) return;
    this.openSourceIds = [...this.openSourceIds, sourceId];
  }

  closeWorkspace(): void {
    this.openSourceIds = [];
    this.openSubjectPageId = null;
  }

  /** Open a subject page for composition. Does NOT close any open source. */
  openSubjectPage(pageId: PageId): void {
    this.openSubjectPageId = pageId;
  }

  /** Close the open subject page, leaving any open source reader in place. */
  closeSubjectPage(): void {
    this.openSubjectPageId = null;
  }

  // -- highlights tab / motion ---------------------------------------------

  /** Open/close the highlights tab. Closed reserves ZERO sidebar width (R18). */
  setHighlightsTabOpen(open: boolean): void {
    this.highlightsTabOpen = open;
  }

  setSuppressMotion(suppress: boolean): void {
    this.suppressMotion = suppress;
  }

  /**
   * The top-level Files/Nodes view (§3.3, FEAT-005). SESSION VIEW STATE: it is
   * preserved across in-session transitions and writes NO durable record
   * (relates D19). Default 'files'.
   */
  viewMode(): ViewMode {
    return this.view;
  }

  /** Switch the top-level Files/Nodes view. View state only — no record write. */
  setViewMode(mode: ViewMode): void {
    this.view = mode;
  }

  /**
   * The explicit Nodes-view locate target (N04/N05, FEAT-004) or null. Pure
   * getter over transient session state — never persisted.
   */
  focusedPageId(): PageId | null {
    return this.focusedPage;
  }

  /**
   * Set (or clear with null) the explicit locate camera-focus target for the
   * Nodes view (N04/N05). VIEW STATE ONLY: writes no durable record and never
   * persists. This MUST be called ONLY from explicit locate actions ("Show in
   * Nodes" / the destination picker) — ordinary editing transitions never call
   * it, which preserves A09-M2 (no unexpected camera jumps during editing).
   */
  setFocusedPageId(pageId: PageId | null): void {
    this.focusedPage = pageId;
  }

  /**
   * Whether the Nodes (concept-network) view is active vs the Files view. This
   * now DERIVES from the formal FEAT-005 `viewMode` — FEAT-004 introduced a
   * transient flag which FEAT-005 superseded with the proper view switch, so
   * the two stay in lockstep and the earlier callers keep working.
   */
  nodesViewActive(): boolean {
    return this.view === "nodes";
  }

  /** Toggle the Nodes view by setting the formal viewMode (view state only). */
  setNodesViewActive(active: boolean): void {
    this.view = active ? "nodes" : "files";
  }

  /**
   * Set a relationship's human label (the "Connecting Page" surface for M2,
   * FEAT-004 step 1). This edits the durable Relationship's label field only —
   * it never changes endpoints, never creates/deletes a record. Persists.
   */
  async setRelationshipLabel(relationshipId: RelationshipId, label: string): Promise<void> {
    const idx = this.data.relationships.findIndex((r) => r.id === relationshipId);
    if (idx < 0) return;
    const prev = this.data.relationships[idx]!;
    if (prev.label === label) return;
    const updated: Relationship = { ...prev, label };
    const relationships = this.data.relationships.slice();
    relationships[idx] = updated;
    this.data = { ...this.data, relationships };
    await this.persist();
    await this.logChange("relationship", "relationship-label", `Labelled a connection “${label}”`, [relationshipId]);
  }

  /**
   * The explanatory ("Connecting Page") page id of a relationship, if one has
   * been developed via `developRelationshipPage` (A13-M2). Pure getter —
   * returns null when the relationship is unknown or has no explanatory page.
   */
  explanatoryPageId(relationshipId: RelationshipId): PageId | null {
    const rel = this.data.relationships.find((r) => r.id === relationshipId);
    return rel?.explanatoryPageId ?? null;
  }

  /**
   * Develop a relationship's short connection into a FULL Connecting Page
   * (A13-M2, §12.1, §20): "Short connection explanation can develop into a page
   * and connect further subjects." This LAZILY creates (or returns the existing)
   * real subject Page linked via `Relationship.explanatoryPageId`, seeded from
   * the relationship's label (falling back to the joined endpoint titles, or
   * "Connection" when neither is available), and opens it in the SubjectEditor.
   *
   * IDEMPOTENT: if the relationship already has an `explanatoryPageId` and that
   * Page still exists, it is opened and returned unchanged (no second Page is
   * created). Because the explanatory page has a real PageId it can be passed to
   * `createRelationship([...])` as an endpoint — connecting a connection to
   * further subjects — with no special-casing (it flows through the same
   * `relationshipEndpoints` normalizer). Persists.
   */
  async developRelationshipPage(relationshipId: RelationshipId): Promise<PageId> {
    const idx = this.data.relationships.findIndex((r) => r.id === relationshipId);
    if (idx < 0) throw new Error("developRelationshipPage: unknown relationship");
    const rel = this.data.relationships[idx]!;
    const existingId = rel.explanatoryPageId;
    if (existingId != null && this.data.pages.some((p) => p.id === existingId)) {
      this.openSubjectPage(existingId);
      return existingId;
    }
    const title = this.connectingPageTitle(rel);
    const now = new Date().toISOString();
    const page: Page = {
      id: newPageId(),
      kind: "subject",
      title,
      documentJson: emptyDocJson(),
      createdAt: now,
      updatedAt: now,
    };
    const updatedRel: Relationship = { ...rel, explanatoryPageId: page.id };
    const relationships = this.data.relationships.slice();
    relationships[idx] = updatedRel;
    this.data = {
      ...this.data,
      pages: [...this.data.pages, page],
      relationships,
    };
    await this.persist();
    this.openSubjectPage(page.id);
    return page.id;
  }

  /**
   * Seed a Connecting Page's title from a relationship: prefer its short label;
   * else join the endpoint page titles with " ↔ "; else fall back to the
   * literal "Connection". Pure helper — no side effects.
   */
  private connectingPageTitle(rel: Relationship): string {
    const label = rel.label.trim();
    if (label.length > 0) return label;
    const endpointTitles = relationshipEndpoints(rel)
      .map((id) => this.data.pages.find((p) => p.id === id)?.title)
      .filter((t): t is string => typeof t === "string" && t.length > 0);
    if (endpointTitles.length > 0) return endpointTitles.join(" ↔ ");
    return "Connection";
  }

  // -- workspace layout (pane config + lines) -------------------------------

  /**
   * Set a pane's flex-grow weight (adjustable pane widths, section 8.2). This
   * is presentation-only view state that transitions preserve (R19); it never
   * writes a durable record. Weights are clamped to a sane minimum so a pane
   * can be made narrow but never collapsed away while composing.
   */
  setPaneWidth(slotId: string, weight: number): void {
    const clamped = Math.max(0.15, weight);
    this.workspaceLayout = {
      ...this.workspaceLayout,
      paneWidths: { ...this.workspaceLayout.paneWidths, [slotId]: clamped },
    };
  }

  /** The flex-grow weight for a pane slot (defaults to 1). */
  paneWidth(slotId: string): number {
    return this.workspaceLayout.paneWidths[slotId] ?? 1;
  }

  /**
   * Toggle passage-to-evidence line visibility. This changes PRESENTATION ONLY
   * and NEVER deletes a relationship / evidence instance (A08/R08 foundation).
   * The underlying lines remain derivable from `passageEvidenceLines()` whether
   * or not they are drawn.
   */
  setLinesVisible(visible: boolean): void {
    this.workspaceLayout = { ...this.workspaceLayout, linesVisible: visible };
  }

  linesVisible(): boolean {
    return this.workspaceLayout.linesVisible;
  }

  /**
   * Switch ONE reader pane to a different (possibly third) paper while keeping
   * the same subject open and the other panes untouched (section 8.2 note).
   * Preserves pane order; only the targeted slot changes source. Does not close
   * or replace the subject page.
   */
  switchReaderPane(fromSourceId: SourceId, toSourceId: SourceId): void {
    const idx = this.openSourceIds.indexOf(fromSourceId);
    if (idx < 0) return;
    if (toSourceId === fromSourceId) return;
    const next = this.openSourceIds.slice();
    next[idx] = toSourceId;
    // Avoid duplicating one paper into two panes: if the target was already
    // open in a different pane, drop that other occurrence so the swap replaces
    // in place rather than showing the same source twice.
    const dupAt = next.indexOf(toSourceId);
    if (dupAt !== idx && dupAt !== -1) next.splice(dupAt, 1);
    this.openSourceIds = next;
    // Carry the old pane's width weight onto the new source slot so the layout
    // configuration is preserved across the swap (R19).
    const prevWeight = this.workspaceLayout.paneWidths[fromSourceId];
    if (prevWeight != null) this.setPaneWidth(toSourceId, prevWeight);
  }

  /**
   * M14–M16 (FEAT-001) move an already-open source to the FRONT of the open
   * set so it becomes the single visible PDF pane in the compact <1360px
   * 2-pane layout (Paper B's 1-click quick-swap tab). Both sources remain open
   * — unlike {@link switchReaderPane} it never drops a source — so the swap is
   * fully reversible by tapping the (now re-labelled) tab again. No-op when the
   * source is not open or is already at the front. View state only.
   */
  promoteOpenSource(sourceId: SourceId): void {
    const idx = this.openSourceIds.indexOf(sourceId);
    if (idx <= 0) return;
    const next = this.openSourceIds.slice();
    const [moved] = next.splice(idx, 1);
    next.unshift(moved!);
    this.openSourceIds = next;
  }

  // -- library category scope ----------------------------------------------

  /**
   * Set the active library category scope (a category name) or null for "all".
   * A VIEW filter preserved across Library/Reader/workspace transitions (N03,
   * N08); it changes no durable records.
   */
  setCategoryScope(category: string | null): void {
    this.activeCategoryScope = category;
  }

  categoryScope(): string | null {
    return this.activeCategoryScope;
  }

  // -- passage-to-evidence lines (section 10.2) -----------------------------

  /**
   * The passage-to-evidence line DATA for the current editing state (section
   * 10.2): one line per evidence instance in the OPEN subject page that cites
   * an annotation whose source is OPEN in a reader pane. These relate sources
   * to the current page/evidence. The returned set is independent of whether
   * lines are currently drawn (the visibility toggle is presentation-only), so
   * hiding lines never removes a relationship (A08/R08 foundation).
   */
  passageEvidenceLines(): PassageEvidenceLine[] {
    const pageId = this.openSubjectPageId;
    if (!pageId) return [];
    const lines: PassageEvidenceLine[] = [];
    for (const ev of this.data.evidenceInstances) {
      if (ev.destinationPageId !== pageId) continue;
      const annotation = this.data.annotations.find((a) => a.id === ev.annotationId);
      if (!annotation) continue;
      if (!this.openSourceIds.includes(annotation.sourceId)) continue;
      const sourcePageIndex =
        annotation.scope.kind === "pages"
          ? annotation.scope.anchor.startPageIndex
          : annotation.scope.anchor.pageIndex;
      lines.push({
        evidenceId: ev.id,
        annotationId: annotation.id,
        sourceId: annotation.sourceId,
        destinationPageId: pageId,
        sourcePageIndex,
        quotedText: ev.quotedText,
      });
    }
    return lines;
  }

  /**
   * Tentative (DOTTED) passage->page links: annotations associated with the open
   * subject page that have NOT been quoted into it yet. A pair that already has
   * an EvidenceInstance is solid and is covered by passageEvidenceLines(), so it
   * is skipped here. Presentation data only, like its solid counterpart.
   */
  passageAssociationLines(): {
    associationId: string;
    annotationId: AnnotationId;
    sourceId: SourceId;
    sourcePageIndex: number;
  }[] {
    const pageId = this.openSubjectPageId;
    if (!pageId) return [];
    const out: ReturnType<Workbench["passageAssociationLines"]> = [];
    for (const assoc of this.data.subjectAssociations) {
      if (assoc.destinationPageId !== pageId) continue;
      const quoted = this.data.evidenceInstances.some(
        (e) => e.annotationId === assoc.annotationId && e.destinationPageId === pageId,
      );
      if (quoted) continue;
      const annotation = this.data.annotations.find((a) => a.id === assoc.annotationId);
      if (!annotation || !this.openSourceIds.includes(annotation.sourceId)) continue;
      out.push({
        associationId: assoc.id,
        annotationId: annotation.id,
        sourceId: annotation.sourceId,
        sourcePageIndex:
          annotation.scope.kind === "pages"
            ? annotation.scope.anchor.startPageIndex
            : annotation.scope.anchor.pageIndex,
      });
    }
    return out;
  }

  /** Test-only: force the next `count` persist() calls to fail (R12 path). */
  forceNextSaveFailures(count: number): void {
    this.failNextSaves = count;
  }

  /**
   * Test-only: simulate a source EDITION change by mutating a source's stored
   * version hash. Existing annotations keep their original anchor hash, so
   * source-return must then report an explicit `mismatched` state (A17). This
   * exercises the real resolution path without needing a second fixture build.
   */
  async forceSourceVersionDrift(sourceId: SourceId): Promise<void> {
    const idx = this.data.sources.findIndex((s) => s.id === sourceId);
    if (idx < 0) return;
    const sources = this.data.sources.slice();
    sources[idx] = { ...sources[idx]!, versionHash: `${sources[idx]!.versionHash}-DRIFTED` };
    this.data = { ...this.data, sources };
    await this.persist();
  }

  // -- annotations ----------------------------------------------------------

  /**
   * Commit a text-level highlight/underline. Produces an Annotation with an
   * EMPTY comment (quiet by default) and NO node/page/category. Persists.
   */
  async commitTextAnnotation(input: CommitTextAnnotationInput): Promise<AnnotationView> {
    const now = new Date().toISOString();
    const annotation: Annotation = {
      id: newAnnotationId(),
      sourceId: input.sourceId,
      scope: { kind: "text", anchor: input.anchor },
      resolution: { kind: "resolved" },
      comment: "",
      createdAt: now,
      updatedAt: now,
    };
    const style = input.style ?? DEFAULT_STYLE;
    this.data = {
      ...this.writeStyle(this.data, annotation.id, style),
      annotations: [...this.data.annotations, annotation],
    };
    await this.persist();
    return this.viewFor(annotation.id)!;
  }

  /**
   * Commit a continuous page-range annotation (one logical identity across
   * startPageIndex..endPageIndex). Each page shows a highlight BORDER; one
   * shared comment; displays "pp. X-Y". Micro-highlights inside stay separate.
   */
  async commitRangeAnnotation(
    input: CommitRangeAnnotationInput,
  ): Promise<AnnotationView> {
    if (input.endPageIndex < input.startPageIndex) {
      throw new Error("range end must be >= start");
    }
    const source = this.data.sources.find((s) => s.id === input.sourceId);
    if (!source) throw new Error("range annotation: unknown source");
    const now = new Date().toISOString();
    const anchor: ScopeAnchor = {
      docId: input.sourceId,
      sourceVersionHash: source.versionHash,
      startPageIndex: input.startPageIndex,
      endPageIndex: input.endPageIndex,
    };
    const annotation: Annotation = {
      id: newAnnotationId(),
      sourceId: input.sourceId,
      scope: { kind: "pages", anchor },
      resolution: { kind: "resolved" },
      comment: "",
      createdAt: now,
      updatedAt: now,
    };
    this.data = {
      ...this.writeStyle(this.data, annotation.id, input.style ?? DEFAULT_STYLE),
      annotations: [...this.data.annotations, annotation],
    };
    await this.persist();
    return this.viewFor(annotation.id)!;
  }

  /**
   * Immutably set an annotation's style in `presentation.annotationStyles`,
   * keyed by annotation id. Stores a plain {kind, color} record (the model's
   * AnnotationStyleRecord; strokeWidth is an optional/unused §14 refinement).
   * Returns new BrainData; never mutates in place.
   */
  private writeStyle(
    data: BrainData,
    id: AnnotationId,
    style: AnnotationStyle,
  ): BrainData {
    const existing = data.presentation.annotationStyles ?? {};
    return {
      ...data,
      presentation: {
        ...data.presentation,
        annotationStyles: { ...existing, [id]: { kind: style.kind, color: style.color } },
      },
    };
  }

  /** Read an annotation's style, or DEFAULT_STYLE when none is stored. */
  private readStyle(id: AnnotationId): AnnotationStyle {
    const rec = this.data.presentation.annotationStyles?.[id];
    if (!rec) return DEFAULT_STYLE;
    return { kind: rec.kind as HighlightStyle, color: rec.color as HighlightColor };
  }

  /** Change an annotation's highlight style (compact color/kind controls). */
  async setAnnotationStyle(id: AnnotationId, style: AnnotationStyle): Promise<void> {
    if (!this.data.annotations.some((a) => a.id === id)) return;
    this.data = this.writeStyle(this.data, id, style);
    await this.persist();
  }

  /**
   * Set an annotation's quiet comment. The empty string is valid (clears it).
   * On a persistence failure the in-memory comment is retained and a SaveError
   * is surfaced (R12) — we never fake a saved state.
   */
  async setComment(id: AnnotationId, comment: string): Promise<void> {
    const idx = this.data.annotations.findIndex((a) => a.id === id);
    if (idx < 0) return;
    const prev = this.data.annotations[idx]!;
    if (prev.comment === comment) return;
    const updated: Annotation = {
      ...prev,
      comment,
      updatedAt: new Date().toISOString(),
    };
    const annotations = this.data.annotations.slice();
    annotations[idx] = updated;
    this.data = { ...this.data, annotations };
    await this.persist();
    await this.logChange("annotation-comment", "annotation-comment", comment.trim() === "" ? "Cleared a highlight comment" : `Commented on a highlight: ${comment.trim().slice(0, 80)}`, [id]);
  }

  /** Delete an annotation and its style. Associating/citing never calls this. */
  async deleteAnnotation(id: AnnotationId): Promise<void> {
    const { [id]: _removed, ...remainingStyles } =
      this.data.presentation.annotationStyles ?? {};

    // Every evidence instance that quotes this annotation, by destination page,
    // so we can also strip the matching inline atoms from each page document.
    const doomedEvidence = this.data.evidenceInstances.filter(
      (e) => e.annotationId === id,
    );
    const now = new Date().toISOString();
    const pages = this.data.pages.map((page) => {
      const onThisPage = doomedEvidence.filter((e) => e.destinationPageId === page.id);
      if (onThisPage.length === 0) return page;
      let state = hydrateState((page.documentJson as DocumentJson) ?? emptyDocJson());
      for (const ev of onThisPage) state = removeEvidenceNode(state, ev.id);
      return { ...page, documentJson: serializeState(state), updatedAt: now };
    });

    this.data = {
      ...this.data,
      annotations: this.data.annotations.filter((a) => a.id !== id),
      evidenceInstances: this.data.evidenceInstances.filter((e) => e.annotationId !== id),
      subjectAssociations: this.data.subjectAssociations.filter(
        (a) => a.annotationId !== id,
      ),
      pages,
      presentation: { ...this.data.presentation, annotationStyles: remainingStyles },
    };
    await this.persist();
  }

  // -- two-mode highlight deletion (D02) ------------------------------------

  /**
   * D02 "delete highlight only": remove the Annotation record + its style but
   * PRESERVE every EvidenceInstance that quotes it AND the inline evidence
   * atom(s) in any Subject Page documentJson. The quoted text survives verbatim
   * in the page; the (annotation, destination) pair then derives as
   * "unresolved" with reason "source annotation no longer exists" purely
   * because the annotation record is gone (resolveEvidenceSource already does
   * this once the annotation vanishes). SubjectAssociations for the annotation
   * are removed with it (they are reader-side intent that cannot outlive the
   * annotation), but NO evidence is deleted. A no-op for an unknown id.
   */
  async deleteAnnotationOnly(id: AnnotationId): Promise<void> {
    if (!this.data.annotations.some((a) => a.id === id)) return;
    const { [id]: _removed, ...remainingStyles } =
      this.data.presentation.annotationStyles ?? {};
    this.data = {
      ...this.data,
      annotations: this.data.annotations.filter((a) => a.id !== id),
      // Evidence + inline atoms are intentionally UNTOUCHED (the quote lives on).
      subjectAssociations: this.data.subjectAssociations.filter(
        (a) => a.annotationId !== id,
      ),
      presentation: { ...this.data.presentation, annotationStyles: remainingStyles },
    };
    await this.persist();
  }

  /**
   * D02 "delete highlight and its quotes": a DESTRUCTIVE deletion that FIRST
   * records a reconstructable Revision snapshot of every affected Subject Page
   * (its documentJson BEFORE mutation) so the removal can be reviewed/reverted,
   * THEN deletes the Annotation + its style, deletes the matching
   * EvidenceInstance records, and strips ONLY the matching inline `evidence`
   * atom node(s) from each affected page via the existing removeEvidenceNode
   * helper — surrounding prose and any OTHER quotes in the same page are
   * preserved exactly. Persists once. A no-op for an unknown id.
   */
  async deleteAnnotationAndQuotes(id: AnnotationId): Promise<void> {
    if (!this.data.annotations.some((a) => a.id === id)) return;

    // Evidence instances that quote this annotation, grouped by their page.
    const doomedEvidence = this.data.evidenceInstances.filter(
      (e) => e.annotationId === id,
    );
    const doomedEvidenceIds = new Set(doomedEvidence.map((e) => e.id));
    const affectedPageIds = new Set(doomedEvidence.map((e) => e.destinationPageId));

    // (1) Snapshot each affected page's documentJson BEFORE mutating, so the
    // revision is reconstructable. Only pages that actually hold a matching
    // atom are affected; a page could be missing (evidence without a page) so
    // we filter to real pages.
    const affectedPages = this.data.pages.filter((p) => affectedPageIds.has(p.id));
    const now = new Date().toISOString();
    const revisions = this.data.revisions.slice();
    if (affectedPages.length > 0) {
      const revision: Revision = {
        id: newRevisionId(),
        publicationRevision: this.data.manifest.publicationRevision,
        label: "delete-highlight-and-quotes",
        createdAt: now,
        affectedObjectIds: affectedPages.map((p) => p.id),
        beforeSnapshot: affectedPages.map((p) => ({
          pageId: p.id,
          documentJson: structuredClone(p.documentJson),
        })),
        summary: `Deleted annotation ${id} and its ${doomedEvidence.length} quote(s) across ${affectedPages.length} page(s)`,
      };
      revisions.push(revision);
    }

    // (2) Strip ONLY the matching inline evidence atoms from each affected page.
    const pages = this.data.pages.map((page) => {
      if (!affectedPageIds.has(page.id)) return page;
      const evidenceOnThisPage = doomedEvidence.filter(
        (e) => e.destinationPageId === page.id,
      );
      let state = hydrateState((page.documentJson as DocumentJson) ?? emptyDocJson());
      for (const ev of evidenceOnThisPage) {
        state = removeEvidenceNode(state, ev.id);
      }
      return {
        ...page,
        documentJson: serializeState(state),
        updatedAt: now,
      };
    });

    // (3) Delete the annotation + its style + the matching evidence + the
    // annotation's reader-side associations. Persist once.
    const { [id]: _removed, ...remainingStyles } =
      this.data.presentation.annotationStyles ?? {};
    this.data = {
      ...this.data,
      annotations: this.data.annotations.filter((a) => a.id !== id),
      evidenceInstances: this.data.evidenceInstances.filter(
        (e) => !doomedEvidenceIds.has(e.id),
      ),
      subjectAssociations: this.data.subjectAssociations.filter(
        (a) => a.annotationId !== id,
      ),
      pages,
      revisions,
      presentation: { ...this.data.presentation, annotationStyles: remainingStyles },
    };
    await this.persist();
  }

  // -- subject pages + association/citation state machine -------------------

  /**
   * Create a subject page with an EMPTY composition. Creating a subject is an
   * explicit user action and is NEVER triggered by importing or annotating. A
   * subject page requires NO notebook/folder/parent (spec section 3).
   */
  async createSubjectPage(title: string): Promise<Page> {
    const now = new Date().toISOString();
    const page: Page = {
      id: newPageId(),
      kind: "subject",
      title,
      documentJson: emptyDocJson(),
      createdAt: now,
      updatedAt: now,
    };
    this.data = { ...this.data, pages: [...this.data.pages, page] };
    await this.persist();
    await this.logChange("other", "page-created", `Created page “${title}”`, [page.id]);
    return page;
  }

  /**
   * DELIBERATE subject creation from selected source evidence (spec section
   * 4.2): the user explicitly turns an annotation into a new subject Page whose
   * composition OPENS with that evidence already cited. This is the only way a
   * subject is born from reading; nothing auto-creates it.
   *
   * The created page's document contains the typed evidence node (so the quote
   * is really composed in) and a provenance-bearing EvidenceInstance is
   * recorded, so the (annotation, page) pair derives straight to SOLID — a
   * direct deliberate citation may go source-local -> solid with no prior
   * tentative association (R06).
   */
  async createSubjectFromAnnotation(
    title: string,
    annotationId: AnnotationId,
    opts: { includeComment?: boolean } = {},
  ): Promise<{ page: Page; evidence: EvidenceInstance }> {
    const page = await this.createSubjectPage(title);
    const evidence = await this.insertEvidenceIntoPage(annotationId, page.id, {
      pos: null,
      includeComment: opts.includeComment ?? false,
    });
    return { page, evidence };
  }

  /**
   * M13 (§2.1(1)) PROMOTE a Memory (a reader Note / Highlight / Area figure)
   * into an OBSERVATION NODE on the Nodes canvas. A Memory lives inside the PDF
   * reader first and never auto-clutters the canvas; when one grows into an idea
   * of its own the user escalates it into a first-class node. An Observation
   * Node is simply a subject `Page` (there is NO distinct node record type — the
   * canvas renders subject pages as nodes), so this creates that page and
   * inserts the annotation as provenance-bearing evidence so the new node CITES
   * the Memory it was promoted from (the (annotation, page) pair derives to
   * SOLID). Modelled on {@link createSubjectFromAnnotation}; the source
   * annotation is never moved or deleted.
   */
  async promoteAnnotationToNode(
    annotationId: AnnotationId,
    opts: { title?: string; includeComment?: boolean } = {},
  ): Promise<{ page: Page; evidence: EvidenceInstance }> {
    const annotation = this.data.annotations.find((a) => a.id === annotationId);
    if (!annotation) throw new Error("promoteAnnotationToNode: unknown annotation");
    // Seed a readable node title from the promoted Memory's quoted text.
    const snippet = quotedTextForScope(annotation).trim().slice(0, 60);
    const title = opts.title ?? (snippet.length > 0 ? snippet : "Observation Node");
    const now = new Date().toISOString();
    const page: Page = {
      id: newPageId(),
      kind: "subject",
      title,
      documentJson: emptyDocJson(),
      createdAt: now,
      updatedAt: now,
    };
    this.data = { ...this.data, pages: [...this.data.pages, page] };
    await this.persist();
    await this.logChange(
      "other",
      "page-created",
      `Promoted a highlight into node “${title}”`,
      [page.id],
    );
    // Cite the promoted annotation into the new node (SOLID).
    const evidence = await this.insertEvidenceIntoPage(annotationId, page.id, {
      pos: null,
      includeComment: opts.includeComment ?? false,
    });
    return { page, evidence };
  }

  /**
   * M14–M16 (FEAT-001) DIRECT highlight-to-highlight linking. Dragging one
   * highlight fragment onto another (or the "Link with another highlight…"
   * action) synthesises an OBSERVATION NODE — an ordinary subject `Page` — that
   * cites BOTH highlights as provenance-bearing EvidenceInstances, with a
   * bridging-note commentary paragraph inserted BETWEEN the two cited quotes so
   * the user can annotate the connection. Because the new node cites two
   * evidence instances it derives straight to the "observation" tier (filled
   * dot), never a hollow memory. Both source annotations are left untouched.
   *
   * The page is opened + selected so the user lands in the editor ready to
   * write the bridge. Modelled on {@link promoteAnnotationToNode}; one logical
   * creation + two citations, each persisting through the adapter. Returns the
   * new page id.
   */
  async linkHighlightsToObservation(
    fromAnnotationId: AnnotationId,
    toAnnotationId: AnnotationId,
    opts: { title?: string } = {},
  ): Promise<PageId> {
    const from = this.data.annotations.find((a) => a.id === fromAnnotationId);
    const to = this.data.annotations.find((a) => a.id === toAnnotationId);
    if (!from) throw new Error("linkHighlightsToObservation: unknown from-annotation");
    if (!to) throw new Error("linkHighlightsToObservation: unknown to-annotation");

    const fromSnippet = quotedTextForScope(from).trim().slice(0, 32);
    const toSnippet = quotedTextForScope(to).trim().slice(0, 32);
    const title =
      opts.title ??
      (fromSnippet.length > 0 && toSnippet.length > 0
        ? `${fromSnippet} ↔ ${toSnippet}`
        : "Linked observation");

    const now = new Date().toISOString();
    const page: Page = {
      id: newPageId(),
      kind: "subject",
      title,
      documentJson: emptyDocJson(),
      createdAt: now,
      updatedAt: now,
    };
    this.data = { ...this.data, pages: [...this.data.pages, page] };
    await this.persist();
    await this.logChange(
      "other",
      "page-created",
      `Linked two highlights into observation “${title}”`,
      [page.id, fromAnnotationId, toAnnotationId],
    );

    // Cite the first highlight (appended at the end of the empty doc).
    await this.insertEvidenceIntoPage(fromAnnotationId, page.id, { pos: null });

    // Insert a bridging-note commentary paragraph BETWEEN the quotes, then cite
    // the second highlight AFTER it. Re-hydrate the live doc each step so the
    // positions reflect the growing document.
    const bridgeState = hydrateState(this.subjectDocJson(page.id));
    const afterFirst = bridgeState.doc.content.size;
    const bridged = insertBridgingNoteAt(bridgeState, afterFirst, "");
    await this.saveSubjectDoc(page.id, serializeState(bridged));

    // Cite the second highlight at the end (after the bridging note).
    await this.insertEvidenceIntoPage(toAnnotationId, page.id, { pos: null });

    // Open + select the new Observation Node so the user can write the bridge.
    this.openSubjectPage(page.id);
    return page.id;
  }

  /** The stored ProseMirror document JSON for a subject page (source of truth). */
  subjectDocJson(pageId: PageId): DocumentJson {
    const page = this.data.pages.find((p) => p.id === pageId);
    if (!page) throw new Error("subjectDocJson: unknown page");
    return (page.documentJson as DocumentJson) ?? emptyDocJson();
  }

  /**
   * Register the live ProseMirror editor's doc getter for an open subject page.
   * While a page is open in the editor its on-screen doc can hold newer,
   * not-yet-persisted text than stored documentJson. External mutations (insert
   * evidence from the reader, move a block) first fold that live doc into the
   * stored JSON via pullLiveDoc so they operate on the real current content and
   * never wipe unsaved typing. Returns a detach function the editor calls on
   * unmount. Only one provider per page; a re-attach replaces the prior one.
   */
  attachLiveDoc(pageId: PageId, getDoc: () => DocumentJson): () => void {
    this.liveDocs.set(pageId, getDoc);
    return () => {
      // Only detach if we are still the registered provider for this page.
      if (this.liveDocs.get(pageId) === getDoc) this.liveDocs.delete(pageId);
    };
  }

  /**
   * Fold the live editor doc (if one is attached for this page) into stored
   * documentJson so a subsequent structural mutation starts from the newest
   * content. Does NOT persist by itself (the caller persists once as part of
   * its own write). A no-op when no live provider is attached or the page is
   * unknown.
   */
  private pullLiveDoc(pageId: PageId): void {
    const getDoc = this.liveDocs.get(pageId);
    if (!getDoc) return;
    const idx = this.data.pages.findIndex((p) => p.id === pageId);
    if (idx < 0) return;
    let live: DocumentJson;
    try {
      live = getDoc();
    } catch {
      return; // a detached/disposed editor should never break a model write
    }
    const canonical = serializeState(hydrateState(live));
    const prev = this.data.pages[idx]!;
    const pages = this.data.pages.slice();
    pages[idx] = { ...prev, documentJson: canonical };
    this.data = { ...this.data, pages };
  }

  /**
   * Persist a subject page's composition from structured document JSON. The
   * JSON is the durable source of truth (NOT the editor HTML/DOM); it is
   * re-hydrated + re-serialized here so a malformed doc is rejected and so the
   * stored value is canonical for byte-equivalent round-trips (R14).
   */
  async saveSubjectDoc(pageId: PageId, json: DocumentJson): Promise<void> {
    const idx = this.data.pages.findIndex((p) => p.id === pageId);
    if (idx < 0) throw new Error("saveSubjectDoc: unknown page");
    const state = hydrateState(json);
    const canonical = serializeState(state);
    const prev = this.data.pages[idx]!;
    const updated: Page = {
      ...prev,
      documentJson: canonical,
      updatedAt: new Date().toISOString(),
    };
    const pages = this.data.pages.slice();
    pages[idx] = updated;
    // Reconcile the EvidenceInstance records for this page with the evidence
    // atoms actually present in the saved doc BEFORE building the next state so
    // a quote removed in the editor drops its instance (solid -> none/tentative)
    // and a cut-then-pasted quote restores its instance.
    const reconciledEvidence = this.reconcileEvidenceForPage(
      pageId,
      collectEvidence(state.doc),
    );
    this.data = { ...this.data, pages, evidenceInstances: reconciledEvidence };
    await this.persist();
  }

  /**
   * Reconcile EvidenceInstance records for a single subject page against the
   * `evidence` atoms actually present in its document. EvidenceInstances for
   * this page whose atom is gone are dropped; atoms whose EvidenceInstance is
   * missing (e.g. a cut-then-pasted quote, or a quote carried in via an
   * external paste) are restored from the atom's own provenance attrs. Records
   * for OTHER pages are never touched. Returns the next evidenceInstances list.
   */
  private reconcileEvidenceForPage(
    pageId: PageId,
    atoms: readonly EvidenceAttrs[],
  ): readonly EvidenceInstance[] {
    const atomById = new Map<string, EvidenceAttrs>();
    for (const atom of atoms) atomById.set(String(atom.evidenceId), atom);

    // Keep every instance that is either on another page or still has its atom.
    const kept = this.data.evidenceInstances.filter(
      (e) => e.destinationPageId !== pageId || atomById.has(String(e.id)),
    );
    const keptIds = new Set(kept.map((e) => String(e.id)));

    // Restore an instance for any atom on this page that lost its record.
    const now = new Date().toISOString();
    const restored: EvidenceInstance[] = [];
    for (const atom of atoms) {
      const evidenceId = String(atom.evidenceId);
      if (keptIds.has(evidenceId)) continue;
      restored.push({
        id: atom.evidenceId,
        annotationId: atom.annotationId,
        destinationPageId: pageId,
        quotedText: atom.quotedText,
        createdAt: now,
      });
    }
    return [...kept, ...restored];
  }

  /**
   * Build the typed evidence-node attrs for an annotation. The quoted-text
   * snapshot + portable anchor are captured at insertion time so the quote
   * renders without resolving the live source, and source-return can re-resolve
   * on demand. Range annotations carry their pp. label as the snapshot.
   */
  private evidenceAttrsFor(
    annotation: Annotation,
    evidenceId: EvidenceInstance["id"],
    mode: "live" | "copy",
  ): EvidenceAttrs {
    if (annotation.scope.kind === "text") {
      return {
        evidenceId,
        sourceId: annotation.sourceId,
        annotationId: annotation.id,
        quotedText: annotation.scope.anchor.selectedText,
        anchor: annotation.scope.anchor,
        mode,
      };
    }
    if (annotation.scope.kind === "area") {
      // Area annotation: synthesize a minimal text anchor whose page + rect
      // come from the area box so source-return navigates to the right page.
      const a = annotation.scope.anchor;
      const synthetic: TextAnchor = {
        docId: a.docId,
        sourceVersionHash: a.sourceVersionHash,
        pageIndex: a.pageIndex,
        rects: [a.rect],
        selectedText: quotedTextForScope(annotation),
        prefix: "",
        suffix: "",
      };
      return {
        evidenceId,
        sourceId: annotation.sourceId,
        annotationId: annotation.id,
        quotedText: synthetic.selectedText,
        anchor: synthetic,
        mode,
      };
    }
    // Range annotation: synthesize a minimal text anchor so the node's attr
    // shape is uniform. Source-return for a range navigates to its first page.
    const a = annotation.scope.anchor;
    const synthetic: TextAnchor = {
      docId: a.docId,
      sourceVersionHash: a.sourceVersionHash,
      pageIndex: a.startPageIndex,
      rects: [],
      selectedText: `pp. ${a.startPageIndex + 1}-${a.endPageIndex + 1}`,
      prefix: "",
      suffix: "",
    };
    return {
      evidenceId,
      sourceId: annotation.sourceId,
      annotationId: annotation.id,
      quotedText: synthetic.selectedText,
      anchor: synthetic,
      mode,
    };
  }

  /**
   * Insert a provenance-bearing quote for an annotation into a subject page at
   * an explicit position (DOTTED -> SOLID; or source-local -> SOLID for a
   * direct citation with no prior association). This does TWO things atomically:
   *
   *  1. inserts a typed `evidence` node into the page's ProseMirror document at
   *     `pos` (or the end when `pos` is null), the composition side; and
   *  2. records an EvidenceInstance so the (annotation, page) pair derives as
   *     "cited".
   *
   * The source annotation is never moved or deleted (R06). Multiple quotes may
   * cite one pair; removing one must not demote the pair while another remains.
   * Optionally the annotation's comment is copied in, CLEARLY marked as copied
   * and appended after the quote so it never overwrites page writing (4.3).
   */
  async insertEvidenceIntoPage(
    annotationId: AnnotationId,
    destinationPageId: PageId,
    opts: { pos?: number | null; includeComment?: boolean; mode?: "live" | "copy" } = {},
  ): Promise<EvidenceInstance> {
    const annotation = this.data.annotations.find((a) => a.id === annotationId);
    if (!annotation) throw new Error("insertEvidenceIntoPage: unknown annotation");
    // Fold any live unsaved editor content for this page into stored JSON first
    // so the inserted quote lands in the user's current doc, not a stale one.
    this.pullLiveDoc(destinationPageId);
    const pageIdx = this.data.pages.findIndex((p) => p.id === destinationPageId);
    if (pageIdx < 0) throw new Error("insertEvidenceIntoPage: unknown page");

    const evidence: EvidenceInstance = {
      id: newEvidenceInstanceId(),
      annotationId,
      destinationPageId,
      quotedText: quotedTextForScope(annotation),
      createdAt: new Date().toISOString(),
    };

    const attrs = this.evidenceAttrsFor(annotation, evidence.id, opts.mode ?? "live");
    const page = this.data.pages[pageIdx]!;
    const state = hydrateState((page.documentJson as DocumentJson) ?? emptyDocJson());
    const insertOptions = {
      attrs,
      copiedComment: opts.includeComment ? annotation.comment : null,
    };
    const next =
      opts.pos == null
        ? appendEvidence(state, insertOptions)
        : insertEvidenceAt(state, opts.pos, insertOptions);

    const updatedPage: Page = {
      ...page,
      documentJson: serializeState(next),
      updatedAt: new Date().toISOString(),
    };
    const pages = this.data.pages.slice();
    pages[pageIdx] = updatedPage;
    this.data = {
      ...this.data,
      pages,
      evidenceInstances: [...this.data.evidenceInstances, evidence],
    };
    await this.persist();
    await this.logChange("quote-insert", "quote-insert", `Quoted “${evidence.quotedText.slice(0, 80)}” into a page`, [destinationPageId, annotationId]);
    return evidence;
  }

  /**
   * Move a top-level block within a subject page's composition from index
   * `from` to index `to`, preserving order, formatting, quote identities and
   * links (A04). Re-derives + persists the canonical JSON.
   */
  async moveSubjectBlock(pageId: PageId, from: number, to: number): Promise<void> {
    // Fold live unsaved editor content in first so the move reorders the user's
    // current blocks (including freshly typed text) rather than a stale copy.
    this.pullLiveDoc(pageId);
    const page = this.data.pages.find((p) => p.id === pageId);
    if (!page) throw new Error("moveSubjectBlock: unknown page");
    const state = hydrateState((page.documentJson as DocumentJson) ?? emptyDocJson());
    const next = moveBlock(state, from, to);
    await this.saveSubjectDoc(pageId, serializeState(next));
  }

  /**
   * Resolve the live source passage for one evidence instance (source-return,
   * spec section 8.2, A17). Returns the owning annotation's current anchor and a
   * resolution: a changed/missing source version yields an explicit
   * `mismatched`/`unresolved` state, NEVER a silent navigation to unrelated
   * content. Following a quote does not close or replace the subject page.
   */
  resolveEvidenceSource(evidenceId: string):
    | {
        readonly sourceId: SourceId | null;
        readonly anchor: TextAnchor | null;
        readonly scopeStartPageIndex: number;
        readonly resolution: AnchorResolution;
      }
    | null {
    const evidence = this.data.evidenceInstances.find((e) => e.id === evidenceId);
    if (!evidence) return null;
    const annotation = this.data.annotations.find((a) => a.id === evidence.annotationId);
    if (!annotation) {
      return {
        // The annotation record is gone, so there is no real source to point
        // at; a null sourceId is explicit (never a bogus id derived from an
        // unrelated field) so the UI reports "unresolved" rather than
        // navigating somewhere wrong.
        sourceId: null,
        anchor: null,
        scopeStartPageIndex: 0,
        resolution: { kind: "unresolved", reason: "source annotation no longer exists" },
      };
    }
    const source = this.data.sources.find((s) => s.id === annotation.sourceId);
    if (!source) {
      return {
        sourceId: annotation.sourceId,
        anchor: null,
        scopeStartPageIndex: 0,
        resolution: { kind: "unresolved", reason: "source document not available" },
      };
    }
    const expectedHash =
      annotation.scope.kind === "text"
        ? annotation.scope.anchor.sourceVersionHash
        : annotation.scope.anchor.sourceVersionHash;
    if (expectedHash !== source.versionHash) {
      return {
        sourceId: annotation.sourceId,
        anchor: annotation.scope.kind === "text" ? annotation.scope.anchor : null,
        scopeStartPageIndex:
          annotation.scope.kind === "pages" ? annotation.scope.anchor.startPageIndex : 0,
        resolution: {
          kind: "mismatched",
          reason: "source version changed since the quote was captured",
          expectedVersionHash: expectedHash,
          actualVersionHash: source.versionHash,
        },
      };
    }
    // Source + annotation intact and the hash matches, but the PDF binary was
    // evicted locally (A17): the citation still FUNCTIONS from stored metadata
    // (quote/comment/page), only the live render is unavailable. Report it as a
    // first-class "binary-offloaded" state rather than pretending it resolved.
    if (this.sourceBinaryStatus(annotation.sourceId) === "binary-offloaded") {
      return {
        sourceId: annotation.sourceId,
        anchor: annotation.scope.kind === "text" ? annotation.scope.anchor : null,
        scopeStartPageIndex:
          annotation.scope.kind === "pages" ? annotation.scope.anchor.startPageIndex : 0,
        resolution: {
          kind: "binary-offloaded",
          reason: "the PDF binary was offloaded locally; re-attach it to view the page",
        },
      };
    }
    return {
      sourceId: annotation.sourceId,
      anchor: annotation.scope.kind === "text" ? annotation.scope.anchor : null,
      scopeStartPageIndex:
        annotation.scope.kind === "pages" ? annotation.scope.anchor.startPageIndex : 0,
      resolution: { kind: "resolved" },
    };
  }

  /** Structural details for a subject page's composition (section 9, A07). */
  compositionStatsForPage(pageId: PageId): CompositionStats {
    const page = this.data.pages.find((p) => p.id === pageId);
    if (!page) throw new Error("compositionStatsForPage: unknown page");
    const state = hydrateState((page.documentJson as DocumentJson) ?? emptyDocJson());
    return compositionStats(state.doc);
  }

  /** Find the document position of an evidence node within a subject page. */
  evidencePosInPage(pageId: PageId, evidenceId: string): number | null {
    const page = this.data.pages.find((p) => p.id === pageId);
    if (!page) return null;
    const state = hydrateState((page.documentJson as DocumentJson) ?? emptyDocJson());
    return findEvidencePos(state.doc, evidenceId);
  }

  /**
   * Tentatively associate an annotation with a subject page (DOTTED). This
   * produces NO page composition change and does not move/delete the source
   * annotation (R05). Idempotent per pair. Commenting never calls this.
   */
  async associateWithSubject(
    annotationId: AnnotationId,
    destinationPageId: PageId,
  ): Promise<SubjectAssociation> {
    const existing = this.data.subjectAssociations.find(
      (a) => a.annotationId === annotationId && a.destinationPageId === destinationPageId,
    );
    if (existing) return existing;
    const assoc: SubjectAssociation = {
      id: newSubjectAssociationId(),
      annotationId,
      destinationPageId,
      createdAt: new Date().toISOString(),
    };
    this.data = {
      ...this.data,
      subjectAssociations: [...this.data.subjectAssociations, assoc],
    };
    await this.persist();
    await this.logChange("tentative-association", "association-created", "Tentatively linked a highlight to a page", [annotationId, destinationPageId]);
    return assoc;
  }

  /** Remove a tentative association for a pair (dotted -> none if no evidence). */
  async removeAssociation(
    annotationId: AnnotationId,
    destinationPageId: PageId,
  ): Promise<void> {
    this.data = {
      ...this.data,
      subjectAssociations: this.data.subjectAssociations.filter(
        (a) =>
          !(a.annotationId === annotationId && a.destinationPageId === destinationPageId),
      ),
    };
    await this.persist();
  }

  /**
   * Legacy direct-citation entry (FEAT-003 path): record an EvidenceInstance
   * for a pair WITHOUT composing the page document. FEAT-004's real insertion
   * is `insertEvidenceIntoPage`; this remains for the reader's quick
   * "Insert into subject page..." action against a not-yet-open page and for
   * the derived-status tests. The pair derives as "cited".
   */
  async insertEvidence(
    annotationId: AnnotationId,
    destinationPageId: PageId,
    quotedText: string,
  ): Promise<EvidenceInstance> {
    // If the page exists, compose the quote into its document too so the model
    // and composition never drift; otherwise just record the instance.
    if (this.data.pages.some((p) => p.id === destinationPageId)) {
      return this.insertEvidenceIntoPage(annotationId, destinationPageId, { pos: null });
    }
    const evidence: EvidenceInstance = {
      id: newEvidenceInstanceId(),
      annotationId,
      destinationPageId,
      quotedText,
      createdAt: new Date().toISOString(),
    };
    this.data = {
      ...this.data,
      evidenceInstances: [...this.data.evidenceInstances, evidence],
    };
    await this.persist();
    return evidence;
  }

  /**
   * Remove one evidence instance AND its node from the destination page's
   * composition. The pair's status is RE-DERIVED: it stays "cited" while
   * another quote remains, otherwise reverts to "tentative" if an association
   * exists, else "none" (ADR-0007).
   */
  async removeEvidence(evidenceId: string): Promise<void> {
    const evidence = this.data.evidenceInstances.find((e) => e.id === evidenceId);
    let pages: readonly Page[] = this.data.pages;
    if (evidence) {
      const pageIdx = this.data.pages.findIndex((p) => p.id === evidence.destinationPageId);
      if (pageIdx >= 0) {
        const page = this.data.pages[pageIdx]!;
        const state = hydrateState((page.documentJson as DocumentJson) ?? emptyDocJson());
        const next = removeEvidenceNode(state, evidenceId);
        const updated: Page = {
          ...page,
          documentJson: serializeState(next),
          updatedAt: new Date().toISOString(),
        };
        const nextPages = this.data.pages.slice();
        nextPages[pageIdx] = updated;
        pages = nextPages;
      }
    }
    this.data = {
      ...this.data,
      pages,
      evidenceInstances: this.data.evidenceInstances.filter((e) => e.id !== evidenceId),
    };
    await this.persist();
    await this.logChange("quote-remove", "quote-remove", "Removed a quote from a page", [evidenceId]);
  }

  // -- derived views --------------------------------------------------------

  /** Derived status for one (annotation, destination) pair. */
  referenceStatus(
    annotationId: AnnotationId,
    destinationPageId: PageId,
  ): SubjectReferenceStatus {
    return deriveSubjectReferenceStatus(
      annotationId,
      destinationPageId,
      this.data.evidenceInstances,
      this.data.subjectAssociations,
    );
  }

  /** All annotations for a source as denormalized views (for the reader). */
  annotationsForSource(sourceId: SourceId): AnnotationView[] {
    return this.data.annotations
      .filter((a) => a.sourceId === sourceId)
      .map((a) => this.viewFor(a.id)!)
      .filter((v): v is AnnotationView => v !== null);
  }

  viewFor(id: AnnotationId): AnnotationView | null {
    const annotation = this.data.annotations.find((a) => a.id === id);
    if (!annotation) return null;
    const style = this.readStyle(id);
    const isRange = annotation.scope.kind === "pages";
    const rangeLabel =
      annotation.scope.kind === "pages"
        ? `pp. ${annotation.scope.anchor.startPageIndex + 1}-${
            annotation.scope.anchor.endPageIndex + 1
          }`
        : null;
    const references = deriveSubjectReferences(
      id,
      this.data.evidenceInstances,
      this.data.subjectAssociations,
    );
    return { annotation, style, isRange, rangeLabel, references };
  }

  /**
   * The subject Page ids an annotation is CITED into (N04/N05/N07): the distinct
   * `destinationPageId`s of the annotation's EvidenceInstances that point at a
   * Page of kind 'subject'. A "cited" pair is exactly one backed by an
   * EvidenceInstance, so this drives the reference-directed locate branching:
   * 0 cited pages => no "Show in Nodes" (N07 precondition false); exactly 1 =>
   * single-subject locate (N04); >1 => the destination picker (N05). Pure read.
   */
  citedSubjectPagesForAnnotation(annotationId: AnnotationId): PageId[] {
    const subjectPageIds = new Set<PageId>(
      this.data.pages.filter((p) => p.kind === "subject").map((p) => p.id),
    );
    const out: PageId[] = [];
    const seen = new Set<PageId>();
    for (const ev of this.data.evidenceInstances) {
      if (ev.annotationId !== annotationId) continue;
      if (!subjectPageIds.has(ev.destinationPageId)) continue;
      if (seen.has(ev.destinationPageId)) continue;
      seen.add(ev.destinationPageId);
      out.push(ev.destinationPageId);
    }
    return out;
  }

  // -- concept network (M2, FEAT-003) ---------------------------------------

  /** The effective color for a category (explicit colorCode or the default). */
  private categoryColor(category: Category): string {
    return category.colorCode ?? DEFAULT_CATEGORY_COLOR;
  }

  /**
   * Create a category with a watercolor color. Creating a category is an
   * explicit user action; it references pages by id and NEVER duplicates a
   * Page. `colorCode` is persisted so the derived hub blendColor is stable.
   */
  async createCategory(
    name: string,
    colorCode: string = DEFAULT_CATEGORY_COLOR,
    memberPageIds: readonly PageId[] = [],
  ): Promise<Category> {
    const category: Category = {
      id: newCategoryId(),
      name,
      memberPageIds: [...memberPageIds],
      createdAt: new Date().toISOString(),
      colorCode,
    };
    this.data = { ...this.data, categories: [...this.data.categories, category] };
    await this.persist();
    await this.logChange("category", "category-created", `Created category “${name}”`, [category.id]);
    return category;
  }

  /**
   * Add a page to a category's membership (idempotent). Membership edits never
   * embed a Page; they only change the set of member ids (A18 foundation).
   */
  async addPageToCategory(categoryId: CategoryId, pageId: PageId): Promise<void> {
    const idx = this.data.categories.findIndex((c) => c.id === categoryId);
    if (idx < 0) return;
    const prev = this.data.categories[idx]!;
    if (prev.memberPageIds.includes(pageId)) return;
    const updated: Category = {
      ...prev,
      memberPageIds: [...prev.memberPageIds, pageId],
    };
    const categories = this.data.categories.slice();
    categories[idx] = updated;
    this.data = { ...this.data, categories };
    await this.persist();
    await this.logChange("category", "category-member-added", "Added a page to a category", [categoryId, pageId]);
  }

  /** Remove a page from a category's membership. Never deletes the Page. */
  async removePageFromCategory(categoryId: CategoryId, pageId: PageId): Promise<void> {
    const idx = this.data.categories.findIndex((c) => c.id === categoryId);
    if (idx < 0) return;
    const prev = this.data.categories[idx]!;
    if (!prev.memberPageIds.includes(pageId)) return;
    const updated: Category = {
      ...prev,
      memberPageIds: prev.memberPageIds.filter((id) => id !== pageId),
    };
    const categories = this.data.categories.slice();
    categories[idx] = updated;
    this.data = { ...this.data, categories };
    await this.persist();
    await this.logChange("category", "category-member-removed", "Removed a page from a category", [categoryId, pageId]);
  }

  /**
   * The DISTINCT category colors spanned by a set of endpoint pages. Used to
   * derive a relationship's blendColor. A page may belong to several
   * categories; every such category contributes its color.
   */
  private endpointCategoryColors(endpointPageIds: readonly PageId[]): string[] {
    const colors: string[] = [];
    for (const category of this.data.categories) {
      if (category.memberPageIds.some((id) => endpointPageIds.includes(id))) {
        colors.push(this.categoryColor(category));
      }
    }
    return colors;
  }

  /**
   * Create a relationship ("Connecting Page") spanning N>=2 page endpoints. The
   * N=2 case fills the degenerate `fromPageId`/`toPageId`; every case stores the
   * explicit `endpointPageIds` so later reads go through one normalizer. The
   * `blendColor` is DERIVED (watercolor-multiply of the endpoint categories'
   * colors, §3.2) — never a hand-chosen value — so overlaps are always visually
   * consistent. Persists through the adapter.
   */
  async createRelationship(
    endpointPageIds: readonly PageId[],
    kind: RelationshipKind = "relates",
    label = "",
  ): Promise<Relationship> {
    if (endpointPageIds.length < 2) {
      throw new Error("createRelationship: need at least 2 endpoints");
    }
    const blendColor = deriveHubBlendColor(this.endpointCategoryColors(endpointPageIds));
    const relationship: Relationship = {
      id: newRelationshipId(),
      fromPageId: endpointPageIds[0]!,
      toPageId: endpointPageIds[endpointPageIds.length - 1]!,
      kind,
      label,
      createdAt: new Date().toISOString(),
      endpointPageIds: [...endpointPageIds],
      blendColor,
    };
    this.data = {
      ...this.data,
      relationships: [...this.data.relationships, relationship],
    };
    await this.persist();
    await this.logChange("relationship", "relationship-created", "Connected pages", [relationship.id, ...endpointPageIds]);
    return relationship;
  }

  // -- category master pages (A14-M2, §12.2) --------------------------------

  /**
   * The master page id of a category, if one has been created (A14-M2). Pure
   * getter — returns null when the category is unknown or has no master page.
   */
  categoryMasterPageId(categoryId: CategoryId): PageId | null {
    const cat = this.data.categories.find((c) => c.id === categoryId);
    return cat?.masterPageId ?? null;
  }

  /**
   * Get or create a category's MASTER page (§12.2, A14-M2). Each category has
   * one master page: a REAL subject Page (editable in the SubjectEditor) seeded
   * with the category name. This is IDEMPOTENT — if the category already has a
   * `masterPageId` and that Page still exists it is returned unchanged (no
   * second Page is created). Otherwise a fresh subject Page is created and the
   * Category's `masterPageId` is set immutably, then persisted.
   *
   * The master page is referenced via `Category.masterPageId`; it is NOT added
   * to the category's `memberPageIds` (membership semantics are unchanged).
   */
  async getOrCreateCategoryMasterPage(categoryId: CategoryId): Promise<PageId> {
    const idx = this.data.categories.findIndex((c) => c.id === categoryId);
    if (idx < 0) throw new Error("getOrCreateCategoryMasterPage: unknown category");
    const category = this.data.categories[idx]!;
    const existingId = category.masterPageId;
    if (existingId != null && this.data.pages.some((p) => p.id === existingId)) {
      return existingId;
    }
    // Create a real subject Page seeded from the category name.
    const now = new Date().toISOString();
    const page: Page = {
      id: newPageId(),
      kind: "subject",
      title: `${category.name} (master)`,
      documentJson: emptyDocJson(),
      createdAt: now,
      updatedAt: now,
    };
    const updatedCategory: Category = { ...category, masterPageId: page.id };
    const categories = this.data.categories.slice();
    categories[idx] = updatedCategory;
    this.data = {
      ...this.data,
      pages: [...this.data.pages, page],
      categories,
    };
    await this.persist();
    return page.id;
  }

  // -- M13 (§2.1(2)) Subject basins + Subject Pages -------------------------

  /**
   * M13 (§2.1(2)) the id of a Subject's overarching SUBJECT PAGE, if one has
   * been created. Pure getter — null when the category is unknown or has no
   * Subject Page yet. Distinct from `categoryMasterPageId`.
   */
  subjectBasinPageId(categoryId: CategoryId): PageId | null {
    const cat = this.data.categories.find((c) => c.id === categoryId);
    return cat?.subjectPageId ?? null;
  }

  /**
   * M13 (§2.1(2)) true iff `pageId` is the Subject Page of some Subject basin.
   * Lets the SubjectEditor (and FEAT-003 routing) discriminate a basin page
   * from an ordinary subject / node page via workbench state. Pure read.
   */
  isSubjectBasinPage(pageId: PageId): boolean {
    return this.data.categories.some((c) => c.subjectPageId === pageId);
  }

  /**
   * M13 (§2.1(2)) get or create a Subject's overarching SUBJECT PAGE — the real
   * subject `Page` (editable in SubjectEditor) that holds the user's macro
   * thoughts about the whole Subject. Cloned from
   * {@link getOrCreateCategoryMasterPage} but writes `Category.subjectPageId`
   * (a DISTINCT field from `masterPageId`), seeds the title from the category
   * name, and is IDEMPOTENT — if the Subject already has a `subjectPageId` and
   * that Page still exists it is returned unchanged. The Subject Page is NOT
   * added to the category's `memberPageIds` (membership semantics unchanged).
   */
  async getOrCreateSubjectBasinPage(categoryId: CategoryId): Promise<PageId> {
    const idx = this.data.categories.findIndex((c) => c.id === categoryId);
    if (idx < 0) throw new Error("getOrCreateSubjectBasinPage: unknown category");
    const category = this.data.categories[idx]!;
    const existingId = category.subjectPageId;
    if (existingId != null && this.data.pages.some((p) => p.id === existingId)) {
      // M13 (§2.2, P4): opening a Subject basin opens its overarching Subject
      // Page so the Reader/SubjectEditor render the basin-page surface.
      this.openSubjectPage(existingId);
      return existingId;
    }
    const now = new Date().toISOString();
    const page: Page = {
      id: newPageId(),
      kind: "subject",
      title: category.name,
      documentJson: emptyDocJson(),
      createdAt: now,
      updatedAt: now,
    };
    const updatedCategory: Category = { ...category, subjectPageId: page.id };
    const categories = this.data.categories.slice();
    categories[idx] = updatedCategory;
    this.data = {
      ...this.data,
      pages: [...this.data.pages, page],
      categories,
    };
    await this.persist();
    await this.logChange(
      "category",
      "subject-page-created",
      `Opened Subject Page for “${category.name}”`,
      [categoryId, page.id],
    );
    // M13 (§2.2, P4): open the newly created Subject Page.
    this.openSubjectPage(page.id);
    return page.id;
  }

  /**
   * M13 (§2.1(2)) the EFFECTIVE basin geometry for a Subject: its explicit
   * `Category.basin` when set, else the deterministic default derived from the
   * Subject's index in the category list (so even a 0-node Subject has a stable
   * visible basin). Pure read — null when the category is unknown.
   */
  subjectBasin(
    categoryId: CategoryId,
  ): { x: number; y: number; rx: number; ry: number } | null {
    const index = this.data.categories.findIndex((c) => c.id === categoryId);
    if (index < 0) return null;
    const cat = this.data.categories[index]!;
    return resolveBasin(cat.basin, index, this.data.categories.length);
  }

  /**
   * M13 (§2.1(2)) set (or move/resize) a Subject's explicit watercolour basin
   * geometry. Durable record edit — the basin is a Subject's first-class
   * spatial identity, so dragging/resizing a basin so it overlaps another is a
   * real model change (A∩B membership is then re-derived from positions).
   */
  async setSubjectBasin(
    categoryId: CategoryId,
    basin: { x: number; y: number; rx: number; ry: number },
  ): Promise<void> {
    const idx = this.data.categories.findIndex((c) => c.id === categoryId);
    if (idx < 0) return;
    const prev = this.data.categories[idx]!;
    const categories = this.data.categories.slice();
    categories[idx] = { ...prev, basin };
    this.data = { ...this.data, categories };
    await this.persist();
    await this.logChange("category", "subject-basin-moved", "Moved a Subject basin", [
      categoryId,
    ]);
  }

  /**
   * M13 (§2.1(3)) BIDIRECTIONAL spatial coincidence = Subject membership.
   * Given an Observation Node's resolved `[x, y]` canvas position, recompute the
   * Subject basins that geometrically contain it and set the node's category
   * membership to EXACTLY those Subjects:
   *   - into Subject A alone        -> `[A]`
   *   - into the A∩B overlap lens   -> `[A, B]`
   *   - out onto the bare paper     -> `[]`
   * Uses the pure {@link pointInSubjectBasin} ellipse test against each
   * Subject's effective basin, then reconciles via the existing idempotent
   * `addPageToCategory` / `removePageFromCategory`. A node is only tested
   * against real Subject basins; membership of a Subject's own Subject Page /
   * master page is never auto-mutated here (those are not Observation Nodes
   * resting in the territory).
   */
  async syncNodeBasinMembership(
    pageId: PageId,
    pos: { x: number; y: number },
  ): Promise<void> {
    const categories = this.data.categories;
    const containing = new Set<CategoryId>();
    categories.forEach((cat, index) => {
      const basin = resolveBasin(cat.basin, index, categories.length);
      if (pointInSubjectBasin(pos, basin)) containing.add(cat.id);
    });
    for (const cat of categories) {
      const isMember = cat.memberPageIds.includes(pageId);
      const shouldBeMember = containing.has(cat.id);
      if (shouldBeMember && !isMember) {
        await this.addPageToCategory(cat.id, pageId);
      } else if (!shouldBeMember && isMember) {
        await this.removePageFromCategory(cat.id, pageId);
      }
    }
  }

  /**
   * M13 (§2.1(3)) the inverse of {@link syncNodeBasinMembership}: when a node's
   * Subject membership is set PROGRAMMATICALLY (table / menu), place its `[x,y]`
   * inside the target basin (or the centroid of the A∩B overlap zone for two
   * Subjects) by writing a durable `nodePosition`, then reconcile membership so
   * the spatial and set-membership views agree. The node is added to EXACTLY
   * `categoryIds`. Returns the placed position.
   */
  async placeNodeInSubjects(
    pageId: PageId,
    categoryIds: readonly CategoryId[],
  ): Promise<{ x: number; y: number }> {
    const cats = this.data.categories;
    const basins = categoryIds
      .map((id) => {
        const index = cats.findIndex((c) => c.id === id);
        if (index < 0) return null;
        return resolveBasin(cats[index]!.basin, index, cats.length);
      })
      .filter((b): b is NonNullable<typeof b> => b != null);
    let target: { x: number; y: number };
    if (basins.length === 0) {
      target = { x: 0, y: 0 };
    } else if (basins.length === 1) {
      target = { x: basins[0]!.x, y: basins[0]!.y };
    } else {
      // Centroid of the two (or more) target basins — inside the overlap lens.
      let sx = 0;
      let sy = 0;
      for (const b of basins) {
        sx += b.x;
        sy += b.y;
      }
      target = { x: sx / basins.length, y: sy / basins.length };
    }
    await this.setNodePosition(pageId, target.x, target.y);
    await this.syncNodeBasinMembership(pageId, target);
    return target;
  }

  // -- M13 (§2.2, FEAT-003) 4-tier workspace routing ------------------------

  /**
   * M13 (§2.2) rank the cited SOURCES for an Observation Node's Page by how many
   * cited highlights point into it, DESC. For each `EvidenceInstance` whose
   * `destinationPageId === pageId`, follow its `annotationId` to the owning
   * `Annotation.sourceId` and tally per source. Returns `[{sourceId, count}]`
   * ordered by count DESC (ties broken by sourceId for determinism). This feeds
   * the Top-2 source workspace + the Source Switcher Pill (Test 5). Pure read.
   */
  topCitedSourcesForNode(pageId: PageId): { sourceId: SourceId; count: number }[] {
    return this.rankCitedSources(this.citedSourceCountsForPage(pageId));
  }

  /**
   * M13 (§2.2) rank the cited SOURCES for a Node-to-Node intersection (hub /
   * relationship) by cited-highlight count, DESC, AGGREGATED across the pages of
   * ALL the relationship's connected Observation Nodes. Each endpoint page's
   * cited-source counts are summed, so a source cited from two member nodes
   * counts twice. Returns `[{sourceId, count}]` ordered DESC. Pure read.
   */
  topCitedSourcesForRelationship(
    relationshipId: RelationshipId,
  ): { sourceId: SourceId; count: number }[] {
    const rel = this.data.relationships.find((r) => r.id === relationshipId);
    if (!rel) return [];
    const totals = new Map<SourceId, number>();
    for (const endpointPageId of relationshipEndpoints(rel)) {
      for (const [sourceId, count] of this.citedSourceCountsForPage(endpointPageId)) {
        totals.set(sourceId, (totals.get(sourceId) ?? 0) + count);
      }
    }
    return this.rankCitedSources(totals);
  }

  /**
   * The per-source cited-highlight counts for a single page: a map
   * `sourceId -> number of EvidenceInstances citing that source into the page`.
   * Private helper shared by the node + relationship rankings.
   */
  private citedSourceCountsForPage(pageId: PageId): Map<SourceId, number> {
    const counts = new Map<SourceId, number>();
    for (const ev of this.data.evidenceInstances) {
      if (ev.destinationPageId !== pageId) continue;
      const annotation = this.data.annotations.find((a) => a.id === ev.annotationId);
      if (!annotation) continue;
      counts.set(annotation.sourceId, (counts.get(annotation.sourceId) ?? 0) + 1);
    }
    return counts;
  }

  /** Order a source-count map by count DESC, ties broken by sourceId ASC. */
  private rankCitedSources(
    counts: Map<SourceId, number>,
  ): { sourceId: SourceId; count: number }[] {
    return [...counts.entries()]
      .map(([sourceId, count]) => ({ sourceId, count }))
      .sort((a, b) => (b.count - a.count) || String(a.sourceId).localeCompare(String(b.sourceId)));
  }

  /**
   * M13 (§2.2) the cited-source ranking for the CURRENTLY OPEN workspace page,
   * resolved by the open page's kind so the Reader's Source Switcher Pill can
   * render counts without re-deriving the kind:
   *   - a node-intersection page -> aggregate across the relationship's nodes;
   *   - any other open subject page -> that page's own cited sources.
   * Each entry carries the source title for display. Returns `[]` when no
   * subject page is open. Pure read.
   */
  citedSourceRankingForOpenWorkspace(): {
    sourceId: SourceId;
    title: string;
    count: number;
  }[] {
    const pageId = this.openSubjectPageId;
    if (pageId == null) return [];
    let ranked: { sourceId: SourceId; count: number }[];
    const rel = this.data.relationships.find((r) => r.explanatoryPageId === pageId);
    if (rel) {
      ranked = this.topCitedSourcesForRelationship(rel.id);
    } else {
      ranked = this.topCitedSourcesForNode(pageId);
    }
    return ranked.map((r) => ({
      sourceId: r.sourceId,
      title: this.data.sources.find((s) => s.id === r.sourceId)?.title ?? String(r.sourceId),
      count: r.count,
    }));
  }

  /**
   * M13 (§2.2, P1) open the OBSERVATION NODE's workspace: the Node's Page
   * alongside its TOP-2 most-populated cited PDFs, jumped to the first cited
   * highlight with EvidenceLines active. The subject page is opened; the top-2
   * cited sources are opened TOGETHER (or fewer when the node cites <2). The
   * Source Switcher Pill (rendered by the Reader) lists every cited source so a
   * 3rd+ PDF can be swapped in. Returns the opened source ids (the top 2).
   */
  openNodeWorkspace(pageId: PageId): SourceId[] {
    const ranked = this.topCitedSourcesForNode(pageId);
    const top2 = ranked.slice(0, 2).map((r) => r.sourceId);
    this.openTogether(top2);
    this.openSubjectPage(pageId);
    this.setLinesVisible(true);
    return top2;
  }

  /**
   * M13 (§2.2, P2) open the NODE-INTERSECTION workspace: lazily create/open the
   * relationship's own Connecting Page (via {@link getOrCreateRelationshipPage})
   * alongside the TOP-2 cited PDFs aggregated across the connected nodes, with
   * EvidenceLines active. Returns the created/opened page id. The Reader renders
   * the Source Switcher + member-node quick-jump pills.
   */
  async openRelationshipWorkspace(relationshipId: RelationshipId): Promise<PageId> {
    const ranked = this.topCitedSourcesForRelationship(relationshipId);
    const top2 = ranked.slice(0, 2).map((r) => r.sourceId);
    const pageId = await this.getOrCreateRelationshipPage(relationshipId);
    this.openTogether(top2);
    this.openSubjectPage(pageId);
    this.setLinesVisible(true);
    return pageId;
  }

  /**
   * M13 (§2.2, P2) get or create the Node-Intersection's own Page. This ALIASES
   * the existing {@link developRelationshipPage} (§12.1, A13-M2): a relationship
   * already has a first-class explanatory subject Page home, so the intersection
   * page is exactly that page. Idempotent — reuses `Relationship.explanatoryPageId`
   * when present. The SubjectEditor renders this surface with
   * `data-testid="intersection-page-editor"` (driven by `openPageKind`).
   */
  async getOrCreateRelationshipPage(relationshipId: RelationshipId): Promise<PageId> {
    return this.developRelationshipPage(relationshipId);
  }

  /**
   * M13 (§2.2, P3) get or create the ONE unified SUBJECT-INTERSECTION Page for a
   * set of overlapping Subjects. Regardless of how many Subjects overlap at the
   * clicked point (2, 3, …, N) there is exactly one page per DISTINCT sorted
   * subject set, deduped by the deterministic key `sortedSubjectIds.join("|")`
   * stored in `BrainData.subjectIntersectionPages`. Idempotent — an existing key
   * whose page still exists reopens that page unchanged. Opens the page and
   * returns its id. The input ids are sorted defensively so caller order never
   * forks the key.
   */
  async getOrCreateSubjectIntersectionPage(
    sortedSubjectIds: readonly CategoryId[],
  ): Promise<PageId> {
    if (sortedSubjectIds.length < 2) {
      throw new Error("getOrCreateSubjectIntersectionPage: need >= 2 subjects");
    }
    const sorted = [...sortedSubjectIds].map((id) => String(id)).sort();
    const key = sorted.join("|");
    const existingMap = this.data.subjectIntersectionPages ?? {};
    const existingId = existingMap[key];
    if (existingId != null && this.data.pages.some((p) => p.id === existingId)) {
      this.openSubjectPage(existingId);
      return existingId;
    }
    // Seed a readable title from the participating Subject names (A ∩ B ∩ C).
    const names = sorted.map(
      (id) => this.data.categories.find((c) => String(c.id) === id)?.name ?? id,
    );
    const title = names.join(" ∩ ");
    const now = new Date().toISOString();
    const page: Page = {
      id: newPageId(),
      kind: "subject",
      title,
      documentJson: emptyDocJson(),
      createdAt: now,
      updatedAt: now,
    };
    this.data = {
      ...this.data,
      pages: [...this.data.pages, page],
      subjectIntersectionPages: { ...existingMap, [key]: page.id },
    };
    await this.persist();
    await this.logChange(
      "other",
      "page-created",
      `Opened Subject intersection “${title}”`,
      [page.id],
    );
    this.openSubjectPage(page.id);
    return page.id;
  }

  /**
   * M13 (§2.2, P3) the sorted subject-id SET a Subject-intersection page covers,
   * or null when `pageId` is not a Subject-intersection page. Reverses the
   * `subjectIntersectionPages` map. Pure read.
   */
  subjectIntersectionSubjectIds(pageId: PageId): CategoryId[] | null {
    const map = this.data.subjectIntersectionPages ?? {};
    for (const [key, id] of Object.entries(map)) {
      if (id === pageId) return key.split("|") as CategoryId[];
    }
    return null;
  }

  /** M13 (§2.2) true iff `pageId` is a unified Subject-intersection page (P3). */
  isSubjectIntersectionPage(pageId: PageId): boolean {
    return this.subjectIntersectionSubjectIds(pageId) !== null;
  }

  /** M13 (§2.2) true iff `pageId` is a relationship's Connecting Page (P2). */
  isNodeIntersectionPage(pageId: PageId): boolean {
    return this.data.relationships.some((r) => r.explanatoryPageId === pageId);
  }

  /**
   * M13 (§2.2) the KIND of the currently open subject page (null when none is
   * open), discriminated so the Reader/SubjectEditor render the right surface:
   * subject-basin (P4) > subject-intersection (P3) > node-intersection (P2) >
   * node (P1 / ordinary). Pure read over the durable records.
   */
  openPageKind(): OpenPageKind | null {
    const pageId = this.openSubjectPageId;
    if (pageId == null) return null;
    if (this.isSubjectBasinPage(pageId)) return "subject-basin";
    if (this.isSubjectIntersectionPage(pageId)) return "subject-intersection";
    if (this.isNodeIntersectionPage(pageId)) return "node-intersection";
    return "node";
  }

  /**
   * M13 (§2.2) the aspect-bar relationship-kind selector value for the open
   * Subject-intersection page (defaults to "relates"), or null when the open
   * page is not a Subject-intersection page. UI-local session state.
   */
  intersectionRelationshipKind(pageId: PageId): IntersectionRelationshipKind {
    return this.intersectionRelationshipKinds.get(pageId) ?? "relates";
  }

  /**
   * M13 (§2.2) set the aspect-bar relationship-kind selector value for a
   * Subject-intersection page. Transient UI-local session state — writes NO
   * durable record (mirrors the view-state setters).
   */
  setIntersectionRelationshipKind(
    pageId: PageId,
    kind: IntersectionRelationshipKind,
  ): void {
    this.intersectionRelationshipKinds.set(pageId, kind);
  }

  /**
   * M13 (§2.2) the full Intersection Aspect Selector Bar data for the OPEN
   * Subject-intersection page, or null when no such page is open. Builds the
   * CORE pill (A∩B∩C…), every PAIRWISE pill (A∩B, B∩C, A∩C…), the current
   * relationship-kind value, and the LIVE list of Observation Nodes currently
   * inside the overlap — a node is "inside" when its resolved canvas position
   * lies within EVERY participating Subject's basin (pointInSubjectBasin).
   */
  intersectionAspects(forPageId?: PageId): IntersectionAspects | null {
    const pageId = forPageId ?? this.openSubjectPageId;
    if (pageId == null) return null;
    const subjectIds = this.subjectIntersectionSubjectIds(pageId);
    if (subjectIds == null) return null;

    const categories = this.data.categories;
    const subjects: IntersectionSubject[] = subjectIds.map((id) => {
      const cat = categories.find((c) => String(c.id) === String(id));
      return { categoryId: id, name: cat?.name ?? String(id) };
    });
    const nameOf = (id: CategoryId): string =>
      subjects.find((s) => String(s.categoryId) === String(id))?.name ?? String(id);

    const corePill: IntersectionAspectPill = {
      subjectIds,
      label: subjects.map((s) => s.name).join(" ∩ "),
      kind: "core",
    };

    // Every unordered pair of participating Subjects -> a pairwise sub-overlap.
    const pairwisePills: IntersectionAspectPill[] = [];
    for (let i = 0; i < subjectIds.length; i++) {
      for (let j = i + 1; j < subjectIds.length; j++) {
        const a = subjectIds[i]!;
        const b = subjectIds[j]!;
        pairwisePills.push({
          subjectIds: [a, b],
          label: `${nameOf(a)} ∩ ${nameOf(b)}`,
          kind: "pairwise",
        });
      }
    }

    // LIVE Observation Nodes inside the overlap: resolved canvas position lies
    // within EVERY participating Subject's effective basin.
    const positions = this.data.presentation.nodePositions ?? this.data.presentation.positions;
    const basins = subjectIds.map((id) => {
      const index = categories.findIndex((c) => String(c.id) === String(id));
      return index < 0
        ? null
        : resolveBasin(categories[index]!.basin, index, categories.length);
    });
    const nodesInside: { pageId: PageId; title: string }[] = [];
    for (const page of this.data.pages) {
      if (page.kind !== "subject") continue;
      const pos = positions[page.id];
      if (!pos) continue;
      const inAll = basins.every((b) => b != null && pointInSubjectBasin(pos, b));
      if (inAll) nodesInside.push({ pageId: page.id, title: page.title });
    }

    return {
      subjects,
      corePill,
      pairwisePills,
      relationshipKind: this.intersectionRelationshipKind(pageId),
      nodesInside,
    };
  }

  /**
   * Connect two categories at their BOUNDARIES (§12.2, A14-M2): the explicit
   * "a category master page may connect to another category boundary"
   * capability. Ensures BOTH categories have a master page (creating them if
   * needed) and then creates a Relationship whose endpoints are the two master
   * page ids. Because master pages have real PageIds, this flows through the
   * same `createRelationship`/`relationshipEndpoints` normalizer as any other
   * relationship. Returns the new relationship id. Persists.
   */
  async connectCategoryBoundaries(
    fromCategoryId: CategoryId,
    toCategoryId: CategoryId,
  ): Promise<RelationshipId> {
    if (fromCategoryId === toCategoryId) {
      throw new Error("connectCategoryBoundaries: categories must be distinct");
    }
    const fromMaster = await this.getOrCreateCategoryMasterPage(fromCategoryId);
    const toMaster = await this.getOrCreateCategoryMasterPage(toCategoryId);
    const rel = await this.createRelationship([fromMaster, toMaster]);
    return rel.id;
  }

  /**
   * The DERIVED concept-network graph the view renders from: nodes = pages
   * (with hidden flag + laid-out position), links = relationships with their
   * normalized endpoints + topology + derived blendColor, categories with their
   * colors. Reading the graph derives everything live; it never mutates data.
   */
  conceptGraph(): ConceptGraph {
    const presentation = this.data.presentation;
    const hiddenPages = new Set<PageId>(presentation.hiddenPageIds);
    const hiddenRels = new Set<RelationshipId>(presentation.hiddenRelationshipIds);
    const positions = presentation.nodePositions ?? presentation.positions;

    const nodes: ConceptNode[] = this.data.pages.map((page) => {
      const nodeTier = this.nodeTierFor(page);
      return {
        pageId: page.id,
        title: page.title,
        kind: page.kind,
        hidden: hiddenPages.has(page.id),
        position: positions[page.id] ?? null,
        nodeTier,
        ...(nodeTier === "memory" ? { isPromotedMemory: true } : {}),
      };
    });

    const links: ConceptLink[] = this.data.relationships.map((rel) => {
      const endpoints = relationshipEndpoints(rel);
      return {
        relationshipId: rel.id,
        endpointPageIds: endpoints,
        kind: rel.kind,
        label: rel.label,
        topology: endpoints.length >= 3 ? "star" : "lens",
        blendColor:
          rel.blendColor ?? deriveHubBlendColor(this.endpointCategoryColors(endpoints)),
        hidden: hiddenRels.has(rel.id),
      };
    });

    const categories: ConceptCategory[] = this.data.categories.map((category) => ({
      categoryId: category.id,
      name: category.name,
      colorCode: this.categoryColor(category),
      memberPageIds: category.memberPageIds,
      ...(category.masterPageId != null ? { masterPageId: category.masterPageId } : {}),
      ...(category.basin != null ? { basin: category.basin } : {}),
      ...(category.subjectPageId != null ? { subjectPageId: category.subjectPageId } : {}),
    }));

    return { nodes, links, categories };
  }

  // -- search / retrieval / neighbourhood (M2-FIX-2, §13, A10, D07) ---------

  /**
   * M13 FEAT-001 — classify a page's node maturity tier for the concept graph.
   *
   * A page is a "memory" (hollow dot) iff it is an ordinary subject/node page
   * whose record is effectively a single promoted highlight: it cites AT MOST
   * ONE evidence instance AND carries no synthesis prose beyond that quote.
   * As soon as a 2nd evidence quote is inserted (evidenceCount >= 2) OR the
   * author adds synthesis text, the node GRADUATES to "observation" (filled).
   *
   * Non-ordinary subject pages — Subject BASIN pages (P4), Subject-intersection
   * pages (P3), node-intersection/Connecting pages (P2), and Category master
   * pages — always default to "observation" so they are never hollowed.
   */
  private nodeTierFor(page: Page): "memory" | "observation" {
    // Only ordinary subject pages are candidates for the "memory" tier.
    if (page.kind !== "subject") return "observation";
    if (
      this.isSubjectBasinPage(page.id) ||
      this.isSubjectIntersectionPage(page.id) ||
      this.isNodeIntersectionPage(page.id)
    ) {
      return "observation";
    }
    // A category master page is a durable hub, never a promoted memory.
    if (this.data.categories.some((c) => c.masterPageId === page.id)) {
      return "observation";
    }

    const evidence = this.data.evidenceInstances.filter(
      (e) => e.destinationPageId === page.id,
    );
    const evidenceCount = evidence.length;
    if (evidenceCount >= 2) return "observation";

    // "Extra synthesis": any body text beyond the single promoted quote. A
    // freshly promoted node's body is exactly its one quoted evidence atom, so
    // stripping the quoted text(s) leaves nothing for a pure memory node.
    const body = this.pageBodyText(page);
    let residual = body;
    for (const ev of evidence) {
      if (ev.quotedText) residual = residual.split(ev.quotedText).join("");
    }
    const hasExtraSynthesis = residual.replace(/\s+/g, "").length > 0;

    return evidenceCount <= 1 && !hasExtraSynthesis ? "memory" : "observation";
  }

  /**
   * Extract a page's searchable body text from its stored ProseMirror
   * `documentJson` via the editor layer (NOT a bespoke serialization): the JSON
   * is re-hydrated and flattened with `plainText`, so composed quotes and
   * written prose are both searchable. Empty/malformed docs yield "".
   */
  private pageBodyText(page: Page): string {
    try {
      const json = (page.documentJson as DocumentJson) ?? emptyDocJson();
      return plainText(hydrateState(json).doc);
    } catch {
      return "";
    }
  }

  /**
   * The searchable anchor text for an annotation: the selected text for a
   * text-scope highlight, or the `pp. X-Y` label for a page-range annotation.
   */
  private annotationAnchorText(annotation: Annotation): string {
    if (annotation.scope.kind === "text") return annotation.scope.anchor.selectedText;
    if (annotation.scope.kind === "area") {
      return `Area on p. ${annotation.scope.anchor.pageIndex + 1}`;
    }
    const a = annotation.scope.anchor;
    return `pp. ${a.startPageIndex + 1}-${a.endPageIndex + 1}`;
  }

  /**
   * Build the pure search index from the LIVE BrainData. Page body text comes
   * from the editor layer (`pageBodyText`), category membership from
   * `Category.memberPageIds`, and annotation anchor/comment from the model.
   * This is the ONE place the Workbench translates its records into the
   * module's minimal structural view — the matching logic lives in
   * `src/network/search.ts`.
   */
  private buildSearchIndex(): SearchIndex {
    const categoriesByPage = new Map<PageId, string[]>();
    for (const category of this.data.categories) {
      for (const pageId of category.memberPageIds) {
        const list = categoriesByPage.get(pageId) ?? [];
        list.push(category.id);
        categoriesByPage.set(pageId, list);
      }
    }
    return {
      docs: this.data.pages.map((page) => ({
        pageId: page.id,
        title: page.title,
        bodyText: this.pageBodyText(page),
        categoryIds: categoriesByPage.get(page.id) ?? [],
      })),
      categories: this.data.categories.map((c) => ({
        categoryId: c.id,
        name: c.name,
      })),
      annotations: this.data.annotations.map((a) => ({
        annotationId: a.id,
        sourceId: a.sourceId,
        anchorText: this.annotationAnchorText(a),
        comment: a.comment,
      })),
    };
  }

  /**
   * Case-insensitive substring search across Page titles + body text, Category
   * names, and Annotation anchor text + comment (§13, A10, D07). Builds the
   * index from live BrainData and DELEGATES all matching to
   * `src/network/search.ts`; an optional `categoryId` restricts page hits to
   * that category's members. Pure read — writes nothing, creates no records.
   */
  search(query: string, options: SearchOptions = {}): SearchResult[] {
    return runSearch(query, this.buildSearchIndex(), options);
  }

  /**
   * The 1-hop graph neighbourhood around a page (§13, D07): the connected
   * PageIds and connecting RelationshipIds. Edges are derived via the single
   * `relationshipEndpoints` normalizer so N=2 and N>=3 relationships behave
   * identically; the matching logic is delegated to `src/network/search.ts`.
   * Pure read.
   */
  neighborhood(pageId: PageId): { pageIds: PageId[]; relationshipIds: RelationshipId[] } {
    const edges: SearchEdge[] = this.data.relationships.map((rel) => ({
      relationshipId: rel.id,
      endpointPageIds: relationshipEndpoints(rel),
    }));
    const n = computeNeighborhood(pageId, edges);
    return {
      pageIds: n.pageIds as PageId[],
      relationshipIds: n.relationshipIds as RelationshipId[],
    };
  }

  // -- concept-network presentation-only transitions ------------------------

  /**
   * Set a node's durable 2D canvas position (laid-out or hand-dragged). This is
   * PRESENTATION state: it never creates or deletes a Page/Relationship. Writes
   * `nodePositions` (the M2 canvas map) and persists.
   */
  async setNodePosition(pageId: PageId, x: number, y: number): Promise<void> {
    const nodePositions = {
      ...(this.data.presentation.nodePositions ?? {}),
      [pageId]: { x, y },
    };
    this.data = {
      ...this.data,
      presentation: { ...this.data.presentation, nodePositions },
    };
    await this.persist();
  }

  /**
   * Set a node's user-dragged OFFSET relative to the engine layout. Durable
   * presentation state (D19); survives a relayout. Never touches records.
   */
  async setDragOffset(pageId: PageId, x: number, y: number): Promise<void> {
    const dragOffsets = {
      ...(this.data.presentation.dragOffsets ?? {}),
      [pageId]: { x, y },
    };
    this.data = {
      ...this.data,
      presentation: { ...this.data.presentation, dragOffsets },
    };
    await this.persist();
  }

  /** Set the canvas zoom scale (presentation only). */
  async setZoom(zoom: number): Promise<void> {
    this.data = {
      ...this.data,
      presentation: { ...this.data.presentation, zoom },
    };
    await this.persist();
  }

  /** Current canvas zoom scale (defaults to 1). */
  zoom(): number {
    return this.data.presentation.zoom ?? 1;
  }

  /**
   * M14–M16 (FEAT-002) record a Nodes-canvas "camera dive" target: the
   * pre-dive camera (`x`/`y`/`zoom`) and the id of the entity the click dived
   * into. Presentation-only — it writes NO durable Page/Relationship record and
   * is persisted alongside the other presentation session context so the "←
   * Return to Map" control can pull the camera back out from exactly where it
   * dived in. Idempotent for the same target.
   */
  async recordCameraDive(target: {
    x: number;
    y: number;
    zoom: number;
    targetId: string;
  }): Promise<void> {
    this.data = {
      ...this.data,
      presentation: {
        ...this.data.presentation,
        lastDiveTarget: {
          x: target.x,
          y: target.y,
          zoom: target.zoom,
          targetId: target.targetId,
        },
      },
    };
    await this.persist();
  }

  /** M14–M16 (FEAT-002) the last recorded camera-dive target, or null. */
  lastDiveTarget(): { x: number; y: number; zoom: number; targetId: string } | null {
    const t = this.data.presentation.lastDiveTarget;
    return t ? { x: t.x, y: t.y, zoom: t.zoom, targetId: t.targetId } : null;
  }

  /**
   * M14–M16 (FEAT-002) "← Return to Map": switch back to the Nodes view so the
   * camera can smoothly pull back out from the last dive target. View state
   * only — never alters durable records. Returns the dive target it will pull
   * back from (null when no dive was recorded).
   */
  returnToMap(): { x: number; y: number; zoom: number; targetId: string } | null {
    const target = this.lastDiveTarget();
    this.setViewMode("nodes");
    return target;
  }

  /**
   * A read-only view of the interactive 2D canvas presentation state (§3.3):
   * the durable per-node drag offsets and absolute position overrides keyed by
   * page id, plus the canvas zoom. Returns PLAIN copies so a caller (NodesCanvas
   * / testApi) cannot mutate the underlying record.
   */
  presentationView(): {
    dragOffsets: Record<string, { x: number; y: number }>;
    nodePositions: Record<string, { x: number; y: number }>;
    zoom: number;
  } {
    const dragOffsets: Record<string, { x: number; y: number }> = {};
    for (const [id, p] of Object.entries(this.data.presentation.dragOffsets ?? {})) {
      dragOffsets[id] = { x: p.x, y: p.y };
    }
    const nodePositions: Record<string, { x: number; y: number }> = {};
    for (const [id, p] of Object.entries(this.data.presentation.nodePositions ?? {})) {
      nodePositions[id] = { x: p.x, y: p.y };
    }
    return { dragOffsets, nodePositions, zoom: this.data.presentation.zoom ?? 1 };
  }

  /**
   * Hide a node. PRESENTATION ONLY: it adds the id to `hiddenPageIds` and NEVER
   * deletes the Page (A09-M2 / the M1 non-destructive guarantee). Idempotent.
   */
  async hideNode(pageId: PageId): Promise<void> {
    if (this.data.presentation.hiddenPageIds.includes(pageId)) return;
    this.data = {
      ...this.data,
      presentation: {
        ...this.data.presentation,
        hiddenPageIds: [...this.data.presentation.hiddenPageIds, pageId],
      },
    };
    await this.persist();
  }

  /** Un-hide a node (presentation only). */
  async showNode(pageId: PageId): Promise<void> {
    if (!this.data.presentation.hiddenPageIds.includes(pageId)) return;
    this.data = {
      ...this.data,
      presentation: {
        ...this.data.presentation,
        hiddenPageIds: this.data.presentation.hiddenPageIds.filter((id) => id !== pageId),
      },
    };
    await this.persist();
  }

  /**
   * Hide a relationship. PRESENTATION ONLY: adds the id to
   * `hiddenRelationshipIds` and NEVER deletes the Relationship. Idempotent.
   */
  async hideRelationship(relationshipId: RelationshipId): Promise<void> {
    if (this.data.presentation.hiddenRelationshipIds.includes(relationshipId)) return;
    this.data = {
      ...this.data,
      presentation: {
        ...this.data.presentation,
        hiddenRelationshipIds: [
          ...this.data.presentation.hiddenRelationshipIds,
          relationshipId,
        ],
      },
    };
    await this.persist();
  }

  /** Un-hide a relationship (presentation only). */
  async showRelationship(relationshipId: RelationshipId): Promise<void> {
    if (!this.data.presentation.hiddenRelationshipIds.includes(relationshipId)) return;
    this.data = {
      ...this.data,
      presentation: {
        ...this.data.presentation,
        hiddenRelationshipIds: this.data.presentation.hiddenRelationshipIds.filter(
          (id) => id !== relationshipId,
        ),
      },
    };
    await this.persist();
  }

  // -- density monitor (§3.4) ----------------------------------------------

  /**
   * The count of NON-hidden pages participating in the concept network. Pure
   * getter: counts durable pages minus those presentation-hidden. Hiding a node
   * lowers this (view state) without deleting anything.
   */
  activeNodeCount(): number {
    const hidden = new Set<PageId>(this.data.presentation.hiddenPageIds);
    return this.data.pages.filter((p) => !hidden.has(p.id)).length;
  }

  /**
   * Whether the §3.4 density reward (3D presentation) is UNLOCKED: true once the
   * active node count reaches THREE_D_UNLOCK_THRESHOLD (35).
   */
  is3DUnlocked(): boolean {
    return this.activeNodeCount() >= THREE_D_UNLOCK_THRESHOLD;
  }

  /** Whether 3D presentation is currently active (user opt-in). */
  active3D(): boolean {
    return this.data.presentation.active3D ?? false;
  }

  /**
   * Set the active-3D flag (presentation only). The view is responsible for
   * only surfacing the toggle when `is3DUnlocked()`; this persists the choice.
   */
  async setActive3D(on: boolean): Promise<void> {
    this.data = {
      ...this.data,
      presentation: { ...this.data.presentation, active3D: on },
    };
    await this.persist();
  }

  // -- N06 transient placeholder --------------------------------------------

  /**
   * Return a TRANSIENT "Not connected yet" placeholder for a source id (N06).
   * This is pure/ephemeral: it creates NO Page/Relationship/Category and writes
   * NOTHING to storage — mirroring the invariant that annotating/associating
   * creates zero graph records. The returned descriptor is marked
   * `transient: true` so the view never persists it.
   */
  nodePlaceholderFor(sourceId: string): NodePlaceholder {
    const source = this.data.sources.find((s) => s.id === (sourceId as SourceId));
    const title = source ? `${source.title} — not connected yet` : "Not connected yet";
    return { sourceId, title, transient: true };
  }

  /**
   * Whether a Source PARTICIPATES in the concept network (N06). A source is
   * "connected" once one of its annotations is cited into a subject page (an
   * EvidenceInstance pointing at a Page), which is what makes a node/relationship
   * exist for it. A freshly-imported, never-cited PDF is UNCONNECTED, and the
   * Nodes view shows the transient "not connected yet" placeholder for it.
   * Pure read — never mutates data.
   */
  sourceIsConnected(sourceId: string): boolean {
    const id = sourceId as SourceId;
    const annotationIds = new Set(
      this.data.annotations.filter((a) => a.sourceId === id).map((a) => a.id),
    );
    if (annotationIds.size === 0) return false;
    return this.data.evidenceInstances.some((ev) => annotationIds.has(ev.annotationId));
  }

  // -- M7 linked history, checkpoints & reflection (H01-H07, D13, D14) ------

  /** Read-only view of the recorded revisions (oldest first). */
  revisions(): readonly Revision[] {
    return this.data.revisions;
  }

  /** Read-only view of the periodic history checkpoints (H06). */
  checkpoints(): readonly Checkpoint[] {
    return this.data.checkpoints ?? [];
  }

  /** Read-only view of the recorded multi-span reflections (H04, D14). */
  reflections(): readonly ReflectionEntry[] {
    return this.data.reflections ?? [];
  }

  /** Read-only view of the per-revision comments (H04). */
  revisionComments(): Readonly<Record<string, string>> {
    return this.data.revisionComments ?? {};
  }

  /**
   * Creation-timezone day key `YYYY-MM-DD` for an ISO timestamp (H03). Uses the
   * LOCAL calendar date so the timeline groups by the author's day, matching
   * the HistoryReflectionPanel's grouping.
   */
  static dateKeyOf(iso: string): string {
    const d = new Date(iso);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  /**
   * M7 (H01) record a prose edit to a Subject Page's documentJson. Same-page
   * edits within COALESCE_WINDOW_MS COALESCE into one buffered revision; an edit
   * to a DIFFERENT page (or after the idle window elapses) first flushes the
   * pending buffer, then starts a new one. The buffer is committed to
   * `data.revisions` by `flushPendingRevision()`. This records NO revision by
   * itself - it only mutates the page + buffers the coalesced delta.
   *
   * `now` is injectable so tests can simulate the passage of the idle window
   * deterministically without a wall-clock timer.
   */
  async recordProseEdit(
    pageId: PageId,
    nextDocumentJson: unknown,
    now: string = new Date().toISOString(),
  ): Promise<void> {
    const idx = this.data.pages.findIndex((p) => p.id === pageId);
    if (idx < 0) return;
    const page = this.data.pages[idx]!;
    const beforeForBuffer = structuredClone(page.documentJson);

    // If the buffer belongs to a different page or the idle window elapsed,
    // flush it before starting a fresh coalescing buffer for this edit.
    if (this.pendingProse) {
      const sincePrev =
        new Date(now).getTime() - new Date(this.pendingProse.lastEditAt).getTime();
      if (this.pendingProse.pageId !== pageId || sincePrev > COALESCE_WINDOW_MS) {
        await this.flushPendingRevision(this.pendingProse.lastEditAt);
      }
    }

    if (this.pendingProse && this.pendingProse.pageId === pageId) {
      // Fold into the existing buffer: keep the ORIGINAL before-snapshot, extend
      // the after-snapshot and the last-edit timestamp.
      this.pendingProse.afterDocumentJson = structuredClone(nextDocumentJson);
      this.pendingProse.lastEditAt = now;
    } else {
      this.pendingProse = {
        pageId,
        beforeDocumentJson: beforeForBuffer,
        afterDocumentJson: structuredClone(nextDocumentJson),
        firstEditAt: now,
        lastEditAt: now,
      };
    }

    // Apply the edit to the live page (prose edits are not deferred, only the
    // REVISION record is coalesced).
    const pages = this.data.pages.slice();
    pages[idx] = { ...page, documentJson: nextDocumentJson, updatedAt: now };
    this.data = { ...this.data, pages };
    await this.persist();
  }

  /**
   * M7 (H01) commit the buffered coalesced prose-edit revision (if any) as ONE
   * `page-prose` Revision. Public + deterministic so tests can force the
   * coalescing boundary. A no-op when nothing is buffered.
   */
  async flushPendingRevision(now: string = new Date().toISOString()): Promise<void> {
    const pending = this.pendingProse;
    if (!pending) return;
    this.pendingProse = null;
    const createdAt = pending.lastEditAt ?? now;
    await this.appendRevision({
      kind: "page-prose",
      label: "page-prose",
      createdAt,
      affectedObjectIds: [pending.pageId],
      beforeSnapshot: { pageId: pending.pageId, documentJson: pending.beforeDocumentJson },
      afterSnapshot: { pageId: pending.pageId, documentJson: pending.afterDocumentJson },
      summary: `Edited page ${pending.pageId}`,
    });
  }

  /**
   * Record a user-meaningful change in History (H02). Thin wrapper over
   * recordStructuralRevision so every mutator logs the same way. Kept AFTER the
   * mutator's own persist so the change is durable before it is narrated.
   */
  private async logChange(
    kind: RevisionKind,
    label: string,
    summary: string,
    affectedObjectIds: readonly string[],
  ): Promise<void> {
    if (!this.autoHistory) return;
    await this.recordStructuralRevision({ kind, label, summary, affectedObjectIds });
  }

  /**
   * Turn on automatic History logging for user-meaningful mutations (pages,
   * quotes, comments, categories, connections, associations). Off by default so a
   * Workbench driven directly (tests, tooling) records exactly the revisions it
   * asks for; the app shell turns it on.
   */
  enableAutoHistory(on = true): void {
    this.autoHistory = on;
  }

  /**
   * M7 (H02) record a STRUCTURAL action as its own Revision immediately (never
   * coalesced). Flushes any pending prose buffer first so history stays ordered.
   * Structural kinds: quote insert/remove/reorder, annotation comments, range
   * boundaries, tentative associations, categories, relationships.
   */
  async recordStructuralRevision(input: {
    kind: RevisionKind;
    label?: string;
    affectedObjectIds?: readonly string[];
    beforeSnapshot?: unknown;
    afterSnapshot?: unknown;
    summary?: string;
    now?: string;
  }): Promise<Revision> {
    // A structural action supersedes buffered prose typing; flush it first.
    if (this.pendingProse) await this.flushPendingRevision(input.now);
    return this.appendRevision({
      kind: input.kind,
      label: input.label ?? input.kind,
      createdAt: input.now ?? new Date().toISOString(),
      ...(input.affectedObjectIds !== undefined
        ? { affectedObjectIds: input.affectedObjectIds }
        : {}),
      ...(input.beforeSnapshot !== undefined
        ? { beforeSnapshot: input.beforeSnapshot }
        : {}),
      ...(input.afterSnapshot !== undefined
        ? { afterSnapshot: input.afterSnapshot }
        : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
    });
  }

  /**
   * Append a fully-formed Revision to `data.revisions`, stamp its creation-day
   * key, write a Checkpoint when the count crosses a CHECKPOINT_INTERVAL
   * boundary (H06), and persist once. Internal: all public recorders funnel
   * through here so checkpoint cadence + dateKey stamping happen in one place.
   */
  private async appendRevision(input: {
    kind: RevisionKind;
    label: string;
    createdAt: string;
    affectedObjectIds?: readonly string[];
    beforeSnapshot?: unknown;
    afterSnapshot?: unknown;
    summary?: string;
  }): Promise<Revision> {
    const revision: Revision = {
      id: newRevisionId(),
      publicationRevision: this.data.manifest.publicationRevision,
      label: input.label,
      createdAt: input.createdAt,
      kind: input.kind,
      dateKey: Workbench.dateKeyOf(input.createdAt),
      ...(input.affectedObjectIds !== undefined
        ? { affectedObjectIds: input.affectedObjectIds }
        : {}),
      ...(input.beforeSnapshot !== undefined
        ? { beforeSnapshot: input.beforeSnapshot }
        : {}),
      ...(input.afterSnapshot !== undefined
        ? { afterSnapshot: input.afterSnapshot }
        : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
    };
    const revisions = [...this.data.revisions, revision];
    let checkpoints = this.data.checkpoints ?? [];
    // Write a checkpoint every CHECKPOINT_INTERVAL revisions (H06).
    if (revisions.length % CHECKPOINT_INTERVAL === 0) {
      checkpoints = [...checkpoints, this.buildCheckpoint(revisions)];
    }
    this.data = { ...this.data, revisions, checkpoints };
    await this.persist();
    return revision;
  }

  /**
   * M7 (H06) build a validated Checkpoint over `revisions`. CRITICAL: the
   * `stateSnapshot` EXCLUDES the `revisions` and `checkpoints` collections (no
   * recursive history nesting) and carries NO PDF binary bytes (BrainData holds
   * only asset ids + a manifest asset index, never the bytes themselves, so a
   * structuredClone of the structured records is binary-free by construction).
   */
  private buildCheckpoint(revisions: readonly Revision[]): Checkpoint {
    const last = revisions[revisions.length - 1]!;
    // Strip history collections so the snapshot never nests history in history.
    const { revisions: _r, checkpoints: _c, ...structured } = this.data;
    return {
      id: newCheckpointId(),
      createdAt: new Date().toISOString(),
      revisionIndex: revisions.length - 1,
      afterRevisionId: last.id,
      stateSnapshot: structuredClone({ ...structured, revisions: [], checkpoints: [] }),
    };
  }

  /**
   * M7 (H05) reconstruct the structured brain state AS OF `revId` by replaying
   * the recorded prose deltas forward from the nearest prior Checkpoint (or from
   * an empty snapshot if none). Returns the reconstructed state on a complete
   * chain; returns an explicit `missing-segment` result (with the ids it could
   * not replay and the best-effort fallback state) when the delta chain between
   * the checkpoint and the target is broken.
   */
  reconstructRevisionState(revId: string): ReconstructResult {
    const revisions = this.data.revisions;
    const targetIdx = revisions.findIndex((r) => r.id === revId);
    if (targetIdx < 0) {
      return { status: "missing-segment", missingIds: [revId], fallbackState: null };
    }

    // Find the nearest checkpoint at or before the target revision.
    const checkpoints = this.data.checkpoints ?? [];
    const priorCheckpoint = [...checkpoints]
      .filter((c) => c.revisionIndex <= targetIdx)
      .sort((a, b) => b.revisionIndex - a.revisionIndex)[0];

    // Base state: the checkpoint's structured snapshot, or an empty snapshot.
    const baseState: Record<string, unknown> = priorCheckpoint
      ? (structuredClone(priorCheckpoint.stateSnapshot) as Record<string, unknown>)
      : this.emptyStructuredSnapshot();
    const startIdx = priorCheckpoint ? priorCheckpoint.revisionIndex + 1 : 0;

    const missingIds: string[] = [];
    const pages = new Map<string, unknown>();
    for (const page of (baseState["pages"] as { id: string; documentJson: unknown }[]) ?? []) {
      pages.set(page.id, page.documentJson);
    }

    for (let i = startIdx; i <= targetIdx; i += 1) {
      const rev = revisions[i]!;
      // A `restore` revision records its `afterSnapshot` as an ARRAY of
      // { pageId, documentJson } (see restoreRevision). Replay each entry so a
      // revision recorded AFTER a mid-segment restore reconstructs the restored
      // page content, even before the next checkpoint.
      if (rev.kind === "restore") {
        const entries = rev.afterSnapshot as
          | { pageId?: string; documentJson?: unknown }[]
          | undefined;
        if (!Array.isArray(entries)) {
          missingIds.push(rev.id);
          continue;
        }
        for (const entry of entries) {
          if (!entry || typeof entry.pageId !== "string") continue;
          pages.set(entry.pageId, entry.documentJson);
        }
        continue;
      }
      if (rev.kind !== "page-prose") continue;
      const after = rev.afterSnapshot as
        | { pageId?: string; documentJson?: unknown }
        | undefined;
      if (!after || typeof after.pageId !== "string") {
        // A prose revision with no replayable after-delta breaks the chain.
        missingIds.push(rev.id);
        continue;
      }
      pages.set(after.pageId, after.documentJson);
    }

    const reconstructedPages: { id: string; documentJson: unknown }[] = (
      (baseState["pages"] as { id: string }[]) ?? []
    ).map((p) => ({ ...p, documentJson: pages.get(p.id) }));
    // Include any page only referenced by replayed deltas (defensive).
    const known = new Set(reconstructedPages.map((p) => p.id));
    for (const [id, documentJson] of pages) {
      if (!known.has(id)) reconstructedPages.push({ id, documentJson });
    }
    const state = { ...baseState, pages: reconstructedPages };

    if (missingIds.length > 0) {
      return { status: "missing-segment", missingIds, fallbackState: state };
    }
    return { status: "ok", state };
  }

  /** A minimal empty structured snapshot (history collections excluded). */
  private emptyStructuredSnapshot(): Record<string, unknown> {
    const { revisions: _r, checkpoints: _c, ...structured } = this.data;
    const clone = structuredClone({ ...structured }) as Record<string, unknown>;
    clone["pages"] = [];
    return clone;
  }

  /**
   * M7 (H05) restore the brain to the state AS OF `revId` by reconstructing that
   * state and applying it to the live pages, recording a NEW FORWARD Revision.
   * It NEVER erases intermediate history - the revision list only GROWS, so the
   * restore is itself reversible. Returns the new forward Revision (or null when
   * the chain is broken and nothing could be restored).
   */
  async restoreRevision(revId: string): Promise<Revision | null> {
    // Flush any buffered prose so the restore records against settled history.
    if (this.pendingProse) await this.flushPendingRevision();
    const result = this.reconstructRevisionState(revId);
    const state =
      result.status === "ok" ? result.state : result.fallbackState;
    if (!state) return null;
    const restoredPages = (state as { pages?: { id: string; documentJson: unknown }[] })
      .pages;
    if (!restoredPages) return null;

    const beforePages = this.data.pages.map((p) => ({
      pageId: p.id,
      documentJson: structuredClone(p.documentJson),
    }));
    const now = new Date().toISOString();
    const restoredById = new Map(restoredPages.map((p) => [p.id, p.documentJson]));
    const pages = this.data.pages.map((p) =>
      restoredById.has(p.id)
        ? { ...p, documentJson: restoredById.get(p.id), updatedAt: now }
        : p,
    );
    this.data = { ...this.data, pages };
    // Record the restore as a NEW forward revision (history is never erased).
    return this.appendRevision({
      kind: "restore",
      label: "restore",
      createdAt: now,
      affectedObjectIds: restoredPages.map((p) => p.id),
      beforeSnapshot: beforePages,
      afterSnapshot: restoredPages.map((p) => ({
        pageId: p.id,
        documentJson: structuredClone(p.documentJson),
      })),
      summary: `Restored state as of revision ${revId}`,
    });
  }

  /**
   * M7 (H07) measure the on-disk/in-memory overhead of the linked-history
   * machinery: the number of revisions + checkpoints, the serialized byte size
   * of the revision deltas and of the checkpoint snapshots, and the wall-clock
   * time to replay the full revision chain once (the reconstruct cost).
   */
  measureHistoryOverhead(): HistoryOverhead {
    const revisions = this.data.revisions;
    const checkpoints = this.data.checkpoints ?? [];
    const deltaBytes = utf8ByteLength(JSON.stringify(revisions));
    const checkpointBytes = utf8ByteLength(JSON.stringify(checkpoints));
    const start =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    const last = revisions[revisions.length - 1];
    if (last) this.reconstructRevisionState(last.id);
    const end = typeof performance !== "undefined" ? performance.now() : Date.now();
    return {
      revisionCount: revisions.length,
      checkpointCount: checkpoints.length,
      deltaBytes,
      checkpointBytes,
      replayDurationMs: Math.max(0, end - start),
    };
  }

  /**
   * M7 (H04, D14) create a multi-span reflection linking a cherry-picked set of
   * revisions. Computes `startDateKey`/`endDateKey` from the linked revisions'
   * creation-day keys. A reflection NEVER rewrites a Revision and NEVER creates
   * a graph node (Page/Relationship/Category) - the counts are unchanged.
   */
  async createReflection(input: ReflectionInput): Promise<ReflectionEntry> {
    const linkedRevisionIds = input.linkedRevisionIds as readonly RevisionId[];
    const dateKeys = this.data.revisions
      .filter((r) => input.linkedRevisionIds.includes(r.id))
      .map((r) => r.dateKey ?? Workbench.dateKeyOf(r.createdAt))
      .sort();
    const now = new Date().toISOString();
    const entry: ReflectionEntry = {
      id: newReflectionId(),
      text: input.text,
      linkedRevisionIds,
      startDateKey: dateKeys[0] ?? Workbench.dateKeyOf(now),
      endDateKey: dateKeys[dateKeys.length - 1] ?? Workbench.dateKeyOf(now),
      createdAt: now,
    };
    this.data = {
      ...this.data,
      reflections: [...(this.data.reflections ?? []), entry],
    };
    await this.persist();
    return entry;
  }

  /**
   * M7 (H04) attach (or replace) a per-change comment on a revision. It is a
   * note ABOUT the change and NEVER rewrites the Revision itself. A no-op for an
   * unknown revision id.
   */
  async addRevisionComment(revId: string, text: string): Promise<void> {
    if (!this.data.revisions.some((r) => r.id === revId)) return;
    const revisionComments = {
      ...(this.data.revisionComments ?? {}),
      [revId]: text,
    };
    this.data = { ...this.data, revisionComments };
    await this.persist();
  }

  // -- M4 remote sync (Koofr): safe atomic publication + resilient refresh --

  /**
   * M4 (§15, A20) current remote-sync status for the UI banner. Reflects the
   * last publish/refresh outcome. `publishing` only while a publish is in
   * flight; `up-to-date` after a verified success; `offline`/`stale` with a
   * reason on failure.
   */
  syncStatus(): SyncStatus {
    return {
      state: this.syncState,
      lastSyncedRevision: this.lastSyncedRevision,
      ...(this.syncReason !== undefined ? { reason: this.syncReason } : {}),
    };
  }

  /**
   * M4 (§15, A20, H06) publish the live brain to a Koofr/WebDAV remote using the
   * POINTER-LAST protocol:
   *
   *   Step 1 (H06 economical assets): upload ONLY assets not already present on
   *     the remote (probe each `assets/<id>`); unchanged PDFs and history
   *     archives are never re-uploaded.
   *   Step 2: write `snapshots/rev-<publicationRevision>.json` and VERIFY the
   *     read-back integrity hash (sha256Hex of the snapshot JSON bytes).
   *   Step 3 (pointer LAST): update `current-revision.json` ONLY after steps 1
   *     and 2 succeed and verify.
   *
   * If any step before step 3 throws, the prior remote `current-revision.json`
   * is left untouched and the failure is surfaced through syncStatus().
   */
  async publishToRemote(remote: KoofrStorageAdapter): Promise<SyncStatus> {
    // Flush any buffered prose so the snapshot reflects settled state.
    if (this.pendingProse) await this.flushPendingRevision();

    this.syncState = "publishing";
    this.syncReason = undefined;
    const publicationRevision = this.data.manifest.publicationRevision;
    try {
      await remote.ensureLayout();

      // Step 1 (H06): upload only missing assets.
      for (const entry of this.data.manifest.assetIndex) {
        const assetId = entry.assetId as string;
        const already = await remote.hasAsset(assetId);
        if (already) continue;
        const bytes = await this.storage.readAsset(
          this.data.manifest.brainId,
          assetId,
        );
        // A locally-offloaded binary (A17) simply cannot be re-published; skip
        // it rather than fail the whole publish.
        if (!bytes) continue;
        await remote.writeAsset(assetId, bytes);
      }

      // Step 2: write the immutable snapshot and verify read-back integrity.
      const snapshotJson = JSON.stringify(this.data);
      const expectedHash = await sha256Hex(strToU8(snapshotJson));
      await remote.writeSnapshot(publicationRevision, snapshotJson);
      const readBack = await remote.readSnapshot(publicationRevision);
      if (readBack === null) {
        throw new Error("snapshot read-back missing after write");
      }
      const actualHash = await sha256Hex(strToU8(readBack));
      if (actualHash !== expectedHash) {
        throw new Error("snapshot read-back integrity hash mismatch");
      }

      // Step 3 (pointer LAST): advance the remote pointer only now.
      const pointer: RemotePointer = {
        publicationRevision,
        snapshotHash: expectedHash,
        updatedAt: new Date().toISOString(),
      };
      await remote.writePointer(pointer);

      this.syncState = "up-to-date";
      this.lastSyncedRevision = publicationRevision;
      this.syncReason = undefined;
      return this.syncStatus();
    } catch (err) {
      // A failure BEFORE step 3 leaves the prior remote pointer intact (we never
      // touched it). Surface the failure without advancing lastSyncedRevision.
      this.syncState = "offline";
      this.syncReason = err instanceof Error ? err.message : String(err);
      return this.syncStatus();
    }
  }

  /**
   * M4 (A20) resilient phone/client refresh. Reads `current-revision.json`,
   * fetches the target snapshot, validates it through the existing staging
   * validator, verifies the integrity hash, and ONLY THEN replaces active
   * state.
   *
   * A20 guarantee: on a dropped fetch, a corrupted/invalid snapshot, or an
   * integrity mismatch, the prior local working copy is retained UNTOUCHED
   * (this.data is never mutated) and syncStatus() is set to a stale/offline
   * state with a reason.
   */
  async refreshFromRemote(remote: KoofrStorageAdapter): Promise<SyncStatus> {
    try {
      const pointer = await remote.readPointer();
      if (!pointer) {
        this.syncState = "offline";
        this.syncReason = "no remote pointer (current-revision.json absent)";
        return this.syncStatus();
      }

      const snapshotJson = await remote.readSnapshot(pointer.publicationRevision);
      if (snapshotJson === null) {
        this.syncState = "stale";
        this.syncReason = `remote snapshot rev-${pointer.publicationRevision} missing`;
        return this.syncStatus();
      }

      // Integrity: the snapshot bytes must hash to the pointer's recorded hash.
      const actualHash = await sha256Hex(strToU8(snapshotJson));
      if (actualHash !== pointer.snapshotHash) {
        this.syncState = "stale";
        this.syncReason = "remote snapshot failed integrity verification";
        return this.syncStatus();
      }

      // Validate the snapshot shape through the staging validator WITHOUT
      // touching the live store. A hard-reject means a corrupted/invalid
      // snapshot; retain the local copy.
      const staged = await this.stageImport(snapshotJson);
      if (staged.outcome === "hard-reject") {
        this.clearStagedImport();
        this.syncState = "stale";
        this.syncReason = `remote snapshot rejected: ${staged.reason}`;
        return this.syncStatus();
      }

      // Parse into a fully-populated BrainData only after validation passed.
      const next = migrateBrainData(JSON.parse(snapshotJson));
      this.clearStagedImport();
      this.data = next;
      this.syncState = "up-to-date";
      this.lastSyncedRevision = pointer.publicationRevision;
      this.syncReason = undefined;
      return this.syncStatus();
    } catch (err) {
      // A20: any interruption/corruption leaves this.data untouched.
      this.clearStagedImport();
      this.syncState = "offline";
      this.syncReason = err instanceof Error ? err.message : String(err);
      return this.syncStatus();
    }
  }

  // -- M5 mobile thought capture + idempotent desktop queue -----------------

  /** All captures in the live brain (for the mobile composer / desktop queue). */
  captures(): readonly Capture[] {
    return this.data.captures;
  }

  /** The capture-handling audit log (dedupe key store for A22 idempotency). */
  captureHandlings(): readonly CaptureHandling[] {
    return this.data.captureHandlings ?? [];
  }

  /**
   * M5 (§16.2, A23) create a mobile Capture saved locally IMMEDIATELY. The
   * capture is a loose thought/quote: creating one (with or WITHOUT a source)
   * MUST NEVER create a Page/Category/Relationship graph node. It is only added
   * to this.data.captures and persisted. Status is `"local"` by default, or
   * `"pending"` when queued for upload.
   */
  async createMobileCapture(input: MobileCaptureInput): Promise<Capture> {
    const now = new Date().toISOString();
    const status: Capture["status"] = input.queueForUpload ? "pending" : "local";
    const capture: Capture = {
      id: newCaptureId(),
      // Keep the canonical `sourceId` field assignable (SourceId | null) and
      // mirror an explicit optional sourceId when provided.
      sourceId: input.sourceId ?? null,
      text: input.content,
      createdAt: now,
      ...(input.originDevice !== undefined ? { originDevice: input.originDevice } : {}),
      ...(input.anchor !== undefined ? { anchor: input.anchor } : {}),
      ...(input.targetPageId !== undefined ? { targetPageId: input.targetPageId } : {}),
      status,
    };
    // A23: ONLY the captures collection is touched. No Page/Category/Relationship.
    this.data = { ...this.data, captures: [...this.data.captures, capture] };
    await this.persist();
    return capture;
  }

  /**
   * M5 (§16.2) upload every local/pending capture to the remote `captures/`
   * collection as an INDEPENDENT item (never overwriting the published PC brain
   * snapshot) and transition its status to `"uploaded"`. On an offline/error
   * for a capture, its status is kept `"pending"` with an honest error recorded
   * through syncStatus; the capture is never thrown away. Returns the per-id
   * outcome.
   */
  async uploadPendingCaptures(
    remote: KoofrStorageAdapter,
  ): Promise<{ captureId: string; status: "uploaded" | "pending"; error?: string }[]> {
    const results: { captureId: string; status: "uploaded" | "pending"; error?: string }[] = [];
    let ensured = false;
    const nextCaptures = this.data.captures.slice();
    let changed = false;
    let lastError: string | undefined;

    for (let i = 0; i < nextCaptures.length; i += 1) {
      const cap = nextCaptures[i]!;
      if (cap.status !== "local" && cap.status !== "pending") continue;
      try {
        if (!ensured) {
          await remote.ensureLayout();
          ensured = true;
        }
        await remote.writeCapture(cap.id as string, JSON.stringify(cap));
        nextCaptures[i] = { ...cap, status: "uploaded" };
        changed = true;
        results.push({ captureId: cap.id as string, status: "uploaded" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        lastError = message;
        // Keep the capture queued for a later retry; do not discard it.
        if (cap.status !== "pending") {
          nextCaptures[i] = { ...cap, status: "pending" };
          changed = true;
        }
        results.push({ captureId: cap.id as string, status: "pending", error: message });
      }
    }

    if (changed) {
      this.data = { ...this.data, captures: nextCaptures };
      await this.persist();
    }
    if (lastError !== undefined) {
      this.syncState = "offline";
      this.syncReason = lastError;
    }
    return results;
  }

  /**
   * M5 (§16.3, A22) pull remote captures from the `captures/` collection into
   * the live brain, STRICTLY idempotent by CaptureId: a capture already present
   * in this.data.captures OR already recorded in this.data.captureHandlings is
   * incorporated AT MOST ONCE, so repeated / out-of-order pulls are safe.
   * Returns the ids newly incorporated.
   */
  async pullRemoteCaptures(remote: KoofrStorageAdapter): Promise<string[]> {
    const ids = await remote.listCaptureIds();
    const knownCaptureIds = new Set(this.data.captures.map((c) => c.id as string));
    const handledIds = new Set(
      (this.data.captureHandlings ?? []).map((h) => h.captureId as string),
    );

    const incorporated: string[] = [];
    const additions: Capture[] = [];
    for (const id of ids) {
      // A22: dedupe against BOTH captures and handlings.
      if (knownCaptureIds.has(id) || handledIds.has(id)) continue;
      const json = await remote.readCapture(id);
      if (json === null) continue;
      let parsed: Capture;
      try {
        parsed = JSON.parse(json) as Capture;
      } catch {
        continue;
      }
      if (!parsed || typeof parsed.id !== "string") continue;
      // Guard against a duplicate id within this same pull batch.
      if (knownCaptureIds.has(parsed.id as string)) continue;
      knownCaptureIds.add(parsed.id as string);
      additions.push(parsed);
      incorporated.push(parsed.id as string);
    }

    if (additions.length > 0) {
      this.data = { ...this.data, captures: [...this.data.captures, ...additions] };
      await this.persist();
    }
    return incorporated;
  }

  /**
   * M5 (§16.3, A22) act on a pulled capture. STRICTLY idempotent: if the capture
   * was already handled (present in captureHandlings) this is a no-op.
   *
   *  - `insert-into-page`: insert the capture's thought/quote into its target
   *    Page and record a CaptureHandling with disposition `incorporated-quote`.
   *  - `create-subject`: DELIBERATELY create a new subject Page from the capture
   *    (disposition `created-subject`). This is the ONLY path in the capture
   *    engine that creates a Page, and only on this explicit user action.
   *  - `dismiss`: record disposition `dismissed`.
   *
   * In all cases the original Capture record is preserved with an updated
   * `status`, and a CaptureHandling is appended.
   */
  async handleCapture(
    captureId: CaptureId,
    action: CaptureAction,
  ): Promise<CaptureHandling | null> {
    const idStr = captureId as string;
    // A22: already handled -> no-op (idempotent).
    if ((this.data.captureHandlings ?? []).some((h) => (h.captureId as string) === idStr)) {
      return (
        (this.data.captureHandlings ?? []).find(
          (h) => (h.captureId as string) === idStr,
        ) ?? null
      );
    }
    const idx = this.data.captures.findIndex((c) => (c.id as string) === idStr);
    if (idx < 0) return null;
    const capture = this.data.captures[idx]!;
    const now = new Date().toISOString();

    let pages = this.data.pages;
    let destinationPageId: PageId | undefined;
    let disposition: CaptureHandling["disposition"];
    let nextStatus: Capture["status"];

    if (action === "insert-into-page") {
      const targetId = capture.targetPageId;
      const targetIdx =
        targetId != null ? this.data.pages.findIndex((p) => p.id === targetId) : -1;
      if (targetIdx < 0) {
        // No valid target page: cannot incorporate; leave the capture intact.
        return null;
      }
      const page = this.data.pages[targetIdx]!;
      const nextDoc = appendParagraphToDoc(page.documentJson, capture.text);
      const nextPages = this.data.pages.slice();
      nextPages[targetIdx] = { ...page, documentJson: nextDoc, updatedAt: now };
      pages = nextPages;
      destinationPageId = page.id;
      disposition = "incorporated-quote";
      nextStatus = "incorporated";
    } else if (action === "create-subject") {
      // DELIBERATE page creation on explicit user action only (A23 allows this
      // path because it is the user choosing to make a subject).
      const title = deriveCaptureTitle(capture.text);
      const newPage: Page = {
        id: newPageId(),
        kind: "subject",
        title,
        documentJson: appendParagraphToDoc(emptyDocJson(), capture.text),
        createdAt: now,
        updatedAt: now,
      };
      pages = [...this.data.pages, newPage];
      destinationPageId = newPage.id;
      disposition = "created-subject";
      nextStatus = "incorporated";
    } else {
      // dismiss
      disposition = "dismissed";
      nextStatus = "dismissed";
    }

    const captures = this.data.captures.slice();
    captures[idx] = { ...capture, status: nextStatus };
    const handling: CaptureHandling = {
      captureId,
      disposition,
      ...(destinationPageId !== undefined ? { destinationPageId } : {}),
      handledAt: now,
    };
    this.data = {
      ...this.data,
      pages,
      captures,
      captureHandlings: [...(this.data.captureHandlings ?? []), handling],
    };
    await this.persist();
    return handling;
  }

  // -- persistence ----------------------------------------------------------

  /**
   * Persist the current data through the adapter, advancing the publication
   * revision. Annotation styles live in `presentation.annotationStyles`, so
   * there is no longer any style-folding step here (the M1 capture sentinel is
   * gone). On failure, retain in-memory state and record a SaveError — the
   * caller/UI shows an actionable error and keeps the draft.
   */
  private async persist(): Promise<void> {
    // Serialize every persist through a single promise chain. Rapid mutations
    // (e.g. setComment on two annotations back to back) must apply and resolve
    // in call order; otherwise a slow first write could land AFTER a fast
    // second write and clobber it with a stale snapshot. Each queued task reads
    // the LATEST `this.data` at execution time so writes compose instead of
    // racing. A rejection does not break the chain for subsequent saves.
    const run = this.saveQueue.then(() => this.persistNow());
    // Swallow rejections on the chain tail so one failed save cannot reject the
    // next caller's queued promise; the real error is still surfaced via `run`.
    this.saveQueue = run.catch(() => undefined);
    return run;
  }

  /** Perform a single write-through. Only ever invoked from the save queue. */
  private async persistNow(): Promise<void> {
    const next: BrainData = {
      ...this.data,
      manifest: {
        ...this.data.manifest,
        publicationRevision: this.data.manifest.publicationRevision + 1,
        updatedAt: new Date().toISOString(),
      },
    };
    try {
      if (this.failNextSaves > 0) {
        this.failNextSaves -= 1;
        throw new Error("simulated save failure");
      }
      await this.storage.writeBrain(next);
      // Do NOT assign `next` wholesale: `this.data` may have been mutated while
      // the write was in flight (a page created, an annotation committed...).
      // Replacing it with the pre-await snapshot would silently drop those
      // edits from memory. Adopt only the revision bookkeeping we just wrote;
      // the mutator that made the concurrent edit queues its own persist, which
      // re-reads the latest data.
      this.data = {
        ...this.data,
        manifest: {
          ...this.data.manifest,
          publicationRevision: next.manifest.publicationRevision,
          updatedAt: next.manifest.updatedAt,
        },
      };
      this.saveError = null;
    } catch (err) {
      // Keep this.data at its pre-persist value so the draft is not lost.
      this.saveError = {
        message: err instanceof Error ? err.message : String(err),
        atISO: new Date().toISOString(),
      };
      throw err;
    }
  }

  /**
   * Re-attempt a persist after a previous save failed, clearing `saveError` on
   * success. The current in-memory draft (never discarded on failure) is what
   * gets written. A no-op resolve when there is no recorded error.
   */
  async retrySave(): Promise<void> {
    if (!this.saveError) return;
    await this.persist();
  }

  /** Normalized union bounding box for a set of rects (used for overlays). */
  static boundingBox(rects: readonly NormalizedRect[]): NormalizedRect | null {
    if (rects.length === 0) return null;
    const x0 = Math.min(...rects.map((r) => r.x));
    const y0 = Math.min(...rects.map((r) => r.y));
    const x1 = Math.max(...rects.map((r) => r.x + r.width));
    const y1 = Math.max(...rects.map((r) => r.y + r.height));
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }
}
