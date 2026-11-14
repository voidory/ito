/**
 * Structural normaliser for LaTeX math, used by the box-selection extraction
 * benchmark (docs/LATEX-EXTRACTION-PLAN.md, Phase 1).
 *
 * Two LaTeX strings should compare equal when they typeset the same structure,
 * whatever their spelling: `x^{2}` and `x^2`, `x_i^2` and `x^2_i`, `\le` and
 * `\leq`, `\left(…\right)` and `(…)`, `f'` and `f^{\prime}`. This module parses
 * a LaTeX math string into a small tree and canonicalises it, so "exact match"
 * means "same tree" and partial credit is a tree edit distance (see score.ts).
 *
 * What is deliberately NOT folded, because it is visible on the page:
 *   - font changes (`\mathrm{d}` vs `d`, `\mathbf`, `\mathbb`, `\mathcal`);
 *   - variant letters (`\epsilon` vs `\varepsilon`, `\phi` vs `\varphi`);
 *   - `\bar` (an accent glyph) vs `\overline` (a rule).
 *   - word spaces inside text: `\text{is even}` is not `\text{iseven}`.
 * A font is a property of each character it changes, not of how the source
 * groups them: `\mathbf{AB}` equals `\mathbf{A}\mathbf{B}`, `\mathrm{Te}^b`
 * equals `\mathrm{T}\mathrm{e}^b`, and `\mathrm{c,2}` equals `\mathrm{c},2`
 * because `\mathrm` changes neither the comma nor the digit. Bold italic
 * (`\boldsymbol`) and bold upright (`\mathbf`) are different fonts.
 * What IS folded, because it is spacing or size only: `\,` `\;` `\quad`,
 * `\left`/`\right`/`\big`, `\displaystyle`, `\limits`, `\dfrac`/`\tfrac`,
 * and a space at either end of a text run (`\text{if }x` equals `\text{if}x`:
 * whether that gap is a word space or math spacing is not a structural fact).
 *
 * Pure and dependency-free. It is a benchmark instrument, not a LaTeX engine:
 * unknown commands become opaque symbols rather than errors.
 */

/** A node of the canonical tree: a label and ordered children. */
export interface TexNode {
  readonly t: string;
  readonly c: readonly TexNode[];
}

const leaf = (t: string): TexNode => ({ t, c: [] });
const node = (t: string, c: TexNode[]): TexNode => ({ t, c });
const EMPTY = leaf("empty");
/** A word space inside text-mode content (`\text{is even}`). */
const SPACE = "\u2423";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Commands that only affect spacing, size or style: dropped entirely. */
const IGNORED = new Set([
  ",", ";", ":", "!", " ", "quad", "qquad", "enspace", "thinspace", "medspace", "thickspace",
  "negthinspace", "displaystyle", "textstyle", "scriptstyle", "scriptscriptstyle", "limits",
  "nolimits", "nonumber", "notag", "mathstrut", "strut", "allowbreak", "relax", "protect",
  "big", "Big", "bigg", "Bigg", "bigl", "Bigl", "biggl", "Biggl", "bigr", "Bigr", "biggr", "Biggr",
  "bigm", "Bigm", "biggm", "Biggm", "left", "right", "middle", "bigskip", "medskip", "smallskip",
  "hfill", "centering", "boldmath", "unboldmath",
]);
/** Commands dropped together with one braced argument. */
const IGNORED_WITH_ARG = new Set([
  "label", "tag", "hspace", "vspace", "phantom", "hphantom", "vphantom", "kern", "mkern",
  "mskip", "hskip", "color",
]);
/** Commands that pass their single argument through unchanged. */
const TRANSPARENT = new Set(["boxed", "mathop", "mathbin", "mathrel", "mathord", "mathopen", "mathclose", "mathpunct", "mathinner", "ensuremath", "smash"]);

const FONTS: Readonly<Record<string, string>> = {
  text: "rm", textrm: "rm", mathrm: "rm", operatorname: "rm", textnormal: "rm", mbox: "rm", hbox: "rm",
  textup: "rm", mathbf: "bf", textbf: "bf", boldsymbol: "bm", bm: "bm", pmb: "bm",
  mathbb: "bb", mathcal: "cal", mathscr: "cal", mathfrak: "frak", mathsf: "sf", textsf: "sf",
  mathtt: "tt", texttt: "tt", mathit: "it", textit: "it",
};
/**
 * Font commands whose argument is typeset in text mode, where a space is a
 * word space. In the math-mode ones (`\mathrm`, `\operatorname`) TeX ignores it.
 */
const TEXT_MODE = new Set(["text", "textrm", "textnormal", "mbox", "hbox", "textup", "textbf", "textsf", "texttt", "textit"]);
const ACCENTS: Readonly<Record<string, string>> = {
  hat: "hat", widehat: "hat", tilde: "tilde", widetilde: "tilde", bar: "bar", vec: "vec",
  overrightarrow: "vec", dot: "dot", ddot: "ddot", overline: "overline", underline: "underline",
  check: "check", breve: "breve", acute: "acute", grave: "grave", mathring: "ring",
  overbrace: "overbrace", underbrace: "underbrace",
};
const FRACS = new Set(["frac", "dfrac", "tfrac", "cfrac"]);
const BINOMS = new Set(["binom", "dbinom", "tbinom"]);

