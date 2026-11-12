/**
 * FEAT-005B — REAL-WORLD carbon-skeleton benchmark corpus (ground truth).
 *
 * This is a SEPARATE benchmark category from the synthetic SVG fixtures in
 * `../fixtures.ts`. Its accuracy MUST NOT be combined with the synthetic score.
 *
 * Each entry is a real, named organic molecule reduced to its CARBON skeleton
 * (heteroatoms, bond orders, charges and stereochemistry are deliberately out
 * of scope for M19 — see `../SKELETON_RECOGNITION.md`). The ground-truth graph
 * (carbon coordinates in a conventional skeletal layout + carbon-carbon bonds)
 * was authored and MANUALLY VERIFIED here, then rendered by an external,
 * anti-aliasing raster engine (`scripts/gen-realworld-corpus.py`, Pillow) to a
 * genuine PNG with real-world drawing artefacts: anti-aliased strokes, varied
 * line weights, element labels / annotations placed next to or touching bonds,
 * non-120° "textbook" bond angles, and a range of resolutions.
 *
 * HONESTY NOTE (mirrors the project's existing caveats): these are REAL
 * STRUCTURES RENDERED by a raster engine, not photographs of scanned textbook
 * pages. They introduce the real-diagram artefacts the synthetic 1px SVG
 * fixtures lack (true anti-aliasing, labels, line-weight variation, lossy
 * compression, noise, skew — applied in `transforms.ts`) and they exercise the
 * *actual* PNG-decode path. They do NOT, by themselves, establish accuracy on
 * photographed / hand-drawn pages; that remains the final validation step and
 * is stated plainly in the report.
 *
 * The coordinates here are the authoritative ground truth. The renderer and the
 * TypeScript benchmark both read THIS file, so there is a single source of
 * truth and the PNGs can be regenerated deterministically.
 */

import type { Point } from "../../../skeleton/types";

/** Structural categories required by FEAT-005B, scored separately. */
export type RealWorldCategory =
  | "straight-chain"
  | "branched-chain"
  | "simple-ring"
  | "substituted-ring"
  | "fused-ring"
  | "connected-ring"
  | "small-ring"
  | "multi-branch"
  | "polycyclic";

/** Label/annotation placed on the rendered diagram (e.g. "OH", "COOH"). */
export interface CorpusLabel {
  /** Index of the carbon atom the label is attached to / near. */
  readonly atom: number;
  readonly text: string;
  /** Pixel offset of the label from the atom (drawing style). */
  readonly dx: number;
  readonly dy: number;
}

/** Rendering hints so the corpus spans styles / resolutions / weights. */
export interface RenderHints {
  /** Stroke width in device px (line-weight variation). */
  readonly lineWidth: number;
  /** Multiplier applied to the base layout to vary resolution / scale. */
  readonly scale: number;
  /** Supersampling-based anti-aliasing (all real corpus entries use it). */
  readonly antialias: true;
}

export interface RealWorldStructure {
  readonly name: string;
  /** Human description incl. the real molecule it is the carbon skeleton of. */
  readonly description: string;
  readonly category: RealWorldCategory;
  /** Ground-truth carbon coordinates in layout units (pre-scale). */
  readonly atoms: readonly Point[];
  /** Ground-truth carbon-carbon bonds as atom-index pairs. */
  readonly bonds: readonly (readonly [number, number])[];
  /** Expected independent ring count μ (cycle rank). */
  readonly expectedCycleRank: number;
  /** Labels / annotations to render near the skeleton (real-diagram artefact). */
  readonly labels: readonly CorpusLabel[];
  readonly render: RenderHints;
}

// --- Layout helpers -------------------------------------------------------

const L = 1.0; // base bond length in layout units
const COS30 = Math.cos(Math.PI / 6);
const SIN30 = Math.sin(Math.PI / 6);

/** A conventional zig-zag chain of n carbons (120° interior angles). */
function chain(n: number, angleJitterDeg = 0): { atoms: Point[]; bonds: [number, number][] } {
  const atoms: Point[] = [];
  const bonds: [number, number][] = [];
  const jitter = (angleJitterDeg * Math.PI) / 180;
  for (let i = 0; i < n; i++) {
    const baseY = i % 2 === 0 ? 0 : L * SIN30;
    const wobble = jitter ? Math.sin(i * 1.7) * jitter * L : 0;
    atoms.push({ x: i * L * COS30, y: baseY + wobble });
    if (i > 0) bonds.push([i - 1, i]);
  }
  return { atoms, bonds };
}

/** A regular k-gon ring, circumradius chosen so each side == bond length L. */
function polygon(
  k: number,
  cx: number,
  cy: number,
  startDeg = -90,
): { atoms: Point[]; bonds: [number, number][] } {
  const r = L / (2 * Math.sin(Math.PI / k));
  const atoms: Point[] = [];
  const bonds: [number, number][] = [];
  const start = (startDeg * Math.PI) / 180;
  for (let i = 0; i < k; i++) {
    const a = start + (2 * Math.PI * i) / k;
    atoms.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    bonds.push([i, (i + 1) % k]);
  }
  return { atoms, bonds };
}

