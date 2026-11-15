/**
 * From a page's glyphs to identified math symbols
 * (docs/LATEX-EXTRACTION-PLAN.md, Phase 2).
 *
 * `pageMathModel.ts` says which font slot each glyph is. This module looks the
 * slot up in the generated table (`texFontSlots.ts`) and returns the glyphs of
 * a region as `MathGlyph`s that carry their exact LaTeX, class and font style,
 * for `mathLayout.ts` to arrange. Three things are settled here because they
 * are facts about glyphs, not about layout:
 *
 *   - composites: `\notin`, `\neq`, `\cong`, `\ldots`... are several glyphs at
 *     fixed offsets, and become one symbol;
 *   - assemblies: a delimiter or radical too tall for one glyph is a stack of
 *     pieces, and becomes one symbol;
 *   - the baseline of extension-font glyphs: TeX centres big operators and
 *     delimiters on the math axis and their own origin is at their top, so
 *     they are given the baseline of the line they are centred on.
 *
 * The tables cover Computer Modern and the AMS fonts, and the fonts of the
 * packages papers use to set mathematics in Times, Palatino and STIX
 * (mathptmx, txfonts, newtx, mathpazo, pxfonts, newpx, stix, stix2). A glyph
 * from any other font keeps the character pdf.js reports and no class: the
 * layout then falls back to its character heuristics for that glyph, with
 * exact geometry.
 *
 * Pure and DOM-free.
 */

import type { MathGlyph, MathRule } from "./mathLayout";
import type { ModelGlyph, PageMathModel } from "./pageMathModel";
import { TEX_ASSEMBLIES, TEX_BRACES, TEX_COMPOSITES, TEX_FONT_INK, TEX_FONT_SLOTS, TEX_KEYED_BY_CHARACTER } from "./texFontSlots";

/** TeX's math axis sits a quarter of an em above the baseline. */
const AXIS = 0.25;
/** How far a composite's part may sit from its recorded offset, in ems. */
const COMPOSITE_TOLERANCE = 0.09;
/** Font families whose glyphs are centred on the math axis, not set on the baseline. */
const AXIS_FAMILIES = new Set(["CMEX"]);
/** Classes a font may draw hanging from the origin even when most of its glyphs sit on the baseline (STIX Two Math). */
const HANGS = new Set(["open", "close", "fence", "radical"]);
const hanging = new Map<string, boolean>();
/**
 * Whether a family is an extension font: TeX's convention for those is that a
 * glyph hangs from its origin, so the origin says nothing about the line the
 * glyph is on. Computer Modern's is named; the others (txex, the STIX
 * extensions...) are known by their ink, most of which lies below the origin.
 */
function isAxisFamily(family: string): boolean {
  if (AXIS_FAMILIES.has(family)) return true;
  let hit = hanging.get(family);
  if (hit === undefined) {
    const flat = TEX_FONT_INK[family] ?? [];
    let below = 0;
    for (let i = 0; i + 2 < flat.length; i += 3) if (flat[i + 2]! <= 60 && flat[i + 1]! < -400) below++;
    hit = below >= 3 && below > flat.length / 3 / 2;
    hanging.set(family, hit);
  }
  return hit;
}

/** How much of a glyph's height the selection's top or bottom edge may cut off. */
const CUT_TOLERANCE = 0.25;

/**
 * Latin Modern is Computer Modern redrawn. Its math fonts keep TeX's math
 * encodings, so a slot means what it means in the Computer Modern font named
 * here. Its text fonts come in several encodings under one name (OT1 for the
 * roman of formulas, T1 for the text of most papers), so a slot alone does not
 * say which glyph it is; their glyph names are standard, though, and pdf.js
 * reads the character from them.
 */
