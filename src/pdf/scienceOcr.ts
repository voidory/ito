/**
 * M17 (§2) native LaTeX math + chemical SMILES / curly-arrow mechanism engine.
 *
 * Everything here is 100% PURE, synchronous and deterministic — it performs NO
 * network calls (so it never touches the sandbox Squid proxy) and reads the DOM
 * only to lift already-extracted text out of a `.textLayer`. The four exported
 * entry points are:
 *
 *  - {@link extractLatexFromRegion}: reconstruct clean LaTeX from the text-layer
 *    spans intersecting a normalized crop rect (or normalize a text hint).
 *  - {@link convertLatexToMathML}: compile a LaTeX string into self-contained
 *    `<math xmlns=...>` MathML that Microsoft Word parses into an editable
 *    equation.
 *  - {@link renderMechanismSvg}: render a {@link ChemicalMechanismSpec} (a
 *    reaction SMILES scheme + curly electron-pushing arrows) into a
 *    publication-grade vector `<svg>`.
 *  - {@link copyScienceToWordClipboard}: build the multi-MIME payload and write
 *    it to the clipboard (with graceful fallbacks for unit tests).
 */

import type {
  ChemicalMechanismSpec,
  ElectronFlowArrow,
  NormalizedRect,
  SpatialAtom2D,
  SpatialBond2D,
} from "../model";
import {
  smilesFromGraph,
  vectorizeMechanismImage,
  type FigureChar,
  type RasterImage,
  type RawCurlyArrow,
} from "./mechanismVision";
import { parseSmilesGraph } from "../science/recognition/chemGraph";
import {
  MATH_SYMBOL_TO_LATEX,
  detectHorizontalRules,
  glyphsToLatex,
  type MathGlyph,
  type MathRule,
} from "./mathLayout";

// ---------------------------------------------------------------------------
// §2.2(1) LaTeX extraction from a cropped region
// ---------------------------------------------------------------------------

/** Greek letter → LaTeX command map (lowercase + a few common uppercase). */
const GREEK_TO_LATEX: Record<string, string> = {
  α: "\\alpha", β: "\\beta", γ: "\\gamma", δ: "\\delta", ε: "\\epsilon",
  ζ: "\\zeta", η: "\\eta", θ: "\\theta", ι: "\\iota", κ: "\\kappa",
  λ: "\\lambda", μ: "\\mu", ν: "\\nu", ξ: "\\xi", ο: "o", π: "\\pi",
  ρ: "\\rho", σ: "\\sigma", τ: "\\tau", υ: "\\upsilon", φ: "\\phi",
  χ: "\\chi", ψ: "\\psi", ω: "\\omega",
  Γ: "\\Gamma", Δ: "\\Delta", Θ: "\\Theta", Λ: "\\Lambda", Ξ: "\\Xi",
  Π: "\\Pi", Σ: "\\Sigma", Φ: "\\Phi", Ψ: "\\Psi", Ω: "\\Omega",
};

/** Mathematical operator / symbol → LaTeX command map. */
const SYMBOL_TO_LATEX: Record<string, string> = {
  "∫": "\\int", "∑": "\\sum", "∏": "\\prod", "√": "\\sqrt",
  "±": "\\pm", "∓": "\\mp", "×": "\\times", "÷": "\\div",
  "≤": "\\leq", "≥": "\\geq", "≠": "\\neq", "≈": "\\approx",
  "∞": "\\infty", "∂": "\\partial", "∇": "\\nabla", "→": "\\to",
  "·": "\\cdot", "∈": "\\in", "∉": "\\notin", "∪": "\\cup", "∩": "\\cap",
};

/** Options for {@link extractLatexFromRegion}. */
export interface ExtractLatexOptions {
  /**
   * Thin horizontal rules (fraction bars, radical vincula) inside the region,
   * in normalized 0..1 PAGE coordinates — see {@link detectRegionRules}. They
   * are drawn as graphics, so the text layer alone cannot supply them.
   */
  readonly rules?: readonly MathRule[];
}

/**
 * M17 (§2.2(1)) reconstruct LaTeX from the text inside a box selection.
 *
 * The glyphs whose centres fall inside `normRect` are lifted from the page's
 * `.textLayer` WITH their geometry (per-glyph x extent, baseline, font size)
 * and handed to {@link glyphsToLatex}, which rebuilds super/subscripts,
 * fractions, radicals, limits and line breaks from where the glyphs sit. A box
 * that cuts through a text run therefore yields only the glyphs it covers, not
 * the whole run. When no stage/glyphs are available (jsdom, or a crop over an
 * image region) `hintText` is normalized instead, so a caller can always pass
 * extracted OCR text.
 */
export function extractLatexFromRegion(
  pageStageEl: HTMLElement | null,
  normRect: NormalizedRect,
  hintText?: string,
  options: ExtractLatexOptions = {},
): string {
  const stageBox = pageStageEl?.getBoundingClientRect();
  // Work in on-screen pixels so the page's aspect ratio is respected; without a
  // laid-out stage (jsdom) fall back to a nominal page so geometry still scales.
  const sw = stageBox && stageBox.width > 0 ? stageBox.width : 1000;
  const sh = stageBox && stageBox.height > 0 ? stageBox.height : 1414;
  const glyphs = collectRegionGlyphs(pageStageEl, normRect, sw, sh);
  if (glyphs.length === 0) return normalizeToLatex(hintText ?? "");
  const rules = (options.rules ?? []).map((r) => ({
    x0: r.x0 * sw,
    x1: r.x1 * sw,
    y: r.y * sh,
    ...(r.thickness != null ? { thickness: r.thickness * sh } : {}),
  }));
  const latex = glyphsToLatex(glyphs, rules);
  return latex.length > 0 ? latex : normalizeToLatex(hintText ?? "");
}

/**
 * Find the fraction bars / radical vincula drawn inside an area crop, as rules
 * in normalized page coordinates for {@link extractLatexFromRegion}. Reads the
 * crop's own pixels (the PNG captured when the box was drawn), so nothing is
 * re-rendered. Resolves to `[]` where the crop cannot be decoded (jsdom, or an
 * area that predates the cropper).
 */
export async function detectRegionRules(
  imageDataUrl: string | undefined,
  normRect: NormalizedRect,
): Promise<MathRule[]> {
  if (!imageDataUrl || normRect.width <= 0 || normRect.height <= 0) return [];
  const image = await loadRasterFromDataUrl(imageDataUrl);
  if (!image) return [];
  const kx = normRect.width / image.width;
  const ky = normRect.height / image.height;
  return detectHorizontalRules(image).map((r) => ({
    x0: normRect.x + r.x0 * kx,
    x1: normRect.x + r.x1 * kx,
    y: normRect.y + r.y * ky,
    thickness: (r.thickness ?? 1) * ky,
  }));
}

