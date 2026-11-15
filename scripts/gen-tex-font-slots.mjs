// Generate src/pdf/texFontSlots.ts: which LaTeX command each slot of the fonts
// TeX sets mathematics in is (docs/LATEX-EXTRACTION-PLAN.md, Phase 2).
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
// It asks once per font setup (FONT_SETS): Computer Modern with the AMS fonts
// first, then the packages that set mathematics in Times, Palatino and STIX.
// A slot keeps the meaning it was first given, so the Computer Modern tables
// do not depend on which other packages are installed.
//
// A PDF gives advances but not heights, and operators and delimiters hang far
// below their baseline, so the vertical ink extent of every slot is recorded
// too. For Computer Modern and the AMS fonts it is copied from TeX's own AFM
// metric files. The other fonts are often re-encoded, so an AFM's codes are
// not their slots; their ink is measured on the page, with Ghostscript.
//
// Needs `pdflatex`, `kpsewhich` and `gs` (texlive-latex-base,
// texlive-latex-recommended, texlive-fonts-recommended, ghostscript; and for
// newtx, newpx and STIX texlive-fonts-extra, texlive-latex-extra and
// texlive-plain-generic: a package that is missing is skipped and its
// families drop out of the table, so regenerate with all of them). Only this
// script needs them: its output is committed. Run with
// `npm run gen-tex-font-slots`. Needs Node 22.18+.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  // The negation slash on its own: `\not\subset`, and the Feynman slash `\not p`.
  ["\\not\\mathrel{}", "\\not", "rel"],
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
  ntrianglelefteq ntrianglerighteq multimap vartriangle eqslantless eqslantgtr lessdot gtrdot mid parallel
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
  ["\\mathsf", "sf", [...ALNUM, ...GREEK_UPPER.map((g) => `\\${g}`)]],
  ["\\mathtt", "tt", [...ALNUM, ...GREEK_UPPER.map((g) => `\\${g}`)]],
  ["\\mathcal", "cal", UPPER],
  ["\\mathscr", "cal", UPPER],
  ["\\mathbb", "bb", UPPER],
  ["\\mathfrak", "frak", [...LOWER, ...UPPER]],
  // Text-mode letters last: in Computer Modern they are the fonts above, but a
  // package may give text and math different ones (STIX Two Text and Math).
  ["\\textbf", "bf", ALNUM],
  ["\\textit", "it", ALNUM],
  ["\\textsf", "sf", ALNUM],
  ["\\texttt", "tt", ALNUM],
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
// Bold italic text (`\textbf{\textit{p}}`) is a font of its own, read as bold italic.
for (const a of ALNUM) ask(`$\\textbf{\\textit{${a}}}$`, "symbol", a, "ord", { style: "bm" });
// The typewriter font draws the underscore as a glyph; the others rule it.
ask("$\\texttt{\\_}$", "symbol", "\\_", "ord", { style: "tt" });
for (const name of ACCENTS) ask(`$\\${name}{x}$`, "accent", `\\${name}`, "accent");
// Accents in the bold fonts are other slots: `\boldsymbol{\hat{x}}`, `\mathbf{\hat{x}}`.
for (const wrap of ["\\boldsymbol", "\\mathbf"]) {
  for (const name of ACCENTS) ask(`$${wrap}{\\${name}{x}}$`, "accent", `\\${name}`, "accent");
}
for (const name of WIDE_ACCENTS) {
  for (const arg of ["x", "xx", "xxx", "xxxx", "xxxxxx"]) ask(`$\\${name}{${arg}}$`, "accent", `\\${name}`, "accent");
}
// Each accent again with nothing under it: one glyph alone on the page, whose
// ink can then be measured for the fonts that have no usable metric file.
for (const name of ACCENTS) ask(`$\\${name}{\\hphantom{x}}$`, "accent", `\\${name}`, "accent");
for (const name of WIDE_ACCENTS) {
  for (const arg of ["x", "xx", "xxx", "xxxx", "xxxxxx"]) ask(`$\\${name}{\\hphantom{${arg}}}$`, "accent", `\\${name}`, "accent");
}
// Horizontal braces: four pieces in a row with rules between them. The same
// four pieces make both; their order says which.
for (const name of ["underbrace", "overbrace"]) ask(`$\\${name}{\\hphantom{xxxxxxxx}}$`, "brace", `\\${name}`, "brace");
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
// The four named sizes too: a font may have one that no height above selects.
for (const [list, cls, left] of [[OPEN_DELIMS, "open", true], [CLOSE_DELIMS, "close", false], [FENCE_DELIMS, "fence", true]]) {
  for (const [src, tex] of list) {
    for (const size of ["big", "Big", "bigg", "Bigg"]) ask(`$\\${size}${left ? "l" : "r"}${src}$`, "delimiter", tex, cls);
  }
}
for (const h of [2, ...HEIGHTS]) ask(`$\\sqrt{\\vrule height ${h}pt depth 0pt width 0pt}$`, "delimiter", "\\sqrt", "radical");

