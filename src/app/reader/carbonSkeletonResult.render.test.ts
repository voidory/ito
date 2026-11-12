/**
 * Production MVP — CarbonSkeletonResult component render tests (Vitest/jsdom).
 *
 * CarbonSkeletonResult is a PURE VIEW over an already-produced
 * {@link CarbonSkeletonRecognition}. That is the test seam: we hand it a
 * hand-built successful (or failed) result and assert the rendered UI, WITHOUT
 * needing a real browser image decoder. This complements
 * identifyCarbonSkeleton.render.test.ts, which exercises the real
 * recognition-invocation + explicit-failure path through the SciencePanel.
 *
 * No production code is weakened for the test — the component already accepts
 * the recognition result + image data as props by design.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CarbonSkeletonResult } from "./CarbonSkeletonResult";
import type { CarbonSkeletonRecognition } from "../../science/recognition/carbonSkeleton";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.innerHTML = "";
});

async function render(node: ReturnType<typeof createElement>): Promise<HTMLElement> {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
  return container;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const CROP = "data:image/png;base64,AAAA";

/** A successful branched-chain result (2-methylpentane-like: 6 carbons, 5 bonds). */
function branchedSuccess(): CarbonSkeletonRecognition {
  return {
    success: true,
    status: "success",
    confidence: 0.82,
    notes: [],
    skeleton: {
      imageWidth: 200,
      imageHeight: 120,
      topology: { carbonCount: 6, bondCount: 5, ringCount: 0, shape: "branched-chain" },
      carbons: [
        { id: 0, x: 20, y: 90, degree: 1, isEndpoint: true, isBranch: false, inRing: false },
        { id: 1, x: 55, y: 60, degree: 3, isEndpoint: false, isBranch: true, inRing: false },
        { id: 2, x: 90, y: 90, degree: 2, isEndpoint: false, isBranch: false, inRing: false },
        { id: 3, x: 125, y: 60, degree: 2, isEndpoint: false, isBranch: false, inRing: false },
        { id: 4, x: 160, y: 90, degree: 1, isEndpoint: true, isBranch: false, inRing: false },
        { id: 5, x: 55, y: 25, degree: 1, isEndpoint: true, isBranch: false, inRing: false },
      ],
      bonds: [
        { source: 0, target: 1 },
        { source: 1, target: 2 },
        { source: 2, target: 3 },
        { source: 3, target: 4 },
        { source: 1, target: 5 },
      ],
    },
  };
}

/** A successful monocyclic result (cyclohexane: 6 carbons, 6 bonds, 1 ring). */
function ringSuccess(): CarbonSkeletonRecognition {
  const n = 6;
  const cx = 100;
  const cy = 100;
  const r = 60;
  const carbons = Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
    return {
      id: i,
      x: cx + r * Math.cos(a),
      y: cy + r * Math.sin(a),
      degree: 2,
      isEndpoint: false,
      isBranch: false,
      inRing: true,
    };
  });
  const bonds = Array.from({ length: n }, (_, i) => ({ source: i, target: (i + 1) % n }));
  return {
    success: true,
    status: "success",
    confidence: 0.95,
    notes: [],
    skeleton: {
      imageWidth: 200,
      imageHeight: 200,
      topology: { carbonCount: 6, bondCount: 6, ringCount: 1, ring: [0, 1, 2, 3, 4, 5], shape: "monocyclic" },
      carbons,
      bonds,
    },
  };
}

function failure(reason: string): CarbonSkeletonRecognition {
  return { success: false, status: "unsupported", confidence: 0.3, reason, notes: [] };
}

