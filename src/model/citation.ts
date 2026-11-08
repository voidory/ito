import type { AnnotationId, PageId } from "./ids";
import type { EvidenceInstance, SubjectAssociation } from "./types";

/**
 * Citation status is DERIVED per (annotation, destination page) pair — spec
 * invariant (section 20). There is deliberately no standalone `isCited` boolean
 * stored on any record; it is always computed from the live set of
 * EvidenceInstances so it cannot drift out of sync.
 */
export type CitationStatus = "cited" | "uncited";

/**
 * The full source-association state for an (annotation, destination page) pair
 * (spec section 6 table). Derived, never stored:
 *
 *  - "cited"     (SOLID): at least one provenance-bearing EvidenceInstance
 *    links the pair. Evidence DOMINATES: a pair with evidence is always solid
 *    even if a tentative association also exists.
 *  - "tentative" (DOTTED): no evidence yet, but a SubjectAssociation declares
 *    reader intent to connect them.
 *  - "none": neither evidence nor association links the pair.
 *
 * This is the single derivation point for the state machine. Because it reads
 * the LIVE sets, removing one quote cannot demote a pair that still has another
 * citing quote, and the same annotation can be solid for one subject while
 * tentative for another — each pair resolves independently.
 */
export type SubjectReferenceStatus = "cited" | "tentative" | "none";

/**
 * Returns "cited" iff at least one EvidenceInstance links the given annotation
 * to the given destination page.
 */
export function deriveCitationStatus(
  annotationId: AnnotationId,
  destinationPageId: PageId,
  evidenceInstances: readonly EvidenceInstance[],
): CitationStatus {
  const cited = evidenceInstances.some(
    (e) => e.annotationId === annotationId && e.destinationPageId === destinationPageId,
  );
  return cited ? "cited" : "uncited";
}

/**
 * Count of distinct destination pages that cite the given annotation. Useful
 * for reader-side "used in N pages" affordances without ever storing a flag.
 */
export function countCitingPages(
  annotationId: AnnotationId,
  evidenceInstances: readonly EvidenceInstance[],
): number {
  const pages = new Set<PageId>();
  for (const e of evidenceInstances) {
    if (e.annotationId === annotationId) pages.add(e.destinationPageId);
  }
  return pages.size;
}

/**
 * Derive the source-association state for one (annotation, destination) pair
 * from the live sets of evidence + tentative associations. Evidence dominates
 * association, so a citation is reported as "cited" (solid) even if the pair
 * also carries a tentative association record.
 */
export function deriveSubjectReferenceStatus(
  annotationId: AnnotationId,
  destinationPageId: PageId,
  evidenceInstances: readonly EvidenceInstance[],
  subjectAssociations: readonly SubjectAssociation[],
): SubjectReferenceStatus {
  const cited = evidenceInstances.some(
    (e) => e.annotationId === annotationId && e.destinationPageId === destinationPageId,
  );
  if (cited) return "cited";
  const tentative = subjectAssociations.some(
    (a) => a.annotationId === annotationId && a.destinationPageId === destinationPageId,
  );
  return tentative ? "tentative" : "none";
}

/** A derived (annotation, destination) reference with its live status. */
export interface SubjectReference {
  readonly annotationId: AnnotationId;
  readonly destinationPageId: PageId;
  readonly status: SubjectReferenceStatus;
}

/**
 * Enumerate every (annotation, destination) pair that has either evidence or a
 * tentative association, with its derived status. This is the data a reader or
 * graph view consumes to draw solid vs dotted lines; pairs with status "none"
 * are omitted because nothing links them.
 */
export function deriveSubjectReferences(
  annotationId: AnnotationId,
  evidenceInstances: readonly EvidenceInstance[],
  subjectAssociations: readonly SubjectAssociation[],
): SubjectReference[] {
  const destinations = new Set<PageId>();
  for (const e of evidenceInstances) {
    if (e.annotationId === annotationId) destinations.add(e.destinationPageId);
  }
  for (const a of subjectAssociations) {
    if (a.annotationId === annotationId) destinations.add(a.destinationPageId);
  }
  const out: SubjectReference[] = [];
  for (const destinationPageId of destinations) {
    out.push({
      annotationId,
      destinationPageId,
      status: deriveSubjectReferenceStatus(
        annotationId,
        destinationPageId,
        evidenceInstances,
        subjectAssociations,
      ),
    });
  }
  return out;
}
