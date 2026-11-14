// Spike for Phase 2 of docs/LATEX-EXTRACTION-PLAN.md: what does pdf.js expose
// about each glyph and rule on a page, and is it enough to read TeX math
// exactly? Findings are written up in docs/spikes/pdf-glyph-geometry.md; this
// script produces every number quoted there.
//
//   node scripts/spikes/pdf-glyph-geometry.mjs            all four TeX tiers
//   node scripts/spikes/pdf-glyph-geometry.mjs tex-inline  one tier
//
// It reads the development corpus only. The held-out set is never opened.
//
// Needs Node 22.18+ (it imports normalize.ts through type stripping). The slot
// names in the last section come from TeX's own AFM files, found with
// `kpsewhich`; without a TeX installation that section is skipped.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { parseLatex } from "../../src/science/research/latex/normalize.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = resolve(HERE, "../../src/science/research/latex/corpus");
const manifest = JSON.parse(readFileSync(resolve(CORPUS, "manifest.json"), "utf8"));
const { OPS, Util } = pdfjs;

/** How far outside the ink the corpus builder drew each box, in points. */
const PAD = { "tex-inline": [1.5, 2] };
const padOf = (tier) => PAD[tier] ?? [3, 3];

// ---------------------------------------------------------------------------
// One pass over a page's operator list -> glyphs and rules in PDF user space
// ---------------------------------------------------------------------------

const IDENTITY = [1, 0, 0, 1, 0, 0];
const freshState = () => ({
  ctm: IDENTITY, tm: IDENTITY, x: 0, y: 0, lineX: 0, lineY: 0,
  font: null, size: 0, dir: 1, charSpacing: 0, wordSpacing: 0, hScale: 1, rise: 0, leading: 0,
  lineWidth: 1,
});

/**
 * @returns {{glyphs: object[], rules: object[], unknownOps: Set<string>}}
 *   glyphs: { font, code, unicode, x, y, advance, size, angle }
 *   rules:  { x0, x1, y, thickness, kind } for thin horizontal strokes / fills
 */
