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
//
// `node scripts/gen-math-corpus.mjs heldout` builds the held-out set instead,
// under corpus-heldout/: grammar equations drawn by the same rule from a
// different seed, less any that the development corpus also drew, typeset as
//   tex-display.pdf      Computer Modern 10pt, display style
//   tex-inline.pdf       Computer Modern 10pt, inside a line of prose
//   tex-display-12pt.pdf Computer Modern 12pt, display style (other design sizes)
// It is measured only at phase gates and reported in aggregate, so the
// extractor cannot be tuned to it (see the benchmark README).
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
import {
  MAX_DISPLAY_WIDTH, PAD_DISPLAY, PAD_INLINE_X, PAD_INLINE_Y, PAGE_H, PAGE_W, compile, placements,
  texSource, tier,
} from "./math-corpus/typeset.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LATEX_DIR = resolve(HERE, "../src/science/research/latex");

const SETS = {
  dev: { dir: "corpus", seed: 20261113, curated: true, prefix: "g" },
  heldout: { dir: "corpus-heldout", seed: 58231907, curated: false, prefix: "h" },
};
const SET = process.argv[2] === "heldout" ? "heldout" : "dev";
const OUT = resolve(LATEX_DIR, SETS[SET].dir);
/** Generated equations wanted in the display tier (see the 99.9% note below). */
const GENERATED = 3300;
/** Equations (curated first) in the smaller font / ToUnicode tiers. */
const SUBSET = 760;
/** Pages of the display tier rasterised into the scanned tier. */
const SCANNED_PAGES = 6;
// ---------------------------------------------------------------------------
// Equations
// ---------------------------------------------------------------------------

/**
 * The equations of one set: the curated list (if any), then the first
 * GENERATED distinct draws of the grammar. `exclude` holds canonical forms a
 * draw may not repeat.
 */
