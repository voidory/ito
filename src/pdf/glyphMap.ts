/**
 * M18 (FEAT-PDF-CACHE §11) build-once, cached GLYPH MAP for a page's text layer.
 *
 * ------------------------------------------------------------------------
 * The problem this fixes
 * ------------------------------------------------------------------------
 * `render.ts` previously walked the ENTIRE text-layer DOM with a `TreeWalker`
 * on EVERY selection / range operation (`rangeToClientRects`, `selectRange`, and
 * the `pageText` getter each called `buildGlyphMap()` afresh). A highlight drag,
 * a Ctrl+F match, a live-preview tick — each re-walked every text node on the
 * page. That is O(nodes) per operation and O(nodes × operations) overall.
 *
 * ------------------------------------------------------------------------
 * The fix (§11)
 * ------------------------------------------------------------------------
 *   text layer created  ->  build glyph map ONCE  ->  cache it
 *                        ->  selection / range ops REUSE the cache
 *                        ->  invalidate ONLY when the text layer changes
 *
 *   - construction: a single O(n) TreeWalker pass over the text nodes;
 *   - offset -> node lookup: BINARY SEARCH over the ordered run ranges, O(log n),
 *     instead of a linear `.find()` scan over every run;
 *   - invalidation: a monotonic "generation" token bumped only when the text
 *     layer DOM actually changes (a re-render / hydration), so zoom / scroll /
 *     reopen never rebuild it (§12).
 *
 * The runs are intrinsically ordered (document order from the TreeWalker) and
 * non-overlapping ([start, end) offsets), so binary search is correct.
 */

/** One text-node run inside the text layer: its [start, end) offset span. */
export interface GlyphRun {
  readonly node: Text;
  /** Inclusive start offset into the flattened page text. */
  readonly start: number;
  /** Exclusive end offset into the flattened page text. */
  readonly end: number;
}

/** A built glyph map: the flattened page text + its ordered run index. */
export interface GlyphMap {
  /** Flattened page text (what offsets index into). */
  readonly text: string;
  /** Ordered, non-overlapping runs (document order). */
  readonly runs: readonly GlyphRun[];
}

/**
 * Build a {@link GlyphMap} from a text-layer element in a SINGLE O(n) pass
 * (§11). Walks the text nodes in document order, concatenating their data and
 * recording each node's [start, end) offset span. Derived from the LIVE DOM so
 * offsets line up with the client rects the DOM reports.
 */
export function buildGlyphMap(textLayerEl: HTMLElement): GlyphMap {
  const runs: GlyphRun[] = [];
  let text = "";
  const doc = textLayerEl.ownerDocument;
  const walker = doc.createTreeWalker(textLayerEl, NodeFilter.SHOW_TEXT);
  let n = walker.nextNode();
  while (n) {
    const node = n as Text;
    const content = node.data;
    runs.push({ node, start: text.length, end: text.length + content.length });
    text += content;
    n = walker.nextNode();
  }
  return { text, runs };
}

/**
 * Find the run that CONTAINS a given offset via binary search (§11), O(log n).
 * `mode` selects the half-open containment rule the caller needs:
 *   - "start": run.start <= offset < run.end  (the run a range START lands in);
 *   - "end":   run.start <  offset <= run.end  (the run a range END lands in).
 * Returns the run or null when the offset is outside every run.
 */
export function findRunForOffset(
  map: GlyphMap,
  offset: number,
  mode: "start" | "end",
): GlyphRun | null {
  const { runs } = map;
  let lo = 0;
  let hi = runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const run = runs[mid]!;
    const afterStart = mode === "start" ? offset >= run.start : offset > run.start;
    const beforeEnd = mode === "start" ? offset < run.end : offset <= run.end;
    if (afterStart && beforeEnd) return run;
    if (offset < run.start || (mode === "end" && offset <= run.start)) {
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return null;
}

/**
 * A cached glyph map bound to one text-layer element (§11). It builds the map
 * LAZILY on first use and reuses it until {@link invalidate} is called (which
 * the owner does only when the text layer DOM actually changes — a re-render or
 * a cache hydration). Zoom / scroll / selection operations reuse the SAME map.
 */
export class CachedGlyphMap {
  private map: GlyphMap | null = null;
  /** Bumped on invalidate so callers can detect a rebuild happened (tests §20). */
  private generation = 0;

  constructor(private readonly textLayerEl: HTMLElement) {}

  /** Get the glyph map, building it once and caching it (§11). */
  get(): GlyphMap {
    if (this.map === null) {
      this.map = buildGlyphMap(this.textLayerEl);
    }
    return this.map;
  }

  /** The flattened page text (cached). */
  text(): string {
    return this.get().text;
  }

  /**
   * Resolve a [start, end) offset range to a DOM Range, using binary search for
   * both endpoints (§11). Reuses the cached map — never re-walks the DOM.
   */
  rangeFor(start: number, end: number): Range {
    const map = this.get();
    const startRun = findRunForOffset(map, start, "start");
    const endRun = findRunForOffset(map, end, "end");
    if (!startRun || !endRun) {
      throw new Error(
        `CachedGlyphMap.rangeFor: offsets [${start}, ${end}) not covered by text layer`,
      );
    }
    const range = this.textLayerEl.ownerDocument.createRange();
    range.setStart(startRun.node, start - startRun.start);
    range.setEnd(endRun.node, end - endRun.start);
    return range;
  }

  /**
   * Invalidate the cached map — call ONLY when the text layer DOM changed (a
   * re-render at a new scale, or a cache hydration) (§11, §12). Zoom that only
   * transforms CSS does NOT change the DOM structure, so callers that merely
   * re-position spans must NOT invalidate.
   */
  invalidate(): void {
    this.map = null;
    this.generation += 1;
  }

  /** Current generation token; increments on each {@link invalidate} (tests). */
  getGeneration(): number {
    return this.generation;
  }

  /** True when a map is currently built + cached (tests §20 case 12). */
  isBuilt(): boolean {
    return this.map !== null;
  }
}