/** Rough relative advance widths, for splitting a run when the DOM cannot. */
function charWeight(ch: string): number {
  if (/[iljtf.,;:'!|()\[\] ]/.test(ch)) return 0.5;
  if (/[mwMW∑∏]/.test(ch)) return 1.5;
  if (/[A-Z]/.test(ch)) return 1.2;
  return 1;
}

/**
 * Lift the glyphs whose centre lies inside a normalized crop rect, each with
 * its x extent, baseline and font size in stage pixels.
 *
 *  - Baseline + font size come from the exact pdf.js text transform that
 *    `render.ts` stamps on each span (`data-base-geom`); a browser's fallback
 *    font would otherwise shift the DOM baseline by a font-dependent amount —
 *    enough to confuse a subscript with on-line text.
 *  - Per-glyph x extents are measured with a DOM Range, so a box that cuts a
 *    run in half selects only the glyphs it covers.
 *  - Spans without either (cache-hydrated spans, jsdom) fall back to their
 *    normalized rect, split proportionally.
 */
function collectRegionGlyphs(
  pageStageEl: HTMLElement | null,
  normRect: NormalizedRect,
  sw: number,
  sh: number,
): MathGlyph[] {
  if (!pageStageEl) return [];
  const textLayer = pageStageEl.querySelector<HTMLElement>(".textLayer");
  if (!textLayer) return [];
  const stageBox = pageStageEl.getBoundingClientRect();
  const measurable = stageBox.width > 0 && stageBox.height > 0;
  let spans = Array.from(textLayer.querySelectorAll<HTMLElement>("span")).filter(
    (el) => el.childElementCount === 0 && (el.textContent ?? "").trim().length > 0 &&
      el.dataset.ocrSynthetic !== "true",
  );
  // A cache-hydrated layer duplicates the live pdf.js spans: prefer the live ones.
  const live = spans.filter((el) => el.dataset.cachedSpan !== "true");
  if (live.length > 0) spans = live;

  const rx0 = normRect.x * sw;
  const rx1 = (normRect.x + normRect.width) * sw;
  const ry0 = normRect.y * sh;
  const ry1 = (normRect.y + normRect.height) * sh;
  const range = measurable && typeof document !== "undefined" && document.createRange
    ? document.createRange()
    : null;
  const out: MathGlyph[] = [];

  for (const span of spans) {
    const geo = spanNormGeometry(span, stageBox);
    if (!geo) continue;
    let x0 = geo.x * sw;
    let width = geo.width * sw;
    // Cached rects are baseline-bottomed; a live line box hangs ~0.2em below.
    let size = geo.height * sh;
    let base = span.dataset.cachedSpan === "true" || !measurable
      ? (geo.y + geo.height) * sh
      : geo.y * sh + 0.8 * size;
    const stamp = span.dataset.baseGeom?.split(",").map((p) => parseFloat(p));
    if (stamp && stamp.length === 4 && stamp.every((v) => Number.isFinite(v))) {
      if (Math.abs(stamp[3]!) > 0.2) continue; // not horizontal on screen
      base = stamp[1]! * sh;
      size = stamp[2]! * sh;
      if (!measurable) x0 = stamp[0]! * sw;
    }
    if (!(size > 0)) continue;
    // Cheap reject before measuring individual glyphs.
    const midY = base - 0.3 * size;
    if (midY < ry0 || midY > ry1 || x0 > rx1 || x0 + width < rx0) continue;

    const textNode = span.firstChild;
    const str = span.textContent ?? "";
    const chars = Array.from(str);
    let measured: { x0: number; x1: number }[] | null = null;
    if (range && textNode && textNode.nodeType === 3) {
      measured = [];
      let offset = 0;
      for (const ch of chars) {
        try {
          range.setStart(textNode, offset);
          range.setEnd(textNode, offset + ch.length);
          const r = range.getBoundingClientRect();
          measured.push({ x0: r.left - stageBox.left, x1: r.right - stageBox.left });
        } catch {
          measured = null;
          break;
        }
        offset += ch.length;
      }
      if (measured && !measured.some((m) => m.x1 > m.x0)) measured = null;
    }
    if (!measured) {
      const total = chars.reduce((acc, ch) => acc + charWeight(ch), 0) || 1;
      let acc = 0;
      measured = chars.map((ch) => {
        const a = x0 + (acc / total) * width;
        acc += charWeight(ch);
        return { x0: a, x1: x0 + (acc / total) * width };
      });
    }
    chars.forEach((ch, i) => {
      const m = measured![i]!;
      const c = (m.x0 + m.x1) / 2;
      if (ch.trim().length === 0 || c < rx0 || c > rx1) return;
      out.push({ ch, x0: m.x0, x1: m.x1, base, size });
    });
  }
  return out;
}

function spanNormGeometry(
  span: HTMLElement,
  stageBox: { left: number; top: number; width: number; height: number },
): NormalizedRect | null {
  const data = span.dataset?.normRect;
  if (data) {
    const parts = data.split(",").map((p) => parseFloat(p));
    if (parts.length === 4 && parts.every((v) => Number.isFinite(v))) {
      return { x: parts[0]!, y: parts[1]!, width: parts[2]!, height: parts[3]! };
    }
  }
  const rect = span.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0 && stageBox.width > 0 && stageBox.height > 0) {
    return {
      x: (rect.left - stageBox.left) / stageBox.width,
      y: (rect.top - stageBox.top) / stageBox.height,
      width: rect.width / stageBox.width,
      height: rect.height / stageBox.height,
    };
  }
  return null;
}

/**
 * Normalize an arbitrary math string into valid LaTeX: map Unicode Greek +
 * operator glyphs, turn `√x` / `√(expr)` into `\sqrt{...}`, turn simple `a/b`
 * into `\frac{a}{b}`, and brace multi-char super/subscript runs.
 *
 * Exported (M18 FEAT-003) so the recognition layer's math recognizer can route
 * a model backend's raw LaTeX through the SAME normalization the text-layer
 * extraction uses, before compiling it to MathML. Behavior is unchanged.
 */
export function normalizeToLatex(input: string): string {
  let s = (input ?? "").trim();
  if (s.length === 0) return "";

  // If the input already looks like LaTeX (contains a backslash command), keep
  // its structure and only map any stray Unicode glyphs.
  for (const [glyph, cmd] of Object.entries(SYMBOL_TO_LATEX)) {
    if (glyph === "√") continue; // handled below with its radicand
    s = s.split(glyph).join(`${cmd} `);
  }
  for (const [glyph, cmd] of Object.entries(GREEK_TO_LATEX)) {
    s = s.split(glyph).join(`${cmd} `);
  }

  // √(...) or √x → \sqrt{...}
  s = s.replace(/√\s*\(([^)]*)\)/g, (_m, g1) => `\\sqrt{${String(g1).trim()}}`);
  s = s.replace(/√\s*([A-Za-z0-9]+)/g, (_m, g1) => `\\sqrt{${String(g1)}}`);
  s = s.split("√").join("\\sqrt{}");

  // Brace multi-character super/subscript runs that are not already braced:
  // x^23 → x^{23}, a_ij → a_{ij}. Single-char runs are left as-is (valid LaTeX).
  s = s.replace(/([\^_])\{?([A-Za-z0-9]+)\}?/g, (_m, op, run) => {
    const r = String(run);
    return r.length > 1 ? `${op}{${r}}` : `${op}${r}`;
  });

  // Simple top-level `a/b` → \frac{a}{b} (only when neither side already uses a
  // LaTeX command / brace, to avoid mangling \frac or paths).
  s = s.replace(
    /(^|[\s=({+\-])([A-Za-z0-9]+)\s*\/\s*([A-Za-z0-9]+)(?=$|[\s=)}\-+])/g,
    (_m, pre, a, b) => `${pre}\\frac{${a}}{${b}}`,
  );

  // The glyph→command mapping above appends a separator space (so `α2` cannot
  // fuse into `\alpha2`). A following ^/_ already terminates the command, so
  // drop that space: `\alpha ^2` → `\alpha^2`.
  s = s.replace(/(\\[A-Za-z]+) +(?=[\^_])/g, "$1");

  return s.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// §2.2(2) LaTeX → Word-native MathML compiler
// ---------------------------------------------------------------------------

const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

/** A tiny LaTeX token for the recursive-descent MathML compiler. */
type LatexToken =
  | { kind: "cmd"; name: string }
  | { kind: "sym"; value: string }
  | { kind: "num"; value: string }
  | { kind: "ident"; value: string }
  | { kind: "op"; value: string }
  | { kind: "text"; value: string; cmd: string }
  | { kind: "sup" }
  | { kind: "sub" }
  | { kind: "lbrace" }
  | { kind: "rbrace" };

/**
 * M17 (§2.2(2)) compile a LaTeX string into a self-contained
 * `<math xmlns="http://www.w3.org/1998/Math/MathML" display="block">…</math>`
 * document that Microsoft Word parses natively into an editable equation.
 * Supports `\frac{a}{b}` (`<mfrac>`), `x^{…}` (`<msup>`), `x_{…}` (`<msub>`),
 * `\sqrt{…}` (`<msqrt>`), `\sum`/`\int`/operators, and Greek letters.
 */
export function convertLatexToMathML(latex: string): string {
  const tokens = tokenizeLatex(latex ?? "");
  // A top-level `\\` separates the lines of a multi-line equation.
  const rows: LatexToken[][] = [[]];
  let depth = 0;
  for (const tok of tokens) {
    if (tok.kind === "lbrace") depth++;
    else if (tok.kind === "rbrace") depth = Math.max(0, depth - 1);
    if (depth === 0 && tok.kind === "cmd" && tok.name === "\\") rows.push([]);
    else rows[rows.length - 1]!.push(tok);
  }
  const bodies = rows
    .filter((r, i) => r.length > 0 || i === 0)
    .map((r) => {
      const { nodes } = parseSequence(r, 0, false);
      return nodes.length > 0 ? nodes.join("") : "<mrow></mrow>";
    });
  const body =
    bodies.length > 1
      ? `<mtable>${bodies.map((b) => `<mtr><mtd><mrow>${b}</mrow></mtd></mtr>`).join("")}</mtable>`
      : bodies[0]!;
  return `<math xmlns="${MATHML_NS}" display="block"><mrow>${body}</mrow></math>`;
}

/** `\name` -> glyph for every plain symbol command the extractor can emit. */
const EXTRA_OPS: Record<string, string> = Object.fromEntries(
  Object.entries(MATH_SYMBOL_TO_LATEX)
    .filter(([, cmd]) => /^\\[A-Za-z]+$/.test(cmd))
    .map(([glyph, cmd]) => [cmd.slice(1), glyph]),
);
/** Commands whose `{…}` argument is literal text, not math. */
const TEXT_CMDS = new Set(["text", "mathrm", "operatorname", "mathbb", "textrm", "mathit"]);

const GREEK_NAMES = new Set(
  Object.values(GREEK_TO_LATEX).map((c) => c.replace(/^\\/, "")),
);
const GREEK_CHAR: Record<string, string> = Object.fromEntries(
  Object.entries(GREEK_TO_LATEX).map(([ch, cmd]) => [cmd.replace(/^\\/, ""), ch]),
);
const BIG_OPS: Record<string, string> = {
  sum: "∑", int: "∫", prod: "∏", oint: "∮",
};
const NAMED_OPS: Record<string, string> = {
  pm: "±", mp: "∓", times: "×", div: "÷", cdot: "·", to: "→",
  leq: "≤", geq: "≥", neq: "≠", approx: "≈", infty: "∞",
  partial: "∂", nabla: "∇", le: "≤", ge: "≥", pm2: "±",
};

function tokenizeLatex(src: string): LatexToken[] {
  const out: LatexToken[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === " " || ch === "\t" || ch === "\n") {
      i++;
      continue;
    }
    if (ch === "\\") {
      let j = i + 1;
      let name = "";
      while (j < src.length && /[A-Za-z]/.test(src[j]!)) {
        name += src[j]!;
        j++;
      }
      if (name.length === 0 && j < src.length) {
        const esc = src[j]!;
        if (esc === "\\") {
          out.push({ kind: "cmd", name: "\\" });
        } else if (",;:! ".includes(esc)) {
          out.push({ kind: "cmd", name: "space" });
        } else {
          // An escaped symbol like \{ — treat the next char as a symbol.
          out.push({ kind: "sym", value: esc });
        }
        i = j + 1;
        continue;
      }
      if (TEXT_CMDS.has(name)) {
        // Literal-text argument: keep its spaces instead of tokenizing it.
        let k = j;
        while (k < src.length && src[k] === " ") k++;
        if (src[k] === "{") {
          let depth = 1;
          let m = k + 1;
          while (m < src.length && depth > 0) {
            if (src[m] === "{") depth++;
            else if (src[m] === "}") depth--;
            if (depth > 0) m++;
          }
          out.push({ kind: "text", value: src.slice(k + 1, m), cmd: name });
          i = Math.min(src.length, m + 1);
          continue;
        }
      }
      out.push({ kind: "cmd", name });
      i = j;
      continue;
    }
    if (ch === "{") {
      out.push({ kind: "lbrace" });
      i++;
      continue;
    }
    if (ch === "}") {
      out.push({ kind: "rbrace" });
      i++;
      continue;
    }
    if (ch === "^") {
      out.push({ kind: "sup" });
      i++;
      continue;
    }
    if (ch === "_") {
      out.push({ kind: "sub" });
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let num = ch;
      let j = i + 1;
      while (j < src.length && /[0-9.]/.test(src[j]!)) {
        num += src[j]!;
        j++;
      }
      out.push({ kind: "num", value: num });
      i = j;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      out.push({ kind: "ident", value: ch });
      i++;
      continue;
    }
    out.push({ kind: "op", value: ch });
    i++;
  }
  return out;
}

