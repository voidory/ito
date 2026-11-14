// Generate src/pdf/texFontSlots.ts: which LaTeX command each slot of TeX's
// Computer Modern and AMS fonts is (docs/LATEX-EXTRACTION-PLAN.md, Phase 2).
//
// The table is not typed by hand and not derived from glyph names. This script
// asks TeX: it typesets every command in the lists below on a page of its own,
// reads the page back with the same page model the reader uses
// (src/pdf/pageMathModel.ts), and records which font slots appeared.
//
//   one glyph            -> a slot entry: (family, slot) -> command, class, style
//   several glyphs       -> a composite: `\notin` is `\in` with a slash over it
//   a growing delimiter  -> its size variants, and the pieces of its built-up form
//   an accent over `x`   -> the accent's slot
//
// A style (`\mathbf`, `\mathcal`, `\text`...) is recorded for a slot only when
// the unstyled command does not already land there, so `1` in `\mathrm{1}`
// stays a plain digit and `a` in `\mathrm{a}` is upright.
//
// The vertical ink extent of every slot is copied from TeX's own AFM metric
// files, because a PDF gives advances but not heights, and operators and
// delimiters hang far below their baseline.
//
// Needs `pdflatex` and `kpsewhich` (texlive-latex-base, texlive-latex-recommended,
// texlive-fonts-recommended). Only this script needs them: its output is
// committed. Run with `npm run gen-tex-font-slots`. Needs Node 22.18+.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildPageMathModel } from "../src/pdf/pageMathModel.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../src/pdf/texFontSlots.ts");

// ---------------------------------------------------------------------------
// What to ask TeX. Order is priority: the first command to claim a slot keeps it.
// ---------------------------------------------------------------------------

const words = (s) => s.split(/\s+/).filter(Boolean);
const LOWER = "abcdefghijklmnopqrstuvwxyz".split("");
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const DIGITS = "0123456789".split("");

const GREEK_LOWER = words(`alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa
  lambda mu nu xi pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega`);
const GREEK_UPPER = words("Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega");

/** [source, emitted LaTeX, class] for plain characters. */
const CHARS = [
  ["+", "+", "bin"], ["-", "-", "bin"], ["=", "=", "rel"], ["<", "<", "rel"], [">", ">", "rel"],
  ["/", "/", "ord"], ["|", "|", "fence"], ["\\|", "\\|", "fence"], ["(", "(", "open"], [")", ")", "close"],
  ["[", "[", "open"], ["]", "]", "close"], ["\\{", "\\{", "open"], ["\\}", "\\}", "close"],
  ["*", "*", "bin"], [",", ",", "punct"], [";", ";", "punct"], [".", ".", "ord"], [":", ":", "rel"],
  ["!", "!", "close"], ["?", "?", "close"], ["\\%", "\\%", "ord"], ["\\#", "\\#", "ord"],
  ["\\langle", "\\langle", "open"], ["\\rangle", "\\rangle", "close"], ["\\lfloor", "\\lfloor", "open"],
  ["\\rfloor", "\\rfloor", "close"], ["\\lceil", "\\lceil", "open"], ["\\rceil", "\\rceil", "close"],
  ["\\&", "\\&", "ord"], ["\\$", "\\$", "ord"], ["\\_", "\\_", "ord"], ["{}^{\\prime}", "\\prime", "ord"],
];

const ORD = words(`infty partial nabla hbar ell Re Im aleph wp imath jmath emptyset varnothing forall
  exists nexists neg top bot angle triangle flat natural sharp clubsuit diamondsuit heartsuit
  spadesuit Box Diamond blacksquare lozenge bigstar complement eth mho Finv Game beth gimel
  daleth hslash measuredangle sphericalangle diagup diagdown backprime varkappa digamma Bbbk
  circledS triangledown blacktriangle blacktriangledown blacklozenge S P checkmark
  maltese varGamma varDelta varTheta varLambda varXi varPi varSigma varUpsilon varPhi varPsi
  varOmega ldots cdots vdots ddots colon`);
const BIN = words(`pm mp times div cdot star circ bullet oplus ominus otimes oslash odot dagger
  ddagger cap cup uplus sqcap sqcup vee wedge setminus wr diamond bigtriangleup bigtriangledown
  triangleleft triangleright bigcirc amalg dotplus smallsetminus Cap Cup barwedge veebar
  doublebarwedge boxminus boxtimes boxdot boxplus divideontimes ltimes rtimes leftthreetimes
  rightthreetimes curlywedge curlyvee circleddash circledast circledcirc centerdot intercal`);