function pageModel(page, opList) {
  const glyphs = [];
  const rules = [];
  const stack = [];
  let st = freshState();
  let path = null;
  const fontOf = (id) => page.commonObjs.get(id);

  const paintStroke = () => {
    if (!path) return;
    const scale = Math.sqrt(Math.abs(st.ctm[0] * st.ctm[3] - st.ctm[1] * st.ctm[2]));
    for (const seg of path.lines) {
      const [ax, ay] = Util.applyTransform(seg[0], path.ctm);
      const [bx, by] = Util.applyTransform(seg[1], path.ctm);
      if (Math.abs(ay - by) < 0.01 && Math.abs(ax - bx) > 0.5) {
        rules.push({ x0: Math.min(ax, bx), x1: Math.max(ax, bx), y: ay, thickness: st.lineWidth * scale, kind: "stroke" });
      }
    }
  };
  const paintFill = () => {
    if (!path) return;
    for (const [x, y, w, h] of path.rects) {
      const [ax, ay] = Util.applyTransform([x, y], path.ctm);
      const [bx, by] = Util.applyTransform([x + w, y + h], path.ctm);
      const width = Math.abs(bx - ax);
      const height = Math.abs(by - ay);
      if (height < 2 && width > height) {
        rules.push({ x0: Math.min(ax, bx), x1: Math.max(ax, bx), y: (ay + by) / 2, thickness: height, kind: "fill" });
      }
    }
  };

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const a = opList.argsArray[i];
    switch (fn) {
      case OPS.save:
        stack.push({ ...st });
        break;
      case OPS.restore:
        if (stack.length > 0) st = stack.pop();
        break;
      case OPS.transform:
        st.ctm = Util.transform(st.ctm, a);
        break;
      case OPS.paintFormXObjectBegin:
        stack.push({ ...st });
        if (a[0]) st.ctm = Util.transform(st.ctm, a[0]);
        break;
      case OPS.paintFormXObjectEnd:
        if (stack.length > 0) st = stack.pop();
        break;
      case OPS.setLineWidth:
        st.lineWidth = a[0];
        break;
      case OPS.beginText:
        st.tm = IDENTITY;
        st.x = st.y = st.lineX = st.lineY = 0;
        break;
      case OPS.setFont: {
        st.font = fontOf(a[0]);
        st.size = Math.abs(a[1]);
        st.dir = a[1] < 0 ? -1 : 1;
        break;
      }
      case OPS.setCharSpacing:
        st.charSpacing = a[0];
        break;
      case OPS.setWordSpacing:
        st.wordSpacing = a[0];
        break;
      case OPS.setHScale:
        st.hScale = a[0] / 100;
        break;
      case OPS.setLeading:
        st.leading = -a[0];
        break;
      case OPS.setTextRise:
        st.rise = a[0];
        break;
      case OPS.setLeadingMoveText:
        st.leading = a[1];
        st.x = st.lineX += a[0];
        st.y = st.lineY += a[1];
        break;
      case OPS.moveText:
        st.x = st.lineX += a[0];
        st.y = st.lineY += a[1];
        break;
      case OPS.setTextMatrix:
        st.tm = a.slice(0, 6);
        st.x = st.lineX = 0;
        st.y = st.lineY = 0;
        break;
      case OPS.nextLine:
        st.x = st.lineX += 0;
        st.y = st.lineY += st.leading;
        break;
      case OPS.showText: {
        const font = st.font;
        if (!font || font.isType3Font) break;
        const base = Util.transform(st.ctm, st.tm);
        const xScale = Math.hypot(base[0], base[1]);
        const yScale = Math.hypot(base[2], base[3]);
        const angle = Math.atan2(base[1], base[0]);
        const advanceScale = st.size * (font.fontMatrix?.[0] ?? 0.001);
        const hScale = st.hScale * st.dir;
        let x = 0;
        for (const g of a[0]) {
          if (typeof g === "number") {
            x -= (g * st.size) / 1000;
            continue;
          }
          const spacing = (g.isSpace ? st.wordSpacing : 0) + st.charSpacing;
          const charWidth = g.width * advanceScale + spacing * st.dir;
          const [ux, uy] = Util.applyTransform([st.x + x * hScale, st.y + st.rise], base);
          glyphs.push({
            font: font.name,
            code: g.originalCharCode,
            unicode: g.unicode,
            isSpace: g.isSpace,
            x: ux,
            y: uy,
            advance: g.width * advanceScale * Math.abs(hScale) * xScale,
            size: st.size * yScale,
            angle,
          });
          x += charWidth;
        }
        st.x += x * hScale;
        break;
      }
      case OPS.constructPath: {
        // One path can arrive as several constructPath operations (pdf.js
        // splits it where an operator-list chunk ends), so accumulate until
        // the path is painted.
        const [ops, args] = a;
        const lines = path?.lines ?? [];
        const rects = path?.rects ?? [];
        let k = 0;
        let cur = path?.cur ?? null;
        for (const op of ops) {
          if (op === OPS.moveTo) {
            cur = [args[k], args[k + 1]];
            k += 2;
          } else if (op === OPS.lineTo) {
            const next = [args[k], args[k + 1]];
            if (cur) lines.push([cur, next]);
            cur = next;
            k += 2;
          } else if (op === OPS.rectangle) {
            rects.push([args[k], args[k + 1], args[k + 2], args[k + 3]]);
            k += 4;
          } else if (op === OPS.curveTo) {
            cur = [args[k + 4], args[k + 5]];
            k += 6;
          } else if (op === OPS.curveTo2 || op === OPS.curveTo3) {
            cur = [args[k + 2], args[k + 3]];
            k += 4;
          }
        }
        path = { lines, rects, cur, ctm: st.ctm };
        break;
      }
      case OPS.stroke:
      case OPS.closeStroke:
        paintStroke();
        path = null;
        break;
      case OPS.fill:
      case OPS.eoFill:
        paintFill();
        path = null;
        break;
      case OPS.fillStroke:
      case OPS.eoFillStroke:
      case OPS.closeFillStroke:
      case OPS.closeEOFillStroke:
        paintFill();
        paintStroke();
        path = null;
        break;
      case OPS.endPath:
        path = null;
        break;
      default:
        break;
    }
  }
  return { glyphs, rules };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** "HWMSQP+CMMI10" -> { face: "CMMI10", family: "CMMI", design: 10 } */