/** Parse a sequence of tokens into MathML strings until EOF / a `}` when nested. */
function parseSequence(
  tokens: LatexToken[],
  start: number,
  nested: boolean,
): { nodes: string[]; next: number } {
  const nodes: string[] = [];
  let i = start;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    if (tok.kind === "rbrace") {
      if (nested) return { nodes, next: i + 1 };
      i++;
      continue;
    }
    const { node, next } = parseAtomWithScripts(tokens, i);
    if (node != null) nodes.push(node);
    // Always make progress: if the sub-parser could not consume this token
    // (e.g. a dangling ^/_ with no base, or a stray }), skip it so the loop can
    // never spin forever on malformed LaTeX.
    i = next > i ? next : i + 1;
  }
  return { nodes, next: i };
}

/** Parse one atom plus any trailing ^/_ scripts into a single MathML node. */
function parseAtomWithScripts(
  tokens: LatexToken[],
  start: number,
): { node: string | null; next: number } {
  const first = parseAtom(tokens, start);
  let base = first.node;
  let i = first.next;
  if (base == null) return { node: null, next: i };

  let sup: string | null = null;
  let sub: string | null = null;
  while (i < tokens.length && (tokens[i]!.kind === "sup" || tokens[i]!.kind === "sub")) {
    const isSup = tokens[i]!.kind === "sup";
    const scriptRes = parseAtom(tokens, i + 1);
    const scriptNode = scriptRes.node ?? "<mrow></mrow>";
    i = scriptRes.next;
    if (isSup) sup = scriptNode;
    else sub = scriptNode;
  }

  if (sup != null && sub != null) {
    return { node: `<msubsup>${base}${sub}${sup}</msubsup>`, next: i };
  }
  if (sup != null) return { node: `<msup>${base}${sup}</msup>`, next: i };
  if (sub != null) return { node: `<msub>${base}${sub}</msub>`, next: i };
  return { node: base, next: i };
}

/** Parse a single atom (group, command, number, identifier, operator). */
function parseAtom(tokens: LatexToken[], start: number): { node: string | null; next: number } {
  if (start >= tokens.length) return { node: null, next: start };
  const tok = tokens[start]!;
  switch (tok.kind) {
    case "lbrace": {
      const { nodes, next } = parseSequence(tokens, start + 1, true);
      const inner = nodes.length > 0 ? nodes.join("") : "<mrow></mrow>";
      return { node: `<mrow>${inner}</mrow>`, next };
    }
    case "num":
      return { node: `<mn>${escapeXml(tok.value)}</mn>`, next: start + 1 };
    case "ident":
      return { node: `<mi>${escapeXml(tok.value)}</mi>`, next: start + 1 };
    case "sym":
      return { node: `<mo>${escapeXml(tok.value)}</mo>`, next: start + 1 };
    case "op":
      return { node: `<mo>${escapeXml(tok.value)}</mo>`, next: start + 1 };
    case "text": {
      const v = escapeXml(tok.value);
      if (tok.cmd === "mathbb") {
        return { node: `<mi mathvariant="double-struck">${v}</mi>`, next: start + 1 };
      }
      if (tok.cmd === "text" || tok.cmd === "textrm") {
        return { node: `<mtext>${v.replace(/ /g, "\u00a0")}</mtext>`, next: start + 1 };
      }
      const variant = tok.cmd === "mathit" ? "italic" : "normal";
      return { node: `<mi mathvariant="${variant}">${v}</mi>`, next: start + 1 };
    }
    case "cmd":
      return parseCommand(tokens, start);
    case "sup":
    case "sub":
      // A dangling script with no base; consume the following atom as its base.
      return { node: null, next: start };
    case "rbrace":
      return { node: null, next: start };
    default:
      return { node: null, next: start + 1 };
  }
}

