/**
 * FEAT-005B §6 — development-only Area-crop harness integration test.
 *
 * Verifies the integration contract WITHOUT wiring recognition into the normal
 * Identify workflow:
 *   - an actual PNG crop (as a base64 data URL on an AreaAnchor) is DECODED,
 *   - reconstruction runs and produces a visualisable result,
 *   - the original crop is NOT modified,
 *   - failures (blank / undecodable / no-crop) are reported EXPLICITLY.
 *
 * Under jsdom there is no canvas decoder, so we inject a Node data-URL decoder
 * built on the pure-TS PNG decoder — the same decode path the benchmark uses.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AreaAnchor } from "../../../model/types";
import { probeAreaCrop, type DataUrlDecoder } from "./areaCropHarness";
import { decodePngToGray } from "./pngDecode";

const PNG_DIR = resolve(__dirname, "..", "fixtures", "realworld", "png");

/** Build an AreaAnchor whose imageDataUrl is a real PNG crop (base64). */
function anchorFromPng(name: string): AreaAnchor {
  const bytes = readFileSync(resolve(PNG_DIR, `${name}.png`));
  const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
  return {
    docId: "doc-1" as AreaAnchor["docId"],
    sourceVersionHash: "v1" as AreaAnchor["sourceVersionHash"],
    pageIndex: 0,
    rect: { x: 0, y: 0, width: 1, height: 1 },
    imageDataUrl: dataUrl,
  };
}

/** Node decoder: strip the data-URL prefix, base64-decode, decode PNG → gray. */
const nodeDecoder: DataUrlDecoder = (dataUrl: string) => {
  const comma = dataUrl.indexOf(",");
  const b64 = dataUrl.slice(comma + 1);
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  return decodePngToGray(bytes);
};

describe("FEAT-005B Area-crop harness (dev-only)", () => {
  it("decodes an actual PNG crop and reconstructs a carbon skeleton", async () => {
    const anchor = anchorFromPng("cyclohexane");
    const probe = await probeAreaCrop(anchor, nodeDecoder);
    expect(probe.decoded).toBe(true);
    expect(probe.result.status).toBe("success");
    expect(probe.result.atoms.length).toBe(6);
    expect(probe.result.bonds.length).toBe(6);
    expect(probe.result.cycleRank).toBe(1);
  });

  it("does NOT modify the original crop (imageDataUrl unchanged)", async () => {
    const anchor = anchorFromPng("benzene");
    const before = anchor.imageDataUrl;
    const probe = await probeAreaCrop(anchor, nodeDecoder);
    expect(probe.cropUnmodified).toBe(true);
    expect(anchor.imageDataUrl).toBe(before);
    expect(probe.message).not.toContain("WARNING");
  });

  it("produces a visualisable SVG debug overlay", async () => {
    const anchor = anchorFromPng("decalin");
    const probe = await probeAreaCrop(anchor, nodeDecoder);
    expect(probe.debugSvg).not.toBeNull();
    expect(probe.debugSvg!.startsWith("<svg")).toBe(true);
    // Overlay contains the reconstructed atoms/bonds.
    expect(probe.debugSvg!).toContain("<circle");
    expect(probe.debugSvg!).toContain("<line");
  });

  it("reports an explicit failure when there is no crop", async () => {
    const anchor: AreaAnchor = {
      docId: "doc-1" as AreaAnchor["docId"],
      sourceVersionHash: "v1" as AreaAnchor["sourceVersionHash"],
      pageIndex: 0,
      rect: { x: 0, y: 0, width: 1, height: 1 },
    };
    const probe = await probeAreaCrop(anchor, nodeDecoder);
    expect(probe.decoded).toBe(false);
    expect(probe.result.status).toBe("unsupported");
    expect(probe.message).toContain("No crop");
    expect(probe.cropUnmodified).toBe(true);
  });

  it("reports an explicit failure when the crop cannot be decoded", async () => {
    const anchor: AreaAnchor = {
      docId: "doc-1" as AreaAnchor["docId"],
      sourceVersionHash: "v1" as AreaAnchor["sourceVersionHash"],
      pageIndex: 0,
      rect: { x: 0, y: 0, width: 1, height: 1 },
      imageDataUrl: "data:image/png;base64,not-a-real-png",
    };
    const probe = await probeAreaCrop(anchor, nodeDecoder);
    expect(probe.decoded).toBe(false);
    expect(probe.result.status).toBe("unsupported");
    expect(probe.message.toLowerCase()).toContain("decode failed");
    // Even on failure the original crop is untouched.
    expect(probe.cropUnmodified).toBe(true);
  });
});
