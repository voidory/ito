import { describe, expect, it } from "vitest";
import { blendColors, deriveHubBlendColor, parseHex, toHex } from "./index";

/**
 * Pure coverage for watercolor MULTIPLY color semantics (§3.2): overlaps are
 * darker-or-equal per channel, order-independent, and single-color identity.
 */

describe("blendColors — multiplicative (watercolor multiply)", () => {
  it("multiply blend is darker-or-equal per channel than each input", () => {
    const a = "#ff8040";
    const b = "#80c0ff";
    const blended = parseHex(blendColors([a, b]));
    const ra = parseHex(a);
    const rb = parseHex(b);
    expect(blended.r).toBeLessThanOrEqual(ra.r);
    expect(blended.g).toBeLessThanOrEqual(ra.g);
    expect(blended.b).toBeLessThanOrEqual(ra.b);
    expect(blended.r).toBeLessThanOrEqual(rb.r);
    expect(blended.g).toBeLessThanOrEqual(rb.g);
    expect(blended.b).toBeLessThanOrEqual(rb.b);
  });

  it("is order-independent (commutative)", () => {
    const colors = ["#336699", "#cc3300", "#00ff80"];
    const forward = blendColors(colors);
    const reversed = blendColors([...colors].reverse());
    expect(forward).toBe(reversed);
  });

  it("a single color returns itself", () => {
    expect(blendColors(["#3a7bd5"])).toBe("#3a7bd5");
  });

  it("white is the identity (multiplying by white leaves a color unchanged)", () => {
    expect(blendColors(["#123456", "#ffffff"])).toBe("#123456");
  });

  it("black absorbs (multiplying by black yields black)", () => {
    expect(blendColors(["#abcdef", "#000000"])).toBe("#000000");
  });

  it("empty list returns white (multiplicative identity)", () => {
    expect(blendColors([])).toBe("#ffffff");
  });

  it("adding more colors only darkens (monotonic)", () => {
    const two = parseHex(blendColors(["#ff8040", "#80c0ff"]));
    const three = parseHex(blendColors(["#ff8040", "#80c0ff", "#c0c0c0"]));
    expect(three.r).toBeLessThanOrEqual(two.r);
    expect(three.g).toBeLessThanOrEqual(two.g);
    expect(three.b).toBeLessThanOrEqual(two.b);
  });
});

describe("parseHex / toHex", () => {
  it("round-trips a 6-digit hex", () => {
    expect(toHex(parseHex("#1a2b3c"))).toBe("#1a2b3c");
  });

  it("expands 3-digit shorthand", () => {
    expect(parseHex("#f0a")).toEqual({ r: 255, g: 0, b: 170 });
  });

  it("tolerates a missing leading '#'", () => {
    expect(parseHex("112233")).toEqual({ r: 17, g: 34, b: 51 });
  });

  it("throws on malformed input", () => {
    expect(() => parseHex("#zzzzzz")).toThrow();
    expect(() => parseHex("#1234")).toThrow();
  });
});

describe("deriveHubBlendColor", () => {
  it("blends the DISTINCT category colors (duplicates collapsed)", () => {
    const withDup = deriveHubBlendColor(["#ff8040", "#ff8040", "#80c0ff"]);
    const distinct = blendColors(["#ff8040", "#80c0ff"]);
    expect(withDup).toBe(distinct);
  });

  it("is order-independent and case-insensitive", () => {
    const a = deriveHubBlendColor(["#FF8040", "#80C0FF"]);
    const b = deriveHubBlendColor(["#80c0ff", "#ff8040"]);
    expect(a).toBe(b);
  });

  it("a single category color returns that color", () => {
    expect(deriveHubBlendColor(["#3a7bd5"])).toBe("#3a7bd5");
  });
});