function fontParts(name) {
  const face = String(name ?? "").replace(/^[A-Z]{6}\+/, "");
  const m = /^(.*?)(\d+)$/.exec(face);
  return { face, family: (m ? m[1] : face).toUpperCase(), design: m ? Number(m[2]) : null };
}

function labelsOf(tree) {
  const out = new Map();
  const walk = (n) => {
    out.set(n.t, (out.get(n.t) ?? 0) + 1);
    n.c.forEach(walk);
  };
  walk(tree);
  return out;
}

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
const fmt = (v, d = 3) => (v == null || Number.isNaN(v) ? "n/a" : v.toFixed(d));

/** TeX's own name for each slot of a font, from its AFM file. */
const afmCache = new Map();
function afmNames(face) {
  const key = face.toLowerCase();
  if (afmCache.has(key)) return afmCache.get(key);
  let names = null;
  try {
    const file = execFileSync("kpsewhich", [`${key}.afm`], { encoding: "utf8" }).trim();
    if (file) {
      names = new Map();
      for (const line of readFileSync(file, "latin1").split("\n")) {
        const m = /^C (-?\d+) ;.*? N (\S+) ;/.exec(line);
        if (m && Number(m[1]) >= 0) names.set(Number(m[1]), m[2]);
      }
    }
  } catch {
    names = null;
  }
  afmCache.set(key, names);
  return names;
}

// ---------------------------------------------------------------------------
// Slot predicates: "this slot is on the page" <=> "the ground truth has this"
// ---------------------------------------------------------------------------

const slot = (family, ...codes) => (g) => g.family === family && codes.includes(g.code);
const range = (family, lo, hi) => (g) => g.family === family && g.code >= lo && g.code <= hi;
const any = (...tests) => (g) => tests.some((t) => t(g));
const has = (...labels) => (L) => labels.some((l) => L.has(l));
const hasPrefix = (prefix) => (L) => [...L.keys()].some((l) => l.startsWith(prefix));
const isLetter = (g) => (g.code >= 65 && g.code <= 90) || (g.code >= 97 && g.code <= 122);

/** Each row: a symbol or style, the TeX font slots that print it, and the tree labels that mean it. */
const PREDICATES = [
  ["\\sum", any(slot("CMEX", 0x50, 0x58)), has("\\sum")],
  ["\\prod", any(slot("CMEX", 0x51, 0x59)), has("\\prod")],
  ["\\int", any(slot("CMEX", 0x52, 0x5a)), has("\\int")],
  ["\\oint", any(slot("CMEX", 0x48, 0x49)), has("\\oint")],
  ["\\bigcup", any(slot("CMEX", 0x53, 0x5b)), has("\\bigcup")],
  ["\\bigcap", any(slot("CMEX", 0x54, 0x5c)), has("\\bigcap")],
  ["radical sign", any(slot("CMSY", 0x70), range("CMEX", 0x70, 0x76)), has("sqrt", "root")],
  ["\\neq (negation slash)", slot("CMSY", 0x36), has("\\neq", "\\not")],
  ["\\setminus", slot("CMSY", 0x6e), has("\\setminus")],
  ["\\varepsilon", slot("CMMI", 0x22), has("\\varepsilon")],
  ["\\epsilon", slot("CMMI", 0x0f), has("\\epsilon")],
  ["\\vartheta", slot("CMMI", 0x23), has("\\vartheta")],
  ["\\theta", slot("CMMI", 0x12), has("\\theta")],
  ["\\varphi", slot("CMMI", 0x27), has("\\varphi")],
  ["\\phi", slot("CMMI", 0x1e), has("\\phi")],
  ["blackboard letter", (g) => g.family === "MSBM" && isLetter(g), hasPrefix("font:bb")],
  ["bold letter or digit", (g) => g.family === "CMBX", hasPrefix("font:bf")],
  ["calligraphic letter", range("CMSY", 0x41, 0x5a), hasPrefix("font:cal")],
  ["upright letter", (g) => g.family === "CMR" && isLetter(g), (L) => hasPrefix("font:rm")(L) || hasPrefix("fn:")(L)],
  ["\\hat", any(slot("CMR", 0x5e), range("CMEX", 0x62, 0x64)), has("accent:hat")],
  ["\\tilde", any(slot("CMR", 0x7e), range("CMEX", 0x65, 0x67)), has("accent:tilde")],
  ["\\bar", slot("CMR", 0x16), has("accent:bar")],
  ["\\dot", slot("CMR", 0x5f), has("accent:dot")],
  ["\\ddot", slot("CMR", 0x7f), has("accent:ddot")],
  ["\\vec", slot("CMMI", 0x7e), has("accent:vec")],
];

