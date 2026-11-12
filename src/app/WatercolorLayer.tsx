import { useMemo } from "react";
import type { SceneSquircle } from "../network";
import { categoryPigment } from "../network";
import type { RelationshipKind } from "../model";

/**
 * The watercolour look of the concept map, kept separate from the interaction
 * code in NodesCanvas.
 *
 *  - Each category is a WASH: a radial gradient that is light in the middle and
 *    pools darker toward the edge (how pigment dries on wet paper), pushed
 *    through a turbulence displacement so its boundary looks bled, not drawn.
 *  - Where two categories OVERLAP the colours do not just multiply into a dark
 *    lens: a BLEED zone mixes them like two colours meeting in water - a
 *    gradient that slowly flows from one pigment to the other with a mixed
 *    middle tone and drifting blotches of each.
 *  - A faint, slowly drifting WATER backdrop and a travelling SHEEN on each wash
 *    give the surface a living, reflective feel.
 *
 * Everything that animates is optional (`motion`) so the map honours the app's
 * motion-suppression setting and the OS reduced-motion preference.
 */

/* ----------------------------------------------------------------------- */
/* Colour helpers                                                           */
/* ----------------------------------------------------------------------- */

function parseHex(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [154, 167, 178];
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Blend two hex colours; t=0 -> a, t=1 -> b. Subtractive-looking mid tone. */
export function mixHex(a: string, b: string, t = 0.5): string {
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  // Mix in a slightly darkened way so the meeting tone reads as paint, not as a
  // washed-out average.
  const k = 1;
  const c = (x: number, y: number): number => Math.round((x + (y - x) * t) * k);
  return `#${[c(ar, br), c(ag, bg), c(ab, bb)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Whether two squircle regions overlap (ellipse test on their bounds). */
export function squirclesOverlap(a: SceneSquircle, b: SceneSquircle): boolean {
  const dx = a.bounds.cx - b.bounds.cx;
  const dy = a.bounds.cy - b.bounds.cy;
  const rx = a.bounds.rx + b.bounds.rx;
  const ry = a.bounds.ry + b.bounds.ry;
  return (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) < 0.8;
}

export function overlapPairs(
  squircles: readonly SceneSquircle[],
): [SceneSquircle, SceneSquircle][] {
  const out: [SceneSquircle, SceneSquircle][] = [];
  for (let i = 0; i < squircles.length; i += 1) {
    for (let j = i + 1; j < squircles.length; j += 1) {
      if (squirclesOverlap(squircles[i]!, squircles[j]!)) out.push([squircles[i]!, squircles[j]!]);
    }
  }
  return out;
}

const safeId = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, "_");

/* ----------------------------------------------------------------------- */
/* M14–M16 (FEAT-002) Unstirred watercolour curls / marbling ribbons        */
/* ----------------------------------------------------------------------- */

/** A point in scene space. */
interface CurlPoint {
  readonly x: number;
  readonly y: number;
}

/** Round a number to 2dp so generated path strings stay compact + stable. */
function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * M14–M16 (FEAT-002) build 2–3 interlocking, counter-curling cubic-Bézier
 * ribbon path strings for the zone where two pigments MEET — a Subject-basin
 * overlap (OverlapBleeds) or a node-to-node intersection Hub. The ribbons are
 * generated PURELY from the two endpoints `a` and `b` (scene coordinates) and
 * the relationship `kind`, so the same geometry is exercised by Vitest and the
 * live SVG with no DOM. Ribbon[0] carries Pigment A, ribbon[1] carries Pigment
 * B, and (for the harmonious kinds) ribbon[2] is a thin interleaving filament —
 * so the two colours visibly CURL into each other like unstirred ink in water
 * rather than averaging into one flat wash.
 *
 * The curl geometry is differentiated by `RelationshipKind`:
 *   - `relates` / `supports`: harmonious intertwined S-curve double-helix
 *     ribbons (mirror-image sine-like curls that weave over/under each other).
 *   - `contradicts`: opposing counter-vortex hooks that recoil away from a
 *     sharp tension cleft at the hub centre.
 *   - `derives`: a single directional tapered plume streaming from the source
 *     node (a) into the target node (b).
 *
 * Deterministic: identical inputs always yield identical path strings.
 */
export function buildWatercolorCurlRibbons(
  a: CurlPoint,
  b: CurlPoint,
  kind: RelationshipKind = "relates",
): string[] {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  // Unit direction (a -> b) and its perpendicular (the curl amplitude axis).
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  // Curl amplitude scales with the span but is clamped so a tiny hub still
  // shows a visible curl and a huge basin overlap never balloons.
  const amp = Math.max(14, Math.min(len * 0.32, 90));
  const p = (sx: number, sy: number): string => `${r2(sx)} ${r2(sy)}`;

  if (kind === "derives") {
    // A single directional tapered plume: it leaves the source (a), swells and
    // swings to one side through the midpoint, then narrows into the target
    // (b). Two edges of the plume plus a centre streak = a tapered stream.
    const swell = amp * 0.9;
    const c1x = a.x + ux * len * 0.3 + px * swell;
    const c1y = a.y + uy * len * 0.3 + py * swell;
    const c2x = b.x - ux * len * 0.3 + px * swell * 0.25;
    const c2y = b.y - uy * len * 0.3 + py * swell * 0.25;
    const edgeHi = `M ${p(a.x, a.y)} C ${p(c1x, c1y)} ${p(c2x, c2y)} ${p(b.x, b.y)}`;
    const c1xLo = a.x + ux * len * 0.3 - px * swell * 0.4;
    const c1yLo = a.y + uy * len * 0.3 - py * swell * 0.4;
    const c2xLo = b.x - ux * len * 0.3 - px * swell * 0.1;
    const c2yLo = b.y - uy * len * 0.3 - py * swell * 0.1;
    const edgeLo = `M ${p(a.x, a.y)} C ${p(c1xLo, c1yLo)} ${p(c2xLo, c2yLo)} ${p(b.x, b.y)}`;
    return [edgeHi, edgeLo];
  }

  if (kind === "contradicts") {
    // Opposing counter-vortex hooks: each ribbon curls hard toward the centre
    // then RECOILS away on the opposite side, leaving a sharp tension cleft at
    // the hub centre where the two colours refuse to merge.
    const cleft = amp * 0.18; // the small gap the two hooks leave at centre.
    const hookA =
      `M ${p(a.x, a.y)} ` +
      `C ${p(a.x + ux * len * 0.35 + px * amp, a.y + uy * len * 0.35 + py * amp)} ` +
      `${p(mx - ux * cleft + px * amp * 0.4, my - uy * cleft + py * amp * 0.4)} ` +
      `${p(mx - ux * cleft, my - uy * cleft)}`;
    const hookB =
      `M ${p(b.x, b.y)} ` +
      `C ${p(b.x - ux * len * 0.35 - px * amp, b.y - uy * len * 0.35 - py * amp)} ` +
      `${p(mx + ux * cleft - px * amp * 0.4, my + uy * cleft - py * amp * 0.4)} ` +
      `${p(mx + ux * cleft, my + uy * cleft)}`;
    return [hookA, hookB];
  }

  // Harmonious kinds (`relates` / `supports`): an intertwined S-curve
  // double-helix. Ribbon A bows to +perp through the midpoint; ribbon B mirrors
  // it to -perp; a thin filament laces between them so the two colours read as
  // woven, not stacked.
  const q1x = a.x + dx * 0.33;
  const q1y = a.y + dy * 0.33;
  const q2x = a.x + dx * 0.66;
  const q2y = a.y + dy * 0.66;
  const helixA =
    `M ${p(a.x, a.y)} ` +
    `C ${p(q1x + px * amp, q1y + py * amp)} ${p(q2x - px * amp, q2y - py * amp)} ${p(b.x, b.y)}`;
  const helixB =
    `M ${p(a.x, a.y)} ` +
    `C ${p(q1x - px * amp, q1y - py * amp)} ${p(q2x + px * amp, q2y + py * amp)} ${p(b.x, b.y)}`;
  const filament =
    `M ${p(a.x, a.y)} ` +
    `C ${p(q1x + px * amp * 0.35, q1y + py * amp * 0.35)} ` +
    `${p(q2x - px * amp * 0.35, q2y - py * amp * 0.35)} ${p(b.x, b.y)}`;
  return [helixA, helixB, filament];
}

/**
 * M14–M16 (FEAT-002) render the unstirred-watercolour curl ribbons for ONE
 * meeting zone (a basin overlap or a node-to-node intersection hub). Two/three
 * interlocking ribbons from {@link buildWatercolorCurlRibbons} are painted with
 * `mix-blend-mode: multiply` and pushed through the directional marbling filter
 * `#watercolor-curl-marbling` so the colours curl into each other like
 * unstirred ink in water. `data-testid="watercolor-curl-ribbons"` wraps the
 * group; `data-curl-kind` carries the differentiating RelationshipKind.
 */
export function WatercolorCurlRibbons({
  a,
  b,
  colorA,
  colorB,
  kind = "relates",
}: {
  a: CurlPoint;
  b: CurlPoint;
  colorA: string;
  colorB: string;
  kind?: RelationshipKind;
}): JSX.Element {
  const ribbons = useMemo(() => buildWatercolorCurlRibbons(a, b, kind), [a, b, kind]);
  const fills = [colorA, colorB, mixHex(colorA, colorB, 0.5)];
  return (
    <g
      data-testid="watercolor-curl-ribbons"
      data-curl-kind={kind}
      data-ribbon-count={ribbons.length}
      className="ito-curl-ribbons"
      aria-hidden="true"
      pointerEvents="none"
      filter="url(#watercolor-curl-marbling)"
    >
      {ribbons.map((d, i) => (
        <path
          key={i}
          className="ito-curl-ribbon"
          data-ribbon-index={i}
          d={d}
          fill="none"
          stroke={fills[i] ?? fills[0]}
          strokeOpacity={i === 2 ? 0.5 : 0.78}
          strokeWidth={i === 2 ? 3 : 7}
          strokeLinecap="round"
          style={{ mixBlendMode: "multiply" }}
        />
      ))}
    </g>
  );
}

/* ----------------------------------------------------------------------- */
/* Defs: gradients, clip paths, filters                                     */
/* ----------------------------------------------------------------------- */

export function WatercolorDefs({
  squircles,
  motion,
}: {
  squircles: readonly SceneSquircle[];
  motion: boolean;
}): JSX.Element {
  const pairs = useMemo(() => overlapPairs(squircles), [squircles]);
  return (
    <>
      {/* Bled edge for the overlap zones: stronger displacement + a soft blur. */}
      <filter id="watercolor-bleed" x="-25%" y="-25%" width="150%" height="150%">
        <feTurbulence type="fractalNoise" baseFrequency="0.018 0.024" numOctaves={3} seed={11} result="n" />
        <feDisplacementMap in="SourceGraphic" in2="n" scale={34} xChannelSelector="R" yChannelSelector="B" result="d" />
        <feGaussianBlur in="d" stdDeviation={3.2} />
      </filter>
      {/*
        M14–M16 (FEAT-002) directional marbling filter for the unstirred curl
        ribbons. A DIRECTIONAL (anisotropic) turbulence streaks the noise along
        one axis, then a displacement map warps the ribbon strokes so the two
        pigment ribbons curl + marble into one another like unstirred ink,
        instead of reading as two clean vector strokes.
      */}
      <filter id="watercolor-curl-marbling" x="-40%" y="-40%" width="180%" height="180%">
        <feTurbulence
          type="turbulence"
          baseFrequency="0.006 0.028"
          numOctaves={2}
          seed={23}
          result="curlNoise"
        />
        <feDisplacementMap
          in="SourceGraphic"
          in2="curlNoise"
          scale={22}
          xChannelSelector="R"
          yChannelSelector="G"
          result="curlWarp"
        />
        <feGaussianBlur in="curlWarp" stdDeviation={1.1} />
      </filter>
      {/*
        Blooms and the water backdrop are soft because they are RADIAL GRADIENTS
        that fade to transparent - not blurred shapes. A blur filter on a moving
        element is re-rasterised every frame; a gradient costs almost nothing.
      */}
      <radialGradient id="soft-neutral">
        <stop offset="0" stopColor="#7d93ad" stopOpacity="0.9" />
        <stop offset="0.55" stopColor="#7d93ad" stopOpacity="0.45" />
        <stop offset="1" stopColor="#7d93ad" stopOpacity="0" />
      </radialGradient>
      {/* Travelling sheen: a soft diagonal highlight (the "reflection"). */}
      <linearGradient id="watercolor-sheen" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#ffffff" stopOpacity="0" />
        <stop offset="0.45" stopColor="#ffffff" stopOpacity="0" />
        <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.55" />
        <stop offset="0.55" stopColor="#ffffff" stopOpacity="0" />
        <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        {motion && (
          <animateTransform
            attributeName="gradientTransform"
            type="translate"
            from="-1.1 -1.1"
            to="1.1 1.1"
            dur="16s"
            repeatCount="indefinite"
          />
        )}
      </linearGradient>

      {squircles.map((sq) => {
        const pigment = categoryPigment(sq.categoryId, sq.colorCode);
        const r = Math.max(sq.bounds.rx, sq.bounds.ry) * 1.05;
        const id = safeId(sq.categoryId);
        return (
          <g key={`wd-${id}`}>
            <radialGradient id={`soft-${id}`}>
              <stop offset="0" stopColor={pigment} stopOpacity="0.9" />
              <stop offset="0.55" stopColor={pigment} stopOpacity="0.45" />
              <stop offset="1" stopColor={pigment} stopOpacity="0" />
            </radialGradient>
            <radialGradient
              id={`wash-${id}`}
              gradientUnits="userSpaceOnUse"
              cx={sq.bounds.cx}
              cy={sq.bounds.cy}
              r={r}
            >
              <stop offset="0" stopColor={pigment} stopOpacity="0.09" />
              <stop offset="0.6" stopColor={pigment} stopOpacity="0.17" />
              <stop offset="0.9" stopColor={pigment} stopOpacity="0.34" />
              <stop offset="1" stopColor={pigment} stopOpacity="0.44" />
            </radialGradient>
            <clipPath id={`clip-${id}`}>
              <path d={sq.d} />
            </clipPath>
          </g>
        );
      })}

      {pairs.map(([a, b]) => {
        const ida = safeId(a.categoryId);
        const idb = safeId(b.categoryId);
        const ca = categoryPigment(a.categoryId, a.colorCode);
        const cb = categoryPigment(b.categoryId, b.colorCode);
        const mid = mixHex(ca, cb, 0.5);
        const x1 = a.bounds.cx;
        const y1 = a.bounds.cy;
        const x2 = b.bounds.cx;
        const y2 = b.bounds.cy;
        return (
          <linearGradient
            key={`mx-${ida}-${idb}`}
            id={`mix-${ida}-${idb}`}
            gradientUnits="userSpaceOnUse"
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
          >
            <stop offset="0.15" stopColor={ca} stopOpacity="0.9" />
            <stop offset="0.5" stopColor={mid} stopOpacity="1" />
            <stop offset="0.85" stopColor={cb} stopOpacity="0.9" />
          </linearGradient>
        );
      })}
    </>
  );
}

/* ----------------------------------------------------------------------- */
/* Layers                                                                   */
/* ----------------------------------------------------------------------- */

/** Faint pigment-tinted water that drifts behind everything. */
export function WaterBackdrop({
  squircles,
  extent,
  motion,
}: {
  squircles: readonly SceneSquircle[];
  extent: { x: number; y: number; w: number; h: number };
  motion: boolean;
}): JSX.Element {
  const blobs = [0, 1, 2].map((i) => {
    const sq = squircles[i % Math.max(1, squircles.length)];
    return {
      fill: sq ? `url(#soft-${safeId(sq.categoryId)})` : "url(#soft-neutral)",
      cx: extent.x + extent.w * (0.2 + 0.3 * i),
      cy: extent.y + extent.h * (i % 2 === 0 ? 0.3 : 0.7),
      r: Math.max(extent.w, extent.h) * (0.28 + 0.05 * i),
      delay: `${-i * 7}s`,
    };
  });
  return (
    <g data-testid="water-backdrop" className="ito-water" aria-hidden="true" pointerEvents="none" data-animated={motion ? "true" : "false"}>
      {blobs.map((b, i) => (
        <circle
          key={i}
          className="ito-water-blob"
          cx={b.cx}
          cy={b.cy}
          r={b.r}
          fill={b.fill}
          style={{ animationDelay: b.delay }}
        />
      ))}
    </g>
  );
}

/**
 * M13 (§2.1(4)) continuous SUBTRACTIVE glazed watercolour washes — one per
 * Subject basin (including EMPTY Subjects, whose scene squircle is basin-driven).
 *
 * Each basin is rendered as:
 *   - a continuous translucent WASH filling the whole basin interior with
 *     `mix-blend-mode: multiply` so where two basins cross the pigments darken
 *     OPTICALLY (subtractive glaze) instead of being replaced by one averaged
 *     mud colour — the user sees BOTH washes crossing; and
 *   - a distinct darker WET-EDGE pigment ring (higher stroke alpha) along the
 *     ENTIRE basin perimeter so each Subject reads as its own territory.
 *
 * This layer is additive: it does NOT replace the legacy radial-gradient
 * `.category-squircle-fill` rendered by NodesCanvas, it sits over it to deliver
 * the glaze + ring the §2.1(4) spec requires. `data-testid="basin-wash-layer"`
 * wraps the layer; each basin carries `data-testid="category-basin-wash"`.
 */
export function BasinWashes({
  squircles,
}: {
  squircles: readonly SceneSquircle[];
}): JSX.Element {
  return (
    <g data-testid="basin-wash-layer" aria-hidden="true" pointerEvents="none">
      {squircles.map((sq) => {
        const pigment = categoryPigment(sq.categoryId, sq.colorCode);
        return (
          <g
            key={`basin-${safeId(sq.categoryId)}`}
            data-testid="category-basin-wash"
            data-category-id={sq.categoryId}
            data-basin={sq.basin ? "true" : "false"}
          >
            {/* Continuous translucent wash — multiply so overlaps glaze. */}
            <path
              className="ito-basin-wash-fill"
              d={sq.d}
              fill={pigment}
              fillOpacity={0.26}
              style={{ mixBlendMode: "multiply" }}
            />
            {/* Darker wet-edge pigment ring along the ENTIRE perimeter. */}
            <path
              className="ito-basin-wash-edge"
              d={sq.d}
              fill="none"
              stroke={pigment}
              strokeOpacity={0.55}
              strokeWidth={2.4}
            />
          </g>
        );
      })}
    </g>
  );
}

/**
 * Colour-mixing zones where two category washes overlap. KEEPS the legacy
 * `overlap-layer` / `category-overlap` testids (back-compat, specs poll them)
 * and ADDS, for each overlapping pair, a true subtractive INTERSECTION LENS
 * (`data-testid="watercolor-overlap-zone"`) — the optically glazed `multiply`
 * intersection the user inspects in the DOM (M13 §2.1(4)). The lens is the
 * geometric A∩B region (basin B clipped to basin A) painted with `multiply`,
 * so the overlap darkens where the two washes cross rather than being replaced
 * by a single averaged blob.
 */
export function OverlapBleeds({
  squircles,
  motion,
}: {
  squircles: readonly SceneSquircle[];
  motion: boolean;
}): JSX.Element {
  const pairs = useMemo(() => overlapPairs(squircles), [squircles]);
  return (
    <g data-testid="overlap-layer" aria-hidden="true" pointerEvents="none">
      {pairs.map(([a, b]) => {
        const ida = safeId(a.categoryId);
        const idb = safeId(b.categoryId);
        const midX = (a.bounds.cx + b.bounds.cx) / 2;
        const midY = (a.bounds.cy + b.bounds.cy) / 2;
        const rr = Math.min(a.bounds.rx, b.bounds.rx, a.bounds.ry, b.bounds.ry) * 0.55;
        const ca = categoryPigment(a.categoryId, a.colorCode);
        const cb = categoryPigment(b.categoryId, b.colorCode);
        return (
          <g
            key={`${ida}|${idb}`}
            data-testid="category-overlap"
            data-a={a.categoryId}
            data-b={b.categoryId}
            clipPath={`url(#clip-${ida})`}
            className="ito-overlap"
          >
            <g filter="url(#watercolor-bleed)">
              <path d={b.d} fill={`url(#mix-${ida}-${idb})`} />
            </g>
            {/* Drifting blooms of each pigment inside the meeting zone. */}
            <g className="ito-overlap-blooms" data-animated={motion ? "true" : "false"}>
              <ellipse className="ito-bloom ito-bloom-a" cx={midX - rr * 0.35} cy={midY - rr * 0.1} rx={rr * 1.5} ry={rr * 1.05} fill={`url(#soft-${ida})`} />
              <ellipse className="ito-bloom ito-bloom-b" cx={midX + rr * 0.35} cy={midY + rr * 0.1} rx={rr * 1.35} ry={rr * 1.1} fill={`url(#soft-${idb})`} />
            </g>
            {/*
              M13 §2.1(4): the subtractive glazed INTERSECTION LENS. Painting
              basin B's whole shape with `multiply`, clipped to basin A (the
              group's clipPath), yields exactly the A∩B region darkened by BOTH
              pigments — the glaze — while both basins' own washes/edges remain
              fully visible crossing each other. Inspectable via its testid.
            */}
            <path
              data-testid="watercolor-overlap-zone"
              className="ito-overlap-lens"
              d={b.d}
              fill={mixHex(ca, cb, 0.5)}
              fillOpacity={0.3}
              style={{ mixBlendMode: "multiply" }}
            />
            {/*
              M14–M16 (FEAT-002): unstirred watercolour CURLS. Where the two
              Subject basins meet, the pigments curl into each other as
              interlocking marbling ribbons rather than averaging into a flat
              wash. A basin overlap has no RelationshipKind, so the harmonious
              `relates` double-helix is used.
            */}
            <WatercolorCurlRibbons
              a={{ x: a.bounds.cx, y: a.bounds.cy }}
              b={{ x: b.bounds.cx, y: b.bounds.cy }}
              colorA={ca}
              colorB={cb}
              kind="relates"
            />
          </g>
        );
      })}
    </g>
  );
}

/** A soft travelling highlight over a wash (the watery reflection). */
export function SheenOverlay({ d }: { d: string }): JSX.Element {
  return <path className="ito-sheen" d={d} fill="url(#watercolor-sheen)" pointerEvents="none" />;
}