const REL = words(`leq geq equiv prec succ sim preceq succeq simeq ll gg asymp subset supset approx
  subseteq supseteq cong sqsubseteq sqsupseteq bowtie in ni propto vdash dashv models smile frown
  doteq perp neq notin leqslant geqslant lesssim gtrsim lessapprox gtrapprox approxeq lessgtr
  gtrless lll ggg leqq geqq subseteqq supseteqq Subset Supset sqsubset sqsupset preccurlyeq
  succcurlyeq curlyeqprec curlyeqsucc precsim succsim vartriangleleft vartriangleright
  trianglelefteq trianglerighteq vDash Vdash Vvdash therefore because triangleq circeq bumpeq
  Bumpeq doteqdot risingdotseq fallingdotseq eqcirc backsim backsimeq eqsim between pitchfork
  varpropto backepsilon blacktriangleleft blacktriangleright shortmid shortparallel nmid nparallel
  nless ngtr nleq ngeq nleqslant ngeqslant lneq gneq lneqq gneqq lnsim gnsim nprec nsucc npreceq
  nsucceq precneqq succneqq nsim ncong nsubseteq nsupseteq subsetneq supsetneq subsetneqq
  supsetneqq varsubsetneq varsupsetneq nvdash nvDash nVdash nVDash ntriangleleft ntriangleright
  ntrianglelefteq ntrianglerighteq multimap vartriangle eqslantless eqslantgtr lessdot gtrdot
  lesseqgtr gtreqless lesseqqgtr gtreqqless
  leftarrow rightarrow leftrightarrow Leftarrow Rightarrow Leftrightarrow mapsto hookleftarrow
  hookrightarrow leftharpoonup rightharpoonup leftharpoondown rightharpoondown rightleftharpoons
  longleftarrow longrightarrow longleftrightarrow Longleftarrow Longrightarrow Longleftrightarrow
  longmapsto uparrow downarrow updownarrow Uparrow Downarrow Updownarrow nearrow searrow swarrow
  nwarrow dashrightarrow dashleftarrow leftleftarrows rightrightarrows leftrightarrows
  rightleftarrows Lleftarrow Rrightarrow twoheadleftarrow twoheadrightarrow leftarrowtail
  rightarrowtail looparrowleft looparrowright leftrightharpoons curvearrowleft curvearrowright
  circlearrowleft circlearrowright Lsh Rsh upuparrows downdownarrows upharpoonleft upharpoonright
  downharpoonleft downharpoonright rightsquigarrow leftrightsquigarrow nleftarrow nrightarrow
  nLeftarrow nRightarrow nleftrightarrow nLeftrightarrow`);
/** Operators that take limits above and below in display style. */
const BIG_OPS = words(`sum prod coprod bigcap bigcup bigsqcup bigvee bigwedge bigodot bigotimes
  bigoplus biguplus`);
/** Integral-like operators: scripts stay at the side. */
const INTEGRALS = words("int oint iint iiint");
const OPEN_DELIMS = [["(", "("], ["[", "["], ["\\{", "\\{"], ["\\langle", "\\langle"], ["\\lfloor", "\\lfloor"], ["\\lceil", "\\lceil"]];
const CLOSE_DELIMS = [[")", ")"], ["]", "]"], ["\\}", "\\}"], ["\\rangle", "\\rangle"], ["\\rfloor", "\\rfloor"], ["\\rceil", "\\rceil"]];
const FENCE_DELIMS = [["|", "|"], ["\\|", "\\|"], ["/", "/"], ["\\backslash", "\\setminus"]];
const ACCENTS = words("hat check breve acute grave tilde bar vec dot ddot mathring");
const WIDE_ACCENTS = words("widehat widetilde");