/** Upright named operators. `\mathrm{sin}` and `\sin` are the same thing. */
export const FUNCTION_NAMES: ReadonlySet<string> = new Set([
  "sin", "cos", "tan", "cot", "sec", "csc", "sinh", "cosh", "tanh", "coth", "arcsin", "arccos",
  "arctan", "log", "ln", "lg", "exp", "lim", "liminf", "limsup", "max", "min", "sup", "inf",
  "det", "dim", "ker", "arg", "deg", "gcd", "hom", "Pr", "mod",
]);

/** Command spellings of the same symbol -> one canonical command name. */
const SYNONYMS: Readonly<Record<string, string>> = {
  le: "leq", ge: "geq", ne: "neq", to: "rightarrow", gets: "leftarrow", land: "wedge",
  lor: "vee", lnot: "neg", owns: "ni", iff: "Longleftrightarrow", implies: "Longrightarrow",
  impliedby: "Longleftarrow", backslash: "setminus", dotsc: "ldots", dotso: "ldots",
  dotsb: "cdots", dotsm: "cdots", dotsi: "cdots", hslash: "hbar", bot: "perp", dag: "dagger", ddag: "ddagger",
  thicksim: "sim", thickapprox: "approx", bmod: "mod", square: "Box", degree: "circ",
};
/** Binary operators and relations: `\dots` before one of these is `\cdots`. */
const DOTS_CENTRED_BEFORE = new Set([
  "times", "cdot", "pm", "mp", "circ", "oplus", "otimes", "cup", "cap", "wedge", "vee", "leq", "geq",
  "neq", "approx", "equiv", "sim", "simeq", "cong", "propto", "ll", "gg", "subset", "subseteq",
  "supset", "supseteq", "in", "rightarrow", "leftarrow", "Rightarrow", "prec", "succ", "preceq", "succeq",
]);
/** Commands that typeset a plain character (or the double bar `\|`). */
const CMD_TO_LEAF: Readonly<Record<string, string>> = {
  mid: "|", vert: "|", lvert: "|", rvert: "|", Vert: "\\|", lVert: "\\|", rVert: "\\|",
  "|": "\\|", parallel: "\\|", ast: "*", colon: ":", lbrack: "[", rbrack: "]", lbrace: "{",
  rbrace: "}", "{": "{", "}": "}", lparen: "(", rparen: ")", lt: "<", gt: ">", "%": "%",
  "#": "#", $: "$", _: "_",
};

/** Unicode -> the LaTeX command (or plain char) that produces it. */
const UNICODE: Readonly<Record<string, string>> = {
  α: "\\alpha", β: "\\beta", γ: "\\gamma", δ: "\\delta", ϵ: "\\epsilon", ε: "\\varepsilon",
  ζ: "\\zeta", η: "\\eta", θ: "\\theta", ϑ: "\\vartheta", ι: "\\iota", κ: "\\kappa",
  λ: "\\lambda", μ: "\\mu", µ: "\\mu", ν: "\\nu", ξ: "\\xi", π: "\\pi", ϖ: "\\varpi",
  ρ: "\\rho", ϱ: "\\varrho", σ: "\\sigma", ς: "\\varsigma", τ: "\\tau", υ: "\\upsilon",
  ϕ: "\\phi", φ: "\\varphi", χ: "\\chi", ψ: "\\psi", ω: "\\omega",
  Γ: "\\Gamma", Δ: "\\Delta", "∆": "\\Delta", Θ: "\\Theta", Λ: "\\Lambda", Ξ: "\\Xi",
  Π: "\\Pi", Σ: "\\Sigma", Υ: "\\Upsilon", Φ: "\\Phi", Ψ: "\\Psi", Ω: "\\Omega", "\u2126": "\\Omega",
  "∑": "\\sum", "∏": "\\prod", "∐": "\\coprod", "∫": "\\int", "∮": "\\oint", "∬": "\\iint",
  "⋃": "\\bigcup", "⋂": "\\bigcap", "⨁": "\\bigoplus", "⨂": "\\bigotimes",
  "±": "\\pm", "∓": "\\mp", "×": "\\times", "÷": "\\div", "·": "\\cdot", "⋅": "\\cdot",
  "∗": "*", "∘": "\\circ", "∙": "\\bullet", "•": "\\bullet", "⊕": "\\oplus", "⊗": "\\otimes",
  "⊖": "\\ominus", "⊙": "\\odot", "†": "\\dagger", "‡": "\\ddagger", "⋆": "\\star",
  "≤": "\\leq", "≥": "\\geq", "≠": "\\neq", "≈": "\\approx", "≡": "\\equiv", "∝": "\\propto",
  "∼": "\\sim", "≃": "\\simeq", "≅": "\\cong", "≪": "\\ll", "≫": "\\gg", "≺": "\\prec",
  "≻": "\\succ", "⪯": "\\preceq", "⪰": "\\succeq", "≐": "\\doteq", "≍": "\\asymp",
  "∞": "\\infty", "∂": "\\partial", "∇": "\\nabla", "ℏ": "\\hbar", "ℓ": "\\ell", "ℜ": "\\Re",
  "ℑ": "\\Im", "ℵ": "\\aleph", "℘": "\\wp", "ı": "\\imath", "ȷ": "\\jmath",
  "→": "\\rightarrow", "←": "\\leftarrow", "↔": "\\leftrightarrow", "↦": "\\mapsto",
  "⇒": "\\Rightarrow", "⇐": "\\Leftarrow", "⇔": "\\Leftrightarrow", "↑": "\\uparrow",
  "↓": "\\downarrow", "⟶": "\\longrightarrow", "⟵": "\\longleftarrow",
  "⟹": "\\Longrightarrow", "⟸": "\\Longleftarrow", "⟺": "\\Longleftrightarrow",
  "↪": "\\hookrightarrow", "⇌": "\\rightleftharpoons",
  "∈": "\\in", "∉": "\\notin", "∋": "\\ni", "∪": "\\cup", "∩": "\\cap", "∅": "\\emptyset",
  "⊂": "\\subset", "⊃": "\\supset", "⊆": "\\subseteq", "⊇": "\\supseteq", "∖": "\\setminus",
  "∀": "\\forall", "∃": "\\exists", "¬": "\\neg", "∧": "\\wedge", "∨": "\\vee", "⊢": "\\vdash",
  "⊨": "\\models", "⊤": "\\top", "⊥": "\\perp", "∠": "\\angle", "△": "\\triangle",
  "⟨": "\\langle", "⟩": "\\rangle", "〈": "\\langle", "〉": "\\rangle", "⌊": "\\lfloor",
  "⌋": "\\rfloor", "⌈": "\\lceil", "⌉": "\\rceil", "∥": "\\|", "‖": "\\|", "∣": "|",
  "…": "\\ldots", "⋯": "\\cdots", "⋮": "\\vdots", "⋱": "\\ddots", "′": "\\prime",
  "ℝ": "\\mathbb{R}", "ℂ": "\\mathbb{C}", "ℕ": "\\mathbb{N}", "ℤ": "\\mathbb{Z}",
  "ℚ": "\\mathbb{Q}", "−": "-", "–": "-", "—": "-", "‐": "-", "√": "\\sqrt{}", "°": "^{\\circ}",
  "″": "\\prime\\prime",
};

