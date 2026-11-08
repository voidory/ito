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
  createEmptyBrainData,
  deriveSubjectReferenceStatus,
  deriveSubjectReferences,
  newAnnotationId,
  newAssetId,
  newCaptureId,
  newEvidenceInstanceId,
  newPageId,
  newSourceId,
  newSubjectAssociationId,
  type Annotation,
  type AnnotationId,
  type BrainData,
  type BrainId,
  type Capture,
  type EvidenceInstance,
  type NormalizedRect,
  type Page,
  type PageId,
  type ScopeAnchor,
  type Source,
  type SourceId,
  type SubjectAssociation,
  type SubjectReference,
  type SubjectReferenceStatus,
  type TextAnchor,
} from "../model";
import type { StorageAdapter } from "../storage";

/** The highlight style an annotation is committed with. */
export type HighlightStyle = "highlight" | "underline";

/** The available highlight colors (compact selection controls only). */
export const HIGHLIGHT_COLORS = ["yellow", "green", "blue", "pink"] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];

/**
 * Presentation attributes for an annotation. These are stored in the comment
 * channel's sibling map rather than on the model's Annotation (which stays the
 * pure section-20 contract); the workbench owns them and persists them inside
 * a reserved structure so save/reopen restores them. See `AnnotationView`.
 */
export interface AnnotationStyle {
  readonly kind: HighlightStyle;
  readonly color: HighlightColor;
}

/** Default style applied when a selection is committed with no explicit color. */
export const DEFAULT_STYLE: AnnotationStyle = { kind: "highlight", color: "yellow" };

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
 * Styles live outside the pure model so the section-20 Annotation stays clean.
 * They are persisted inside the manifest-adjacent `captures` channel would be
 * wrong (that is real data); instead the workbench serializes them into a
 * dedicated note Page? No — that would create a Page. Keep them in a parallel
 * record persisted alongside annotations via the adapter's structured blob.
 *
 * To avoid changing the storage contract we encode styles as a JSON string in
 * a single reserved Capture whose sourceId is null and whose text is tagged.
 */
const STYLE_CAPTURE_TAG = "\u0000ito:annotation-styles\u0000";

function readStyles(data: BrainData): Map<AnnotationId, AnnotationStyle> {
  const map = new Map<AnnotationId, AnnotationStyle>();
  const cap = data.captures.find((c) => c.text.startsWith(STYLE_CAPTURE_TAG));
  if (!cap) return map;
  try {
    const json = cap.text.slice(STYLE_CAPTURE_TAG.length);
    const parsed = JSON.parse(json) as Record<string, AnnotationStyle>;
    for (const [id, style] of Object.entries(parsed)) {
      map.set(id as AnnotationId, style);
    }
  } catch {
    // Corrupt style blob is non-fatal: fall back to defaults.
  }
  return map;
}

