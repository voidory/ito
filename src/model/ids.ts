/**
 * Durable unique identifiers.
 *
 * Invariant (spec section 20): every record carries a unique, durable string
 * ID. IDs are opaque strings; callers MUST NOT parse meaning out of them. The
 * prefix exists only to make debugging/log inspection easier.
 */

export type Id = string;

/** Branded id types so the compiler catches cross-wiring of record ids. */
declare const brand: unique symbol;
export type Branded<T, B extends string> = T & { readonly [brand]: B };

export type BrainId = Branded<Id, "Brain">;
export type SourceId = Branded<Id, "Source">;
export type AnnotationId = Branded<Id, "Annotation">;
export type PageId = Branded<Id, "Page">;
export type EvidenceInstanceId = Branded<Id, "EvidenceInstance">;
export type RelationshipId = Branded<Id, "Relationship">;
export type CategoryId = Branded<Id, "Category">;
export type CaptureId = Branded<Id, "Capture">;
export type RevisionId = Branded<Id, "Revision">;
export type AssetId = Branded<Id, "Asset">;
export type TentativeAssociationId = Branded<Id, "TentativeAssociation">;
export type SubjectAssociationId = Branded<Id, "SubjectAssociation">;

type Prefix =
  | "brain"
  | "src"
  | "ann"
  | "page"
  | "evi"
  | "rel"
  | "cat"
  | "cap"
  | "rev"
  | "asset"
  | "tent"
  | "sassoc";

/**
 * Generate a new durable id with the given prefix. Uses crypto.randomUUID when
 * available (browser + Node 22), falling back to a time+random composition so
 * the generator never silently produces collisions in constrained runtimes.
 */
export function newId<T extends Id>(prefix: Prefix): T {
  const unique =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${unique}` as T;
}

export const newBrainId = (): BrainId => newId<BrainId>("brain");
export const newSourceId = (): SourceId => newId<SourceId>("src");
export const newAnnotationId = (): AnnotationId => newId<AnnotationId>("ann");
export const newPageId = (): PageId => newId<PageId>("page");
export const newEvidenceInstanceId = (): EvidenceInstanceId =>
  newId<EvidenceInstanceId>("evi");
export const newRelationshipId = (): RelationshipId => newId<RelationshipId>("rel");
export const newCategoryId = (): CategoryId => newId<CategoryId>("cat");
export const newCaptureId = (): CaptureId => newId<CaptureId>("cap");
export const newRevisionId = (): RevisionId => newId<RevisionId>("rev");
export const newAssetId = (): AssetId => newId<AssetId>("asset");
export const newTentativeAssociationId = (): TentativeAssociationId =>
  newId<TentativeAssociationId>("tent");
export const newSubjectAssociationId = (): SubjectAssociationId =>
  newId<SubjectAssociationId>("sassoc");
