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
 *    (PresentationState.hiddenPageIds / hiddenRelationshipIds), never a
 *    mutation or deletion of the underlying Page/Relationship.
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
  CheckpointId,
  EvidenceInstanceId,
  PageId,
  ReflectionId,
  RelationshipId,
  RevisionId,
  SourceId,
  SubjectAssociationId,
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
 *
 * M3 (A17, spec section 4.3) adds a fourth first-class state,
 * "binary-offloaded": the Source + Annotation records are intact and the stored
 * versionHash still matches, but the PDF BINARY has been evicted locally to
 * reclaim space (offline-first). The annotation/citation still FUNCTIONS from
 * the stored quote/comment/page metadata; only the live page render is
 * unavailable until the binary is re-attached. This is distinct from
 * "unresolved" (a record is gone) and "mismatched" (a true edition drift).
 */
export type AnchorResolution =
  | { readonly kind: "resolved" }
  | { readonly kind: "unresolved"; readonly reason: string }
  | {
      readonly kind: "mismatched";
      readonly reason: string;
      readonly expectedVersionHash: SourceVersionHash;
      readonly actualVersionHash: SourceVersionHash;
    }
  | { readonly kind: "binary-offloaded"; readonly reason: string };

// ---------------------------------------------------------------------------
// Source (spec section 20)
// ---------------------------------------------------------------------------

/**
 * M6 (A15, A24) a source is now either an imported "pdf" OR a snapshot
 * "website". The kind stays the primary discriminator; the optional `type`
 * alias (also "pdf"|"website") exists only because the spec's wording for the
 * website feature is `Source.type = "website"`. Both are kept in sync by the
 * workbench; `kind` remains the canonical field every reader already uses.
 */
export type SourceKind = "pdf" | "website";

/**
 * M6 (A15, D11) local availability of a source's rendered payload. A PDF whose
 * bytes are present is implicitly available; a snapshot website carries
 * "snapshot-cached" so the Reader can show a provenance badge explaining the
 * live URL is NOT fetched (the stored snapshot is the source of truth).
 */
export type SourceAvailabilityStatus = "snapshot-cached";

export interface Source {
  readonly id: SourceId;
  readonly kind: SourceKind;
  readonly title: string;
  /** Id of the stored binary asset (the PDF bytes, or the website snapshot). */
  readonly assetId: AssetId;
  readonly versionHash: SourceVersionHash;
  readonly pageCount: number;
  readonly importedAt: Timestamp;
  /**
   * Optional free-form library category used only to ORGANIZE the source list
   * (spec section 5). It is a label on the source, never a Category record and
   * never a Page — importing or categorizing a source creates no graph content.
   */
  readonly category: string;
  /**
   * M6 (A15) optional alias of `kind` mirroring the spec's `Source.type`
   * wording. Optional/additive so existing PDF sources (which only carry
   * `kind`) read fine; the workbench keeps it equal to `kind` when it is set.
   */
  readonly type?: SourceKind;
  /** M6 (A15, D11) original website URL for a snapshot source. Optional. */
  readonly url?: string;
  /** M6 (D11) local availability status (e.g. "snapshot-cached"). Optional. */
  readonly availabilityStatus?: SourceAvailabilityStatus;
  /**
   * M6 (A24, D10) stable external identifier when the source was imported from
   * an external library (Zotero item key). Importing matches on this id so a
   * re-import updates the record in place instead of duplicating it. Optional.
   */
  readonly externalId?: string;
  /**
   * FEAT-002 optional PDF document AUTHOR(s), extracted from pdf.js
   * `getMetadata().info.Author` at ingest / first load. Optional/additive so
   * existing serialized sources read fine; the Library prefers it over the
   * title-regex fallback when present.
   */
  readonly authors?: string;
  /**
   * FEAT-002 optional 4-digit publication YEAR, parsed from pdf.js
   * `info.CreationDate` / `info.ModDate` (falling back to a title regex in the
   * UI). Optional/additive — stored as a string to stay regex-friendly.
   */
  readonly year?: string;
  /**
   * M12 (FEAT-001) deterministic 64-bit FNV-1a hex digest (16 hex chars) of the
   * raw PDF `Uint8Array` bytes. The STRONGEST identity signal: two sources with
   * the same `contentHash` are byte-identical (Tier-1 match). Optional/additive
   * so existing serialized sources (which never carried it) load unchanged, and
   * `exactOptionalPropertyTypes: true`-safe (`string | undefined`).
   */
  readonly contentHash?: string | undefined;
  /**
   * M12 (FEAT-001) normalized canonical publication identifier scanned from the
   * PDF text / metadata, e.g. `"doi:10.1000/xyz"` or `"isbn:9781234567890"`.
   * Two sources sharing a `canonicalId` are the same work regardless of layout
   * drift (Tier-2 match). Optional/additive and exactOptional-safe.
   */
  readonly canonicalId?: string | undefined;
  /**
   * M12 (FEAT-001) normalized document stem + sequence token derived from the
   * title/filename, e.g. `"ch2101_lab::seq=lab:1"` or `"ch2101_lab"`. Lets a
   * revised university doc (`Lab1_draft` -> `Lab1_final`) re-hydrate the same
   * slot while a different sequence (`Lab1` vs `Lab2`) is hard-vetoed.
   * Optional/additive and exactOptional-safe.
   */
  readonly docStem?: string | undefined;
  /**
   * M12 (FEAT-001) up to 24 deterministic 64-bit FNV-1a hex hashes: 16 MinHash
   * 5-word shingles + 8 normalized-sentence hashes. Used for the fuzzy Tier-3
   * (textbook / cross-source paper) and Tier-4 (revised draft) matches via
   * Jaccard overlap. A scanned/empty PDF yields `< 4` shingles and is excluded
   * from fuzzy matching. Optional/additive and exactOptional-safe.
   */
  readonly textShingles?: readonly string[] | undefined;
}

