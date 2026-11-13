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
  "∆": "\\Delta", "µ": "\\mu", "ϵ": "\\epsilon", "ϕ": "\\phi", "ϑ": "\\theta",
  "%": "\\%", "#": "\\#", "&": "\\&", "$": "\\$", "{": "\\{", "}": "\\}",
};

const GREEK: Readonly<Record<string, string>> = {
  α: "\\alpha", β: "\\beta", γ: "\\gamma", δ: "\\delta", ε: "\\epsilon",
  ζ: "\\zeta", η: "\\eta", θ: "\\theta", ι: "\\iota", κ: "\\kappa",
  λ: "\\lambda", μ: "\\mu", ν: "\\nu", ξ: "\\xi", ο: "o", π: "\\pi",
  ρ: "\\rho", σ: "\\sigma", ς: "\\sigma", τ: "\\tau", υ: "\\upsilon", φ: "\\phi",
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
  "arg", "deg", "gcd", "mod",
]);
/** Short prose words that only count as text next to another text word. */
const STOPWORDS = new Set([
  "the", "and", "for", "is", "of", "in", "to", "if", "or", "at", "on", "as", "by", "we",
  "an", "be", "so", "are", "let", "all", "any", "not", "a",
]);

/** Operators whose scripts sit above/below them (display limits). */
const LIMIT_OPS = new Set(["∑", "∏", "⋃", "⋂"]);
const LIMIT_WORDS = new Set(["\\lim", "\\max", "\\min", "\\sup", "\\inf"]);
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

type BoxKind = "glyph" | "frac" | "sqrt" | "over" | "word" | "text";

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
  return b.kind === "glyph" && b.ch != null && ANCHOR_CHARS.has(b.ch);
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

