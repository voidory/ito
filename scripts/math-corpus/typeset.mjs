// Typesetting for the benchmark corpus: set a list of equations with pdfLaTeX,
// one per line or each inside a line of prose, and record the box TeX gave
// each one. Shared by scripts/gen-math-corpus.mjs (the generated tiers) and
// scripts/gen-real-paper-tier.mjs (equations harvested from papers).

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
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

export function texSource(equations, { inline = false, preamble = "", pointSize = 10 }) {
  const lines = [
    String.raw`\documentclass[${pointSize}pt]{article}`,
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
export function compile(workDir, name, tex) {
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

export const round = (v) => Math.round(v * 100) / 100;

/** Selection rectangles in PDF points (y up): [id, page, x0, y0, x1, y1]. */
export function placements(equations, boxes, padX, padY) {
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

export const tier = (pdf, description, list) => ({
  pdf,
  description,
  pageWidth: PAGE_W,
  pageHeight: PAGE_H,
  placements: list,
});

/** Widest display equation that still leaves room for the selection padding. */
export const MAX_DISPLAY_WIDTH = PAGE_W - 2 * MARGIN - 12 - 2 * PAD_DISPLAY;
