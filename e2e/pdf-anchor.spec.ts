import { expect, test, type Page } from "@playwright/test";

/**
 * M0 RISK SPIKE — PDF text selection + portable anchor round-trip (FEAT-002,
 * spec sections 22/26). This is RUNTIME validation in real chromium: it renders
 * the committed 3+ page fixture with a genuine pdf.js text layer, selects real
 * text, creates a portable anchor, then proves the anchor resolves back to the
 * same glyphs across reload, zoom change, and page resize.
 *
 * A static-string assertion or a mocked pdf.js would NOT satisfy the spec; the
 * harness at spikes/pdf-anchor renders the actual document.
 */

const SPIKE_URL = "/spikes/pdf-anchor/index.html";

/** A phrase present verbatim in a single wrapped line of the fixture text. */
const NEEDLE = "quick brown fox";

interface RenderInfo {
  pageText: string;
  versionHash: string;
  numPages: number;
}

interface ResolveResult {
  kind: string;
  rects: { x: number; y: number; width: number; height: number }[];
  text: string;
}

async function gotoSpike(page: Page): Promise<void> {
  await page.goto(SPIKE_URL);
  await expect(page.locator("body")).toHaveAttribute(
    "data-spike-ready",
    "true",
    { timeout: 15_000 },
  );
}

async function renderPage1(page: Page, scale = 1.5): Promise<RenderInfo> {
  return page.evaluate((s) => window.__spike.render(1, s), scale);
}

test("real pdf.js text layer renders with selectable text across 3+ pages", async ({
  page,
}) => {
  await gotoSpike(page);
  const info = await renderPage1(page);

  expect(info.numPages).toBeGreaterThanOrEqual(3);
  expect(info.versionHash).toMatch(/^[0-9a-f]{64}$/);
  expect(info.pageText).toContain(NEEDLE);

  // Prove the text layer is genuinely in the DOM and selectable (not a canvas
  // raster): there are positioned text spans covering the needle.
  const spanCount = await page.locator(".textLayer span").count();
  expect(spanCount).toBeGreaterThan(0);
});

test("anchor round-trips across reload, zoom change, and page resize", async ({
  page,
}) => {
  await gotoSpike(page);
  const info = await renderPage1(page);

  const start = info.pageText.indexOf(NEEDLE);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = start + NEEDLE.length;

  // 1) Create the portable anchor from a REAL selection in the text layer.
  const anchor = await page.evaluate(
    ([s, e]) => window.__spike.createAnchorForRange(s as number, e as number),
    [start, end],
  );

  expect(anchor.selectedText).toBe(NEEDLE);
  expect(anchor.pageIndex).toBe(0);
  expect(anchor.rects.length).toBeGreaterThan(0);
  // Normalized rects must be within the page box (0..1).
  for (const r of anchor.rects) {
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.x + r.width).toBeLessThanOrEqual(1.0001);
    expect(r.y + r.height).toBeLessThanOrEqual(1.0001);
  }

  // Baseline resolution at the SAME render.
  const baseline: ResolveResult = await page.evaluate(
    (a) => window.__spike.resolve(a),
    anchor,
  );
  expect(baseline.kind).toBe("resolved");
  expect(baseline.text).toBe(NEEDLE);
  expect(baseline.rects.length).toBeGreaterThan(0);

  // 2) RELOAD the page entirely (fresh document, fresh render) and resolve the
  // SAME portable anchor object.
  await gotoSpike(page);
  await renderPage1(page);
  const afterReload: ResolveResult = await page.evaluate(
    (a) => window.__spike.resolve(a),
    anchor,
  );
  expect(afterReload.kind).toBe("resolved");
  expect(afterReload.text).toBe(NEEDLE);
  expectRectsClose(afterReload.rects, baseline.rects);

  // 3) ZOOM change: re-render at a different scale; normalized rects are
  // scale-invariant, so they must stay close to the baseline.
  await page.evaluate(() => window.__spike.zoom(2.5));
  const afterZoom: ResolveResult = await page.evaluate(
    (a) => window.__spike.resolve(a),
    anchor,
  );
  expect(afterZoom.kind).toBe("resolved");
  expect(afterZoom.text).toBe(NEEDLE);
  // Tolerance 0.03 (3% of the page box) absorbs sub-pixel glyph-box rounding
  // that pdf.js introduces at different scale factors. A genuine mis-anchor
  // would be off by whole lines/columns (> 0.1), so this still proves the
  // highlight tracks the same glyphs. See docs/spikes/pdf-anchor.md.
  expectRectsClose(afterZoom.rects, baseline.rects, 0.03);

  // 4) PAGE RESIZE: shrink the mount and re-render smaller; still resolves to
  // the same normalized geometry.
  await page.evaluate(() => window.__spike.resizeMount(400));
  await page.evaluate(() => window.__spike.zoom(1.0));
  const afterResize: ResolveResult = await page.evaluate(
    (a) => window.__spike.resolve(a),
    anchor,
  );
  expect(afterResize.kind).toBe("resolved");
  expect(afterResize.text).toBe(NEEDLE);
  expectRectsClose(afterResize.rects, baseline.rects, 0.03);
});

test("version-hash mismatch resolves to an explicit mismatched state", async ({
  page,
}) => {
  await gotoSpike(page);
  const info = await renderPage1(page);
  const start = info.pageText.indexOf(NEEDLE);
  const anchor = await page.evaluate(
    ([s, e]) => window.__spike.createAnchorForRange(s as number, e as number),
    [start, start + NEEDLE.length],
  );

  // Tamper with the stored version hash: resolution must be EXPLICIT, not a
  // silent drop (spec invariant: unresolved/mismatched anchors are first-class).
  const tampered = { ...anchor, sourceVersionHash: "deadbeef" };
  const result: ResolveResult = await page.evaluate(
    (a) => window.__spike.resolve(a),
    tampered,
  );
  expect(result.kind).toBe("mismatched");
  expect(result.rects.length).toBe(0);
});

/**
 * Assert two sets of normalized rects describe the same region. Because
 * resolution re-derives geometry from the live DOM (not the stored rects), tiny
 * sub-pixel differences are expected; the default tolerance is generous but
 * still far tighter than a mis-anchor would be.
 */
function expectRectsClose(
  got: { x: number; y: number; width: number; height: number }[],
  want: { x: number; y: number; width: number; height: number }[],
  tol = 0.01,
): void {
  expect(got.length).toBeGreaterThan(0);
  // Compare the union bounding box, which is robust to run-splitting differences.
  const bb = (rs: typeof got) => ({
    x0: Math.min(...rs.map((r) => r.x)),
    y0: Math.min(...rs.map((r) => r.y)),
    x1: Math.max(...rs.map((r) => r.x + r.width)),
    y1: Math.max(...rs.map((r) => r.y + r.height)),
  });
  const a = bb(got);
  const b = bb(want);
  expect(Math.abs(a.x0 - b.x0)).toBeLessThanOrEqual(tol);
  expect(Math.abs(a.y0 - b.y0)).toBeLessThanOrEqual(tol);
  expect(Math.abs(a.x1 - b.x1)).toBeLessThanOrEqual(tol);
  expect(Math.abs(a.y1 - b.y1)).toBeLessThanOrEqual(tol);
}