/** Environments that are a grid of cells, and the delimiters they imply. */
const GRID_ENVS: Readonly<Record<string, [string, string] | null>> = {
  matrix: null, smallmatrix: null, array: null, pmatrix: ["(", ")"], bmatrix: ["[", "]"],
  Bmatrix: ["{", "}"], vmatrix: ["|", "|"], Vmatrix: ["\\|", "\\|"], cases: ["{", ""],
  dcases: ["{", ""],
};
/** Environments that are stacked lines; `&` is alignment only. */
const LINE_ENVS = new Set(["aligned", "align", "split", "gathered", "gather", "eqnarray", "multline", "alignedat", "equation", "displaymath"]);

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Tok =
  | { k: "cmd"; v: string }
  | { k: "chr"; v: string }
  | { k: "open" | "close" | "sup" | "sub" | "amp" | "nl" };

function tokenize(src: string): Tok[] {
  // Expand Unicode first so the rest of the pipeline only sees LaTeX.
  let s = "";
  for (const ch of Array.from(src)) {
    const u = UNICODE[ch];
    // A control word needs a terminator; anything else must not gain a space,
    // which would read as a word space inside text.
    s += u == null ? ch : /\\[A-Za-z]+$/.test(u) ? `${u} ` : u;
  }
  const out: Tok[] = [];
  let i = 0;
  // Brace depths at which a text-mode argument opened: inside one, white space
  // is a word space, not source formatting.
  let depth = 0;
  const textAt: number[] = [];
  let pendingText = false;
  const wordSpace = (): void => {
    const last = out[out.length - 1];
    if (!(last?.k === "chr" && last.v === SPACE)) out.push({ k: "chr", v: SPACE });
  };
  while (i < s.length) {
    const ch = s[i]!;
    if (/\s/.test(ch) || ch === "~") {
      i++;
      if (textAt.length > 0) wordSpace();
      continue;
    }
    const textArg = pendingText && ch === "{";
    pendingText = false;
    if (ch === "%") {
      while (i < s.length && s[i] !== "\n") i++;
      continue;
    }
    if (ch === "\\") {
      let j = i + 1;
      while (j < s.length && /[A-Za-z]/.test(s[j]!)) j++;
      if (j === i + 1) {
        const esc = s[j] ?? "";
        j++;
        if (esc === "\\") {
          // `\\[2pt]`: an optional vertical-space argument is not content.
          let k = j;
          while (k < s.length && s[k] === " ") k++;
          if (s[k] === "[" && /^\[[^\]]*(pt|em|ex|mm|cm|in)\]/.test(s.slice(k))) j = s.indexOf("]", k) + 1;
          out.push({ k: "nl" });
        } else if (esc === " " && textAt.length > 0) {
          wordSpace(); // `\ ` is an explicit word space
        } else if (!IGNORED.has(esc)) {
          out.push({ k: "cmd", v: esc });
        }
        i = j;
        continue;
      }
      let name = s.slice(i + 1, j);
      if (s[j] === "*") j++; // starred forms (`\operatorname*`, `align*`)
      // TeX swallows the white space that ends a control word, in any mode.
      while (j < s.length && /\s/.test(s[j]!)) j++;
      i = j;
      if (name === "left" || name === "right" || name === "middle") {
        // `\left.` / `\right.` is an invisible delimiter, not a full stop.
        let k = i;
        while (k < s.length && s[k] === " ") k++;
        if (s[k] === ".") i = k + 1;
      }
      if (name === "cr") {
        out.push({ k: "nl" });
        continue;
      }
      if (IGNORED.has(name)) continue;
      name = name in SYNONYMS ? SYNONYMS[name]! : name;
      out.push({ k: "cmd", v: name });
      pendingText = TEXT_MODE.has(name);
      continue;
    }
    i++;
    if (ch === "{") {
      depth++;
      if (textArg) textAt.push(depth);
      out.push({ k: "open" });
    } else if (ch === "}") {
      if (textAt[textAt.length - 1] === depth) textAt.pop();
      depth = Math.max(0, depth - 1);
      out.push({ k: "close" });
    }
    else if (ch === "^") out.push({ k: "sup" });
    else if (ch === "_") out.push({ k: "sub" });
    else if (ch === "&") out.push({ k: "amp" });
    else out.push({ k: "chr", v: ch });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
  private i = 0;
  private readonly toks: Tok[];
  // No parameter property: the corpus builder imports this file through Node's
  // type stripping, which only erases types.
  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  private peek(): Tok | undefined {
    return this.toks[this.i];
  }

  /** Read `{name}` after `\begin` / `\end`. */
  private envName(): string {
    let name = "";
    if (this.peek()?.k !== "open") return name;
    this.i++;
    while (this.i < this.toks.length && this.peek()!.k !== "close") {
      const t = this.toks[this.i++]!;
      if (t.k === "chr") name += t.v;
      else if (t.k === "cmd") name += t.v;
    }
    this.i++;
    return name.replace(/\*$/, "");
  }

  /** Symbols until a stop token; `stop` is not consumed. */
  row(stop: (t: Tok) => boolean): TexNode[] {
    const out: TexNode[] = [];
    while (this.i < this.toks.length) {
      const t = this.peek()!;
      if (stop(t)) break;
      if (t.k === "close") {
        this.i++; // stray brace: skip rather than fail
        continue;
      }
      if (t.k === "amp" || t.k === "nl") {
        this.i++; // outside an environment these carry no structure
        out.push(leaf(t.k === "nl" ? "\\\\" : "&"));
        continue;
      }
      let base: TexNode | null;
      if (t.k === "sup" || t.k === "sub" || (t.k === "chr" && t.v === "'")) base = EMPTY;
      else base = this.atom();
      if (base == null) continue;
      out.push(this.scripts(base));
    }
    return out;
  }

  /** Attach any `^`, `_` and prime marks following `base`. */
  private scripts(base: TexNode): TexNode {
    const sup: TexNode[] = [];
    const sub: TexNode[] = [];
    for (;;) {
      const t = this.peek();
      if (!t) break;
      if (t.k === "sup") {
        this.i++;
        const arg = this.arg();
        // `x^{'}`: the apostrophe is the prime itself, not a prime on nothing.
        const marks =
          arg.t === "row" && arg.c.length > 0 && arg.c.every((k) => k.t === "script" && k.c[0]!.t === "empty" && k.c[1]!.c.length === 0 && k.c[2]!.c.every((m) => m.t === "\\prime"))
            ? arg.c.flatMap((k) => k.c[2]!.c)
            : null;
        if (marks) sup.push(...marks);
        else sup.push(arg);
      } else if (t.k === "sub") {
        this.i++;
        sub.push(this.arg());
      } else if (t.k === "chr" && t.v === "'") {
        this.i++;
        sup.push(leaf("\\prime"));
      } else break;
    }
    if (sup.length === 0 && sub.length === 0) return base;
    return node("script", [base, node("row", sub), node("row", sup)]);
  }

  /** One argument: a braced group or a single atom. */
  private arg(): TexNode {
    const t = this.peek();
    if (!t) return EMPTY;
    if (t.k === "open") {
      this.i++;
      const inner = this.row((x) => x.k === "close");
      this.i++;
      return node("row", inner);
    }
    if (t.k === "sup" || t.k === "sub" || t.k === "close" || t.k === "amp" || t.k === "nl") return EMPTY;
    return this.atom() ?? EMPTY;
  }

  private atom(): TexNode | null {
    const t = this.toks[this.i++]!;
    if (t.k === "open") {
      const inner = this.row((x) => x.k === "close");
      this.i++;
      return node("row", inner);
    }
    if (t.k === "chr") return leaf(t.v);
    if (t.k !== "cmd") return null;
    const name = t.v;

    if (IGNORED_WITH_ARG.has(name)) {
      this.arg();
      return null;
    }
    if (name === "mathop") {
      // `\mathop{\otimes}\limits_{X}` sets X under the symbol, as `\underset`
      // does (`\limits` itself is dropped with the other layout commands; a
      // displayed `\mathop` takes limits without it).
      const inner = this.arg();
      const symbol = inner.t === "row" && inner.c.length === 1 ? inner.c[0]! : inner;
      if (BIG_OPS.has(symbol.t) || INTEGRALS.has(symbol.t) || symbol.t.startsWith("fn:") || symbol.c.length > 0) return inner;
      let out = inner;
      for (;;) {
        const t = this.peek();
        if (t?.k === "sub") {
          this.i++;
          out = node("under", [out, this.arg()]);
        } else if (t?.k === "sup") {
          this.i++;
          out = node("over", [out, this.arg()]);
        } else break;
      }
      return out;
    }
    if (TRANSPARENT.has(name)) return this.arg();
    if (FRACS.has(name)) return node("frac", [this.arg(), this.arg()]);
    if (BINOMS.has(name)) return node("binom", [this.arg(), this.arg()]);
    if (name === "sqrt") {
      const nx = this.peek();
      if (nx?.k === "chr" && nx.v === "[") {
        this.i++;
        const index = this.row((x) => x.k === "chr" && x.v === "]");
        this.i++;
        return node("root", [node("row", index), this.arg()]);
      }
      return node("sqrt", [this.arg()]);
    }
    if (name in FONTS) return node(`font:${FONTS[name]}`, [this.arg()]);
    if (name in ACCENTS) return node(`accent:${ACCENTS[name]}`, [this.arg()]);
    if (name === "overset" || name === "stackrel") {
      const top = this.arg();
      return node("over", [this.arg(), top]);
    }
    if (name === "underset") {
      const bottom = this.arg();
      return node("under", [this.arg(), bottom]);
    }
    if (name === "not") {
      const nx = this.peek();
      if (nx?.k === "chr" && nx.v === "=") {
        this.i++;
        return leaf("\\neq");
      }
      if (nx?.k === "cmd" && nx.v === "in") {
        this.i++;
        return leaf("\\notin");
      }
      return leaf("\\not");
    }
    if (name === "pmod") {
      // `\pmod{n}` prints "(mod n)".
      return node("row", [leaf("("), leaf("fn:mod"), this.arg(), leaf(")")]);
    }
    // amsmath sets multiple integrals as repeated integral signs.
    if (name === "iint") return node("row", [leaf("\\int"), leaf("\\int")]);
    if (name === "iiint") return node("row", [leaf("\\int"), leaf("\\int"), leaf("\\int")]);
    if (name === "dots") {
      // amsmath's `\dots` looks at what follows: centred before a binary
      // operator or a relation, on the baseline otherwise.
      const nx = this.peek();
      const centred = nx != null && (nx.k === "chr" ? "+-=<>*".includes(nx.v) : nx.k === "cmd" && DOTS_CENTRED_BEFORE.has(SYNONYMS[nx.v] ?? nx.v));
      return centred
        ? node("row", [leaf("\\cdot"), leaf("\\cdot"), leaf("\\cdot")])
        : node("row", [leaf("."), leaf("."), leaf(".")]);
    }
    if (name === "ldots") return node("row", [leaf("."), leaf("."), leaf(".")]);
    if (name === "cdots") return node("row", [leaf("\\cdot"), leaf("\\cdot"), leaf("\\cdot")]);
    if (name === "begin") return this.environment(this.envName());
    if (name === "end") {
      this.envName();
      return null;
    }
    if (FUNCTION_NAMES.has(name)) return leaf(`fn:${name}`);
    if (name in CMD_TO_LEAF) return leaf(CMD_TO_LEAF[name]!);
    return leaf(`\\${name}`);
  }

  private environment(env: string): TexNode {
    if (env === "array" || env === "alignedat") this.arg(); // column spec
    const rows: TexNode[][][] = [[[]]];
    const isEnd = (x: Tok): boolean => x.k === "cmd" && x.v === "end";
    while (this.i < this.toks.length) {
      const cell = this.row((x) => x.k === "amp" || x.k === "nl" || isEnd(x));
      const cur = rows[rows.length - 1]!;
      cur[cur.length - 1]!.push(...cell);
      const t = this.peek();
      if (!t) break;
      this.i++;
      if (t.k === "amp") cur.push([]);
      else if (t.k === "nl") rows.push([[]]);
      else {
        this.envName();
        break;
      }
    }
    // A trailing `\\` leaves an empty last row.
    const kept = rows.filter((r, idx) => idx < rows.length - 1 || r.some((c) => c.length > 0));
    if (LINE_ENVS.has(env)) {
      return node("lines", kept.map((r) => node("row", r.flat())));
    }
    const grid = node(
      "matrix",
      kept.map((r) => node("mrow", r.map((c) => node("row", c)))),
    );
    const delims = GRID_ENVS[env];
    if (!delims) return grid;
    return node("row", [leaf(delims[0]), grid, ...(delims[1] ? [leaf(delims[1])] : [])]);
  }
}

