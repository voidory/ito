import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalLatex, constructsOf, parseLatex } from "./normalize";
import { failureRateUpperBound } from "./score";

/**
 * Integrity of the committed benchmark corpus. These are the acceptance
 * criteria of Phase 1 that do not need a browser: the corpus is big enough for
 * the target to be testable, every construct is represented, and the manifest
 * is consistent with the PDFs next to it.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(HERE, "corpus/manifest.json"), "utf8")) as {
  equations: Record<string, string>;
  tiers: Record<
    string,
    { pdf: string; pageWidth: number; pageHeight: number; placements: [string, number, number, number, number, number][] }
  >;
};
const thresholds = JSON.parse(readFileSync(resolve(HERE, "thresholds.json"), "utf8")) as {
  tiers: Record<string, { target: number | null; floor: number }>;
  heldout: Record<string, { target: number | null }>;
};
const heldout = JSON.parse(readFileSync(resolve(HERE, "corpus-heldout/manifest.json"), "utf8")) as typeof manifest & {
  set: string;
  comparison: { drawn: number; excludedDevIds: string[] };
};

describe("LaTeX benchmark corpus", () => {
  it("every tier has its PDF, a threshold entry and in-page boxes for known equations", () => {
    for (const [name, tier] of Object.entries(manifest.tiers)) {
      expect(existsSync(resolve(HERE, "corpus", tier.pdf)), `${name} pdf`).toBe(true);
      expect(thresholds.tiers[name], `${name} thresholds`).toBeDefined();
      expect(tier.placements.length).toBeGreaterThan(0);
      for (const [id, page, x0, y0, x1, y1] of tier.placements) {
        expect(manifest.equations[id], `${name} ${id}`).toBeDefined();
        expect(page).toBeGreaterThanOrEqual(0);
        expect(x0).toBeGreaterThanOrEqual(0);
        expect(y0).toBeGreaterThanOrEqual(0);
        expect(x1).toBeLessThanOrEqual(tier.pageWidth);
        expect(y1).toBeLessThanOrEqual(tier.pageHeight);
        expect(x1 - x0).toBeGreaterThan(2);
        expect(y1 - y0).toBeGreaterThan(2);
      }
    }
  });

  it("boxes on a page do not overlap, so a selection never takes in a neighbour", () => {
    for (const [name, tier] of Object.entries(manifest.tiers)) {
      const byPage = new Map<number, typeof tier.placements>();
      for (const p of tier.placements) byPage.set(p[1], [...(byPage.get(p[1]) ?? []), p]);
      for (const list of byPage.values()) {
        const sorted = [...list].sort((a, b) => b[5] - a[5]); // top of page first
        for (let i = 1; i < sorted.length; i++) {
          expect(sorted[i]![5], `${name} ${sorted[i]![0]}`).toBeLessThanOrEqual(sorted[i - 1]![3]);
        }
      }
    }
  });

  it("holds only distinct, parseable equations", () => {
    const seen = new Set<string>();
    for (const [id, latex] of Object.entries(manifest.equations)) {
      const key = canonicalLatex(latex);
      expect(key, id).not.toBe("unparsed");
      expect(key, id).not.toBe("empty");
      expect(seen.has(key), `${id} duplicates another equation`).toBe(false);
      seen.add(key);
    }
  });

  it("is large enough for a 99.9% exact-match claim to be testable on TeX PDFs", () => {
    const n = manifest.tiers["tex-display"]!.placements.length;
    // With zero failures, the 95% upper bound on the failure rate must be < 0.1%.
    expect(failureRateUpperBound(n, 0)).toBeLessThan(0.001);
  });

  it("represents every construct at least 15 times in the display tier", () => {
    const counts = new Map<string, number>();
    for (const [id] of manifest.tiers["tex-display"]!.placements) {
      for (const c of constructsOf(parseLatex(manifest.equations[id]!))) {
        counts.set(c, (counts.get(c) ?? 0) + 1);
      }
    }
    const expected = [
      "script", "sub+sup", "nested-script", "prime", "fraction", "nested-fraction",
      "fraction-in-script", "radical", "root-index", "limits", "big-operator", "integral",
      "integral-bounds", "matrix", "cases", "multi-line", "accent", "overline", "binomial",
      "tall-delimiter", "function", "greek", "text", "upright-letter", "font-bf", "font-bb",
      "font-cal", "stacked-symbol", "plain",
    ];
    for (const c of expected) expect(counts.get(c) ?? 0, c).toBeGreaterThanOrEqual(15);
  });
});

describe("held-out LaTeX benchmark set", () => {
  it("every tier has its PDF, a target entry and in-page boxes for known equations", () => {
    expect(heldout.set).toBe("heldout");
    for (const [name, tier] of Object.entries(heldout.tiers)) {
      expect(existsSync(resolve(HERE, "corpus-heldout", tier.pdf)), `${name} pdf`).toBe(true);
      expect(thresholds.heldout[name], `${name} target`).toBeDefined();
      expect(tier.placements.length).toBeGreaterThan(0);
      for (const [id, page, x0, y0, x1, y1] of tier.placements) {
        expect(heldout.equations[id], `${name} ${id}`).toBeDefined();
        expect(page).toBeGreaterThanOrEqual(0);
        expect(x0).toBeGreaterThanOrEqual(0);
        expect(y0).toBeGreaterThanOrEqual(0);
        expect(x1).toBeLessThanOrEqual(tier.pageWidth);
        expect(y1).toBeLessThanOrEqual(tier.pageHeight);
      }
    }
  });

  it("shares no equation with the development corpus", () => {
    const dev = new Set(Object.values(manifest.equations).map(canonicalLatex));
    const seen = new Set<string>();
    for (const [id, latex] of Object.entries(heldout.equations)) {
      const key = canonicalLatex(latex);
      expect(dev.has(key), `${id} is also in the development corpus`).toBe(false);
      expect(seen.has(key), `${id} duplicates another held-out equation`).toBe(false);
      seen.add(key);
    }
  });

  it("records which development equations it also drew, so both sides can drop them", () => {
    const { drawn, excludedDevIds } = heldout.comparison;
    // Same draw size as the development corpus's generated part.
    expect(drawn).toBe(Object.keys(manifest.equations).filter((id) => id.startsWith("g")).length);
    expect(Object.keys(heldout.equations).filter((id) => id.startsWith("h")).length).toBe(drawn - excludedDevIds.length);
    expect(new Set(excludedDevIds).size).toBe(excludedDevIds.length);
    for (const id of excludedDevIds) {
      expect(id.startsWith("g"), id).toBe(true);
      expect(manifest.equations[id], id).toBeDefined();
    }
  });

  it("is large enough for a 99.9% claim to be testable, and covers every construct", () => {
    const display = heldout.tiers["tex-display"]!.placements;
    expect(failureRateUpperBound(display.length, 0)).toBeLessThan(0.001);
    const counts = new Map<string, number>();
    for (const [id] of display) {
      for (const c of constructsOf(parseLatex(heldout.equations[id]!))) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    const devConstructs = new Set<string>();
    for (const [id] of manifest.tiers["tex-display"]!.placements) {
      for (const c of constructsOf(parseLatex(manifest.equations[id]!))) devConstructs.add(c);
    }
    for (const c of devConstructs) expect(counts.get(c) ?? 0, c).toBeGreaterThanOrEqual(15);
  });
});

describe("real-paper tiers", () => {
  type Source = { arxiv: string; title: string; authors: string; licence: string };
  const sourcesOf = (m: unknown): Source[] => (m as { sources?: Source[] }).sources ?? [];

  it("credits every paper, and uses only CC BY 4.0 and CC0 papers", () => {
    for (const m of [manifest, heldout]) {
      const sources = sourcesOf(m);
      expect(sources.length).toBeGreaterThanOrEqual(10);
      for (const s of sources) {
        expect(s.arxiv).toMatch(/^\d{4}\.\d{4,5}$/);
        expect(s.title.length).toBeGreaterThan(0);
        expect(s.authors.length).toBeGreaterThan(0);
        expect(["http://creativecommons.org/licenses/by/4.0/", "http://creativecommons.org/publicdomain/zero/1.0/"]).toContain(s.licence);
      }
    }
  });

  it("puts no paper in both the development corpus and the held-out set", () => {
    const dev = new Set(sourcesOf(manifest).map((s) => s.arxiv));
    for (const s of sourcesOf(heldout)) expect(dev.has(s.arxiv), s.arxiv).toBe(false);
  });

  it("has a display and an inline tier in each set", () => {
    for (const m of [manifest, heldout]) {
      expect(m.tiers["real-display"]!.placements.length).toBeGreaterThanOrEqual(300);
      expect(m.tiers["real-inline"]!.placements.length).toBeGreaterThanOrEqual(300);
    }
  });
});
