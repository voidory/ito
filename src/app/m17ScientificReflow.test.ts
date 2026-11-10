/**
 * M17 — scientific reflow & set-text cache hard-gate tests (Vitest/jsdom).
 *
 * The six M17 invariants from the handoff, driving the REAL Workbench
 * (in-memory storage, nothing mocked) and the REAL React surfaces where a DOM
 * contract is asserted:
 *
 *  - Test 1 (Set-Text Pre-Parsed Cache Hydration): wb.cacheParsedPdfPages
 *    persists cachedPages, and hydrateTextLayerFromCache synchronously
 *    populates .textLayer with positioned <span data-cached-span="true">.
 *  - Test 2 (Scanned / Zero-Height OCR Highlight Fallback): a .textLayer whose
 *    getClientRects() is 0×0 (or synthesized OCR spans) still yields valid
 *    non-zero normalized [x, y, w, h] rects.
 *  - Test 3 (LaTeX Extraction & Word-Native MathML Compilation): the quadratic
 *    formula compiles to <math> with <mfrac>/<msqrt>/<msup>, and
 *    copyScienceToWordClipboard yields plainText (LaTeX) + htmlText (MathML).
 *  - Test 4 (Reaction SMILES + Curly-Arrow Mechanism SVG): renderMechanismSvg
 *    emits bond lines, the reagent text, and two curly-arrow paths with the
 *    full + fishhook barbs.
 *  - Test 5 (Annotation Science Persistence & Popover Controls): setting
 *    science data + mounting HighlightEditPopover renders the preview + action
 *    buttons.
 *  - Test 6 (SubjectEditor Live Equation & Mechanism Blocks): the two insert
 *    buttons add the blocks and render page-math-block + page-chem-block.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { Workbench } from "./workbench";
import { SubjectEditor } from "./SubjectEditor";
import { HighlightEditPopover } from "./reader/AnnotationOverlays";
import {
  extractPreParsedPageLayout,
  hydrateTextLayerFromCache,
  synthesizeOcrPageSpans,
  type PreParsedPageLayout,
} from "../pdf/textCache";
import {
  createAnchorRectsWithOcrFallback,
  recomputeRectsFromQuote,
} from "../pdf/highlight";
import {
  convertLatexToMathML,
  copyScienceToWordClipboard,
  extractMechanismFromRegion,
  figureCharsFromSpans,
  renderMechanismSvg,
  snapArrowEndpointsToMolGraph,
} from "../pdf/scienceOcr";
import { hydrateState } from "../editor";
import type { DocumentJson } from "../editor";
import type { NormalizedRect, Source } from "../model";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function render(node: ReturnType<typeof createElement>): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
  return container;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

async function importOne(wb: Workbench, title: string): Promise<Source> {
  return wb.importSource({
    title,
    bytes: new Uint8Array([title.length, 2, 3, 4]),
    versionHash: "hash-" + title,
    pageCount: 2,
    category: "Papers",
  });
}

// ---------------------------------------------------------------------------
// Test 1 — Set-Text Pre-Parsed Cache Hydration
// ---------------------------------------------------------------------------

describe("M17 Test 1 — set-text pre-parsed layout cache hydration", () => {
  it("persists cachedPages and hydrates .textLayer synchronously", async () => {
    const storage = new InMemoryStorageAdapter();
    const wb = await Workbench.open(storage);
    const src = await importOne(wb, "Quadratics");

    // Build a layout from pdf.js-shaped text items + a viewport.
    const viewport = { width: 600, height: 800, rotation: 0 };
    const items = [
      { str: "Energy equation", transform: [12, 0, 0, 12, 60, 700], width: 120, height: 12 },
      { str: "E = mc^2", transform: [12, 0, 0, 12, 60, 660], width: 60, height: 12 },
    ];
    const layout = extractPreParsedPageLayout(0, viewport, items);
    expect(layout.spans.length).toBe(2);
    // Every span rect has a non-zero (clamped) width + height.
    for (const span of layout.spans) {
      const [, , w, h] = span.normRect;
      expect(w).toBeGreaterThan(0);
      expect(h).toBeGreaterThan(0);
    }

    await wb.cacheParsedPdfPages(src.id, [layout]);
    const stored = wb.rawData().sources.find((s) => s.id === src.id)!;
    expect(stored.cachedPages).toBeTruthy();
    expect(stored.cachedPages!.length).toBe(1);
    expect(stored.cachedPages![0]!.spans.length).toBe(2);

    // Survives a save/reopen (persisted set-text cache).
    const wb2 = await Workbench.open(storage, wb.snapshot().brainId);
    const reopened = wb2.rawData().sources.find((s) => s.id === src.id)!;
    expect(reopened.cachedPages!.length).toBe(1);

    // Hydration synchronously populates a .textLayer with cached spans.
    const stage = document.createElement("div");
    const textLayer = document.createElement("div");
    textLayer.className = "textLayer";
    stage.appendChild(textLayer);
    hydrateTextLayerFromCache(textLayer, reopened.cachedPages![0]!, 600, 800);

    const cachedSpans = textLayer.querySelectorAll('[data-cached-span="true"]');
    expect(cachedSpans.length).toBe(2);
    // Positioned absolutely with the cached normalized rect preserved.
    const first = cachedSpans[0] as HTMLElement;
    expect(first.style.position).toBe("absolute");
    expect(first.getAttribute("data-norm-rect")).toBeTruthy();
    expect(first.textContent).toBe("Energy equation");

    // Idempotent: re-hydrating does not duplicate spans.
    hydrateTextLayerFromCache(textLayer, reopened.cachedPages![0]!, 600, 800);
    expect(textLayer.querySelectorAll('[data-cached-span="true"]').length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Test 2 — Scanned / Zero-Height OCR Highlight Fallback
// ---------------------------------------------------------------------------

describe("M17 Test 2 — scanned / zero-height OCR highlight fallback", () => {
  it("produces valid non-zero rects when client rects are 0×0", () => {
    // Build a scanned-page .textLayer from synthesized OCR spans.
    const stage = document.createElement("div");
    const textLayer = document.createElement("div");
    textLayer.className = "textLayer";
    stage.appendChild(textLayer);
    document.body.appendChild(stage);

    const ocrSpans = synthesizeOcrPageSpans(0, ["reaction yield 87%", "second OCR line"]);
    expect(ocrSpans.length).toBe(2);
    const layout: PreParsedPageLayout = {
      pageIndex: 0,
      widthPt: 500,
      heightPt: 700,
      rotation: 0,
      spans: ocrSpans,
    };
    hydrateTextLayerFromCache(textLayer, layout, 500, 700);
    const spans = textLayer.querySelectorAll('[data-ocr-synthetic="true"]');
    expect(spans.length).toBe(2);

    // jsdom getClientRects() is empty/0×0 — the quote re-anchor must still
    // recover non-zero normalized rects from the cached span geometry.
    const rects = recomputeRectsFromQuote(stage, "reaction yield 87%");
    expect(rects.length).toBeGreaterThanOrEqual(1);
    for (const r of rects) {
      expect(r.width).toBeGreaterThan(0);
      expect(r.height).toBeGreaterThan(0);
    }

    // The explicit OCR-fallback helper on a Range over the OCR spans also
    // yields non-zero rects despite a broken (0×0) scanned OCR layer.
    const range = document.createRange();
    range.selectNodeContents(spans[0]!);
    const fallbackRects = createAnchorRectsWithOcrFallback(stage, range);
    expect(fallbackRects.length).toBeGreaterThanOrEqual(1);
    for (const r of fallbackRects) {
      expect(r.width).toBeGreaterThan(0);
      expect(r.height).toBeGreaterThan(0);
    }

    stage.remove();
  });
});

// ---------------------------------------------------------------------------
// Test 3 — LaTeX Extraction & Word-Native MathML Compilation
// ---------------------------------------------------------------------------

describe("M17 Test 3 — LaTeX → Word-native MathML", () => {
  it("compiles the quadratic formula to MathML and builds the clipboard payload", async () => {
    const latex = "\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}";
    const mathml = convertLatexToMathML(latex);

    expect(mathml).toContain('<math xmlns="http://www.w3.org/1998/Math/MathML"');
    expect(mathml).toContain("<mfrac>");
    expect(mathml).toContain("<msqrt>");
    expect(mathml).toContain("<msup>");
    // The ± operator carried through from \pm.
    expect(mathml).toContain("±");

    const payload = await copyScienceToWordClipboard({ kind: "math", latex });
    expect(payload.plainText).toBe(latex);
    expect(payload.htmlText).toContain("<math");
    expect(payload.htmlText).toContain("<mfrac>");
  });

  it("terminates on malformed / dangling-script LaTeX (never hangs)", () => {
    // Orphaned ^/_ , stray braces and empty input must all return promptly
    // with valid self-contained MathML (a hang here freezes the browser tab).
    for (const bad of ["^2", "_i", "x^", "}}}", "", "\\frac{a}", "a_^b"]) {
      const out = convertLatexToMathML(bad);
      expect(out.startsWith('<math xmlns="http://www.w3.org/1998/Math/MathML"')).toBe(true);
      expect(out).toContain("</math>");
    }
  });
});

// ---------------------------------------------------------------------------
// Test 4 — Reaction SMILES + Curly-Arrow Mechanism SVG Rendering
// ---------------------------------------------------------------------------

describe("M17 Test 4 — reaction SMILES + curly-arrow mechanism SVG", () => {
  it("renders bond lines, reagent text, and full + fishhook curly arrows", () => {
    const svg = renderMechanismSvg({
      smiles: "C=C.BrBr>>BrCCBr",
      conditionsAbove: "CH2Cl2",
      arrows: [
        { id: "a1", fromAtomOrBond: "C1=C2", toAtomOrBond: "Br1", barb: "full" },
        { id: "a2", fromAtomOrBond: "Br1-Br2", toAtomOrBond: "Br2", barb: "fishhook" },
      ],
    });

    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('data-testid="chem-mechanism-svg"');
    // Skeletal bond lines.
    expect(svg).toContain('class="ito-bond"');
    // The reagent/condition caption.
    expect(svg).toContain("CH2Cl2");
    // Two curly electron-pushing arrows with the right barbs/markers.
    const fullArrows = svg.match(/data-barb="full"/g) ?? [];
    const fishhookArrows = svg.match(/data-barb="fishhook"/g) ?? [];
    expect(fullArrows.length).toBeGreaterThanOrEqual(1);
    expect(fishhookArrows.length).toBeGreaterThanOrEqual(1);
    expect(svg).toContain("url(#ito-full-barb)");
    expect(svg).toContain("url(#ito-fishhook-barb)");
    expect((svg.match(/class="ito-curly-arrow"/g) ?? []).length).toBe(2);

    // Deterministic: identical input reproduces identical markup.
    const svg2 = renderMechanismSvg({
      smiles: "C=C.BrBr>>BrCCBr",
      conditionsAbove: "CH2Cl2",
      arrows: [
        { id: "a1", fromAtomOrBond: "C1=C2", toAtomOrBond: "Br1", barb: "full" },
        { id: "a2", fromAtomOrBond: "Br1-Br2", toAtomOrBond: "Br2", barb: "fishhook" },
      ],
    });
    expect(svg2).toBe(svg);
  });
});

// ---------------------------------------------------------------------------
// Test 5 — Annotation Science Persistence & Popover Controls
// ---------------------------------------------------------------------------

describe("M17 Test 5 — annotation science persistence + popover controls", () => {
  it("persists science data and the popover renders the preview + action buttons", async () => {
    const storage = new InMemoryStorageAdapter();
    const wb = await Workbench.open(storage);
    const src = await importOne(wb, "Mechanisms");
    const rect: NormalizedRect = { x: 0.1, y: 0.1, width: 0.4, height: 0.3 };
    const area = await wb.commitAreaAnnotation(src.id, 0, rect, "A reaction");

    await wb.setAnnotationScienceData(area.annotation.id, {
      latex: "\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}",
      smiles: "C=C.BrBr>>BrCCBr",
      mechanism: {
        smiles: "C=C.BrBr>>BrCCBr",
        arrows: [{ id: "a1", fromAtomOrBond: "C1", toAtomOrBond: "Br1", barb: "full" }],
      },
    });

    // Persisted on the area anchor + survives reopen.
    const wb2 = await Workbench.open(storage, wb.snapshot().brainId);
    const stored = wb2.rawData().annotations.find((a) => a.id === area.annotation.id)!;
    expect(stored.scope.kind).toBe("area");
    if (stored.scope.kind === "area") {
      expect(stored.scope.anchor.latex).toContain("\\frac");
      expect(stored.scope.anchor.smiles).toBe("C=C.BrBr>>BrCCBr");
      expect(stored.scope.anchor.mechanism?.arrows.length).toBe(1);
    }

    const el = await render(
      createElement(HighlightEditPopover, {
        wb,
        popover: {
          annotationId: area.annotation.id,
          sourceId: src.id,
          rect: { left: 100, top: 100, right: 300, bottom: 140, width: 200 },
        },
        onClose: () => undefined,
        bump: () => undefined,
      }),
    );
    await flush();

    // The popover mounts via a portal to document.body, so query the document.
    void el;
    for (const id of [
      "extract-latex-btn",
      "extract-chem-btn",
      "annotation-latex-preview",
      "chem-mechanism-svg",
      "add-curly-arrow-btn",
      "copy-word-math-btn",
      "copy-word-chem-btn",
    ]) {
      expect(document.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 6 — SubjectEditor Live Equation & Mechanism Blocks
// ---------------------------------------------------------------------------

describe("M17 Test 6 — SubjectEditor live equation + mechanism blocks", () => {
  it("inserts math + chem blocks and renders their live previews", async () => {
    const storage = new InMemoryStorageAdapter();
    const wb = await Workbench.open(storage);
    const page = await wb.createSubjectPage("Scientific page");

    const el = await render(
      createElement(SubjectEditor, {
        wb,
        pageId: page.id,
        onFollowSource: () => undefined,
        onClose: () => undefined,
        bump: () => undefined,
      }),
    );
    await flush();

    // The two new toolbar buttons render.
    expect(el.querySelector('[data-testid="insert-latex-block-btn"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="insert-chem-block-btn"]')).not.toBeNull();

    await click(el.querySelector('[data-testid="insert-latex-block-btn"]')!);
    await click(el.querySelector('[data-testid="insert-chem-block-btn"]')!);
    await new Promise((r) => setTimeout(r, 220));
    await flush();

    // The live blocks render inside the ProseMirror document.
    expect(el.querySelector('[data-testid="page-math-block"]')).not.toBeNull();
    const chemBlock = el.querySelector('[data-testid="page-chem-block"]');
    expect(chemBlock).not.toBeNull();
    // The chem block carries its curly-arrow <svg>.
    expect(chemBlock!.querySelector('[data-testid="chem-mechanism-svg"]')).not.toBeNull();

    // Both blocks are persisted into the stored document JSON (source of truth).
    const doc = hydrateState(wb.subjectDocJson(page.id) as DocumentJson).doc;
    let mathBlocks = 0;
    let chemBlocks = 0;
    doc.forEach((block) => {
      if (block.type.name === "paragraph" && block.attrs.latexFormula != null) mathBlocks += 1;
      if (block.type.name === "paragraph" && block.attrs.chemMechanismJson != null) chemBlocks += 1;
    });
    expect(mathBlocks).toBeGreaterThanOrEqual(1);
    expect(chemBlocks).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Test 7 — Nearest-atom/bond curly-arrow snapper + spatially-preserved render
// ---------------------------------------------------------------------------

describe("M17 Test 7 — nearest-atom/bond curly-arrow snapper", () => {
  const atoms2D = [
    { id: "C1", element: "C", x: 0.2, y: 0.6 },
    { id: "C2", element: "C", x: 0.4, y: 0.4 },
    { id: "O3", element: "O", x: 0.2, y: 0.2 },
    { id: "Br4", element: "Br", x: 0.7, y: 0.4 },
  ] as const;
  const bonds2D = [
    { id: "C1=C2", fromAtomId: "C1", toAtomId: "C2", order: 2 },
    { id: "C2-Br4", fromAtomId: "C2", toAtomId: "Br4", order: 1 },
  ] as const;

  it("snaps tail to the nearest bond midpoint and head to the nearest atom", () => {
    const raw = { id: "a1", tailX: 0.31, tailY: 0.47, headX: 0.68, headY: 0.36, ctrlX: 0.5, ctrlY: 0.15 };
    const arrow = snapArrowEndpointsToMolGraph(raw, atoms2D, bonds2D);
    expect(arrow.fromAtomOrBond).toBe("C1=C2");
    expect(arrow.toAtomOrBond).toBe("Br4");
    expect(arrow.barb).toBe("full");
    expect(Math.abs(arrow.curvature ?? 0)).toBeGreaterThan(0.1);

    // Head and tail never collapse onto the same anchor.
    const same = snapArrowEndpointsToMolGraph(
      { tailX: 0.7, tailY: 0.4, headX: 0.71, headY: 0.41 },
      atoms2D,
      bonds2D,
    );
    expect(same.fromAtomOrBond).toBe("Br4");
    expect(same.toAtomOrBond).not.toBe("Br4");

    const spec = extractMechanismFromRegion({ atoms2D, bonds2D, rawArrows: [raw] });
    const svg = renderMechanismSvg(spec);
    expect(svg).toMatch(/<path class="ito-curly-arrow"[^>]*data-from="C1=C2"[^>]*data-to="Br4"/);
    // Spatial preservation: Br is drawn where the spec says (0.7 × 420 = 294).
    expect(svg).toMatch(/data-atom-id="Br4" x="294"/);
    expect(spec.smiles).toContain("Br");
  });

  it("lays a bare SMILES out once and stores the layout on the spec", () => {
    const spec = extractMechanismFromRegion({ smiles: "C=C.BrBr>>BrCCBr" });
    expect(spec.atoms2D?.length).toBe(8);
    expect(spec.bonds2D?.some((b) => b.order === 2)).toBe(true);
    expect(spec.reactionArrow).toBeDefined();
    expect(renderMechanismSvg(spec)).toContain('data-spatial="true"');
  });
});

// ---------------------------------------------------------------------------
// Test 8 — figure pixels → bonds, labels and curly arrows
// ---------------------------------------------------------------------------

/** A tiny software rasteriser so the vectoriser is tested on real pixels. */
function makeFigure(width: number, height: number) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const put = (x: number, y: number, rgb: readonly [number, number, number]): void => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= width || yi >= height) return;
    const i = (yi * width + xi) * 4;
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
  };
  const disc = (cx: number, cy: number, r: number, rgb: readonly [number, number, number]): void => {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if (Math.hypot(x - cx, y - cy) <= r) put(x, y, rgb);
      }
    }
  };
  const BLACK = [0, 0, 0] as const;
  const api = {
    width,
    height,
    data,
    line(x1: number, y1: number, x2: number, y2: number, rgb: readonly [number, number, number] = BLACK): void {
      const n = Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 2);
      for (let i = 0; i <= n; i++) disc(x1 + ((x2 - x1) * i) / n, y1 + ((y2 - y1) * i) / n, 1, rgb);
    },
    ring(cx: number, cy: number, r: number): void {
      for (let a = 0; a < 360; a += 1) disc(cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180), 1, BLACK);
    },
    /** A quadratic curly arrow with a filled (full) or half (fishhook) head. */
    arrow(
      x1: number, y1: number, cx: number, cy: number, x2: number, y2: number,
      rgb: readonly [number, number, number] = BLACK, fishhook = false,
    ): void {
      for (let i = 0; i <= 400; i++) {
        const t = i / 400;
        const u = 1 - t;
        disc(u * u * x1 + 2 * u * t * cx + t * t * x2, u * u * y1 + 2 * u * t * cy + t * t * y2, 0.9, rgb);
      }
      const ang = Math.atan2(y2 - cy, x2 - cx);
      const hl = 14;
      const hw = 6;
      for (let d = 0; d <= hl; d += 0.4) {
        const half = (hw * d) / hl;
        for (let w = fishhook ? 0 : -half; w <= half; w += 0.4) {
          put(x2 - Math.cos(ang) * d - Math.sin(ang) * w, y2 - Math.sin(ang) * d + Math.cos(ang) * w, rgb);
        }
      }
    },
  };
  return api;
}

