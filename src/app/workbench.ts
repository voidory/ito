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
  newAnnotationId,
  newAssetId,
  newCategoryId,
  newEvidenceInstanceId,
  newPageId,
  newRelationshipId,
  newSourceId,
  newSubjectAssociationId,
  relationshipEndpoints,
  type Annotation,
  type AnnotationId,
  type AnnotationStyleRecord,
  type AnchorResolution,
  type BrainData,
  type BrainId,
  type Category,
  type CategoryId,
  type EvidenceInstance,
  type NormalizedRect,
  type Page,
  type PageId,
  type Relationship,
  type RelationshipId,
  type RelationshipKind,
  type ScopeAnchor,
  type Source,
  type SourceId,
  type SubjectAssociation,
  type SubjectReference,
  type SubjectReferenceStatus,
  type TextAnchor,
} from "../model";
import { deriveHubBlendColor } from "../network";
import {
  appendEvidence,
  compositionStats,
  findEvidencePos,
  hydrateState,
  insertEvidenceAt,
  moveBlock,
  removeEvidenceNode,
  serializeState,
  type CompositionStats,
  type DocumentJson,
  type EvidenceAttrs,
} from "../editor";
import type { StorageAdapter } from "../storage";

/** An empty subject-page composition: one empty paragraph (never null). */
function emptyDocJson(): DocumentJson {
  return { type: "doc", content: [{ type: "paragraph" }] };
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
export type ViewMode = "files" | "nodes";

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
}

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
  private highlightsTabOpen = false;
  private suppressMotion = false;
  private view: ViewMode = "files";
  private workspaceLayout: WorkspaceLayout = DEFAULT_WORKSPACE_LAYOUT;
  private activeCategoryScope: string | null = null;
  private saveError: SaveError | null = null;
  /**
   * Test-only: when > 0, the next N persist() calls throw AFTER applying the
   * in-memory change, exercising the real draft-retention + error path (R12)
   * without needing to corrupt IndexedDB. Set via `failNextSaves`.
   */
  private failNextSaves = 0;

  private constructor(
    private readonly storage: StorageAdapter,
    data: BrainData,
  ) {
    this.data = data;
  }

  /** Open an existing brain, or create+persist a new empty one. */
  static async open(storage: StorageAdapter, brainId?: BrainId): Promise<Workbench> {
    let data: BrainData | null = null;
    let createdFresh = false;
    if (brainId) {
      data = await storage.readBrain(brainId);
    } else {
      const ids = await storage.listBrains();
      if (ids[0]) data = await storage.readBrain(ids[0]);
    }
    if (!data) {
      data = createEmptyBrainData();
      await storage.writeBrain(data);
      createdFresh = true;
    }
    const wb = new Workbench(storage, data);
    // One-time M1 -> M2.5 migration (ADR-0010): strip any legacy sentinel
    // Capture (sourceId===null + tagged style payload) out of BrainData.captures
    // and fold its styles into presentation.annotationStyles. A freshly created
    // brain can never carry the sentinel, so skip the extra persist for it.
    if (!createdFresh) await wb.migrateLegacyStyleCaptures();
    return wb;
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
      workspaceLayout: this.workspaceLayout,
      categoryScope: this.activeCategoryScope,
      saveError: this.saveError,
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
  }): Promise<Source> {
    const assetId = newAssetId();
    const source: Source = {
      id: newSourceId(),
      kind: "pdf",
      title: params.title,
      assetId,
      versionHash: params.versionHash,
      pageCount: params.pageCount,
      importedAt: new Date().toISOString(),
      category: params.category ?? "Uncategorized",
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

  /** Read the stored PDF bytes for a source (for the reader to render). */
  async readSourceBytes(sourceId: SourceId): Promise<Uint8Array | null> {
    const source = this.data.sources.find((s) => s.id === sourceId);
    if (!source) return null;
    return this.storage.readAsset(this.data.manifest.brainId, source.assetId);
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
        annotation.scope.kind === "text"
          ? annotation.scope.anchor.pageIndex
          : annotation.scope.anchor.startPageIndex;
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
    const updated: Annotation = {
      ...prev,
      comment,
      updatedAt: new Date().toISOString(),
    };
    const annotations = this.data.annotations.slice();
    annotations[idx] = updated;
    this.data = { ...this.data, annotations };
    await this.persist();
  }

  /** Delete an annotation and its style. Associating/citing never calls this. */
  async deleteAnnotation(id: AnnotationId): Promise<void> {
    const { [id]: _removed, ...remainingStyles } =
      this.data.presentation.annotationStyles ?? {};
    this.data = {
      ...this.data,
      annotations: this.data.annotations.filter((a) => a.id !== id),
      evidenceInstances: this.data.evidenceInstances.filter((e) => e.annotationId !== id),
      subjectAssociations: this.data.subjectAssociations.filter(
        (a) => a.annotationId !== id,
      ),
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

  /** The stored ProseMirror document JSON for a subject page (source of truth). */
  subjectDocJson(pageId: PageId): DocumentJson {
    const page = this.data.pages.find((p) => p.id === pageId);
    if (!page) throw new Error("subjectDocJson: unknown page");
    return (page.documentJson as DocumentJson) ?? emptyDocJson();
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
    const canonical = serializeState(hydrateState(json));
    const prev = this.data.pages[idx]!;
    const updated: Page = {
      ...prev,
      documentJson: canonical,
      updatedAt: new Date().toISOString(),
    };
    const pages = this.data.pages.slice();
    pages[idx] = updated;
    this.data = { ...this.data, pages };
    await this.persist();
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
    const pageIdx = this.data.pages.findIndex((p) => p.id === destinationPageId);
    if (pageIdx < 0) throw new Error("insertEvidenceIntoPage: unknown page");

    const evidence: EvidenceInstance = {
      id: newEvidenceInstanceId(),
      annotationId,
      destinationPageId,
      quotedText:
        annotation.scope.kind === "text"
          ? annotation.scope.anchor.selectedText
          : `pp. ${annotation.scope.anchor.startPageIndex + 1}-${
              annotation.scope.anchor.endPageIndex + 1
            }`,
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
    return evidence;
  }

  /**
   * Move a top-level block within a subject page's composition from index
   * `from` to index `to`, preserving order, formatting, quote identities and
   * links (A04). Re-derives + persists the canonical JSON.
   */
  async moveSubjectBlock(pageId: PageId, from: number, to: number): Promise<void> {
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
        readonly sourceId: SourceId;
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
        sourceId: evidence.annotationId as unknown as SourceId,
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
    return relationship;
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

    const nodes: ConceptNode[] = this.data.pages.map((page) => ({
      pageId: page.id,
      title: page.title,
      kind: page.kind,
      hidden: hiddenPages.has(page.id),
      position: positions[page.id] ?? null,
    }));

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
    }));

    return { nodes, links, categories };
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

  // -- persistence ----------------------------------------------------------

  /**
   * Persist the current data through the adapter, advancing the publication
   * revision. Annotation styles live in `presentation.annotationStyles`, so
   * there is no longer any style-folding step here (the M1 capture sentinel is
   * gone). On failure, retain in-memory state and record a SaveError — the
   * caller/UI shows an actionable error and keeps the draft.
   */
  private async persist(): Promise<void> {
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
      this.data = next;
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
