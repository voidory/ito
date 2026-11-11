/**
 * FEAT-005B — visual debugging output for every evaluated structure.
 *
 * Produces a single self-contained SVG per structure that overlays, in labelled
 * panels:
 *   1. the original decoded image (as a gray raster),
 *   2. the extracted BINARY image (post threshold/denoise/close),
 *   3. the THINNED 1px skeleton,
 *   4. the detected GEOMETRIC vertices (pre chemical interpretation),
 *   5. the reconstructed CARBON atoms (coloured by match status vs. ground truth),
 *   6. the reconstructed BONDS (coloured correct / wrong),
 *   7. the detected CYCLES (ring atom-id loops filled).
 *
 * False vertices (predicted with no ground-truth match), missing vertices
 * (ground-truth with no predicted match) and incorrectly-connected bonds are
 * drawn in distinct colours so they are easy to inspect by eye.
 *
 * The SVG is pure text (no DOM, no canvas), so it is written during the
 * benchmark run and opens in any browser / the read-only file explorer.
 */

import { extractGeometricGraph } from "../../../skeleton/graphExtraction";
import { preprocess } from "../../../skeleton/preprocess";
import type {
  BinaryImage,
  CarbonSkeletonResult,
  GeometricGraph,
  GrayImage,
  Point,
} from "../../../skeleton/types";
import { DEFAULT_PIPELINE_OPTIONS } from "../../../skeleton/types";
import type { EvaluationMetrics, GroundTruthGraph } from "./metrics";

export interface VisualizationInput {
  readonly gray: GrayImage;
  readonly result: CarbonSkeletonResult;
  readonly groundTruth: GroundTruthGraph;
  readonly metrics: EvaluationMetrics;
  readonly title: string;
  /**
   * Optional base64 of the ORIGINAL PNG. When provided, the "original" panel
   * embeds it as an <image> (compact + faithful) instead of rasterising every
   * dark pixel as an SVG rect (which bloats the file on anti-aliased art).
   */
  readonly originalPngBase64?: string;
}

/** Rebuild the pipeline intermediates needed for the overlay panels. */
export function pipelineStages(gray: GrayImage): {
  binary: BinaryImage;
  skeleton: BinaryImage;
  graph: GeometricGraph;
} {
  const opts = DEFAULT_PIPELINE_OPTIONS;
  const { cleaned, skeleton } = preprocess(gray, {
    minComponentPixels: opts.minComponentPixels,
  });
  const graph = extractGeometricGraph(skeleton, {
    simplifyTolerance: opts.simplifyTolerance,
    minCornerAngleDeg: opts.minCornerAngleDeg,
    mergeRadius: opts.mergeRadius,
    minEdgeLength: opts.minEdgeLength,
    keepCrossingsAsJunction: true,
  });
  return { binary: cleaned, skeleton, graph };
}

function grayPanelPixels(gray: GrayImage): string {
  // Render as a <image> via a data URI would need a PNG encoder; instead draw
  // a coarse foreground mask as rects (cheap + dependency-free). We sample dark
  // pixels so the panel reads as the original line art.
  return binaryLikeRects(
    gray.width,
    gray.height,
    (x, y) => (gray.data[y * gray.width + x] as number) < 160,
    "#333",
  );
}

function binaryPanel(bin: BinaryImage, color: string): string {
  return binaryLikeRects(bin.width, bin.height, (x, y) => bin.data[y * bin.width + x] === 1, color);
}

/** Emit 1x1 rects for every "on" pixel. Compact enough for small crops. */
function binaryLikeRects(
  width: number,
  height: number,
  on: (x: number, y: number) => boolean,
  color: string,
): string {
  const parts: string[] = [];
  // Run-length encode horizontal spans to keep the SVG small.
  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < width) {
      if (!on(x, y)) {
        x++;
        continue;
      }
      let len = 1;
      while (x + len < width && on(x + len, y)) len++;
      parts.push(`<rect x="${x}" y="${y}" width="${len}" height="1"/>`);
      x += len;
    }
  }
  return `<g fill="${color}">${parts.join("")}</g>`;
}

