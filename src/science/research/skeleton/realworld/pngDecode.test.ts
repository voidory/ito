/**
 * FEAT-005B — unit tests for the pure-TS PNG decoder.
 *
 * The decoder underpins the whole real-world benchmark (it replaces the DOM
 * canvas decode path that jsdom lacks), so it is tested directly against the
 * committed corpus PNGs: it must decode the expected dimensions, produce a
 * white-dominant background with dark ink, and round-trip through grayscale.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decodePng, decodePngToGray } from "./pngDecode";

const PNG_DIR = resolve(__dirname, "..", "fixtures", "realworld", "png");

describe("pngDecode", () => {
  it("rejects non-PNG bytes", () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3, 4]))).toThrow(/signature/);
  });

  it("decodes a real corpus PNG to RGBA of the right size", () => {
    const bytes = new Uint8Array(readFileSync(resolve(PNG_DIR, "cyclohexane.png")));
    const img = decodePng(bytes);
    expect(img.width).toBeGreaterThan(0);
    expect(img.height).toBeGreaterThan(0);
    expect(img.rgba.length).toBe(img.width * img.height * 4);
  });

  it("produces a white-dominant background with dark ink", () => {
    const bytes = new Uint8Array(readFileSync(resolve(PNG_DIR, "benzene.png")));
    const gray = decodePngToGray(bytes);
    let dark = 0;
    let light = 0;
    for (let i = 0; i < gray.data.length; i++) {
      const v = gray.data[i] as number;
      if (v < 80) dark++;
      else if (v > 200) light++;
    }
    // A skeletal drawing is mostly whitespace with a thin dark skeleton.
    expect(light).toBeGreaterThan(dark);
    expect(dark).toBeGreaterThan(0);
  });

  it("decodes every committed corpus PNG without error", () => {
    const files = readdirSync(PNG_DIR).filter((f) => f.endsWith(".png"));
    expect(files.length).toBeGreaterThanOrEqual(50);
    for (const f of files) {
      const bytes = new Uint8Array(readFileSync(resolve(PNG_DIR, f)));
      const gray = decodePngToGray(bytes);
      expect(gray.width).toBeGreaterThan(0);
      expect(gray.height).toBeGreaterThan(0);
    }
  });
});
