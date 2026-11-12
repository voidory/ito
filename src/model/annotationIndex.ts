/**
 * Phase 1 (STRUCTURAL INDEXING) pure, framework-free structural indexes over a
 * canonical `Annotation[]`.
 *
 * ------------------------------------------------------------------------
 * Why this module exists
 * ------------------------------------------------------------------------
 * The workbench holds annotations in a flat immutable array
 * (`this.data.annotations`) and every lookup today is a linear scan
 * (`annotations.find(a => a.id === id)`, `annotations.filter(...)`). Resolving
 * one annotation, or the annotations on one page, is therefore O(n) per call —
 * and the reader calls these on every scroll frame, zoom and hit-test.
 *
 * This module derives two read indexes from the array:
 *   - {@link AnnotationById}      — id -> annotation,            O(1) resolve
 *   - {@link AnnotationsByPage}   — 0-based pageIndex -> annotations on it
 *
 * ------------------------------------------------------------------------
 * The ONE invariant that keeps the indexes honest
 * ------------------------------------------------------------------------
 * The array is the SINGLE source of truth. These indexes are a DERIVED view:
 * they are always built (or incrementally patched) FROM the array, never
 * written to independently. {@link assertIndexConsistency} re-derives from the
 * array and checks equality, so a test can prove the index never diverges.
 *
 * ------------------------------------------------------------------------
 * The tricky part: an annotation's page(s) are INDIRECT
 * ------------------------------------------------------------------------
 * `Annotation` carries no top-level `pageIndex`. The page(s) an annotation
 * occupies are derived from its `scope` (a discriminated union):
 *   - "text"  -> `anchor.pageIndex`                         (one page)
 *   - "area"  -> `anchor.pageIndex`                         (one page)
 *   - "pages" -> `anchor.startPageIndex..endPageIndex`      (an inclusive range)
 * {@link pagesForAnnotation} is the SINGLE canonical resolver for this, so the
 * per-scope branching is written exactly once instead of being duplicated
 * across `drawAnnotation`, hit-testing and re-anchoring.
 *
 * All page indices are 0-based (matching the model + the reader's
 * `data-page-index` convention). Pure + synchronous + dependency-free.
 */

import type { AnnotationId } from "./ids";
import type { Annotation } from "./types";

/** id -> annotation. Mirror of the canonical array keyed by stable id. */
export type AnnotationById = Map<AnnotationId, Annotation>;

/**
 * 0-based pageIndex -> the annotations occupying that page, in CANONICAL ARRAY
 * ORDER. A `"pages"`-scope annotation appears in EVERY bucket of its range. The
 * per-page arrays preserve the relative order of the source `Annotation[]` so
 * downstream rendering/z-order is unchanged.
 */
export type AnnotationsByPage = Map<number, Annotation[]>;

/** Both derived indexes bundled together. */
export interface AnnotationIndexes {
  readonly byId: AnnotationById;
  readonly byPage: AnnotationsByPage;
}

/**
 * The SINGLE canonical resolver of the 0-based page index(es) an annotation
 * occupies (see module header). Returns:
 *   - `[pageIndex]`                       for a "text" or "area" scope,
 *   - `[start, start+1, ..., end]`        for a "pages" scope range,
 *   - `[]`                                for a degenerate/invalid range.
 *
 * A "pages" range with `end < start` yields `[]` (the workbench rejects such a
 * range at creation, but the resolver stays defensive). O(1) for text/area and
 * O(range length) for a page range.
 */
export function pagesForAnnotation(annotation: Annotation): number[] {
  const scope = annotation.scope;
  if (scope.kind === "text" || scope.kind === "area") {
    return [scope.anchor.pageIndex];
  }
  // scope.kind === "pages"
  const { startPageIndex, endPageIndex } = scope.anchor;
  if (endPageIndex < startPageIndex) return [];
  const out: number[] = [];
  for (let p = startPageIndex; p <= endPageIndex; p++) out.push(p);
  return out;
}

/**
 * Build the id index from the canonical array in a single O(n) pass. The LAST
 * occurrence of a duplicate id wins (ids are unique in practice; this is only a
 * defensive tie-break).
 */
export function buildAnnotationById(annotations: readonly Annotation[]): AnnotationById {
  const map: AnnotationById = new Map();
  for (const a of annotations) map.set(a.id, a);
  return map;
}

/**
 * Build the page-bucket index from the canonical array in a single
 * O(n + Σ range length) pass. Iterates the array in order so each per-page
 * bucket preserves canonical order; a "pages" annotation is pushed into every
 * bucket of its range exactly once.
 */
export function buildAnnotationsByPage(
  annotations: readonly Annotation[],
): AnnotationsByPage {
  const map: AnnotationsByPage = new Map();
  for (const a of annotations) {
    for (const page of pagesForAnnotation(a)) {
      const bucket = map.get(page);
      if (bucket) bucket.push(a);
      else map.set(page, [a]);
    }
  }
  return map;
}

/** Build both derived indexes from the canonical array. */
export function buildAnnotationIndexes(
  annotations: readonly Annotation[],
): AnnotationIndexes {
  return {
    byId: buildAnnotationById(annotations),
    byPage: buildAnnotationsByPage(annotations),
  };
}

/** Read the annotations on a page, O(1 + Aₚ). Never returns a shared mutable ref. */
export function annotationsOnPage(
  byPage: AnnotationsByPage,
  pageIndex: number,
): Annotation[] {
  const bucket = byPage.get(pageIndex);
  return bucket ? bucket.slice() : [];
}

