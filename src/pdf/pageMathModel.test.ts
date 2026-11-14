import { describe, expect, it } from "vitest";
import {
  buildPageMathModel,
  fontFamilyOf,
  pageMathModelFor,
  registerPageMathModel,
  type FontLike,
  type OpsTable,
} from "./pageMathModel";

// Any distinct numbers will do: the walker only compares against the table.
const OPS: OpsTable = Object.fromEntries(
  [
    "save", "restore", "transform", "paintFormXObjectBegin", "paintFormXObjectEnd", "setLineWidth",
    "beginText", "setFont", "setCharSpacing", "setWordSpacing", "setHScale", "setLeading",
    "setTextRise", "setLeadingMoveText", "moveText", "setTextMatrix", "nextLine", "showText",
    "constructPath", "stroke", "closeStroke", "fill", "eoFill", "fillStroke", "eoFillStroke",
    "closeFillStroke", "closeEOFillStroke", "endPath", "moveTo", "lineTo", "rectangle", "curveTo",
    "curveTo2", "curveTo3",
  ].map((name, i) => [name, i + 1]),
);
// A US Letter page: PDF y grows upwards, the model's y grows downwards.
const VIEWPORT = { transform: [1, 0, 0, -1, 0, 792], width: 612, height: 792 };
const FONTS: Record<string, FontLike> = {
  f1: { name: "ABCDEF+CMMI10", fontMatrix: [0.001, 0, 0, 0.001, 0, 0] },
  f2: { name: "ABCDEF+CMEX10", fontMatrix: [0.001, 0, 0, 0.001, 0, 0] },
  t3: { name: "T3", isType3Font: true },
};
const glyph = (code: number, width: number, unicode = "?") => ({ originalCharCode: code, width, unicode, isSpace: false });

function model(ops: [string, unknown][]) {
  return buildPageMathModel(
    { fnArray: ops.map(([name]) => OPS[name]!), argsArray: ops.map(([, args]) => args) },
    (id) => FONTS[id],
    OPS,
    VIEWPORT,
  );
}

describe("fontFamilyOf", () => {
  it("drops the subset tag and the design size", () => {
    expect(fontFamilyOf("HWMSQP+CMMI10")).toEqual({ face: "CMMI10", family: "CMMI" });
    expect(fontFamilyOf("CMR7")).toEqual({ face: "CMR7", family: "CMR" });
    expect(fontFamilyOf(undefined)).toEqual({ face: "", family: "" });
  });
});

describe("buildPageMathModel: glyphs", () => {
  it("keeps the font slot and places each glyph from the text state", () => {
    const m = model([
      ["beginText", []],
      ["setFont", ["f1", 10]],
      ["setTextMatrix", [1, 0, 0, 1, 100, 700]],
      // x, a kern of -200/1000 em (moves right by 2pt), then y.
      ["showText", [[glyph(0x78, 572, "x"), -200, glyph(0x79, 490, "y")]]],
      ["moveText", [0, -12]],
      ["showText", [[glyph(0x7a, 465, "z")]]],
    ]);
    expect(m.glyphs.map((g) => [g.family, g.slot])).toEqual([["CMMI", 0x78], ["CMMI", 0x79], ["CMMI", 0x7a]]);
    const [x, y, z] = m.glyphs;
    expect(x!.x).toBeCloseTo(100);
    expect(x!.y).toBeCloseTo(92); // 792 - 700
    expect(x!.advance).toBeCloseTo(5.72);
    expect(x!.size).toBeCloseTo(10);
    expect(x!.angle).toBeCloseTo(0);
    expect(y!.x).toBeCloseTo(100 + 5.72 + 2);
    // moveText is relative to the start of the previous line, not to the pen.
    expect(z!.x).toBeCloseTo(100);
    expect(z!.y).toBeCloseTo(104);
  });

  it("follows the transform stack", () => {
    const m = model([
      ["save", []],
      ["transform", [2, 0, 0, 2, 10, 20]],
      ["beginText", []],
      ["setFont", ["f1", 5]],
      ["setTextMatrix", [1, 0, 0, 1, 50, 300]],
      ["showText", [[glyph(0x78, 572)]]],
      ["restore", []],
      ["beginText", []],
      ["setFont", ["f1", 5]],
      ["setTextMatrix", [1, 0, 0, 1, 50, 300]],
      ["showText", [[glyph(0x78, 572)]]],
    ]);
    expect(m.glyphs[0]!.x).toBeCloseTo(110);
    expect(m.glyphs[0]!.y).toBeCloseTo(792 - 620);
    expect(m.glyphs[0]!.size).toBeCloseTo(10);
    expect(m.glyphs[1]!.x).toBeCloseTo(50);
    expect(m.glyphs[1]!.size).toBeCloseTo(5);
  });

  it("reports rotated text with its angle and skips Type 3 fonts", () => {
    const m = model([
      ["beginText", []],
      ["setFont", ["f1", 10]],
      ["setTextMatrix", [0, 1, -1, 0, 100, 100]],
      ["showText", [[glyph(0x78, 572)]]],
      ["setFont", ["t3", 10]],
      ["showText", [[glyph(0x41, 500)]]],
    ]);
    expect(m.glyphs).toHaveLength(1);
    expect(Math.abs(m.glyphs[0]!.angle)).toBeCloseTo(Math.PI / 2);
  });
});

