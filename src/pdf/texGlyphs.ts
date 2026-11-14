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
 * A glyph from a font with no table (anything but Computer Modern and the AMS
 * fonts) keeps the character pdf.js reports and no class: the layout then
 * falls back to its character heuristics for that glyph, with exact geometry.
 *
 * Pure and DOM-free.
 */

import type { MathGlyph, MathRule } from "./mathLayout";
import type { ModelGlyph, PageMathModel } from "./pageMathModel";
import { TEX_ASSEMBLIES, TEX_COMPOSITES, TEX_FONT_INK, TEX_FONT_SLOTS } from "./texFontSlots";

/** TeX's math axis sits a quarter of an em above the baseline. */
const AXIS = 0.25;
/** How far a composite's part may sit from its recorded offset, in ems. */
const COMPOSITE_TOLERANCE = 0.09;
/** Font families whose glyphs are centred on the math axis, not set on the baseline. */
const AXIS_FAMILIES = new Set(["CMEX"]);

/** Whether this font family has a slot table at all. */
export function hasSlotTable(family: string): boolean {
  return TEX_FONT_SLOTS[family] != null;
}

const ink = new Map<string, Map<number, readonly [number, number]>>();
/** Lowest and highest ink of a slot, in ems above the baseline; null when unknown. */
function inkOf(family: string, slot: number): readonly [number, number] | null {
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
  const family = g.family;
  const entry = TEX_FONT_SLOTS[family]?.[g.slot];
  const extent = inkOf(family, g.slot);
  return {
    family,
    slot: g.slot,
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
    axis: AXIS_FAMILIES.has(family),
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
    made.push(union(stack, assembly.tex, assembly.cls));
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
    inside.push(item);
  }
  const items = mergeAssemblies(mergeComposites(inside));

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
