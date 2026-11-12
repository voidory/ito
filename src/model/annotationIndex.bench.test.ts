/**
 * Phase 1 (STRUCTURAL INDEXING §C) performance instrumentation comparing the
 * EXISTING linear-scan lookups against the new indexed lookups across growing
 * datasets (10p/100a, 100p/1000a, 1000p/10000a).
 *
 * This is a MEASUREMENT harness, not a timing gate: it prints real per-op
 * figures to the console and asserts only correctness + that the index is not
 * dramatically slower (a generous bound) so it never flakes in CI. Treat the
 * printed numbers as observed measurements on the run machine, distinct from
 * the O(n) -> O(1) asymptotic expectation.
 */

import { describe, expect, it } from "vitest";
import type { Annotation, AnnotationId } from "./index";
import {
  buildAnnotationIndexes,
  annotationsOnPage,
  pagesForAnnotation,
} from "./annotationIndex";

function makeDataset(pageCount: number, annotationCount: number): Annotation[] {
  const anns: Annotation[] = [];
  for (let i = 0; i < annotationCount; i++) {
    const pageIndex = i % pageCount;
    anns.push({
      id: `ann_${i}` as AnnotationId,
      sourceId: "src" as Annotation["sourceId"],
      scope: {
        kind: "text",
        anchor: {
          docId: "src" as Annotation["sourceId"],
          sourceVersionHash: "h",
          pageIndex,
          rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.03 }],
          selectedText: "q",
          prefix: "",
          suffix: "",
        },
      },
      resolution: { kind: "resolved" },
      comment: "",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });
  }
  return anns;
}

function timeMs(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

const SCALES: Array<{ pages: number; annotations: number }> = [
  { pages: 10, annotations: 100 },
  { pages: 100, annotations: 1000 },
  { pages: 1000, annotations: 10000 },
];

describe("annotation index benchmark (linear vs indexed)", () => {
  for (const { pages, annotations } of SCALES) {
    it(`${pages} pages / ${annotations} annotations`, () => {
      const data = makeDataset(pages, annotations);
      const PROBES = 2000;
      // Deterministic probe ids/pages spread across the dataset.
      const probeIds: AnnotationId[] = [];
      const probePages: number[] = [];
      for (let i = 0; i < PROBES; i++) {
        probeIds.push(`ann_${(i * 7) % annotations}` as AnnotationId);
        probePages.push((i * 13) % pages);
      }

      // ---- index construction cost -------------------------------------
      let indexes!: ReturnType<typeof buildAnnotationIndexes>;
      const buildMs = timeMs(() => {
        indexes = buildAnnotationIndexes(data);
      });

      // ---- resolve annotation by id ------------------------------------
      let linearHits = 0;
      const linearIdMs = timeMs(() => {
        for (const id of probeIds) {
          const a = data.find((x) => x.id === id);
          if (a) linearHits++;
        }
      });
      let indexedHits = 0;
      const indexedIdMs = timeMs(() => {
        for (const id of probeIds) {
          const a = indexes.byId.get(id);
          if (a) indexedHits++;
        }
      });
      expect(indexedHits).toBe(linearHits); // same correctness

      // ---- retrieve annotations for a page -----------------------------
      let linearPageTotal = 0;
      const linearPageMs = timeMs(() => {
        for (const p of probePages) {
          const onPage = data.filter((a) => pagesForAnnotation(a).includes(p));
          linearPageTotal += onPage.length;
        }
      });
      let indexedPageTotal = 0;
      const indexedPageMs = timeMs(() => {
        for (const p of probePages) {
          indexedPageTotal += annotationsOnPage(indexes.byPage, p).length;
        }
      });
      expect(indexedPageTotal).toBe(linearPageTotal); // same correctness

      const fmt = (ms: number) => `${(ms / PROBES * 1000).toFixed(3)}µs/op`;
      // eslint-disable-next-line no-console
      console.log(
        `\n[bench ${pages}p/${annotations}a] build=${buildMs.toFixed(2)}ms | ` +
          `id: linear ${fmt(linearIdMs)} vs indexed ${fmt(indexedIdMs)} ` +
          `(${(linearIdMs / Math.max(indexedIdMs, 1e-6)).toFixed(1)}x) | ` +
          `page: linear ${fmt(linearPageMs)} vs indexed ${fmt(indexedPageMs)} ` +
          `(${(linearPageMs / Math.max(indexedPageMs, 1e-6)).toFixed(1)}x)`,
      );

      // Correctness-anchored sanity bound only (never a strict timing gate):
      // the indexed path must not be pathologically slower than linear.
      expect(indexedIdMs).toBeLessThanOrEqual(linearIdMs + 50);
      expect(indexedPageMs).toBeLessThanOrEqual(linearPageMs + 50);
    });
  }
});