function writeStyles(
  data: BrainData,
  styles: Map<AnnotationId, AnnotationStyle>,
): BrainData {
  const payload: Record<string, AnnotationStyle> = {};
  for (const [id, style] of styles) payload[id] = style;
  const text = STYLE_CAPTURE_TAG + JSON.stringify(payload);
  const existing = data.captures.find((c) => c.text.startsWith(STYLE_CAPTURE_TAG));
  const others = data.captures.filter((c) => !c.text.startsWith(STYLE_CAPTURE_TAG));
  const cap: Capture = {
    id: existing?.id ?? newCaptureId(),
    sourceId: null,
    text,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  return { ...data, captures: [...others, cap] };
}

/** Immutable snapshot of workbench state the UI renders from. */
export interface WorkbenchState {
  readonly brainId: BrainId;
  readonly sources: readonly Source[];
  readonly pages: readonly Page[];
  /** Source ids currently open in the reading workspace (1 = single, 2+ = together). */
  readonly openSourceIds: readonly SourceId[];
  /** Whether the highlights tab (sidebar) is open; closed reserves ZERO width. */
  readonly highlightsTabOpen: boolean;
  /** Global suppress-motion setting (in-app, independent of OS media query). */
  readonly suppressMotion: boolean;
  /** Last save failure, if any; cleared on the next successful save. */
  readonly saveError: SaveError | null;
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
  private styles: Map<AnnotationId, AnnotationStyle>;
  private openSourceIds: SourceId[] = [];
  private highlightsTabOpen = false;
  private suppressMotion = false;
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
    this.styles = readStyles(data);
  }

  /** Open an existing brain, or create+persist a new empty one. */
  static async open(storage: StorageAdapter, brainId?: BrainId): Promise<Workbench> {
    let data: BrainData | null = null;
    if (brainId) {
      data = await storage.readBrain(brainId);
    } else {
      const ids = await storage.listBrains();
      if (ids[0]) data = await storage.readBrain(ids[0]);
    }
    if (!data) {
      data = createEmptyBrainData();
      await storage.writeBrain(data);
    }
    return new Workbench(storage, data);
  }

  // -- snapshot -------------------------------------------------------------

  snapshot(): WorkbenchState {
    return {
      brainId: this.data.manifest.brainId,
      sources: this.data.sources,
      pages: this.data.pages,
      openSourceIds: [...this.openSourceIds],
      highlightsTabOpen: this.highlightsTabOpen,
      suppressMotion: this.suppressMotion,
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

  /** Sources grouped by category, sorted for the library list (spec section 5). */
  librarySections(sortBy: "title" | "importedAt" = "title"): {
    category: string;
    sources: Source[];
  }[] {
    const byCategory = new Map<string, Source[]>();
    for (const s of this.data.sources) {
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
  }

  // -- highlights tab / motion ---------------------------------------------

  /** Open/close the highlights tab. Closed reserves ZERO sidebar width (R18). */
  setHighlightsTabOpen(open: boolean): void {
    this.highlightsTabOpen = open;
  }

  setSuppressMotion(suppress: boolean): void {
    this.suppressMotion = suppress;
  }

  /** Test-only: force the next `count` persist() calls to fail (R12 path). */
  forceNextSaveFailures(count: number): void {
    this.failNextSaves = count;
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
    this.styles.set(annotation.id, style);
    this.data = { ...this.data, annotations: [...this.data.annotations, annotation] };
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
    this.styles.set(annotation.id, input.style ?? DEFAULT_STYLE);
    this.data = { ...this.data, annotations: [...this.data.annotations, annotation] };
    await this.persist();
    return this.viewFor(annotation.id)!;
  }

  /** Change an annotation's highlight style (compact color/kind controls). */
  async setAnnotationStyle(id: AnnotationId, style: AnnotationStyle): Promise<void> {
    if (!this.data.annotations.some((a) => a.id === id)) return;
    this.styles.set(id, style);
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
    this.data = {
      ...this.data,
      annotations: this.data.annotations.filter((a) => a.id !== id),
      evidenceInstances: this.data.evidenceInstances.filter((e) => e.annotationId !== id),
      subjectAssociations: this.data.subjectAssociations.filter(
        (a) => a.annotationId !== id,
      ),
    };
    this.styles.delete(id);
    await this.persist();
  }

  // -- subject pages + association/citation state machine -------------------

  /**
   * Create a subject page. (In FEAT-003 subjects exist only as association
   * targets; FEAT-004 owns real composition.) Creating a subject is an
   * explicit user action and is NOT triggered by annotating.
   */
  async createSubjectPage(title: string): Promise<Page> {
    const now = new Date().toISOString();
    const page: Page = {
      id: newPageId(),
      kind: "subject",
      title,
      documentJson: { type: "doc", content: [{ type: "paragraph" }] },
      createdAt: now,
      updatedAt: now,
    };
    this.data = { ...this.data, pages: [...this.data.pages, page] };
    await this.persist();
    return page;
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

  /** Remove a tentative association for a pair (dotted → none if no evidence). */
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
   * Insert a provenance-bearing quote for an annotation into a subject page
   * (DOTTED → SOLID). FEAT-004 owns the real ProseMirror insertion; here we
   * record the EvidenceInstance that makes the pair derive as "cited". Multiple
   * quotes may exist for one pair; removing one must not demote the pair while
   * another remains.
   */
  async insertEvidence(
    annotationId: AnnotationId,
    destinationPageId: PageId,
    quotedText: string,
  ): Promise<EvidenceInstance> {
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
   * Remove one evidence instance. The pair's status is RE-DERIVED: it stays
   * "cited" while another quote remains, otherwise falls back per the
   * last-citation policy (ADR-0007: revert-to-tentative if an association
   * exists, else none).
   */
  async removeEvidence(evidenceId: string): Promise<void> {
    this.data = {
      ...this.data,
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
    const style = this.styles.get(id) ?? DEFAULT_STYLE;
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

  // -- persistence ----------------------------------------------------------

  /**
   * Persist the current data (styles folded in) through the adapter, advancing
   * the publication revision. On failure, retain in-memory state and record a
   * SaveError — the caller/UI shows an actionable error and keeps the draft.
   */
  private async persist(): Promise<void> {
    const withStyles = writeStyles(this.data, this.styles);
    const next: BrainData = {
      ...withStyles,
      manifest: {
        ...withStyles.manifest,
        publicationRevision: withStyles.manifest.publicationRevision + 1,
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