function ringRadius(k: number): number {
  return L / (2 * Math.sin(Math.PI / k));
}

/** Offset + merge several graphs, optionally sharing atoms by coordinate. */
function merge(
  parts: { atoms: Point[]; bonds: [number, number][] }[],
  extraBonds: [number, number][] = [],
  mergeTolerance = 1e-6,
): { atoms: Point[]; bonds: [number, number][] } {
  const atoms: Point[] = [];
  const bonds: [number, number][] = [];
  const indexMaps: Map<number, number>[] = [];
  for (const part of parts) {
    const map = new Map<number, number>();
    part.atoms.forEach((p, localIdx) => {
      const existing = atoms.findIndex(
        (q) => Math.abs(q.x - p.x) < mergeTolerance && Math.abs(q.y - p.y) < mergeTolerance,
      );
      if (existing >= 0) {
        map.set(localIdx, existing);
      } else {
        map.set(localIdx, atoms.length);
        atoms.push(p);
      }
    });
    indexMaps.push(map);
  }
  parts.forEach((part, pi) => {
    const map = indexMaps[pi] as Map<number, number>;
    for (const [a, b] of part.bonds) {
      const ga = map.get(a) as number;
      const gb = map.get(b) as number;
      if (ga !== gb && !hasBond(bonds, ga, gb)) bonds.push([ga, gb]);
    }
  });
  for (const [a, b] of extraBonds) if (!hasBond(bonds, a, b)) bonds.push([a, b]);
  return { atoms, bonds };
}

