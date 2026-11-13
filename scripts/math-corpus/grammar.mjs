// A seeded grammar of syntactically valid equations. It widens the corpus far
// beyond what can be hand-written, so a 99.9% claim has enough trials behind
// it. The equations are plausible in shape, not meaningful mathematics; real
// papers are represented by the curated list and (later) the real-paper tier.

export function makeGrammar(seed) {
  let state = seed >>> 0;
  const rnd = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const chance = (p) => rnd() < p;
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  /** Weighted choice among [weight, thunk] pairs. */
  const choose = (pairs) => {
    const total = pairs.reduce((s, [w]) => s + w, 0);
    let r = rnd() * total;
    for (const [w, f] of pairs) {
      r -= w;
      if (r < 0) return f();
    }
    return pairs[pairs.length - 1][1]();
  };

  const LOWER = "abcdfghmnpqrstuvwxyz".split("");
  const UPPER = "ABCDEFGHKLMNPQRSTUVWXYZ".split("");
  const GREEK = [
    "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta", "theta",
    "vartheta", "kappa", "lambda", "mu", "nu", "xi", "pi", "rho", "sigma", "tau", "phi",
    "varphi", "chi", "psi", "omega", "Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi",
    "Sigma", "Phi", "Psi", "Omega",
    // The trailing space ends the control word, so `\alpha` + `b` cannot fuse.
  ].map((g) => `\\${g} `);
  const INDEX = ["i", "j", "k", "n", "m", "0", "1", "2", "ij", "n+1", "k-1", "2n", "i,j", "\\mu\\nu", "\\alpha", "t", "\\max", "\\min"];
  const POWER = ["2", "3", "n", "-1", "n+1", "T", "*", "\\prime", "k", "1/2", "-2", "\\dagger", "(n)", "2k", "m"];
  const REL = ["=", "=", "=", "=", "=", "=", "\\leq ", "\\geq ", "<", ">", "\\neq ", "\\approx ", "\\equiv ", "\\sim ", "\\propto ", "\\simeq ", "\\ll "];
  const SETS = ["\\mathbb{R}", "\\mathbb{N}", "\\mathbb{Z}", "\\mathbb{Q}", "\\mathbb{C}", "A", "B", "S", "X", "\\Omega"];

  const lower = () => pick(LOWER);
  const letter = () => (chance(0.25) ? pick(UPPER) : lower());
  const greek = () => pick(GREEK);
  const base = () => (chance(0.3) ? greek() : letter());
  const br = (s) => (s.length === 1 ? s : `{${s}}`);
  const number = () =>
    choose([
      [6, () => String(int(1, 9))],
      [2, () => String(int(10, 99))],
      [1, () => pick(["0.5", "1.5", "2.5", "0.1", "3.14", "100", "0"])],
    ]);

  const scripted = () => {
    const b = base();
    return choose([
      [35, () => `${b}_${br(pick(INDEX))}`],
      [35, () => `${b}^${br(pick(POWER))}`],
      [20, () => `${b}_${br(pick(INDEX))}^${br(pick(POWER))}`],
      [10, () =>
        pick([
          `${b}_{${lower()}_${br(pick(["i", "j", "k", "0", "1"]))}}`,
          `${b}^{${pick(["2", "x", "n"])}^${br(pick(["2", "n", "k"]))}}`,
          `e^{-${lower()}^2}`,
          `${b}_{${pick(["n", "k", "i"])}}^{(${pick(["k", "n", "0", "1"])})}`,
          `${b}^{${lower()}_${br(pick(["i", "k", "0"]))}}`,
          `2^{${pick(["n", "k"])}^2}`,
          `e^{-\\frac{${lower()}^2}{2${pick(["", "\\sigma ^2", "t"])}}}`,
          `${b}^{\\frac{${pick(["1", "2", "n"])}}{${pick(["2", "3", "n", "k"])}}}`,
          `e^{${pick(["i", "-", ""])}\\frac{${lower()}}{${lower()}}}`,
        ])],
    ]);
  };
  const symbol = () =>
    choose([
      [5, letter],
      [3, greek],
      [5, scripted],
      [1, number],
    ]);

  const accent = () => {
    const a = choose([
      [8, () => `\\${pick(["hat", "bar", "tilde", "vec", "dot", "ddot"])}{${base()}}`],
      [2, () => `\\overline{${pick(UPPER)}${pick(UPPER)}}`],
      [1, () => `\\widehat{${lower()}${lower()}}`],
    ]);
    return chance(0.3) ? `${a}_${br(pick(["i", "j", "k", "n", "0", "1"]))}` : a;
  };
  const font = () =>
    choose([
      // Upright letters: differentials, constants and units.
      [2, () => pick([`\\mathrm{d}${lower()}`, `\\mathrm{e}^${br(lower())}`, `${number()}\\,\\mathrm{${pick(["kg", "m", "s", "eV", "Hz", "mol", "K"])}}`, `\\mathrm{${pick(["T", "i", "c"])}}`])],
      [3, () => `${pick(SETS.slice(0, 5))}${chance(0.3) ? `^${br(pick(["n", "2", "3", "m"]))}` : ""}`],
      [2, () => `\\mathcal{${pick(["L", "H", "F", "O", "N", "A", "S"])}}`],
      [3, () => `\\mathbf{${letter()}}`],
    ]);
  const derivative = () => {
    const f = pick(["f", "u", "y", "\\psi ", "\\phi ", "L", "g"]);
    const x = pick(["x", "t", "r", "z", "s"]);
    return pick([
      `\\frac{d${f}}{d${x}}`,
      `\\frac{\\partial ${f}}{\\partial ${x}}`,
      `\\frac{\\partial^2 ${f}}{\\partial ${x}^2}`,
      `\\frac{d^2${f}}{d${x}^2}`,
      `${pick(["f", "g", "u", "y"])}'(${x})`,
      `${pick(["f", "g", "u"])}''(${x})`,
      `\\nabla ${f}`,
      `\\nabla^2 ${f}`,
      `\\nabla\\cdot\\mathbf{${pick(["v", "E", "B", "F"])}}`,
      `\\frac{\\partial^2 ${f}}{\\partial ${x}\\,\\partial ${pick(["y", "s", "q"])}}`,
    ]);
  };
  const func = (d) => {
    const fn = pick(["sin", "cos", "tan", "ln", "log", "exp", "sinh", "cosh", "arctan"]);
    return choose([
      [4, () => `\\${fn} ${chance(0.5) ? lower() : greek()}`],
      [3, () => `\\${fn}(${expr(d + 1)})`],
      [2, () => `\\${pick(["sin", "cos", "tan"])}^${br(pick(["2", "3", "-1", "n"]))}${greek()}`],
      [1, () => `\\log_${br(pick(["2", "10", "b", "e"]))}${lower()}`],
      [1, () => `\\exp\\left(${expr(d + 1)}\\right)`],
    ]);
  };
  const paren = (d) => {
    const [l, r] = pick([
      ["\\left(", "\\right)"], ["\\left(", "\\right)"], ["\\left(", "\\right)"], ["(", ")"],
      ["\\left[", "\\right]"], ["\\left\\{", "\\right\\}"], ["\\left|", "\\right|"],
      ["\\left\\|", "\\right\\|"], ["\\langle ", "\\rangle "], ["\\lfloor ", "\\rfloor "],
      ["\\lceil ", "\\rceil "],
    ]);
    const tail = chance(0.3) ? `^${br(pick(["2", "n", "-1", "1/2", "k"]))}` : chance(0.1) ? `_${br(pick(["2", "p", "\\infty"]))}` : "";
    return `${l}${expr(d + 1)}${r}${tail}`;
  };
  const frac = (d) =>
    chance(0.2) ? `\\frac${br(number())}${br(number())}` : `\\frac{${expr(d + 1)}}{${expr(d + 1)}}`;
  const sqrt = (d) =>
    chance(0.15) ? `\\sqrt[${pick(["3", "4", "n", "k"])}]{${expr(d + 1)}}` : `\\sqrt{${expr(d + 1)}}`;
  const binom = () => `\\binom{${pick(["n", "m", "2n", "n+1", "N"])}}{${pick(["k", "2", "r", "k-1", "m"])}}`;
  const bigop = (d) => {
    const i = pick(["i", "j", "k", "n", "m"]);
    const hi = pick(["n", "N", "m", "\\infty", "k"]);
    const lo = pick(["0", "1"]);
    const x = pick(["x", "t", "s", "r", "u"]);
    return choose([
      [5, () => `\\${pick(["sum", "sum", "prod"])}_{${i}=${lo}}^${br(hi)}${term(d + 1)}`],
      [2, () => `\\sum_${br(i)}${term(d + 1)}`],
      [1, () => `\\sum_{${i}\\in ${pick(["I", "S", "A"])}}${term(d + 1)}`],
      [1, () => `\\sum_{i<j}${term(d + 1)}`],
      [1, () => `\\${pick(["bigcup", "bigcap"])}_{${i}=1}^${br(hi)}${pick(UPPER)}_${i}`],
      [4, () => `\\int_${br(pick(["0", "a", "-\\infty", "1"]))}^${br(pick(["1", "b", "\\infty", "\\pi", "T"]))}${expr(d + 1)}\\,d${x}`],
      [2, () => `\\int ${expr(d + 1)}\\,d${x}`],
      [1.5, () => `\\int_${br(pick(["0", "a"]))}^${br(pick(["1", "b", "\\infty"]))}${expr(d + 1)}\\,\\mathrm{d}${x}`],
      [1, () => `\\oint_${br(pick(["C", "\\gamma", "\\partial S"]))}${term(d + 1)}\\,d${pick(["z", "s", "l"])}`],
      [3, () => `\\lim_{${x}\\to ${pick(["0", "\\infty", "a", "0^+"])}}${factor(d + 1)}`],
      [2, () => `\\${pick(["max", "min", "sup", "inf"])}_${br(pick([i, `${x}\\in ${pick(["X", "A", "S"])}`, `1\\leq ${i}\\leq n`]))}${factor(d + 1)}`],
    ]);
  };

  function factor(d) {
    const deep = d < 2;
    return choose([
      [10, symbol],
      [deep ? 2 : 0, () => paren(d)],
      [deep ? 2.2 : 0, () => frac(d)],
      [deep ? 1.5 : 0, () => sqrt(d)],
      [2, () => func(Math.max(d, 1))],
      [1, accent],
      [1, font],
      [0.6, binom],
      [0.8, derivative],
      [d === 0 ? 1 : 0, () => bigop(d)],
      [0.8, () => choose([[2, () => `|${expr(2)}|`], [1, () => `\\|${symbol()}\\|${chance(0.5) ? `_${br(pick(["2", "1", "p", "\\infty"]))}` : ""}`]])],
    ]);
  }
  function term(d) {
    const n = d >= 2 ? 1 : choose([[5, () => 1], [4, () => 2], [1, () => 3]]);
    let s = chance(0.3) ? number() : "";
    for (let k = 0; k < n; k++) {
      const f = factor(d);
      // A digit run must not fuse with a following number.
      s += /[0-9]$/.test(s) && /^[0-9]/.test(f) ? `\\cdot ${f}` : f;
    }
    return s;
  }
  function expr(d) {
    const n = d >= 2 ? 1 : d === 1 ? int(1, 2) : choose([[3, () => 1], [5, () => 2], [2, () => 3]]);
    let s = chance(0.1) ? "-" : "";
    for (let k = 0; k < n; k++) {
      if (k > 0) s += pick(["+", "-", "+", "-", "\\pm ", "\\cdot ", "\\times "]);
      s += term(d);
    }
    return s;
  }

  const matrix = () => {
    const env = pick(["pmatrix", "pmatrix", "bmatrix", "vmatrix", "matrix"]);
    const [rows, cols] = pick([[2, 2], [2, 2], [3, 3], [2, 3], [3, 1], [1, 3], [3, 2]]);
    const cell = () =>
      choose([
        [4, letter],
        [3, number],
        [2, () => `${lower()}_{${int(1, 3)}${int(1, 3)}}`],
        [1, () => pick(["0", "1", "-1", "\\lambda ", "\\cos\\theta ", "-\\sin\\theta ", "\\cdots "])],
      ]);
    const body = Array.from({ length: rows }, () => Array.from({ length: cols }, cell).join("&")).join("\\\\");
    const m = env === "matrix" ? `\\left(\\begin{matrix}${body}\\end{matrix}\\right)` : `\\begin{${env}}${body}\\end{${env}}`;
    return choose([
      [4, () => `${pick(UPPER)}=${m}`],
      [2, () => `${m}${pick(["^T", "^{-1}", "^2", ""])}`],
      [2, () => `${m}\\mathbf{${lower()}}=${pick(["\\lambda ", ""])}\\mathbf{${lower()}}`],
      [1, () => `\\det ${m}=${expr(1)}`],
    ]);
  };
  const cases = () => {
    const x = pick(["x", "n", "t", "k"]);
    const cond = () => `${x}${pick(["<", ">", "\\geq ", "\\leq ", "=", "\\neq "])}${pick(["0", "1", "a", "n"])}`;
    const rows = int(2, 3);
    const lines = [];
    for (let r = 0; r < rows; r++) {
      const last = r === rows - 1;
      const c = last && chance(0.5) ? "\\text{otherwise}" : chance(0.5) ? `\\text{if }${cond()}` : cond();
      lines.push(`${expr(1)}&${c}`);
    }
    return `${pick(["f", "g", "h", "u"])}(${x})=\\begin{cases}${lines.join("\\\\")}\\end{cases}`;
  };
  const aligned = () =>
    choose([
      [1, () => `\\begin{aligned}${symbol()}&=${expr(1)}\\\\&=${expr(1)}${chance(0.4) ? `\\\\&=${expr(1)}` : ""}\\end{aligned}`],
      [1, () => `\\begin{aligned}${expr(1)}&=${number()}\\\\${expr(1)}&=${number()}\\end{aligned}`],
    ]);
  const logic = () =>
    choose([
      [2, () => `\\forall ${lower()}\\in ${pick(SETS)},\\ \\exists ${lower()}\\in ${pick(SETS)}:${symbol()}${pick(REL)}${expr(1)}`],
      [2, () => `${pick(UPPER)}\\${pick(["cup", "cap", "setminus", "times"])} ${pick(UPPER)}${pick(["=", "\\subseteq ", "\\subset ", "\\neq "])}${pick([pick(UPPER), "\\emptyset"])}`],
      [1, () => `${lower()}\\${pick(["in", "notin"])} ${pick(SETS)}\\${pick(["Rightarrow", "Leftrightarrow"])} ${symbol()}${pick(REL)}${symbol()}`],
      [1, () => `\\{${lower()}\\in ${pick(SETS)}:${symbol()}${pick(REL)}${number()}\\}`],
      [1, () => `${pick(["p", "q"])}\\${pick(["wedge", "vee"])} \\neg ${pick(["q", "r"])}\\Rightarrow ${pick(["r", "s"])}`],
    ]);
  const stackedRel = () =>
    pick(["\\overset{\\text{def}}{=}", "\\stackrel{?}{=}", "\\overset{!}{=}", "\\underset{n\\to\\infty}{\\longrightarrow}", "\\overset{d}{\\to}"]);
  const relation = () => `${chance(0.5) ? symbol() : expr(0)}${chance(0.04) ? stackedRel() : pick(REL)}${expr(0)}${chance(0.2) ? `${pick(REL)}${expr(1)}` : ""}`;
  const textmix = () => {
    const x = lower();
    return choose([
      [3, () => `${relation()}\\text{ for all }${x}${pick(["\\geq ", ">", "\\in "])}${pick(["0", "1", "\\mathbb{N}"])}`],
      [2, () => `${relation()}\\text{ where }${symbol()}=${expr(1)}`],
      [2, () => `${relation()}\\quad\\text{and}\\quad ${relation()}`],
      [1, () => `${symbol()}${pick(REL)}${symbol()}\\text{ if and only if }${symbol()}${pick(REL)}${symbol()}`],
      [1, () => `${symbol()}\\to ${pick(["0", "\\infty"])}\\text{ as }${x}\\to\\infty`],
    ]);
  };
  const tensor = () => {
    const [a, b, c, e] = ["\\mu", "\\nu", "\\rho", "\\sigma"];
    const T = pick(["T", "F", "g", "R", "A", "h"]);
    return pick([
      `${T}^{${a}${b}}=${T}^{${b}${a}}`,
      `${T}_{${a}${b}}=\\partial_${a} A_${b}-\\partial_${b} A_${a}`,
      `\\partial_${a} ${T}^{${a}${b}}=${pick(["0", `J^${b}`])}`,
      `R^${c}{}_{${e}${a}${b}}=\\partial_${a}\\Gamma^${c}_{${b}${e}}-\\partial_${b}\\Gamma^${c}_{${a}${e}}`,
      `g^{${a}${c}}g_{${c}${b}}=\\delta^${a}_${b}`,
      `${T}_{${a}${b}}${T}^{${a}${b}}=${expr(1)}`,
    ]);
  };

  /** One top-level equation. */
  function equation() {
    return choose([
      [30, relation],
      [8, () => expr(0)],
      [14, () => `${chance(0.6) ? `${scripted()}=` : ""}${bigop(0)}${chance(0.4) ? `${pick(REL)}${expr(1)}` : ""}`],
      [8, matrix],
      [6, cases],
      [6, aligned],
      [6, logic],
      [8, textmix],
      [4, tensor],
      [6, () => `${derivative()}${pick(REL)}${expr(0)}`],
      [4, () => `${paren(0)}${pick(["\\leq ", "\\geq ", "=", "<"])}${expr(0)}`],
    ]);
  }
  return { equation };
}
