/**
 * src/network/search — a PURE, deterministic search + retrieval module
 * (M2-FIX-2, §13, §22 M2, A10, D07). Like the rest of src/network it imports
 * NO DOM, NO React, NO src/model and NO src/app: it operates ONLY on the
 * minimal structural view of the data the Workbench passes in, so it is
 * unit-testable in isolation and the Workbench owns the index construction.
 *
 * It provides two capabilities:
 *
 *  1. `search(query, index, options?)` — a case-insensitive substring search
 *     across Page titles + ProseMirror body text, Category names, and
 *     Annotation anchor text + comment text, returning a DETERMINISTIC ordered
 *     list of discriminated results. An optional `categoryId` restricts page
 *     results to members of that category.
 *
 *  2. `neighborhood(pageId, edges)` — the 1-hop graph neighbourhood around a
 *     page: the connected PageIds and the connecting RelationshipIds, handling
 *     both the N=2 (lens) and N>=3 (star) endpoint cases and excluding the
 *     origin page itself.
 */

/** A page as seen by the search index: title + flattened body text + category membership. */
export interface SearchDoc {
  readonly pageId: string;
  readonly title: string;
  /** Flattened ProseMirror body text (no markers); may be empty. */
  readonly bodyText: string;
  /** Ids of the categories this page is a member of. */
  readonly categoryIds: readonly string[];
}

/** A category as seen by the search index. */
export interface SearchCategory {
  readonly categoryId: string;
  readonly name: string;
}

/** An annotation as seen by the search index: anchor text + comment. */
export interface SearchAnnotation {
  readonly annotationId: string;
  readonly sourceId: string;
  /** The anchor's searchable text (selected text, or a pp. range label). */
  readonly anchorText: string;
  readonly comment: string;
}

/** A relationship edge: its id + the normalized endpoint page ids (N>=2). */
export interface SearchEdge {
  readonly relationshipId: string;
  readonly endpointPageIds: readonly string[];
}

/** The full structural index the Workbench builds from live BrainData. */
export interface SearchIndex {
  readonly docs: readonly SearchDoc[];
  readonly categories: readonly SearchCategory[];
  readonly annotations: readonly SearchAnnotation[];
}

/** Which field a result matched on (lets the UI explain the hit). */
export type MatchedField =
  | "title"
  | "body"
  | "name"
  | "anchor"
  | "comment";

/** A single discriminated search result. */
export type SearchResult =
  | {
      readonly kind: "page";
      readonly id: string;
      readonly title: string;
      readonly matchedField: Extract<MatchedField, "title" | "body">;
    }
  | {
      readonly kind: "category";
      readonly id: string;
      readonly name: string;
      readonly matchedField: Extract<MatchedField, "name">;
    }
  | {
      readonly kind: "annotation";
      readonly id: string;
      readonly sourceId: string;
      readonly anchorText: string;
      readonly comment: string;
      readonly matchedField: Extract<MatchedField, "anchor" | "comment">;
    };

/** Options for `search`. */
export interface SearchOptions {
  /** Restrict PAGE results to members of this category id. */
  readonly categoryId?: string;
}

/** The result of a 1-hop neighbourhood query. */
export interface Neighborhood {
  readonly pageIds: string[];
  readonly relationshipIds: string[];
}

/** Stable kind ordering so results group deterministically. */
const KIND_ORDER: Record<SearchResult["kind"], number> = {
  page: 0,
  category: 1,
  annotation: 2,
};

/** Case-insensitive substring test. */
function contains(haystack: string, needleLower: string): boolean {
  return haystack.toLowerCase().includes(needleLower);
}

/**
 * Case-insensitive substring search across the index. Empty/whitespace-only
 * queries return `[]`. Pages match on title OR body text (title preferred when
 * both match); categories match on name; annotations match on anchor text OR
 * comment (anchor preferred). An optional `categoryId` restricts page results
 * to members of that category. The returned array is DETERMINISTIC: ordered by
 * kind (page, category, annotation) then by the entity id, so identical input
 * yields an identical array every call.
 */
export function search(
  query: string,
  index: SearchIndex,
  options: SearchOptions = {},
): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];

  const results: SearchResult[] = [];

  for (const doc of index.docs) {
    if (options.categoryId != null && !doc.categoryIds.includes(options.categoryId)) {
      continue;
    }
    const titleHit = contains(doc.title, q);
    const bodyHit = contains(doc.bodyText, q);
    if (titleHit || bodyHit) {
      results.push({
        kind: "page",
        id: doc.pageId,
        title: doc.title,
        matchedField: titleHit ? "title" : "body",
      });
    }
  }

  for (const category of index.categories) {
    if (contains(category.name, q)) {
      results.push({
        kind: "category",
        id: category.categoryId,
        name: category.name,
        matchedField: "name",
      });
    }
  }

  for (const annotation of index.annotations) {
    const anchorHit = contains(annotation.anchorText, q);
    const commentHit = contains(annotation.comment, q);
    if (anchorHit || commentHit) {
      results.push({
        kind: "annotation",
        id: annotation.annotationId,
        sourceId: annotation.sourceId,
        anchorText: annotation.anchorText,
        comment: annotation.comment,
        matchedField: anchorHit ? "anchor" : "comment",
      });
    }
  }

  results.sort((a, b) => {
    const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (byKind !== 0) return byKind;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return results;
}

/**
 * The 1-hop graph neighbourhood around `pageId`: the set of pages directly
 * connected to it by ANY relationship and the ids of those connecting
 * relationships. Works for both N=2 (lens) and N>=3 (star) edges — a star edge
 * connects its origin to EVERY other endpoint in a single hop. The origin page
 * is excluded from `pageIds`; pages 2+ hops away are never included. Both
 * returned arrays are de-duplicated and sorted for determinism.
 */
export function neighborhood(pageId: string, edges: readonly SearchEdge[]): Neighborhood {
  const pageIds = new Set<string>();
  const relationshipIds = new Set<string>();

  for (const edge of edges) {
    if (!edge.endpointPageIds.includes(pageId)) continue;
    relationshipIds.add(edge.relationshipId);
    for (const endpoint of edge.endpointPageIds) {
      if (endpoint !== pageId) pageIds.add(endpoint);
    }
  }

  return {
    pageIds: [...pageIds].sort(),
    relationshipIds: [...relationshipIds].sort(),
  };
}
