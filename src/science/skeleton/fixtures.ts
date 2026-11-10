/**
 * FEAT-005 — controlled carbon-skeleton test corpus.
 *
 * Each fixture is a skeletal organic structure defined by its ground-truth
 * carbon graph: atom pixel coordinates + carbon-carbon bonds (index pairs). The
 * geometry uses conventional skeletal angles (120 deg zig-zags, regular ring
 * polygons) and a uniform bond length, so rasterising the bonds produces a
 * clean skeletal drawing whose correct reconstruction is known exactly.
 *
 * The corpus deliberately spans the milestone's required classes:
 *   straight chains, chains with varying bends, branched chains, multiple
 *   branches, cycloalkanes, ring substituents, and fused/connected rings.
 *
 * These are SYNTHETIC fixtures: they validate the algorithm's correctness, but
 * passing them does not establish real-world recognition accuracy (see the
 * benchmark report).
 */

import type { Point } from "./types";
import { rasterizeSegments, type RasterStyle, type Segment } from "./raster";
import type { GrayImage } from "./types";

export interface SkeletonFixture {
  readonly name: string;
  readonly description: string;
  /** Ground-truth carbon coordinates (pixels). */
  readonly atoms: readonly Point[];
  /** Ground-truth carbon-carbon bonds as atom-index pairs. */
  readonly bonds: readonly (readonly [number, number])[];
  /** Expected cycle rank μ (independent rings). */
  readonly expectedCycleRank: number;
  /** Structural class, for grouping the benchmark report. */
  readonly category:
    | "straight-chain"
    | "bent-chain"
    | "branched-chain"
    | "cycloalkane"
    | "ring-substituent"
    | "fused-ring";
}

const BOND = 36; // pixel bond length
const PAD = 24; // image padding around the drawing
const COS30 = Math.cos(Math.PI / 6);
const SIN30 = Math.sin(Math.PI / 6);

/** Build a zig-zag open chain of `n` carbons (n-1 bonds). */
function zigzag(n: number): { atoms: Point[]; bonds: [number, number][] } {
  const atoms: Point[] = [];
  const bonds: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    atoms.push({ x: i * BOND * COS30, y: i % 2 === 0 ? 0 : BOND * SIN30 });
    if (i > 0) bonds.push([i - 1, i]);
  }
  return { atoms, bonds };
}