function hasBond(bonds: readonly [number, number][], a: number, b: number): boolean {
  return bonds.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

function s(
  name: string,
  description: string,
  category: RealWorldCategory,
  g: { atoms: Point[]; bonds: [number, number][] },
  expectedCycleRank: number,
  labels: CorpusLabel[] = [],
  render: Partial<RenderHints> = {},
): RealWorldStructure {
  return {
    name,
    description,
    category,
    atoms: g.atoms,
    bonds: g.bonds,
    expectedCycleRank,
    labels,
    render: { lineWidth: render.lineWidth ?? 3, scale: render.scale ?? 48, antialias: true },
  };
}

// --- The corpus -----------------------------------------------------------

function buildRealWorldCorpus(): RealWorldStructure[] {
  const out: RealWorldStructure[] = [];

  // === Straight / lightly-bent chains (real alkanes, fatty-acid backbones) ===
  out.push(s("n-propane", "carbon skeleton of propane", "straight-chain", chain(3), 0, [], { lineWidth: 3 }));
  out.push(s("n-butane", "carbon skeleton of n-butane", "straight-chain", chain(4), 0, [], { lineWidth: 2 }));
  out.push(s("n-pentane", "carbon skeleton of n-pentane", "straight-chain", chain(5), 0, [], { lineWidth: 4 }));
  out.push(s("n-hexane", "carbon skeleton of n-hexane", "straight-chain", chain(6), 0, [], { lineWidth: 3, scale: 40 }));
  out.push(s("n-heptane", "carbon skeleton of n-heptane", "straight-chain", chain(7), 0, [], { lineWidth: 3, scale: 56 }));
  out.push(s("n-octane", "carbon skeleton of n-octane", "straight-chain", chain(8), 0, [], { lineWidth: 2 }));
  out.push(s("n-decane", "carbon skeleton of n-decane", "straight-chain", chain(10), 0, [], { lineWidth: 3, scale: 36 }));
  out.push(
    s("octanoic-acid", "fatty acid backbone (carboxyl labelled)", "straight-chain", chain(8), 0, [
      { atom: 7, text: "OH", dx: 14, dy: -6 },
      { atom: 7, text: "O", dx: 6, dy: 18 },
    ], { lineWidth: 3 }),
  );
  out.push(
    s("ethanol-skeleton", "ethanol carbon skeleton with OH label", "straight-chain", chain(2), 0, [
      { atom: 1, text: "OH", dx: 14, dy: 0 },
    ], { lineWidth: 3, scale: 60 }),
  );

  // === Branched chains (real isomers) ===
  out.push(
    s("isobutane", "2-methylpropane", "branched-chain", {
      atoms: [{ x: 0, y: 0 }, { x: -L * COS30, y: L * SIN30 }, { x: L * COS30, y: L * SIN30 }, { x: 0, y: -L }],
      bonds: [[0, 1], [0, 2], [0, 3]],
    }, 0),
  );
  out.push(
    s("isopentane", "2-methylbutane", "branched-chain", (() => {
      const base = chain(4);
      const b = base.atoms[1] as Point;
      return { atoms: [...base.atoms, { x: b.x, y: b.y - L }], bonds: [...base.bonds, [1, 4]] };
    })(), 0),
  );
  out.push(
    s("neopentane", "2,2-dimethylpropane (quaternary carbon, degree-4)", "branched-chain", {
      atoms: [{ x: 0, y: 0 }, { x: 0, y: -L }, { x: 0, y: L }, { x: -L, y: 0 }, { x: L, y: 0 }],
      bonds: [[0, 1], [0, 2], [0, 3], [0, 4]],
    }, 0),
  );
  out.push(
    s("2,3-dimethylbutane", "two adjacent methyl branches", "multi-branch", (() => {
      const base = chain(4);
      const a1 = base.atoms[1] as Point;
      const a2 = base.atoms[2] as Point;
      return {
        atoms: [...base.atoms, { x: a1.x, y: a1.y - L }, { x: a2.x, y: a2.y + L }],
        bonds: [...base.bonds, [1, 4], [2, 5]],
      };
    })(), 0),
  );
  out.push(
    s("3-ethylpentane", "pentane with an ethyl branch", "multi-branch", (() => {
      const base = chain(5);
      const mid = base.atoms[2] as Point;
      return {
        atoms: [...base.atoms, { x: mid.x, y: mid.y + L }, { x: mid.x + L * COS30, y: mid.y + L + L * SIN30 }],
        bonds: [...base.bonds, [2, 5], [5, 6]],
      };
    })(), 0),
  );
  out.push(
    s("isooctane", "2,2,4-trimethylpentane (anti-knock reference)", "multi-branch", (() => {
      const base = chain(5);
      const a1 = base.atoms[1] as Point;
      const a3 = base.atoms[3] as Point;
      return {
        atoms: [
          ...base.atoms,
          { x: a1.x, y: a1.y - L }, // 5
          { x: a1.x - L, y: a1.y }, // 6
          { x: a3.x, y: a3.y + L }, // 7
        ],
        bonds: [...base.bonds, [1, 5], [1, 6], [3, 7]],
      };
    })(), 0),
  );
  out.push(
    s("neopentyl-chain", "quaternary carbon feeding a chain (multi-branch)", "multi-branch", (() => {
      const base = chain(5);
      const a1 = base.atoms[1] as Point;
      return {
        atoms: [...base.atoms, { x: a1.x, y: a1.y - L }, { x: a1.x - L * COS30, y: a1.y - L * SIN30 }],
        bonds: [...base.bonds, [1, 5], [1, 6]],
      };
    })(), 0),
  );

  // === Simple rings (cycloalkanes) ===
  out.push(s("cyclopropane", "3-membered ring (small ring)", "small-ring", polygon(3, 0, 0), 1, [], { lineWidth: 4, scale: 60 }));
  out.push(s("cyclobutane", "4-membered ring (small ring)", "small-ring", polygon(4, 0, 0), 1, [], { lineWidth: 3, scale: 54 }));
  out.push(s("cyclopentane", "5-membered ring", "simple-ring", polygon(5, 0, 0), 1, [], { lineWidth: 3 }));
  out.push(s("cyclohexane", "6-membered ring", "simple-ring", polygon(6, 0, 0), 1, [], { lineWidth: 3 }));
  out.push(s("cycloheptane", "7-membered ring", "simple-ring", polygon(7, 0, 0), 1, [], { lineWidth: 2, scale: 44 }));
  out.push(s("cyclooctane", "8-membered ring", "simple-ring", polygon(8, 0, 0), 1, [], { lineWidth: 3, scale: 40 }));
  out.push(s("benzene", "benzene carbon ring (Kekulé skeleton)", "simple-ring", polygon(6, 0, 0), 1, [], { lineWidth: 3 }));

  // === Substituted rings ===
  out.push(
    s("methylcyclohexane", "cyclohexane + methyl", "substituted-ring", (() => {
      const ring = polygon(6, 0, 0);
      const top = ring.atoms[0] as Point;
      return { atoms: [...ring.atoms, { x: top.x, y: top.y - L }], bonds: [...ring.bonds, [0, 6]] };
    })(), 1),
  );
  out.push(
    s("ethylbenzene", "benzene + ethyl group", "substituted-ring", (() => {
      const ring = polygon(6, 0, 0);
      const top = ring.atoms[0] as Point;
      return {
        atoms: [...ring.atoms, { x: top.x, y: top.y - L }, { x: top.x + L * COS30, y: top.y - L - L * SIN30 }],
        bonds: [...ring.bonds, [0, 6], [6, 7]],
      };
    })(), 1),
  );
  out.push(
    s("1,4-dimethylcyclohexane", "para-dimethyl cyclohexane", "substituted-ring", (() => {
      const ring = polygon(6, 0, 0);
      const a0 = ring.atoms[0] as Point;
      const a3 = ring.atoms[3] as Point;
      return {
        atoms: [...ring.atoms, { x: a0.x, y: a0.y - L }, { x: a3.x, y: a3.y + L }],
        bonds: [...ring.bonds, [0, 6], [3, 7]],
      };
    })(), 1),
  );
  out.push(
    s("tert-butylcyclohexane", "cyclohexane + tert-butyl (multi-branch substituent)", "substituted-ring", (() => {
      const ring = polygon(6, 0, 0);
      const a0 = ring.atoms[0] as Point;
      const q = { x: a0.x, y: a0.y - L };
      return {
        atoms: [
          ...ring.atoms,
          q, // 6
          { x: q.x - L * COS30, y: q.y - L * SIN30 }, // 7
          { x: q.x + L * COS30, y: q.y - L * SIN30 }, // 8
          { x: q.x, y: q.y - L }, // 9
        ],
        bonds: [...ring.bonds, [0, 6], [6, 7], [6, 8], [6, 9]],
      };
    })(), 1),
  );
  out.push(
    s("cyclohexanol-skeleton", "cyclohexane ring with OH label touching ring", "substituted-ring",
      polygon(6, 0, 0), 1, [{ atom: 0, text: "OH", dx: 0, dy: -18 }], { lineWidth: 3 }),
  );
  out.push(
    s("toluene-skeleton", "methylbenzene with CH3 label", "substituted-ring", (() => {
      const ring = polygon(6, 0, 0);
      const top = ring.atoms[0] as Point;
      return { atoms: [...ring.atoms, { x: top.x, y: top.y - L }], bonds: [...ring.bonds, [0, 6]] };
    })(), 1, [{ atom: 6, text: "CH3", dx: -4, dy: -16 }]),
  );
  out.push(
    s("styrene-skeleton", "benzene with a vinyl-length substituent", "substituted-ring", (() => {
      const ring = polygon(6, 0, 0);
      const top = ring.atoms[0] as Point;
      return {
        atoms: [...ring.atoms, { x: top.x, y: top.y - L }, { x: top.x - L * COS30, y: top.y - L - L * SIN30 }],
        bonds: [...ring.bonds, [0, 6], [6, 7]],
      };
    })(), 1),
  );
  out.push(
    s("cumene-skeleton", "isopropylbenzene (branched substituent)", "substituted-ring", (() => {
      const ring = polygon(6, 0, 0);
      const top = ring.atoms[0] as Point;
      const c = { x: top.x, y: top.y - L };
      return {
        atoms: [...ring.atoms, c, { x: c.x - L * COS30, y: c.y - L * SIN30 }, { x: c.x + L * COS30, y: c.y - L * SIN30 }],
        bonds: [...ring.bonds, [0, 6], [6, 7], [6, 8]],
      };
    })(), 1),
  );

  // === Fused ring systems (share an edge) ===
  const decalin = (() => {
    // Two pointy-top hexagons sharing a vertical edge.
    const r = ringRadius(6);
    const hex = (cx: number): { atoms: Point[]; bonds: [number, number][] } => {
      const atoms: Point[] = [];
      const bonds: [number, number][] = [];
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI / 6 + (2 * Math.PI * i) / 6;
        atoms.push({ x: cx + r * Math.cos(a), y: r * Math.sin(a) });
        bonds.push([i, (i + 1) % 6]);
      }
      return { atoms, bonds };
    };
    const ringA = hex(0);
    const sharedX = Math.max(...ringA.atoms.map((p) => p.x));
    const ringB = {
      atoms: ringA.atoms.map((p) => ({ x: 2 * sharedX - p.x, y: p.y })),
      bonds: ringA.bonds,
    };
    return merge([ringA, ringB], [], 1e-6);
  })();
  out.push(s("decalin", "bicyclo[4.4.0]decane (two fused 6-rings)", "fused-ring", decalin, 2));

  const naphthalene = (() => {
    const r = ringRadius(6);
    const hex = (cx: number): { atoms: Point[]; bonds: [number, number][] } => {
      const atoms: Point[] = [];
      const bonds: [number, number][] = [];
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI / 6 + (2 * Math.PI * i) / 6;
        atoms.push({ x: cx + r * Math.cos(a), y: r * Math.sin(a) });
        bonds.push([i, (i + 1) % 6]);
      }
      return { atoms, bonds };
    };
    const ringA = hex(0);
    const sharedX = Math.max(...ringA.atoms.map((p) => p.x));
    const ringB = { atoms: ringA.atoms.map((p) => ({ x: 2 * sharedX - p.x, y: p.y })), bonds: ringA.bonds };
    return merge([ringA, ringB], [], 1e-6);
  })();
  out.push(s("naphthalene", "fused bicyclic aromatic (10 carbons)", "fused-ring", naphthalene, 2));

  const indane = (() => {
    // 6-ring fused to a 5-ring sharing one edge.
    const r6 = ringRadius(6);
    const hex: { atoms: Point[]; bonds: [number, number][] } = (() => {
      const atoms: Point[] = [];
      const bonds: [number, number][] = [];
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI / 6 + (2 * Math.PI * i) / 6;
        atoms.push({ x: r6 * Math.cos(a), y: r6 * Math.sin(a) });
        bonds.push([i, (i + 1) % 6]);
      }
      return { atoms, bonds };
    })();
    // Share the rightmost edge (two largest-x vertices) with a 5-ring.
    const sorted = hex.atoms.map((p, i) => ({ p, i })).sort((a, b) => b.p.x - a.p.x);
    const v1 = (sorted[0] as { p: Point; i: number });
    const v2 = (sorted[1] as { p: Point; i: number });
    // Build a 5-ring on the shared edge v1-v2, bulging right.
    const mid = { x: (v1.p.x + v2.p.x) / 2, y: (v1.p.y + v2.p.y) / 2 };
    const edgeLen = Math.hypot(v1.p.x - v2.p.x, v1.p.y - v2.p.y);
    // three new carbons for a 5-ring (pentagon) attached to the edge
    const outward = { x: 1, y: 0 };
    const apex = { x: mid.x + outward.x * edgeLen * 1.4, y: mid.y };
    const p3 = { x: v1.p.x + outward.x * edgeLen * 0.9, y: v1.p.y };
    const p4 = { x: v2.p.x + outward.x * edgeLen * 0.9, y: v2.p.y };
    const atoms = [...hex.atoms, p3, p4, apex];
    const bonds = [...hex.bonds];
    const i3 = 6;
    const i4 = 7;
    const iApex = 8;
    bonds.push([v1.i, i3], [i3, iApex], [iApex, i4], [i4, v2.i]);
    return { atoms, bonds };
  })();
  out.push(s("indane-skeleton", "benzene fused to a cyclopentane (5-6 fused)", "fused-ring", indane, 2));

  const anthracene = (() => {
    const r = ringRadius(6);
    const hex = (cx: number): { atoms: Point[]; bonds: [number, number][] } => {
      const atoms: Point[] = [];
      const bonds: [number, number][] = [];
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI / 6 + (2 * Math.PI * i) / 6;
        atoms.push({ x: cx + r * Math.cos(a), y: r * Math.sin(a) });
        bonds.push([i, (i + 1) % 6]);
      }
      return { atoms, bonds };
    };
    const ringA = hex(0);
    const w = Math.max(...ringA.atoms.map((p) => p.x)) - Math.min(...ringA.atoms.map((p) => p.x));
    const ringB = hex(w);
    const ringC = hex(2 * w);
    return merge([ringA, ringB, ringC], [], 1e-6);
  })();
  out.push(s("anthracene", "three linearly fused 6-rings", "polycyclic", anthracene, 3));

  const phenanthrene = (() => {
    const r = ringRadius(6);
    const hex = (cx: number, cy: number): { atoms: Point[]; bonds: [number, number][] } => {
      const atoms: Point[] = [];
      const bonds: [number, number][] = [];
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI / 6 + (2 * Math.PI * i) / 6;
        atoms.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
        bonds.push([i, (i + 1) % 6]);
      }
      return { atoms, bonds };
    };
    const w = 2 * r * Math.cos(Math.PI / 6);
    const ringA = hex(0, 0);
    const ringB = hex(w, 0);
    const ringC = hex(1.5 * w, -r * 1.5);
    return merge([ringA, ringB, ringC], [], 1e-6);
  })();
  out.push(s("phenanthrene", "three angularly fused 6-rings", "polycyclic", phenanthrene, 3));

  // === Connected (not fused) rings ===
  const biphenyl = (() => {
    const r = ringRadius(6);
    const hexFlat = (cx: number): { atoms: Point[]; bonds: [number, number][] } => {
      const atoms: Point[] = [];
      const bonds: [number, number][] = [];
      for (let i = 0; i < 6; i++) {
        const a = (2 * Math.PI * i) / 6;
        atoms.push({ x: cx + r * Math.cos(a), y: r * Math.sin(a) });
        bonds.push([i, (i + 1) % 6]);
      }
      return { atoms, bonds };
    };
    const ringA = hexFlat(0);
    const gap = 2 * r + L;
    const ringB = hexFlat(gap);
    const g = merge([ringA, ringB], [], 1e-6);
    // Bridge ringA rightmost (idx 0) to ringB leftmost (idx 6+3 -> after merge).
    g.bonds.push([0, 6 + 3]);
    return g;
  })();
  out.push(s("biphenyl", "two benzene rings joined by a single bond", "connected-ring", biphenyl, 2));

  const dicyclohexyl = (() => {
    const r = ringRadius(6);
    const hexFlat = (cx: number): { atoms: Point[]; bonds: [number, number][] } => {
      const atoms: Point[] = [];
      const bonds: [number, number][] = [];
      for (let i = 0; i < 6; i++) {
        const a = (2 * Math.PI * i) / 6;
        atoms.push({ x: cx + r * Math.cos(a), y: r * Math.sin(a) });
        bonds.push([i, (i + 1) % 6]);
      }
      return { atoms, bonds };
    };
    const ringA = hexFlat(0);
    const gap = 2 * r + L;
    const ringB = hexFlat(gap);
    const g = merge([ringA, ringB], [], 1e-6);
    g.bonds.push([0, 6 + 3]);
    return g;
  })();
  out.push(s("bicyclohexyl", "two cyclohexanes joined by a single bond", "connected-ring", dicyclohexyl, 2));

  const diphenylmethane = (() => {
    const r = ringRadius(6);
    const hexFlat = (cx: number): { atoms: Point[]; bonds: [number, number][] } => {
      const atoms: Point[] = [];
      const bonds: [number, number][] = [];
      for (let i = 0; i < 6; i++) {
        const a = (2 * Math.PI * i) / 6;
        atoms.push({ x: cx + r * Math.cos(a), y: r * Math.sin(a) });
        bonds.push([i, (i + 1) % 6]);
      }
      return { atoms, bonds };
    };
    const ringA = hexFlat(0);
    const gap = 2 * r + 2 * L;
    const ringB = hexFlat(gap);
    const g = merge([ringA, ringB], [], 1e-6);
    // CH2 bridge carbon between the two rings' inner vertices.
    const bridge = { x: (ringA.atoms[0] as Point).x + L, y: 0 };
    g.atoms.push(bridge);
    const bridgeIdx = g.atoms.length - 1;
    g.bonds.push([0, bridgeIdx], [bridgeIdx, 6 + 3]);
    return g;
  })();
  out.push(s("diphenylmethane", "two benzene rings bridged by a CH2 (methylene)", "connected-ring", diphenylmethane, 2));

  // === Spiro (share one vertex) ===
  const spiropentane = (() => {
    const r5 = ringRadius(5);
    const ringA = polygon(5, 0, 0, -90);
    const shareA = ringA.atoms[0] as Point;
    const ringBfull = polygon(5, shareA.x, shareA.y - r5, 90);
    const dx = shareA.x - (ringBfull.atoms[0] as Point).x;
    const dy = shareA.y - (ringBfull.atoms[0] as Point).y;
    const ringB = { atoms: ringBfull.atoms.map((p) => ({ x: p.x + dx, y: p.y + dy })), bonds: ringBfull.bonds };
    return merge([ringA, ringB], [], 1e-6);
  })();
  out.push(s("spiro-5-5", "two 5-rings sharing one carbon (spiro)", "polycyclic", spiropentane, 2));

  const spirohexane = (() => {
    const r6 = ringRadius(6);
    const ringA = polygon(6, 0, 0, -90);
    const shareA = ringA.atoms[0] as Point;
    const ringBfull = polygon(6, shareA.x, shareA.y - r6, 90);
    const dx = shareA.x - (ringBfull.atoms[0] as Point).x;
    const dy = shareA.y - (ringBfull.atoms[0] as Point).y;
    const ringB = { atoms: ringBfull.atoms.map((p) => ({ x: p.x + dx, y: p.y + dy })), bonds: ringBfull.bonds };
    return merge([ringA, ringB], [], 1e-6);
  })();
  out.push(s("spiro-6-6", "two 6-rings sharing one carbon (spiro)", "polycyclic", spirohexane, 2));

  // === Polycyclic / bridged (real natural-product cores) ===
  const norbornane = (() => {
    // Bicyclo[2.2.1]heptane: a cyclohexane-ish 6-ring with a 1-carbon bridge.
    const ring = polygon(6, 0, 0, -90);
    const a1 = ring.atoms[1] as Point;
    const a4 = ring.atoms[4] as Point;
    const bridge = { x: (a1.x + a4.x) / 2, y: (a1.y + a4.y) / 2 - ringRadius(6) * 0.6 };
    const atoms = [...ring.atoms, bridge];
    const bonds = [...ring.bonds, [1, 6] as [number, number], [4, 6] as [number, number]];
    return { atoms, bonds };
  })();
  out.push(s("norbornane", "bicyclo[2.2.1]heptane (bridged bicyclic)", "polycyclic", norbornane, 2));

  const adamantane = (() => {
    // Adamantane carbon skeleton: 10 carbons, 12 bonds, three fused chair rings.
    // Use a known 2D projection (symmetric) with coordinates in layout units.
    const atoms: Point[] = [
      { x: 0.0, y: -2.0 }, // 0 top
      { x: -1.6, y: -1.0 }, // 1
      { x: 1.6, y: -1.0 }, // 2
      { x: 0.0, y: -1.0 }, // 3 (front-top)
      { x: -1.6, y: 0.6 }, // 4
      { x: 1.6, y: 0.6 }, // 5
      { x: 0.0, y: 0.6 }, // 6 (front-mid)
      { x: -0.9, y: 1.6 }, // 7
      { x: 0.9, y: 1.6 }, // 8
      { x: 0.0, y: 2.0 }, // 9 bottom
    ];
    const bonds: [number, number][] = [
      [0, 1], [0, 2], [0, 3],
      [1, 4], [2, 5], [3, 6],
      [4, 7], [5, 8], [6, 7], [6, 8],
      [7, 9], [8, 9],
    ];
    return { atoms, bonds };
  })();
  out.push(s("adamantane", "adamantane carbon cage (tricyclic)", "polycyclic", adamantane, 3, [], { lineWidth: 3, scale: 44 }));

  const bicyclohexane_fused = (() => {
    // Hydrindane: cyclohexane fused to cyclopentane (6-5 fused).
    const r6 = ringRadius(6);
    const hex: { atoms: Point[]; bonds: [number, number][] } = (() => {
      const atoms: Point[] = [];
      const bonds: [number, number][] = [];
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI / 6 + (2 * Math.PI * i) / 6;
        atoms.push({ x: r6 * Math.cos(a), y: r6 * Math.sin(a) });
        bonds.push([i, (i + 1) % 6]);
      }
      return { atoms, bonds };
    })();
    const sorted = hex.atoms.map((p, i) => ({ p, i })).sort((a, b) => b.p.x - a.p.x);
    const v1 = sorted[0] as { p: Point; i: number };
    const v2 = sorted[1] as { p: Point; i: number };
    const edgeLen = Math.hypot(v1.p.x - v2.p.x, v1.p.y - v2.p.y);
    const p3 = { x: v1.p.x + edgeLen * 0.9, y: v1.p.y };
    const p4 = { x: v2.p.x + edgeLen * 0.9, y: v2.p.y };
    const apex = { x: ((v1.p.x + v2.p.x) / 2) + edgeLen * 1.4, y: (v1.p.y + v2.p.y) / 2 };
    const atoms = [...hex.atoms, p3, p4, apex];
    const bonds = [...hex.bonds, [v1.i, 6] as [number, number], [6, 8] as [number, number], [8, 7] as [number, number], [7, v2.i] as [number, number]];
    return { atoms, bonds };
  })();
  out.push(s("hydrindane", "cyclohexane fused to cyclopentane (6-5)", "fused-ring", bicyclohexane_fused, 2));

  // === More small / strained rings ===
  out.push(
    s("methylcyclopropane", "cyclopropane + methyl (small ring, substituent)", "small-ring", (() => {
      const ring = polygon(3, 0, 0);
      const top = ring.atoms[0] as Point;
      return { atoms: [...ring.atoms, { x: top.x, y: top.y - L }], bonds: [...ring.bonds, [0, 3]] };
    })(), 1, [], { lineWidth: 4, scale: 56 }),
  );
  out.push(
    s("spiro-3-3", "two cyclobutanes sharing one carbon (small spiro)", "small-ring", (() => {
      const r4 = ringRadius(4);
      const ringA = polygon(4, 0, 0, -45);
      const shareA = ringA.atoms[0] as Point;
      const ringBfull = polygon(4, shareA.x, shareA.y - r4, 135);
      const dx = shareA.x - (ringBfull.atoms[0] as Point).x;
      const dy = shareA.y - (ringBfull.atoms[0] as Point).y;
      const ringB = { atoms: ringBfull.atoms.map((p) => ({ x: p.x + dx, y: p.y + dy })), bonds: ringBfull.bonds };
      return merge([ringA, ringB], [], 1e-6);
    })(), 2, [], { lineWidth: 3, scale: 52 }),
  );

  // === Longer real backbones with multiple branches ===
  out.push(
    s("2-methylhexane", "hexane + methyl (branched)", "branched-chain", (() => {
      const base = chain(6);
      const a1 = base.atoms[1] as Point;
      return { atoms: [...base.atoms, { x: a1.x, y: a1.y - L }], bonds: [...base.bonds, [1, 6]] };
    })(), 0),
  );
  out.push(
    s("3,3-dimethylpentane", "pentane with geminal dimethyl (quaternary)", "multi-branch", (() => {
      const base = chain(5);
      const a2 = base.atoms[2] as Point;
      return {
        atoms: [...base.atoms, { x: a2.x, y: a2.y + L }, { x: a2.x, y: a2.y - L }],
        bonds: [...base.bonds, [2, 5], [2, 6]],
      };
    })(), 0),
  );
  out.push(
    s("4-propylheptane", "heptane with a propyl branch (long substituent)", "multi-branch", (() => {
      const base = chain(7);
      const mid = base.atoms[3] as Point;
      return {
        atoms: [
          ...base.atoms,
          { x: mid.x, y: mid.y + L },
          { x: mid.x + L * COS30, y: mid.y + L + L * SIN30 },
          { x: mid.x + L * COS30, y: mid.y + 2 * L + L * SIN30 },
        ],
        bonds: [...base.bonds, [3, 7], [7, 8], [8, 9]],
      };
    })(), 0),
  );

  // A couple more substituted rings to comfortably exceed 50.
  out.push(
    s("xylene-skeleton", "1,2-dimethylbenzene (ortho)", "substituted-ring", (() => {
      const ring = polygon(6, 0, 0);
      const a0 = ring.atoms[0] as Point;
      const a1 = ring.atoms[1] as Point;
      return {
        atoms: [...ring.atoms, { x: a0.x, y: a0.y - L }, { x: a1.x + L * COS30, y: a1.y - L * SIN30 }],
        bonds: [...ring.bonds, [0, 6], [1, 7]],
      };
    })(), 1),
  );
  out.push(
    s("mesitylene-skeleton", "1,3,5-trimethylbenzene", "substituted-ring", (() => {
      const ring = polygon(6, 0, 0);
      const a0 = ring.atoms[0] as Point;
      const a2 = ring.atoms[2] as Point;
      const a4 = ring.atoms[4] as Point;
      return {
        atoms: [
          ...ring.atoms,
          { x: a0.x, y: a0.y - L },
          { x: a2.x + L, y: a2.y },
          { x: a4.x - L, y: a4.y },
        ],
        bonds: [...ring.bonds, [0, 6], [2, 7], [4, 8]],
      };
    })(), 1),
  );
  out.push(
    s("propylcyclopentane", "cyclopentane + propyl chain", "substituted-ring", (() => {
      const ring = polygon(5, 0, 0);
      const top = ring.atoms[0] as Point;
      return {
        atoms: [
          ...ring.atoms,
          { x: top.x, y: top.y - L },
          { x: top.x + L * COS30, y: top.y - L - L * SIN30 },
          { x: top.x + L * COS30, y: top.y - 2 * L - L * SIN30 },
        ],
        bonds: [...ring.bonds, [0, 5], [5, 6], [6, 7]],
      };
    })(), 1),
  );
  out.push(
    s("1-methylnaphthalene", "naphthalene + methyl", "polycyclic", (() => {
      const r = ringRadius(6);
      const hex = (cx: number): { atoms: Point[]; bonds: [number, number][] } => {
        const atoms: Point[] = [];
        const bonds: [number, number][] = [];
        for (let i = 0; i < 6; i++) {
          const a = -Math.PI / 6 + (2 * Math.PI * i) / 6;
          atoms.push({ x: cx + r * Math.cos(a), y: r * Math.sin(a) });
          bonds.push([i, (i + 1) % 6]);
        }
        return { atoms, bonds };
      };
      const ringA = hex(0);
      const sharedX = Math.max(...ringA.atoms.map((p) => p.x));
      const ringB = { atoms: ringA.atoms.map((p) => ({ x: 2 * sharedX - p.x, y: p.y })), bonds: ringA.bonds };
      const g = merge([ringA, ringB], [], 1e-6);
      // Add a methyl off a peripheral top-left carbon.
      const topLeft = g.atoms.reduce((best, p, i) => (p.y < (g.atoms[best] as Point).y ? i : best), 0);
      const tl = g.atoms[topLeft] as Point;
      g.atoms.push({ x: tl.x, y: tl.y - L });
      g.bonds.push([topLeft, g.atoms.length - 1]);
      return g;
    })(), 2),
  );
  out.push(
    s("tetralin-skeleton", "benzene fused to a saturated 6-ring", "fused-ring", (() => {
      const r = ringRadius(6);
      const hex = (cx: number): { atoms: Point[]; bonds: [number, number][] } => {
        const atoms: Point[] = [];
        const bonds: [number, number][] = [];
        for (let i = 0; i < 6; i++) {
          const a = -Math.PI / 6 + (2 * Math.PI * i) / 6;
          atoms.push({ x: cx + r * Math.cos(a), y: r * Math.sin(a) });
          bonds.push([i, (i + 1) % 6]);
        }
        return { atoms, bonds };
      };
      const ringA = hex(0);
      const sharedX = Math.max(...ringA.atoms.map((p) => p.x));
      const ringB = { atoms: ringA.atoms.map((p) => ({ x: 2 * sharedX - p.x, y: p.y })), bonds: ringA.bonds };
      return merge([ringA, ringB], [], 1e-6);
    })(), 2),
  );
  out.push(
    s("fluorene-skeleton", "two benzene rings bridged into a central 5-ring", "polycyclic", (() => {
      const r = ringRadius(6);
      const hexFlat = (cx: number): { atoms: Point[]; bonds: [number, number][] } => {
        const atoms: Point[] = [];
        const bonds: [number, number][] = [];
        for (let i = 0; i < 6; i++) {
          const a = (2 * Math.PI * i) / 6;
          atoms.push({ x: cx + r * Math.cos(a), y: r * Math.sin(a) });
          bonds.push([i, (i + 1) % 6]);
        }
        return { atoms, bonds };
      };
      const ringA = hexFlat(0);
      const gap = 2 * r + L;
      const ringB = hexFlat(gap);
      const g = merge([ringA, ringB], [], 1e-6);
      // biphenyl bond + a CH2 bridge forming the central 5-ring.
      g.bonds.push([0, 6 + 3]);
      // Bridge the ortho carbons (indices 1 of ringA and 2 of ringB) via a CH2.
      const bridge = { x: ((ringA.atoms[1] as Point).x + (ringB.atoms[2] as Point).x) / 2, y: (ringA.atoms[1] as Point).y - L };
      g.atoms.push(bridge);
      const bi = g.atoms.length - 1;
      g.bonds.push([1, bi], [bi, 6 + 2]);
      return g;
    })(), 3),
  );

  return out;
}

/** The real-world corpus (>= 50 structures). Separate from synthetic fixtures. */
export const REAL_WORLD_CORPUS: readonly RealWorldStructure[] = buildRealWorldCorpus();