function panel(
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  body: string,
): string {
  return (
    `<g transform="translate(${x},${y})">` +
    `<rect x="0" y="0" width="${w}" height="${h + 18}" fill="white" stroke="#ccc"/>` +
    `<text x="4" y="13" font-family="sans-serif" font-size="11" fill="#222">${escapeXml(label)}</text>` +
    `<g transform="translate(0,18)">${body}</g>` +
    `</g>`
  );
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function verticesPanel(graph: GeometricGraph): string {
  const edges = graph.edges
    .map((e) => {
      const a = graph.vertices[e.source] as Point;
      const b = graph.vertices[e.target] as Point;
      return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="#bbb" stroke-width="1"/>`;
    })
    .join("");
  const verts = graph.vertices
    .map((v) => {
      const color = v.kind === "junction" ? "#d62728" : v.kind === "endpoint" ? "#1f77b4" : "#2ca02c";
      return `<circle cx="${v.x.toFixed(1)}" cy="${v.y.toFixed(1)}" r="3" fill="${color}"/>`;
    })
    .join("");
  return edges + verts;
}

function atomsPanel(input: VisualizationInput): string {
  const { result, groundTruth, metrics } = input;
  // Ground-truth atoms that were matched by SOME predicted atom.
  const gtMatched = new Set(metrics.predToGt.filter((g) => g >= 0));
  const parts: string[] = [];
  // Missing (GT atoms never matched) — orange hollow squares.
  groundTruth.atoms.forEach((p, i) => {
    if (!gtMatched.has(i)) {
      parts.push(
        `<rect x="${(p.x - 4).toFixed(1)}" y="${(p.y - 4).toFixed(1)}" width="8" height="8" fill="none" stroke="#ff7f0e" stroke-width="2"/>`,
      );
    }
  });
  // Predicted atoms: green = matched true vertex, red = false (unmatched).
  result.atoms.forEach((a, i) => {
    const matched = (metrics.predToGt[i] ?? -1) >= 0;
    parts.push(
      `<circle cx="${a.x.toFixed(1)}" cy="${a.y.toFixed(1)}" r="3.5" fill="${matched ? "#2ca02c" : "#d62728"}"/>`,
    );
  });
  return parts.join("");
}

function bondsPanel(input: VisualizationInput): string {
  const { result, groundTruth, metrics } = input;
  const predToGt = metrics.predToGt;
  const gtBondSet = new Set(
    groundTruth.bonds.map(([a, b]) => (a < b ? `${a}:${b}` : `${b}:${a}`)),
  );
  const parts: string[] = [];
  // Ground-truth bonds faint underlay.
  groundTruth.bonds.forEach(([a, b]) => {
    const pa = groundTruth.atoms[a] as Point;
    const pb = groundTruth.atoms[b] as Point;
    parts.push(
      `<line x1="${pa.x.toFixed(1)}" y1="${pa.y.toFixed(1)}" x2="${pb.x.toFixed(1)}" y2="${pb.y.toFixed(1)}" stroke="#ddd" stroke-width="3"/>`,
    );
  });
  // Predicted bonds coloured correct (green) / wrong (red).
  result.bonds.forEach((bnd) => {
    const pa = result.atoms[bnd.source] as Point;
    const pb = result.atoms[bnd.target] as Point;
    const ga = predToGt[bnd.source] ?? -1;
    const gb = predToGt[bnd.target] ?? -1;
    const key = ga >= 0 && gb >= 0 ? (ga < gb ? `${ga}:${gb}` : `${gb}:${ga}`) : "X";
    const correct = key !== "X" && gtBondSet.has(key);
    parts.push(
      `<line x1="${pa.x.toFixed(1)}" y1="${pa.y.toFixed(1)}" x2="${pb.x.toFixed(1)}" y2="${pb.y.toFixed(1)}" stroke="${correct ? "#2ca02c" : "#d62728"}" stroke-width="1.6"/>`,
    );
  });
  return parts.join("");
}

