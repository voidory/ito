import { describe, expect, it } from "vitest";
import { extractPreParsedPageLayout, type TextItemLike, type ViewportLike } from "./textCache";
import { normalizePageAnalysis } from "./pageAnalyzer";

const viewport: ViewportLike = { width: 600, height: 800, rotation: 0 };

const textItems: TextItemLike[] = [
  { str: "Hello", transform: [12, 0, 0, 12, 60, 720], width: 40, height: 12 },
  { str: "World", transform: [12, 0, 0, 12, 110, 720], width: 42, height: 12 },
  { str: "rotated", transform: [0, 12, -12, 0, 300, 400], width: 50, height: 12 },
];

describe("page analyzer geometry equivalence (§10/§19/§20 case 10)", () => {
  it("cached normalized geometry equals the live text-layer extractor", () => {
    const live = extractPreParsedPageLayout(0, viewport, textItems);
    const analysis = normalizePageAnalysis({ pageNumber: 1, viewport, textItems });

    expect(analysis.text?.items.length).toBe(live.spans.length);
    for (let i = 0; i < live.spans.length; i++) {
      const span = live.spans[i]!;
      const item = analysis.text!.items[i]!;
      const [nx, ny, nw, nh] = span.normRect;
      // The analyzer's normalized rect must equal the live extractor's rect.
      expect(item.rect.x).toBeCloseTo(nx, 10);
      expect(item.rect.y).toBeCloseTo(ny, 10);
      expect(item.rect.width).toBeCloseTo(nw, 10);
      expect(item.rect.height).toBeCloseTo(nh, 10);
      expect(item.str).toBe(span.str);
      // geometry.textRects mirrors text.items order (no cross-join needed).
      expect(analysis.geometry!.textRects[i]).toEqual(item.rect);
    }
  });

  it("preserves page metadata (dimensions + rotation)", () => {
    const a = normalizePageAnalysis({
      pageNumber: 2,
      viewport: { width: 600, height: 800, rotation: 90 },
      textItems: [],
    });
    expect(a.width).toBe(600);
    expect(a.height).toBe(800);
    expect(a.rotation).toBe(90);
    expect(a.pageNumber).toBe(2);
  });

  it("captures a rotated baseline angle", () => {
    const a = normalizePageAnalysis({ pageNumber: 1, viewport, textItems });
    const rotated = a.text!.items.find((i) => i.str === "rotated");
    expect(rotated?.angleRad).toBeDefined();
    expect(Math.abs(rotated!.angleRad!)).toBeGreaterThan(1e-6);
  });
});

describe("annotation normalization (§2/§20 case 11)", () => {
  it("normalizes a PDF annotation rect (y-up -> y-down, 0..1)", () => {
    const a = normalizePageAnalysis({
      pageNumber: 1,
      viewport,
      textItems: [],
      annotations: [
        {
          id: "a1",
          subtype: "Link",
          // PDF user space (y-up): bottom-left (60,700) to top-right (160,740).
          rect: [60, 700, 160, 740],
          url: "https://example.org",
        },
      ],
    });
    expect(a.annotations).toHaveLength(1);
    const ann = a.annotations![0]!;
    expect(ann.subtype).toBe("Link");
    expect(ann.url).toBe("https://example.org");
    expect(ann.rect.x).toBeCloseTo(60 / 600, 10);
    // top edge = (vh - y2)/vh = (800 - 740)/800
    expect(ann.rect.y).toBeCloseTo((800 - 740) / 800, 10);
    expect(ann.rect.width).toBeCloseTo(100 / 600, 10);
    expect(ann.rect.height).toBeCloseTo(40 / 800, 10);
  });

  it("freshly analysed annotations equal a re-run of the same analysis (determinism)", () => {
    const args = {
      pageNumber: 1,
      viewport,
      textItems: [],
      annotations: [{ id: "x", subtype: "Highlight", rect: [10, 20, 30, 40] }],
    };
    const first = normalizePageAnalysis(args);
    const second = normalizePageAnalysis(args);
    expect(first).toEqual(second);
  });

  it("omits the annotations field entirely when there are none", () => {
    const a = normalizePageAnalysis({ pageNumber: 1, viewport, textItems });
    expect(a.annotations).toBeUndefined();
  });
});
