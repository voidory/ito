// Typesetting for the benchmark corpus: set a list of equations with pdfLaTeX,
// one per line or each inside a line of prose, and record the box TeX gave
// each one. Shared by scripts/gen-math-corpus.mjs (the generated tiers) and
// scripts/gen-real-paper-tier.mjs (equations harvested from papers).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PAGE_W = 612;
export const PAGE_H = 792;
export const MARGIN = 54;
/** How loosely a reader draws the box, in points beyond the ink. */
export const PAD_DISPLAY = 3;
export const PAD_INLINE_X = 1.5;
export const PAD_INLINE_Y = 2;
export const SP_PER_BP = 65781.76;

// ---------------------------------------------------------------------------
// TeX
// ---------------------------------------------------------------------------

const LEAD = ["The value of", "We then obtain", "Recall that", "It follows that", "Suppose", "Note that", "Here", "In this case"];
const TAIL = ["is used in the estimate below.", "holds throughout.", "by the previous lemma.", "as claimed.", "in what follows.", "for the remainder of the section.", "and the result follows."];

/** Sentence marks set against an inline formula, in turn. */
export const MARKS = [",", ".", ";", ":"];
/** Room the mark takes beyond the formula's own box, in points. */
export const MARK_WIDTH = 3.5;
/** A numbered equation wider than this has its number set on the next line, as amsmath does. */
export const NUMBER_FITS = 400;
/** How far below the equation's box a number on its own line reaches. */
export const NUMBER_DROP = 16;
/** Equation numbers as papers write them. */
export const numberLabel = (i) => [`${i + 1}`, `${1 + (i % 7)}.${i + 1}`, `A.${i + 1}`, `${i + 1}a`][i % 4];

/**
 * `inline`: each equation inside a line of prose; with `marks`, a comma, full
 * stop, semicolon or colon directly after it. `numbered`: each display
 * equation centred with its number flush right, as `equation` sets it.
 */
export function texSource(equations, { inline = false, preamble = "", pointSize = 10, marks = false, numbered = false, dvi = false }) {
  const lines = [
    String.raw`\documentclass[${pointSize}pt]{article}`,
    String.raw`\usepackage[letterpaper,margin=${MARGIN}bp]{geometry}`,
    String.raw`\usepackage{amsmath,amssymb}`,
    preamble,
    // In DVI mode nothing tells TeX the page size that \pdfsavepos measures from.
    dvi ? String.raw`\pdfpagewidth=${PAGE_W}bp \pdfpageheight=${PAGE_H}bp` : "",
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
    String.raw`\newcommand{\neqfit}[3]{\par\noindent\hbox to\hsize{\hfil\eqmark{#1}\box\eqbox\hfil\llap{(#3)}}\par\vskip 16bp}`,
    String.raw`\newcommand{\neqwide}[3]{\par\noindent\hbox to\hsize{\hfil\eqmark{#1}\box\eqbox\hfil}\par\nointerlineskip\vskip 4bp\noindent\hbox to\hsize{\hfil(#3)}\par\vskip 16bp}`,
    String.raw`\newcommand{\neqn}[3]{\setbox\eqbox\hbox{$\displaystyle #2$}\ifdim\wd\eqbox>${NUMBER_FITS}bp \neqwide{#1}{#2}{#3}\else\neqfit{#1}{#2}{#3}\fi}`,
    String.raw`\newcommand{\ieqm}[5]{\setbox\eqbox\hbox{$#2$}\par\noindent #3 \eqmark{#1}\box\eqbox#5 #4\par\vskip 9bp}`,
    String.raw`\begin{document}`,
  ];
  equations.forEach((e, i) => {
    if (inline && marks) lines.push(`\\ieqm{${e.id}}{${e.latex}}{${LEAD[i % LEAD.length]}}{${TAIL[i % TAIL.length]}}{${MARKS[i % MARKS.length]}}`);
    else if (inline) lines.push(`\\ieq{${e.id}}{${e.latex}}{${LEAD[i % LEAD.length]}}{${TAIL[i % TAIL.length]}}`);
    else if (numbered) lines.push(`\\neqn{${e.id}}{${e.latex}}{${numberLabel(i)}}`);
    else lines.push(`\\eq{${e.id}}{${e.latex}}`);
  });
  lines.push(String.raw`\end{document}`);
  return lines.join("\n") + "\n";
}

/**
 * Compile `tex`; returns the PDF bytes and each equation's recorded box. With
 * `dvips`, by the older route (latex, dvips, Ghostscript), which draws rules
 * as image masks and embeds fonts differently; it needs `dvips` and `gs`.
 */
export function compile(workDir, name, tex, { dvips = false } = {}) {
  writeFileSync(join(workDir, `${name}.tex`), tex);
  try {
    execFileSync(dvips ? "latex" : "pdflatex", ["-interaction=nonstopmode", "-halt-on-error", `${name}.tex`], {
      cwd: workDir,
      stdio: "pipe",
    });
    if (dvips) {
      const quiet = { cwd: workDir, stdio: "pipe", env: { ...process.env, SOURCE_DATE_EPOCH: "0" } };
      execFileSync("dvips", ["-q", "-t", "letter", "-Ppdf", "-o", `${name}.ps`, `${name}.dvi`], quiet);
      execFileSync("gs", ["-q", "-dBATCH", "-dNOPAUSE", "-dSAFER", "-sDEVICE=pdfwrite", "-dCompatibilityLevel=1.4", `-sOutputFile=${name}.pdf`, `${name}.ps`], quiet);
    }
  } catch (err) {
    if (!existsSync(join(workDir, `${name}.log`))) throw err;
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

export const round = (v) => Math.round(v * 100) / 100;

/** Selection rectangles in PDF points (y up): [id, page, x0, y0, x1, y1]. `extraRight` widens each to take in a mark. */
export function placements(equations, boxes, padX, padY, extraRight = 0) {
  const out = [];
  for (const e of equations) {
    const b = boxes.get(e.id);
    if (!b) throw new Error(`no recorded position for ${e.id}`);
    out.push([
      e.id,
      b.page,
      round(b.x - padX),
      round(b.y - b.dp - padY),
      round(b.x + b.wd + padX + extraRight),
      round(b.y + b.ht + padY),
    ]);
  }
  return out;
}

/** Boxes as wide as the text column, taking in the equation's number wherever it was set. */
export function columnPlacements(equations, boxes, padY) {
  return equations.map((e) => {
    const b = boxes.get(e.id);
    if (!b) throw new Error(`no recorded position for ${e.id}`);
    const drop = b.wd > NUMBER_FITS ? NUMBER_DROP : 0;
    return [e.id, b.page, MARGIN - 2, round(b.y - b.dp - padY - drop), PAGE_W - MARGIN + 2, round(b.y + b.ht + padY)];
  });
}

export const tier = (pdf, description, list) => ({
  pdf,
  description,
  pageWidth: PAGE_W,
  pageHeight: PAGE_H,
  placements: list,
});

/** Widest display equation that still leaves room for the selection padding. */
export const MAX_DISPLAY_WIDTH = PAGE_W - 2 * MARGIN - 12 - 2 * PAD_DISPLAY;
