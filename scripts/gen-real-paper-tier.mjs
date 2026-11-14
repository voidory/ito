// The real-paper tier of the LaTeX-extraction benchmark
// (docs/LATEX-EXTRACTION-PLAN.md): equations as authors actually write them.
//
//   node scripts/gen-real-paper-tier.mjs harvest   (network + TeX)
//   node scripts/gen-real-paper-tier.mjs           (TeX only)
//
// `harvest` picks openly licensed arXiv papers, takes equations from their
// LaTeX source and writes scripts/math-corpus/real-papers.json. The default
// run typesets that file and adds the tiers `real-display` and `real-inline`
// to both corpora. Papers alternate between the development corpus and the
// held-out set, so no paper contributes to both.
//
// What "real" means here, and what it does not:
//   - The equations and their frequencies are the authors'. The page is ours:
//     each equation is set alone by the same harness as the generated tiers
//     (pdfLaTeX, amsmath, Computer Modern), not cut from the paper's own PDF.
//     So this tier tests real mathematics, not real page layout.
//   - Ground truth is the source after expanding the paper's own simple
//     macros (\newcommand, \def, \DeclareMathOperator). An equation is kept
//     only if every command left in it is in the vocabulary below and it
//     compiles in the harness. Equations built on heavier macros or packages
//     are left out; the harvest prints how many, and that is this tier's bias.
//   - Only papers under CC BY 4.0 or CC0 are used, and each is credited in the
//     manifest (`sources`) and in the benchmark README.
//
// arXiv asks automated clients to go slowly: one request every three seconds.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { TEX_COMPOSITES, TEX_FONT_SLOTS } from "../src/pdf/texFontSlots.ts";
import { canonicalLatex, parseLatex, treeSize } from "../src/science/research/latex/normalize.ts";
import {
  MARK_WIDTH, MAX_DISPLAY_WIDTH, PAD_DISPLAY, PAD_INLINE_X, PAD_INLINE_Y, columnPlacements, compile, placements,
  texSource, tier,
} from "./math-corpus/typeset.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LATEX_DIR = resolve(HERE, "../src/science/research/latex");
const STORE = resolve(HERE, "math-corpus/real-papers.json");

/** Papers wanted per arXiv set; half go to each corpus. */
const QUOTAS = [
  ["math", 16], ["physics:hep-th", 8], ["physics:quant-ph", 8], ["physics:cond-mat", 6],
  ["physics:astro-ph", 6], ["cs", 10], ["stat", 6],
];
/** Records last touched in this window are the candidates: fixed, so a re-harvest finds the same papers. */
const WINDOW = { from: "2024-03-04", until: "2024-03-06" };
const LICENCES = new Set([
  "http://creativecommons.org/licenses/by/4.0/",
  "http://creativecommons.org/publicdomain/zero/1.0/",
]);
const PER_PAPER = 30;
/** A paper with fewer usable display equations than this is not a mathematical paper for our purpose. */
const MIN_DISPLAY = 8;
const MAX_SOURCE_BYTES = 6_000_000;
const USER_AGENT = "math-corpus-builder/1.0";
/** The harness preamble for this tier: bold symbols and script letters are common in papers. */
const PREAMBLE = [
  String.raw`\usepackage{bm}`,
  String.raw`\DeclareFontFamily{U}{rsfs}{}\DeclareFontShape{U}{rsfs}{m}{n}{<-> rsfs10}{}`,
  String.raw`\DeclareMathAlphabet{\mathscr}{U}{rsfs}{m}{n}`,
].join("\n");

// ---------------------------------------------------------------------------
// Vocabulary: the only commands an equation may contain
// ---------------------------------------------------------------------------