/**
 * `\notin` is not a slot: LaTeX prints `\in` and centres a slash over it. So
 * it is read from two glyphs that overlap, which only geometry can tell.
 */
function hasCancelledIn(glyphs) {
  const ins = glyphs.filter((g) => g.family === "CMSY" && g.code === 0x32);
  const slashes = glyphs.filter((g) => g.family === "CMMI" && g.code === 0x3d);
  return ins.some((i) => slashes.some((s) => s.x < i.x + i.advance && s.x + s.advance > i.x && Math.abs(s.y - i.y) < 0.01));
}

/** Rules TeX draws for an equation: one per fraction, radical and over/underline. */
function expectedRules(labels) {
  let n = 0;
  for (const l of ["frac", "sqrt", "root", "accent:overline", "accent:underline"]) n += labels.get(l) ?? 0;
  return n;
}

// ---------------------------------------------------------------------------
// Per-tier measurement
// ---------------------------------------------------------------------------

async function measureTier(tierName) {
  const tier = manifest.tiers[tierName];
  const data = new Uint8Array(readFileSync(resolve(CORPUS, tier.pdf)));
  const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
  const [padX, padY] = padOf(tierName);
  const isolated = tierName !== "tex-inline"; // pages hold equations and nothing else

  const byPage = new Map();
  for (const p of tier.placements) byPage.set(p[1], [...(byPage.get(p[1]) ?? []), p]);

  const timings = [];
  const fonts = new Map(); // face -> glyph count
  const sizes = new Map(); // "family@size" -> count
  const slots = new Map(); // "FACEFAMILY:code" -> { unicode: Map, n, face }
  const perEquation = []; // { id, glyphs, rules }
  let glyphTotal = 0;
  let orphanGlyphs = 0;
  let rotated = 0;
  let textItems = 0;
  let textItemsMatched = 0;
  const ruleKinds = new Map();

  for (const [pageIndex, boxes] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    const page = await doc.getPage(pageIndex + 1);
    const t0 = performance.now();
    const opList = await page.getOperatorList();
    timings.push(performance.now() - t0);
    const model = pageModel(page, opList);

    // Independent check of the transform tracking: every run that pdf.js's own
    // text extraction reports must start at a glyph origin computed here.
    if (pageIndex % 10 === 0) {
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!item.str || !item.str.trim()) continue;
        textItems++;
        const [, , , , e, f] = item.transform;
        if (model.glyphs.some((g) => Math.abs(g.x - e) < 0.02 && Math.abs(g.y - f) < 0.02)) textItemsMatched++;
      }
    }

    const buckets = boxes.map((b) => ({ id: b[0], box: b, glyphs: [], rules: [] }));
    for (const g of model.glyphs) {
      if (g.isSpace) continue;
      glyphTotal++;
      if (Math.abs(g.angle) > 1e-6) rotated++;
      const parts = fontParts(g.font);
      g.family = parts.family;
      g.face = parts.face;
      fonts.set(parts.face, (fonts.get(parts.face) ?? 0) + 1);
      const sizeKey = `${parts.family}@${g.size.toFixed(2)}`;
      sizes.set(sizeKey, (sizes.get(sizeKey) ?? 0) + 1);
      const home = buckets.find(({ box }) => g.x >= box[2] - 0.01 && g.x <= box[4] + 0.01 && g.y >= box[3] - 0.01 && g.y <= box[5] + 0.01);
      if (!home) {
        orphanGlyphs++;
        continue;
      }
      home.glyphs.push(g);
      const key = `${parts.family}:${g.code}`;
      let s = slots.get(key);
      if (!s) slots.set(key, (s = { family: parts.family, code: g.code, face: parts.face, n: 0, unicode: new Map() }));
      s.n++;
      s.unicode.set(g.unicode, (s.unicode.get(g.unicode) ?? 0) + 1);
    }
    for (const r of model.rules) {
      ruleKinds.set(r.kind, (ruleKinds.get(r.kind) ?? 0) + 1);
      const mid = (r.x0 + r.x1) / 2;
      const home = buckets.find(({ box }) => mid >= box[2] && mid <= box[4] && r.y >= box[3] && r.y <= box[5]);
      if (home) home.rules.push(r);
    }
    perEquation.push(...buckets);
    page.cleanup();
  }

  // --- geometry against TeX's own record of each box ---
  const leftGap = [];
  const rightGap = [];
  let emptyBoxes = 0;
  for (const e of perEquation) {
    if (e.glyphs.length === 0) {
      emptyBoxes++;
      continue;
    }
    const inkLeft = Math.min(...e.glyphs.map((g) => g.x));
    const inkRight = Math.max(...e.glyphs.map((g) => g.x + g.advance));
    leftGap.push(inkLeft - (e.box[2] + padX));
    rightGap.push(e.box[4] - padX - inkRight);
  }
  leftGap.sort((a, b) => a - b);
  rightGap.sort((a, b) => a - b);

  // --- slot predicates ---
  const predicateRows = PREDICATES.map(([name, slotTest, labelTest]) => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    const examples = [];
    for (const e of perEquation) {
      const labels = labelsOf(parseLatex(manifest.equations[e.id]));
      const onPage = e.glyphs.some(slotTest);
      const inTruth = labelTest(labels);
      if (onPage && inTruth) tp++;
      else if (onPage && !inTruth) {
        fp++;
        if (examples.length < 2) examples.push(`FP ${e.id}: ${manifest.equations[e.id]}`);
      } else if (!onPage && inTruth) {
        fn++;
        if (examples.length < 2) examples.push(`FN ${e.id}: ${manifest.equations[e.id]}`);
      }
    }
    return { name, tp, fp, fn, examples };
  });
  {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const e of perEquation) {
      const onPage = hasCancelledIn(e.glyphs);
      const inTruth = labelsOf(parseLatex(manifest.equations[e.id])).has("\\notin");
      if (onPage && inTruth) tp++;
      else if (onPage) fp++;
      else if (inTruth) fn++;
    }
    predicateRows.push({ name: "\\notin (slash overlapping \\in)", tp, fp, fn, examples: [] });
  }

  // --- rules ---
  let rulesAgree = 0;
  const ruleMismatch = [];
  for (const e of perEquation) {
    const want = expectedRules(labelsOf(parseLatex(manifest.equations[e.id])));
    if (want === e.rules.length) rulesAgree++;
    else if (ruleMismatch.length < 4) ruleMismatch.push(`${e.id}: expected ${want}, found ${e.rules.length}: ${manifest.equations[e.id]}`);
  }

  timings.sort((a, b) => a - b);
  await doc.destroy();
  return {
    tierName, isolated, pages: byPage.size, equations: perEquation.length, glyphTotal, orphanGlyphs, rotated,
    emptyBoxes, textItems, textItemsMatched, leftGap, rightGap, fonts, sizes, slots, predicateRows,
    rulesAgree, ruleMismatch, ruleKinds, timings,
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function report(r) {
  const out = [];
  out.push(`\n## ${r.tierName}: ${r.equations} equations on ${r.pages} pages, ${r.glyphTotal} glyphs`);

  out.push("\n### getOperatorList cost (Node, per page, ms)");
  const mean = r.timings.reduce((s, v) => s + v, 0) / r.timings.length;
  out.push(`mean ${fmt(mean, 1)}  median ${fmt(quantile(r.timings, 0.5), 1)}  p95 ${fmt(quantile(r.timings, 0.95), 1)}  max ${fmt(r.timings[r.timings.length - 1], 1)}`);

  out.push("\n### Position tracking");
  out.push(`text runs reported by getTextContent that start at a glyph origin computed from the operator list: ${r.textItemsMatched}/${r.textItems}`);
  out.push(`boxes with no glyph inside: ${r.emptyBoxes}/${r.equations}`);
  out.push(r.isolated
    ? `glyphs outside every box (pages hold only equations): ${r.orphanGlyphs}/${r.glyphTotal}`
    : `glyphs outside every box (surrounding prose, expected): ${r.orphanGlyphs}/${r.glyphTotal}`);
  out.push(`rotated glyphs: ${r.rotated}`);
  const q = (arr) => `min ${fmt(arr[0])}  median ${fmt(quantile(arr, 0.5))}  p95 ${fmt(quantile(arr, 0.95))}  max ${fmt(arr[arr.length - 1])}`;
  out.push(`leftmost glyph origin minus TeX's box left edge (pt):  ${q(r.leftGap)}`);
  out.push(`  within 0.02pt: ${r.leftGap.filter((v) => Math.abs(v) < 0.02).length}/${r.leftGap.length}`);
  out.push(`TeX's box right edge minus rightmost glyph end (pt):    ${q(r.rightGap)}`);
  out.push(`  glyph end past the box by more than 0.02pt: ${r.rightGap.filter((v) => v < -0.02).length}/${r.rightGap.length}`);

  out.push("\n### Fonts (glyphs per face)");
  out.push([...r.fonts.entries()].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} ${n}`).join(", "));
  out.push("\n### Rendered sizes per family (family@size: glyphs)");
  out.push([...r.sizes.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([f, n]) => `${f}: ${n}`).join(", "));

  out.push("\n### Slot -> symbol: does the slot's presence agree with the ground truth?");
  out.push("symbol | both | slot only (false positive) | truth only (missed)");
  for (const p of r.predicateRows) {
    out.push(`${p.name} | ${p.tp} | ${p.fp} | ${p.fn}`);
    for (const ex of p.examples) out.push(`    ${ex}`);
  }

  out.push("\n### Rules (thin horizontal strokes or fills)");
  out.push(`kinds: ${[...r.ruleKinds.entries()].map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);
  out.push(`equations whose rule count equals fractions + radicals + over/underlines in the ground truth: ${r.rulesAgree}/${r.equations}`);
  for (const m of r.ruleMismatch) out.push(`    ${m}`);

  out.push("\n### Slots in use, and what pdf.js reports as their Unicode");
  out.push(`distinct (family, slot) pairs: ${r.slots.size}`);
  const wrong = [];
  let unnamed = 0;
  for (const s of [...r.slots.values()].sort((a, b) => a.family.localeCompare(b.family) || a.code - b.code)) {
    const names = afmNames(s.face);
    const name = names?.get(s.code);
    if (names && !name) unnamed++;
    const uni = [...s.unicode.keys()].map((u) => JSON.stringify(u)).join("/");
    wrong.push(`${s.family}:${s.code} (${name ?? "?"}) x${s.n} -> ${uni}`);
  }
  out.push(`slots with no name in TeX's AFM file: ${unnamed}`);
  out.push(wrong.join("\n"));
  return out.join("\n");
}

const tiers = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["tex-display", "tex-inline", "tex-tounicode", "tex-times"];
console.log(`pdfjs-dist ${pdfjs.version}, node ${process.version}`);
for (const name of tiers) {
  if (!manifest.tiers[name]) throw new Error(`unknown tier ${name}`);
  console.log(report(await measureTier(name)));
}
