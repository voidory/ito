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

import type { ChemicalMechanismSpec, ElectronFlowArrow, NormalizedRect } from "../model";

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

/**
 * M17 (§2.2(1)) reconstruct clean LaTeX from the `.textLayer` spans that
 * intersect `normRect` on `pageStageEl`. Unicode math symbols/Greek letters are
 * mapped to LaTeX commands, `a/b` fractions become `\frac{a}{b}`, `√x` becomes
 * `\sqrt{x}`, and `^`/`_` runs are wrapped in braces. When no stage/spans are
 * available (jsdom, or a crop over an image region) the `hintText` is
 * normalized the same way, so a caller can always pass extracted OCR text.
 */
export function extractLatexFromRegion(
  pageStageEl: HTMLElement | null,
  normRect: NormalizedRect,
  hintText?: string,
): string {
  const collected = collectRegionText(pageStageEl, normRect);
  const raw = collected.length > 0 ? collected : (hintText ?? "");
  return normalizeToLatex(raw);
}

/** Lift text from the spans intersecting a normalized crop rect, in order. */
function collectRegionText(pageStageEl: HTMLElement | null, normRect: NormalizedRect): string {
  if (!pageStageEl) return "";
  const textLayer = pageStageEl.querySelector<HTMLElement>(".textLayer");
  if (!textLayer) return "";
  const stageBox = pageStageEl.getBoundingClientRect();
  const spans = Array.from(textLayer.querySelectorAll<HTMLElement>("span"));
  const picked: { x: number; y: number; text: string }[] = [];
  for (const span of spans) {
    const geo = spanNormGeometry(span, stageBox);
    if (!geo) continue;
    if (rectsIntersect(geo, normRect)) {
      const text = span.textContent ?? "";
      if (text.length > 0) picked.push({ x: geo.x, y: geo.y, text });
    }
  }
  // Reading order: top-to-bottom then left-to-right.
  picked.sort((a, b) => (Math.abs(a.y - b.y) > 0.01 ? a.y - b.y : a.x - b.x));
  return picked.map((p) => p.text).join(" ").replace(/\s+/g, " ").trim();
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

function rectsIntersect(a: NormalizedRect, b: NormalizedRect): boolean {
  return !(
    a.x > b.x + b.width ||
    a.x + a.width < b.x ||
    a.y > b.y + b.height ||
    a.y + a.height < b.y
  );
}

/**
 * Normalize an arbitrary math string into valid LaTeX: map Unicode Greek +
 * operator glyphs, turn `√x` / `√(expr)` into `\sqrt{...}`, turn simple `a/b`
 * into `\frac{a}{b}`, and brace multi-char super/subscript runs.
 */
function normalizeToLatex(input: string): string {
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
  const { nodes } = parseSequence(tokens, 0, false);
  const body = nodes.length > 0 ? nodes.join("") : "<mrow></mrow>";
  return `<math xmlns="${MATHML_NS}" display="block"><mrow>${body}</mrow></math>`;
}

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
        // An escaped symbol like \{ — treat the next char as a symbol.
        out.push({ kind: "sym", value: src[j]! });
        i = j + 1;
        continue;
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
  if (BIG_OPS[name]) {
    return { node: `<mo>${BIG_OPS[name]}</mo>`, next: i };
  }
  if (NAMED_OPS[name]) {
    return { node: `<mo>${NAMED_OPS[name]}</mo>`, next: i };
  }
  if (GREEK_NAMES.has(name) && GREEK_CHAR[name]) {
    return { node: `<mi>${GREEK_CHAR[name]}</mi>`, next: i };
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
}

/** A laid-out bond between two atoms (1=single, 2=double, 3=triple). */
interface LaidBond {
  readonly a: number;
  readonly b: number;
  readonly order: number;
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
      parts.push(...bondLines(x1, y1, x2, y2, bond.order));
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
  parsed.atoms.forEach((el, index) => {
    const x = index * stepX;
    const y = index % 2 === 0 ? amp : 0;
    atoms.push({ index, element: el, x, y, isHetero: HETERO.has(el) });
  });
  if (atoms.length === 0) {
    // An unparseable / empty fragment still gets one carbon vertex so the side
    // renders a dot rather than nothing.
    atoms.push({ index: 0, element: "C", x: 0, y: amp, isHetero: false });
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

/** A minimal SMILES parse: atom element list + bonds (order + ring closures). */
function parseSmiles(smiles: string): { atoms: string[]; bonds: LaidBond[] } {
  const atoms: string[] = [];
  const bonds: LaidBond[] = [];
  const ringOpen = new Map<string, number>();
  const branchStack: number[] = [];
  let prev = -1;
  let pendingOrder = 1;
  let i = 0;
  const s = smiles ?? "";
  const pushBond = (a: number, b: number, order: number): void => {
    if (a >= 0 && b >= 0 && a !== b) bonds.push({ a, b, order });
  };
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === "(") {
      branchStack.push(prev);
      i++;
      continue;
    }
    if (ch === ")") {
      prev = branchStack.pop() ?? prev;
      i++;
      continue;
    }
    if (ch === "-" || ch === "=" || ch === "#") {
      pendingOrder = ch === "=" ? 2 : ch === "#" ? 3 : 1;
      i++;
      continue;
    }
    if (ch === "." ) {
      prev = -1;
      i++;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      // Ring closure digit.
      if (ringOpen.has(ch)) {
        const other = ringOpen.get(ch)!;
        pushBond(prev, other, pendingOrder);
        ringOpen.delete(ch);
      } else if (prev >= 0) {
        ringOpen.set(ch, prev);
      }
      pendingOrder = 1;
      i++;
      continue;
    }
    if (ch === "[") {
      // Bracket atom: read until ']'.
      const close = s.indexOf("]", i);
      const inner = close > i ? s.slice(i + 1, close) : s.slice(i + 1);
      const el = parseBracketElement(inner);
      const idx = atoms.length;
      atoms.push(el);
      if (prev >= 0) pushBond(prev, idx, pendingOrder);
      prev = idx;
      pendingOrder = 1;
      i = close > i ? close + 1 : s.length;
      continue;
    }
    const el = readOrganicElement(s, i);
    if (el) {
      const idx = atoms.length;
      atoms.push(el.symbol);
      if (prev >= 0) pushBond(prev, idx, pendingOrder);
      prev = idx;
      pendingOrder = 1;
      i += el.length;
      continue;
    }
    i++;
  }
  return { atoms, bonds };
}

/** Read an organic-subset element (Cl/Br are two-letter; aromatic lowercased). */
function readOrganicElement(s: string, i: number): { symbol: string; length: number } | null {
  const two = s.slice(i, i + 2);
  if (two === "Cl" || two === "Br") return { symbol: two, length: 2 };
  const ch = s[i]!;
  if (/[A-Z]/.test(ch)) return { symbol: ch, length: 1 };
  if (/[cnosp]/.test(ch)) return { symbol: ch.toUpperCase(), length: 1 };
  return null;
}

/** Extract the element symbol from a bracket-atom body like "OH-" or "NH4+". */
function parseBracketElement(inner: string): string {
  const m = inner.match(/^([A-Z][a-z]?)/);
  return m ? m[1]! : "C";
}

/** Render a bond as one (or two/three parallel) crisp skeletal line(s). */
function bondLines(x1: number, y1: number, x2: number, y2: number, order: number): string[] {
  const line = (a: number, b: number, c: number, d: number): string =>
    `<line class="ito-bond" x1="${fmt(a)}" y1="${fmt(b)}" x2="${fmt(c)}" y2="${fmt(d)}" ` +
    `stroke="#1a3a5a" stroke-width="1.6" stroke-linecap="round"/>`;
  if (order <= 1) return [line(x1, y1, x2, y2)];
  // Offset perpendicular to the bond for double/triple parallel lines.
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const ox = (-dy / len) * 2.6;
  const oy = (dx / len) * 2.6;
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
      const items: Record<string, Blob> = {
        "text/plain": new Blob([payload.plainText], { type: "text/plain" }),
        "text/html": new Blob([payload.htmlText], { type: "text/html" }),
      };
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