describe("buildPageMathModel: rules", () => {
  it("reads a stroked rule with its width, as pdfTeX draws fraction bars", () => {
    const m = model([
      ["setLineWidth", [0.398]],
      ["constructPath", [[OPS.moveTo, OPS.lineTo], [100, 500, 140, 500]]],
      ["stroke", []],
    ]);
    expect(m.rules).toEqual([{ x0: 100, x1: 140, y: 292, thickness: 0.398 }]);
  });

  it("joins a path that pdf.js delivers as two constructPath operations", () => {
    const m = model([
      ["setLineWidth", [0.4]],
      ["constructPath", [[OPS.moveTo], [100, 500]]],
      ["constructPath", [[OPS.lineTo], [140, 500]]],
      ["stroke", []],
    ]);
    expect(m.rules).toHaveLength(1);
    expect(m.rules[0]!.x1 - m.rules[0]!.x0).toBeCloseTo(40);
  });

  it("reads a thin filled rectangle, and ignores boxes and unpainted paths", () => {
    const m = model([
      ["constructPath", [[OPS.rectangle], [100, 500, 40, 0.4]]],
      ["fill", []],
      ["constructPath", [[OPS.rectangle], [100, 400, 40, 30]]],
      ["fill", []],
      ["constructPath", [[OPS.moveTo, OPS.lineTo], [0, 0, 50, 0]]],
      ["endPath", []],
    ]);
    expect(m.rules).toHaveLength(1);
    expect(m.rules[0]!.thickness).toBeCloseTo(0.4);
    expect(m.rules[0]!.y).toBeCloseTo(792 - 500.2);
  });

  it("keeps vertical rules apart from horizontal ones", () => {
    const m = model([
      ["setLineWidth", [0.4]],
      ["constructPath", [[OPS.moveTo, OPS.lineTo], [100, 500, 100, 540]]],
      ["stroke", []],
    ]);
    expect(m.rules).toHaveLength(0);
    expect(m.vrules).toEqual([{ x: 100, y0: 252, y1: 292 }]);
  });
});

describe("page model registry", () => {
  it("builds a stage's model once and gives null for an unknown stage", async () => {
    const stage = document.createElement("div");
    let builds = 0;
    registerPageMathModel(stage, async () => {
      builds++;
      return model([]);
    });
    const a = await pageMathModelFor(stage);
    const b = await pageMathModelFor(stage);
    expect(a).toBe(b);
    expect(builds).toBe(1);
    expect(await pageMathModelFor(document.createElement("div"))).toBeNull();
    expect(await pageMathModelFor(null)).toBeNull();
  });

  it("gives null when the model cannot be built", async () => {
    const stage = document.createElement("div");
    registerPageMathModel(stage, async () => {
      throw new Error("worker gone");
    });
    expect(await pageMathModelFor(stage)).toBeNull();
  });
});