function cyclesPanel(result: CarbonSkeletonResult): string {
  const palette = ["#1f77b455", "#ff7f0e55", "#2ca02c55", "#9467bd55", "#8c564b55"];
  const parts: string[] = [];
  result.cycles.forEach((cycle, ci) => {
    const pts = cycle
      .map((id) => {
        const a = result.atoms[id] as { x: number; y: number } | undefined;
        return a ? `${a.x.toFixed(1)},${a.y.toFixed(1)}` : "";
      })
      .filter(Boolean)
      .join(" ");
    parts.push(`<polygon points="${pts}" fill="${palette[ci % palette.length]}" stroke="#555" stroke-width="1"/>`);
  });
  // Also draw the skeleton edges for context.
  result.bonds.forEach((b) => {
    const pa = result.atoms[b.source] as { x: number; y: number };
    const pb = result.atoms[b.target] as { x: number; y: number };
    parts.push(
      `<line x1="${pa.x.toFixed(1)}" y1="${pa.y.toFixed(1)}" x2="${pb.x.toFixed(1)}" y2="${pb.y.toFixed(1)}" stroke="#999" stroke-width="1"/>`,
    );
  });
  return parts.join("");
}

/** Build the full multi-panel SVG debugging overlay for one structure. */
export function renderDebugSvg(input: VisualizationInput): string {
  const { gray } = input;
  const { binary, skeleton, graph } = pipelineStages(gray);
  const w = gray.width;
  const h = gray.height;
  const gap = 12;
  const cols = 4;
  const panelW = w;
  const panelH = h;
  const rowH = panelH + 18 + gap;
  const colW = panelW + gap;

  const originalBody = input.originalPngBase64
    ? `<image x="0" y="0" width="${w}" height="${h}" href="data:image/png;base64,${input.originalPngBase64}"/>`
    : grayPanelPixels(gray);

  const panels: { label: string; body: string }[] = [
    { label: "1. original", body: originalBody },
    { label: "2. binary", body: binaryPanel(binary, "#111") },
    { label: "3. thinned skeleton", body: binaryPanel(skeleton, "#0066cc") },
    { label: "4. geometric vertices", body: verticesPanel(graph) },
    { label: "5. carbon atoms (red=false, orange=missing)", body: atomsPanel(input) },
    { label: "6. bonds (red=wrong)", body: bondsPanel(input) },
    { label: "7. cycles", body: cyclesPanel(input.result) },
    { label: "legend", body: legend() },
  ];

  const body = panels
    .map((p, i) => {
      const cx = (i % cols) * colW;
      const cy = Math.floor(i / cols) * rowH + 22;
      return panel(cx, cy, panelW, panelH, p.label, p.body);
    })
    .join("");

  const rows = Math.ceil(panels.length / cols);
  const totalW = cols * colW;
  const totalH = rows * rowH + 24;

  const m = input.metrics;
  const header =
    `<text x="4" y="15" font-family="sans-serif" font-size="13" fill="#000">` +
    escapeXml(
      `${input.title}  |  exact=${m.exact}  vF1=${m.vertex.f1.toFixed(2)}  bF1=${m.bond.f1.toFixed(2)}  ` +
        `GED=${m.graphEditDistance}  μ ${m.cycleRankActual}/${m.cycleRankExpected}  ` +
        `branchTopo=${m.branchTopologyCorrect}`,
    ) +
    `</text>`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}">` +
    `<rect width="100%" height="100%" fill="#fafafa"/>` +
    header +
    body +
    `</svg>`
  );
}

function legend(): string {
  const items = [
    ["#2ca02c", "matched / correct"],
    ["#d62728", "false vertex or wrong bond"],
    ["#ff7f0e", "missing (GT) vertex"],
    ["#1f77b4", "endpoint (geom)"],
  ];
  return items
    .map(
      ([c, t], i) =>
        `<circle cx="8" cy="${12 + i * 18}" r="5" fill="${c}"/>` +
        `<text x="20" y="${16 + i * 18}" font-family="sans-serif" font-size="10" fill="#222">${escapeXml(t as string)}</text>`,
    )
    .join("");
}
