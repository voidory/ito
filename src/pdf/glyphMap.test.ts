import { describe, expect, it, vi } from "vitest";
import { CachedGlyphMap, buildGlyphMap, findRunForOffset } from "./glyphMap";

/** Build a text-layer div with one span per supplied string. */
function textLayerWith(strings: string[]): HTMLElement {
  const el = document.createElement("div");
  for (const s of strings) {
    const span = document.createElement("span");
    span.textContent = s;
    el.appendChild(span);
  }
  return el;
}

describe("buildGlyphMap (§11)", () => {
  it("flattens text and records ordered non-overlapping runs", () => {
    const el = textLayerWith(["Hello", " ", "world"]);
    const map = buildGlyphMap(el);
    expect(map.text).toBe("Hello world");
    expect(map.runs.map((r) => [r.start, r.end])).toEqual([
      [0, 5],
      [5, 6],
      [6, 11],
    ]);
  });
});

describe("findRunForOffset binary search (§11)", () => {
  const el = textLayerWith(["abc", "def", "ghi"]); // offsets 0-3, 3-6, 6-9
  const map = buildGlyphMap(el);

  it("start mode: start <= offset < end", () => {
    expect(findRunForOffset(map, 0, "start")?.start).toBe(0);
    expect(findRunForOffset(map, 3, "start")?.start).toBe(3);
    expect(findRunForOffset(map, 5, "start")?.start).toBe(3);
    expect(findRunForOffset(map, 9, "start")).toBeNull(); // past end
  });

  it("end mode: start < offset <= end", () => {
    expect(findRunForOffset(map, 3, "end")?.start).toBe(0);
    expect(findRunForOffset(map, 6, "end")?.start).toBe(3);
    expect(findRunForOffset(map, 9, "end")?.start).toBe(6);
  });
});

describe("CachedGlyphMap reuse + invalidation (§11/§12/§20 case 12)", () => {
  it("builds the map once and reuses it across selection operations", () => {
    const el = textLayerWith(["Hello", " ", "world"]);
    const cached = new CachedGlyphMap(el);
    const spy = vi.spyOn(document, "createTreeWalker");

    // Many range operations (simulating repeated selection / Ctrl+F) …
    for (let i = 0; i < 25; i++) {
      cached.rangeFor(0, 5);
      cached.text();
    }
    // … build the glyph map exactly ONCE (the hot-path regression this fixes).
    expect(spy).toHaveBeenCalledTimes(1);
    expect(cached.getGeneration()).toBe(0);
    spy.mockRestore();
  });

  it("rebuilds only when the text layer actually changes (not on zoom/scroll)", () => {
    const el = textLayerWith(["Hello", " ", "world"]);
    const cached = new CachedGlyphMap(el);
    cached.get();
    const spy = vi.spyOn(document, "createTreeWalker");

    // Simulate zoom/scroll: NO DOM change, NO invalidate -> no rebuild.
    cached.rangeFor(0, 5);
    cached.text();
    expect(spy).toHaveBeenCalledTimes(0);

    // Now the text layer is re-rendered -> explicit invalidate -> one rebuild.
    cached.invalidate();
    expect(cached.getGeneration()).toBe(1);
    cached.get();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("resolves a DOM Range covering the requested offsets", () => {
    const el = textLayerWith(["Hello", " ", "world"]);
    const cached = new CachedGlyphMap(el);
    const range = cached.rangeFor(0, 5);
    expect(range.toString()).toBe("Hello");
    const range2 = cached.rangeFor(6, 11);
    expect(range2.toString()).toBe("world");
  });

  it("throws for offsets outside the text layer", () => {
    const el = textLayerWith(["abc"]);
    const cached = new CachedGlyphMap(el);
    expect(() => cached.rangeFor(5, 10)).toThrow(/not covered/);
  });
});