/** Font commands, the style they mean, and what to set in each. */
const ALNUM = [...LOWER, ...UPPER, ...DIGITS];
const GREEK_SRC = [...GREEK_LOWER, ...GREEK_UPPER].map((g) => `\\${g}`);
const BOLD_SYMBOLS = words("nabla partial ell imath jmath infty hbar").map((g) => `\\${g}`);
const TEXT_ONLY = [
  "ff", "fi", "fl", "ffi", "ffl", ".", ",", ";", ":", "!", "?", "'", "`", "-", "--", "---", "(", ")",
  "[", "]", "/", "*", "+", "=", "@", "``", "''",
];
const STYLES = [
  ["\\mathrm", "rm", [...ALNUM, ...GREEK_SRC]],
  ["\\text", "rm", [...ALNUM, ...TEXT_ONLY]],
  ["\\mathbf", "bf", [...ALNUM, ...GREEK_SRC]],
  ["\\textbf", "bf", TEXT_ONLY],
  ["\\boldsymbol", "bm", [...ALNUM, ...GREEK_SRC, ...BOLD_SYMBOLS]],
  ["\\mathit", "it", [...ALNUM, ...GREEK_SRC]],
  ["\\textit", "it", TEXT_ONLY],
  ["\\mathsf", "sf", ALNUM],
  ["\\mathtt", "tt", ALNUM],
  ["\\mathcal", "cal", UPPER],
  ["\\mathscr", "cal", UPPER],
  ["\\mathbb", "bb", UPPER],
  ["\\mathfrak", "frak", [...LOWER, ...UPPER]],
];
/** What a text-mode source string should be emitted as. */
const TEXT_EMIT = { "--": "--", "---": "---", "``": "“", "''": "”", "`": "‘" };

// ---------------------------------------------------------------------------
// The TeX document: one request per page
// ---------------------------------------------------------------------------

/** @type {{src: string, kind: string, tex: string, cls: string, style?: string, extra?: object}[]} */
const requests = [];
const ask = (src, kind, tex, cls, extra = {}) => requests.push({ src, kind, tex, cls, ...extra });
/** A command that may not exist in this TeX installation typesets nothing. */
const guarded = (name) => `\\ifdefined\\${name}\\${name}\\fi`;

for (const [src, tex, cls] of CHARS) ask(`$${src}$`, "symbol", tex, cls);
for (const g of [...GREEK_LOWER, ...GREEK_UPPER]) ask(`$\\${g}$`, "symbol", `\\${g}`, "ord");
for (const [list, cls] of [[ORD, "ord"], [BIN, "bin"], [REL, "rel"], [BIG_OPS, "op"], [INTEGRALS, "int"]]) {
  for (const name of list) {
    ask(`$${guarded(name)}$`, "symbol", `\\${name}`, cls);
    ask(`$\\displaystyle ${guarded(name)}$`, "symbol", `\\${name}`, cls);
  }
}
for (const c of ALNUM) ask(`$${c}$`, "symbol", c, "ord");
for (const [cmd, style, atoms] of STYLES) {
  for (const a of atoms) {
    ask(`$${cmd}{${a}}$`, "symbol", TEXT_EMIT[a] ?? a, "ord", { style });
  }
}
for (const name of ACCENTS) ask(`$\\${name}{x}$`, "accent", `\\${name}`, "accent");
for (const name of WIDE_ACCENTS) {
  for (const arg of ["x", "xx", "xxx", "xxxx", "xxxxxx"]) ask(`$\\${name}{${arg}}$`, "accent", `\\${name}`, "accent");
}
// Delimiters at every size TeX has: its ready-made variants, then the built-up
// form. The strut makes the delimiter grow; `\right.` is the empty partner.
const HEIGHTS = [];
for (let h = 4; h <= 60; h += 2) HEIGHTS.push(h);
const strut = (h) => `\\vrule height ${h}pt depth ${h}pt width 0pt`;
for (const [list, cls, left] of [[OPEN_DELIMS, "open", true], [CLOSE_DELIMS, "close", false], [FENCE_DELIMS, "fence", true]]) {
  for (const [src, tex] of list) {
    for (const h of HEIGHTS) {
      ask(left ? `$\\left${src}${strut(h)}\\right.$` : `$\\left.${strut(h)}\\right${src}$`, "delimiter", tex, cls);
    }
  }
}
for (const h of [2, ...HEIGHTS]) ask(`$\\sqrt{\\vrule height ${h}pt depth 0pt width 0pt}$`, "delimiter", "\\sqrt", "radical");