const words = (s) => s.split(/\s+/).filter(Boolean);
const STRUCTURE = words(`frac dfrac tfrac binom dbinom tbinom sqrt left right middle big Big bigg Bigg bigl
  Bigl biggl Biggl bigr Bigr biggr Biggr bigm Bigm text textrm textit textbf textsf texttt textnormal
  mbox mathrm mathbf mathit mathsf mathtt mathcal mathscr mathbb mathfrak boldsymbol bm operatorname
  hat check breve acute grave tilde bar vec dot ddot mathring widehat widetilde overline underline
  overbrace underbrace overrightarrow overset underset stackrel begin end limits nolimits quad qquad
  displaystyle textstyle scriptstyle scriptscriptstyle not pmod bmod mod to gets le ge ne iff
  implies land lor lnot dots dotsc dotsb dotsm dotso mid vert Vert lvert rvert lVert rVert lbrace
  rbrace lbrack rbrack langle rangle lfloor rfloor lceil rceil ast colon prime backslash owns
  sin cos tan cot sec csc sinh cosh tanh coth arcsin arccos arctan log ln lg exp lim liminf limsup
  max min sup inf det dim ker arg deg gcd hom Pr mathop mathbin mathrel mathord nonumber notag
  perp parallel dag ddag`);
const ENVIRONMENTS = new Set(words(`aligned gathered cases matrix pmatrix bmatrix Bmatrix vmatrix Vmatrix
  smallmatrix array`));