function buildEquations({ seed, curated, prefix }, exclude = new Set()) {
  const seen = new Set(exclude);
  const out = [];
  const add = (id, latex, source) => {
    const key = canonicalLatex(latex);
    if (seen.has(key) || key === "empty" || key === "unparsed") return false;
    seen.add(key);
    out.push({ id, latex, source });
    return true;
  };
  if (curated) {
    CURATED.forEach((latex, i) => {
      if (!add(`c${String(i + 1).padStart(3, "0")}`, latex, "curated")) {
        throw new Error(`curated equation ${i + 1} duplicates an earlier one: ${latex}`);
      }
    });
  }
  const grammar = makeGrammar(seed);
  let n = 0;
  for (let guard = 0; n < GENERATED && guard < GENERATED * 20; guard++) {
    const latex = grammar.equation();
    if (latex.length > 150) continue; // would not fit the measure
    if (add(`${prefix}${String(n + 1).padStart(4, "0")}`, latex, "generated")) n++;
  }
  if (n < GENERATED) throw new Error(`grammar produced only ${n} distinct equations`);
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

/**
 * Compile the display tier, dropping generated equations too wide for the
 * measure. Returns the kept equations and their compiled page.
 */
function compileDisplay(work, name, equations, options = {}) {
  let compiled = compile(work, name, texSource(equations, options));
  const tooWide = equations.filter((e) => compiled.boxes.get(e.id).wd > MAX_DISPLAY_WIDTH);
  if (tooWide.length > 0) {
    const curated = tooWide.find((e) => e.source === "curated");
    if (curated) throw new Error(`curated equation too wide: ${curated.latex}`);
    const drop = new Set(tooWide.map((e) => e.id));
    equations = equations.filter((e) => !drop.has(e.id));
    compiled = compile(work, name, texSource(equations, options));
  }
  return { equations, compiled, dropped: tooWide.length };
}

/** Equations that sit in a line of prose: one line tall and not too wide. */
function inlineCandidates(equations, tags, display) {
  const stacked = (e) => tags.get(e.id).some((t) => t === "multi-line" || t === "matrix" || t === "cases");
  return equations.filter((e) => !stacked(e) && display.boxes.get(e.id).wd <= 230);
}

/**
 * Tiers this script cannot generate (real papers, other producers) live in
 * the set's manual-tiers.json, next to their PDFs, so regenerating the TeX
 * tiers never discards them. scripts/gen-real-paper-tier.mjs writes that file.
 */
function mergeManualTiers(manifest) {
  const manualPath = join(OUT, "manual-tiers.json");
  if (!existsSync(manualPath)) return;
  const manual = JSON.parse(readFileSync(manualPath, "utf8"));
  if (manual.sources) manifest.sources = manual.sources;
  for (const [id, latex] of Object.entries(manual.equations ?? {})) {
    if (id in manifest.equations) throw new Error(`manual-tiers.json reuses equation id ${id}`);
    manifest.equations[id] = latex;
  }
  for (const [name, t] of Object.entries(manual.tiers ?? {})) {
    if (name in manifest.tiers) throw new Error(`manual-tiers.json redefines tier ${name}`);
    manifest.tiers[name] = t;
  }
}

async function buildDev(work) {
  const built = compileDisplay(work, "tex-display", buildEquations(SETS.dev));
  const { equations, compiled: display } = built;

  const tags = new Map(equations.map((e) => [e.id, constructsOf(parseLatex(e.latex))]));
  const inlineSet = inlineCandidates(equations, tags, display);
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

  const manifest = {
    version: 1,
    seed: SETS.dev.seed,
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

  mergeManualTiers(manifest);

  const files = {
    "tex-display.pdf": display.pdf,
    "tex-inline.pdf": inline.pdf,
    "tex-times.pdf": times.pdf,
    "tex-tounicode.pdf": tounicode.pdf,
    "scanned.pdf": scanned,
  };
  return { manifest, files, tags, dropped: built.dropped, curated: CURATED.length };
}

async function buildHeldout(work) {
  // Draw by exactly the rule the development corpus used (first GENERATED
  // distinct equations, none equal to a curated one), then drop whatever the
  // development corpus also drew. Short equations are the likeliest to be
  // drawn twice and the easiest to extract, so the held-out set ends up
  // slightly harder than a fresh draw. To keep the comparison fair the
  // development side must lose the same equations: their ids are recorded
  // here, and the benchmark compares the two sets with those left out.
  const dev = buildEquations(SETS.dev);
  const key = (e) => canonicalLatex(e.latex);
  const curatedKeys = new Set(dev.filter((e) => e.source === "curated").map(key));
  const devGenerated = new Map(dev.filter((e) => e.source === "generated").map((e) => [key(e), e.id]));
  const drawn = buildEquations(SETS.heldout, curatedKeys);
  const excludedDevIds = drawn.filter((e) => devGenerated.has(key(e))).map((e) => devGenerated.get(key(e))).sort();
  const built = compileDisplay(work, "tex-display", drawn.filter((e) => !devGenerated.has(key(e))));
  if (built.dropped > 0) throw new Error("held-out equations were dropped as too wide; the development corpus dropped none");
  const { equations, compiled: display } = built;

  const tags = new Map(equations.map((e) => [e.id, constructsOf(parseLatex(e.latex))]));
  const inlineSet = inlineCandidates(equations, tags, display);
  const inline = compile(work, "tex-inline", texSource(inlineSet, { inline: true }));

  // 12pt sets the same equations from other design sizes (cmr12/8/6 rather
  // than cmr10/7/5), which the development corpus never shows. Everything is
  // a fifth larger, so take the first equations that still fit the measure.
  const wide = compile(work, "probe-12pt", texSource(equations.slice(0, SUBSET * 2), { pointSize: 12 }));
  const fits = equations
    .slice(0, SUBSET * 2)
    .filter((e) => wide.boxes.get(e.id).wd <= MAX_DISPLAY_WIDTH)
    .slice(0, SUBSET);
  if (fits.length < SUBSET) throw new Error(`only ${fits.length} equations fit the measure at 12pt`);
  const twelve = compile(work, "tex-display-12pt", texSource(fits, { pointSize: 12 }));

  const manifest = {
    version: 1,
    set: "heldout",
    seed: SETS.heldout.seed,
    note: "Held-out set, generated by `node scripts/gen-math-corpus.mjs heldout`. Measured only at phase gates and reported in aggregate; do not inspect individual failures. Boxes are PDF points, origin bottom-left: [id, page, x0, y0, x1, y1].",
    comparison: {
      note: "Both sets are the first distinct draws of the same grammar; equations drawn by both were removed from this set. The development equations listed here are those twins: leave them out of the development side when comparing rates, so both sides lose the same (short, easy) equations.",
      drawn: drawn.length,
      excludedDevIds,
    },
    tiers: {
      "tex-display": tier(
        "tex-display.pdf",
        "pdfLaTeX, Computer Modern 10pt, display style, one equation per line",
        placements(equations, display.boxes, PAD_DISPLAY, PAD_DISPLAY),
      ),
      "tex-inline": tier(
        "tex-inline.pdf",
        "pdfLaTeX, Computer Modern 10pt, text style, equation inside a line of prose",
        placements(inlineSet, inline.boxes, PAD_INLINE_X, PAD_INLINE_Y),
      ),
      "tex-display-12pt": tier(
        "tex-display-12pt.pdf",
        "pdfLaTeX, Computer Modern 12pt, display style (design sizes absent from the development corpus)",
        placements(fits, twelve.boxes, PAD_DISPLAY, PAD_DISPLAY),
      ),
    },
    equations: Object.fromEntries(equations.map((e) => [e.id, e.latex])),
  };
  mergeManualTiers(manifest);
  const files = {
    "tex-display.pdf": display.pdf,
    "tex-inline.pdf": inline.pdf,
    "tex-display-12pt.pdf": twelve.pdf,
  };
  return { manifest, files, tags, dropped: built.dropped, curated: 0 };
}

async function main() {
  const work = mkdtempSync(join(tmpdir(), "ito-math-corpus-"));
  mkdirSync(OUT, { recursive: true });
  const { manifest, files, tags, dropped, curated } = SET === "heldout" ? await buildHeldout(work) : await buildDev(work);

  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(OUT, name), bytes);
  // One placement per line keeps the file diffable without being huge.
  const json = JSON.stringify(manifest, null, 1)
    .replace(/\[\n\s+("[^"]+"),\n\s+(\d+),\n\s+([-\d.]+),\n\s+([-\d.]+),\n\s+([-\d.]+),\n\s+([-\d.]+)\n\s+\]/g, "[$1,$2,$3,$4,$5,$6]");
  writeFileSync(join(OUT, "manifest.json"), json + "\n");
  rmSync(work, { recursive: true, force: true });

  // Coverage summary.
  const counts = new Map();
  for (const t of tags.values()) for (const c of t) counts.set(c, (counts.get(c) ?? 0) + 1);
  console.log(`${SET} set -> ${OUT}`);
  console.log(`equations: ${tags.size} (${curated} curated), dropped as too wide: ${dropped}`);
  for (const [name, t] of Object.entries(manifest.tiers)) {
    const pages = Math.max(...t.placements.map((p) => p[1])) + 1;
    console.log(`  ${name.padEnd(18)} ${String(t.placements.length).padStart(5)} equations, ${pages} pages`);
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
