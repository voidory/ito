/**
 * FEAT-005B — opt-in MANIFEST generator for the real-world corpus.
 *
 * The TypeScript corpus (`corpus.ts`) + layout (`layout.ts`) are the single
 * source of truth. The external Python renderer needs that geometry as data, so
 * this suite (run with ITO_WRITE_REALWORLD_MANIFEST=1) writes
 * `fixtures/realworld/manifest.json`: for every structure, the pixel-space
 * atoms, bonds, labels, canvas size, render hints and dev/eval split.
 *
 *   ITO_WRITE_REALWORLD_MANIFEST=1 npx vitest run \
 *     src/science/skeleton/realworld/manifest
 *
 * Without the flag it is a cheap invariant assertion, so CI never writes.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REAL_WORLD_CORPUS } from "./corpus";
import { layoutStructure, pixelBondLength } from "./layout";
import { splitOf } from "./split";

const WRITE = process.env.ITO_WRITE_REALWORLD_MANIFEST === "1";

describe("real-world corpus manifest", () => {
  it(WRITE ? "writes manifest.json" : "has >= 50 structures spanning all categories", () => {
    expect(REAL_WORLD_CORPUS.length).toBeGreaterThanOrEqual(50);
    const categories = new Set(REAL_WORLD_CORPUS.map((s) => s.category));
    expect(categories.size).toBeGreaterThanOrEqual(8);
    const names = REAL_WORLD_CORPUS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);

    if (!WRITE) return;

    const here = dirname(fileURLToPath(import.meta.url));
    const outDir = resolve(here, "..", "fixtures", "realworld");
    mkdirSync(outDir, { recursive: true });

    const entries = REAL_WORLD_CORPUS.map((structure) => {
      const layout = layoutStructure(structure);
      return {
        name: structure.name,
        description: structure.description,
        category: structure.category,
        split: splitOf(structure.name),
        width: layout.width,
        height: layout.height,
        lineWidth: structure.render.lineWidth,
        bondLengthPx: pixelBondLength(structure),
        atoms: layout.atoms.map((p) => [round1(p.x), round1(p.y)]),
        bonds: structure.bonds.map(([a, b]) => [a, b]),
        labels: layout.labels.map((l) => [round1(l.x), round1(l.y), l.text]),
        expectedCycleRank: structure.expectedCycleRank,
      };
    });

    const manifest = {
      note:
        "Real-world carbon-skeleton benchmark. Generated from corpus.ts + layout.ts. " +
        "These are REAL molecular structures rendered to anti-aliased PNG (not scanned pages). " +
        "Synthetic SVG fixtures are a SEPARATE benchmark category and MUST NOT be combined.",
      pad: 28,
      count: entries.length,
      structures: entries,
    };

    writeFileSync(resolve(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    expect(entries.length).toBe(REAL_WORLD_CORPUS.length);
  });
});

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