const VOCABULARY = new Set(STRUCTURE);
for (const family of Object.values(TEX_FONT_SLOTS)) {
  for (const [tex] of Object.values(family)) if (/^\\[A-Za-z]+$/.test(tex)) VOCABULARY.add(tex.slice(1));
}
for (const c of TEX_COMPOSITES) if (/^\\[A-Za-z]+$/.test(c.tex)) VOCABULARY.add(c.tex.slice(1));
/** amssymb's blackboard font has capital letters only. */
const BLACKBOARD_NON_LETTER = /\\mathbb\s*(\{\s*)?[^A-Z{\s]/;
/** Control symbols (a backslash and one non-letter) that are safe. */
const CONTROL_SYMBOLS = new Set([",", ";", ":", "!", " ", "{", "}", "|", "%", "&", "#", "_", "\\"]);

// ---------------------------------------------------------------------------
// arXiv
// ---------------------------------------------------------------------------

let lastRequest = 0;
/**
 * Fetch a URL with curl, which follows the machine's proxy and certificate
 * settings where Node's own fetch may not. Null on any failure.
 */
async function politeFetch(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = lastRequest + 3000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequest = Date.now();
    try {
      const out = execFileSync(
        "curl",
        ["-sS", "-L", "--fail", "--max-time", "120", "--max-filesize", String(MAX_SOURCE_BYTES * 4), "-A", USER_AGENT, url],
        { maxBuffer: MAX_SOURCE_BYTES * 8, stdio: ["ignore", "pipe", "pipe"] },
      );
      return out;
    } catch (err) {
      // 22: an HTTP error (no such source); anything else may be transient.
      if (err.status === 22 && !/ 503| 429/.test(String(err.stderr))) return null;
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  return null;
}

const unxml = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/** Openly licensed papers of one arXiv set, in id order. */
async function listPapers(set) {
  const out = [];
  let url = `https://oaipmh.arxiv.org/oai?verb=ListRecords&metadataPrefix=arXiv&set=${encodeURIComponent(set)}&from=${WINDOW.from}&until=${WINDOW.until}`;
  for (let page = 0; url && page < 4; page++) {
    const body = (await politeFetch(url))?.toString("utf8");
    if (!body) break;
    for (const rec of body.split("<record>").slice(1)) {
      const field = (name) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(rec)?.[1] ?? "";
      const id = field("id").trim();
      const licence = field("license").trim();
      if (!/^\d{4}\.\d{4,5}$/.test(id) || !LICENCES.has(licence)) continue;
      const authors = [...rec.matchAll(/<author>([\s\S]*?)<\/author>/g)].map((m) => {
        const part = (name) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(m[1])?.[1] ?? "";
        return unxml(`${part("forenames")} ${part("keyname")}`);
      });
      out.push({ id, title: unxml(field("title")), authors, licence, categories: unxml(field("categories")) });
    }
    const token = /<resumptionToken[^>]*>([^<]+)<\/resumptionToken>/.exec(body)?.[1];
    url = token ? `https://oaipmh.arxiv.org/oai?verb=ListRecords&resumptionToken=${encodeURIComponent(token)}` : null;
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** The .tex files of a paper's source, or null when there is no TeX source. */
async function fetchSource(id) {
  const raw = await politeFetch(`https://arxiv.org/e-print/${id}`);
  if (!raw || raw.length > MAX_SOURCE_BYTES) return null;
  let data;
  try {
    data = gunzipSync(raw);
  } catch {
    return null; // a PDF-only submission
  }
  if (data.subarray(0, 4).toString("latin1") === "%PDF") return null;
  if (data.length > 512 && data.subarray(257, 262).toString("latin1") === "ustar") {
    // Read the tar by hand: only regular files ending in .tex, never written to disk.
    const files = [];
    for (let at = 0; at + 512 <= data.length; ) {
      const header = data.subarray(at, at + 512);
      if (header.every((b) => b === 0)) break;
      const name = header.subarray(0, 100).toString("latin1").replace(/\0.*$/, "");
      const size = parseInt(header.subarray(124, 136).toString("latin1").replace(/\0.*$/, "").trim() || "0", 8);
      const type = String.fromCharCode(header[156]);
      if ((type === "0" || type === "\0") && /\.(tex|ltx)$/i.test(name)) {
        files.push(data.subarray(at + 512, at + 512 + size).toString("latin1"));
      }
      at += 512 + Math.ceil(size / 512) * 512;
    }
    return files.length > 0 ? files : null;
  }
  const text = data.toString("latin1");
  return /\\documentclass|\\documentstyle/.test(text) ? [text] : null;
}

// ---------------------------------------------------------------------------
// From LaTeX source to candidate equations
// ---------------------------------------------------------------------------

const stripComments = (s) => s.replace(/(^|[^\\])%.*$/gm, "$1");

/** Read a balanced `{...}` starting at `at`; returns [content, index after]. */
function readGroup(s, at) {
  if (s[at] !== "{") return null;
  let depth = 0;
  for (let i = at; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return [s.slice(at + 1, i), i + 1];
  }
  return null;
}

/** The paper's own simple macros: name -> { args, body }. */
function readMacros(source) {
  const macros = new Map();
  const define = (name, args, body) => {
    if (/#[1-9]/.test(body.replace(/#[1-9]/g, (m) => (Number(m[1]) <= args ? "" : m)))) return;
    macros.set(name, { args, body });
  };
  const newcommand = /\\(?:re|provide)?newcommand\*?\s*(?:\{\s*\\([A-Za-z]+)\s*\}|\\([A-Za-z]+))\s*(?:\[(\d)\])?\s*(\[)?/g;
  for (let m; (m = newcommand.exec(source)); ) {
    if (m[4]) continue; // an optional-argument default: not a simple macro
    const body = readGroup(source, newcommand.lastIndex);
    if (!body) continue;
    define(m[1] ?? m[2], Number(m[3] ?? 0), body[0]);
  }
  const def = /\\def\s*\\([A-Za-z]+)((?:#[1-9])*)\s*(?=\{)/g;
  for (let m; (m = def.exec(source)); ) {
    const body = readGroup(source, def.lastIndex);
    if (body) define(m[1], m[2].length / 2, body[0]);
  }
  const operator = /\\DeclareMathOperator\s*\{\s*\\([A-Za-z]+)\s*\}\s*(?=\{)/g;
  for (let m; (m = operator.exec(source)); ) {
    const body = readGroup(source, operator.lastIndex);
    if (body) define(m[1], 0, `\\operatorname{${body[0]}}`);
  }
  return macros;
}

/** Expand the paper's macros; null when an expansion cannot be done faithfully. */
function expand(tex, macros) {
  let out = tex;
  for (let round = 0; round < 12; round++) {
    let changed = false;
    let next = "";
    for (let i = 0; i < out.length; ) {
      const m = out[i] === "\\" ? /^\\([A-Za-z]+)/.exec(out.slice(i, i + 40)) : null;
      const macro = m ? macros.get(m[1]) : undefined;
      if (!m) {
        // Copy a control symbol whole, so `\\` is never read as a backslash and a name.
        const take = out[i] === "\\" ? 2 : 1;
        next += out.slice(i, i + take);
        i += take;
        continue;
      }
      if (!macro) {
        next += m[0];
        i += m[0].length;
        continue;
      }
      let at = i + m[0].length;
      const args = [];
      for (let k = 0; k < macro.args; k++) {
        while (out[at] === " " || out[at] === "\n") at++;
        const group = readGroup(out, at);
        if (group) {
          args.push(group[0]);
          at = group[1];
        } else {
          const token = /^(\\[A-Za-z]+|\\.|[^\s{}])/.exec(out.slice(at, at + 40));
          if (!token) return null;
          args.push(token[0]);
          at += token[0].length;
        }
      }
      let body = macro.body.replace(/#([1-9])/g, (_, n) => args[Number(n) - 1]);
      // TeX drops the spaces after a control word; keep the next letter from joining an expansion that ends in one.
      while (out[at] === " ") at++;
      if (/\\[A-Za-z]+$/.test(body) && /[A-Za-z]/.test(out[at] ?? "")) body += " ";
      next += body;
      i = at;
      changed = true;
    }
    out = next;
    if (!changed) return out;
  }
  return null; // still expanding after twelve rounds: recursive
}

const DISPLAY_ENVS = ["equation", "equation*", "align", "align*", "gather", "gather*", "displaymath"];

/** Display and inline math of a document body, in order of appearance. */
function findMath(body) {
  const display = [];
  let rest = body;
  const take = (re, wrap) => {
    rest = rest.replace(re, (_, inner) => {
      display.push(wrap(inner));
      return " ";
    });
  };
  for (const env of DISPLAY_ENVS) {
    const name = env.replace("*", "\\*");
    const wrap = env.startsWith("align") ? (s) => `\\begin{aligned}${s}\\end{aligned}`
      : env.startsWith("gather") ? (s) => `\\begin{gathered}${s}\\end{gathered}`
      : (s) => s;
    take(new RegExp(`\\\\begin\\{${name}\\}([\\s\\S]*?)\\\\end\\{${name}\\}`, "g"), wrap);
  }
  take(/\\\[([\s\S]*?)\\\]/g, (s) => s);
  take(/\$\$([\s\S]*?)\$\$/g, (s) => s);
  // Whatever display environments remain (multline, eqnarray...) are not harvested; drop them so their
  // contents are not mistaken for inline math.
  rest = rest.replace(/\\begin\{(multline|eqnarray|flalign|alignat)\*?\}[\s\S]*?\\end\{\1\*?\}/g, " ");
  const inline = [];
  for (const m of rest.matchAll(/(?<!\\)\$((?:[^$\\]|\\.)+?)\$/g)) inline.push(m[1]);
  for (const m of rest.matchAll(/\\\(([\s\S]*?)\\\)/g)) inline.push(m[1]);
  return { display, inline };
}

/** Tidy one equation's source, or say why it cannot be used. */
function prepare(raw, macros, kind) {
  let tex = raw
    .replace(/\\label\s*\{[^{}]*\}/g, "")
    .replace(/\\(nonumber|notag)\b/g, "")
    .replace(/\\begin\{split\}/g, "\\begin{aligned}")
    .replace(/\\end\{split\}/g, "\\end{aligned}")
    .replace(/\s+/g, " ")
    .trim();
  tex = expand(tex, macros);
  if (tex == null) return { why: "macro could not be expanded" };
  tex = tex.replace(/\s+/g, " ").trim();
  if (!/^[\x20-\x7e]*$/.test(tex)) return { why: "non-ASCII characters" };
  if (tex.includes("$") || tex.includes("#") || tex.includes("~")) return { why: "nested math, parameter or tie" };
  if (tex.length > (kind === "display" ? 260 : 110)) return { why: "too long" };
  let depth = 0;
  for (let i = 0; i < tex.length; i++) {
    if (tex[i] === "\\") i++;
    else if (tex[i] === "{") depth++;
    else if (tex[i] === "}" && --depth < 0) break;
  }
  if (depth !== 0) return { why: "unbalanced braces" };
  if (/^[\^_]/.test(tex)) return { why: "script with no base" };
  if (BLACKBOARD_NON_LETTER.test(tex)) return { why: "blackboard bold of a non-letter" };
  const envs = [...tex.matchAll(/\\(begin|end)\{([^{}]*)\}/g)];
  if (envs.some((m) => !ENVIRONMENTS.has(m[2]))) return { why: "environment outside the vocabulary" };
  const opens = envs.filter((m) => m[1] === "begin").length;
  if (opens !== envs.length - opens) return { why: "unbalanced environments" };
  if (kind === "inline" && (opens > 0 || tex.includes("\\\\"))) return { why: "inline math with rows" };
  if (opens === 0 && (tex.includes("\\\\") || /(?<!\\)&/.test(tex))) return { why: "rows outside an environment" };
  if (/\[[^\]]*(pt|em|ex|cm|mm)\]/.test(tex)) return { why: "explicit spacing" };
  for (const m of tex.matchAll(/\\([A-Za-z]+|.)/g)) {
    const name = m[1];
    const ok = /^[A-Za-z]/.test(name) ? VOCABULARY.has(name) : CONTROL_SYMBOLS.has(name);
    if (!ok) return { why: "command outside the vocabulary", command: name };
  }
  const key = canonicalLatex(tex);
  if (key === "empty" || key === "unparsed") return { why: "not parsed by the normaliser" };
  if (treeSize(parseLatex(tex)) < (kind === "display" ? 5 : 4)) return { why: "trivial" };
  return { tex, key };
}

// ---------------------------------------------------------------------------
// TeX: which equations compile in the harness, and how wide they come out
// ---------------------------------------------------------------------------

/** Compile; on errors return the ids of the offending equations instead of the boxes. */
function tryCompile(work, name, equations, options) {
  const { preambleBefore = "", ...rest } = options;
  const tex = texSource(equations, { ...rest, preamble: `${preambleBefore}${PREAMBLE}` });
  writeFileSync(join(work, `${name}.tex`), tex);
  try {
    execFileSync("pdflatex", ["-interaction=nonstopmode", "-no-shell-escape", `${name}.tex`], { cwd: work, stdio: "pipe", timeout: 180_000 });
  } catch {
    // Errors are read from the log below.
  }
  const log = existsSync(join(work, `${name}.log`)) ? readFileSync(join(work, `${name}.log`), "latin1") : "";
  const lines = tex.split("\n");
  const bad = new Set();
  for (const m of log.matchAll(/\n!(?:[^\n]*\n){1,12}?l\.(\d+)/g)) {
    const id = /^\\i?eq\{([^}]+)\}/.exec(lines[Number(m[1]) - 1] ?? "")?.[1];
    if (id) bad.add(id);
  }
  if (bad.size > 0) return { bad };
  if (/\n!/.test(log) || !existsSync(join(work, `${name}.pdf`))) return { bad: new Set(equations.map((e) => e.id)) };
  const boxes = new Map();
  for (const line of readFileSync(join(work, `${name}.pos`), "latin1").split("\n")) {
    const m = /^(\S+) (-?\d+) (-?\d+) ([\d.]+)pt ([\d.]+)pt ([\d.]+)pt (\d+)$/.exec(line.trim());
    if (!m) continue;
    const pt = 72 / 72.27;
    boxes.set(m[1], { x: Number(m[2]) / 65781.76, y: Number(m[3]) / 65781.76, wd: Number(m[4]) * pt, ht: Number(m[5]) * pt, dp: Number(m[6]) * pt, page: Number(m[7]) - 1 });
  }
  return { boxes, lost: /Missing character/.test(log), pdf: readFileSync(join(work, `${name}.pdf`)) };
}

/** The equations that compile cleanly, with their boxes. */
function compileClean(work, name, equations, options = {}) {
  let list = equations;
  for (let round = 0; round < 8 && list.length > 0; round++) {
    const result = tryCompile(work, name, list, options);
    if (result.bad) {
      list = list.filter((e) => !result.bad.has(e.id));
      continue;
    }
    if (result.lost) {
      // A glyph missing from a font is not tied to a line in the log: halve.
      if (list.length === 1) return { equations: [], boxes: new Map() };
      const half = Math.ceil(list.length / 2);
      const a = compileClean(work, name, list.slice(0, half), options);
      const b = compileClean(work, name, list.slice(half), options);
      list = [...a.equations, ...b.equations];
      continue;
    }
    return { equations: list, boxes: result.boxes, pdf: result.pdf };
  }
  return { equations: [], boxes: new Map() };
}

/** `n` items spread evenly over a list, in order. */
function spread(list, n) {
  if (list.length <= n) return list;
  return Array.from({ length: n }, (_, i) => list[Math.floor((i * list.length) / n)]);
}

// ---------------------------------------------------------------------------
// harvest
// ---------------------------------------------------------------------------

async function harvest() {
  const work = mkdtempSync(join(tmpdir(), "ito-real-"));
  const papers = [];
  const equations = [];
  const seen = new Set();
  const rejected = new Map();
  const commands = new Map();
  const totals = { papersTried: 0, noSource: 0, tooFew: 0, found: 0, usable: 0, compiled: 0 };
  const count = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

  for (const [set, quota] of QUOTAS) {
    const candidates = await listPapers(set);
    console.log(`${set}: ${candidates.length} openly licensed records in the window`);
    let accepted = 0;
    for (const paper of candidates) {
      if (accepted >= quota) break;
      if (papers.some((p) => p.id === paper.id)) continue;
      totals.papersTried++;
      const files = await fetchSource(paper.id);
      if (!files) {
        totals.noSource++;
        continue;
      }
      const source = files.map(stripComments).join("\n");
      const macros = readMacros(source);
      const found = findMath(source.slice(Math.max(0, source.indexOf("\\begin{document}"))));
      const usable = { display: [], inline: [] };
      const local = new Set();
      for (const kind of ["display", "inline"]) {
        for (const raw of found[kind]) {
          totals.found++;
          const r = prepare(raw, macros, kind);
          if (r.why) {
            count(rejected, r.why);
            if (r.command) count(commands, r.command);
            continue;
          }
          if (seen.has(r.key) || local.has(r.key)) {
            count(rejected, "duplicate");
            continue;
          }
          local.add(r.key);
          totals.usable++;
          usable[kind].push({ id: `t${usable[kind].length}`, latex: r.tex, key: r.key });
        }
      }
      // Compile a spread of each kind, keep what is clean and fits, then thin to the per-paper cap.
      const display = compileClean(work, "probe-d", spread(usable.display, PER_PAPER * 3));
      const fitsD = display.equations.filter((e) => display.boxes.get(e.id).wd <= MAX_DISPLAY_WIDTH);
      if (fitsD.length < MIN_DISPLAY) {
        totals.tooFew++;
        continue;
      }
      const inline = compileClean(work, "probe-i", spread(usable.inline, PER_PAPER * 3), { inline: true });
      const fitsI = inline.equations.filter((e) => inline.boxes.get(e.id).wd <= 230 && inline.boxes.get(e.id).ht + inline.boxes.get(e.id).dp <= 14);
      totals.compiled += fitsD.length + fitsI.length;
      const split = accepted % 2 === 0 ? "dev" : "heldout";
      papers.push({ ...paper, set, split });
      for (const [kind, list] of [["display", spread(fitsD, PER_PAPER)], ["inline", spread(fitsI, PER_PAPER)]]) {
        for (const e of list) {
          seen.add(e.key);
          equations.push({ paper: paper.id, kind, latex: e.latex });
        }
      }
      accepted++;
      console.log(`  ${paper.id} -> ${split}: ${Math.min(fitsD.length, PER_PAPER)} display, ${Math.min(fitsI.length, PER_PAPER)} inline (${macros.size} macros)`);
    }
    if (accepted < quota) console.log(`  only ${accepted} of ${quota} papers found for ${set}`);
  }
  rmSync(work, { recursive: true, force: true });

  const store = {
    note: "Equations from the LaTeX source of openly licensed arXiv papers, written by `node scripts/gen-real-paper-tier.mjs harvest`. Each equation is the authors' source with their simple macros expanded; `paper` is its arXiv identifier. See `papers` for titles, authors and licences.",
    window: WINDOW,
    papers,
    equations,
  };
  writeFileSync(STORE, JSON.stringify(store, null, 1) + "\n");

  console.log(`\npapers: ${papers.length} kept of ${totals.papersTried} tried (${totals.noSource} without TeX source, ${totals.tooFew} with too few usable display equations)`);
  console.log(`equations: ${totals.found} found in the kept and rejected papers, ${totals.usable} passed the source checks, ${equations.length} kept`);
  console.log("left out, by reason:");
  for (const [why, n] of [...rejected].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${why}`);
  console.log("most common commands outside the vocabulary:");
  console.log("  " + [...commands].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([c, n]) => `\\${c} ${n}`).join("  "));
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

function build() {
  const store = JSON.parse(readFileSync(STORE, "utf8"));
  const work = mkdtempSync(join(tmpdir(), "ito-real-"));
  // An equation that either corpus already has from the grammar or the
  // curated list would be a duplicate there, and a leak between the two sets.
  const taken = new Set();
  for (const dir of ["corpus", "corpus-heldout"]) {
    const manifest = JSON.parse(readFileSync(resolve(LATEX_DIR, dir, "manifest.json"), "utf8"));
    for (const [id, latex] of Object.entries(manifest.equations)) {
      if (!/^[rq][di]\d/.test(id)) taken.add(canonicalLatex(latex));
    }
  }
  for (const [split, dir, prefix] of [["dev", "corpus", "r"], ["heldout", "corpus-heldout", "q"]]) {
    const papers = store.papers.filter((p) => p.split === split);
    const ids = new Set(papers.map((p) => p.id));
    const mine = store.equations.filter((e) => {
      const key = canonicalLatex(e.latex);
      // `$^{3}$` is a footnote or affiliation mark, not a formula anyone would select.
      if (!ids.has(e.paper) || taken.has(key) || /^[\^_]/.test(e.latex)) return false;
      // `\mathbb{1}` needs a font this harness does not have; with amssymb alone it prints an unrelated symbol.
      if (BLACKBOARD_NON_LETTER.test(e.latex)) return false;
      taken.add(key); // also keeps a formula from appearing both displayed and inline
      return true;
    });
    const number = (list) => list.map((e, i) => ({ ...e, id: `${prefix}${e.kind[0]}${String(i + 1).padStart(4, "0")}` }));
    const display = number(mine.filter((e) => e.kind === "display"));
    const inline = number(mine.filter((e) => e.kind === "inline"));
    const d = compileClean(work, "real-display", display);
    const i = compileClean(work, "real-inline", inline, { inline: true });
    if (d.equations.length !== display.length || i.equations.length !== inline.length) {
      throw new Error(`${split}: some stored equations no longer compile; run the harvest again`);
    }
    // The same equations as a reader meets them: a sentence's mark against the
    // formula, a number beside the equation with a box as wide as the column,
    // and the older dvips route to PDF.
    const marked = compile(work, "real-inline-punct", texSource(inline, { inline: true, marks: true, preamble: PREAMBLE }));
    const numbered = compile(work, "real-display-numbered", texSource(display, { numbered: true, preamble: PREAMBLE }));
    const dvips = compile(work, "real-display-dvips", texSource(display, { preamble: PREAMBLE, dvi: true }), { dvips: true });
    // Latin Modern as papers load it: T1 text, the math fonts in TeX's own encodings.
    const lm = compileClean(work, "real-display-lm", display, { preambleBefore: String.raw`\usepackage[T1]{fontenc}\usepackage{lmodern}` });
    const lmDisplay = lm.equations;
    const out = resolve(LATEX_DIR, dir);
    writeFileSync(join(out, "real-display.pdf"), d.pdf);
    writeFileSync(join(out, "real-inline.pdf"), i.pdf);
    writeFileSync(join(out, "real-inline-punct.pdf"), marked.pdf);
    writeFileSync(join(out, "real-display-numbered.pdf"), numbered.pdf);
    writeFileSync(join(out, "real-display-dvips.pdf"), dvips.pdf);
    writeFileSync(join(out, "real-display-lm.pdf"), lm.pdf);
    const manual = {
      note: "Written by `node scripts/gen-real-paper-tier.mjs`; merged into manifest.json by scripts/gen-math-corpus.mjs. Do not edit by hand.",
      sources: papers.map((p) => ({ arxiv: p.id, title: p.title, authors: p.authors.join(", "), licence: p.licence })),
      equations: Object.fromEntries([...display, ...inline].map((e) => [e.id, e.latex])),
      tiers: {
        "real-display": tier(
          "real-display.pdf",
          `display equations from the source of ${papers.length} openly licensed arXiv papers, set by the benchmark harness (pdfLaTeX, Computer Modern 10pt)`,
          placements(display, d.boxes, PAD_DISPLAY, PAD_DISPLAY),
        ),
        "real-inline": tier(
          "real-inline.pdf",
          `inline formulas from the same ${papers.length} papers, each inside a line of prose`,
          placements(inline, i.boxes, PAD_INLINE_X, PAD_INLINE_Y),
        ),
        "real-inline-punct": tier(
          "real-inline-punct.pdf",
          "the same inline formulas, each with a comma, full stop, semicolon or colon set against it and inside the box",
          placements(inline, marked.boxes, PAD_INLINE_X, PAD_INLINE_Y, MARK_WIDTH),
        ),
        "real-display-numbered": tier(
          "real-display-numbered.pdf",
          "the same display equations, centred and numbered as `equation` sets them, with a box as wide as the text column",
          columnPlacements(display, numbered.boxes, PAD_DISPLAY),
        ),
        "real-display-dvips": tier(
          "real-display-dvips.pdf",
          "the same display equations by the older route (latex, dvips, Ghostscript), which draws rules as image masks",
          placements(display, dvips.boxes, PAD_DISPLAY, PAD_DISPLAY),
        ),
        "real-display-lm": tier(
          "real-display-lm.pdf",
          "the same display equations in Latin Modern (lmodern with T1 text), less any with a glyph Latin Modern lacks",
          placements(lmDisplay, lm.boxes, PAD_DISPLAY, PAD_DISPLAY),
        ),
      },
    };
    const json = JSON.stringify(manual, null, 1)
      .replace(/\[\n\s+("[^"]+"),\n\s+(\d+),\n\s+([-\d.]+),\n\s+([-\d.]+),\n\s+([-\d.]+),\n\s+([-\d.]+)\n\s+\]/g, "[$1,$2,$3,$4,$5,$6]");
    writeFileSync(join(out, "manual-tiers.json"), json + "\n");
    console.log(`${split}: ${papers.length} papers, ${display.length} display and ${inline.length} inline equations -> ${out}`);
  }
  rmSync(work, { recursive: true, force: true });

  // Credit, in one readable place. CC BY asks for the author, the licence and a note of changes.
  const credit = [
    "# Sources of the real-paper tiers",
    "",
    "Generated by `node scripts/gen-real-paper-tier.mjs`. Do not edit by hand.",
    "",
    "The `real-display` and `real-inline` tiers contain equations taken from the LaTeX source of the",
    "arXiv papers below, each used under the licence shown. The equations were changed in these ways:",
    "the authors' macros were expanded, labels and numbering commands were removed, and each equation",
    "was typeset on its own by the benchmark's harness. Nothing else of the papers is reproduced.",
    "",
    "| arXiv | Title | Authors | Licence | Set |",
    "|---|---|---|---|---|",
    ...store.papers.map((p) => {
      const licence = p.licence.includes("publicdomain") ? `[CC0 1.0](${p.licence})` : `[CC BY 4.0](${p.licence})`;
      const cell = (t) => t.replace(/\|/g, "\\|");
      return `| [${p.id}](https://arxiv.org/abs/${p.id}) | ${cell(p.title)} | ${cell(p.authors.join(", "))} | ${licence} | ${p.split === "dev" ? "development" : "held-out"} |`;
    }),
    "",
  ];
  writeFileSync(resolve(LATEX_DIR, "SOURCES.md"), credit.join("\n"));

  // Fold the new tiers into each manifest.
  execFileSync("node", [join(HERE, "gen-math-corpus.mjs")], { stdio: "inherit" });
  execFileSync("node", [join(HERE, "gen-math-corpus.mjs"), "heldout"], { stdio: "inherit" });
}

if (process.argv[2] === "harvest") await harvest();
else build();
