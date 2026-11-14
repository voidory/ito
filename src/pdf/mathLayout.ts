/**
 * Geometry-aware reconstruction of LaTeX from the glyphs inside a box selection.
 *
 * A PDF text layer carries no math structure: `x²` is an "x" and a smaller "2"
 * set higher, a fraction is two runs of text with a drawn rule between them.
 * Reading the selected text in order therefore loses exactly what makes it an
 * equation. This module rebuilds that structure from where each glyph sits:
 *
 *   glyph boxes (+ horizontal rules found in the crop's pixels)
 *     -> fractions / radicals / overlines   (a rule with glyphs stacked on it)
 *     -> lines                              (clusters of full-size baselines)
 *     -> super/subscripts and limits        (smaller glyphs off the baseline)
 *     -> LaTeX
 *
 * Everything here is PURE and DOM-free: callers hand in glyph geometry in any
 * consistent unit with y growing downwards (`scienceOcr.ts` lifts it from the
 * live text layer). The output is a best-effort draft that the user verifies in
 * the editor, so every heuristic degrades to "emit the glyphs in reading order"
 * rather than dropping text.
 */

/** One glyph of the selection: its horizontal extent, baseline and font size. */
export interface MathGlyph {
  readonly ch: string;
  readonly x0: number;
  readonly x1: number;
  /** y of the text baseline (y grows downwards). */
  readonly base: number;
  /** Font size (em height) in the same unit as the coordinates. */
  readonly size: number;
  /**
   * Exact identity, when the glyph's font slot is known (`texGlyphs.ts`): the
   * LaTeX it is, its class (`ord`, `bin`, `rel`, `op`, `int`, `open`, `close`,
   * `fence`, `punct`, `accent`, `radical`) and its font style (`rm`, `bf`,
   * `bm`, `it`, `sf`, `tt`, `cal`, `bb`, `frak`). With `tex` set, `ch` is not
   * interpreted and none of the character heuristics below apply to the glyph.
   */
  readonly tex?: string;
  readonly cls?: string;
  readonly style?: string;
  /** Ink extent (y grows downwards), when known. */
  readonly top?: number;
  readonly bottom?: number;
}

/** A thin horizontal rule (fraction bar / radical vinculum) in glyph units. */
export interface MathRule {
  readonly x0: number;
  readonly x1: number;
  readonly y: number;
  readonly thickness?: number;
}

// ---------------------------------------------------------------------------
// Character tables
// ---------------------------------------------------------------------------

/** Unicode math glyph -> LaTeX command (beyond the Greek alphabet). */
export const MATH_SYMBOL_TO_LATEX: Readonly<Record<string, string>> = {
  "∫": "\\int", "∑": "\\sum", "∏": "\\prod", "∮": "\\oint", "√": "\\sqrt{}",
  "⋃": "\\bigcup", "⋂": "\\bigcap",
  "±": "\\pm", "∓": "\\mp", "×": "\\times", "÷": "\\div", "·": "\\cdot", "⋅": "\\cdot",
  "∗": "*", "∘": "\\circ", "⊕": "\\oplus", "⊗": "\\otimes",
  "≤": "\\leq", "≥": "\\geq", "≠": "\\neq", "≈": "\\approx", "≡": "\\equiv",
  "∝": "\\propto", "∼": "\\sim", "≃": "\\simeq", "≅": "\\cong", "≪": "\\ll", "≫": "\\gg",
  "∞": "\\infty", "∂": "\\partial", "∇": "\\nabla", "ℏ": "\\hbar", "ℓ": "\\ell",
  "→": "\\to", "←": "\\leftarrow", "↔": "\\leftrightarrow", "↦": "\\mapsto",
  "⇒": "\\Rightarrow", "⇐": "\\Leftarrow", "⇔": "\\Leftrightarrow",
  "∈": "\\in", "∉": "\\notin", "∪": "\\cup", "∩": "\\cap", "∅": "\\emptyset",
  "⊂": "\\subset", "⊃": "\\supset", "⊆": "\\subseteq", "⊇": "\\supseteq",
  "∀": "\\forall", "∃": "\\exists", "¬": "\\neg", "∧": "\\wedge", "∨": "\\vee",
  "⟨": "\\langle", "⟩": "\\rangle", "〈": "\\langle", "〉": "\\rangle",
  "∥": "\\parallel", "⊥": "\\perp", "∠": "\\angle",
  "…": "\\dots", "⋯": "\\cdots", "′": "\\prime", "″": "\\prime\\prime",
  "ℝ": "\\mathbb{R}", "ℂ": "\\mathbb{C}", "ℕ": "\\mathbb{N}", "ℤ": "\\mathbb{Z}", "ℚ": "\\mathbb{Q}",
  "−": "-", "–": "-", "—": "-", "‐": "-",
  "∆": "\\Delta", "µ": "\\mu", "ϵ": "\\epsilon", "ϕ": "\\phi", "ϑ": "\\vartheta",
  "ϖ": "\\varpi", "ϱ": "\\varrho",
  "%": "\\%", "#": "\\#", "&": "\\&", "$": "\\$", "{": "\\{", "}": "\\}",
};

const GREEK: Readonly<Record<string, string>> = {
  α: "\\alpha", β: "\\beta", γ: "\\gamma", δ: "\\delta", ε: "\\varepsilon",
  ζ: "\\zeta", η: "\\eta", θ: "\\theta", ι: "\\iota", κ: "\\kappa",
  λ: "\\lambda", μ: "\\mu", ν: "\\nu", ξ: "\\xi", ο: "o", π: "\\pi",
  ρ: "\\rho", σ: "\\sigma", ς: "\\varsigma", τ: "\\tau", υ: "\\upsilon", φ: "\\phi",
  χ: "\\chi", ψ: "\\psi", ω: "\\omega",
  Γ: "\\Gamma", Δ: "\\Delta", Θ: "\\Theta", Λ: "\\Lambda", Ξ: "\\Xi",
  Π: "\\Pi", Σ: "\\Sigma", Φ: "\\Phi", Ψ: "\\Psi", Ω: "\\Omega",
};

const SUPERSCRIPT_CHARS: Readonly<Record<string, string>> = {
  "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7",
  "⁸": "8", "⁹": "9", "⁺": "+", "⁻": "-", "⁼": "=", "⁽": "(", "⁾": ")", "ⁿ": "n", "ⁱ": "i",
};
const SUBSCRIPT_CHARS: Readonly<Record<string, string>> = {
  "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4", "₅": "5", "₆": "6", "₇": "7",
  "₈": "8", "₉": "9", "₊": "+", "₋": "-", "₌": "=", "₍": "(", "₎": ")",
  "ₐ": "a", "ₑ": "e", "ₒ": "o", "ₓ": "x", "ᵢ": "i", "ⱼ": "j", "ₖ": "k", "ₙ": "n", "ₘ": "m",
};

/** Named operators typeset upright; emitted as `\name`. */
const FUNCTIONS = new Set([
  "sin", "cos", "tan", "cot", "sec", "csc", "sinh", "cosh", "tanh", "arcsin", "arccos",
  "arctan", "log", "ln", "exp", "lim", "max", "min", "sup", "inf", "det", "dim", "ker",
  "arg", "deg", "gcd", "mod", "coth", "lg", "hom", "Pr",
]);
/** Short prose words that only count as text next to another text word. */
const STOPWORDS = new Set([
  "the", "and", "for", "is", "of", "in", "to", "if", "or", "at", "on", "as", "by", "we",
  "an", "be", "so", "are", "let", "all", "any", "not", "a",
]);

/** Operators whose scripts sit above/below them (display limits). */
const LIMIT_OPS = new Set(["∑", "∏", "⋃", "⋂"]);
const LIMIT_WORDS = new Set(["\\lim", "\\max", "\\min", "\\sup", "\\inf", "\\liminf", "\\limsup", "\\det", "\\gcd", "\\Pr"]);
/**
 * Glyphs drawn from extensible/operator fonts, whose reported baseline is not
 * the text baseline (a display `∑` hangs from its origin). They always sit on
 * the line, whatever their baseline says.
 */
const ANCHOR_CHARS = new Set(["∑", "∏", "∫", "∮", "⋃", "⋂", "√", "(", ")", "[", "]", "{", "}", "|", "⟨", "⟩"]);
/** Glyphs that ARE a horizontal bar, so a rule found on them is not a rule. */
const BAR_CHARS = new Set(["-", "−", "–", "—", "‐", "=", "≡", "≠", "≤", "≥", "±", "∓", "÷", "_", "¯", "‾", "≈", "≃", "≅", "→", "←", "↔", "⇒", "⇔", "⇐", "↦", "+", "∼", "~"]);

// ---------------------------------------------------------------------------
// Boxes
// ---------------------------------------------------------------------------

