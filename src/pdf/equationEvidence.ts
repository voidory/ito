/**
 * Structured evidence behind a geometric LaTeX draft.
 *
 * The extractor is a chain of geometric decisions: which glyph is which
 * symbol, which is a script of which, which rows a box divides into. Most are
 * far from any threshold; some are not. This module gathers what can be known
 * about how sure the chain was, without touching the chain: the same draft
 * comes out whether or not anyone reads the evidence.
 *
 * Four groups:
 *  - `region`: what the box did to the glyphs it was drawn over;
 *  - `glyphs`: what the layout was handed, and how much of it was identified
 *    from a font table rather than guessed from a character;
 *  - `layout`: the closest calls the layout made (see layoutProbe.ts);
 *  - `output`: facts about the LaTeX that came out, which need no knowledge of
 *    how it was made.
 *
 * `equationConfidence.ts` turns these into a probability.
 */

import { analyzeGlyphs, glyphsToLatex, type GlyphStats, type MathGlyph, type MathRule } from "./mathLayout";
import type { LayoutProbe } from "./layoutProbe";
import type { PageMathModel } from "./pageMathModel";
import { regionMathGlyphs, type RegionReport } from "./texGlyphs";

/** Facts about the draft itself. */
export interface OutputStats {
  readonly chars: number;
  /** Deepest nesting of `{ }`. */
  readonly depth: number;
  /** `{` and `}` that do not pair up (a draft that cannot compile). */
  readonly unbalanced: boolean;
  readonly fractions: number;
  readonly radicals: number;
  readonly scripts: number;
  /** `^` or `_` set on nothing (`{}^2`): a script with no base. */
  readonly orphanScripts: number;
  readonly environments: number;
  /** Rows separated by `\\`. */
  readonly rows: number;
  readonly texts: number;
  readonly stacks: number;
  readonly accents: number;
  /** Symbols the layout could only spell as a raw character (`?`, private-use, or a non-ASCII letter). */
  readonly rawCharacters: number;
}

/**
 * How much the draft depends on exact positions. The glyphs are moved by a
 * small random amount (a fraction of their own size) and the layout is run
 * again: a draft that comes out the same every time rests on decisions made
 * well clear of every threshold; one that changes was a close call somewhere,
 * whichever threshold it was. This reaches decisions no probe site was put on.
 */
export interface Stability {
  /** Fraction of re-runs, per jitter size, that gave the same LaTeX. Keys are the jitter in thousandths of an em. */
  readonly same: Readonly<Record<string, number>>;
  /** Distinct drafts seen at the largest jitter, counting the original. */
  readonly distinct: number;
}

export interface EquationEvidence {
  /** The box in ems of the median glyph in it: an inline formula is about two ems tall, a display a good deal more. */
  readonly box: { readonly widthEms: number; readonly heightEms: number };
  readonly stability: Stability;
  readonly region: RegionReport;
  readonly glyphs: GlyphStats;
  readonly layout: LayoutProbe;
  readonly output: OutputStats;
}

const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

/** Facts about a draft, from its text alone. */
export function outputStats(latex: string): OutputStats {
  let depth = 0;
  let deepest = 0;
  let unbalanced = false;
  for (let i = 0; i < latex.length; i++) {
    const c = latex[i];
    if (c === "\\") {
      i++;
    } else if (c === "{") {
      depth++;
      deepest = Math.max(deepest, depth);
    } else if (c === "}") {
      depth--;
      if (depth < 0) unbalanced = true;
    }
  }
  if (depth !== 0) unbalanced = true;
  return {
    chars: latex.length,
    depth: deepest,
    unbalanced,
    fractions: count(latex, /\\frac\{/g),
    radicals: count(latex, /\\sqrt/g),
    scripts: count(latex, /[\^_]/g),
    orphanScripts: count(latex, /\{\}[\^_]/g),
    environments: count(latex, /\\begin\{/g),
    rows: count(latex, /\\\\/g),
    texts: count(latex, /\\text\{/g),
    stacks: count(latex, /\\(?:overset|underset|underbrace|overbrace)/g),
    accents: count(latex, /\\(?:hat|bar|tilde|vec|dot|ddot|check|breve|acute|grave|mathring|widehat|widetilde|overline|underline)\{/g),
    rawCharacters: count(latex, /[^\x20-\x7e]/g),
  };
}

/** mulberry32: a small seeded generator, so the same box gives the same evidence. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const JITTERS = [0.01, 0.02, 0.04, 0.06] as const;
const RUNS = 6;

/** Re-run the layout on glyphs moved by up to `amount` of their size, and see whether the draft holds. */
export function measureStability(glyphs: readonly MathGlyph[], rules: readonly MathRule[], latex: string): Stability {
  const same: Record<string, number> = {};
  const seen = new Set<string>([latex]);
  let seed = glyphs.length * 2654435761;
  for (const amount of JITTERS) {
    let kept = 0;
    for (let run = 0; run < RUNS; run++) {
      const random = seeded((seed += 40503));
      const moved = glyphs.map((g) => {
        const dx = (random() * 2 - 1) * amount * g.size;
        const dy = (random() * 2 - 1) * amount * g.size;
        return {
          ...g,
          x0: g.x0 + dx,
          x1: g.x1 + dx,
          base: g.base + dy,
          ...(g.top != null ? { top: g.top + dy } : {}),
          ...(g.bottom != null ? { bottom: g.bottom + dy } : {}),
        };
      });
      const unit = glyphs.length > 0 ? glyphs[0]!.size : 10;
      const shaken = rules.map((r) => ({ ...r, y: r.y + (random() * 2 - 1) * amount * unit }));
      const draft = glyphsToLatex(moved, shaken);
      if (draft === latex) kept++;
      if (amount === JITTERS[JITTERS.length - 1]) seen.add(draft);
    }
    same[String(Math.round(amount * 1000))] = kept / RUNS;
  }
  return { same, distinct: seen.size };
}

/** A draft and the evidence behind it, for the glyphs and rules of a box on a page. */
export function analyzeModelRegion(
  model: PageMathModel,
  rect: { x: number; y: number; width: number; height: number },
): { latex: string; evidence: EquationEvidence } {
  const { glyphs, rules, report } = regionMathGlyphs(model, {
    x0: rect.x * model.width,
    y0: rect.y * model.height,
    x1: (rect.x + rect.width) * model.width,
    y1: (rect.y + rect.height) * model.height,
  });
  const sizes = glyphs.map((g) => g.size).sort((a, b) => a - b);
  const em = sizes.length > 0 ? sizes[sizes.length >> 1]! : 10;
  const box = { widthEms: (rect.width * model.width) / em, heightEms: (rect.height * model.height) / em };
  if (glyphs.length === 0) {
    return {
      latex: "",
      evidence: {
        box,
        stability: { same: {}, distinct: 1 },
        region: report,
        glyphs: { glyphs: 0, exact: 0, droppedNumbers: 0, rules: 0, rulesUsable: 0 },
        layout: { margins: {}, counts: {} },
        output: outputStats(""),
      },
    };
  }
  const { latex, stats, probe } = analyzeGlyphs(glyphs, rules);
  return {
    latex,
    evidence: { box, stability: measureStability(glyphs, rules, latex), region: report, glyphs: stats, layout: probe, output: outputStats(latex) },
  };
}