/**
 * The font setups to ask under, in order of priority: a slot claimed under an
 * earlier setup keeps its meaning. Computer Modern comes first, so adding a
 * setup never changes what a Computer Modern slot is. The others are the font
 * packages papers load to set their mathematics in Times or Palatino; a
 * package this TeX installation lacks is skipped.
 */
const FONT_SETS = [
  { name: "cm", requires: null, preamble: "" },
  { name: "mathptmx", requires: "mathptmx.sty", preamble: String.raw`\usepackage{mathptmx}` },
  { name: "txfonts", requires: "txfonts.sty", preamble: String.raw`\usepackage{txfonts}` },
  { name: "newtx", requires: "newtxmath.sty", preamble: String.raw`\usepackage{newtxtext,newtxmath}` },
  { name: "times", requires: "times.sty", preamble: String.raw`\usepackage{times}` },
  { name: "mathpazo", requires: "mathpazo.sty", preamble: String.raw`\usepackage{mathpazo}` },
  { name: "pxfonts", requires: "pxfonts.sty", preamble: String.raw`\usepackage{pxfonts}` },
  { name: "newpx", requires: "newpxmath.sty", preamble: String.raw`\usepackage{newpxtext,newpxmath}` },
  { name: "stix", requires: "stix.sty", preamble: String.raw`\usepackage{stix}` },
  { name: "stix2", requires: "stix2.sty", preamble: String.raw`\usepackage{stix2}` },
];