/** Build a regular `k`-gon ring centred at (cx,cy) with circumradius r. */
function regularRing(
  k: number,
  cx: number,
  cy: number,
  r: number,
  startAngle = -Math.PI / 2,
): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i < k; i++) {
    const a = startAngle + (2 * Math.PI * i) / k;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

function ringRadiusForBond(k: number, bond: number): number {
  // side = 2 r sin(pi/k)  =>  r = side / (2 sin(pi/k))
  return bond / (2 * Math.sin(Math.PI / k));
}

/** Translate all atoms so the drawing sits at PAD,PAD and report image size. */
function normalize(atoms: Point[]): { atoms: Point[]; width: number; height: number } {
  const minX = Math.min(...atoms.map((a) => a.x));
  const minY = Math.min(...atoms.map((a) => a.y));
  const shifted = atoms.map((a) => ({ x: a.x - minX + PAD, y: a.y - minY + PAD }));
  const maxX = Math.max(...shifted.map((a) => a.x));
  const maxY = Math.max(...shifted.map((a) => a.y));
  return {
    atoms: shifted,
    width: Math.ceil(maxX + PAD),
    height: Math.ceil(maxY + PAD),
  };
}

function ring(k: number): { atoms: Point[]; bonds: [number, number][] } {
  const r = ringRadiusForBond(k, BOND);
  const atoms = regularRing(k, 0, 0, r);
  const bonds: [number, number][] = [];
  for (let i = 0; i < k; i++) bonds.push([i, (i + 1) % k]);
  return { atoms, bonds };
}

/** Compose atoms+bonds from parts, offsetting indices. */
function join(
  ...parts: { atoms: Point[]; bonds: [number, number][] }[]
): { atoms: Point[]; bonds: [number, number][] } {
  const atoms: Point[] = [];
  const bonds: [number, number][] = [];
  for (const p of parts) {
    const off = atoms.length;
    atoms.push(...p.atoms);
    bonds.push(...p.bonds.map(([a, b]) => [a + off, b + off] as [number, number]));
  }
  return { atoms, bonds };
}

// --- The corpus -----------------------------------------------------------

/** Safe indexed access (satisfies noUncheckedIndexedAccess for known-valid i). */
function at(pts: readonly Point[], i: number): Point {
  const p = pts[i];
  if (!p) throw new Error(`fixture atom index ${i} out of range`);
  return p;
}

function make(
  name: string,
  description: string,
  category: SkeletonFixture["category"],
  g: { atoms: Point[]; bonds: [number, number][] },
  expectedCycleRank: number,
): SkeletonFixture {
  return { name, description, category, atoms: g.atoms, bonds: g.bonds, expectedCycleRank };
}

function buildCorpus(): SkeletonFixture[] {
  const fixtures: SkeletonFixture[] = [];

  // 1-4. Straight / zig-zag chains of varying length (butane..octane).
  fixtures.push(make("ethane", "2-carbon chain", "straight-chain", zigzag(2), 0));
  fixtures.push(make("butane", "4-carbon zig-zag chain", "straight-chain", zigzag(4), 0));
  fixtures.push(make("hexane", "6-carbon zig-zag chain", "bent-chain", zigzag(6), 0));
  fixtures.push(make("octane", "8-carbon zig-zag chain", "bent-chain", zigzag(8), 0));

  // 5. Pentane with a single sharp bend (fewer standard bends).
  {
    const atoms: Point[] = [
      { x: 0, y: 40 },
      { x: BOND, y: 40 },
      { x: BOND + BOND * COS30, y: 40 - BOND * SIN30 },
      { x: BOND + 2 * BOND * COS30, y: 40 },
      { x: 2 * BOND + 2 * BOND * COS30, y: 40 },
    ];
    fixtures.push(
      make("pentane-bent", "5-carbon chain, 2 interior bends", "bent-chain", {
        atoms,
        bonds: [
          [0, 1],
          [1, 2],
          [2, 3],
          [3, 4],
        ],
      }, 0),
    );
  }

  // 6. Isobutane: central carbon with 3 branches (one junction, deg 3).
  {
    const c = { x: 0, y: 0 };
    const atoms: Point[] = [
      c,
      { x: -BOND * COS30, y: BOND * SIN30 },
      { x: BOND * COS30, y: BOND * SIN30 },
      { x: 0, y: -BOND },
    ];
    fixtures.push(
      make("isobutane", "central carbon, three methyl branches", "branched-chain", {
        atoms,
        bonds: [
          [0, 1],
          [0, 2],
          [0, 3],
        ],
      }, 0),
    );
  }

  // 7. Isopentane: chain with one methyl branch.
  {
    const base = zigzag(4);
    const branchFrom = 1;
    const bx = at(base.atoms, branchFrom).x;
    const by = at(base.atoms, branchFrom).y;
    const g = {
      atoms: [...base.atoms, { x: bx, y: by - BOND }],
      bonds: [...base.bonds, [branchFrom, base.atoms.length] as [number, number]],
    };
    fixtures.push(make("isopentane", "4-chain with one methyl branch", "branched-chain", g, 0));
  }

  // 8. Neopentane: quaternary carbon, four methyls (degree-4 junction).
  {
    const c = { x: 0, y: 0 };
    const atoms: Point[] = [
      c,
      { x: 0, y: -BOND },
      { x: 0, y: BOND },
      { x: -BOND, y: 0 },
      { x: BOND, y: 0 },
    ];
    fixtures.push(
      make("neopentane", "quaternary carbon, four branches (degree-4)", "branched-chain", {
        atoms,
        bonds: [
          [0, 1],
          [0, 2],
          [0, 3],
          [0, 4],
        ],
      }, 0),
    );
  }

  // 9. 2,3-dimethylbutane: two adjacent branch points (two methyls).
  {
    const base = zigzag(4);
    const g = {
      atoms: [
        ...base.atoms,
        { x: at(base.atoms, 1).x, y: at(base.atoms, 1).y - BOND },
        { x: at(base.atoms, 2).x, y: at(base.atoms, 2).y + BOND },
      ],
      bonds: [
        ...base.bonds,
        [1, base.atoms.length] as [number, number],
        [2, base.atoms.length + 1] as [number, number],
      ],
    };
    fixtures.push(
      make("dimethylbutane", "4-chain with two methyl branches", "branched-chain", g, 0),
    );
  }

  // 10. 3-ethylpentane: multiple branches, one longer.
  {
    const base = zigzag(5);
    const mid = 2;
    const mx = at(base.atoms, mid).x;
    const my = at(base.atoms, mid).y;
    const g = {
      atoms: [
        ...base.atoms,
        { x: mx, y: my + BOND },
        { x: mx + BOND * COS30, y: my + BOND + BOND * SIN30 },
      ],
      bonds: [
        ...base.bonds,
        [mid, base.atoms.length] as [number, number],
        [base.atoms.length, base.atoms.length + 1] as [number, number],
      ],
    };
    fixtures.push(make("ethylpentane", "5-chain with an ethyl branch", "branched-chain", g, 0));
  }

  // 11-14. Cycloalkanes: cyclopropane..cyclohexane.
  fixtures.push(make("cyclopropane", "3-membered ring", "cycloalkane", ring(3), 1));
  fixtures.push(make("cyclobutane", "4-membered ring", "cycloalkane", ring(4), 1));
  fixtures.push(make("cyclopentane", "5-membered ring", "cycloalkane", ring(5), 1));
  fixtures.push(make("cyclohexane", "6-membered ring", "cycloalkane", ring(6), 1));

  // 15. Methylcyclohexane: ring + one substituent.
  {
    const r = ringRadiusForBond(6, BOND);
    const pts = regularRing(6, 0, 0, r);
    const sub = { x: at(pts, 0).x, y: at(pts, 0).y - BOND };
    const bonds: [number, number][] = [];
    for (let i = 0; i < 6; i++) bonds.push([i, (i + 1) % 6]);
    bonds.push([0, 6]);
    fixtures.push(
      make("methylcyclohexane", "cyclohexane with one methyl", "ring-substituent", {
        atoms: [...pts, sub],
        bonds,
      }, 1),
    );
  }

  // 16. 1,4-dimethylcyclohexane: ring + two substituents.
  {
    const r = ringRadiusForBond(6, BOND);
    const pts = regularRing(6, 0, 0, r);
    const sub0 = { x: at(pts, 0).x, y: at(pts, 0).y - BOND };
    const sub3 = { x: at(pts, 3).x, y: at(pts, 3).y + BOND };
    const bonds: [number, number][] = [];
    for (let i = 0; i < 6; i++) bonds.push([i, (i + 1) % 6]);
    bonds.push([0, 6], [3, 7]);
    fixtures.push(
      make("dimethylcyclohexane", "cyclohexane with two methyls", "ring-substituent", {
        atoms: [...pts, sub0, sub3],
        bonds,
      }, 1),
    );
  }

  // 17. Ethylcyclopentane: 5-ring + a 2-carbon chain.
  {
    const r = ringRadiusForBond(5, BOND);
    const pts = regularRing(5, 0, 0, r);
    const s1 = { x: at(pts, 0).x, y: at(pts, 0).y - BOND };
    const s2 = { x: at(pts, 0).x + BOND * COS30, y: at(pts, 0).y - BOND - BOND * SIN30 };
    const bonds: [number, number][] = [];
    for (let i = 0; i < 5; i++) bonds.push([i, (i + 1) % 5]);
    bonds.push([0, 5], [5, 6]);
    fixtures.push(
      make("ethylcyclopentane", "cyclopentane with an ethyl chain", "ring-substituent", {
        atoms: [...pts, s1, s2],
        bonds,
      }, 1),
    );
  }

  // 18. Decalin-like fused bicyclohexane (two 6-rings sharing one edge).
  //     Hexagon A is a standard flat-top ring; hexagon B is A's mirror image
  //     across the shared vertical edge, so the two rings share exactly two
  //     carbons (the shared edge). 10 carbons, 11 bonds, μ = 2.
  {
    const r = ringRadiusForBond(6, BOND);
    // "Pointy-top" hexagon so a vertical edge is shared cleanly: vertices at
    // 30,90,150,210,270,330 degrees. The shared edge is the right edge
    // (vertices at -30deg and +30deg), both with x = r*cos(30).
    const base = regularRing(6, 0, 0, r, -Math.PI / 6); // start at -30deg
    // base[0] = -30deg (upper right), base[5] = +30deg... recompute explicitly.
    const hex = (cx: number): Point[] =>
      [0, 1, 2, 3, 4, 5].map((i) => {
        const ang = -Math.PI / 6 + (2 * Math.PI * i) / 6;
        return { x: cx + r * Math.cos(ang), y: r * Math.sin(ang) };
      });
    void base;
    const ringA = hex(0);
    // Shared edge of ring A: the two rightmost vertices (max x). Find them.
    const sortedByX = ringA.map((p, i) => ({ p, i })).sort((u, v) => v.p.x - u.p.x);
    const sIdxA1 = (sortedByX[0] as { i: number }).i; // shared vertex 1
    const sIdxA2 = (sortedByX[1] as { i: number }).i; // shared vertex 2
    const sharedX = at(ringA, sIdxA1).x;
    // Ring B is ring A reflected across the vertical line x = sharedX.
    const ringB = ringA.map((p) => ({ x: 2 * sharedX - p.x, y: p.y }));
    // Assemble: ringA atoms 0..5, then ringB atoms except its two shared
    // vertices (which coincide with ringA's shared vertices).
    const atoms: Point[] = [...ringA];
    const bIndexMap = new Map<number, number>();
    for (let i = 0; i < 6; i++) {
      if (i === sIdxA1) {
        bIndexMap.set(i, sIdxA1);
      } else if (i === sIdxA2) {
        bIndexMap.set(i, sIdxA2);
      } else {
        bIndexMap.set(i, atoms.length);
        atoms.push(at(ringB, i));
      }
    }
    const bonds: [number, number][] = [];
    for (let i = 0; i < 6; i++) bonds.push([i, (i + 1) % 6]); // ring A
    for (let i = 0; i < 6; i++) {
      const u = bIndexMap.get(i) as number;
      const v = bIndexMap.get((i + 1) % 6) as number;
      // Skip the shared edge (already added as part of ring A).
      const isShared =
        (u === sIdxA1 && v === sIdxA2) || (u === sIdxA2 && v === sIdxA1);
      if (!isShared) bonds.push([u, v]);
    }
    fixtures.push(make("decalin", "two fused 6-rings (bicyclic)", "fused-ring", { atoms, bonds }, 2));
  }

  // 19. Biphenyl-like: two 6-rings connected by a single bond (not fused).
  //     Use flat-top hexagons so each ring has a single rightmost / leftmost
  //     vertex, and bridge them with a horizontal bond of standard length.
  {
    const r = ringRadiusForBond(6, BOND);
    // Flat-top hexagon: vertices at 0,60,...300 deg -> a single vertex at 0deg
    // (rightmost) and one at 180deg (leftmost).
    const hexFlat = (cx: number): Point[] =>
      [0, 1, 2, 3, 4, 5].map((i) => {
        const ang = (2 * Math.PI * i) / 6;
        return { x: cx + r * Math.cos(ang), y: r * Math.sin(ang) };
      });
    const ringA = hexFlat(0); // rightmost vertex = index 0 at (r, 0)
    const gap = 2 * r + BOND; // centre-to-centre so the bridge bond == BOND
    const ringB = hexFlat(gap); // leftmost vertex = index 3 at (gap - r, 0)
    const a = join(
      { atoms: ringA, bonds: hexBonds() },
      { atoms: ringB, bonds: hexBonds() },
    );
    // Bridge ring A's rightmost vertex (0) to ring B's leftmost vertex (6+3).
    a.bonds.push([0, 6 + 3]);
    fixtures.push(make("biphenyl", "two 6-rings joined by a single bond", "fused-ring", a, 2));
  }

  // 20. Spiro-like: two rings sharing a single vertex (spiro[5.5]).
  {
    const r5 = ringRadiusForBond(5, BOND);
    const ringA = regularRing(5, 0, 0, r5, -Math.PI / 2);
    // Ring B shares ringA vertex 0 (top). Place B centred above that vertex.
    const shareA = at(ringA, 0);
    const ringBfull = regularRing(5, shareA.x, shareA.y - r5, r5, Math.PI / 2);
    // Make ringB's vertex 0 coincide with shareA by translation.
    const dx = shareA.x - at(ringBfull, 0).x;
    const dy = shareA.y - at(ringBfull, 0).y;
    const ringB = ringBfull.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    // atoms: ringA (0..4) + ringB minus its vertex 0 (which equals ringA[0]).
    const atoms: Point[] = [...ringA, ...ringB.slice(1)];
    const bonds: [number, number][] = [];
    for (let i = 0; i < 5; i++) bonds.push([i, (i + 1) % 5]);
    // ringB vertices: ringB[0] == atom 0; ringB[1..4] == atoms 5,6,7,8.
    // ringB cycle 0-5-6-7-8-0 (vertex 0 is the shared spiro carbon).
    bonds.push([0, 5], [5, 6], [6, 7], [7, 8], [8, 0]);
    fixtures.push(make("spiropentane", "two 5-rings sharing one carbon (spiro)", "fused-ring", { atoms, bonds }, 2));
  }

  // 21. Propane (shortest bent), to ensure a 3-atom open chain is handled.
  fixtures.push(make("propane", "3-carbon chain, one bend", "straight-chain", zigzag(3), 0));

  // 22. tert-butyl-cyclohexane: ring + branched substituent (multiple branches).
  {
    const r = ringRadiusForBond(6, BOND);
    const pts = regularRing(6, 0, 0, r);
    const q = { x: at(pts, 0).x, y: at(pts, 0).y - BOND }; // quaternary carbon
    const m1 = { x: q.x - BOND * COS30, y: q.y - BOND * SIN30 };
    const m2 = { x: q.x + BOND * COS30, y: q.y - BOND * SIN30 };
    const m3 = { x: q.x, y: q.y - BOND };
    const bonds: [number, number][] = [];
    for (let i = 0; i < 6; i++) bonds.push([i, (i + 1) % 6]);
    bonds.push([0, 6], [6, 7], [6, 8], [6, 9]);
    fixtures.push(
      make("tbutylcyclohexane", "cyclohexane with a tert-butyl group", "ring-substituent", {
        atoms: [...pts, q, m1, m2, m3],
        bonds,
      }, 1),
    );
  }

  return fixtures;
}

function hexBonds(): [number, number][] {
  const b: [number, number][] = [];
  for (let i = 0; i < 6; i++) b.push([i, (i + 1) % 6]);
  return b;
}

/** The full test corpus (>= 20 structures). */
export const CARBON_SKELETON_CORPUS: readonly SkeletonFixture[] = buildCorpus();

/** Rasterise a fixture to a {@link GrayImage}, with normalised placement. */
export function rasterizeFixture(
  fixture: SkeletonFixture,
  style?: RasterStyle,
): { image: GrayImage; atoms: Point[]; width: number; height: number } {
  const { atoms, width, height } = normalize([...fixture.atoms]);
  const segments: Segment[] = fixture.bonds.map(([a, b]) => ({
    from: at(atoms, a),
    to: at(atoms, b),
  }));
  const image = rasterizeSegments(width, height, segments, style);
  return { image, atoms, width, height };
}

/** Produce an SVG string for a fixture (documentation / visual inspection). */
export function fixtureToSvg(fixture: SkeletonFixture): string {
  const { atoms, width, height } = normalize([...fixture.atoms]);
  const lines = fixture.bonds
    .map(([a, b]) => {
      const p = at(atoms, a);
      const q = at(atoms, b);
      return `<line x1="${p.x.toFixed(1)}" y1="${p.y.toFixed(1)}" x2="${q.x.toFixed(1)}" y2="${q.y.toFixed(1)}" stroke="black" stroke-width="2" stroke-linecap="round"/>`;
    })
    .join("\n  ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n  <rect width="100%" height="100%" fill="white"/>\n  ${lines}\n</svg>`;
}

/** Ground-truth {@link import("./graphCompare").SimpleGraph} for a fixture. */
export function fixtureGroundTruth(fixture: SkeletonFixture): {
  vertexCount: number;
  edges: { a: number; b: number }[];
} {
  return {
    vertexCount: fixture.atoms.length,
    edges: fixture.bonds.map(([a, b]) => ({ a, b })),
  };
}