function parseCommand(tokens: LatexToken[], start: number): { node: string | null; next: number } {
  const tok = tokens[start]! as { kind: "cmd"; name: string };
  const name = tok.name;
  let i = start + 1;

  if (name === "frac") {
    const num = parseAtom(tokens, i);
    i = num.next;
    const den = parseAtom(tokens, i);
    i = den.next;
    const numNode = num.node ?? "<mrow></mrow>";
    const denNode = den.node ?? "<mrow></mrow>";
    return { node: `<mfrac>${numNode}${denNode}</mfrac>`, next: i };
  }
  if (name === "sqrt") {
    const rad = parseAtom(tokens, i);
    i = rad.next;
    const radNode = rad.node ?? "<mrow></mrow>";
    return { node: `<msqrt>${radNode}</msqrt>`, next: i };
  }
  if (name === "overline" || name === "bar") {
    const arg = parseAtom(tokens, i);
    return {
      node: `<mover accent="true">${arg.node ?? "<mrow></mrow>"}<mo>\u00af</mo></mover>`,
      next: arg.next,
    };
  }
  if (name === "space" || name === "quad" || name === "qquad") {
    const w = name === "space" ? "0.28em" : name === "quad" ? "1em" : "2em";
    return { node: `<mspace width="${w}"/>`, next: i };
  }
  if (name === "\\") return { node: null, next: i };
  if (BIG_OPS[name]) {
    return { node: `<mo>${BIG_OPS[name]}</mo>`, next: i };
  }
  if (NAMED_OPS[name]) {
    return { node: `<mo>${NAMED_OPS[name]}</mo>`, next: i };
  }
  if (GREEK_NAMES.has(name) && GREEK_CHAR[name]) {
    return { node: `<mi>${GREEK_CHAR[name]}</mi>`, next: i };
  }
  if (EXTRA_OPS[name]) {
    return { node: `<mo>${EXTRA_OPS[name]}</mo>`, next: i };
  }
  if (name === "left" || name === "right") {
    // Delimiter wrappers: emit the following delimiter glyph as an <mo>.
    const next = tokens[i];
    if (next && (next.kind === "op" || next.kind === "sym")) {
      return { node: `<mo>${escapeXml(next.value)}</mo>`, next: i + 1 };
    }
    return { node: null, next: i };
  }
  // Unknown command: render its name as an identifier so nothing is lost.
  return { node: `<mi>${escapeXml(name)}</mi>`, next: i };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// §2.2(3) SMILES + curly-arrow mechanism SVG renderer
// ---------------------------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";

/** A laid-out atom in a rendered molecule. */
interface LaidAtom {
  readonly index: number;
  readonly element: string;
  readonly x: number;
  readonly y: number;
  readonly isHetero: boolean;
  /** True for aromatic atoms (preserved from the parsed graph). */
  readonly aromatic: boolean;
}

/** A laid-out bond between two atoms (1=single, 2=double, 3=triple). */
interface LaidBond {
  readonly a: number;
  readonly b: number;
  readonly order: number;
  /** True when this bond is aromatic (preserved from the parsed graph). */
  readonly aromatic: boolean;
}

/** A laid-out molecule: atoms + bonds + its bounding box. */
interface LaidMolecule {
  readonly atoms: readonly LaidAtom[];
  readonly bonds: readonly LaidBond[];
  readonly width: number;
  readonly height: number;
}

/**
 * M17 (§2.2(3)) deterministically render a {@link ChemicalMechanismSpec} into a
 * publication-grade vector `<svg>`: skeletal bond lines + heteroatom labels for
 * each reactant/product molecule, a reaction `⟶` arrow carrying the
 * conditions, and every {@link ElectronFlowArrow} as a smooth cubic-Bézier
 * curly arrow (double-barbed `full` or single-barbed `fishhook`). Pure +
 * deterministic: identical input always yields byte-identical markup.
 */
export function renderMechanismSvg(spec: ChemicalMechanismSpec): string {
  if (spec.atoms2D && spec.atoms2D.length > 0) return renderSpatialMechanismSvg(spec);
  const bondLen = 34;
  const padding = 28;
  const groupGap = 70;
  const arrowGap = 86;

  const { reactants, products } = splitReactionSmiles(spec.smiles);

  // Lay each side's molecules out left→right; track cumulative x offset.
  const placed: { mol: LaidMolecule; offsetX: number; offsetY: number }[] = [];
  let cursorX = padding;
  const centerY = 90;

  const placeSide = (smilesList: readonly string[]): number => {
    let sideWidth = 0;
    smilesList.forEach((smi, idx) => {
      const mol = layoutMolecule(smi, bondLen);
      const offsetY = centerY - mol.height / 2;
      placed.push({ mol, offsetX: cursorX, offsetY });
      cursorX += mol.width + (idx < smilesList.length - 1 ? groupGap : 0);
      sideWidth += mol.width;
    });
    return sideWidth;
  };

  placeSide(reactants);
  const reactantsEndX = cursorX;
  // Reaction arrow gap.
  const arrowStartX = reactantsEndX + 24;
  const arrowEndX = arrowStartX + arrowGap;
  cursorX = arrowEndX + 24;
  placeSide(products);

  const totalWidth = Math.ceil(cursorX + padding);
  const totalHeight = 180;

  const parts: string[] = [];

  // Molecule bond lines + heteroatom labels.
  for (const { mol, offsetX, offsetY } of placed) {
    for (const bond of mol.bonds) {
      const a = mol.atoms[bond.a]!;
      const b = mol.atoms[bond.b]!;
      const x1 = offsetX + a.x;
      const y1 = offsetY + a.y;
      const x2 = offsetX + b.x;
      const y2 = offsetY + b.y;
      parts.push(...bondLines(x1, y1, x2, y2, bond.order, bond.aromatic));
    }
    // FEAT-002 (spec Phase 2.2): aromatic rings get an inner circle so an
    // aromatic SMILES (c1ccccc1) renders DIFFERENTLY from the saturated ring
    // (C1CCCCC1) — aromaticity is no longer lost at render time. The circle is
    // only emitted when the molecule actually contains aromatic atoms, so
    // aliphatic output (and the pinned M17 Test 4 markup) is byte-unchanged.
    const aromaticAtoms = mol.atoms.filter((a) => a.aromatic);
    if (aromaticAtoms.length >= 3) {
      let cx = 0;
      let cy = 0;
      for (const a of aromaticAtoms) {
        cx += offsetX + a.x;
        cy += offsetY + a.y;
      }
      cx /= aromaticAtoms.length;
      cy /= aromaticAtoms.length;
      let radius = 0;
      for (const a of aromaticAtoms) {
        radius = Math.max(radius, Math.hypot(offsetX + a.x - cx, offsetY + a.y - cy));
      }
      parts.push(
        `<circle class="ito-aromatic-ring" cx="${fmt(cx)}" cy="${fmt(cy)}" ` +
          `r="${fmt(radius * 0.6)}" fill="none" stroke="#1a3a5a" stroke-width="1.2"/>`,
      );
    }
    for (const atom of mol.atoms) {
      if (atom.isHetero) {
        const cx = offsetX + atom.x;
        const cy = offsetY + atom.y;
        parts.push(
          `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="9" fill="#fff"/>` +
            `<text class="ito-atom-label" x="${fmt(cx)}" y="${fmt(cy)}" font-size="13" ` +
            `text-anchor="middle" dominant-baseline="central" fill="#1a3a5a">${escapeXml(atom.element)}</text>`,
        );
      }
    }
  }

  // Reaction arrow (longrightarrow) + conditions above / below.
  parts.push(
    `<line class="ito-reaction-arrow" x1="${fmt(arrowStartX)}" y1="${fmt(centerY)}" ` +
      `x2="${fmt(arrowEndX)}" y2="${fmt(centerY)}" stroke="#1a3a5a" stroke-width="1.6" ` +
      `marker-end="url(#ito-reaction-head)"/>`,
  );
  if (spec.conditionsAbove && spec.conditionsAbove.length > 0) {
    parts.push(
      `<text class="ito-conditions-above" x="${fmt((arrowStartX + arrowEndX) / 2)}" ` +
        `y="${fmt(centerY - 8)}" font-size="11" text-anchor="middle" fill="#1a3a5a">` +
        `${escapeXml(spec.conditionsAbove)}</text>`,
    );
  }
  if (spec.conditionsBelow && spec.conditionsBelow.length > 0) {
    parts.push(
      `<text class="ito-conditions-below" x="${fmt((arrowStartX + arrowEndX) / 2)}" ` +
        `y="${fmt(centerY + 18)}" font-size="11" text-anchor="middle" fill="#1a3a5a">` +
        `${escapeXml(spec.conditionsBelow)}</text>`,
    );
  }

  // Curly electron-pushing arrows.
  spec.arrows.forEach((arrow, idx) => {
    parts.push(curlyArrowPath(arrow, idx, placed, totalWidth, centerY));
  });

  const defs =
    `<defs>` +
    `<marker id="ito-full-barb" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">` +
    `<path d="M 0 0 L 10 5 L 0 10 z" fill="#b2402e"/></marker>` +
    `<marker id="ito-fishhook-barb" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">` +
    `<path d="M 0 0 L 10 5 L 4 5 z" fill="#2e6fb2"/></marker>` +
    `<marker id="ito-reaction-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">` +
    `<path d="M 0 1 L 9 5 L 0 9" fill="none" stroke="#1a3a5a" stroke-width="1.4"/></marker>` +
    `</defs>`;

  return (
    `<svg xmlns="${SVG_NS}" data-testid="chem-mechanism-svg" ` +
    `width="${totalWidth}" height="${totalHeight}" viewBox="0 0 ${totalWidth} ${totalHeight}" ` +
    `class="ito-chem-mechanism" data-smiles="${escapeXml(spec.smiles)}">` +
    defs +
    parts.join("") +
    `</svg>`
  );
}

/** Format a number with fixed precision so output is deterministic. */
function fmt(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

/** Split a (reaction) SMILES into reactant + product molecule SMILES lists. */
function splitReactionSmiles(smiles: string): {
  reactants: readonly string[];
  products: readonly string[];
} {
  const s = (smiles ?? "").trim();
  if (s.length === 0) return { reactants: [], products: [] };
  // Reaction SMILES: Reactants>Agents>Products (agents optional). We accept the
  // common ">>" (no agents) and the 3-field form.
  if (s.includes(">")) {
    const fields = s.split(">");
    const reactants = (fields[0] ?? "").split(".").filter((p) => p.length > 0);
    const products = (fields[fields.length - 1] ?? "").split(".").filter((p) => p.length > 0);
    return { reactants, products };
  }
  // A plain SMILES (possibly several '.'-separated fragments) → all reactants.
  return { reactants: s.split(".").filter((p) => p.length > 0), products: [] };
}

/** The set of heteroatom element symbols we label explicitly. */
const HETERO = new Set(["O", "N", "S", "P", "F", "Cl", "Br", "I", "B"]);

/**
 * Lay a single molecule's SMILES out as a deterministic skeletal zig-zag chain.
 * This is a PURPOSELY simple layout (no ring embedding engine) that still
 * yields crisp bond lines + heteroatom labels for publication-grade schemes:
 * atoms alternate up/down along the x axis, bond order is honoured, and ring
 * closure digits re-connect a bond. Enough to render recognizable skeletons for
 * chains, rings and heteroatoms deterministically.
 */
function layoutMolecule(smiles: string, bondLen: number): LaidMolecule {
  const parsed = parseSmiles(smiles);
  const atoms: LaidAtom[] = [];
  const stepX = bondLen * 0.87;
  const amp = bondLen * 0.5;
  parsed.atoms.forEach((atom, index) => {
    const x = index * stepX;
    const y = index % 2 === 0 ? amp : 0;
    atoms.push({
      index,
      element: atom.element,
      x,
      y,
      isHetero: HETERO.has(atom.element),
      aromatic: atom.aromatic,
    });
  });
  if (atoms.length === 0) {
    // An unparseable / empty fragment still gets one carbon vertex so the side
    // renders a dot rather than nothing.
    atoms.push({ index: 0, element: "C", x: 0, y: amp, isHetero: false, aromatic: false });
  }
  let maxX = 0;
  let maxY = 0;
  for (const a of atoms) {
    if (a.x > maxX) maxX = a.x;
    if (a.y > maxY) maxY = a.y;
  }
  return {
    atoms,
    bonds: parsed.bonds,
    width: Math.max(bondLen, maxX),
    height: Math.max(amp, maxY) + 4,
  };
}

/**
 * Parse a single molecule SMILES into the element/aromatic list + bonds the
 * skeletal renderer needs. This now delegates to the richer graph parser in
 * `src/science/recognition/chemGraph.ts` (FEAT-002) so aromaticity is PRESERVED
 * (aromatic atoms keep their `aromatic` flag instead of being silently
 * uppercased into aliphatic carbons) while the renderer's existing deterministic
 * geometry is unchanged for aliphatic input.
 */
function parseSmiles(smiles: string): {
  atoms: { element: string; aromatic: boolean }[];
  bonds: LaidBond[];
} {
  // The renderer lays out ONE molecule at a time (splitReactionSmiles already
  // separated reactants/products and '.'-fragments), so take the first parsed
  // component; empty input yields an empty graph.
  const components = parseSmilesGraph(smiles);
  const mol = components[0];
  if (!mol) return { atoms: [], bonds: [] };
  const atoms = mol.atoms.map((a) => ({ element: a.element, aromatic: a.aromatic }));
  const bonds: LaidBond[] = mol.bonds.map((b) => ({
    a: b.a,
    b: b.b,
    order: b.order,
    aromatic: b.aromatic === true,
  }));
  return { atoms, bonds };
}

/** Render a bond as one (or two/three parallel) crisp skeletal line(s). */
function bondLines(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  order: number,
  aromatic = false,
  strokeWidth = 1.6,
  offset = 2.6,
  bondId?: string,
): string[] {
  // FEAT-002: aromatic bonds carry a data-aromatic marker so aromaticity is
  // visible in the markup. Aliphatic bonds emit no extra attribute.
  const aromaticAttr = aromatic ? ' data-aromatic="true"' : "";
  const idAttr = bondId ? ` data-bond-id="${escapeXml(bondId)}"` : "";
  const line = (a: number, b: number, c: number, d: number): string =>
    `<line class="ito-bond"${aromaticAttr}${idAttr} x1="${fmt(a)}" y1="${fmt(b)}" x2="${fmt(c)}" y2="${fmt(d)}" ` +
    `stroke="#1a3a5a" stroke-width="${fmt(strokeWidth)}" stroke-linecap="round"/>`;
  if (order <= 1) return [line(x1, y1, x2, y2)];
  // Offset perpendicular to the bond for double/triple parallel lines.
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const ox = (-dy / len) * offset;
  const oy = (dx / len) * offset;
  if (order === 2) {
    return [line(x1 + ox, y1 + oy, x2 + ox, y2 + oy), line(x1 - ox, y1 - oy, x2 - ox, y2 - oy)];
  }
  return [
    line(x1, y1, x2, y2),
    line(x1 + ox * 1.6, y1 + oy * 1.6, x2 + ox * 1.6, y2 + oy * 1.6),
    line(x1 - ox * 1.6, y1 - oy * 1.6, x2 - ox * 1.6, y2 - oy * 1.6),
  ];
}

/**
 * Build a smooth cubic-Bézier curly arrow path for an {@link ElectronFlowArrow}.
 * The endpoints are resolved to anchor points on the laid-out molecules by
 * best-effort matching atom/bond tokens; when a token cannot be resolved the
 * arrow deterministically arcs across a region of the scene so it is always
 * drawn (an electron-pushing arrow must never silently vanish). The barb style
 * selects the `full` (double-barbed) or `fishhook` (single-barbed) marker.
 */
function curlyArrowPath(
  arrow: ElectronFlowArrow,
  index: number,
  placed: { mol: LaidMolecule; offsetX: number; offsetY: number }[],
  totalWidth: number,
  centerY: number,
): string {
  const from = resolveArrowAnchor(arrow.fromAtomOrBond, index, placed, totalWidth, centerY, true);
  const to = resolveArrowAnchor(arrow.toAtomOrBond, index, placed, totalWidth, centerY, false);
  const curvature = arrow.curvature ?? 0.5;
  // Control points bow the path upward (electron arrows arc over the scheme).
  const midX = (from.x + to.x) / 2;
  const span = Math.hypot(to.x - from.x, to.y - from.y) || 40;
  const lift = -(span * (0.35 + curvature * 0.4)) - 18;
  const c1x = from.x + (midX - from.x) * 0.5;
  const c1y = Math.min(from.y, to.y) + lift;
  const c2x = to.x + (midX - to.x) * 0.5;
  const c2y = Math.min(from.y, to.y) + lift;
  const d = `M ${fmt(from.x)} ${fmt(from.y)} C ${fmt(c1x)} ${fmt(c1y)} ${fmt(c2x)} ${fmt(c2y)} ${fmt(to.x)} ${fmt(to.y)}`;
  const marker = arrow.barb === "fishhook" ? "url(#ito-fishhook-barb)" : "url(#ito-full-barb)";
  const stroke = arrow.barb === "fishhook" ? "#2e6fb2" : "#b2402e";
  return (
    `<path class="ito-curly-arrow" data-arrow-id="${escapeXml(arrow.id)}" ` +
    `data-from="${escapeXml(arrow.fromAtomOrBond)}" data-to="${escapeXml(arrow.toAtomOrBond)}" ` +
    `data-barb="${arrow.barb}" d="${d}" fill="none" stroke="${stroke}" ` +
    `stroke-width="1.5" marker-end="${marker}"/>`
  );
}

/** Deterministically resolve an arrow token to an (x, y) anchor in the scene. */
function resolveArrowAnchor(
  token: string,
  index: number,
  placed: { mol: LaidMolecule; offsetX: number; offsetY: number }[],
  totalWidth: number,
  centerY: number,
  isSource: boolean,
): { x: number; y: number } {
  // Try to resolve to a labelled atom element token (e.g. "Br1", "O2"). A
  // trailing index selects the Nth atom of that element (1-based) so "Br1" and
  // "Br2" map to DISTINCT atoms when the scheme has several; otherwise the
  // first matching atom is used.
  const elMatch = token.match(/([A-Z][a-z]?)(\d+)?/);
  if (elMatch && elMatch[1] && placed.length > 0) {
    const el = elMatch[1];
    const ordinal = elMatch[2] != null ? Math.max(1, parseInt(elMatch[2], 10)) : 1;
    let seen = 0;
    let firstHit: { x: number; y: number } | null = null;
    for (const { mol, offsetX, offsetY } of placed) {
      for (const atom of mol.atoms) {
        if (atom.element !== el) continue;
        seen += 1;
        const pt = { x: offsetX + atom.x, y: offsetY + atom.y };
        if (firstHit == null) firstHit = pt;
        if (seen === ordinal) return pt;
      }
    }
    if (firstHit) return firstHit;
  }
  // Deterministic fallback: spread anchors across the scheme by arrow index so
  // every arrow is visibly drawn even without a geometry match.
  const frac = placed.length > 0 ? (index + (isSource ? 0.3 : 0.7)) / (placed.length + 1) : 0.4;
  const x = totalWidth * (0.25 + 0.4 * ((index % 3) / 3)) + (isSource ? -14 : 14);
  return { x: Math.max(20, Math.min(totalWidth - 20, x)), y: centerY + (isSource ? -4 : 4) + frac * 2 };
}

// ---------------------------------------------------------------------------
// §2.2 spatially-preserved mechanisms: snap, extract, render
// ---------------------------------------------------------------------------

/** Resolve an atom id or bond id to its anchor point (atom centre / bond midpoint). */
function anchorPoint(
  token: string,
  atoms: readonly SpatialAtom2D[],
  bonds: readonly SpatialBond2D[],
): { x: number; y: number } | null {
  const atom = atoms.find((a) => a.id === token);
  if (atom) return { x: atom.x, y: atom.y };
  const bond = bonds.find((b) => b.id === token);
  if (bond) {
    const a = atoms.find((x) => x.id === bond.fromAtomId);
    const b = atoms.find((x) => x.id === bond.toAtomId);
    if (a && b) return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
  return null;
}

/**
 * M17 (§2.2(1)) nearest-atom-or-bond snap. Candidates are every atom centre
 * and every bond midpoint; the tail takes the nearest candidate and the head
 * the nearest DISTINCT one. The signed curvature is the bulge of the arc
 * (through `ctrl`) perpendicular to tail→head, as a fraction of the chord.
 * `aspect` (box width / height) makes distances isotropic for non-square boxes.
 */
export function snapArrowEndpointsToMolGraph(
  rawArrow: RawCurlyArrow,
  atoms2D: readonly SpatialAtom2D[],
  bonds2D: readonly SpatialBond2D[],
  aspect = 1,
): ElectronFlowArrow {
  const cands: { id: string; x: number; y: number }[] = atoms2D.map((a) => ({ id: a.id, x: a.x, y: a.y }));
  for (const b of bonds2D) {
    const p = anchorPoint(b.id, atoms2D, bonds2D);
    if (p) cands.push({ id: b.id, x: p.x, y: p.y });
  }
  const nearest = (x: number, y: number, exclude?: string): string => {
    let best = "";
    let bestD = Infinity;
    for (const c of cands) {
      if (c.id === exclude) continue;
      const d = Math.hypot((c.x - x) * aspect, c.y - y);
      if (d < bestD) {
        bestD = d;
        best = c.id;
      }
    }
    return best;
  };
  const from = nearest(rawArrow.tailX, rawArrow.tailY);
  const to = nearest(rawArrow.headX, rawArrow.headY, from);

  const dx = (rawArrow.headX - rawArrow.tailX) * aspect;
  const dy = rawArrow.headY - rawArrow.tailY;
  const chord = Math.hypot(dx, dy);
  let curvature: number | undefined;
  if (rawArrow.ctrlX != null && rawArrow.ctrlY != null && chord > 1e-9) {
    const mx = (rawArrow.ctrlX - (rawArrow.tailX + rawArrow.headX) / 2) * aspect;
    const my = rawArrow.ctrlY - (rawArrow.tailY + rawArrow.headY) / 2;
    curvature = (mx * dy - my * dx) / (chord * chord);
  }
  const hasCubic =
    rawArrow.c1X != null && rawArrow.c1Y != null && rawArrow.c2X != null && rawArrow.c2Y != null;
  return {
    id: rawArrow.id ?? `a-${from}-${to}`,
    fromAtomOrBond: from,
    toAtomOrBond: to,
    barb: rawArrow.barb ?? "full",
    ...(curvature !== undefined ? { curvature } : {}),
    ...(hasCubic
      ? {
          geometry: [
            rawArrow.tailX, rawArrow.tailY, rawArrow.c1X!, rawArrow.c1Y!,
            rawArrow.c2X!, rawArrow.c2Y!, rawArrow.headX, rawArrow.headY,
          ] as const,
        }
      : {}),
  };
}

/** Input of {@link extractMechanismFromRegion}. */
export interface MechanismRegionInput {
  /** Pixels of the cropped figure: when given, the structure, labels and arrows are read from it. */
  readonly image?: RasterImage;
  readonly smiles?: string;
  readonly atoms2D?: readonly SpatialAtom2D[];
  readonly bonds2D?: readonly SpatialBond2D[];
  readonly rawArrows?: readonly RawCurlyArrow[];
  /** Text known to sit in the figure (PDF text layer / OCR), normalized to the box. */
  readonly ocrChars?: readonly FigureChar[];
  readonly conditionsAbove?: string;
  readonly conditionsBelow?: string;
}

/**
 * M17 (§2.2(2)) build a complete, spatially-preserved {@link ChemicalMechanismSpec}.
 *
 *  - With `image`: vectorise the figure (see `mechanismVision.ts`) — bonds and
 *    atoms keep their printed positions, curly arrows are detected and snapped,
 *    and all remaining ink is carried along.
 *  - With explicit `atoms2D`/`bonds2D`: use them as-is.
 *  - With only `smiles`: lay the scheme out once, deterministically.
 *
 * Every arrow (detected or passed in `rawArrows`) goes through
 * {@link snapArrowEndpointsToMolGraph}.
 */
export function extractMechanismFromRegion(input: MechanismRegionInput): ChemicalMechanismSpec {
  let atoms: readonly SpatialAtom2D[] = input.atoms2D ?? [];
  let bonds: readonly SpatialBond2D[] = input.bonds2D ?? [];
  let raw: readonly RawCurlyArrow[] = input.rawArrows ?? [];
  let smiles = input.smiles ?? "";
  let aspect: number | undefined;
  let reactionArrow: readonly [number, number, number, number] | undefined;
  let ink: readonly string[] | undefined;
  let inkSize: readonly [number, number] | undefined;

  if (input.image && !input.atoms2D) {
    const v = vectorizeMechanismImage(input.image, input.ocrChars ? { ocrChars: input.ocrChars } : {});
    atoms = v.atoms2D;
    bonds = v.bonds2D;
    raw = [...v.rawArrows, ...raw];
    aspect = v.aspect;
    ink = v.ink;
    inkSize = v.inkSize;
    if (smiles.length === 0) smiles = v.smiles;
  } else if (atoms.length === 0 && smiles.length > 0) {
    const laid = layoutSmilesGraph(smiles, input.ocrChars);
    atoms = laid.atoms2D;
    bonds = laid.bonds2D;
    aspect = laid.aspect;
    reactionArrow = laid.reactionArrow;
  } else if (smiles.length === 0 && atoms.length > 0) {
    smiles = smilesFromGraph(atoms, bonds);
  }

  const arrows = raw.map((r, i) =>
    snapArrowEndpointsToMolGraph(r.id != null ? r : { ...r, id: `a${i + 1}` }, atoms, bonds, aspect ?? 1),
  );
  return {
    smiles,
    atoms2D: atoms,
    bonds2D: bonds,
    arrows,
    ...(input.conditionsAbove != null ? { conditionsAbove: input.conditionsAbove } : {}),
    ...(input.conditionsBelow != null ? { conditionsBelow: input.conditionsBelow } : {}),
    ...(aspect !== undefined ? { aspect } : {}),
    ...(reactionArrow ? { reactionArrow } : {}),
    ...(ink && ink.length > 0 && inkSize ? { ink, inkSize } : {}),
  };
}

const LAYOUT_W = 420;
const LAYOUT_H = 180;

/**
 * Lay a (reaction) SMILES out ONCE into normalized 2D atoms/bonds so the layout
 * becomes data on the spec instead of being re-derived at every render. Any
 * `ocrChars` heteroatom positions override the generated position of the
 * matching element (first unused atom of that element, in order).
 */
function layoutSmilesGraph(
  smiles: string,
  ocrChars?: readonly FigureChar[],
): {
  atoms2D: SpatialAtom2D[];
  bonds2D: SpatialBond2D[];
  aspect: number;
  reactionArrow?: readonly [number, number, number, number];
} {
  const { reactants, products } = splitReactionSmiles(smiles);
  const bondLen = 34;
  const mols = [...reactants, ...products].map((s) => layoutMolecule(s, bondLen));
  const gap = 46;
  const arrowLen = products.length > 0 ? 70 : 0;
  const natural =
    mols.reduce((a, m) => a + m.width, 0) + gap * Math.max(0, mols.length - 1) + arrowLen + 56;
  const scale = Math.min(1, LAYOUT_W / natural);
  let cursor = 28;
  const atoms2D: SpatialAtom2D[] = [];
  const bonds2D: SpatialBond2D[] = [];
  let reactionArrow: readonly [number, number, number, number] | undefined;
  mols.forEach((mol, mi) => {
    if (products.length > 0 && mi === reactants.length) {
      const x1 = cursor - gap + 12;
      reactionArrow = [(x1 * scale) / LAYOUT_W, 0.5, ((x1 + arrowLen + gap - 24) * scale) / LAYOUT_W, 0.5];
      cursor += arrowLen;
    }
    const ids: string[] = [];
    mol.atoms.forEach((a) => {
      const id = `${a.element}${atoms2D.length + 1}`;
      ids.push(id);
      atoms2D.push({
        id,
        element: a.element,
        x: ((cursor + a.x) * scale) / LAYOUT_W,
        y: (LAYOUT_H / 2 - mol.height / 2 + a.y) / LAYOUT_H,
      });
    });
    for (const b of mol.bonds) {
      const order = (b.order >= 3 ? 3 : b.order === 2 ? 2 : 1) as 1 | 2 | 3;
      const sym = order === 2 ? "=" : order === 3 ? "#" : "-";
      bonds2D.push({ id: `${ids[b.a]}${sym}${ids[b.b]}`, fromAtomId: ids[b.a]!, toAtomId: ids[b.b]!, order });
    }
    cursor += mol.width + gap;
  });
  if (ocrChars && ocrChars.length > 0) {
    const used = new Set<number>();
    for (const ch of ocrChars) {
      const idx = atoms2D.findIndex((a, i) => !used.has(i) && a.element === ch.text);
      if (idx < 0) continue;
      used.add(idx);
      atoms2D[idx] = { ...atoms2D[idx]!, x: ch.x, y: ch.y };
    }
  }
  return { atoms2D, bonds2D, aspect: LAYOUT_W / LAYOUT_H, ...(reactionArrow ? { reactionArrow } : {}) };
}

/** Render label text with chemistry-style subscripts (digits) and superscript charges. */
function labelTspans(text: string, fontSize: number): string {
  const small = fmt(fontSize * 0.68);
  let out = "";
  let shift = 0;
  const parts = text.match(/[0-9]+|[+\-−–⁺⁻]+|[^0-9+\-−–⁺⁻]+/g) ?? [text];
  parts.forEach((part, i) => {
    const isDigit = /^[0-9]+$/.test(part) && i > 0;
    const isCharge = /^[+\-−–⁺⁻]+$/.test(part) && i > 0;
    const want = isDigit ? fontSize * 0.22 : isCharge ? -fontSize * 0.38 : 0;
    const dy = want - shift;
    shift = want;
    const size = isDigit || isCharge ? ` font-size="${small}"` : "";
    out += `<tspan dy="${fmt(dy)}"${size}>${escapeXml(part)}</tspan>`;
  });
  return out;
}

/**
 * Render a spec that carries its own 2D layout. Atom and arrow coordinates are
 * used exactly as stored (never re-laid-out), the box keeps the source aspect
 * ratio, and traced ink is replayed underneath.
 */
function renderSpatialMechanismSvg(spec: ChemicalMechanismSpec): string {
  const atoms = spec.atoms2D ?? [];
  const bonds = spec.bonds2D ?? [];
  const VW = LAYOUT_W;
  const VH = Math.max(40, Math.round(spec.aspect && spec.aspect > 0 ? VW / spec.aspect : LAYOUT_H));
  const X = (x: number): number => x * VW;
  const Y = (y: number): number => y * VH;
  const byId = new Map(atoms.map((a) => [a.id, a]));
  const parts: string[] = [];

  // Scale strokes / fonts to the drawing: a 30-atom scheme squeezed into the
  // same box must not get the line weight of a single molecule.
  const lens: number[] = [];
  for (const b of bonds) {
    const a = byId.get(b.fromAtomId);
    const c = byId.get(b.toAtomId);
    if (a && c) lens.push(Math.hypot(X(a.x) - X(c.x), Y(a.y) - Y(c.y)));
  }
  lens.sort((p, q) => p - q);
  const bondLen = lens.length > 0 ? lens[Math.floor(lens.length / 2)]! : 34;
  const sw = Math.max(0.5, Math.min(1.8, bondLen / 20));
  const ink = "#1a3a5a";

  if (spec.ink && spec.ink.length > 0 && spec.inkSize) {
    const sx = VW / spec.inkSize[0];
    const sy = VH / spec.inkSize[1];
    parts.push(
      `<g class="ito-traced-ink" transform="scale(${sx.toFixed(5)} ${sy.toFixed(5)})" fill="${ink}">` +
        spec.ink.map((d) => `<path d="${d}"/>`).join("") +
        `</g>`,
    );
  }

  /** Pull a bond end out of an atom's label box so lines never run through text. */
  const clip = (ax: number, ay: number, bx: number, by: number, atom: SpatialAtom2D): { x: number; y: number } => {
    const isLabelled = atom.labelBox != null || (atom.element !== "C" && atom.element !== "");
    if (!isLabelled) return { x: ax, y: ay };
    const pad = Math.max(1.5, bondLen * 0.1);
    const box = atom.labelBox
      ? { x0: X(atom.labelBox[0]) - pad, y0: Y(atom.labelBox[1]) - pad, x1: X(atom.labelBox[0] + atom.labelBox[2]) + pad, y1: Y(atom.labelBox[1] + atom.labelBox[3]) + pad }
      : { x0: ax - 5 * atom.element.length - 2, y0: ay - 8, x1: ax + 5 * atom.element.length + 2, y1: ay + 8 };
    const L = Math.hypot(bx - ax, by - ay) || 1;
    for (let t = 0; t <= 0.6 * L; t += 0.5) {
      const x = ax + ((bx - ax) * t) / L;
      const y = ay + ((by - ay) * t) / L;
      if (x < box.x0 || x > box.x1 || y < box.y0 || y > box.y1) return { x, y };
    }
    return { x: ax + (bx - ax) * 0.6, y: ay + (by - ay) * 0.6 };
  };

  for (const b of bonds) {
    const a = byId.get(b.fromAtomId);
    const c = byId.get(b.toAtomId);
    if (!a || !c) continue;
    const p = clip(X(a.x), Y(a.y), X(c.x), Y(c.y), a);
    const q = clip(X(c.x), Y(c.y), X(a.x), Y(a.y), c);
    const offset = Math.max(1.6, bondLen * 0.075);
    if (b.order === 2) {
      // Skeletal convention: when the neighbouring atoms lie mostly on one side
      // (a ring, a branch), the second line goes on that side, shortened; a
      // free-standing double bond is drawn symmetric.
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      let side = 0;
      for (const o of bonds) {
        if (o === b) continue;
        for (const [end, other] of [[o.fromAtomId, o.toAtomId], [o.toAtomId, o.fromAtomId]] as const) {
          if (end !== a.id && end !== c.id) continue;
          const n = byId.get(other);
          if (!n) continue;
          side += Math.sign(dx * (Y(n.y) - p.y) - dy * (X(n.x) - p.x));
        }
      }
      if (side !== 0) {
        const L = Math.hypot(dx, dy) || 1;
        const k = Math.sign(side) * offset * 2;
        const nx = (-dy / L) * k;
        const ny = (dx / L) * k;
        const sh = 0.12;
        parts.push(...bondLines(p.x, p.y, q.x, q.y, 1, false, sw, offset, b.id));
        parts.push(
          ...bondLines(p.x + nx + dx * sh, p.y + ny + dy * sh, q.x + nx - dx * sh, q.y + ny - dy * sh, 1, false, sw, offset, b.id),
        );
        continue;
      }
    }
    parts.push(...bondLines(p.x, p.y, q.x, q.y, b.order, false, sw, offset, b.id));
  }

  for (const a of atoms) {
    if (a.element === "?" || a.element === "") continue;
    if (a.labelBox) {
      const [bx, by, bw, bh] = a.labelBox;
      const hasSub = /[0-9]/.test(a.element.slice(1));
      const capH = Y(bh) / (hasSub ? 1.22 : 1);
      const fontSize = Math.max(4, capH / 0.72);
      const baseline = Y(by) + capH;
      parts.push(
        `<text class="ito-atom-label" data-atom-id="${escapeXml(a.id)}" x="${fmt(X(bx))}" y="${fmt(baseline)}" ` +
          `font-size="${fmt(fontSize)}" font-family="Helvetica, Arial, sans-serif" textLength="${fmt(X(bw))}" ` +
          `lengthAdjust="spacingAndGlyphs" fill="${ink}">${labelTspans(a.element, fontSize)}</text>`,
      );
    } else if (a.element !== "C") {
      const fontSize = Math.max(6, Math.min(14, bondLen * 0.42));
      parts.push(
        `<text class="ito-atom-label" data-atom-id="${escapeXml(a.id)}" x="${fmt(X(a.x))}" y="${fmt(Y(a.y))}" ` +
          `font-size="${fmt(fontSize)}" font-family="Helvetica, Arial, sans-serif" text-anchor="middle" ` +
          `dominant-baseline="central" fill="${ink}">${labelTspans(a.element, fontSize)}</text>`,
      );
    }
  }

  if (spec.reactionArrow) {
    const [x1, y1, x2, y2] = spec.reactionArrow;
    parts.push(
      `<line class="ito-reaction-arrow" x1="${fmt(X(x1))}" y1="${fmt(Y(y1))}" x2="${fmt(X(x2))}" y2="${fmt(Y(y2))}" ` +
        `stroke="${ink}" stroke-width="1.6" marker-end="url(#ito-reaction-head)"/>`,
    );
  }
  const capX = spec.reactionArrow ? X((spec.reactionArrow[0] + spec.reactionArrow[2]) / 2) : VW / 2;
  const capY = spec.reactionArrow ? Y(spec.reactionArrow[1]) : VH / 2;
  if (spec.conditionsAbove) {
    parts.push(
      `<text class="ito-conditions-above" x="${fmt(capX)}" y="${fmt(capY - 8)}" font-size="11" ` +
        `text-anchor="middle" fill="${ink}">${escapeXml(spec.conditionsAbove)}</text>`,
    );
  }
  if (spec.conditionsBelow) {
    parts.push(
      `<text class="ito-conditions-below" x="${fmt(capX)}" y="${fmt(capY + 18)}" font-size="11" ` +
        `text-anchor="middle" fill="${ink}">${escapeXml(spec.conditionsBelow)}</text>`,
    );
  }

  for (const arrow of spec.arrows) {
    let d: string | null = null;
    if (arrow.geometry) {
      const [tx, ty, c1x, c1y, c2x, c2y, hx, hy] = arrow.geometry;
      d = `M ${fmt(X(tx))} ${fmt(Y(ty))} C ${fmt(X(c1x))} ${fmt(Y(c1y))} ${fmt(X(c2x))} ${fmt(Y(c2y))} ${fmt(X(hx))} ${fmt(Y(hy))}`;
    } else {
      const from = anchorPoint(arrow.fromAtomOrBond, atoms, bonds);
      const to = anchorPoint(arrow.toAtomOrBond, atoms, bonds);
      if (from && to) {
        const fx = X(from.x), fy = Y(from.y), tx = X(to.x), ty = Y(to.y);
        const chord = Math.hypot(tx - fx, ty - fy) || 1;
        // Both control points sit h off the chord; the arc's bulge is 0.75·h.
        const h = ((arrow.curvature ?? 0.3) * chord) / 0.75;
        const nx = (ty - fy) / chord;
        const ny = -(tx - fx) / chord;
        const c1x = fx + (tx - fx) / 3 + nx * h, c1y = fy + (ty - fy) / 3 + ny * h;
        const c2x = fx + ((tx - fx) * 2) / 3 + nx * h, c2y = fy + ((ty - fy) * 2) / 3 + ny * h;
        // Stand the ends off the atoms so the arrow does not bury the label.
        const off = Math.min(6, chord * 0.12);
        const l1 = Math.hypot(c1x - fx, c1y - fy) || 1;
        const l2 = Math.hypot(c2x - tx, c2y - ty) || 1;
        const sx = fx + ((c1x - fx) / l1) * off, sy = fy + ((c1y - fy) / l1) * off;
        const ex = tx + ((c2x - tx) / l2) * off, ey = ty + ((c2y - ty) / l2) * off;
        d = `M ${fmt(sx)} ${fmt(sy)} C ${fmt(c1x)} ${fmt(c1y)} ${fmt(c2x)} ${fmt(c2y)} ${fmt(ex)} ${fmt(ey)}`;
      }
    }
    if (!d) continue;
    const fish = arrow.barb === "fishhook";
    parts.push(
      `<path class="ito-curly-arrow" data-arrow-id="${escapeXml(arrow.id)}" ` +
        `data-from="${escapeXml(arrow.fromAtomOrBond)}" data-to="${escapeXml(arrow.toAtomOrBond)}" ` +
        `data-barb="${arrow.barb}" d="${d}" fill="none" stroke="${fish ? "#2e6fb2" : "#b2402e"}" ` +
        `stroke-width="${fmt(Math.max(0.8, sw))}" stroke-linecap="round" ` +
        `marker-end="${fish ? "url(#ito-fishhook-barb)" : "url(#ito-full-barb)"}"/>`,
    );
  }

  // Heads are sized against the drawing (not the stroke) so they stay in
  // proportion to the bonds, as in print.
  const hs = fmt(Math.max(3, Math.min(9, bondLen * 0.24)));
  const mk = `markerUnits="userSpaceOnUse" markerWidth="${hs}" markerHeight="${hs}" orient="auto-start-reverse"`;
  const defs =
    `<defs>` +
    `<marker id="ito-full-barb" viewBox="0 0 10 10" refX="9" refY="5" ${mk}>` +
    `<path d="M 0 1 L 10 5 L 0 9 L 2.5 5 z" fill="#b2402e"/></marker>` +
    `<marker id="ito-fishhook-barb" viewBox="0 0 10 10" refX="9" refY="5" ${mk}>` +
    `<path d="M 0 1 L 10 5 L 2.5 5 z" fill="#2e6fb2"/></marker>` +
    `<marker id="ito-reaction-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">` +
    `<path d="M 0 1 L 9 5 L 0 9" fill="none" stroke="${ink}" stroke-width="1.4"/></marker>` +
    `</defs>`;

  return (
    `<svg xmlns="${SVG_NS}" data-testid="chem-mechanism-svg" width="${VW}" height="${VH}" ` +
    `viewBox="0 0 ${VW} ${VH}" class="ito-chem-mechanism" data-spatial="true" ` +
    `data-smiles="${escapeXml(spec.smiles)}">` +
    defs +
    parts.join("") +
    `</svg>`
  );
}

/**
 * Text the PDF itself carries inside a figure crop (labels such as "OH", "Br"),
 * taken from a page's cached spans and re-expressed in the crop's own 0..1
 * coordinates, ready to pass as `ocrChars`. Spans wider than half the crop are
 * body text / captions, not atom labels, and are skipped.
 */
export function figureCharsFromSpans(
  spans: readonly { readonly str: string; readonly normRect: readonly [number, number, number, number] }[],
  rect: NormalizedRect,
): FigureChar[] {
  const out: FigureChar[] = [];
  if (rect.width <= 0 || rect.height <= 0) return out;
  for (const span of spans) {
    const text = span.str.trim();
    if (text.length === 0) continue;
    const [sx, sy, sw, sh] = span.normRect;
    const cx = sx + sw / 2;
    const cy = sy + sh / 2;
    if (cx < rect.x || cx > rect.x + rect.width || cy < rect.y || cy > rect.y + rect.height) continue;
    if (sw > 0.5 * rect.width) continue;
    out.push({
      text,
      x: (cx - rect.x) / rect.width,
      y: (cy - rect.y) / rect.height,
      w: sw / rect.width,
      h: sh / rect.height,
    });
  }
  return out;
}

/** Decode an image URL in the browser; resolves null where that is impossible (jsdom). */
function loadImageElement(url: string, timeoutMs = 4000): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    if (typeof Image === "undefined") {
      resolve(null);
      return;
    }
    const img = new Image();
    const timer = setTimeout(() => resolve(null), timeoutMs);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    img.src = url;
  });
}