const LATIN_MODERN: readonly (readonly [RegExp, string, "slot" | "character"])[] = [
  [/^LMMATHITALIC\d+-REGULAR$/, "CMMI", "slot"],
  [/^LMMATHITALIC\d+-BOLD$/, "CMMIB", "slot"],
  [/^LMMATHSYMBOLS\d+-REGULAR$/, "CMSY", "slot"],
  [/^LMMATHSYMBOLS\d+-BOLD$/, "CMBSY", "slot"],
  [/^LMMATHEXTENSION\d+-REGULAR$/, "CMEX", "slot"],
  [/^LMROMAN\d+-REGULAR$/, "CMR", "character"],
  [/^LMROMAN\d+-BOLD$/, "CMBX", "character"],
  [/^LMROMAN\d+-ITALIC$/, "CMTI", "character"],
  [/^LMROMAN\d+-BOLDITALIC$/, "CMBXTI", "character"],
  [/^LMSANS\d+-REGULAR$/, "CMSS", "character"],
  [/^LMMONO\d+-REGULAR$/, "CMTT", "character"],
];
/** Families that are several fonts under one name: a slot and the character together name a glyph. */
const KEYED_BY_CHARACTER = new Set(TEX_KEYED_BY_CHARACTER);
const resolved = new Map<string, { family: string; by: "slot" | "character" } | null>();
/** The family whose table reads this font, and whether by slot or by character. */
function tableOf(family: string): { family: string; by: "slot" | "character" } | null {
  let hit = resolved.get(family);
  if (hit === undefined) {
    hit = null;
    if (TEX_FONT_SLOTS[family] != null) hit = { family, by: "slot" };
    else {
      const alias = LATIN_MODERN.find(([pattern]) => pattern.test(family));
      if (alias) hit = { family: alias[1], by: alias[2] };
    }
    resolved.set(family, hit);
  }
  return hit;
}

/** Whether glyphs of this font family are identified from a slot table. */
export function hasSlotTable(family: string): boolean {
  return tableOf(family) != null;
}

/** What pdf.js reports for a character, as the table spells it. */
const CHARACTER_AS_TEX: Readonly<Record<string, string>> = {
  Γ: "\\Gamma", Δ: "\\Delta", Θ: "\\Theta", Λ: "\\Lambda", Ξ: "\\Xi", Π: "\\Pi", Σ: "\\Sigma",
  Υ: "\\Upsilon", Φ: "\\Phi", Ψ: "\\Psi", Ω: "\\Omega", "\u2126": "\\Omega", "\u2206": "\\Delta", "ﬁ": "fi", "ﬂ": "fl", "ﬀ": "ff", "ﬃ": "ffi",
  "ﬄ": "ffl", "–": "--", "—": "---", "’": "'", "{": "\\{", "}": "\\}",
  // Math accents are glyphs of the roman font; pdf.js reports the spacing or the combining form.
  "\u00af": "\\bar", "\u0304": "\\bar", "\u02c6": "\\hat", "\u0302": "\\hat", "\u02dc": "\\tilde",
  "\u0303": "\\tilde", "\u02c7": "\\check", "\u030c": "\\check", "\u02d8": "\\breve", "\u0306": "\\breve",
  "\u00b4": "\\acute", "\u0301": "\\acute", "\u0060": "\\grave", "\u0300": "\\grave", "\u02d9": "\\dot",
  "\u0307": "\\dot", "\u00a8": "\\ddot", "\u0308": "\\ddot", "\u02da": "\\mathring", "\u030a": "\\mathring",
};
const byCharacter = new Map<string, Map<string, number>>();
/** The slot of a table's family that holds this character; undefined when it has none. */
function slotOfCharacter(family: string, unicode: string): number | undefined {
  let index = byCharacter.get(family);
  if (!index) {
    index = new Map();
    for (const [slot, entry] of Object.entries(TEX_FONT_SLOTS[family] ?? {})) {
      if (entry[0] !== "" && !index.has(entry[0])) index.set(entry[0], Number(slot));
    }
    byCharacter.set(family, index);
  }
  return index.get(CHARACTER_AS_TEX[unicode] ?? unicode);
}

const ink = new Map<string, Map<number, readonly [number, number]>>();
/** Lowest and highest ink of a slot, in ems above the baseline; null when unknown. */
export function inkOf(family: string, slot: number): readonly [number, number] | null {
  let fam = ink.get(family);
  if (!fam) {
    fam = new Map();
    const flat = TEX_FONT_INK[family] ?? [];
    for (let i = 0; i + 2 < flat.length; i += 3) fam.set(flat[i]!, [flat[i + 1]! / 1000, flat[i + 2]! / 1000]);
    ink.set(family, fam);
  }
  return fam.get(slot) ?? null;
}