// ---------------------------------------------------------------------------
// Canonicalisation
// ---------------------------------------------------------------------------

function letters(n: TexNode): string | null {
  if (n.c.length === 0) return /^[A-Za-z]$/.test(n.t) ? n.t : null;
  if (n.t !== "row") return null;
  let s = "";
  for (const c of n.c) {
    const l = letters(c);
    if (l == null) return null;
    s += l;
  }
  return s;
}

/** Drop word spaces at either end of a run and collapse repeats inside it. */
function trimSpaces(kids: readonly TexNode[]): TexNode[] {
  const out: TexNode[] = [];
  for (const k of kids) {
    if (k.t === SPACE && (out.length === 0 || out[out.length - 1]!.t === SPACE)) continue;
    out.push(k);
  }
  while (out.length > 0 && out[out.length - 1]!.t === SPACE) out.pop();
  return out;
}

const UPPER_GREEK = new Set(["\\Gamma", "\\Delta", "\\Theta", "\\Lambda", "\\Xi", "\\Pi", "\\Sigma", "\\Upsilon", "\\Phi", "\\Psi", "\\Omega"]);

/**
 * The font a character really ends up in under a font command, or null when
 * the command does not change it. `\mathrm{c,2}` changes the `c` only: the
 * comma and the digit are the glyphs they would be outside. `\mathbf` leaves
 * lowercase Greek and symbols alone; `\boldsymbol` emboldens everything, and
 * for digits and capital Greek gives exactly what `\mathbf` gives.
 */