// ---------------------------------------------------------------------------
// Annotation (spec section 20) — reader-side, anchored to a source
// ---------------------------------------------------------------------------

/**
 * M6 (D01) a rectangular AREA anchor: a single normalized rect on one page,
 * used for area annotations over scanned/image PDF content that has no
 * selectable text layer. It is DOM-independent like the other anchors.
 */
export interface AreaAnchor {
  readonly docId: SourceId;
  readonly sourceVersionHash: SourceVersionHash;
  readonly pageIndex: number;
  readonly rect: NormalizedRect;
  /**
   * FEAT-002 (2.4) Zotero-style figure cropper: an optional PNG (or SVG
   * fallback) data URL of the exact page-canvas pixel region the user dragged a
   * box over. Captured at commit time so the figure thumbnail renders in the
   * highlights drawer, the 1-click popover, and in a citing SubjectEditor
   * without re-rendering the live PDF. Optional so existing area anchors that
   * predate the cropper still typecheck.
   */
  readonly imageDataUrl?: string;
}

/**
 * An annotation scope is a text-level selection, a multi-page range, OR (M6,
 * D01) a rectangular AREA on a single page. Discriminated so callers must
 * handle each; the `area` variant is additive so existing text/pages data
 * still typechecks.
 */
export type AnnotationScope =
  | { readonly kind: "text"; readonly anchor: TextAnchor }
  | { readonly kind: "pages"; readonly anchor: ScopeAnchor }
  | { readonly kind: "area"; readonly anchor: AreaAnchor };

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
  /**
   * M6 (A24, D10) stable external identifier when the annotation was imported
   * from an external library (Zotero highlight/note key). Importing matches on
   * this id so a re-import updates in place rather than duplicating. Optional.
   */
  readonly externalId?: string;
  /**
   * M13 (§1.3) set `true` when a content/version-hash change moved this text
   * annotation's `pageIndex` (via {@link reanchorAnnotations}) so the stored
   * `anchor.rects` still hold the PREVIOUS draft's coordinates. The Reader
   * re-measures the quote against the live text layer on page render and calls
   * `updateAnnotationRects`, which writes fresh rects AND clears this flag.
   * Additive/optional so v1 brains without it read fine and SCHEMA_VERSION
   * stays unchanged.
   */
  readonly rectsStale?: boolean;
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
// Subject association (spec section 6 table, 4.2) — reader-side tentative link
// ---------------------------------------------------------------------------