/** A 2d canvas context, or null where there is no canvas backend (jsdom). */
function canvas2d(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  if (typeof document === "undefined") return null;
  if (typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent ?? "")) return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    return ctx ? { canvas, ctx } : null;
  } catch {
    return null;
  }
}

/**
 * Decode a figure crop (the area annotation's PNG data URL) to pixels for
 * {@link extractMechanismFromRegion}. Small crops are upsampled so hairline
 * strokes are a few pixels wide before thinning. Browser-only; null in jsdom.
 */
export async function loadRasterFromDataUrl(url: string): Promise<RasterImage | null> {
  if (!url.startsWith("data:image/png") && !url.startsWith("data:image/jpeg")) return null;
  const img = await loadImageElement(url);
  if (!img || img.naturalWidth <= 0 || img.naturalHeight <= 0) return null;
  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  const scale = Math.max(1, Math.min(3, 1200 / longest));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const c = canvas2d(w, h);
  if (!c) return null;
  c.ctx.fillStyle = "#fff";
  c.ctx.fillRect(0, 0, w, h);
  c.ctx.imageSmoothingEnabled = true;
  c.ctx.imageSmoothingQuality = "high";
  c.ctx.drawImage(img, 0, 0, w, h);
  const data = c.ctx.getImageData(0, 0, w, h);
  return { data: data.data, width: w, height: h };
}