function texDocument(preamble) {
  return [
    String.raw`\documentclass[10pt]{article}`,
    String.raw`\usepackage{amsmath,amssymb}`,
    // A font package that brings its own script alphabet keeps it.
    String.raw`\ifdefined\mathscr\else\DeclareFontFamily{U}{rsfs}{}\DeclareFontShape{U}{rsfs}{m}{n}{<-> rsfs10}{}`,
    String.raw`\DeclareMathAlphabet{\mathscr}{U}{rsfs}{m}{n}\fi`,
    preamble,
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
const braces = [];
const problems = [];

const entryOf = (family, slot) => slots.get(family)?.get(slot);
function claim(family, slot, entry) {
  let fam = slots.get(family);
  if (!fam) slots.set(family, (fam = new Map()));
  const prior = fam.get(slot);
  // What a slot is in plain math outranks what it is inside `\text` or a font
  // command, whichever setup happened to show it first: txfonts takes its
  // parentheses from the roman font that mathptmx uses only for text.
  if (!prior || (prior.style && !entry.style && prior.tex === entry.tex && entry.cls !== "accent")) fam.set(slot, entry);
}
const round = (v) => Math.round(v * 1000) / 1000;

function record(req, glyphs) {
  if (glyphs.length === 0) return; // a command this installation does not have
  const entry = { tex: req.tex, cls: req.cls, ...(req.style ? { style: req.style } : {}) };

  if (req.kind === "accent") {
    // The letter under the accent is whatever this setup's `x` is, in any weight.
    const rest = glyphs.filter((g) => entryOf(g.family, g.slot)?.tex !== "x");
    if (rest.length !== 1) return void problems.push(`${req.src}: expected one accent glyph, saw ${rest.length}`);
    return claim(rest[0].family, rest[0].slot, entry);
  }

  if (req.kind === "brace") {
    const pieces = [...glyphs].sort((a, b) => a.x - b.x);
    if (pieces.length < 3) return void problems.push(`${req.src}: ${pieces.length} pieces`);
    // A piece that repeats is the fill of a font that draws no rules: once is enough.
    const order = pieces.map((g) => [g.family, g.slot]).filter((part, i, all) => i === 0 || part.join() !== all[i - 1].join());
    if (!braces.some((b) => b.parts.join() === order.join())) braces.push({ tex: req.tex, parts: order });
    for (const g of pieces) claim(g.family, g.slot, { tex: "", cls: "part" });
    return;
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

/** Vertical ink extent of each slot, from the family's 10pt AFM file (or the file named). */
function inkOf(family, file = `${family.toLowerCase()}10.afm`) {
  let path = "";
  try {
    path = execFileSync("kpsewhich", [file], { encoding: "utf8" }).trim();
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

/** family -> slot -> [lowest ink, highest ink] in thousandths of the size, measured on the page. */
const measured = new Map();
/** Families first seen under each setup after Computer Modern. */
const setOf = new Map();
/** A face of each such family, as the PDF names it: where to look for its AFM. */
const faceOf = new Map();
/** family -> slot -> the characters that slot was seen to draw. */
const drawn = new Map();
/** Families identified by slot and character together. */
const byCharacter = new Set();
/** What each setup's pages held. */
const read = [];

/** The ink box of every page, in PDF points, from Ghostscript's bbox device. */
function inkBoxes(pdf) {
  const out = spawnSync("gs", ["-q", "-dBATCH", "-dNOPAUSE", "-sDEVICE=bbox", pdf], { encoding: "utf8", maxBuffer: 1 << 28 });
  return [...out.stderr.matchAll(/%%HiResBoundingBox: (\S+) (\S+) (\S+) (\S+)/g)].map((m) => m.slice(1).map(Number));
}

const work = mkdtempSync(join(tmpdir(), "ito-slots-"));
const skipped = [];
const refused = [];
try {
  for (const set of FONT_SETS) {
    if (set.requires) {
      let found = "";
      try {
        found = execFileSync("kpsewhich", [set.requires], { encoding: "utf8" }).trim();
      } catch {
        // not installed
      }
      if (!found) {
        skipped.push(set.name);
        continue;
      }
    }
    const name = `slots-${set.name}`;
    writeFileSync(join(work, `${name}.tex`), texDocument(set.preamble));
    // Under Computer Modern every request must compile. Another package may
    // refuse a symbol it lacks (mathptmx has no `\\jmath`): TeX then sets
    // nothing on that page, which is the right answer, and carries on.
    try {
      execFileSync("pdflatex", ["-interaction=nonstopmode", ...(set.name === "cm" ? ["-halt-on-error"] : []), `${name}.tex`], { cwd: work, stdio: "pipe" });
    } catch (err) {
      const log = readFileSync(join(work, `${name}.log`), "utf8");
      const errors = log.split("\n").filter((l) => l.startsWith("!") || l.startsWith("l."));
      if (set.name === "cm" || !existsSync(join(work, `${name}.pdf`))) throw new Error(`pdflatex failed for ${set.name}:\n${errors.join("\n")}`, { cause: err });
      refused.push(`${set.name}: ${errors.filter((l) => l.startsWith("!")).length} errors`);
    }
    const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(join(work, `${name}.pdf`))), verbosity: 0 }).promise;
    if (doc.numPages !== requests.length) throw new Error(`expected ${requests.length} pages, TeX made ${doc.numPages}`);
    // Computer Modern's ink comes from its AFM files; other fonts are often
    // re-encoded, so their AFM codes are not their slots, and are measured.
    const boxes = set.name === "cm" ? null : inkBoxes(join(work, `${name}.pdf`));
    if (boxes && boxes.length !== requests.length) throw new Error(`Ghostscript measured ${boxes.length} pages of ${requests.length}`);
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const model = buildPageMathModel(await page.getOperatorList(), (id) => page.commonObjs.get(id), pdfjs.OPS, viewport);
      pages.push({ glyphs: model.glyphs, height: viewport.height });
      for (const g of model.glyphs) {
        let fam = drawn.get(g.family);
        if (!fam) drawn.set(g.family, (fam = new Map()));
        let chars = fam.get(g.slot);
        if (!chars) fam.set(g.slot, (chars = new Set()));
        chars.add(g.unicode);
      }
      page.cleanup();
    }
    await doc.destroy();
    read.push({ set, pages, boxes });
  }
} finally {
  if (process.env.ITO_KEEP) console.log(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}

// A family many of whose slots draw different characters is several fonts
// under one name, each with its own encoding (STIX Two Math is a dozen). A
// slot does not identify a glyph there; a slot together with the character
// pdf.js reads from the glyph's name does.
for (const [family, fam] of drawn) {
  const clashes = [...fam].filter(([, chars]) => chars.size > 1);
  if (process.env.ITO_KEEP && clashes.length > 0) console.log(`clash ${family}: ${clashes.length} of ${fam.size}: ${clashes.slice(0, 4).map(([slot, chars]) => `${slot}=${[...chars].map((c) => c.codePointAt(0).toString(16)).join("/")}`).join(" ")}`);
  // A few clashes are pdf.js naming one glyph two ways, not two encodings.
  if (clashes.length > 0.25 * fam.size) byCharacter.add(family);
}
const keyed = (g) => (byCharacter.has(g.family) ? { ...g, slot: g.slot + 256 * (g.unicode.codePointAt(0) ?? 0) } : g);

for (const { set, pages, boxes } of read) {
  for (let n = 0; n < pages.length; n++) {
    const glyphs = pages[n].glyphs.map(keyed);
    for (const g of glyphs) if (set.name !== "cm" && !slots.has(g.family) && !setOf.has(g.family)) (setOf.set(g.family, set.name), faceOf.set(g.family, g.face));
    // mathpazo makes `\mu` a letter that follows the font command, and its
    // roman font has a macron where the math font has mu: `\mathrm{\mu}`
    // prints an accent. A Greek letter that reads as a Latin character or a
    // mark is not taken.
    const req = requests[n];
    const greek = req.style && /^\\[A-Za-z]+$/.test(req.tex) && glyphs.length === 1;
    if (set.name !== "cm" && greek && /^[\u0020-\u02ff]/.test(glyphs[0].unicode)) continue;
    record(req, glyphs);
    if (boxes && glyphs.length === 1 && setOf.has(glyphs[0].family)) {
      const g = glyphs[0];
      const [, y0, , y1] = boxes[n];
      const base = pages[n].height - g.y;
      let fam = measured.get(g.family);
      if (!fam) measured.set(g.family, (fam = new Map()));
      if (!fam.has(g.slot) && y1 > y0) fam.set(g.slot, [Math.round((1000 * (y0 - base)) / g.size), Math.round((1000 * (y1 - base)) / g.size)]);
    }
    // A built-up delimiter is a stack of pieces, none of which stands alone on
    // any page. The page's ink gives the top of the first and the bottom of
    // the last; between two pieces the boundary is an origin: the lower
    // piece's when pieces hang from their origins, the upper one's when they
    // stand on them. Which it is shows at the ends of the stack.
    if (boxes && req.kind === "delimiter" && glyphs.length > 1 && glyphs.every((g) => g.family === glyphs[0].family && setOf.has(g.family))) {
      const stack = [...glyphs].sort((a, b) => a.y - b.y);
      const size = stack[0].size;
      const top = pages[n].height - boxes[n][3];
      const bottom = pages[n].height - boxes[n][1];
      const hangs = Math.abs(top - stack[0].y) < 0.12 * size;
      const stands = Math.abs(bottom - stack[stack.length - 1].y) < 0.12 * size;
      let fam = measured.get(stack[0].family);
      if (!fam) measured.set(stack[0].family, (fam = new Map()));
      if (hangs !== stands && bottom > top) {
        stack.forEach((g, k) => {
          const t = hangs ? (k === 0 ? top : g.y) : k === 0 ? top : stack[k - 1].y;
          const b = hangs ? (k === stack.length - 1 ? bottom : stack[k + 1].y) : k === stack.length - 1 ? bottom : g.y;
          if (!fam.has(g.slot) && b > t) fam.set(g.slot, [Math.round((1000 * (g.y - b)) / size), Math.round((1000 * (g.y - t)) / size)]);
        });
      }
    }
  }
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
const key = (family) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(family) ? family : JSON.stringify(family));
const lines = [];
lines.push("// GENERATED by scripts/gen-tex-font-slots.mjs from TeX itself. Do not edit by hand:");
lines.push("// change the lists in that script and run `npm run gen-tex-font-slots`.");
lines.push("//");
lines.push("// See src/pdf/texGlyphs.ts for how these tables are read.");
lines.push("");
lines.push("/** family -> slot -> [LaTeX, class, style?]. An empty LaTeX string marks a slot that only occurs as a part. */");
lines.push("export const TEX_FONT_SLOTS: Readonly<Record<string, Readonly<Record<number, readonly [string, string, string?]>>>> = {");
for (const family of families) {
  lines.push(`  ${key(family)}: {`);
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
lines.push("/**");
lines.push(" * Families that are several fonts under one name, each with its own encoding. Their keys in these tables");
lines.push(" * are not slots but `slot + 256 * code point`, the code point being the first of the character pdf.js reports.");
lines.push(" */");
lines.push(`export const TEX_KEYED_BY_CHARACTER: readonly string[] = ${JSON.stringify([...byCharacter].filter((f) => slots.has(f)).sort())};`);
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
lines.push("/** Horizontal braces: the pieces as [family, slot], left to right. A piece may repeat on the page. */");
lines.push("export const TEX_BRACES: readonly { readonly tex: string; readonly parts: readonly (readonly [string, number])[] }[] = [");
for (const b of braces) lines.push(`  { tex: ${JSON.stringify(b.tex)}, parts: ${JSON.stringify(b.parts)} },`);
lines.push("];");
lines.push("");
lines.push("/** family -> flat [slot, lowest ink, highest ink, ...] in thousandths of the font size, baseline at 0. */");
lines.push("export const TEX_FONT_INK: Readonly<Record<string, readonly number[]>> = {");
const noInk = [];
for (const family of families) {
  // Measured ink where there is any; a font's own AFM otherwise.
  const seen = measured.get(family);
  if (seen && seen.size > 0 && !byCharacter.has(family)) {
    // The font's own AFM fills in the slots that never stood alone on a page
    // (the pieces of a built-up delimiter), but only when its codes are this
    // font's slots: where both know a slot, they must agree.
    const afm = inkOf(family, `${faceOf.get(family).toLowerCase()}.afm`) ?? [];
    const fromAfm = new Map();
    for (let i = 0; i + 2 < afm.length; i += 3) fromAfm.set(afm[i], [afm[i + 1], afm[i + 2]]);
    const both = [...seen].filter(([slot]) => fromAfm.has(slot));
    const agree = both.filter(([slot, [lo, hi]]) => Math.abs(fromAfm.get(slot)[0] - lo) <= 25 && Math.abs(fromAfm.get(slot)[1] - hi) <= 25);
    if (both.length >= 10 && agree.length >= 0.9 * both.length) for (const [slot, box] of fromAfm) if (!seen.has(slot) && slots.get(family).has(slot)) seen.set(slot, box);
  }
  const ink = seen && seen.size > 0 ? [...seen].sort((a, b) => a[0] - b[0]).flatMap(([slot, [lo, hi]]) => [slot, lo, hi]) : inkOf(family);
  if (!ink) {
    noInk.push(family);
    continue;
  }
  lines.push(`  ${key(family)}: [${ink.join(",")}],`);
}
lines.push("};");
lines.push("");
writeFileSync(OUT, lines.join("\n"));

const count = [...slots.values()].reduce((n, m) => n + m.size, 0);
console.log(`${requests.length} requests -> ${count} slots in ${families.length} families, ${composites.length} composites, ${assemblies.size} assemblies`);
console.log(`families: ${families.map((f) => `${f} ${slots.get(f).size}`).join(", ")}`);
if (skipped.length > 0) console.log(`font packages not installed, skipped: ${skipped.join(", ")}`);
if (refused.length > 0) console.log(`requests a package refused: ${refused.join("; ")}`);
if (noInk.length > 0) console.log(`no AFM metrics found for: ${noInk.join(", ")}`);
if (problems.length > 0) {
  console.log(`${problems.length} requests could not be recorded:`);
  for (const p of problems) console.log(`  ${p}`);
}