/**
 * A SubjectAssociation is a TENTATIVE, reader-declared link from a source
 * Annotation to a destination subject Page (spec section 6 "Associate with
 * subject..."). It is DOTTED: it records intent without composing the page.
 *
 * It is deliberately distinct from an EvidenceInstance. An EvidenceInstance is
 * provenance-bearing (a real quote inserted into the page) and makes the pair
 * "cited" (solid). A SubjectAssociation carries no provenance and only makes a
 * pair "tentative" (dotted) when no evidence exists for that same pair.
 *
 * The citation status for an (annotation, destinationPage) pair is DERIVED from
 * the live sets of EvidenceInstances + SubjectAssociations (see citation.ts);
 * it is never a stored boolean. Removing one quote must not demote a pair that
 * still has another citing quote. An annotation may be tentatively associated
 * with a second subject while the first stays solid — each pair is independent.
 */
export interface SubjectAssociation {
  readonly id: SubjectAssociationId;
  readonly annotationId: AnnotationId;
  /** The subject page this annotation is tentatively associated with. */
  readonly destinationPageId: PageId;
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
 *
 * `colorCode` is the category's watercolor hex pigment (§3.2); it drives the
 * multiplicative `blendColor` derived for any Relationship/hub whose endpoints
 * span this category. `presentationOrder` is an OPTIONAL view ordering hint
 * (lower sorts first) — it is layout presentation, never a change to the
 * durable set of member pages. Both are additive: v1 brains without them read
 * fine because `colorCode` gets a default in brain.ts and the workbench, and
 * `presentationOrder` is optional. (ADR-0008.)
 */
export interface Category {
  readonly id: CategoryId;
  readonly name: string;
  readonly memberPageIds: readonly PageId[];
  readonly createdAt: Timestamp;
  /** Watercolor hex pigment for this category (e.g. "#ffcc00"). */
  readonly colorCode?: string;
  /** Optional presentation ordering hint; lower sorts first. View-only. */
  readonly presentationOrder?: number;
  /**
   * Optional id of this category's MASTER PAGE (A14, §12.2). A category has one
   * master page — a real `Page` record (editable in SubjectEditor) that MAY
   * connect to another category's boundary, giving category-to-category links a
   * first-class home rather than inferring them only from member bridges.
   * Additive/optional so v1 brains without it read fine and SCHEMA_VERSION
   * stays 1 (ADR-0010); brain.ts seeds no default because absence = "no master
   * page yet" and the workbench creates one lazily on demand.
   */
  readonly masterPageId?: PageId;
  /**
   * M13 (§2.1(2)) the Subject's moveable WATERCOLOUR BASIN geometry: the centre
   * `(x, y)` + semi-axes `(rx, ry)` of the organic territory the Subject's
   * Observation Nodes rest inside on the Nodes canvas. The basin is a Subject's
   * first-class spatial identity — NOT a point-node — so it can be dragged /
   * resized to overlap another Subject's basin (A∩B). When ABSENT the canvas
   * derives a DETERMINISTIC default basin from the category's position in the
   * category list so even a 0-node Subject renders a visible wash. The nodes a
   * basin geometrically contains define the Subject's membership (§2.1(3)).
   * Optional/additive so v1 brains without it read fine and SCHEMA_VERSION
   * stays unchanged.
   */
  readonly basin?: {
    readonly x: number;
    readonly y: number;
    readonly rx: number;
    readonly ry: number;
  };
  /**
   * M13 (§2.1(2)) id of this Subject's overarching SUBJECT PAGE — the real
   * `Page` record (kind "subject", editable in SubjectEditor) that holds the
   * user's macro thoughts about the whole Subject. Created lazily on demand via
   * `getOrCreateSubjectBasinPage(categoryId)`. This is DISTINCT from
   * `masterPageId` (the §12.2 category-boundary master page): a Subject may have
   * BOTH without either clobbering the other. Mirrors the `masterPageId`
   * pattern — optional/additive, v1-safe, no default seeded in brain.ts because
   * absence means "no Subject Page developed yet".
   */
  readonly subjectPageId?: PageId;
}

export type RelationshipKind = "relates" | "supports" | "contradicts" | "derives";

/**
 * A relationship in the concept network. Historically (M1) this was a DIRECTED
 * 2-page edge via `fromPageId`/`toPageId`. M2 reconciles that with the N>=3
 * star-hub "Connecting Page" (§3.1, A13-M2) ADDITIVELY: a relationship may now
 * carry `endpointPageIds` listing N>=2 page endpoints. The 2-page edge is the
 * DEGENERATE case — when `endpointPageIds` is absent, the endpoints are exactly
 * `[fromPageId, toPageId]` (which still render as a lens; N>=3 renders as the
 * arched star). Always read endpoints through `relationshipEndpoints(rel)` so
 * the rest of the app has ONE normalized accessor (see citation/index barrel).
 *
 * `hubPosition` and `blendColor` are DERIVED, cached presentation hints: the
 * hub centroid in 2D canvas coords and the watercolor-multiply of the endpoint
 * categories' colors (`deriveHubBlendColor`, §3.2). They are optional because
 * they are recomputable from positions + category colors; storing them is a
 * cache, not a source of truth. All new fields are optional/readonly so v1 data
 * loads with no migration and SCHEMA_VERSION stays 1 (ADR-0008, ADR-0004/M7).
 */
export interface Relationship {
  readonly id: RelationshipId;
  readonly fromPageId: PageId;
  readonly toPageId: PageId;
  readonly kind: RelationshipKind;
  readonly label: string;
  readonly createdAt: Timestamp;
  /**
   * Optional N>=2 endpoint representation for the Connecting Page. When absent,
   * endpoints are the 2-page degenerate case `[fromPageId, toPageId]`.
   */
  readonly endpointPageIds?: readonly PageId[];
  /** Derived, cached hub centroid in 2D canvas coords (recomputable). */
  readonly hubPosition?: { readonly x: number; readonly y: number };
  /** Derived, cached watercolor-multiply of the endpoint categories' colors. */
  readonly blendColor?: string;
  /**
   * Optional id of the relationship hub's EXPLANATORY PAGE (A13, §12.1 "The
   * Bump"). It lazily links a hub to a full `Page` record so a short connection
   * explanation can DEVELOP INTO A PAGE and connect further subjects, instead
   * of being reduced to an unnamed edge or a fixed-length label. Because the
   * page has a real `PageId`, it can itself participate as an endpoint in
   * further relationships. Optional/additive, v1-safe (ADR-0010): absence means
   * the hub only carries its short `label` and no page has been developed yet.
   */
  readonly explanatoryPageId?: PageId;
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
  /**
   * M5 (§16.2, A23) mobile-capture extensions. All OPTIONAL/readonly and
   * additive so a pre-M5 (v2) capture loads with no migration and
   * SCHEMA_VERSION stays 2. A capture is a loose thought/quote; creating one
   * NEVER creates a Page/Category/Relationship (A23).
   */
  /** Free-form label of the device the capture originated on (e.g. "phone"). */
  readonly originDevice?: string;
  /**
   * NOTE on sourceId: the capture's source is the EXISTING canonical
   * `sourceId: SourceId | null` field above. An M5 mobile capture simply sets
   * that field (null when the capture has no source). A separate optional
   * `sourceId` is intentionally NOT declared here because TypeScript forbids
   * redeclaring a property with a different modifier/type; the canonical field
   * already accepts a SourceId or null and stays assignable.
   */
  /**
   * Optional portable anchor into the source the capture was taken from, so a
   * desktop reviewer can jump to the exact passage. DOM-independent like every
   * other anchor.
   */
  readonly anchor?: TextAnchor | ScopeAnchor | AreaAnchor;
  /** Optional suggested target subject Page for later incorporation. */
  readonly targetPageId?: PageId;
  /**
   * Sync/lifecycle status of the capture (M5). `"local"` = saved on device only,
   * `"pending"` = queued for upload, `"uploaded"` = written to the remote
   * `captures/` collection, `"incorporated"` = acted on via handleCapture,
   * `"dismissed"` = explicitly discarded. Optional/additive.
   */
  readonly status?: "local" | "pending" | "uploaded" | "incorporated" | "dismissed";
}

/**
 * M5 (§16.3, A22) record of how a mobile Capture was handled on the desktop.
 * Appended to BrainData.captureHandlings so capture incorporation is strictly
 * idempotent by CaptureId: a repeated / out-of-order pull or a retried
 * handleCapture call can detect a capture has already been processed. The
 * original Capture record is always preserved; this is an audit entry, never a
 * graph node. All fields readonly; the collection is optional/additive.
 */
export interface CaptureHandling {
  readonly captureId: CaptureId;
  readonly disposition:
    | "incorporated-quote"
    | "created-subject"
    | "dismissed"
    | "pending";
  readonly destinationPageId?: PageId;
  readonly handledAt: string;
}

/**
 * A named point-in-time snapshot of the brain's publication state.
 *
 * M3 (spec section 2.2) extends a Revision so a DESTRUCTIVE action can record a
 * reconstructable snapshot of exactly what it touched BEFORE it mutates, so the
 * change can be reviewed or reversed. All new fields are OPTIONAL and readonly
 * so existing revisions and v1 data still typecheck and load with no migration.
 */
/**
 * M7 (H01, H02) classification of what a Revision recorded, so the history
 * timeline can describe each change and the coalescing logic can tell a
 * same-Page prose edit (coalesced within a 2s idle window) apart from a
 * structural action (quote insert/remove/reorder, annotation comment, range
 * boundary, tentative association, category, relationship) which flushes
 * immediately. Optional/additive so existing (M3) revisions still typecheck.
 */
export type RevisionKind =
  | "page-prose"
  | "quote-insert"
  | "quote-remove"
  | "quote-reorder"
  | "annotation-comment"
  | "range-boundary"
  | "tentative-association"
  | "category"
  | "relationship"
  | "delete-highlight-and-quotes"
  | "restore"
  | "other";

export interface Revision {
  readonly id: RevisionId;
  readonly publicationRevision: number;
  readonly label: string;
  readonly createdAt: Timestamp;
  /** Ids of the records this revision affected (e.g. the mutated page ids). */
  readonly affectedObjectIds?: readonly string[];
  /** Opaque snapshot of the affected records BEFORE the mutation. */
  readonly beforeSnapshot?: unknown;
  /** Opaque snapshot of the affected records AFTER the mutation (if captured). */
  readonly afterSnapshot?: unknown;
  /** Human-readable description of what the revision recorded. */
  readonly summary?: string;
  /**
   * M7 (H01/H02) structured classification of the change. Optional/additive;
   * absent on pre-M7 revisions. `"page-prose"` revisions are the ones coalesced
   * within COALESCE_WINDOW_MS; every other kind is flushed immediately.
   */
  readonly kind?: RevisionKind;
  /**
   * M7 (H03) creation-timezone day key `YYYY-MM-DD` derived from `createdAt`,
   * used to group the timeline by day. Optional/additive; the panel recomputes
   * it from `createdAt` when absent so old revisions still group correctly.
   */
  readonly dateKey?: string;
}

/**
 * M7 (H06, D13) periodic history checkpoint: a validated point-in-time snapshot
 * of the brain's STRUCTURED state written every CHECKPOINT_INTERVAL revisions so
 * `reconstructRevisionState` can replay forward from the nearest prior
 * checkpoint instead of from the very beginning.
 *
 * CRITICAL (H06): `stateSnapshot` MUST exclude the `revisions` and `checkpoints`
 * collections (no recursive history nesting) and MUST NOT duplicate PDF binary
 * bytes - it snapshots only the structured records (sources carry asset ids,
 * not bytes). All fields readonly; the whole collection is optional on BrainData
 * so a pre-M7 brain loads with no migration.
 */
export interface Checkpoint {
  readonly id: CheckpointId;
  readonly createdAt: Timestamp;
  /** Index into `revisions` of the last revision included in this snapshot. */
  readonly revisionIndex: number;
  /** Id of the last revision included in this snapshot (for direct lookup). */
  readonly afterRevisionId: RevisionId;
  /**
   * Structured BrainData with `revisions` and `checkpoints` EXCLUDED (H06) and
   * no asset bytes. Opaque to the model layer; replayed by the Workbench.
   */
  readonly stateSnapshot: unknown;
}

/**
 * M7 (H04, D14) a multi-span reflection: a user's written analysis that LINKS a
 * cherry-picked set of revisions (possibly spanning multiple days / weeks /
 * months). A reflection NEVER rewrites a Revision and NEVER creates a graph node
 * (Page/Relationship/Category) - it is a pure annotation over history.
 */
export interface ReflectionEntry {
  readonly id: ReflectionId;
  readonly text: string;
  readonly linkedRevisionIds: readonly RevisionId[];
  /** Earliest creation-timezone day key `YYYY-MM-DD` of the linked revisions. */
  readonly startDateKey: string;
  /** Latest creation-timezone day key `YYYY-MM-DD` of the linked revisions. */
  readonly endDateKey: string;
  readonly createdAt: Timestamp;
}

/**
 * Persisted annotation highlight style (spec §14). A model-layer record for the
 * `kind`/`color`/`strokeWidth` a user picks for an annotation highlight.
 *
 * It lives HERE (not in src/app) so `PresentationState.annotationStyles` can
 * reference it without the model layer importing from src/app — the model is
 * the pure section-20 contract and must never depend on the React/app layer.
 * `kind` and `color` are the required visual identity; `strokeWidth` is an
 * optional §14 refinement. All fields readonly like the rest of the contract.
 */
export interface AnnotationStyleRecord {
  readonly kind: string;
  readonly color: string;
  /** Optional §14 highlight stroke width. */
  readonly strokeWidth?: number;
}

/**
 * Presentation-only state for the concept network. Hiding a node or edge is a
 * VIEW operation and never deletes the underlying Page / Relationship.
 *
 * M2 (ADR-0009) expands this with the concept-network canvas view state. The
 * persistence scope of each field is resolved by D19:
 *
 *  - `positions` (M1) and `nodePositions` are the DURABLE laid-out 2D canvas
 *    coordinates keyed by page id. `positions` is kept for back-compat;
 *    `nodePositions` is the M2 name used by the network canvas and carries the
 *    same shape. A reader may hand-drag a node; the drag result lives in
 *    `nodePositions` so re-opening restores the arrangement.
 *  - `dragOffsets` are per-node user nudges relative to the engine layout —
 *    durable so a user's manual tweaks survive a relayout.
 *  - `categoryBounds` are the squircle boundary ellipses per category id
 *    (durable, recomputable from members but cached for stable framing).
 *  - `zoom` is the durable canvas zoom scale.
 *  - `active3D` is the §3.4 density-reward flag (durable) — whether the user
 *    has opted into the 3D presentation once it is unlocked.
 *
 * Every new field is OPTIONAL so a v1 `PresentationState` (only
 * hiddenPageIds/hiddenRelationshipIds/positions) still typechecks and loads
 * with no migration; brain.ts seeds the sensible defaults.
 */
export interface PresentationState {
  readonly hiddenPageIds: readonly PageId[];
  readonly hiddenRelationshipIds: readonly RelationshipId[];
  /** Optional saved layout positions, keyed by page id (M1 name). */
  readonly positions: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  /**
   * M2 concept-network 2D canvas coordinates keyed by page id. Same shape as
   * `positions`; the network canvas reads/writes this one.
   */
  readonly nodePositions?: Readonly<
    Record<string, { readonly x: number; readonly y: number }>
  >;
  /** Canvas zoom scale (1 = default). Durable. */
  readonly zoom?: number;
  /** Squircle boundary ellipse per category id (cx,cy center; rx,ry radii). */
  readonly categoryBounds?: Readonly<
    Record<
      string,
      { readonly cx: number; readonly cy: number; readonly rx: number; readonly ry: number }
    >
  >;
  /** §3.4 density-reward: whether the 3D presentation is active. Durable. */
  readonly active3D?: boolean;
  /** Per-node user-dragged offsets relative to the engine layout, by page id. */
  readonly dragOffsets?: Readonly<
    Record<string, { readonly x: number; readonly y: number }>
  >;
  /**
   * Non-destructive home for annotation highlight styles (§14), keyed by
   * annotation id string. This REPLACES the M1 sentinel-`Capture` hack (styles
   * smuggled into `BrainData.captures` via a fake capture with `sourceId:
   * null`), keeping `captures` strictly real user captures. Optional/additive
   * and v1-safe (ADR-0010): brain.ts seeds it to `{}` and a v1 brain without it
   * reads fine; SCHEMA_VERSION stays 1.
   */
  readonly annotationStyles?: Readonly<Record<string, AnnotationStyleRecord>>;
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
  /**
   * M3 backup descriptor (spec section 2.2, A18). "full" means the backup
   * carried every record + binary; "targeted" means a deliberately scoped
   * subset. Optional/readonly and v1-safe: absence means "not a backup / full".
   */
  readonly backupMode?: "full" | "targeted";
  /**
   * M3 backup omissions (spec section 2.2, A18): human-readable notes of what a
   * targeted backup intentionally left out (e.g. offloaded source binaries), so
   * a restore can report the gap rather than silently pretend completeness.
   * Optional/readonly and v1-safe.
   */
  readonly omissions?: readonly string[];
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
  readonly subjectAssociations: readonly SubjectAssociation[];
  readonly pages: readonly Page[];
  readonly categories: readonly Category[];
  readonly relationships: readonly Relationship[];
  readonly tentativeAssociations: readonly TentativeAssociation[];
  readonly captures: readonly Capture[];
  readonly revisions: readonly Revision[];
  readonly presentation: PresentationState;
  /**
   * M7 (H06, D13) periodic history checkpoints. Optional/readonly and additive
   * so a pre-M7 (v2) brain loads with no migration and SCHEMA_VERSION stays 2;
   * brain.ts seeds it to `[]` and migrate.ts defaults it. Written every
   * CHECKPOINT_INTERVAL revisions by the Workbench.
   */
  readonly checkpoints?: readonly Checkpoint[];
  /**
   * M7 (H04, D14) multi-span reflections over history. Optional/readonly and
   * additive (seeded to `[]`). Reflections never rewrite revisions and never
   * create graph nodes.
   */
  readonly reflections?: readonly ReflectionEntry[];
  /**
   * M7 (H04) per-revision user comments, keyed by revision id string. A
   * RevisionComment is a note ABOUT a change; it never rewrites the revision.
   * Optional/readonly and additive (seeded to `{}`).
   */
  readonly revisionComments?: Readonly<Record<string, string>>;
  /**
   * M5 (§16.3, A22) audit log of how mobile Captures were handled. Optional/
   * readonly and additive so a pre-M5 (v2) brain loads with no migration and
   * SCHEMA_VERSION stays 2; brain.ts seeds it to `[]` and migrate.ts defaults
   * it. Used to dedupe capture incorporation strictly by CaptureId.
   */
  readonly captureHandlings?: readonly CaptureHandling[];
  /**
   * M13 (§2.2, FEAT-003) the lazily-created SUBJECT-INTERSECTION Pages, keyed by
   * a deterministic overlap key (`sortedSubjectIds.join("|")`). Clicking an
   * overlapping Subject watercolour zone (A∩B∩…) opens ONE unified Subject
   * Intersection Page; this map lets `getOrCreateSubjectIntersectionPage`
   * dedupe by the sorted containing-subject set so the SAME overlap always
   * reopens the SAME page. Optional/readonly and additive so a pre-M13 brain
   * loads with no migration and SCHEMA_VERSION stays unchanged; brain.ts seeds
   * it to `{}` and migrate.ts defaults it.
   */
  readonly subjectIntersectionPages?: Readonly<Record<string, PageId>>;
}