const assemblyKey = (family: string, slots: readonly number[]): string =>
  `${family}:${[...new Set(slots)].sort((a, b) => a - b).join(",")}`;
const ASSEMBLY_BY_KEY = new Map(TEX_ASSEMBLIES.map((a) => [assemblyKey(a.family, a.slots), a]));
const ASSEMBLY_SLOTS = new Set(TEX_ASSEMBLIES.flatMap((a) => a.slots.map((s) => `${a.family}:${s}`)));
const COMPOSITES_BY_FIRST = new Map<string, (typeof TEX_COMPOSITES)[number][]>();
for (const c of TEX_COMPOSITES) {
  const key = `${c.parts[0]![0]}:${c.parts[0]![1]}`;
  const list = COMPOSITES_BY_FIRST.get(key);
  if (list) list.push(c);
  else COMPOSITES_BY_FIRST.set(key, [c]);
}

/** A glyph on its way to becoming a `MathGlyph`. */
interface Item {
  family: string;
  slot: number;
  unicode: string;
  x0: number;
  x1: number;
  /** Baseline, y downwards. */
  y: number;
  size: number;
  top: number;
  bottom: number;
  tex: string | null;
  cls: string | null;
  style: string | null;
  axis: boolean;
}

function toItem(g: ModelGlyph): Item {
  const table = tableOf(g.family);
  const family = table?.family ?? g.family;
  const slot = table?.by === "character"
    ? (slotOfCharacter(family, g.unicode) ?? -1)
    : KEYED_BY_CHARACTER.has(family) ? g.slot + 256 * (g.unicode.codePointAt(0) ?? 0) : g.slot;
  let entry = TEX_FONT_SLOTS[family]?.[slot];
  // A text font may appear in a second encoding (TeX Gyre: OT1 for `\mathrm`,
  // T1 for `\text`), where a slot the table has not seen still draws a
  // character it has.
  if (!entry && table?.by === "slot" && TEX_FONT_SLOTS[family] != null) {
    const other = slotOfCharacter(family, g.unicode);
    if (other != null) entry = TEX_FONT_SLOTS[family]![other];
  }
  const extent = inkOf(family, slot);
  return {
    family,
    slot,
    unicode: g.unicode,
    x0: g.x,
    x1: g.x + Math.max(g.advance, 0),
    y: g.y,
    size: g.size,
    top: g.y - (extent ? extent[1] : 0.8) * g.size,
    bottom: g.y - (extent ? extent[0] : -0.2) * g.size,
    tex: entry ? entry[0] : null,
    cls: entry ? entry[1] : null,
    style: entry?.[2] ?? null,
    // TeX centres every operator on the axis, whatever font it is from.
    axis: isAxisFamily(family) || (entry != null && (entry[1] === "op" || entry[1] === "int" || (HANGS.has(entry[1]) && extent != null && extent[1] <= 0.08 && extent[0] < -0.4))),
  };
}

function union(parts: readonly Item[], tex: string, cls: string): Item {
  const first = parts[0]!;
  return {
    ...first,
    x0: Math.min(...parts.map((p) => p.x0)),
    x1: Math.max(...parts.map((p) => p.x1)),
    // The lowest part's baseline: `\cong` and `\doteq` raise a part above it.
    y: Math.max(...parts.map((p) => p.y)),
    top: Math.min(...parts.map((p) => p.top)),
    bottom: Math.max(...parts.map((p) => p.bottom)),
    tex,
    cls,
    style: null,
    axis: parts.some((p) => p.axis),
  };
}