function fontOn(font: string, symbol: string): string | null {
  if (/^[A-Za-z]$/.test(symbol)) return font;
  const letterOnly = font === "cal" || font === "bb" || font === "frak";
  if (/^[0-9]$/.test(symbol) || UPPER_GREEK.has(symbol)) {
    if (font === "rm" || letterOnly) return null;
    return font === "bm" ? "bf" : font;
  }
  if (symbol === SPACE || symbol === "empty") return null;
  return font === "bm" ? "bm" : null;
}

/** Apply a font to every character under `n` that it changes. An inner font command wins. */
function pushFont(font: string, n: TexNode): TexNode {
  // Bold round italic, or italic round bold, is bold italic: `\textbf{\textit{p}}`.
  if ((font === "bf" && n.t === "font:it") || (font === "it" && n.t === "font:bf")) return node("font:bm", [...n.c]);
  if (n.t.startsWith("font:")) return n;
  if (n.c.length === 0) {
    const f = fontOn(font, n.t);
    return f ? node(`font:${f}`, [n]) : n;
  }
  return regroupIfRow(node(n.t, n.c.map((c) => pushFont(font, c))));
}
const regroupIfRow = (n: TexNode): TexNode => (n.t === "row" ? regroup(n.c) : n);

/**
 * A row's children with neighbouring characters of one font gathered into one
 * group, so `\mathbf{A}\mathbf{B}` and `\mathbf{AB}` are the same tree. A
 * word space survives only between two groups of one font, where it joins
 * them into one piece of text.
 */