/** Boxes stacked contiguously away from a rule (up: dir = -1, down: dir = +1). */
function chainFrom(cands: Box[], y: number, dir: -1 | 1, s: number): Box[] {
  const out: Box[] = [];
  let edge = y;
  if (dir < 0) {
    for (const b of [...cands].sort((a, c) => c.bottom - a.bottom)) {
      if (edge - b.bottom > 0.35 * s) break;
      out.push(b);
      edge = Math.min(edge, b.top);
    }
  } else {
    for (const b of [...cands].sort((a, c) => a.top - c.top)) {
      if (b.top - edge > 0.35 * s) break;
      out.push(b);
      edge = Math.max(edge, b.bottom);
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
    const cands = boxes.filter((b) => {
      const c = cx(b);
      return c >= rule.x0 - 0.15 * s && c <= rule.x1 + 0.15 * s;
    });
    const mid = (b: Box): number => (b.kind === "glyph" ? b.base - 0.3 * b.size : (b.top + b.bottom) / 2);
    const above = chainFrom(cands.filter((b) => mid(b) < rule.y), rule.y, -1, s);
    const isSurd = (b: Box): boolean => b.kind === "glyph" && b.ch === "√";
    let below = chainFrom(cands.filter((b) => mid(b) >= rule.y), rule.y, 1, s);
    // A radical sign at the rule's left end belongs to the rule, not under it.
    if (above.length === 0) below = below.filter((b) => !(isSurd(b) && cx(b) <= rule.x0 + 0.3 * s));
    if (below.length === 0) continue;

    const consumed = new Set<Box>([...above, ...below]);
    const nested = (set: Box[]): MathRule[] => {
      const bb = bbox(set);
      return pending.filter((r) => {
        const c = (r.x0 + r.x1) / 2;
        return c >= bb.x0 && c <= bb.x1 && r.y >= bb.top && r.y <= bb.bottom;
      });
    };
    let made: Box | null = null;
    let used: MathRule[] = [];

    if (above.length > 0) {
      if (!boundedByRule(above, boxes, rule, s) || !boundedByRule(below, boxes, rule, s)) continue;
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
      const bigBases = below.filter((b) => b.size >= 0.8 * size).map((b) => b.base);
      const base = median(bigBases);
      const surd = boxes.find(
        (b) =>
          isSurd(b) && !consumed.has(b) &&
          cx(b) >= rule.x0 - 1.3 * s && cx(b) <= rule.x0 + 0.3 * s &&
          Math.abs(b.base - rule.y) < 2.5 * s,
      );
      const nB = nested(below);
      if (surd) {
        consumed.add(surd);
        used = nB;
        made = {
          x0: Math.min(surd.x0, bb.x0), x1: Math.max(rule.x1, bb.x1), top: Math.min(rule.y, bb.top),
          bottom: bb.bottom, base, size, tex: `\\sqrt{${build(below, nB, false)}}`, kind: "sqrt",
        };
      } else if (
        below.length <= 8 &&
        rule.y <= base - 0.75 * size && rule.y >= base - 1.4 * size &&
        rule.x1 - rule.x0 <= 1.4 * (bb.x1 - bb.x0) + 0.3 * s
      ) {
        used = nB;
        made = {
          x0: bb.x0, x1: bb.x1, top: Math.min(rule.y, bb.top), bottom: bb.bottom, base, size,
          tex: `\\overline{${build(below, nB, false)}}`, kind: "over",
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
  const plain = boxes.filter((b) => !isAnchor(b));
  const pool = plain.length > 0 ? plain : boxes;
  const maxS = Math.max(...pool.map((b) => b.size));
  const large = pool.filter((b) => b.size >= 0.8 * maxS).sort((a, b) => a.base - b.base);
  const lines: Line[] = [];
  let cur: Box[] = [];
  let mean = 0;
  for (const b of large) {
    if (cur.length > 0 && b.base - mean > 0.4 * maxS) {
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
  const rest = boxes.filter((b) => !largeSet.has(b)).sort((a, b) => Number(isAnchor(b)) - Number(isAnchor(a)));
  for (const b of rest) {
    let best = -1;
    let bestD = Infinity;
    lines.forEach((l, i) => {
      // Operator-font glyphs hang from their origin: compare against mid-line.
      const ref = isAnchor(b) ? l.base - 0.5 * l.size : l.base;
      const d = Math.abs(b.base - ref);
      const e = bbox(l.boxes);
      if (d > 1.7 * l.size || cx(b) < e.x0 - 1.2 * l.size || cx(b) > e.x1 + 1.2 * l.size) return;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best >= 0) lines[best]!.boxes.push(b);
    else leftover.push(b);
  }
  if (leftover.length > 0 && leftover.length < boxes.length) lines.push(...splitLines(leftover));
  else if (leftover.length > 0) lines.push(makeLine(leftover));
  return lines.sort((a, b) => a.base - b.base);
}

function makeLine(large: Box[]): Line {
  return {
    boxes: [...large],
    large: new Set(large),
    base: median(large.map((b) => b.base)),
    size: median(large.map((b) => b.size)),
  };
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
          l.boxes.some((x) => x.ch != null && l.large.has(x) && "=<>≤≥≈≡→".includes(x.ch));
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
  return b.kind === "glyph" && b.ch != null && /^[A-Za-z]$/.test(b.ch);
}

function mergedBox(run: Box[], tex: string, kind: BoxKind): Box {
  const bb = bbox(run);
  return { ...bb, base: run[0]!.base, size: run[0]!.size, tex, kind };
}

/** Fuse adjacent letters into function names (`\sin`) and prose (`\text{…}`). */
function mergeWords(mains: Box[], size: number): Box[] {
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
  const all = [...line.boxes].sort((a, b) => a.x0 - b.x0);
  const mainsRaw: Box[] = [];
  const scripts: Box[] = [];
  for (const b of all) {
    const d = (line.base - b.base) / s;
    const tol = b.kind === "frac" ? 0.3 : b.size <= 0.85 * s ? 0.08 : 0.28;
    if (line.large.has(b) || isAnchor(b) || Math.abs(d) <= tol) mainsRaw.push(b);
    else scripts.push(b);
  }
  if (mainsRaw.length === 0) return joinTex(all.map((b) => b.tex));
  const mains = mergeWords(mainsRaw, s);

  // Connected runs of off-baseline glyphs: each is one script (or one limit).
  const parent = scripts.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < scripts.length; i++) {
    for (let j = i + 1; j < scripts.length; j++) {
      const a = scripts[i]!;
      const b = scripts[j]!;
      const gap = Math.max(0, b.x0 - a.x1, a.x0 - b.x1);
      if (gap < 0.3 * s && Math.abs(a.base - b.base) < 0.45 * Math.max(a.size, b.size)) {
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

  const sups = new Map<Box | null, Box[]>();
  const subs = new Map<Box | null, Box[]>();
  for (const g of groups.values()) {
    const bb = bbox(g);
    const c = cx(bb);
    const isAbove = median(g.map((b) => b.base)) < line.base;
    let host: Box | null =
      mains.find(
        (m) =>
          ((m.kind === "glyph" && m.ch != null && LIMIT_OPS.has(m.ch)) || LIMIT_WORDS.has(m.tex)) &&
          c >= m.x0 - 0.2 * s && c <= m.x1 + 0.2 * s,
      ) ?? null;
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
    let tex = m.tex;
    if (m.kind === "text") {
      // Keep the word spacing that the surrounding math would otherwise eat.
      tex = `\\text{${i > 0 ? " " : ""}${tex.slice(6, -1)}${i < mains.length - 1 ? " " : ""}}`;
    }
    parts.push(tex + script(m));
  });
  return joinTex(parts);
}

function build(boxes: Box[], rules: readonly MathRule[], allowStack: boolean): string {
  const structured = rules.length > 0 ? applyRules(boxes, rules) : boxes;
  let lines = splitLines(structured);
  if (allowStack) lines = mergeStackedFractions(lines);
  return lines.map(lineToTex).filter((t) => t.length > 0).join(" \\\\ ");
}

/**
 * Drop rules that are really the stroke of a bar-shaped glyph (`−`, `=`, …) or
 * too short/thick to be a fraction bar, given the glyphs they sit among.
 */
function usableRules(boxes: Box[], rules: readonly MathRule[]): MathRule[] {
  if (boxes.length === 0) return [];
  const s = median(boxes.map((b) => b.size));
  return rules.filter((r) => {
    const len = r.x1 - r.x0;
    if (len < 0.4 * s) return false;
    if (r.thickness != null && r.thickness > Math.max(0.16 * s, 1.5)) return false;
    return !boxes.some((b) => {
      if (b.ch == null || !BAR_CHARS.has(b.ch)) return false;
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
export function glyphsToLatex(glyphs: readonly MathGlyph[], rules: readonly MathRule[] = []): string {
  const boxes = toBoxes(glyphs);
  if (boxes.length === 0) return "";
  const good = usableRules(boxes, rules);
  return build(boxes, good, good.length === 0).replace(/\s+/g, " ").trim();
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