/** Replace the parts of each composite symbol by the symbol. */
function mergeComposites(items: Item[]): Item[] {
  const used = new Set<Item>();
  const made: Item[] = [];
  for (const first of items) {
    if (used.has(first)) continue;
    const candidates = COMPOSITES_BY_FIRST.get(`${first.family}:${first.slot}`);
    if (!candidates) continue;
    // TEX_COMPOSITES is sorted longest first, so `\iiint` wins over `\iint`.
    for (const c of candidates) {
      const parts: Item[] = [first];
      for (const [family, slot, dx, dy] of c.parts.slice(1)) {
        const hit = items.find(
          (g) =>
            !used.has(g) && !parts.includes(g) && g.family === family && g.slot === slot &&
            Math.abs((g.x0 - first.x0) / first.size - dx) <= COMPOSITE_TOLERANCE &&
            Math.abs((g.y - first.y) / first.size - dy) <= COMPOSITE_TOLERANCE,
        );
        if (!hit) break;
        parts.push(hit);
      }
      if (parts.length !== c.parts.length) continue;
      parts.forEach((p) => used.add(p));
      made.push(union(parts, c.tex, c.cls));
      break;
    }
  }
  return used.size === 0 ? items : [...items.filter((g) => !used.has(g)), ...made];
}

/**
 * A font with no bold has its symbols made bold by printing each three times
 * a hair apart (`\pmb`, and `\boldsymbol` under mathptmx). The copies are one
 * bold symbol.
 */
function mergeOverprints(items: Item[]): Item[] {
  const gone = new Set<Item>();
  for (let i = 0; i < items.length; i++) {
    const a = items[i]!;
    if (gone.has(a) || a.tex == null || a.tex === "") continue;
    const copies = items.filter(
      (b, j) => j > i && !gone.has(b) && b.family === a.family && b.slot === a.slot && b.size === a.size &&
        Math.abs(b.x0 - a.x0) < 0.06 * a.size && Math.abs(b.y - a.y) < 0.06 * a.size,
    );
    if (copies.length < 2) continue;
    copies.forEach((b) => gone.add(b));
    a.x1 = Math.max(a.x1, ...copies.map((b) => b.x1));
    if (a.cls === "ord") a.style = a.style === "rm" ? "bf" : "bm";
  }
  return gone.size === 0 ? items : items.filter((g) => !gone.has(g));
}

/** Replace each stack of delimiter or radical pieces by the symbol it builds. */
function mergeAssemblies(items: Item[]): Item[] {
  const pieces = items
    .filter((g) => ASSEMBLY_SLOTS.has(`${g.family}:${g.slot}`))
    .sort((a, b) => a.x0 - b.x0 || a.top - b.top);
  if (pieces.length < 2) return items;
  const used = new Set<Item>();
  const made: Item[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const first = pieces[i]!;
    if (used.has(first)) continue;
    const stack: Item[] = [first];
    let bottom = first.bottom;
    for (let j = i + 1; j < pieces.length; j++) {
      const p = pieces[j]!;
      if (used.has(p) || p.family !== first.family) continue;
      if (Math.abs(p.x0 - first.x0) > 0.06 * first.size) continue;
      // Pieces abut: the next one starts where the stack ends.
      if (p.top - bottom > 0.25 * first.size || p.bottom < bottom) continue;
      stack.push(p);
      bottom = p.bottom;
    }
    if (stack.length < 2) continue;
    const assembly = ASSEMBLY_BY_KEY.get(assemblyKey(first.family, stack.map((p) => p.slot)));
    if (!assembly) continue;
    stack.forEach((p) => used.add(p));
    // A built-up delimiter is centred on the axis whatever its pieces' origins are.
    made.push({ ...union(stack, assembly.tex, assembly.cls), axis: true });
  }
  return used.size === 0 ? items : [...items.filter((g) => !used.has(g)), ...made];
}

/**
 * Replace the pieces of each horizontal brace by the brace: `\underbrace` and
 * `\overbrace` are the same four pieces, in a different order.
 */
