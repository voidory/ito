/**
 * Pure graph -> 3D-scene-descriptor mapping for the §3.4 dimensional shift
 * (FEAT-006). This is the non-trivial glue between the live concept-network
 * graph and the Three.js scene that ThreeScene.tsx builds.
 *
 * PURE: no DOM, no React, no Three.js, no WebGL. It reuses the SAME 2D scene
 * mapper (src/network/scene.ts) so the 3D view renders the SAME live nodes,
 * hubs and category hulls as the 2D canvas — then lifts that 2D layout into 3D:
 *   - nodes become stellar particles at (x, z=y) with a gentle, DETERMINISTIC
 *     y-elevation so the cloud has depth rather than lying flat,
 *   - categories become translucent 3D bubble hulls (spheres) centered on the
 *     squircle bounds, radius derived from the squircle semi-axes,
 *   - relationship hubs become faint connecting glyphs at the hub center.
 *
 * Keeping this pure means the correctness of the 3D mapping (particle count,
 * hull sizing/positioning, live-graph parity) is provable headlessly in Vitest
 * — the sandbox cannot run WebGL. ThreeScene.tsx only translates these plain
 * descriptors into Three.js objects; it adds no scene semantics of its own.
 */

import { buildScene, type BuildSceneOptions, type SceneGraphInput } from "../network";

/** A 3D point. */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A node lifted to a 3D stellar particle. */
export interface SceneParticle {
  readonly pageId: string;
  readonly title: string;
  readonly position: Vec3;
}

/** A category lifted to a translucent 3D bubble hull (sphere). */
export interface SceneHull {
  readonly categoryId: string;
  readonly name: string;
  readonly colorCode: string;
  readonly center: Vec3;
  /** Sphere radius derived from the squircle semi-axes (watercolor bubble). */
  readonly radius: number;
}

/** A relationship hub lifted to a faint 3D connecting glyph. */
export interface SceneLink3D {
  readonly relationshipId: string;
  readonly blendColor: string;
  readonly center: Vec3;
  /** Endpoint particle positions (so the glyph can bridge the nodes). */
  readonly endpoints: readonly Vec3[];
}

/** The full 3D scene descriptor the renderer consumes. */
export interface Scene3D {
  readonly particles: readonly SceneParticle[];
  readonly hulls: readonly SceneHull[];
  readonly links: readonly SceneLink3D[];
  /** Overall bounding radius (for camera framing); 0 for an empty scene. */
  readonly extent: number;
}

/** Options for the 3D mapping — layout options plus the depth amplitude. */
export interface MapGraphTo3DOptions extends BuildSceneOptions {
  /**
   * Peak absolute y-elevation (depth) applied to particles. Deterministic per
   * node so idle positions stay stable between renders (no camera snap). 0
   * flattens the cloud onto the plane.
   */
  readonly depth?: number;
}

const DEFAULT_DEPTH = 120;

/**
 * Small stable string hash (FNV-1a) used to spread particles through depth
 * deterministically — NOT Math.random, so the 3D cloud is reproducible and the
 * no-forced-motion guarantee carries into 3D.
 */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A deterministic elevation in [-depth, +depth] seeded by the page id. */
function elevationFor(pageId: string, depth: number): number {
  if (depth === 0) return 0;
  // Map the hash into [0, 1) then into [-1, 1] via a smooth-ish fold so the
  // spread is even rather than clustered at the extremes.
  const u = (hashString(pageId) % 10_000) / 10_000;
  return (u * 2 - 1) * depth;
}

/**
 * Map a live concept graph to a 3D scene descriptor. Reuses the 2D layout
 * engine via buildScene so the x/z footprint matches the 2D canvas exactly;
 * the y axis is a deterministic depth lift. Pure and WebGL-free.
 */
export function mapGraphTo3D(
  graph: SceneGraphInput,
  options: MapGraphTo3DOptions = {},
): Scene3D {
  const depth = options.depth ?? DEFAULT_DEPTH;
  const scene = buildScene(graph, options);

  const elevationByPage = new Map<string, number>();
  const particles: SceneParticle[] = scene.nodes.map((n) => {
    const y = elevationFor(n.pageId, depth);
    elevationByPage.set(n.pageId, y);
    return {
      pageId: n.pageId,
      title: n.title,
      position: { x: n.x, y, z: n.y },
    };
  });

  const hulls: SceneHull[] = scene.squircles.map((sq) => {
    // Sphere radius from the squircle half-extent (the larger semi-axis so the
    // bubble encloses the member particles), plus the depth it must span.
    const planar = Math.max(sq.bounds.rx, sq.bounds.ry);
    const radius = Math.sqrt(planar * planar + depth * depth);
    return {
      categoryId: sq.categoryId,
      name: sq.name,
      colorCode: sq.colorCode,
      center: { x: sq.bounds.cx, y: 0, z: sq.bounds.cy },
      radius,
    };
  });

  // Index particles by their planar (x,z) footprint so a hub endpoint (which
  // comes from the SAME buildScene positions) can recover the matching
  // particle's depth and the glyph truly bridges the lifted particles.
  const elevationAt = (x: number, z: number): number => {
    for (const p of particles) {
      if (planarEq(p.position.x, x) && planarEq(p.position.z, z)) return p.position.y;
    }
    return 0;
  };

  const links: SceneLink3D[] = scene.hubs.map((h) => {
    const endpoints: Vec3[] = h.endpoints.map((p) => ({
      x: p.x,
      y: elevationAt(p.x, p.y),
      z: p.y,
    }));
    const avgY =
      endpoints.length > 0
        ? endpoints.reduce((s, p) => s + p.y, 0) / endpoints.length
        : 0;
    return {
      relationshipId: h.relationshipId,
      blendColor: h.blendColor,
      center: { x: h.center.x, y: avgY, z: h.center.y },
      endpoints,
    };
  });

  // Overall extent for camera framing: the farthest particle/hull from origin.
  let extent = 0;
  for (const p of particles) {
    extent = Math.max(extent, Math.hypot(p.position.x, p.position.y, p.position.z));
  }
  for (const hull of hulls) {
    const d = Math.hypot(hull.center.x, hull.center.y, hull.center.z) + hull.radius;
    extent = Math.max(extent, d);
  }

  return { particles, hulls, links, extent };
}

/** Planar coordinate equality with a tiny tolerance (positions are shared). */
function planarEq(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6;
}

/**
 * How the §3.4 "enter 3D" transition prompt should present, given the live
 * density-unlock state and whether motion is suppressed. PURE so the reveal
 * mapping is provable in Vitest without a DOM:
 *   - unlocked=false  -> the prompt is ABSENT entirely (density reward hidden),
 *   - unlocked=true   -> the prompt is PRESENT; it GLOWS (animated) unless
 *     motion is suppressed, in which case it degrades to a static control.
 */
export interface RevealPresentation {
  readonly present: boolean;
  readonly glow: boolean;
}

export function revealPresentation(
  unlocked: boolean,
  suppressMotion: boolean,
): RevealPresentation {
  if (!unlocked) return { present: false, glow: false };
  return { present: true, glow: !suppressMotion };
}