/**
 * Rasterise mechanism SVG markup to a PNG. Word does not render inline `<svg>`
 * from pasted HTML, so the Word-facing clipboard flavours are a PNG (bitmap +
 * an `<img>` in the HTML). Browser-only; null in jsdom.
 */
async function rasterizeSvgToPng(svg: string, scale = 3): Promise<{ blob: Blob; dataUrl: string; width: number; height: number } | null> {
  const m = svg.match(/viewBox="0 0 ([0-9.]+) ([0-9.]+)"/);
  const vw = m ? parseFloat(m[1]!) : 420;
  const vh = m ? parseFloat(m[2]!) : 180;
  const c = canvas2d(Math.round(vw * scale), Math.round(vh * scale));
  if (!c) return null;
  const img = await loadImageElement(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  if (!img) return null;
  c.ctx.fillStyle = "#fff";
  c.ctx.fillRect(0, 0, c.canvas.width, c.canvas.height);
  c.ctx.drawImage(img, 0, 0, c.canvas.width, c.canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => c.canvas.toBlob((b) => resolve(b), "image/png"));
  if (!blob) return null;
  return { blob, dataUrl: c.canvas.toDataURL("image/png"), width: vw, height: vh };
}

// ---------------------------------------------------------------------------
// §2.2(4) multi-MIME clipboard payload builder
// ---------------------------------------------------------------------------

/** The result of building a science clipboard payload (returned for tests). */
export interface ScienceClipboardPayload {
  readonly plainText: string;
  readonly htmlText: string;
  readonly svgText?: string;
}

/**
 * M17 (§2.2(4)) build the multi-MIME clipboard payload for a math equation or a
 * chemical mechanism and write it to the browser clipboard when available:
 *
 *  - math: `text/plain` = raw LaTeX, `text/html` = `<math>` MathML.
 *  - chem: `text/plain` = SMILES, `text/html` = inline `<svg>` + a SMILES
 *    caption, and `svgText` = the standalone SVG markup.
 *
 * Writes via `navigator.clipboard.write([new ClipboardItem(...)])` when that API
 * exists, falling back to `navigator.clipboard.writeText`. In unit tests (no
 * clipboard) it simply returns the built payload so assertions can inspect it.
 */
export async function copyScienceToWordClipboard(
  payload: { kind: "math"; latex: string } | { kind: "chem"; spec: ChemicalMechanismSpec },
): Promise<ScienceClipboardPayload> {
  let built: ScienceClipboardPayload;
  if (payload.kind === "math") {
    const mathml = convertLatexToMathML(payload.latex);
    built = { plainText: payload.latex, htmlText: mathml };
  } else {
    const svg = renderMechanismSvg(payload.spec);
    const caption = `<div class="ito-smiles-caption">${escapeXml(payload.spec.smiles)}</div>`;
    built = { plainText: payload.spec.smiles, htmlText: `${svg}${caption}`, svgText: svg };
  }

  await writeToClipboard(built);
  return built;
}

/** Best-effort clipboard write; never throws (returns silently on failure). */
async function writeToClipboard(payload: ScienceClipboardPayload): Promise<void> {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  const clip = nav?.clipboard as
    | (Clipboard & { write?: (items: ClipboardItem[]) => Promise<void> })
    | undefined;
  if (!clip) return;
  try {
    const ClipboardItemCtor =
      typeof ClipboardItem !== "undefined" ? ClipboardItem : undefined;
    if (clip.write && ClipboardItemCtor && typeof Blob !== "undefined") {
      let html = payload.htmlText;
      const items: Record<string, Blob> = {
        "text/plain": new Blob([payload.plainText], { type: "text/plain" }),
      };
      if (payload.svgText) {
        const png = await rasterizeSvgToPng(payload.svgText);
        if (png) {
          items["image/png"] = png.blob;
          html =
            `<img src="${png.dataUrl}" width="${Math.round(png.width)}" height="${Math.round(png.height)}" ` +
            `alt="${escapeXml(payload.plainText)}"/>`;
        }
      }
      items["text/html"] = new Blob([html], { type: "text/html" });
      await clip.write([new ClipboardItemCtor(items)]);
      return;
    }
    if (typeof clip.writeText === "function") {
      await clip.writeText(payload.plainText);
    }
  } catch {
    // Clipboard denied / unavailable — swallow; the payload is still returned.
  }
}