// ---------------------------------------------------------------------------
// Incremental maintenance helpers
// ---------------------------------------------------------------------------
//
// These mutate the two Maps in place for a single annotation add/remove/move so
// a mutation stays O(1) average (plus O(range) for a page-range annotation)
// rather than rebuilding the whole index. The workbench's immutable-array
// discipline means it CAN instead simply rebuild from the new array; these
// helpers are provided for the incremental path and are exercised by tests so
// both strategies are proven equivalent by assertIndexConsistency.

/** Register a newly created annotation in both indexes. */
export function indexAddAnnotation(indexes: AnnotationIndexes, annotation: Annotation): void {
  indexes.byId.set(annotation.id, annotation);
  for (const page of pagesForAnnotation(annotation)) {
    const bucket = indexes.byPage.get(page);
    if (bucket) {
      if (!bucket.some((a) => a.id === annotation.id)) bucket.push(annotation);
    } else {
      indexes.byPage.set(page, [annotation]);
    }
  }
}

/** Remove an annotation from a single page bucket, pruning an empty bucket. */
function removeFromPageBucket(
  byPage: AnnotationsByPage,
  pageIndex: number,
  id: AnnotationId,
): void {
  const bucket = byPage.get(pageIndex);
  if (!bucket) return;
  const next = bucket.filter((a) => a.id !== id);
  if (next.length === 0) byPage.delete(pageIndex);
  else byPage.set(pageIndex, next);
}

/** Remove a deleted annotation from both indexes (by its PREVIOUS value). */
export function indexRemoveAnnotation(
  indexes: AnnotationIndexes,
  annotation: Annotation,
): void {
  indexes.byId.delete(annotation.id);
  for (const page of pagesForAnnotation(annotation)) {
    removeFromPageBucket(indexes.byPage, page, annotation.id);
  }
}

/**
 * Update an EDITED annotation in both indexes. `prev` is the value currently in
 * the index (its page set before the edit), `next` is the new value. When the
 * page set changed (a move between pages, or a range resize) the annotation is
 * removed from the old buckets and added to the new ones; otherwise only the
 * `byId` value and the in-bucket references are refreshed. O(1) average plus
 * O(range) for page-range scopes.
 */
export function indexUpdateAnnotation(
  indexes: AnnotationIndexes,
  prev: Annotation,
  next: Annotation,
): void {
  indexes.byId.set(next.id, next);
  const prevPages = pagesForAnnotation(prev);
  const nextPages = pagesForAnnotation(next);
  const prevSet = new Set(prevPages);
  const nextSet = new Set(nextPages);

  // Remove from pages the annotation no longer occupies.
  for (const page of prevPages) {
    if (!nextSet.has(page)) removeFromPageBucket(indexes.byPage, page, prev.id);
  }
  // Add to newly occupied pages; refresh the reference on retained pages.
  for (const page of nextPages) {
    const bucket = indexes.byPage.get(page);
    if (!bucket) {
      indexes.byPage.set(page, [next]);
    } else {
      const at = bucket.findIndex((a) => a.id === next.id);
      if (at >= 0) bucket[at] = next;
      else if (!prevSet.has(page)) bucket.push(next);
      else bucket.push(next);
    }
  }
}

// ---------------------------------------------------------------------------
// Consistency assertion (test / dev-only)
// ---------------------------------------------------------------------------

/**
 * Re-derive the indexes from the canonical array and throw if the supplied
 * indexes disagree (Phase 1 §B/§C invariants). Verifies:
 *   - byId has exactly the array's ids, each mapping to the array's object;
 *   - every canonical annotation is in its correct page bucket(s);
 *   - no annotation appears twice in a bucket;
 *   - byPage has no bucket for a page with no annotations, and no stale entry.
 * Intended for tests + a dev assertion, not the hot path (it is O(n + pages)).
 */
export function assertIndexConsistency(
  annotations: readonly Annotation[],
  indexes: AnnotationIndexes,
): void {
  // byId: same size + every array entry present with object identity.
  if (indexes.byId.size !== annotations.length) {
    throw new Error(
      `annotationById size ${indexes.byId.size} != canonical ${annotations.length}`,
    );
  }
  for (const a of annotations) {
    const got = indexes.byId.get(a.id);
    if (got !== a) {
      throw new Error(`annotationById[${a.id}] does not match canonical annotation`);
    }
  }
  // Every indexed id must exist in the canonical array (no stale entries).
  const canonicalIds = new Set(annotations.map((a) => a.id));
  for (const id of indexes.byId.keys()) {
    if (!canonicalIds.has(id)) throw new Error(`annotationById has stale id ${id}`);
  }

  // byPage: re-derive and compare bucket membership + ordering + no dupes.
  const expected = buildAnnotationsByPage(annotations);
  if (indexes.byPage.size !== expected.size) {
    throw new Error(
      `annotationsByPage bucket count ${indexes.byPage.size} != expected ${expected.size}`,
    );
  }
  for (const [page, expectedBucket] of expected) {
    const got = indexes.byPage.get(page);
    if (!got) throw new Error(`annotationsByPage missing bucket for page ${page}`);
    const gotIds = got.map((a) => a.id);
    // No duplicate id within a bucket.
    if (new Set(gotIds).size !== gotIds.length) {
      throw new Error(`annotationsByPage bucket ${page} has a duplicate annotation`);
    }
    const expectedIds = expectedBucket.map((a) => a.id);
    if (gotIds.length !== expectedIds.length || gotIds.some((id, i) => id !== expectedIds[i])) {
      throw new Error(
        `annotationsByPage bucket ${page} mismatch: [${gotIds.join(",")}] != [${expectedIds.join(",")}]`,
      );
    }
    // Object identity check against canonical.
    for (const a of got) {
      if (indexes.byId.get(a.id) !== a) {
        throw new Error(`annotationsByPage bucket ${page} holds a stale object for ${a.id}`);
      }
    }
  }
}
