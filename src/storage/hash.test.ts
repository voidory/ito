/**
 * Tests for the pure storage-layer hash + magic-byte helpers (M3, A17). These
 * run headlessly under jsdom/Node where crypto.subtle is available; they never
 * touch the pdf.js worker.
 */

import { describe, expect, it } from "vitest";
import { hasPdfMagic, sha256Hex } from "./hash";

/** Encode an ASCII string to bytes (jsdom provides TextEncoder). */
function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("sha256Hex", () => {
  it("matches the known digest of the empty input", async () => {
    expect(await sha256Hex(new Uint8Array([]))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("matches the known digest of 'abc'", async () => {
    expect(await sha256Hex(bytes("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("produces a 64-char lower-case hex string and is deterministic", async () => {
    const h = await sha256Hex(bytes("ito"));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(await sha256Hex(bytes("ito")));
  });
});

describe("hasPdfMagic", () => {
  it("accepts bytes beginning with a %PDF-1.4 prefix", () => {
    expect(hasPdfMagic(bytes("%PDF-1.4\n...rest of file..."))).toBe(true);
  });

  it("accepts the bare magic marker", () => {
    expect(hasPdfMagic(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe(true);
  });

  it("rejects arbitrary non-PDF bytes", () => {
    expect(hasPdfMagic(bytes("not a pdf"))).toBe(false);
    expect(hasPdfMagic(new Uint8Array([1, 2, 3, 4]))).toBe(false);
  });

  it("rejects input shorter than the magic marker", () => {
    expect(hasPdfMagic(new Uint8Array([0x25, 0x50]))).toBe(false);
    expect(hasPdfMagic(new Uint8Array([]))).toBe(false);
  });
});
