// Build the LaTeX-extraction benchmark corpus (docs/LATEX-EXTRACTION-PLAN.md,
// Phase 1): real TeX-typeset equations, each with the box a reader would draw
// around it and the LaTeX it should come back as.
//
// Output, under src/science/research/latex/corpus/:
//   manifest.json        equations (id -> LaTeX) + per-tier placements
//   tex-display.pdf      Computer Modern, display style, every equation
//   tex-inline.pdf       Computer Modern, text style, inside a line of prose
//   tex-times.pdf        Times math (mathptmx), display style, a subset
//   tex-tounicode.pdf    Computer Modern with ToUnicode maps, a subset
//   scanned.pdf          image-only pages rasterised from tex-display.pdf
// A hand-written corpus/manual-tiers.json ({ equations, tiers } in the same
// shape) is merged in, for tiers this script cannot generate.
//
// Needs `pdflatex` (texlive-latex-base + texlive-fonts-recommended) and
// `pdftoppm` (poppler-utils) on PATH. Only this script needs them: the PDFs
// are committed. Run with `npm run gen-math-corpus`. Deterministic: the same
// seed and TeX version give byte-identical output.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";
import { canonicalLatex, constructsOf, parseLatex } from "../src/science/research/latex/normalize.ts";
import { CURATED } from "./math-corpus/curated.mjs";
import { makeGrammar } from "./math-corpus/grammar.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../src/science/research/latex/corpus");

const SEED = 20261113;
/** Generated equations wanted in the display tier (see the 99.9% note below). */
const GENERATED = 3300;
/** Equations (curated first) in the smaller font / ToUnicode tiers. */
const SUBSET = 760;
/** Pages of the display tier rasterised into the scanned tier. */
const SCANNED_PAGES = 6;
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;
/** How loosely a reader draws the box, in points beyond the ink. */
const PAD_DISPLAY = 3;
const PAD_INLINE_X = 1.5;
const PAD_INLINE_Y = 2;
const SP_PER_BP = 65781.76;

// ---------------------------------------------------------------------------
// Equations
// ---------------------------------------------------------------------------

function buildEquations() {
  const seen = new Set();
  const out = [];
  const add = (id, latex, source) => {
    const key = canonicalLatex(latex);
    if (seen.has(key) || key === "empty" || key === "unparsed") return false;
    seen.add(key);
    out.push({ id, latex, source });
    return true;
  };
  CURATED.forEach((latex, i) => {
    if (!add(`c${String(i + 1).padStart(3, "0")}`, latex, "curated")) {
      throw new Error(`curated equation ${i + 1} duplicates an earlier one: ${latex}`);
    }
  });
  const grammar = makeGrammar(SEED);
  let n = 0;
  for (let guard = 0; n < GENERATED && guard < GENERATED * 20; guard++) {
    const latex = grammar.equation();
    if (latex.length > 150) continue; // would not fit the measure
    if (add(`g${String(n + 1).padStart(4, "0")}`, latex, "generated")) n++;
  }
  if (n < GENERATED) throw new Error(`grammar produced only ${n} distinct equations`);
  return out;
}

// ---------------------------------------------------------------------------
// TeX
// ---------------------------------------------------------------------------

const LEAD = ["The value of", "We then obtain", "Recall that", "It follows that", "Suppose", "Note that", "Here", "In this case"];
const TAIL = ["is used in the estimate below.", "holds throughout.", "by the previous lemma.", "as claimed.", "in what follows.", "for the remainder of the section.", "and the result follows."];

function texSource(equations, { inline = false, preamble = "" }) {
  const lines = [
    String.raw`\documentclass[10pt]{article}`,
    String.raw`\usepackage[letterpaper,margin=${MARGIN}bp]{geometry}`,
    String.raw`\usepackage{amsmath,amssymb}`,
    preamble,
    // Reproducible bytes: no dates, no engine banner, a fixed trailer id.
    String.raw`\pdfinfoomitdate=1 \pdfsuppressptexinfo=-1 \pdftrailerid{ito-math-corpus}`,
    String.raw`\pdfcompresslevel=9 \pdfobjcompresslevel=2`,
    String.raw`\tracinglostchars=2`,
    String.raw`\pagestyle{empty}\parindent=0pt\raggedbottom\raggedright`,
    String.raw`\newwrite\posfile \immediate\openout\posfile=\jobname.pos`,
    String.raw`\newbox\eqbox`,
    // Record where the box lands: \pdfsavepos marks the baseline-left corner
    // and the write is deferred to shipout, when the position is known. The
    // box's own dimensions are expanded now, before the next equation reuses it.
    String.raw`\newcommand{\eqmark}[1]{\pdfsavepos\edef\next{\write\posfile{#1 \noexpand\the\pdflastxpos\space\noexpand\the\pdflastypos\space\the\wd\eqbox\space\the\ht\eqbox\space\the\dp\eqbox\space\noexpand\the\count0}}\next}`,
    String.raw`\newcommand{\eq}[2]{\setbox\eqbox\hbox{$\displaystyle #2$}\par\noindent\hskip 12bp\eqmark{#1}\box\eqbox\par\vskip 16bp}`,
    String.raw`\newcommand{\ieq}[4]{\setbox\eqbox\hbox{$#2$}\par\noindent #3 \eqmark{#1}\box\eqbox{} #4\par\vskip 9bp}`,
    String.raw`\begin{document}`,
  ];
  equations.forEach((e, i) => {
    lines.push(
      inline
        ? `\\ieq{${e.id}}{${e.latex}}{${LEAD[i % LEAD.length]}}{${TAIL[i % TAIL.length]}}`
        : `\\eq{${e.id}}{${e.latex}}`,
    );
  });
  lines.push(String.raw`\end{document}`);
  return lines.join("\n") + "\n";
}