function mergeBraces(items: Item[]): Item[] {
  const used = new Set<Item>();
  const made: Item[] = [];
  for (const brace of TEX_BRACES) {
    const is = (g: Item, k: number): boolean => g.family === brace.parts[k]![0] && g.slot === brace.parts[k]![1];
    for (const first of items) {
      if (used.has(first) || !is(first, 0)) continue;
      // Pieces in the recorded order, left to right; a piece may repeat (the
      // fill of a font that draws no rules).
      const row = items
        .filter((g) => !used.has(g) && g.size === first.size && Math.abs(g.y - first.y) < 0.05 * first.size && g.x0 > first.x0)
        .sort((p, q) => p.x0 - q.x0);
      const parts: Item[] = [first];
      let at = 0;
      const last = brace.parts.length - 1;
      for (const g of row) {
        if (is(g, at + 1)) at++;
        else if (!is(g, at)) break;
        parts.push(g);
        if (at === last && !is(g, last - 1)) break;
      }
      if (at !== last) continue;
      parts.forEach((p) => used.add(p));
      made.push({ ...union(parts, brace.tex, "brace"), axis: false });
    }
  }
  return used.size === 0 ? items : [...items.filter((g) => !used.has(g)), ...made];
}

/** A rectangle in the model's units (viewport points at scale 1, y downwards). */
export interface ModelRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/**
 * The identified glyphs and the rules whose centre lies inside `rect`, in the
 * model's units. Returns no glyphs when the region holds none (a scanned page,
 * a figure), so the caller can fall back to the text layer.
 */
export function regionMathGlyphs(
  model: PageMathModel,
  rect: ModelRect,
): { glyphs: MathGlyph[]; rules: MathRule[] } {
  const inside: Item[] = [];
  for (const g of model.glyphs) {
    if (Math.abs(g.angle) > 0.2 || !(g.size > 0)) continue;
    // Cheap reject before the table lookups.
    if (g.x > rect.x1 || g.x + g.advance < rect.x0 || g.y < rect.y0 - 4 * g.size || g.y > rect.y1 + 4 * g.size) continue;
    const item = toItem(g);
    if (item.tex == null && item.unicode.trim().length === 0) continue; // a space
    const cx = (item.x0 + item.x1) / 2;
    const cy = (item.top + item.bottom) / 2;
    if (cx < rect.x0 || cx > rect.x1 || cy < rect.y0 || cy > rect.y1) continue;
    // A glyph the top or bottom edge cuts well into belongs to the line of
    // text next to the selection, not to it.
    const cut = Math.max(rect.y0 - item.top, item.bottom - rect.y1, 0);
    if (cut > CUT_TOLERANCE * (item.bottom - item.top)) continue;
    inside.push(item);
  }
  const items = mergeAssemblies(mergeBraces(mergeComposites(mergeOverprints(inside))));
  // mathptmx takes its summation and product signs from the Symbol font
  // enlarged and its integrals from the extension font reduced, so their own
  // size is not the size of the line they are on. An operator in a script is
  // smaller than either.
  const lineSize = Math.max(0, ...items.filter((it) => it.cls !== "op" && it.cls !== "int").map((it) => it.size));
  for (const it of items) {
    if (it.cls !== "op" && it.cls !== "int") continue;
    if (it.size > 1.15 * lineSize ? !isAxisFamily(it.family) : it.size > 0.85 * lineSize) it.size = lineSize;
  }

  const glyphs: MathGlyph[] = [];
  for (const it of items) {
    if (it.tex === "") continue; // a part whose whole is cut off by the box
    const exact = it.tex != null;
    // An axis-centred glyph gets the baseline of the line it is centred on. A
    // radical is not centred: it hangs from its rule, and the layout places it
    // by that rule.
    const base = it.axis && it.cls !== "radical" ? (it.top + it.bottom) / 2 + AXIS * it.size : it.y;
    glyphs.push({
      ch: exact ? it.tex! : it.unicode,
      x0: it.x0,
      x1: it.x1,
      base,
      size: it.size,
      top: it.top,
      bottom: it.bottom,
      ...(exact ? { tex: it.tex!, cls: it.cls ?? "ord", ...(it.style ? { style: it.style } : {}) } : {}),
    });
  }

  const rules: MathRule[] = [];
  for (const r of model.rules) {
    const cx = (r.x0 + r.x1) / 2;
    if (cx < rect.x0 || cx > rect.x1 || r.y < rect.y0 || r.y > rect.y1) continue;
    rules.push({ x0: r.x0, x1: r.x1, y: r.y, thickness: r.thickness });
  }
  return { glyphs, rules };
}
