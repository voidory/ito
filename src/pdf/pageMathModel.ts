/**
 * Page math model: every glyph and every thin rule on a PDF page, read from
 * pdf.js's operator list (docs/LATEX-EXTRACTION-PLAN.md, Phase 2).
 *
 * The text layer says which characters are on the page. It does not say which
 * FONT SLOT each one is, and in TeX output the slot is the symbol: a display
 * `\sum` is slot 88 of the extension font, which pdf.js reports as the letter
 * "X". The operator list keeps the slot, the font and the exact advance of each
 * glyph, and the strokes that draw fraction bars and radical rules, so nothing
 * has to be measured in the DOM or read back from pixels
 * (docs/spikes/pdf-glyph-geometry.md).
 *
 * Pure and DOM-free. The caller passes pdf.js's own `OPS` table, so this file
 * imports nothing from pdf.js and runs unchanged in the reader, in Node and in
 * unit tests. The operator list is not a stable public surface of pdf.js: keep
 * the walker in this one module, and re-run the spike scripts on an upgrade.
 */

/** One glyph as drawn. Coordinates are viewport units at scale 1, y downwards. */
export interface ModelGlyph {
  /** PDF font name without its subset tag, e.g. `CMMI10`. */
  readonly face: string;
  /** Font family: the face upper-cased, less its design size, e.g. `CMMI`. */
  readonly family: string;
  /** The font slot (character code) the PDF asked for. */
  readonly slot: number;
  /** What pdf.js believes the character is. Wrong for symbol and extension fonts. */
  readonly unicode: string;
  /** Glyph origin: left edge and baseline. */
  readonly x: number;
  readonly y: number;
  /** Advance width and font size, in the same units. */
  readonly advance: number;
  readonly size: number;
  /** Direction of the baseline in radians: 0 for upright text on an unrotated page. */
  readonly angle: number;
}

/** A thin axis-aligned rule: a fraction bar, a radical's vinculum, an overline. */
export interface ModelRule {
  readonly x0: number;
  readonly x1: number;
  /** Centre line of the rule. */
  readonly y: number;
  readonly thickness: number;
}

export interface PageMathModel {
  readonly width: number;
  readonly height: number;
  readonly glyphs: readonly ModelGlyph[];
  /** Thin horizontal rules. */
  readonly rules: readonly ModelRule[];
  /** Thin vertical rules (array bars, table borders): `x`, and `y0` (top) to `y1`. */
  readonly vrules: readonly { readonly x: number; readonly y0: number; readonly y1: number }[];
}

/** The parts of a pdf.js operator list this module reads. */
export interface OperatorListLike {
  readonly fnArray: ArrayLike<number>;
  readonly argsArray: ArrayLike<unknown>;
}
/** The parts of a pdf.js font object this module reads. */
export interface FontLike {
  readonly name?: string;
  readonly loadedName?: string;
  readonly fontMatrix?: ArrayLike<number>;
  readonly isType3Font?: boolean;
  readonly vertical?: boolean;
}
/** pdf.js's `OPS`: operator name -> code. */
export type OpsTable = Readonly<Record<string, number>>;