describe("CarbonSkeletonResult — successful recognition", () => {
  it("shows the summary with carbon/bond/ring counts and topology", async () => {
    let dismissed = false;
    await render(
      createElement(CarbonSkeletonResult, {
        result: branchedSuccess(),
        imageDataUrl: CROP,
        onDismiss: () => {
          dismissed = true;
        },
      }),
    );

    expect(document.querySelector('[data-testid="carbon-skeleton-success"]')).not.toBeNull();
    const counts = document.querySelector('[data-testid="carbon-skeleton-counts"]')!;
    expect(counts.textContent).toContain("6 carbons");
    expect(counts.textContent).toContain("5 bonds");
    expect(counts.textContent).toContain("0 rings");

    const topology = document.querySelector('[data-testid="carbon-skeleton-topology"]')!;
    expect(topology.textContent).toBe("Branched chain");

    // Confidence is QUALITATIVE — never the raw 0.82 / "82%".
    const conf = document.querySelector('[data-testid="carbon-skeleton-confidence"]')!;
    expect(conf.textContent).toBe("Moderate confidence");
    expect(conf.textContent).not.toContain("0.82");
    expect(conf.textContent).not.toContain("82");

    expect(dismissed).toBe(false);
  });

  it("renders the crop image and an SVG overlay in the image's coordinate space", async () => {
    await render(
      createElement(CarbonSkeletonResult, {
        result: branchedSuccess(),
        imageDataUrl: CROP,
        onDismiss: () => undefined,
      }),
    );

    const img = document.querySelector('[data-testid="carbon-skeleton-crop"]') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.getAttribute("src")).toBe(CROP);

    const svg = document.querySelector('[data-testid="carbon-skeleton-svg"]')!;
    expect(svg).not.toBeNull();
    // viewBox matches the recogniser's analysed image pixel space (no drift).
    expect(svg.getAttribute("viewBox")).toBe("0 0 200 120");
    expect(svg.getAttribute("preserveAspectRatio")).toBe("none");
  });

  it("renders one marker per carbon and one line per bond (branched chain)", async () => {
    await render(
      createElement(CarbonSkeletonResult, {
        result: branchedSuccess(),
        imageDataUrl: CROP,
        onDismiss: () => undefined,
      }),
    );

    expect(document.querySelectorAll('[data-testid="carbon-skeleton-carbon"]').length).toBe(6);
    expect(document.querySelectorAll('[data-testid="carbon-skeleton-bond"]').length).toBe(5);

    // The branch vertex (id 1) is visually distinguished.
    const branchMarkers = document.querySelectorAll(".ito-cs-carbon--branch");
    expect(branchMarkers.length).toBe(1);

    // A bond line uses the recogniser's coordinates verbatim (carbon 0 -> 1).
    const firstBond = document.querySelector('[data-testid="carbon-skeleton-bond"]')!;
    expect(firstBond.getAttribute("x1")).toBe("20");
    expect(firstBond.getAttribute("y1")).toBe("90");
    expect(firstBond.getAttribute("x2")).toBe("55");
    expect(firstBond.getAttribute("y2")).toBe("60");
  });

  it("renders a ring result with ring vertices distinguished", async () => {
    await render(
      createElement(CarbonSkeletonResult, {
        result: ringSuccess(),
        imageDataUrl: CROP,
        onDismiss: () => undefined,
      }),
    );

    const counts = document.querySelector('[data-testid="carbon-skeleton-counts"]')!;
    expect(counts.textContent).toContain("6 carbons");
    expect(counts.textContent).toContain("6 bonds");
    expect(counts.textContent).toContain("1 ring");
    expect(document.querySelector('[data-testid="carbon-skeleton-topology"]')!.textContent).toBe(
      "Single ring",
    );
    expect(document.querySelectorAll('[data-testid="carbon-skeleton-carbon"]').length).toBe(6);
    expect(document.querySelectorAll('[data-testid="carbon-skeleton-bond"]').length).toBe(6);
    expect(document.querySelectorAll(".ito-cs-carbon--ring").length).toBe(6);
    // High confidence band for a crisp ring.
    expect(document.querySelector('[data-testid="carbon-skeleton-confidence"]')!.textContent).toBe(
      "High confidence",
    );
  });

  it("Dismiss invokes the callback", async () => {
    let dismissed = false;
    await render(
      createElement(CarbonSkeletonResult, {
        result: branchedSuccess(),
        imageDataUrl: CROP,
        onDismiss: () => {
          dismissed = true;
        },
      }),
    );
    await click(document.querySelector('[data-testid="carbon-skeleton-dismiss-btn"]')!);
    expect(dismissed).toBe(true);
  });
});

describe("CarbonSkeletonResult — explicit failure", () => {
  it("shows the failure message + reason and draws NO graph", async () => {
    await render(
      createElement(CarbonSkeletonResult, {
        result: failure("the structure has 2 rings (fused/polycyclic)"),
        imageDataUrl: CROP,
        onDismiss: () => undefined,
      }),
    );

    expect(document.querySelector('[data-testid="carbon-skeleton-failure"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="carbon-skeleton-reason"]')!.textContent).toContain(
      "fused/polycyclic",
    );

    // No fabricated / partial graph on failure.
    expect(document.querySelector('[data-testid="carbon-skeleton-svg"]')).toBeNull();
    expect(document.querySelector('[data-testid="carbon-skeleton-success"]')).toBeNull();
    expect(document.querySelectorAll('[data-testid="carbon-skeleton-carbon"]').length).toBe(0);
    expect(document.querySelectorAll('[data-testid="carbon-skeleton-bond"]').length).toBe(0);
  });
});