function regroup(kids: readonly TexNode[]): TexNode {
  const flat = kids.filter((k) => k.t !== "empty").flatMap((k) => (k.t === "row" ? k.c : [k]));
  const out: TexNode[] = [];
  for (let i = 0; i < flat.length; i++) {
    const k = flat[i]!;
    const prev = out[out.length - 1];
    if (k.t === SPACE) {
      const next = flat[i + 1];
      if (prev && next && prev.t.startsWith("font:") && next.t === prev.t) out[out.length - 1] = node(prev.t, [...prev.c, k]);
      continue;
    }
    if (prev && k.t === prev.t && k.t.startsWith("font:")) out[out.length - 1] = node(k.t, [...prev.c, ...k.c]);
    else out.push(k);
  }
  if (out.length === 0) return EMPTY;
  return out.length === 1 ? out[0]! : node("row", out);
}

/**
 * Settle word spaces once adjacent text runs have been merged (which is why
 * `canon` leaves them alone): `\text{for }\text{all}` must keep its space.
 */
function settleSpaces(n: TexNode): TexNode {
  if (n.c.length === 0) return n;
  const kids = n.c.map(settleSpaces);
  if (n.t.startsWith("font:")) {
    const kept = trimSpaces(kids);
    if (kept.length === 0) return EMPTY;
    // A font is a property of each character it changes, not of the group.
    const font = n.t.slice(5);
    return regroup(kept.map((k) => pushFont(font, k)));
  }
  if (n.t === "row") return regroup(kids);
  // A script on a font group sits on the group's last character: on the page,
  // `\mathrm{Te}^b` and `\mathrm{T}\mathrm{e}^b` are the same thing.
  const base = kids[0];
  if (n.t === "script" && base && base.t.startsWith("font:") && base.c.length > 1) {
    const last = base.c[base.c.length - 1]!;
    return node("row", [
      node(base.t, base.c.slice(0, -1)),
      node("script", [node(base.t, [last]), ...kids.slice(1)]),
    ]);
  }
  return node(n.t, kids);
}