function texDocument() {
  return [
    String.raw`\documentclass[10pt]{article}`,
    String.raw`\usepackage{amsmath,amssymb}`,
    String.raw`\DeclareFontFamily{U}{rsfs}{}\DeclareFontShape{U}{rsfs}{m}{n}{<-> rsfs10}{}`,
    String.raw`\DeclareMathAlphabet{\mathscr}{U}{rsfs}{m}{n}`,
    String.raw`\pagestyle{empty}\parindent=0pt`,
    String.raw`\begin{document}`,
    ...requests.map((r) => `\\mbox{}${r.src}\\newpage`),
    String.raw`\end{document}`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Read the answers
// ---------------------------------------------------------------------------

/** family -> slot -> { tex, cls, style } */
const slots = new Map();
const composites = [];
const assemblies = new Map();
const problems = [];

const entryOf = (family, slot) => slots.get(family)?.get(slot);
function claim(family, slot, entry) {
  let fam = slots.get(family);
  if (!fam) slots.set(family, (fam = new Map()));
  if (!fam.has(slot)) fam.set(slot, entry);
}
const round = (v) => Math.round(v * 1000) / 1000;

function record(req, glyphs) {
  if (glyphs.length === 0) return; // a command this installation does not have
  const entry = { tex: req.tex, cls: req.cls, ...(req.style ? { style: req.style } : {}) };

  if (req.kind === "accent") {
    const rest = glyphs.filter((g) => !(g.family === "CMMI" && g.slot === 0x78));
    if (rest.length !== 1) return void problems.push(`${req.src}: expected one accent glyph, saw ${rest.length}`);
    return claim(rest[0].family, rest[0].slot, entry);
  }

  if (req.kind === "delimiter") {
    if (glyphs.length === 1) return claim(glyphs[0].family, glyphs[0].slot, entry);
    const families = new Set(glyphs.map((g) => g.family));
    if (families.size !== 1) return void problems.push(`${req.src}: built from ${families.size} font families`);
    const family = glyphs[0].family;
    const parts = [...new Set(glyphs.map((g) => g.slot))].sort((a, b) => a - b);
    const key = `${family}:${parts.join(",")}`;
    const prior = assemblies.get(key);
    if (prior && prior.tex !== req.tex) {
      // Two delimiters built from the same pieces differ only in which piece
      // goes where; record the order top to bottom to tell them apart.
      problems.push(`${req.src}: same pieces as ${prior.tex}`);
    }
    if (!prior) assemblies.set(key, { tex: req.tex, cls: req.cls, family, slots: parts });
    return;
  }

  if (glyphs.length === 1) return claim(glyphs[0].family, glyphs[0].slot, entry);

  // Several glyphs. A styled string such as "ffi" is a ligature when it is one
  // glyph and plain letters when it is several; only real symbols are composites.
  if (req.style) {
    if (glyphs.every((g) => entryOf(g.family, g.slot))) return;
    return void problems.push(`${req.src}: ${glyphs.length} glyphs, some unknown`);
  }
  const [first, ...others] = glyphs;
  const parts = [
    [first.family, first.slot, 0, 0],
    ...others.map((g) => [g.family, g.slot, round((g.x - first.x) / first.size), round((g.y - first.y) / first.size)]),
  ];
  const same = (a, b) =>
    a.length === b.length &&
    a.every((p, i) => p[0] === b[i][0] && p[1] === b[i][1] && Math.abs(p[2] - b[i][2]) < 0.03 && Math.abs(p[3] - b[i][3]) < 0.03);
  if (!composites.some((c) => same(c.parts, parts))) composites.push({ tex: req.tex, cls: req.cls, parts });
}

/** Vertical ink extent of each slot, from the family's 10pt AFM file. */
function inkOf(family) {
  let path = "";
  try {
    path = execFileSync("kpsewhich", [`${family.toLowerCase()}10.afm`], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
  if (!path) return null;
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^C (\d+) ;.*; B (-?\d+) (-?\d+) (-?\d+) (-?\d+) ;/.exec(line);
    if (m) out.push(Number(m[1]), Number(m[3]), Number(m[5]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), "ito-slots-"));
try {
  writeFileSync(join(work, "slots.tex"), texDocument());
  try {
    execFileSync("pdflatex", ["-interaction=nonstopmode", "-halt-on-error", "slots.tex"], { cwd: work, stdio: "pipe" });
  } catch (err) {
    const log = readFileSync(join(work, "slots.log"), "utf8");
    throw new Error(`pdflatex failed:\n${log.split("\n").filter((l) => l.startsWith("!") || l.startsWith("l.")).join("\n")}`, { cause: err });
  }
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(join(work, "slots.pdf"))), verbosity: 0 }).promise;
  if (doc.numPages !== requests.length) throw new Error(`expected ${requests.length} pages, TeX made ${doc.numPages}`);
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const model = buildPageMathModel(
      await page.getOperatorList(),
      (id) => page.commonObjs.get(id),
      pdfjs.OPS,
      page.getViewport({ scale: 1 }),
    );
    record(requests[n - 1], model.glyphs);
    page.cleanup();
  }
  await doc.destroy();
} finally {
  rmSync(work, { recursive: true, force: true });
}

