/**
 * Logical data contract (spec section 20).
 *
 * These types are the source of truth for persisted records. Invariants that
 * the spec marks as binding are encoded in the type shapes and documented here
 * so a reader can map each rule to its enforcement point:
 *
 *  - Unique durable string IDs: every record has an `id` of a branded id type
 *    (see ids.ts). IDs are opaque.
 *  - Categories never duplicate pages: a Category references pages by id; a
 *    Page's canonical identity lives in exactly one place. Membership is a set
 *    of ids, never an embedded copy of the page. (Category.memberPageIds)
 *  - Annotation vs evidence distinction: an `Annotation` is anchored to a
 *    SOURCE (the reader side). An `EvidenceInstance` is a USE of an annotation
 *    inside a subject page's document (the composition side). They are distinct
 *    records with distinct ids.
 *  - Graph 'hide' never deletes content: visibility is presentation state
 *    (PresentationState.hiddenNodeIds / hiddenEdgeIds), never a mutation or
 *    deletion of the underlying Page/Relationship.
 *  - Evidence serialization independent of DOM coordinates: an EvidenceInstance
 *    stores the annotation id + a text snapshot, not pixel/DOM offsets. The
 *    ProseMirror document JSON (Page.documentJson) is the source of truth.
 *  - Unresolved sources/anchors explicit: ScopeAnchor / TextAnchor carry a
 *    `resolution` discriminated union; "unresolved" and "mismatched" are
 *    first-class states, never silently dropped.
 *  - Citation status derived per annotation-destination pair, NOT a standalone
 *    boolean: there is no `isCited` field. Status is computed by
 *    `deriveCitationStatus` over (annotation, destinationPageId) using the set
 *    of EvidenceInstances. See citation.ts.
 *  - Empty annotation comment is valid: Annotation.comment is `string` and may
 *    be "" — it is never required to be non-empty.
 */

import type {
  AnnotationId,
  AssetId,
  BrainId,
  CaptureId,
  CategoryId,
  EvidenceInstanceId,
  PageId,
  RelationshipId,
  RevisionId,
  SourceId,
  TentativeAssociationId,
} from "./ids";

/** ISO-8601 timestamp string. */
export type Timestamp = string;

/** SHA-style content hash of a source's bytes, used to detect edition drift. */
export type SourceVersionHash = string;

// ---------------------------------------------------------------------------
// Anchors (spec section 10) — portable, DOM-independent
// ---------------------------------------------------------------------------

/** Normalized rectangle on a page, all values in [0, 1] relative to page box. */
export interface NormalizedRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Portable text anchor (spec section 10.1). Intentionally free of any DOM or
 * pixel coordinates so it round-trips across renders, zoom levels and editions
 * of the same source.
 */
export interface TextAnchor {
  readonly docId: SourceId;
  readonly sourceVersionHash: SourceVersionHash;
  readonly pageIndex: number;
  /** Highlight geometry, normalized 0..1 per page. May span multiple rects. */
  readonly rects: readonly NormalizedRect[];
  readonly selectedText: string;
  /** Short text immediately before the selection, for re-anchoring. */
  readonly prefix: string;
  /** Short text immediately after the selection, for re-anchoring. */
  readonly suffix: string;
}

/**
 * A multi-page scope anchor (spec section 20). Used by annotations whose scope
 * is a page range rather than a single text selection.
 */
export interface ScopeAnchor {
  readonly docId: SourceId;
  readonly sourceVersionHash: SourceVersionHash;
  readonly startPageIndex: number;
  readonly endPageIndex: number;
}

/**
 * Resolution status for an anchor against the currently loaded source.
 * "unresolved" and "mismatched" are explicit, first-class states.
 */
export type AnchorResolution =
  | { readonly kind: "resolved" }
  | { readonly kind: "unresolved"; readonly reason: string }
  | {
      readonly kind: "mismatched";
      readonly reason: string;
      readonly expectedVersionHash: SourceVersionHash;
      readonly actualVersionHash: SourceVersionHash;
    };

// ---------------------------------------------------------------------------
// Source (spec section 20)
// ---------------------------------------------------------------------------

export type SourceKind = "pdf";

export interface Source {
  readonly id: SourceId;
  readonly kind: SourceKind;
  readonly title: string;
  /** Id of the stored binary asset (the PDF bytes). */
  readonly assetId: AssetId;
  readonly versionHash: SourceVersionHash;
  readonly pageCount: number;
  readonly importedAt: Timestamp;
}

// ---------------------------------------------------------------------------
// Annotation (spec section 20) — reader-side, anchored to a source
// ---------------------------------------------------------------------------

/**
 * An annotation scope is EITHER a text-level selection OR a multi-page range.
 * Discriminated so callers must handle both.
 */
export type AnnotationScope =
  | { readonly kind: "text"; readonly anchor: TextAnchor }
  | { readonly kind: "pages"; readonly anchor: ScopeAnchor };