function canon(n: TexNode): TexNode {
  // A childless row is an absent script / empty group, not a symbol.
  if (n.c.length === 0) return n.t === "row" ? EMPTY : n;
  let kids = n.c.map(canon);

  if (n.t === "row") {
    // Flatten nested rows, split stray top-level `\\` into lines, merge runs of
    // upright text, and unwrap a row of one.
    const flat: TexNode[] = [];
    for (const k of kids) {
      if (k.t === "row") flat.push(...k.c);
      else if (k.t !== "empty") flat.push(k);
    }
    const merged: TexNode[] = [];
    for (const k of flat) {
      const prev = merged[merged.length - 1];
      if (k.t === "font:rm" && prev && prev.t === "font:rm") {
        merged[merged.length - 1] = canon(node("font:rm", [node("row", [...prev.c, ...k.c])]));
      } else merged.push(k);
    }
    if (merged.some((k) => k.t === "\\\\")) {
      const lines: TexNode[][] = [[]];
      for (const k of merged) {
        if (k.t === "\\\\") lines.push([]);
        else if (k.t !== "&") lines[lines.length - 1]!.push(k);
      }
      const rows = lines.filter((l) => l.length > 0).map((l) => canon(node("row", l)));
      return rows.length === 1 ? rows[0]! : node("lines", rows);
    }
    // `r'{}_A^{(p)}`: scripts set on nothing right after a primed symbol are
    // that symbol's own scripts, which is how they print.
    for (let i = merged.length - 1; i > 0; i--) {
      const here = merged[i]!;
      const prev = merged[i - 1]!;
      const primes = (n: TexNode): boolean => n.t === "\\prime" || (n.t === "row" && n.c.length > 0 && n.c.every((k) => k.t === "\\prime"));
      if (here.t !== "script" || here.c[0]!.t !== "empty" || prev.t !== "script" || prev.c[1]!.t !== "empty" || !primes(prev.c[2]!)) continue;
      const marks = prev.c[2]!.t === "row" ? prev.c[2]!.c : [prev.c[2]!];
      const sup = here.c[2]!.t === "empty" ? [] : here.c[2]!.t === "row" ? here.c[2]!.c : [here.c[2]!];
      merged.splice(i - 1, 2, canon(node("script", [prev.c[0]!, here.c[1]!, node("row", [...marks, ...sup])])));
    }
    const clean = merged.filter((k) => k.t !== "&");
    if (clean.length === 0) return EMPTY;
    return clean.length === 1 ? clean[0]! : node("row", clean);
  }

  if (n.t === "font:rm") {
    const inner = trimSpaces(kids[0]?.t === "row" ? kids[0].c : kids);
    const word = letters(node("row", inner));
    if (word != null && FUNCTION_NAMES.has(word)) return leaf(`fn:${word}`);
    if (kids[0]?.t === "empty") return EMPTY;
    // Children of a font node are its symbols, without a wrapping row.
    return node(n.t, kids[0]!.t === "row" ? [...kids[0]!.c] : kids);
  }
  if (n.t.startsWith("font:")) {
    if (kids[0]?.t === "empty") return EMPTY;
    return node(n.t, kids[0]!.t === "row" ? [...kids[0]!.c] : kids);
  }

  if (n.t === "script") {
    let [base, sub, sup] = kids as [TexNode, TexNode, TexNode];
    // `{x_i}^2` and `x_i^2` differ only in script placement.
    if (base.t === "script") {
      const [b2, sub2, sup2] = base.c as [TexNode, TexNode, TexNode];
      if (sub.t === "empty" && sup2.t === "empty") {
        base = b2;
        sub = sub2;
      } else if (sup.t === "empty" && sub2.t === "empty") {
        base = b2;
        sup = sup2;
      }
    }
    // `{A'}_v^{(a)}`: the prime and the superscript share one raised line.
    if (base.t === "script" && sup.t !== "empty") {
      const [b2, sub2, sup2] = base.c as [TexNode, TexNode, TexNode];
      const marks = sup2.t === "\\prime" ? [sup2] : sup2.t === "row" && sup2.c.length > 0 && sup2.c.every((k) => k.t === "\\prime") ? sup2.c : null;
      if (marks && sub2.t === "empty") {
        base = b2;
        sup = canon(node("row", [...marks, ...(sup.t === "row" ? sup.c : [sup])]));
      }
    }
    if (sub.t === "empty" && sup.t === "empty") return base;
    // `\iint_S`: the bounds belong to the last of the repeated signs.
    if (base.t === "row" && base.c.every((k) => k.t === "\\int")) {
      const last = base.c.length - 1;
      return node("row", [...base.c.slice(0, last), node("script", [base.c[last]!, sub, sup])]);
    }
    return node("script", [base, sub, sup]);
  }

  if (n.t === "lines") {
    kids = kids.filter((k) => k.t !== "empty");
    if (kids.length === 0) return EMPTY;
    return kids.length === 1 ? kids[0]! : node("lines", kids);
  }
  if (n.t === "matrix") {
    // A 1x1 grid is just its cell.
    if (kids.length === 1 && kids[0]!.c.length === 1) return kids[0]!.c[0]!;
  }
  return node(n.t, kids);
}

const SENTENCE_MARKS = new Set([",", ".", ";", ":"]);
/**
 * A comma, full stop, semicolon or colon that ends a formula (or a line of a
 * several-line one) belongs to the sentence around it, not to the formula:
 * `E = mc^2.` and `E = mc^2` are the same formula. An extractor may drop the
 * mark or keep it.
 */
function dropSentenceMark(n: TexNode): TexNode {
  if (n.t === "lines") return node("lines", n.c.map(dropSentenceMark));
  if (n.t !== "row") return n;
  let end = n.c.length;
  while (end > 1 && SENTENCE_MARKS.has(n.c[end - 1]!.t) && n.c[end - 1]!.c.length === 0) end--;
  if (end === n.c.length) return n;
  return end === 1 ? n.c[0]! : node("row", n.c.slice(0, end));
}

/** Parse a LaTeX math string into its canonical tree. Never throws. */
export function parseLatex(src: string): TexNode {
  const stripped = (src ?? "")
    .trim()
    .replace(/^\$\$?|\$\$?$/g, "")
    .replace(/^\\\[|\\\]$/g, "")
    .replace(/^\\\(|\\\)$/g, "");
  try {
    const p = new Parser(tokenize(stripped));
    return dropSentenceMark(settleSpaces(canon(node("row", p.row(() => false)))));
  } catch {
    return leaf("unparsed");
  }
}