type BoxKind = "glyph" | "frac" | "sqrt" | "over" | "word" | "text" | "grid";

interface Box {
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  base: number;
  size: number;
  tex: string;
  kind: BoxKind;
  /** The source character for `glyph` boxes. */
  ch?: string;
  /** Identity came from the font slot: no character heuristics apply. */
  exact?: boolean;
  cls?: string;
  /** Font style still to be applied to `tex` (see {@link styled}). */
  style?: string;
}

interface Line {
  boxes: Box[];
  large: Set<Box>;
  base: number;
  size: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function cx(b: { x0: number; x1: number }): number {
  return (b.x0 + b.x1) / 2;
}

function isAnchor(b: Box): boolean {
  // An exact glyph already carries the baseline of the line it is centred on.
  return b.kind === "glyph" && !b.exact && b.ch != null && ANCHOR_CHARS.has(b.ch);
}

/**
 * Exact delimiters and big operators. Their size says nothing about the line
 * they are on: `\left\{` around script-size content is still a full-size
 * glyph, so they neither set a line's size nor count as scripts when larger.
 */
function isTall(b: Box): boolean {
  return b.kind === "glyph" && b.exact === true && b.cls != null && TALL_CLASSES.has(b.cls);
}
const TALL_CLASSES = new Set(["open", "close", "fence", "op", "int"]);

const STYLE_COMMANDS: Readonly<Record<string, string>> = {
  rm: "\\mathrm", bf: "\\mathbf", bm: "\\boldsymbol", it: "\\mathit", sf: "\\mathsf",
  tt: "\\mathtt", cal: "\\mathcal", bb: "\\mathbb", frak: "\\mathfrak",
};

/** A box's LaTeX with its pending font style applied. */
function styled(b: Box): string {
  const cmd = b.style ? STYLE_COMMANDS[b.style] : undefined;
  return cmd ? `${cmd}{${b.tex}}` : b.tex;
}

function charToTex(ch: string): string {
  return GREEK[ch] ?? MATH_SYMBOL_TO_LATEX[ch] ?? (ch === "°" ? "^{\\circ}" : ch);
}

function glyphBox(ch: string, x0: number, x1: number, base: number, size: number): Box {
  return {
    x0,
    x1: Math.max(x1, x0),
    top: base - 0.8 * size,
    bottom: base + 0.2 * size,
    base,
    size,
    tex: charToTex(ch),
    kind: "glyph",
    ch,
  };
}

/** Expand raw glyphs into boxes: drop spaces, split ligatures, lift ²/₂ runs. */
function toBoxes(glyphs: readonly MathGlyph[]): Box[] {
  const out: Box[] = [];
  for (const g of glyphs) {
    if (!(g.size > 0) || !Number.isFinite(g.x0 + g.x1 + g.base)) continue;
    const sup = SUPERSCRIPT_CHARS[g.ch];
    const sub = SUBSCRIPT_CHARS[g.ch];
    if (sup != null) {
      out.push(glyphBox(sup, g.x0, g.x1, g.base - 0.4 * g.size, 0.7 * g.size));
      continue;
    }
    if (sub != null) {
      out.push(glyphBox(sub, g.x0, g.x1, g.base + 0.2 * g.size, 0.7 * g.size));
      continue;
    }
    if (g.tex != null) {
      out.push({
        x0: g.x0,
        x1: Math.max(g.x1, g.x0),
        top: g.top ?? g.base - 0.8 * g.size,
        bottom: g.bottom ?? g.base + 0.2 * g.size,
        base: g.base,
        size: g.size,
        tex: g.tex,
        kind: "glyph",
        ch: g.tex,
        exact: true,
        cls: g.cls ?? "ord",
        ...(g.style ? { style: g.style } : {}),
      });
      continue;
    }
    // Keep symbols we map explicitly; fold everything else (math italics,
    // ligatures, fullwidth forms) to its plain compatibility form.
    const known = GREEK[g.ch] != null || MATH_SYMBOL_TO_LATEX[g.ch] != null;
    const chars = Array.from(known ? g.ch : g.ch.normalize("NFKC")).filter((c) => c.trim().length > 0);
    if (chars.length === 0) continue;
    const w = (g.x1 - g.x0) / chars.length;
    chars.forEach((c, i) => out.push(glyphBox(c, g.x0 + i * w, g.x0 + (i + 1) * w, g.base, g.size)));
  }
  return out;
}

function bbox(boxes: readonly Box[]): { x0: number; x1: number; top: number; bottom: number } {
  let x0 = Infinity, x1 = -Infinity, top = Infinity, bottom = -Infinity;
  for (const b of boxes) {
    if (b.x0 < x0) x0 = b.x0;
    if (b.x1 > x1) x1 = b.x1;
    if (b.top < top) top = b.top;
    if (b.bottom > bottom) bottom = b.bottom;
  }
  return { x0, x1, top, bottom };
}

// ---------------------------------------------------------------------------
// Rules -> fractions, radicals, overlines
// ---------------------------------------------------------------------------

/**
 * Boxes stacked contiguously away from a rule (up: dir = -1, down: dir = +1).
 * `bridges` are the heights of other rules in the same column: a fraction
 * inside a numerator leaves a gap at its own bar that is not a break.
 */
function chainFrom(cands: Box[], y: number, dir: -1 | 1, bridges: readonly number[] = []): Box[] {
  const out: Box[] = [];
  if (cands.length === 0) return out;
  const s = Math.max(...cands.map((b) => b.size));
  // Exact boxes end at their ink, and TeX keeps a numerator's baseline (not
  // its ink) a fixed distance from the bar; boxes from characters are padded.
  const reach = (b: Box | null): number => (b == null || b.exact ? 0.7 : 0.35) * s;
  type Item = { top: number; bottom: number; box: Box | null };
  const items: Item[] = [
    ...cands.map((b) => ({ top: b.top, bottom: b.bottom, box: b })),
    ...bridges.filter((r) => (dir < 0 ? r < y : r > y)).map((r) => ({ top: r, bottom: r, box: null })),
  ];
  let edge = y;
  if (dir < 0) {
    for (const it of items.sort((a, c) => c.bottom - a.bottom)) {
      if (edge - it.bottom > reach(it.box)) break;
      if (it.box) out.push(it.box);
      edge = Math.min(edge, it.top);
    }
  } else {
    for (const it of items.sort((a, c) => a.top - c.top)) {
      if (it.top - edge > reach(it.box)) break;
      if (it.box) out.push(it.box);
      edge = Math.max(edge, it.bottom);
    }
  }
  return out;
}

/**
 * A numerator/denominator is bounded by its bar. If glyphs on the same baseline
 * continue past the rule's ends, the rule is an underline or a table rule
 * running under a line of text, not a fraction bar.
 */
function boundedByRule(set: Box[], all: Box[], rule: MathRule, s: number): boolean {
  const inSet = new Set(set);
  for (const x of all) {
    if (inSet.has(x)) continue;
    const c = cx(x);
    if (c >= rule.x0 - 0.15 * s && c <= rule.x1 + 0.15 * s) continue;
    for (const b of set) {
      const gap = Math.max(0, x.x0 - b.x1, b.x0 - x.x1);
      if (Math.abs(x.base - b.base) < 0.15 * s && gap < 0.6 * s) return false;
    }
  }
  return true;
}

function applyRules(input: Box[], rules: readonly MathRule[]): Box[] {
  let boxes = input;
  let pending = [...rules].sort((a, b) => b.x1 - b.x0 - (a.x1 - a.x0));
  while (pending.length > 0 && boxes.length > 0) {
    const rule = pending.shift()!;
    const s = median(boxes.map((b) => b.size));
    // A rule from the PDF spans exactly what it belongs to; one found in
    // pixels may be a little short.
    const slack = (b: Box): number => (b.exact ? 0.02 : 0.15) * s;
    const cands = boxes.filter((b) => {
      const c = cx(b);
      return c >= rule.x0 - slack(b) && c <= rule.x1 + slack(b);
    });
    const mid = (b: Box): number =>
      b.kind === "glyph" && !b.exact ? b.base - 0.3 * b.size : (b.top + b.bottom) / 2;
    const bridges = pending
      .filter((r) => (r.x0 + r.x1) / 2 >= rule.x0 && (r.x0 + r.x1) / 2 <= rule.x1)
      .map((r) => r.y);
    const above = chainFrom(cands.filter((b) => mid(b) < rule.y), rule.y, -1, bridges);
    const isSurd = (b: Box): boolean => b.kind === "glyph" && (b.exact ? b.cls === "radical" : b.ch === "√");
    let below = chainFrom(cands.filter((b) => mid(b) >= rule.y), rule.y, 1, bridges);
    // A radical sign from the PDF ends exactly where its rule starts, and
    // everything under the rule down to the sign's foot is the radicand.
    const exactSurd = above.length > 0 ? undefined : boxes.find(
      (b) => isSurd(b) && b.exact && Math.abs(b.x1 - rule.x0) < 0.1 * s && Math.abs(b.top - rule.y) < 0.3 * s,
    );
    if (exactSurd) {
      below = cands.filter((b) => b !== exactSurd && mid(b) >= rule.y && mid(b) <= exactSurd.bottom + 0.1 * s);
    }
    // A radical sign at the rule's left end belongs to the rule, not under it.
    if (above.length === 0) below = below.filter((b) => !(isSurd(b) && cx(b) <= rule.x0 + 0.3 * s));
    if (below.length === 0) continue;

    const consumed = new Set<Box>([...above, ...below]);
    const nested = (set: Box[]): MathRule[] => {
      const bb = bbox(set);
      // An overline lies above the ink of what it covers, so look a little
      // beyond the boxes, but never across the rule being applied.
      const top = Math.max(bb.top - 0.6 * s, bb.top < rule.y ? -Infinity : rule.y + 1e-6);
      const bottom = Math.min(bb.bottom + 0.3 * s, bb.bottom > rule.y ? Infinity : rule.y - 1e-6);
      return pending.filter((r) => {
        const c = (r.x0 + r.x1) / 2;
        return c >= bb.x0 && c <= bb.x1 && r.y >= top && r.y <= bottom;
      });
    };
    let made: Box | null = null;
    let used: MathRule[] = [];

    if (above.length > 0) {
      // Only a rule found in pixels can be an underline mistaken for a bar.
      const drawn = [...above, ...below].every((b) => b.exact || b.kind !== "glyph");
      if (!drawn && (!boundedByRule(above, boxes, rule, s) || !boundedByRule(below, boxes, rule, s))) continue;
      const nA = nested(above);
      const nB = nested(below);
      used = [...nA, ...nB];
      const all = bbox([...above, ...below]);
      const size = Math.max(...above.map((b) => b.size), ...below.map((b) => b.size));
      made = {
        x0: Math.min(rule.x0, all.x0),
        x1: Math.max(rule.x1, all.x1),
        top: all.top,
        bottom: all.bottom,
        // The bar sits on the math axis, a quarter em above the baseline.
        base: rule.y + 0.25 * size,
        size,
        tex: `\\frac{${build(above, nA, false)}}{${build(below, nB, false)}}`,
        kind: "frac",
      };
    } else {
      const bb = bbox(below);
      const size = Math.max(...below.map((b) => b.size));
      const nB = nested(below);
      const inner = layout(below, nB, false);
      const base = inner.base ?? median(below.filter((b) => b.size >= 0.8 * size).map((b) => b.base));
      const surd = exactSurd ?? boxes.find(
        (b) =>
          isSurd(b) && !consumed.has(b) &&
          cx(b) >= rule.x0 - 1.3 * s && cx(b) <= rule.x0 + 0.3 * s &&
          Math.abs(b.base - rule.y) < 2.5 * s,
      );
      if (surd) {
        consumed.add(surd);
        used = nB;
        made = {
          x0: Math.min(surd.x0, bb.x0), x1: Math.max(rule.x1, bb.x1), top: Math.min(rule.y, bb.top),
          bottom: bb.bottom, base, size, tex: `\\sqrt{${inner.tex}}`, kind: "sqrt",
        };
      } else if (
        // A rule from the PDF just above the ink, with nothing over it, is an
        // overline whatever it covers; one found in pixels has to look like one.
        (below.every((b) => b.exact || b.kind !== "glyph")
          ? rule.y <= bb.top + 0.05 * size && rule.y >= bb.top - 0.6 * size
          : below.length <= 8 && rule.y <= base - 0.75 * size && rule.y >= base - 1.4 * size) &&
        rule.x1 - rule.x0 <= 1.4 * (bb.x1 - bb.x0) + 0.3 * s
      ) {
        used = nB;
        made = {
          x0: bb.x0, x1: bb.x1, top: Math.min(rule.y, bb.top), bottom: bb.bottom, base, size,
          tex: `\\overline{${inner.tex}}`, kind: "over",
        };
      }
    }
    if (!made) continue;
    const usedSet = new Set(used);
    pending = pending.filter((r) => !usedSet.has(r));
    boxes = boxes.filter((b) => !consumed.has(b));
    boxes.push(made);
  }
  return boxes;
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

function splitLines(boxes: Box[]): Line[] {
  if (boxes.length === 0) return [];
  // A delimiter is as tall as what it encloses, so it can be a full-size glyph
  // around script-size content: it does not say what size the line is.
  const plain = boxes.filter((b) => !isAnchor(b) && !(isTall(b) && b.cls !== "op" && b.cls !== "int"));
  const pool = plain.length > 0 ? plain : boxes;
  const maxS = Math.max(...pool.map((b) => b.size));
  const large = pool.filter((b) => b.size >= 0.8 * maxS).sort((a, b) => a.base - b.base);
  const lines: Line[] = [];
  let cur: Box[] = [];
  let mean = 0;
  // Lines of exact glyphs are at least a baseline skip apart, and at the
  // smallest size a script is as large as its base, so split less eagerly.
  const lineGap = (large.every((b) => b.exact || b.kind !== "glyph") ? 0.7 : 0.4) * maxS;
  for (const b of large) {
    if (cur.length > 0 && b.base - mean > lineGap) {
      lines.push(makeLine(cur));
      cur = [];
    }
    cur.push(b);
    mean = cur.reduce((acc, c) => acc + c.base, 0) / cur.length;
  }
  if (cur.length > 0) lines.push(makeLine(cur));

  const largeSet = new Set(large);
  const leftover: Box[] = [];
  // Operator glyphs first, so the limits hanging off them see the full extent.
  let rest = boxes
    .filter((b) => !largeSet.has(b))
    .sort((a, b) => Number(isAnchor(b) || isTall(b)) - Number(isAnchor(a) || isTall(a)));
  // A box joins the nearest line it is close to. Joining widens the line, so
  // go round again until nothing more joins: a second fraction after the
  // first is next to the line only once the first has joined.
  for (let progress = true; progress && rest.length > 0; ) {
    progress = false;
    const waiting: Box[] = [];
    for (const b of rest) {
      let best = -1;
      let bestD = Infinity;
      lines.forEach((l, i) => {
        // Operator-font glyphs hang from their origin: compare against mid-line.
        const ref = isAnchor(b) ? l.base - 0.5 * l.size : l.base;
        const d = Math.abs(b.base - ref);
        const e = bbox(l.boxes);
        // A script on a grid sits at the grid's corner, far from the baseline.
        const onGrid = l.boxes.some(
          (g) => g.kind === "grid" && b.x0 >= g.x1 - 0.1 * l.size && b.x0 <= g.x1 + 0.4 * l.size &&
            b.bottom > g.top - 0.6 * l.size && b.top < g.bottom + 0.6 * l.size,
        );
        if ((d > 1.7 * l.size && !onGrid) || b.x1 < e.x0 - 1.2 * l.size || b.x0 > e.x1 + 1.2 * l.size) return;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      if (best >= 0) {
        lines[best]!.boxes.push(b);
        progress = true;
      } else waiting.push(b);
    }
    rest = waiting;
  }
  leftover.push(...rest);
  if (leftover.length > 0 && leftover.length < boxes.length) lines.push(...splitLines(leftover));
  else if (leftover.length > 0) lines.push(makeLine(leftover));
  return lines.sort((a, b) => a.base - b.base);
}

function makeLine(large: Box[]): Line {
  const size = median(large.map((b) => b.size));
  return { boxes: [...large], large: new Set(large), base: lineBaseline(large), size };
}

/**
 * The baseline of a line of full-size boxes. With exact glyphs it is the
 * baseline of the leftmost one: at the smallest size a script is as large as
 * its base and only shifted, and a script follows its base. Otherwise the
 * median, which tolerates fallback-font noise.
 */
function lineBaseline(large: Box[]): number {
  if (!large.every((b) => b.exact || b.kind !== "glyph")) return median(large.map((b) => b.base));
  const glyphs = large.filter((b) => !isTall(b) && b.kind !== "frac" && b.kind !== "grid");
  const pool = glyphs.length > 0 ? glyphs : large;
  return pool.reduce((a, b) => (b.x0 < a.x0 ? b : a)).base;
}

/**
 * Without a detected rule (no crop pixels to read), recover a fraction from two
 * stacked, centred runs. Only taken on strong evidence: a line of glyphs whose
 * baseline lies between the two runs, or a selection that is just the stack.
 */
function mergeStackedFractions(lines: Line[]): Line[] {
  let out = lines;
  for (let guard = 0; guard < 8; guard++) {
    let merged = false;
    for (let i = 0; i + 1 < out.length && !merged; i++) {
      for (let j = i + 1; j < out.length && !merged; j++) {
        const a = out[i]!;
        const b = out[j]!;
        const ea = bbox(a.boxes);
        const eb = bbox(b.boxes);
        const s = Math.max(a.size, b.size);
        const overlap = Math.min(ea.x1, eb.x1) - Math.max(ea.x0, eb.x0);
        const wMin = Math.min(ea.x1 - ea.x0, eb.x1 - eb.x0);
        const wMax = Math.max(ea.x1 - ea.x0, eb.x1 - eb.x0);
        if (b.base - a.base > 2.6 * s) continue;
        if (overlap < 0.6 * wMin) continue;
        if (Math.abs(cx(ea) - cx(eb)) > 0.2 * wMax + 0.3 * s) continue;
        const x0 = Math.min(ea.x0, eb.x0);
        const x1 = Math.max(ea.x1, eb.x1);
        const host = out.find(
          (m) =>
            m !== a && m !== b && m.base > a.base && m.base < b.base &&
            m.boxes.every((x) => x.x1 <= x0 + 0.1 * s || x.x0 >= x1 - 0.1 * s),
        );
        // Two short centred lines are a fraction only if neither is itself a
        // statement: a numerator rarely carries a relation at its top level.
        const relation = (l: Line): boolean =>
          l.boxes.some((x) => l.large.has(x) && (x.exact ? x.cls === "rel" : x.ch != null && "=<>≤≥≈≡→".includes(x.ch)));
        const alone =
          out.length === 2 && a.boxes.length <= 8 && b.boxes.length <= 8 && !relation(a) && !relation(b);
        if (!host && !alone) continue;
        const size = Math.max(a.size, b.size);
        const frac: Box = {
          x0, x1, top: ea.top, bottom: eb.bottom,
          base: host ? host.base : (a.base + b.base) / 2 + 0.1 * size,
          size, tex: `\\frac{${lineToTex(a)}}{${lineToTex(b)}}`, kind: "frac",
        };
        out = out.filter((l) => l !== a && l !== b);
        if (host) {
          host.boxes.push(frac);
          host.large.add(frac);
        } else {
          out.push(makeLine([frac]));
        }
        merged = true;
      }
    }
    if (!merged) break;
  }
  return out.sort((a, b) => a.base - b.base);
}

// ---------------------------------------------------------------------------
// One line -> LaTeX
// ---------------------------------------------------------------------------

function isLetter(b: Box): boolean {
  // An exact letter is a variable unless its font says otherwise (see mergeStyledRuns).
  return b.kind === "glyph" && !b.exact && b.ch != null && /^[A-Za-z]$/.test(b.ch);
}

function mergedBox(run: Box[], tex: string, kind: BoxKind): Box {
  const bb = bbox(run);
  return { ...bb, base: run[0]!.base, size: run[0]!.size, tex, kind };
}

/**
 * Exact glyphs say which font they are in, so words need no guessing: touching
 * glyphs of one style are one run. An upright run is a function name, a unit
 * or a word of text; upright runs a word space apart are one piece of text.
 * Any other style wraps the run in its font command.
 */
function mergeStyledRuns(mains: Box[], size: number, all: readonly Box[] = mains): Box[] {
  if (!mains.some((b) => b.exact && b.style)) return mains;
  const out: Box[] = [];
  let run: Box[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const style = run[0]!.style!;
    const word = run.map((b) => b.tex).join("");
    if (style === "rm" && (word === "argmin" || word === "argmax")) {
      // `\arg\!\min`: two function names closed up.
      out.push({ ...mergedBox(run.slice(0, 3), "\\arg", "word"), exact: true, cls: "fn" });
      out.push({ ...mergedBox(run.slice(3), `\\${word.slice(3)}`, "word"), exact: true, cls: "fn" });
    } else if (style === "rm" && FUNCTIONS.has(word)) {
      out.push({ ...mergedBox(run, `\\${word}`, "word"), exact: true, cls: "fn" });
    } else if (style === "rm") {
      const prev = out[out.length - 1];
      const gap = prev ? run[0]!.x0 - prev.x1 : Infinity;
      const first = run[0]!;
      const clear = prev != null && !all.some((b) => cx(b) > prev.x1 && cx(b) < first.x0);
      if (prev && prev.kind === "text" && prev.exact && gap > 0.2 * size && gap < 0.9 * size && clear) {
        // A word space, not math spacing: the same piece of text goes on.
        prev.tex = `${prev.tex.slice(0, -1)} ${word}}`;
        prev.x1 = run[run.length - 1]!.x1;
      } else {
        out.push({ ...mergedBox(run, `\\text{${word}}`, "text"), exact: true, cls: "ord" });
      }
    } else {
      out.push({ ...mergedBox(run, `${STYLE_COMMANDS[style] ?? "\\mathrm"}{${word}}`, "word"), exact: true, cls: "ord" });
    }
    run = [];
  };
  for (const b of mains) {
    const last = run[run.length - 1];
    if (b.exact && b.style && b.kind === "glyph") {
      if (last && (last.style !== b.style || b.x0 - last.x1 > 0.12 * size)) flush();
      run.push(b);
    } else {
      flush();
      out.push(b);
    }
  }
  flush();
  // `\liminf` and `\limsup` print as two words a thin space apart.
  for (let i = out.length - 1; i > 0; i--) {
    const a = out[i - 1]!;
    const b = out[i]!;
    if (a.tex === "\\lim" && (b.tex === "\\inf" || b.tex === "\\sup") && b.x0 - a.x1 < 0.3 * size) {
      out.splice(i - 1, 2, { ...mergedBox([a, b], `\\lim${b.tex.slice(1)}`, "word"), exact: true, cls: "fn" });
    }
  }
  // Text of one or two letters with no word space is a symbol set upright
  // (`\mathrm{d}`, `\mathrm{kg}`), which is what the source most likely said.
  for (const b of out) {
    if (b.kind === "text" && b.exact && !b.tex.includes(" ") && b.tex.length <= 9) {
      b.tex = `\\mathrm{${b.tex.slice(6, -1)}}`;
      b.kind = "word";
    }
  }
  return out;
}

/** Fuse adjacent letters into function names (`\sin`) and prose (`\text{…}`). */
function mergeWords(input: Box[], size: number, all: readonly Box[] = input): Box[] {
  const mains = mergeStyledRuns(input, size, all);
  // 1. maximal runs of touching letters
  const runs: Box[][] = [];
  const items: (Box | Box[])[] = [];
  let run: Box[] = [];
  const flush = (): void => {
    if (run.length > 1) {
      runs.push(run);
      items.push(run);
    } else if (run.length === 1) items.push(run[0]!);
    run = [];
  };
  for (const b of mains) {
    if (isLetter(b) && (run.length === 0 || b.x0 - run[run.length - 1]!.x1 < 0.2 * size)) {
      run.push(b);
    } else {
      flush();
      if (isLetter(b)) run.push(b);
      else items.push(b);
    }
  }
  flush();

  // 2. classify each run
  const word = (r: Box[]): string => r.map((b) => b.ch).join("");
  const isProse = (w: string): boolean => /^[A-Za-z][a-z]{3,}$/.test(w);
  const out: Box[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (!Array.isArray(it)) {
      out.push(it);
      continue;
    }
    const w = word(it);
    if (FUNCTIONS.has(w)) {
      out.push(mergedBox(it, `\\${w}`, "word"));
      continue;
    }
    // `sinx`: a thin space separates a function name from its argument.
    const fn = [...FUNCTIONS].filter((f) => w.startsWith(f) && w.length - f.length === 1)
      .sort((a, b) => b.length - a.length)[0];
    if (fn) {
      out.push(mergedBox(it.slice(0, fn.length), `\\${fn}`, "word"), ...it.slice(fn.length));
      continue;
    }
    const neighbourProse = [items[i - 1], items[i + 1]].some(
      (n) => Array.isArray(n) && isProse(word(n)),
    );
    if (isProse(w) || (STOPWORDS.has(w.toLowerCase()) && neighbourProse)) {
      const prev = out[out.length - 1];
      if (prev && prev.kind === "text") {
        prev.tex = `${prev.tex.slice(0, -1)} ${w}}`;
        prev.x1 = it[it.length - 1]!.x1;
      } else {
        out.push(mergedBox(it, `\\text{${w}}`, "text"));
      }
      continue;
    }
    out.push(...it);
  }
  return out;
}

function wrapScript(tex: string): string {
  const t = tex.startsWith("^{\\circ}") && tex.length === 8 ? "\\circ" : tex;
  return /^[A-Za-z0-9]$/.test(t) ? t : `{${t}}`;
}

/** Concatenate LaTeX fragments, separating a command from a following letter. */
function joinTex(parts: string[]): string {
  let s = "";
  for (const p of parts) {
    if (p.length === 0) continue;
    if (/\\[A-Za-z]+$/.test(s) && /^[A-Za-z0-9]/.test(p)) s += " ";
    s += p;
  }
  return s;
}

function lineToTex(line: Line): string {
  const s = line.size;
  // At the same place a zero-width glyph comes first: the slash of `\not` is
  // drawn at the left edge of the symbol it negates.
  const all = [...line.boxes].sort((a, b) => a.x0 - b.x0 || a.x1 - a.x0 - (b.x1 - b.x0));
  const mainsRaw: Box[] = [];
  const scripts: Box[] = [];
  for (const b of all) {
    const d = (line.base - b.base) / s;
    // Exact glyphs: a script is never on the baseline, whatever its size, and
    // at the smallest size it is no smaller than its base, only shifted.
    const tol = b.kind === "frac" || b.kind === "grid" ? 0.3
      : isTall(b) ? (b.size >= 0.85 * s ? 0.35 : -1)
      : b.exact ? (b.size <= 0.85 * s ? -1 : 0.14)
      : b.size <= 0.85 * s ? 0.08 : 0.28;
    if ((line.large.has(b) && !b.exact) || isAnchor(b) || Math.abs(d) <= tol) mainsRaw.push(b);
    else scripts.push(b);
  }
  if (mainsRaw.length === 0) return joinTex(all.map(styled));
  const mains = mergeWords(mainsRaw, s, all);

  // Connected runs of off-baseline glyphs: each is one script (or one limit).
  const parent = scripts.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < scripts.length; i++) {
    for (let j = i + 1; j < scripts.length; j++) {
      const a = scripts[i]!;
      const b = scripts[j]!;
      const gap = Math.max(0, b.x0 - a.x1, a.x0 - b.x1);
      // Inside a script TeX sets relations and operators tight, so exact
      // glyphs of one script nearly touch; limits of neighbouring operators don't.
      const drawn = (a.exact || a.kind !== "glyph") && (b.exact || b.kind !== "glyph");
      // A limit under an operator lies wholly below the baseline, which no
      // subscript does, and is one piece however its parts are spaced.
      const under = drawn && a.top > line.base + 0.1 * s && b.top > line.base + 0.1 * s;
      const near = under ? 0.45 : drawn ? 0.2 : 0.3;
      if (gap < near * s && Math.abs(a.base - b.base) < 0.45 * Math.max(a.size, b.size)) {
        parent[find(i)] = find(j);
      }
    }
  }
  const groups = new Map<number, Box[]>();
  scripts.forEach((b, i) => {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(b);
    else groups.set(r, [b]);
  });

  // What can carry limits: an operator, a function such as `\lim`, and an
  // integral when the script is centred on it (`\int\limits`).
  const carriesLimits = (m: Box, c: number): boolean =>
    (m.kind === "glyph" && (m.exact ? m.cls === "op" : m.ch != null && LIMIT_OPS.has(m.ch)) && c >= m.x0 - 0.2 * s && c <= m.x1 + 0.2 * s) ||
    (LIMIT_WORDS.has(m.tex) && c >= m.x0 - 0.2 * s && c <= m.x1 + 0.2 * s) ||
    (m.kind === "glyph" && m.exact === true && m.cls === "int" && Math.abs(c - cx(m)) < 0.2 * s);
  // The limits of two operators side by side nearly touch and were joined
  // above: part them at the widest gap between the operators' centres.
  const pieces: Box[][] = [];
  for (const g of groups.values()) {
    let rest = [...g].sort((a, b) => a.x0 - b.x0);
    const span = bbox(rest);
    const hosts = mains
      .filter((m) => carriesLimits(m, cx(m)) && cx(m) > span.x0 && cx(m) < span.x1)
      .sort((a, b) => a.x0 - b.x0);
    for (let h = 0; h + 1 < hosts.length && rest.length > 1; h++) {
      let at = -1;
      let widest = 0;
      for (let i = 0; i + 1 < rest.length; i++) {
        const gap = rest[i + 1]!.x0 - rest[i]!.x1;
        const where = (rest[i]!.x1 + rest[i + 1]!.x0) / 2;
        if (where > cx(hosts[h]!) && where < cx(hosts[h + 1]!) && gap > widest) {
          widest = gap;
          at = i;
        }
      }
      if (at < 0) continue;
      pieces.push(rest.slice(0, at + 1));
      rest = rest.slice(at + 1);
    }
    pieces.push(rest);
  }
  const sups = new Map<Box | null, Box[]>();
  const subs = new Map<Box | null, Box[]>();
  for (const g of pieces) {
    const bb = bbox(g);
    const c = cx(bb);
    const isAbove = median(g.map((b) => b.base)) < line.base;
    if (g.every((b) => b.exact || b.kind !== "glyph")) {
      // A root's index: TeX sets it over the radical's left edge, ending ten
      // math units (0.556 em) inside it.
      const root = isAbove
        ? mains.find((m) => m.kind === "sqrt" && m.tex.startsWith("\\sqrt{") && Math.abs(bb.x1 - (m.x0 + 0.556 * m.size)) < 0.2 * m.size)
        : undefined;
      if (root) {
        root.tex = `\\sqrt[${build(g, [], false)}]${root.tex.slice(5)}`;
        continue;
      }
      // Something centred over or under a relation is stacked on it (`\overset`).
      const rel = mains.find(
        (m) => m.kind === "glyph" && m.exact && m.cls === "rel" && c > m.x0 && c < m.x1 &&
          (isAbove ? bb.bottom <= m.top + 0.15 * s : bb.top >= m.bottom - 0.15 * s),
      );
      if (rel) {
        rel.tex = `\\${isAbove ? "overset" : "underset"}{${build(g, [], false)}}{${rel.tex}}`;
        continue;
      }
    }
    let host: Box | null = mains.find((m) => carriesLimits(m, c)) ?? null;
    if (!host) {
      for (const m of mains) if (m.x1 <= bb.x0 + 0.35 * s) host = m;
    }
    const map = isAbove ? sups : subs;
    const list = map.get(host);
    if (list) list.push(...g);
    else map.set(host, [...g]);
  }

  const script = (host: Box | null): string => {
    const sub = subs.get(host);
    const sup = sups.get(host);
    return (
      (sub ? `_${wrapScript(build(sub, [], false))}` : "") +
      (sup ? `^${wrapScript(build(sup, [], false))}` : "")
    );
  };
  const parts: string[] = [];
  const lead = script(null);
  if (lead) parts.push(`{}${lead}`);
  mains.forEach((m, i) => {
    let tex = styled(m);
    if (m.kind === "text") {
      // Keep the word spacing that the surrounding math would otherwise eat.
      tex = `\\text{${i > 0 ? " " : ""}${tex.slice(6, -1)}${i < mains.length - 1 ? " " : ""}}`;
    }
    parts.push(tex + script(m));
  });
  return joinTex(parts);
}

function build(boxes: Box[], rules: readonly MathRule[], allowStack: boolean): string {
  return layout(boxes, rules, allowStack).tex;
}

// ---------------------------------------------------------------------------
// Rows and grids (exact glyphs only)
// ---------------------------------------------------------------------------

/**
 * Baselines of two rows are at least this far apart, in ems of the rows' own
 * size. The tightest rows are a text-style binomial's (1.06); a subscript and
 * a superscript on one base, both at the smallest size, come to 0.93.
 */
const ROW_APART = 1.0;

/** Whether a rule hangs from a radical sign: its vinculum, not a fraction bar. */
function isVinculum(rule: MathRule, boxes: readonly Box[], s: number): boolean {
  return boxes.some(
    (b) => b.kind === "glyph" && b.cls === "radical" && Math.abs(b.x1 - rule.x0) < 0.1 * s && Math.abs(b.top - rule.y) < 0.3 * s,
  );
}

/**
 * Where a set of boxes divides into rows: the y of each cut, top to bottom;
 * empty for a single row. Rows are found from baselines, not from gaps: a
 * fraction has gaps of its own. Evidence for a row's baseline is a full-size
 * glyph that no fraction bar owns, or a fraction bar that is not nested in
 * another (the bar sits a quarter em above its row's baseline). Each cut then
 * goes through the widest band of white between two baselines.
 */
function rowCuts(boxes: readonly Box[], rules: readonly MathRule[]): number[] {
  const plain = boxes.filter((b) => !isTall(b) && b.cls !== "accent" && b.cls !== "radical");
  if (plain.length === 0) return [];
  const s = Math.max(...plain.map((b) => b.size));
  const mid = (b: Box): number => (b.top + b.bottom) / 2;
  const under = (b: { x0: number; x1: number }, r: MathRule): boolean => cx(b) >= r.x0 - 0.02 * s && cx(b) <= r.x1 + 0.02 * s;
  const bars = rules.filter(
    (r) =>
      !isVinculum(r, boxes, s) &&
      boxes.some((b) => under(b, r) && b.bottom <= r.y + 0.05 * s && r.y - b.bottom < 0.7 * s) &&
      boxes.some((b) => under(b, r) && b.top >= r.y - 0.05 * s && b.top - r.y < 0.7 * s),
  );
  // What each bar holds: the stack of boxes and shorter bars that touches it
  // from above and from below. A step from a bar may be as long as the
  // clearance TeX leaves round a bar; any other step is from ink to ink.
  const ownedBoxes = new Set<Box>();
  const nestedBars = new Set<MathRule>();
  // A shorter bar next to `outer` is part of it when one line of glyphs lies
  // between the two (its own numerator or denominator). Two lines are a
  // denominator and the next row's numerator: the bars are neighbours.
  const partOf = (inner: MathRule, outer: MathRule): boolean => {
    const lo = Math.min(inner.y, outer.y);
    const hi = Math.max(inner.y, outer.y);
    const between = boxes.filter((b) => !isTall(b) && under(b, inner) && mid(b) > lo && mid(b) < hi);
    if (between.length === 0) return true;
    const m = Math.max(...between.map((b) => b.size));
    const bases = between.filter((b) => b.size >= 0.8 * m).map((b) => b.base);
    return Math.max(...bases) - Math.min(...bases) <= 0.5 * m;
  };
  for (const bar of bars) {
    const length = bar.x1 - bar.x0;
    for (const dir of [-1, 1] as const) {
      type Item = { near: number; far: number; box?: Box; rule?: MathRule };
      const items: Item[] = [
        ...boxes
          .filter((b) => under(b, bar) && (dir < 0 ? mid(b) < bar.y : mid(b) > bar.y))
          .map((b) => ({ near: dir < 0 ? b.bottom : b.top, far: dir < 0 ? b.top : b.bottom, box: b })),
        ...bars
          .filter((r) => r !== bar && r.x1 - r.x0 < length - 0.05 * s && under(r, bar) && (dir < 0 ? r.y < bar.y : r.y > bar.y))
          .map((r) => ({ near: r.y, far: r.y, rule: r })),
      ].sort((p, q) => dir * (p.near - q.near));
      let edge = bar.y;
      let reach = 0.7 * s;
      for (const it of items) {
        if (dir * (it.near - edge) > reach) break;
        if (it.rule) {
          if (!partOf(it.rule, bar)) break;
          nestedBars.add(it.rule);
          reach = 0.7 * s;
        } else {
          ownedBoxes.add(it.box!);
          reach = 0.3 * s;
        }
        edge = dir < 0 ? Math.min(edge, it.far) : Math.max(edge, it.far);
      }
    }
  }
  const nested = (r: MathRule): boolean => nestedBars.has(r);
  const owned = (b: Box): boolean => ownedBoxes.has(b);
  const evidence = [
    ...plain.filter((b) => b.size >= 0.8 * s && !owned(b)).map((b) => b.base),
    ...bars.filter((r) => !nested(r)).map((r) => r.y + 0.25 * s),
  ].sort((a, b) => a - b);
  const baselines: number[] = [];
  let group: number[] = [];
  for (const y of evidence) {
    if (group.length > 0 && y - group.reduce((a, b) => a + b, 0) / group.length > ROW_APART * s) {
      baselines.push(group.reduce((a, b) => a + b, 0) / group.length);
      group = [];
    }
    group.push(y);
  }
  if (group.length > 0) baselines.push(group.reduce((a, b) => a + b, 0) / group.length);
  if (baselines.length < 2) return [];

  const ink: [number, number][] = [
    ...boxes.map((b) => [b.top, b.bottom] as [number, number]),
    ...rules.map((r) => [r.y - 0.02 * s, r.y + 0.02 * s] as [number, number]),
  ];
  const cuts: number[] = [];
  for (let i = 0; i + 1 < baselines.length; i++) {
    const from = baselines[i]!;
    const to = baselines[i + 1]!;
    // Ink that reaches across both baselines spans the rows and says nothing.
    const spans = ink
      .filter(([t, b]) => b > from && t < to && !(t < from - 0.1 * s && b > to + 0.1 * s))
      .sort((a, b) => a[0] - b[0]);
    let edge = from;
    let best: [number, number] | null = null;
    for (const [t, b] of spans) {
      if (t > edge && (!best || t - edge > best[1] - best[0])) best = [edge, t];
      edge = Math.max(edge, b);
    }
    if (to > edge && (!best || to - edge > best[1] - best[0])) best = [edge, to];
    cuts.push(best ? (best[0] + best[1]) / 2 : (from + to) / 2);
  }
  return cuts;
}

/** Divide boxes and rules among the rows that `cuts` separates. */
function intoRows(boxes: readonly Box[], rules: readonly MathRule[], cuts: readonly number[]): { boxes: Box[]; rules: MathRule[] }[] {
  const rows = Array.from({ length: cuts.length + 1 }, () => ({ boxes: [] as Box[], rules: [] as MathRule[] }));
  const rowOf = (y: number): number => cuts.filter((c) => c < y).length;
  for (const b of boxes) rows[rowOf((b.top + b.bottom) / 2)]!.boxes.push(b);
  for (const r of rules) rows[rowOf(r.y)]!.rules.push(r);
  return rows;
}

const CLOSER: Readonly<Record<string, string>> = {
  "(": ")", "[": "]", "\\{": "\\}", "\\langle": "\\rangle", "|": "|", "\\|": "\\|", "\\lfloor": "\\rfloor", "\\lceil": "\\rceil",
};
const GRID_ENVIRONMENT: Readonly<Record<string, string>> = {
  "(": "pmatrix", "[": "bmatrix", "\\{": "Bmatrix", "|": "vmatrix", "\\|": "Vmatrix",
};
/** Columns of a grid stand at least this far apart, in ems; spacing inside a cell is tighter. */
const COLUMN_GAP = 0.6;

/**
 * Replace each grid by one box: a pair of delimiters (or a lone left brace)
 * whose contents stand in two or more rows is a binomial, a matrix or `cases`.
 * Cells are laid out on their own, so nothing in one row can reach into the next.
 */
function applyGrids(input: Box[], inputRules: readonly MathRule[]): { boxes: Box[]; rules: MathRule[] } {
  let boxes = input;
  let rules = [...inputRules];
  const isDelimiter = (b: Box): boolean =>
    b.kind === "glyph" && b.exact === true && (b.cls === "open" || b.cls === "close" || b.cls === "fence");
  const tried = new Set<Box>();
  for (let guard = 0; guard < 200; guard++) {
    // Innermost first: the rightmost untried opener has no opener inside it,
    // so a grid within a grid is one box by the time the outer one is read.
    const openers = boxes
      .filter((b) => isDelimiter(b) && !tried.has(b) && CLOSER[b.tex] != null && b.cls !== "close")
      .sort((a, b) => b.x0 - a.x0);
    const open = openers[0];
    if (!open) break;
    tried.add(open);
    const s = open.size;
    const sameExtent = (b: Box): boolean => Math.abs(b.top - open.top) < 0.12 * s && Math.abs(b.bottom - open.bottom) < 0.12 * s;
    let close: Box | undefined;
    let depth = 0;
    for (const b of boxes.filter((x) => isDelimiter(x) && x.x0 > open.x0 && sameExtent(x)).sort((a, b) => a.x0 - b.x0)) {
      if (b.tex === CLOSER[open.tex] && depth === 0) {
        close = b;
        break;
      }
      if (b.tex === open.tex) depth++;
      else if (b.tex === CLOSER[open.tex]) depth--;
    }
    // The second of a pair of bars closes; it does not open the next pair.
    if (close) tried.add(close);
    // A lone brace as tall as two lines opens `cases`.
    if (!close && !(open.tex === "\\{" && open.bottom - open.top > 1.8 * s)) continue;
    const between = (x: number): boolean => x > open.x1 - 0.05 * s && (close ? x < close.x0 + 0.05 * s : true);
    const within = (x: number, y: number): boolean => between(x) && y > open.top - 0.02 * s && y < open.bottom + 0.02 * s;
    const content = boxes.filter((b) => b !== open && b !== close && within(cx(b), (b.top + b.bottom) / 2));
    // Delimiters round a grid are as tall as the grid. Ink that crosses their
    // top or bottom means they stand inside something taller, a fraction say.
    const crosses = (b: Box, y: number): boolean => b.top < y - 0.15 * s && b.bottom > y + 0.15 * s;
    if (close && boxes.some((b) => b !== open && b !== close && between(cx(b)) && (crosses(b, open.top) || crosses(b, open.bottom)))) continue;
    const contentRules = rules.filter((r) => within((r.x0 + r.x1) / 2, r.y));
    if (content.length < 2) continue;
    const cuts = rowCuts(content, contentRules);
    if (cuts.length === 0) continue;

    const rows = intoRows(content, contentRules, cuts);
    const cs = Math.max(...content.filter((b) => !isTall(b)).map((b) => b.size), 0) || s;
    // Columns: gaps in the shadow that all rows together cast on the x axis.
    const shadow = content.map((b) => [b.x0, b.x1] as [number, number]).sort((a, b) => a[0] - b[0]);
    const columnStarts: number[] = [];
    let edge = -Infinity;
    for (const [x0, x1] of shadow) {
      if (x0 - edge >= COLUMN_GAP * cs) columnStarts.push(x0);
      edge = Math.max(edge, x1);
    }
    const columnOf = (x: number): number => Math.max(0, columnStarts.filter((c) => c <= x + 1e-6).length - 1);
    const cells = rows.map((row) => {
      const out = columnStarts.map(() => ({ boxes: [] as Box[], rules: [] as MathRule[] }));
      for (const b of row.boxes) out[columnOf(b.x0)]!.boxes.push(b);
      for (const r of row.rules) out[columnOf((r.x0 + r.x1) / 2)]!.rules.push(r);
      return out.map((c) => (c.boxes.length > 0 ? build(c.boxes, usableRules(c.boxes, c.rules), false) : ""));
    });

    let tex: string;
    const rowGap = rowBaselineGap(content, contentRules, cuts);
    if (close && open.tex === "(" && cells.length === 2 && columnStarts.length === 1 && (cs < 0.85 * s || rowGap > 1.28 * cs)) {
      // The rows of a binomial stand apart as a fraction's do; a matrix keeps the line spacing.
      tex = `\\binom{${cells[0]![0]}}{${cells[1]![0]}}`;
    } else {
      const body = cells.map((row) => row.join(" & ")).join(" \\\\ ");
      const env = !close ? "cases" : GRID_ENVIRONMENT[open.tex];
      tex = env
        ? `\\begin{${env}} ${body} \\end{${env}}`
        : `\\left${open.tex} \\begin{matrix} ${body} \\end{matrix} \\right${close!.tex}`;
    }
    const gone = new Set<Box>([open, ...content, ...(close ? [close] : [])]);
    const goneRules = new Set(contentRules);
    const all = bbox([...gone]);
    boxes = boxes.filter((b) => !gone.has(b));
    rules = rules.filter((r) => !goneRules.has(r));
    boxes.push({
      x0: all.x0, x1: all.x1, top: open.top, bottom: open.bottom,
      // Centred on the math axis of the line it stands in.
      base: (open.top + open.bottom) / 2 + 0.25 * s,
      size: s, tex, kind: "grid", exact: true, cls: "ord",
    });
  }
  return { boxes, rules };
}

/** Distance between the first two row baselines of a grid. */
function rowBaselineGap(boxes: readonly Box[], rules: readonly MathRule[], cuts: readonly number[]): number {
  const rows = intoRows(boxes, rules, cuts);
  const baseOf = (row: { boxes: Box[] }): number => {
    const plain = row.boxes.filter((b) => !isTall(b));
    const size = Math.max(...plain.map((b) => b.size), 0);
    return median(plain.filter((b) => b.size >= 0.8 * size).map((b) => b.base));
  };
  return rows.length < 2 ? 0 : baseOf(rows[1]!) - baseOf(rows[0]!);
}

/** LaTeX for a set of boxes, and their baseline when they form a single line. */
function layout(input: Box[], inputRules: readonly MathRule[], allowStack: boolean): { tex: string; base: number | null } {
  let boxes = input;
  let rules = inputRules;
  // With every glyph identified, the structure that spans lines is read first.
  if (boxes.length > 1 && boxes.every((b) => b.exact || b.kind !== "glyph")) {
    const grids = applyGrids(boxes, rules);
    boxes = grids.boxes;
    rules = grids.rules;
    const cuts = rowCuts(boxes, rules);
    if (cuts.length > 0) {
      const rows = intoRows(boxes, rules, cuts).filter((r) => r.boxes.length > 0);
      if (rows.length > 1) {
        return { tex: rows.map((r) => layoutRow(r.boxes, r.rules, allowStack).tex).filter((t) => t.length > 0).join(" \\\\ "), base: null };
      }
    }
  }
  return layoutRow(boxes, rules, allowStack);
}

function layoutRow(boxes: Box[], rules: readonly MathRule[], allowStack: boolean): { tex: string; base: number | null } {
  const structured = rules.length > 0 ? applyRules(boxes, rules) : boxes;
  let lines = splitLines(structured);
  if (allowStack) lines = mergeStackedFractions(lines);
  return {
    tex: lines.map(lineToTex).filter((t) => t.length > 0).join(" \\\\ "),
    base: lines.length === 1 ? lines[0]!.base : null,
  };
}

/**
 * Drop rules that are really the stroke of a bar-shaped glyph (`−`, `=`, …) or
 * too short/thick to be a fraction bar, given the glyphs they sit among.
 */
function usableRules(boxes: Box[], rules: readonly MathRule[]): MathRule[] {
  if (boxes.length === 0) return [];
  const s = median(boxes.map((b) => b.size));
  // Rules read from the PDF's own drawing operations are rules: only pixel
  // detection can mistake a short stroke or a minus sign for one.
  const fromPdf = boxes.every((b) => b.exact);
  return rules.filter((r) => {
    const len = r.x1 - r.x0;
    if (r.thickness != null && r.thickness > Math.max(0.16 * s, 1.5)) return false;
    if (fromPdf) return true;
    if (len < 0.4 * s) return false;
    return !boxes.some((b) => {
      if (b.exact || b.ch == null || !BAR_CHARS.has(b.ch)) return false;
      const overlap = Math.min(b.x1, r.x1) - Math.max(b.x0, r.x0);
      return overlap >= 0.6 * Math.min(len, b.x1 - b.x0) && len <= 1.6 * (b.x1 - b.x0) + 0.2 * s &&
        r.y >= b.base - 0.7 * b.size && r.y <= b.base + 0.15 * b.size;
    });
  });
}

/**
 * Rebuild LaTeX from positioned glyphs. `rules` are the thin horizontal rules
 * found in the same region (see {@link detectHorizontalRules}); with none, a
 * fraction is only inferred from an unambiguous centred stack.
 */
export function glyphsToLatex(input: readonly MathGlyph[], rules: readonly MathRule[] = []): string {
  const glyphs = dropEquationNumbers(input);
  const boxes = applyAccents(toBoxes(glyphs));
  if (boxes.length === 0) return "";
  const good = usableRules(boxes, rules);
  // With no rule to go by, a fraction can only be guessed from a stack. Exact
  // glyphs come with the page's real rules, so no rule means no fraction.
  const guessStacks = good.length === 0 && !boxes.every((b) => b.exact);
  return dropSentenceMark(build(boxes, good, guessStacks).replace(/\s+/g, " ").trim());
}

/**
 * A comma, full stop, semicolon or colon that ends the formula belongs to the
 * sentence around it: it sits against the formula, inside any box a reader
 * draws. `\,`, `\;` and `\:` are spacing commands, not marks.
 */
export function dropSentenceMark(latex: string): string {
  const m = /^(.*?)\s*[,.;:]$/s.exec(latex);
  if (!m || m[1]!.endsWith("\\")) return latex;
  const rest = m[1]!.replace(/(?:\s*(?:\\[,;:!]|\\quad|\\qquad))+$/, "");
  // Two marks in a row are dots the author wrote, not the end of a sentence.
  if (rest.length === 0 || /[^\\][,.;:]$/.test(rest)) return latex;
  return rest;
}

/** What an equation number looks like between its parentheses: 3, 2.14, A.1, 12a, 4'. */
const EQUATION_NUMBER = /^[A-Z]?\.?\d+(?:[.-]\d+)*[a-z]?'?$/;
/**
 * The number stands at least this far from the equation, in ems. TeX itself
 * leaves a quad or more, moving the number to its own line otherwise.
 */
const NUMBER_GAP = 0.9;

/**
 * Drop equation numbers: a short `(n)` flush with the right edge (or the left,
 * as `leqno` sets it) and clear space between it and the equation. A box dragged across the column takes the number in, and
 * it is not part of the formula. Several-line equations carry one a line.
 */
export function dropEquationNumbers(glyphs: readonly MathGlyph[]): readonly MathGlyph[] {
  let rest = glyphs;
  for (let guard = 0; guard < 40; guard++) {
    const group = equationNumber(rest);
    if (!group) break;
    rest = rest.filter((g) => !group.has(g));
  }
  return rest;
}

function equationNumber(glyphs: readonly MathGlyph[]): Set<MathGlyph> | null {
  if (glyphs.length < 4) return null;
  const text = (g: MathGlyph) => g.tex ?? g.ch;
  const left = Math.min(...glyphs.map((g) => g.x0));
  const right = Math.max(...glyphs.map((g) => g.x1));
  const sorted = [...glyphs].sort((a, b) => a.x0 - b.x0);
  for (let i = 0; i < sorted.length; i++) {
    const open = sorted[i]!;
    if (text(open) !== "(") continue;
    // Walk right along the baseline to the closing parenthesis.
    const group: MathGlyph[] = [open];
    let closed = false;
    for (let j = i + 1; j < sorted.length && group.length <= 9; j++) {
      const g = sorted[j]!;
      const last = group[group.length - 1]!;
      if (Math.abs(g.base - open.base) > 0.1 * open.size) continue;
      if (g.x0 - last.x1 > 0.3 * open.size || Math.abs(g.size - open.size) > 0.05 * open.size) break;
      group.push(g);
      if (text(g) === ")") {
        closed = true;
        break;
      }
    }
    if (!closed || !EQUATION_NUMBER.test(group.slice(1, -1).map(text).join(""))) continue;
    const close = group[group.length - 1]!;
    // Flush with one edge of the selection: right as LaTeX sets it, left with `leqno`.
    const atRight = close.x1 >= right - open.size;
    const atLeft = open.x0 <= left + open.size;
    if (!atRight && !atLeft) continue;
    const members = new Set(group);
    if (members.size === glyphs.length) return null;
    const top = open.base - 0.75 * open.size;
    const bottom = open.base + 0.25 * open.size;
    const gap = NUMBER_GAP * open.size;
    const crowded = glyphs.some((g) => {
      if (members.has(g)) return false;
      const gt = g.top ?? g.base - 0.7 * g.size;
      const gb = g.bottom ?? g.base + 0.2 * g.size;
      if (gb < top || gt > bottom) return false; // on another line
      return atRight ? g.x1 > open.x0 - gap : g.x0 < close.x1 + gap;
    });
    if (!crowded) return members;
  }
  return null;
}

/**
 * Attach each accent glyph (`\hat`, `\vec`, `\widetilde`...) to what it sits
 * over. Only exact glyphs can be accents: a character alone does not say
 * whether `^` is a hat or a caret. TeX centres an accent over its base, so the
 * base is whatever lies under the accent's own width, just below its ink.
 */
function applyAccents(input: Box[]): Box[] {
  const accents = input.filter((b) => b.exact && b.cls === "accent");
  if (accents.length === 0) return input;
  let boxes = input.filter((b) => !(b.exact && b.cls === "accent"));
  // Narrow accents first, so `\widehat{\hat{x} y}` nests the right way round.
  for (const acc of accents.sort((a, b) => a.x1 - a.x0 - (b.x1 - b.x0))) {
    const s = acc.size;
    const wide = acc.tex.startsWith("\\wide");
    // The wide accents come from the extension font, which is not always
    // scaled with the script it sits in: only a narrow accent matches its
    // base in size.
    const under = boxes.filter(
      (b) =>
        (wide || (b.size >= 0.9 * s && b.size <= 1.1 * s)) &&
        b.top - acc.bottom > -0.2 * b.size && b.top - acc.bottom < 0.5 * b.size,
    );
    let bases: Box[];
    if (wide) {
      // A wide accent is centred over a run of boxes. TeX has three sizes of
      // each (0.56, 1 and 1.44 em) and uses the largest that is no wider than
      // what it covers, which bounds the run from both sides.
      const row = under.sort((a, b) => a.x0 - b.x0);
      const w = (acc.x1 - acc.x0) / s;
      const min = w < 0.8 ? 0 : w - 0.2; // an italic correction counts as width
      const max = w < 0.8 ? 1.03 : w < 1.2 ? 1.47 : Infinity;
      let best: Box[] = [];
      for (let i = 0; i < row.length; i++) {
        for (let j = i; j < row.length; j++) {
          const run = row.slice(i, j + 1);
          const bb = bbox(run);
          const width = (bb.x1 - bb.x0) / s;
          if (Math.abs(cx(bb) - cx(acc)) > 0.12 * s || width < min || width > max) continue;
          if (best.length === 0 || bb.x1 - bb.x0 > bbox(best).x1 - bbox(best).x0) best = run;
        }
      }
      bases = best;
    } else {
      const nearest = under
        .filter((b) => Math.abs(cx(b) - cx(acc)) < 0.5 * (b.x1 - b.x0) + 0.12 * s)
        .sort((a, b) => Math.abs(cx(a) - cx(acc)) - Math.abs(cx(b) - cx(acc)))[0];
      bases = nearest ? [nearest] : [];
    }
    if (bases.length === 0) continue; // an accent with nothing under it is dropped
    const inner = bases.sort((a, b) => a.x0 - b.x0);
    const set = new Set(inner);
    const bb = bbox(inner);
    boxes = boxes.filter((b) => !set.has(b));
    boxes.push({
      x0: bb.x0,
      x1: bb.x1,
      top: Math.min(bb.top, acc.top),
      bottom: bb.bottom,
      base: inner[0]!.base,
      size: inner[0]!.size,
      tex: `${acc.tex}{${build(inner, [], false)}}`,
      kind: "word",
      exact: true,
      cls: "ord",
    });
  }
  return boxes;
}

// ---------------------------------------------------------------------------
// Rule detection in the crop's pixels
// ---------------------------------------------------------------------------

/** RGBA pixels (the shape of a DOM `ImageData`). */
export interface RulePixels {
  readonly data: ArrayLike<number>;
  readonly width: number;
  readonly height: number;
}

/**
 * Find thin, isolated horizontal strokes in a rendered crop: fraction bars and
 * radical vincula are drawn as rules, so they never appear in the text layer.
 * "Isolated" (clear paper directly above and below, ignoring the stroke's ends
 * where a radical sign joins) rejects the horizontal strokes of letters such as
 * T, E or 7. Coordinates are in image pixels.
 */
export function detectHorizontalRules(
  img: RulePixels,
  opts: { minLength?: number; maxThickness?: number } = {},
): MathRule[] {
  const W = Math.floor(img.width);
  const H = Math.floor(img.height);
  if (W <= 0 || H <= 0) return [];
  const minLen = Math.max(4, opts.minLength ?? 6);
  const maxThick = Math.max(1, opts.maxThickness ?? Math.max(4, Math.round(H * 0.06)));
  const d = img.data;
  const dark = (x: number, y: number): boolean => {
    const i = (y * W + x) * 4;
    const a = (d[i + 3] ?? 255) / 255;
    const lum = (0.299 * (d[i] ?? 255) + 0.587 * (d[i + 1] ?? 255) + 0.114 * (d[i + 2] ?? 255)) * a + 255 * (1 - a);
    return lum < 185;
  };

  interface Run { x0: number; x1: number; yTop: number; yBot: number }
  const done: Run[] = [];
  let active: Run[] = [];
  for (let y = 0; y <= H; y++) {
    const rowRuns: { x0: number; x1: number }[] = [];
    if (y < H) {
      let start = -1;
      for (let x = 0; x <= W; x++) {
        const on = x < W && dark(x, y);
        if (on && start < 0) start = x;
        else if (!on && start >= 0) {
          if (x - start >= minLen) rowRuns.push({ x0: start, x1: x });
          start = -1;
        }
      }
    }
    const next: Run[] = [];
    const matched = new Set<Run>();
    for (const r of rowRuns) {
      const prev = active.find((a) => {
        const ov = Math.min(a.x1, r.x1) - Math.max(a.x0, r.x0);
        return !matched.has(a) && ov >= 0.8 * Math.min(a.x1 - a.x0, r.x1 - r.x0);
      });
      if (prev) {
        matched.add(prev);
        next.push({ x0: Math.min(prev.x0, r.x0), x1: Math.max(prev.x1, r.x1), yTop: prev.yTop, yBot: y });
      } else {
        next.push({ x0: r.x0, x1: r.x1, yTop: y, yBot: y });
      }
    }
    for (const a of active) if (!matched.has(a)) done.push(a);
    active = next;
  }

  const clear = (run: Run, y: number): boolean => {
    if (y < 0 || y >= H) return true;
    const len = run.x1 - run.x0;
    const a = Math.floor(run.x0 + 0.1 * len);
    const b = Math.ceil(run.x1 - 0.1 * len);
    let n = 0;
    for (let x = a; x < b; x++) if (dark(x, y)) n++;
    return n <= 0.04 * Math.max(1, b - a);
  };
  const out: MathRule[] = [];
  for (const r of done) {
    const thickness = r.yBot - r.yTop + 1;
    if (thickness > maxThick) continue;
    if (!clear(r, r.yTop - 1) || !clear(r, r.yBot + 1)) continue;
    out.push({ x0: r.x0, x1: r.x1, y: (r.yTop + r.yBot + 1) / 2, thickness });
  }
  return out;
}