export interface Annotation {
  readonly id: AnnotationId;
  readonly sourceId: SourceId;
  readonly scope: AnnotationScope;
  /** Current resolution of the annotation's anchor against the source. */
  readonly resolution: AnchorResolution;
  /** Free-form note. The empty string "" is a VALID comment. */
  readonly comment: string;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

// ---------------------------------------------------------------------------
// Evidence (spec sections 9, 20) — composition-side use of an annotation
// ---------------------------------------------------------------------------

/**
 * An EvidenceInstance is a USE of an annotation inside a subject page's
 * ProseMirror document. It is a distinct record from the Annotation itself.
 *
 * The instance stores a text snapshot (quotedText) captured at insertion time
 * so the document renders without resolving the live source, plus the owning
 * annotation id so the live source can be re-resolved on demand. It deliberately
 * stores NO DOM/pixel coordinates.
 */
export interface EvidenceInstance {
  readonly id: EvidenceInstanceId;
  readonly annotationId: AnnotationId;
  /** The subject page whose document contains this evidence node. */
  readonly destinationPageId: PageId;
  /** Snapshot of the quoted text at insertion time. */
  readonly quotedText: string;
  readonly createdAt: Timestamp;
}

// ---------------------------------------------------------------------------
// Pages, categories, relationships (spec section 20) — the concept network
// ---------------------------------------------------------------------------

export type PageKind = "subject" | "note";

/**
 * A deliberate subject page. `documentJson` is the ProseMirror document JSON and
 * is the SOURCE OF TRUTH for composed content (never the rendered HTML/DOM).
 */
export interface Page {
  readonly id: PageId;
  readonly kind: PageKind;
  readonly title: string;
  /** ProseMirror document JSON. Opaque to the model layer; see src/editor. */
  readonly documentJson: unknown;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/**
 * A category groups pages. It references member pages by id only; it NEVER
 * embeds or duplicates a Page. A page id may appear in many categories, but
 * the page itself exists in exactly one place.
 */
export interface Category {
  readonly id: CategoryId;
  readonly name: string;
  readonly memberPageIds: readonly PageId[];
  readonly createdAt: Timestamp;
}

export type RelationshipKind = "relates" | "supports" | "contradicts" | "derives";

/** A directed edge between two pages in the concept network. */
export interface Relationship {
  readonly id: RelationshipId;
  readonly fromPageId: PageId;
  readonly toPageId: PageId;
  readonly kind: RelationshipKind;
  readonly label: string;
  readonly createdAt: Timestamp;
}

/**
 * A tentative association is a not-yet-confirmed link suggested by the user or
 * system. Confirming it produces a Relationship; it is explicitly distinct so
 * the graph can show "proposed" links without committing content.
 */
export interface TentativeAssociation {
  readonly id: TentativeAssociationId;
  readonly fromPageId: PageId;
  readonly toPageId: PageId;
  readonly rationale: string;
  readonly createdAt: Timestamp;
}

// ---------------------------------------------------------------------------
// Capture, revision, presentation state (spec section 20)
// ---------------------------------------------------------------------------

/** A raw capture (e.g. an imported clipping) before it becomes structured. */
export interface Capture {
  readonly id: CaptureId;
  readonly sourceId: SourceId | null;
  readonly text: string;
  readonly createdAt: Timestamp;
}

/** A named point-in-time snapshot of the brain's publication state. */
export interface Revision {
  readonly id: RevisionId;
  readonly publicationRevision: number;
  readonly label: string;
  readonly createdAt: Timestamp;
}

/**
 * Presentation-only state for the concept network. Hiding a node or edge is a
 * VIEW operation and never deletes the underlying Page / Relationship.
 */
export interface PresentationState {
  readonly hiddenPageIds: readonly PageId[];
  readonly hiddenRelationshipIds: readonly RelationshipId[];
  /** Optional saved layout positions, keyed by page id. */
  readonly positions: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
}

// ---------------------------------------------------------------------------
// Assets + manifest (spec sections 14, 20)
// ---------------------------------------------------------------------------

/** Index entry describing a stored binary asset (e.g. a PDF). */
export interface AssetIndexEntry {
  readonly assetId: AssetId;
  readonly contentType: string;
  readonly byteLength: number;
  readonly contentHash: string;
}

/**
 * The top-level manifest for a brain. `schemaVersion` drives migrations;
 * `publicationRevision` advances on each safe publish (section 15).
 */
export interface BrainManifest {
  readonly brainId: BrainId;
  readonly schemaVersion: number;
  readonly publicationRevision: number;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly assetIndex: readonly AssetIndexEntry[];
}

/**
 * The full in-memory shape of a brain's structured records. This is what the
 * storage adapter reads and writes (binary assets are stored separately).
 */
export interface BrainData {
  readonly manifest: BrainManifest;
  readonly sources: readonly Source[];
  readonly annotations: readonly Annotation[];
  readonly evidenceInstances: readonly EvidenceInstance[];
  readonly pages: readonly Page[];
  readonly categories: readonly Category[];
  readonly relationships: readonly Relationship[];
  readonly tentativeAssociations: readonly TentativeAssociation[];
  readonly captures: readonly Capture[];
  readonly revisions: readonly Revision[];
  readonly presentation: PresentationState;
}
