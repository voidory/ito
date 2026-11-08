import type { AnnotationId, PageId } from "./ids";
import type { EvidenceInstance } from "./types";

/**
 * Citation status is DERIVED per (annotation, destination page) pair — spec
 * invariant (section 20). There is deliberately no standalone `isCited` boolean
 * stored on any record; it is always computed from the live set of
 * EvidenceInstances so it cannot drift out of sync.
 */
export type CitationStatus = "cited" | "uncited";

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