type Matrix = readonly [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `a` applied first, then `m` (pdf.js `Util.transform(m, a)`). */
function mul(m: Matrix, a: ArrayLike<number>): Matrix {
  return [
    m[0] * a[0]! + m[2] * a[1]!,
    m[1] * a[0]! + m[3] * a[1]!,
    m[0] * a[2]! + m[2] * a[3]!,
    m[1] * a[2]! + m[3] * a[3]!,
    m[0] * a[4]! + m[2] * a[5]! + m[4],
    m[1] * a[4]! + m[3] * a[5]! + m[5],
  ];
}
function apply(p: readonly [number, number], m: Matrix): [number, number] {
  return [p[0] * m[0] + p[1] * m[2] + m[4], p[0] * m[1] + p[1] * m[3] + m[5]];
}

/** `HWMSQP+CMMI10` -> `{ face: "CMMI10", family: "CMMI" }`. */
export function fontFamilyOf(name: string | undefined): { face: string; family: string } {
  const face = String(name ?? "").replace(/^[A-Z]{6}\+/, "");
  return { face, family: face.replace(/\d+$/, "").toUpperCase() };
}

interface State {
  ctm: Matrix;
  tm: Matrix;
  x: number;
  y: number;
  lineX: number;
  lineY: number;
  font: FontLike | null;
  face: string;
  family: string;
  size: number;
  dir: number;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  rise: number;
  leading: number;
  lineWidth: number;
}

interface Path {
  lines: [[number, number], [number, number]][];
  rects: [number, number, number, number][];
  cur: [number, number] | null;
  ctm: Matrix;
}

/** Rules thicker than this (viewport units) are boxes or bars, not math rules. */
const MAX_RULE_THICKNESS = 2;
const MIN_RULE_LENGTH = 0.5;

/**
 * Walk one page's operator list.
 *
 * @param opList    `await page.getOperatorList()`
 * @param fontOf    resolves a `setFont` id, normally `(id) => page.commonObjs.get(id)`
 * @param ops       pdf.js's `OPS`
 * @param viewport  `page.getViewport({ scale: 1 })`: its `transform`, `width`, `height`
 */
export function buildPageMathModel(
  opList: OperatorListLike,
  fontOf: (id: string) => FontLike | null | undefined,
  ops: OpsTable,
  viewport: { readonly transform: ArrayLike<number>; readonly width: number; readonly height: number },
): PageMathModel {
  const view = Array.from(viewport.transform) as unknown as Matrix;
  const glyphs: ModelGlyph[] = [];
  const rules: ModelRule[] = [];
  const vrules: { x: number; y0: number; y1: number }[] = [];
  const stack: State[] = [];
  let st: State = {
    ctm: view, tm: IDENTITY, x: 0, y: 0, lineX: 0, lineY: 0, font: null, face: "", family: "",
    size: 0, dir: 1, charSpacing: 0, wordSpacing: 0, hScale: 1, rise: 0, leading: 0, lineWidth: 1,
  };
  let path: Path | null = null;

  const addRule = (ax: number, ay: number, bx: number, by: number, thickness: number): void => {
    if (thickness > MAX_RULE_THICKNESS) return;
    if (Math.abs(ay - by) < 0.01 && Math.abs(ax - bx) > MIN_RULE_LENGTH) {
      rules.push({ x0: Math.min(ax, bx), x1: Math.max(ax, bx), y: ay, thickness });
    } else if (Math.abs(ax - bx) < 0.01 && Math.abs(ay - by) > MIN_RULE_LENGTH) {
      vrules.push({ x: ax, y0: Math.min(ay, by), y1: Math.max(ay, by) });
    }
  };
  const paintStroke = (): void => {
    if (!path) return;
    const scale = Math.sqrt(Math.abs(path.ctm[0] * path.ctm[3] - path.ctm[1] * path.ctm[2]));
    for (const [a, b] of path.lines) {
      const [ax, ay] = apply(a, path.ctm);
      const [bx, by] = apply(b, path.ctm);
      addRule(ax, ay, bx, by, st.lineWidth * scale);
    }
  };
  const paintFill = (): void => {
    if (!path) return;
    for (const [x, y, w, h] of path.rects) {
      const [ax, ay] = apply([x, y], path.ctm);
      const [bx, by] = apply([x + w, y + h], path.ctm);
      const width = Math.abs(bx - ax);
      const height = Math.abs(by - ay);
      if (width >= height) addRule(ax, (ay + by) / 2, bx, (ay + by) / 2, height);
      else addRule((ax + bx) / 2, ay, (ax + bx) / 2, by, width);
    }
  };

  const n = opList.fnArray.length;
  for (let i = 0; i < n; i++) {
    const fn = opList.fnArray[i]!;
    // pdf.js operator arguments are untyped.
    const a = opList.argsArray[i] as any;
    switch (fn) {
      case ops.save:
        stack.push({ ...st });
        break;
      case ops.restore:
        if (stack.length > 0) st = stack.pop()!;
        break;
      case ops.transform:
        st.ctm = mul(st.ctm, a);
        break;
      case ops.paintFormXObjectBegin:
        stack.push({ ...st });
        if (a?.[0]) st.ctm = mul(st.ctm, a[0]);
        break;
      case ops.paintFormXObjectEnd:
        if (stack.length > 0) st = stack.pop()!;
        break;
      case ops.setLineWidth:
        st.lineWidth = a[0];
        break;
      case ops.beginText:
        st.tm = IDENTITY;
        st.x = st.y = st.lineX = st.lineY = 0;
        break;
      case ops.setFont: {
        const font = fontOf(a[0]) ?? null;
        st.font = font;
        const parts = fontFamilyOf(font?.name);
        st.face = parts.face;
        st.family = parts.family;
        st.size = Math.abs(a[1]);
        st.dir = a[1] < 0 ? -1 : 1;
        break;
      }
      case ops.setCharSpacing:
        st.charSpacing = a[0];
        break;
      case ops.setWordSpacing:
        st.wordSpacing = a[0];
        break;
      case ops.setHScale:
        st.hScale = a[0] / 100;
        break;
      case ops.setLeading:
        st.leading = -a[0];
        break;
      case ops.setTextRise:
        st.rise = a[0];
        break;
      case ops.setLeadingMoveText:
        st.leading = a[1];
        st.x = st.lineX += a[0];
        st.y = st.lineY += a[1];
        break;
      case ops.moveText:
        st.x = st.lineX += a[0];
        st.y = st.lineY += a[1];
        break;
      case ops.setTextMatrix:
        st.tm = [a[0], a[1], a[2], a[3], a[4], a[5]];
        st.x = st.lineX = 0;
        st.y = st.lineY = 0;
        break;
      case ops.nextLine:
        st.x = st.lineX;
        st.y = st.lineY += st.leading;
        break;
      case ops.showText: {
        const font = st.font;
        // Type 3 (bitmap) fonts carry no usable slot identity or metrics, and
        // vertical writing is not math: both are left to the text-layer path.
        if (!font || font.isType3Font || font.vertical) break;
        const base = mul(st.ctm, st.tm);
        const xScale = Math.hypot(base[0], base[1]);
        const yScale = Math.hypot(base[2], base[3]);
        const angle = Math.atan2(base[1], base[0]);
        const advanceScale = st.size * (font.fontMatrix?.[0] ?? 0.001);
        const hScale = st.hScale * st.dir;
        let x = 0;
        for (const g of a[0] as unknown[]) {
          if (typeof g === "number") {
            x -= (g * st.size) / 1000;
            continue;
          }
          const glyph = g as { originalCharCode?: number; unicode?: string; width?: number; isSpace?: boolean };
          const width = glyph.width ?? 0;
          const spacing = (glyph.isSpace ? st.wordSpacing : 0) + st.charSpacing;
          const [ux, uy] = apply([st.x + x * hScale, st.y + st.rise], base);
          if (typeof glyph.originalCharCode === "number") {
            glyphs.push({
              face: st.face,
              family: st.family,
              slot: glyph.originalCharCode,
              unicode: glyph.unicode ?? "",
              x: ux,
              y: uy,
              advance: width * advanceScale * Math.abs(hScale) * xScale,
              size: st.size * yScale,
              angle,
            });
          }
          x += width * advanceScale + spacing * st.dir;
        }
        st.x += x * hScale;
        break;
      }
      case ops.constructPath: {
        // One path can arrive as several constructPath operations (pdf.js
        // splits it where an operator-list chunk ends), so accumulate until
        // the path is painted.
        const kinds = a[0] as ArrayLike<number>;
        const args = a[1] as ArrayLike<number>;
        const cur: Path = path ?? { lines: [], rects: [], cur: null, ctm: st.ctm };
        let k = 0;
        for (let j = 0; j < kinds.length; j++) {
          const op = kinds[j]!;
          if (op === ops.moveTo) {
            cur.cur = [args[k]!, args[k + 1]!];
            k += 2;
          } else if (op === ops.lineTo) {
            const next: [number, number] = [args[k]!, args[k + 1]!];
            if (cur.cur) cur.lines.push([cur.cur, next]);
            cur.cur = next;
            k += 2;
          } else if (op === ops.rectangle) {
            cur.rects.push([args[k]!, args[k + 1]!, args[k + 2]!, args[k + 3]!]);
            k += 4;
          } else if (op === ops.curveTo) {
            cur.cur = [args[k + 4]!, args[k + 5]!];
            k += 6;
          } else if (op === ops.curveTo2 || op === ops.curveTo3) {
            cur.cur = [args[k + 2]!, args[k + 3]!];
            k += 4;
          }
        }
        cur.ctm = st.ctm;
        path = cur;
        break;
      }
      case ops.stroke:
      case ops.closeStroke:
        paintStroke();
        path = null;
        break;
      case ops.fill:
      case ops.eoFill:
        paintFill();
        path = null;
        break;
      case ops.fillStroke:
      case ops.eoFillStroke:
      case ops.closeFillStroke:
      case ops.closeEOFillStroke:
        paintFill();
        paintStroke();
        path = null;
        break;
      case ops.endPath:
        path = null;
        break;
      case ops.paintSolidColorImageMask: {
        // dvips draws every rule as a one-pixel image mask stretched to the
        // rule's size, so PDFs made from PostScript have no paths at all:
        // the rule is the unit square under the current transform.
        const [ax, ay] = apply([0, 0], st.ctm);
        const [bx, by] = apply([1, 1], st.ctm);
        const width = Math.abs(bx - ax);
        const height = Math.abs(by - ay);
        if (width >= height) addRule(ax, (ay + by) / 2, bx, (ay + by) / 2, height);
        else addRule((ax + bx) / 2, ay, (ax + bx) / 2, by, width);
        break;
      }
      default:
        break;
    }
  }
  return { width: viewport.width, height: viewport.height, glyphs, rules, vrules };
}

// ---------------------------------------------------------------------------
// Which model belongs to which rendered page
// ---------------------------------------------------------------------------

const loaders = new WeakMap<Element, () => Promise<PageMathModel | null>>();

/**
 * `render.ts` registers, for each page stage it creates, how to build that
 * page's model. Keyed by the stage element so the extractor, which is handed a
 * stage, needs no reference to pdf.js or to the rendered page object.
 */
export function registerPageMathModel(stage: Element, load: () => Promise<PageMathModel | null>): void {
  let cached: Promise<PageMathModel | null> | null = null;
  loaders.set(stage, () => (cached ??= load().catch(() => null)));
}

/** The model of the page drawn in `stage`, or null when there is none (jsdom, a page not from pdf.js). */
export function pageMathModelFor(stage: Element | null): Promise<PageMathModel | null> {
  const load = stage ? loaders.get(stage) : undefined;
  return load ? load() : Promise.resolve(null);
}