describe("M17 Test 8 — mechanism vectorised from figure pixels", () => {
  // CH2=CH–CH2–O… drawn as a zig-zag: C1(80,130)=C2(132,100)–C3(184,130)–"O"(236,100),
  // with a curly arrow from the C=C bond over to the O label.
  const draw = (arrowRgb: readonly [number, number, number], fishhook = false) => {
    const f = makeFigure(400, 200);
    f.line(80, 130, 132, 100);
    f.line(88, 118, 126, 96); // second line of the double bond
    f.line(132, 100, 184, 130);
    f.line(184, 130, 222, 108);
    f.ring(236, 100, 9); // the "O" glyph
    f.arrow(102, 92, 160, 20, 226, 80, arrowRgb, fishhook);
    return f;
  };

  it("recovers the bond graph in place, merges the double bond, and snaps the arrow", () => {
    const f = draw([0, 0, 0]);
    const spec = extractMechanismFromRegion({ image: f });

    expect(spec.atoms2D?.length).toBe(4);
    expect(spec.bonds2D?.length).toBe(3);
    expect(spec.bonds2D?.filter((b) => b.order === 2).length).toBe(1);
    expect(spec.aspect).toBe(2);

    // Spatial preservation: every carbon sits within 4px of where it was drawn.
    const drawn = [[80, 130], [132, 100], [184, 130]] as const;
    for (const [x, y] of drawn) {
      const hit = spec.atoms2D!.some((a) => Math.hypot(a.x * 400 - x, a.y * 200 - y) < 4);
      expect(hit).toBe(true);
    }

    // One curly arrow: from the double bond to the (unread) label atom.
    expect(spec.arrows.length).toBe(1);
    const arrow = spec.arrows[0]!;
    const dbl = spec.bonds2D!.find((b) => b.order === 2)!;
    const label = spec.atoms2D!.find((a) => a.labelBox)!;
    expect(arrow.fromAtomOrBond).toBe(dbl.id);
    expect(arrow.toAtomOrBond).toBe(label.id);
    expect(arrow.barb).toBe("full");
    // The arc is kept as drawn: tail and head within a few px of the source.
    const g = arrow.geometry!;
    expect(Math.hypot(g[0] * 400 - 102, g[1] * 200 - 92)).toBeLessThan(5);
    expect(Math.hypot(g[6] * 400 - 226, g[7] * 200 - 80)).toBeLessThan(5);

    // The unread label is carried as traced ink (nothing in the figure is lost).
    expect(label.element).toBe("?");
    expect(spec.ink?.length).toBe(1);

    const svg = renderMechanismSvg(spec);
    expect(svg).toContain('viewBox="0 0 420 210"');
    expect(svg).toContain(`data-from="${dbl.id}"`);
    expect(svg).toContain('class="ito-traced-ink"');
    expect(renderMechanismSvg(spec)).toBe(svg);
  });

  it("names labels from the PDF's own text and writes the SMILES", () => {
    const f = draw([200, 30, 30]); // a red arrow, as many textbooks print them
    const cachedSpans = [
      { str: "O", normRect: [0.1 + 0.8 * (227 / 400), 0.2 + 0.4 * (91 / 200), 0.8 * (18 / 400), 0.4 * (18 / 200)] as const },
      { str: "A long caption line that spans the figure width", normRect: [0.1, 0.55, 0.8, 0.03] as const },
    ];
    const ocrChars = figureCharsFromSpans(cachedSpans, { x: 0.1, y: 0.2, width: 0.8, height: 0.4 });
    expect(ocrChars.length).toBe(1);

    const spec = extractMechanismFromRegion({ image: f, ocrChars });
    const o = spec.atoms2D!.find((a) => a.element === "O");
    expect(o).toBeDefined();
    expect(spec.ink ?? []).toHaveLength(0);
    expect(spec.smiles).toBe("C(=C)CO");
    expect(spec.arrows[0]?.toAtomOrBond).toBe(o!.id);
    expect(renderMechanismSvg(spec)).toMatch(/<text class="ito-atom-label" data-atom-id="O\d"/);
  });

  it("tells a fishhook (1e⁻) head from a full (2e⁻) head", () => {
    const spec = extractMechanismFromRegion({ image: draw([0, 0, 0], true) });
    expect(spec.arrows.length).toBe(1);
    expect(spec.arrows[0]!.barb).toBe("fishhook");
  });
});