// A composite whose every part is just the symbols it is made of, side by
// side, would also be read correctly glyph by glyph; keep them all anyway, the
// matcher needs the exact offsets to tell `\ldots` from three full stops.
composites.sort((a, b) => b.parts.length - a.parts.length || a.tex.localeCompare(b.tex));
for (const c of composites) {
  for (const [family, slot] of c.parts) {
    if (!entryOf(family, slot)) claim(family, slot, { tex: "", cls: "part" });
  }
}
for (const a of assemblies.values()) {
  for (const slot of a.slots) if (!entryOf(a.family, slot)) claim(a.family, slot, { tex: "", cls: "part" });
}

const families = [...slots.keys()].sort();
const lines = [];
lines.push("// GENERATED by scripts/gen-tex-font-slots.mjs from TeX itself. Do not edit by hand:");
lines.push("// change the lists in that script and run `npm run gen-tex-font-slots`.");
lines.push("//");
lines.push("// See src/pdf/texGlyphs.ts for how these tables are read.");
lines.push("");
lines.push("/** family -> slot -> [LaTeX, class, style?]. An empty LaTeX string marks a slot that only occurs as a part. */");
lines.push("export const TEX_FONT_SLOTS: Readonly<Record<string, Readonly<Record<number, readonly [string, string, string?]>>>> = {");
for (const family of families) {
  lines.push(`  ${family}: {`);
  const fam = slots.get(family);
  for (const slot of [...fam.keys()].sort((a, b) => a - b)) {
    const e = fam.get(slot);
    const cells = [JSON.stringify(e.tex), JSON.stringify(e.cls), ...(e.style ? [JSON.stringify(e.style)] : [])];
    lines.push(`    ${slot}: [${cells.join(", ")}],`);
  }
  lines.push("  },");
}
lines.push("};");
lines.push("");
lines.push("/** Symbols drawn as several glyphs: each part is [family, slot, dx, dy] in ems from the first part. */");
lines.push("export const TEX_COMPOSITES: readonly { readonly tex: string; readonly cls: string; readonly parts: readonly (readonly [string, number, number, number])[] }[] = [");
for (const c of composites) lines.push(`  { tex: ${JSON.stringify(c.tex)}, cls: ${JSON.stringify(c.cls)}, parts: ${JSON.stringify(c.parts)} },`);
lines.push("];");
lines.push("");
lines.push("/** Delimiters and radicals too tall for one glyph: the set of slots stacked to build each. */");
lines.push("export const TEX_ASSEMBLIES: readonly { readonly tex: string; readonly cls: string; readonly family: string; readonly slots: readonly number[] }[] = [");
for (const a of [...assemblies.values()].sort((x, y) => x.tex.localeCompare(y.tex) || x.slots.length - y.slots.length)) {
  lines.push(`  { tex: ${JSON.stringify(a.tex)}, cls: ${JSON.stringify(a.cls)}, family: ${JSON.stringify(a.family)}, slots: ${JSON.stringify(a.slots)} },`);
}
lines.push("];");
lines.push("");
lines.push("/** family -> flat [slot, lowest ink, highest ink, ...] in thousandths of the font size, baseline at 0. */");
lines.push("export const TEX_FONT_INK: Readonly<Record<string, readonly number[]>> = {");
const noInk = [];
for (const family of families) {
  const ink = inkOf(family);
  if (!ink) {
    noInk.push(family);
    continue;
  }
  lines.push(`  ${family}: [${ink.join(",")}],`);
}
lines.push("};");
lines.push("");
writeFileSync(OUT, lines.join("\n"));

const count = [...slots.values()].reduce((n, m) => n + m.size, 0);
console.log(`${requests.length} requests -> ${count} slots in ${families.length} families, ${composites.length} composites, ${assemblies.size} assemblies`);
console.log(`families: ${families.map((f) => `${f} ${slots.get(f).size}`).join(", ")}`);
if (noInk.length > 0) console.log(`no AFM metrics found for: ${noInk.join(", ")}`);
if (problems.length > 0) {
  console.log(`${problems.length} requests could not be recorded:`);
  for (const p of problems) console.log(`  ${p}`);
}