/** Canonical one-line form of a tree: equal strings mean equal structure. */
export function serialize(n: TexNode): string {
  return n.c.length === 0 ? n.t : `${n.t}(${n.c.map(serialize).join(" ")})`;
}

/** Canonical form of a LaTeX string; the unit of "exact match". */
export function canonicalLatex(src: string): string {
  return serialize(parseLatex(src));
}

export function treeSize(n: TexNode): number {
  let s = 1;
  for (const c of n.c) s += treeSize(c);
  return s;
}

// ---------------------------------------------------------------------------
// Construct tags
// ---------------------------------------------------------------------------

const BIG_OPS = new Set(["\\sum", "\\prod", "\\coprod", "\\bigcup", "\\bigcap", "\\bigoplus", "\\bigotimes", "\\bigvee", "\\bigwedge"]);
const INTEGRALS = new Set(["\\int", "\\oint", "\\iint", "\\iiint"]);
const LIMIT_FNS = new Set(["fn:lim", "fn:max", "fn:min", "fn:sup", "fn:inf", "fn:liminf", "fn:limsup"]);
const GREEK = /^\\(alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|kappa|lambda|mu|nu|xi|pi|varpi|rho|varrho|sigma|varsigma|tau|upsilon|phi|varphi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega)$/;
const TALL = new Set(["frac", "binom", "matrix", "sqrt", "root", "lines"]);

const CLOSERS: Readonly<Record<string, string>> = {
  "(": ")", "[": "]", "{": "}", "|": "|", "\\|": "\\|", "\\langle": "\\rangle",
  "\\lfloor": "\\rfloor", "\\lceil": "\\rceil",
};
/** A closing bracket may carry a script (`)^2`); look through it. */
const unscripted = (n: TexNode): TexNode => (n.t === "script" ? n.c[0]! : n);

/**
 * The constructs an equation exercises, derived from its tree. The benchmark
 * reports accuracy per tag, so a regression points at what broke.
 */
export function constructsOf(n: TexNode): string[] {
  const tags = new Set<string>();
  const hasTall = (x: TexNode): boolean => TALL.has(x.t) || x.c.some(hasTall);
  const walk = (x: TexNode, inScript: boolean, inFrac: boolean): void => {
    if (x.t === "script") {
      const [base, sub, sup] = x.c as [TexNode, TexNode, TexNode];
      const isOp = BIG_OPS.has(base.t) || LIMIT_FNS.has(base.t);
      if (isOp) tags.add("limits");
      else if (INTEGRALS.has(base.t)) tags.add("integral-bounds");
      else tags.add("script");
      if (sub.t !== "empty" && sup.t !== "empty" && !isOp) tags.add("sub+sup");
      if (inScript) tags.add("nested-script");
      if (sup.t === "\\prime" || (sup.t === "row" && sup.c.some((k) => k.t === "\\prime"))) tags.add("prime");
      walk(base, inScript, inFrac);
      walk(sub, true, inFrac);
      walk(sup, true, inFrac);
      return;
    }
    if (x.t === "frac") {
      tags.add("fraction");
      if (inFrac) tags.add("nested-fraction");
      if (inScript) tags.add("fraction-in-script");
      x.c.forEach((k) => walk(k, inScript, true));
      return;
    }
    if (x.t === "sqrt") tags.add("radical");
    else if (x.t === "root") tags.add("root-index");
    else if (x.t === "binom") tags.add("binomial");
    else if (x.t === "matrix") tags.add(x.c.some((r) => r.c.some((c) => c.t.startsWith("font:rm") || (c.t === "row" && c.c.some((k) => k.t === "font:rm")))) ? "cases" : "matrix");
    else if (x.t === "lines") tags.add("multi-line");
    else if (x.t.startsWith("accent:")) tags.add(x.t === "accent:overline" || x.t === "accent:underline" ? "overline" : "accent");
    else if (x.t === "over" || x.t === "under") tags.add("stacked-symbol");
    else if (x.t === "font:rm") tags.add(x.c.length > 1 ? "text" : "upright-letter");
    else if (x.t.startsWith("font:")) tags.add(`font-${x.t.slice(5)}`);
    else if (x.t.startsWith("fn:")) tags.add("function");
    else if (BIG_OPS.has(x.t)) tags.add("big-operator");
    else if (INTEGRALS.has(x.t)) tags.add("integral");
    else if (GREEK.test(x.t)) tags.add("greek");
    else if (x.t === "row") {
      // A bracket pair that encloses something tall must have been stretched.
      x.c.forEach((k, i) => {
        const open = unscripted(k).t;
        const close = CLOSERS[open];
        if (close == null) return;
        let depth = 0;
        for (let j = i + 1; j < x.c.length; j++) {
          const t = unscripted(x.c[j]!).t;
          if (t === close && depth === 0) {
            if (x.c.slice(i + 1, j).some(hasTall)) tags.add("tall-delimiter");
            return;
          }
          if (t === open) depth++;
          else if (t === close) depth--;
        }
      });
    }
    x.c.forEach((k) => walk(k, inScript, inFrac));
  };
  walk(n, false, false);
  if (tags.size === 0) tags.add("plain");
  return [...tags].sort();
}