/** Compile `tex`; returns the PDF bytes and each equation's recorded box. */
function compile(workDir, name, tex) {
  writeFileSync(join(workDir, `${name}.tex`), tex);
  try {
    execFileSync("pdflatex", ["-interaction=nonstopmode", "-halt-on-error", `${name}.tex`], {
      cwd: workDir,
      stdio: "pipe",
    });
  } catch {
    const log = readFileSync(join(workDir, `${name}.log`), "latin1");
    const at = log.indexOf("\n!");
    const lineNo = /\nl\.(\d+)/.exec(log.slice(at))?.[1];
    const culprit = lineNo ? tex.split("\n")[Number(lineNo) - 1] : "";
    throw new Error(`pdflatex failed in ${name}:\n${log.slice(at, at + 400)}\n${culprit}`);
  }
  const log = readFileSync(join(workDir, `${name}.log`), "latin1");
  const lost = log.match(/Missing character[^\n]*/g) ?? [];
  if (lost.length > 0) {
    throw new Error(`${name}: ${lost.length} glyph(s) missing from the font, e.g. ${lost[0]}`);
  }
  const boxes = new Map();
  for (const line of readFileSync(join(workDir, `${name}.pos`), "latin1").split("\n")) {
    const m = /^(\S+) (-?\d+) (-?\d+) ([\d.]+)pt ([\d.]+)pt ([\d.]+)pt (\d+)$/.exec(line.trim());
    if (!m) continue;
    const pt = 72 / 72.27; // TeX points -> PDF points
    boxes.set(m[1], {
      x: Number(m[2]) / SP_PER_BP,
      y: Number(m[3]) / SP_PER_BP,
      wd: Number(m[4]) * pt,
      ht: Number(m[5]) * pt,
      dp: Number(m[6]) * pt,
      page: Number(m[7]) - 1,
    });
  }
  return { pdf: readFileSync(join(workDir, `${name}.pdf`)), boxes };
}

const round = (v) => Math.round(v * 100) / 100;

/** Selection rectangles in PDF points (y up): [id, page, x0, y0, x1, y1]. */
function placements(equations, boxes, padX, padY) {
  const out = [];
  for (const e of equations) {
    const b = boxes.get(e.id);
    if (!b) throw new Error(`no recorded position for ${e.id}`);
    out.push([
      e.id,
      b.page,
      round(b.x - padX),
      round(b.y - b.dp - padY),
      round(b.x + b.wd + padX),
      round(b.y + b.ht + padY),
    ]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scanned tier
// ---------------------------------------------------------------------------

async function rasterise(workDir, pdfName, pages) {
  execFileSync("pdftoppm", ["-r", "150", "-gray", "-png", "-f", "1", "-l", String(pages), pdfName, "scan"], {
    cwd: workDir,
  });
  const pngs = readdirSync(workDir).filter((f) => /^scan-\d+\.png$/.test(f)).sort();
  const doc = await PDFDocument.create();
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  doc.setProducer("ito math corpus");
  doc.setCreator("ito math corpus");
  for (const f of pngs) {
    const img = await doc.embedPng(readFileSync(join(workDir, f)));
    const page = doc.addPage([PAGE_W, PAGE_H]);
    page.drawImage(img, { x: 0, y: 0, width: PAGE_W, height: PAGE_H });
  }
  return doc.save();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const work = mkdtempSync(join(tmpdir(), "ito-math-corpus-"));
  mkdirSync(OUT, { recursive: true });
  let equations = buildEquations();

  // Display tier first: it also tells us which equations fit the measure.
  let display = compile(work, "tex-display", texSource(equations, {}));
  const maxWidth = PAGE_W - 2 * MARGIN - 12 - 2 * PAD_DISPLAY;
  const tooWide = equations.filter((e) => display.boxes.get(e.id).wd > maxWidth);
  if (tooWide.length > 0) {
    const drop = new Set(tooWide.map((e) => e.id));
    if (tooWide.some((e) => e.source === "curated")) {
      throw new Error(`curated equation too wide: ${tooWide.find((e) => e.source === "curated").latex}`);
    }
    equations = equations.filter((e) => !drop.has(e.id));
    display = compile(work, "tex-display", texSource(equations, {}));
  }

  const tags = new Map(equations.map((e) => [e.id, constructsOf(parseLatex(e.latex))]));
  const stacked = (e) => tags.get(e.id).some((t) => t === "multi-line" || t === "matrix" || t === "cases");
  const inlineSet = equations.filter((e) => !stacked(e) && display.boxes.get(e.id).wd <= 230);
  const subset = equations.slice(0, SUBSET);

  const inline = compile(work, "tex-inline", texSource(inlineSet, { inline: true }));
  const times = compile(work, "tex-times", texSource(subset, { preamble: String.raw`\usepackage{mathptmx}` }));
  const tounicode = compile(
    work,
    "tex-tounicode",
    texSource(subset, { preamble: String.raw`\input{glyphtounicode}\pdfgentounicode=1` }),
  );
  const scanned = await rasterise(work, "tex-display.pdf", SCANNED_PAGES);
  const displayPlacements = placements(equations, display.boxes, PAD_DISPLAY, PAD_DISPLAY);

  const tier = (pdf, description, list) => ({
    pdf,
    description,
    pageWidth: PAGE_W,
    pageHeight: PAGE_H,
    placements: list,
  });
  const manifest = {
    version: 1,
    seed: SEED,
    note: "Generated by scripts/gen-math-corpus.mjs. Boxes are PDF points, origin bottom-left: [id, page, x0, y0, x1, y1].",
    tiers: {
      "tex-display": tier(
        "tex-display.pdf",
        "pdfLaTeX, Computer Modern, display style, one equation per line",
        displayPlacements,
      ),
      "tex-inline": tier(
        "tex-inline.pdf",
        "pdfLaTeX, Computer Modern, text style, equation inside a line of prose",
        placements(inlineSet, inline.boxes, PAD_INLINE_X, PAD_INLINE_Y),
      ),
      "tex-times": tier(
        "tex-times.pdf",
        "pdfLaTeX, Times math (mathptmx), display style",
        placements(subset, times.boxes, PAD_DISPLAY, PAD_DISPLAY),
      ),
      "tex-tounicode": tier(
        "tex-tounicode.pdf",
        "pdfLaTeX, Computer Modern with ToUnicode maps (glyphtounicode), display style",
        placements(subset, tounicode.boxes, PAD_DISPLAY, PAD_DISPLAY),
      ),
      scanned: tier(
        "scanned.pdf",
        "image-only pages rasterised at 150 dpi from the display tier (no text layer)",
        displayPlacements.filter((p) => p[1] < SCANNED_PAGES),
      ),
    },
    equations: Object.fromEntries(equations.map((e) => [e.id, e.latex])),
  };

  // Hand-labelled tiers (real papers, other producers) live in their own file
  // so regenerating the TeX tiers never discards them.
  const manualPath = join(OUT, "manual-tiers.json");
  if (existsSync(manualPath)) {
    const manual = JSON.parse(readFileSync(manualPath, "utf8"));
    for (const [id, latex] of Object.entries(manual.equations ?? {})) {
      if (id in manifest.equations) throw new Error(`manual-tiers.json reuses equation id ${id}`);
      manifest.equations[id] = latex;
    }
    for (const [name, t] of Object.entries(manual.tiers ?? {})) {
      if (name in manifest.tiers) throw new Error(`manual-tiers.json redefines tier ${name}`);
      manifest.tiers[name] = t;
    }
  }

  writeFileSync(join(OUT, "tex-display.pdf"), display.pdf);
  writeFileSync(join(OUT, "tex-inline.pdf"), inline.pdf);
  writeFileSync(join(OUT, "tex-times.pdf"), times.pdf);
  writeFileSync(join(OUT, "tex-tounicode.pdf"), tounicode.pdf);
  writeFileSync(join(OUT, "scanned.pdf"), scanned);
  // One placement per line keeps the file diffable without being huge.
  const json = JSON.stringify(manifest, null, 1)
    .replace(/\[\n\s+("[^"]+"),\n\s+(\d+),\n\s+([-\d.]+),\n\s+([-\d.]+),\n\s+([-\d.]+),\n\s+([-\d.]+)\n\s+\]/g, "[$1,$2,$3,$4,$5,$6]");
  writeFileSync(join(OUT, "manifest.json"), json + "\n");
  rmSync(work, { recursive: true, force: true });

  // Coverage summary.
  const counts = new Map();
  for (const t of tags.values()) for (const c of t) counts.set(c, (counts.get(c) ?? 0) + 1);
  console.log(`equations: ${equations.length} (${CURATED.length} curated), dropped as too wide: ${tooWide.length}`);
  for (const [name, t] of Object.entries(manifest.tiers)) {
    const pages = Math.max(...t.placements.map((p) => p[1])) + 1;
    console.log(`  ${name.padEnd(14)} ${String(t.placements.length).padStart(5)} equations, ${pages} pages`);
  }
  console.log("constructs:");
  for (const [c, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c.padEnd(20)} ${n}`);
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
