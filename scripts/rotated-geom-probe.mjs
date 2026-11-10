/**
 * M13 FEAT-001 — Rotated span alignment + real-browser geometry proof.
 *
 * render.ts builds the text layer via pdf.js's own `new pdfjs.TextLayer(...)`
 * builder (which applies each glyph's rotation transform) and positions spans
 * via the `--scale-factor` CSS var on the stage/textLayer; pointerSelection.ts
 * already hit-tests rotated/vertical spans via per-character geometry. This
 * probe PROVES the rotated geometry is correct in a REAL headless browser
 * against the built `dist/` bundle, mirroring e2e/selection.spec.ts.
 *
 * It opens the "Rotated Fixture" from the Library, finds the `.textLayer span`
 * that contains "Rotated page at 90 degrees" (the 90°-rotated page), and
 * asserts:
 *   a. the span is vertically oriented (rect.height > rect.width),
 *   b. the span sits on the RIGHT half of its page stage (horizontal centre
 *      > 50% of the stage width — i.e. NOT stranded in the top-left corner),
 *   c. dragging vertically along the span produces a non-empty DOM selection
 *      AND an Ito live-preview / highlight fragment whose client rect overlaps
 *      the span's rect within <= 8px on every side.
 *
 * On success it prints "ROTATED-GEOM-PROOF: PASS" and exits 0; any failed
 * assertion throws with diagnostics and exits 1.
 *
 * Usage:  node scripts/rotated-geom-probe.mjs
 */

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const EXEC =
  "/inner_container/opt/playwright/chromium_headless_shell-1232/chrome-headless-shell-linux64/chrome-headless-shell";
const PORT = 4173;
const BASE = `http://localhost:${PORT}/`;
const NEEDLE = "Rotated page at 90 degrees";

/** Spawn `vite preview` serving the built dist/ and resolve once it responds. */
async function startPreview() {
  const proc = spawn(
    "npx",
    ["vite", "preview", "--port", String(PORT), "--strictPort"],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  proc.stdout.on("data", (b) => process.stdout.write(`[preview] ${b}`));
  proc.stderr.on("data", (b) => process.stderr.write(`[preview] ${b}`));

  // Poll the server until it answers (max ~30s).
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE, { method: "GET" });
      if (res.ok) return proc;
    } catch {
      /* not ready yet */
    }
    await delay(300);
  }
  throw new Error("vite preview did not become ready within 30s");
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

let preview;
let browser;
try {
  preview = await startPreview();
  browser = await chromium.launch({
    executablePath: EXEC,
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
  page.on("console", (m) => process.stdout.write(`[page:${m.type()}] ${m.text()}\n`));

  await page.goto(BASE, { waitUntil: "domcontentloaded" });

  // Open the Rotated Fixture (mirror e2e/selection.spec.ts).
  await page.getByTestId("library-item").first().waitFor({ state: "visible", timeout: 15_000 });
  await page.getByTestId("library-open").filter({ hasText: /Rotated Fixture/ }).click();
  await page
    .getByTestId("source-pane")
    .first()
    .waitFor({ state: "attached", timeout: 20_000 });
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="source-pane"]')
        ?.getAttribute("data-ready") === "true",
    { timeout: 20_000 },
  );
  await page.locator(".textLayer span").first().waitFor({ state: "visible", timeout: 20_000 });

  // Locate the page index that actually carries the 90° needle, scroll it into
  // view, and read the rotated span's rect + its page-stage rect.
  const found = await page.evaluate((needle) => {
    const pages = [...document.querySelectorAll(".pdf-page")];
    for (const pg of pages) {
      const layer = pg.querySelector(".textLayer");
      if (!layer) continue;
      const span = [...layer.querySelectorAll("span")].find(
        (el) =>
          el.firstChild?.nodeType === Node.TEXT_NODE &&
          el.firstChild.textContent?.includes(needle),
      );
      if (span) {
        pg.scrollIntoView({ block: "center" });
        return {
          pageIndex: pg.getAttribute("data-page-index"),
        };
      }
    }
    return null;
  }, NEEDLE);

  assert(found, `could not find a .textLayer span containing "${NEEDLE}"`);
  console.log(`Found needle on page-index ${found.pageIndex}`);
  // Allow layout to settle after scroll.
  await delay(300);

  const geom = await page.evaluate((needle) => {
    const pages = [...document.querySelectorAll(".pdf-page")];
    let span = null;
    let stage = null;
    for (const pg of pages) {
      const layer = pg.querySelector(".textLayer");
      const s =
        layer &&
        [...layer.querySelectorAll("span")].find(
          (el) =>
            el.firstChild?.nodeType === Node.TEXT_NODE &&
            el.firstChild.textContent?.includes(needle),
        );
      if (s) {
        span = s;
        stage = pg.querySelector(".pdf-page-stage") ?? pg;
        break;
      }
    }
    if (!span || !stage) return null;
    const node = span.firstChild;
    const start = node.data.indexOf(needle);
    // Per-character rects to find the true visible, rotated baseline. Mirror
    // e2e/selection.spec.ts: project the glyph centres onto the reading axis so
    // the drag follows the actual rotated baseline (not an assumed vertical).
    const charRects = [];
    for (let i = start; i < start + needle.length; i++) {
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      charRects.push(range.getBoundingClientRect());
    }
    const r = span.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    const first = charRects[0];
    const last = charRects[charRects.length - 1];
    const firstCenter = { x: first.left + first.width / 2, y: first.top + first.height / 2 };
    const lastCenter = { x: last.left + last.width / 2, y: last.top + last.height / 2 };
    const dx = lastCenter.x - firstCenter.x;
    const dy = lastCenter.y - firstCenter.y;
    const length = Math.hypot(dx, dy) || 1;
    const axis = { x: dx / length, y: dy / length };
    const normal = { x: -axis.y, y: axis.x };
    const project = (rc) =>
      [
        [rc.left, rc.top],
        [rc.right, rc.top],
        [rc.left, rc.bottom],
        [rc.right, rc.bottom],
      ].map(([x, y]) => x * axis.x + y * axis.y);
    const firstAlong = project(first);
    const lastAlong = project(last);
    const across = firstCenter.x * normal.x + firstCenter.y * normal.y;
    const point = (along) => ({
      x: along * axis.x + across * normal.x,
      y: along * axis.y + across * normal.y,
    });
    // Inset the endpoints slightly inside the first/last glyphs for a robust
    // caret hit (same 0.75px inset as the e2e spec).
    const startPoint = point(Math.min(...firstAlong) + 0.75);
    const endPoint = point(Math.max(...lastAlong) - 0.75);
    // The individually-measured union of the needle's glyph rects = the true
    // visible target region the preview must cover.
    const target = {
      left: Math.min(...charRects.map((c) => c.left)),
      top: Math.min(...charRects.map((c) => c.top)),
      right: Math.max(...charRects.map((c) => c.right)),
      bottom: Math.max(...charRects.map((c) => c.bottom)),
    };
    return {
      span: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
      stage: { left: sr.left, top: sr.top, right: sr.right, bottom: sr.bottom, width: sr.width, height: sr.height },
      startPoint,
      endPoint,
      target,
    };
  }, NEEDLE);

  assert(geom, `could not measure the rotated span geometry for "${NEEDLE}"`);
  console.log("span rect:", JSON.stringify(geom.span));
  console.log("stage rect:", JSON.stringify(geom.stage));

  // (a) vertically oriented.
  assert(
    geom.span.height > geom.span.width,
    `span should be vertical (height ${geom.span.height.toFixed(1)} > width ${geom.span.width.toFixed(1)})`,
  );

  // (b) on the RIGHT half of the page stage (a 90° CW page puts the top-of-text
  // on the right edge). Horizontal centre > 50% of stage width.
  const centreX = (geom.span.left + geom.span.right) / 2;
  const relX = (centreX - geom.stage.left) / geom.stage.width;
  console.log(`span horizontal centre at ${(relX * 100).toFixed(1)}% of stage width`);
  assert(
    relX > 0.5,
    `span centre should be on the RIGHT half (> 50%), got ${(relX * 100).toFixed(1)}%`,
  );

  // (c) drag along the span's visible rotated baseline (first glyph -> last
  // glyph, projected onto the reading axis) and prove the DOM selection + Ito
  // live preview occupy the same viewport region as the visible glyphs.
  await page.mouse.move(geom.startPoint.x, geom.startPoint.y);
  await page.mouse.down();
  await page.mouse.move(geom.endPoint.x, geom.endPoint.y, { steps: 30 });
  await page.mouse.up();

  const sel = await page.evaluate(() => {
    const selection = window.getSelection();
    const hasText =
      !!selection && !selection.isCollapsed && selection.toString().trim().length > 0;
    const union = (items) =>
      items.length
        ? {
            left: Math.min(...items.map((r) => r.left)),
            top: Math.min(...items.map((r) => r.top)),
            right: Math.max(...items.map((r) => r.right)),
            bottom: Math.max(...items.map((r) => r.bottom)),
          }
        : null;
    let rangeBox = null;
    if (selection && selection.rangeCount > 0) {
      const rects = [...selection.getRangeAt(0).getClientRects()].filter(
        (r) => r.width > 0 && r.height > 0,
      );
      rangeBox = union(rects);
    }
    const previews = [
      ...document.querySelectorAll(".ito-selection-live-preview, .ito-highlight-fragment"),
    ]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0);
    return {
      hasText,
      text: selection ? selection.toString().trim() : "",
      rangeBox,
      previewBox: union(previews),
      previewCount: previews.length,
    };
  });

  console.log("selection:", JSON.stringify(sel));
  assert(sel.hasText, "vertical drag should produce a non-empty DOM selection");
  assert(sel.rangeBox, "selection should have a measurable range box");
  assert(
    sel.previewBox,
    "expected at least one .ito-selection-live-preview / .ito-highlight-fragment",
  );

  // The native Range geometry must occupy the rotated region of the visible
  // glyphs (same region, vertically oriented), within 8px on every side.
  const rangeGaps = {
    left: sel.rangeBox.left - geom.target.left,
    top: sel.rangeBox.top - geom.target.top,
    right: geom.target.right - sel.rangeBox.right,
    bottom: geom.target.bottom - sel.rangeBox.bottom,
  };
  console.log("range-vs-visible-glyphs gaps (px):", JSON.stringify(rangeGaps));
  assert(
    sel.rangeBox.bottom - sel.rangeBox.top > (sel.rangeBox.right - sel.rangeBox.left) * 2,
    "the selection's range box must itself be vertically oriented",
  );
  for (const side of ["left", "top", "right", "bottom"]) {
    assert(
      Math.abs(rangeGaps[side]) <= 8,
      `range ${side} gap ${rangeGaps[side].toFixed(1)}px exceeds 8px tolerance`,
    );
  }

  // Ito's live preview must mirror the native Selection's client geometry
  // (this is the FEAT-001 overlap property): gap <= 8px on every side.
  const gaps = {
    left: sel.previewBox.left - sel.rangeBox.left,
    top: sel.previewBox.top - sel.rangeBox.top,
    right: sel.rangeBox.right - sel.previewBox.right,
    bottom: sel.rangeBox.bottom - sel.previewBox.bottom,
  };
  console.log("preview-vs-range gaps (px):", JSON.stringify(gaps));
  for (const side of ["left", "top", "right", "bottom"]) {
    assert(
      Math.abs(gaps[side]) <= 8,
      `preview ${side} gap ${gaps[side].toFixed(1)}px exceeds 8px tolerance`,
    );
  }

  console.log("ROTATED-GEOM-PROOF: PASS");
  process.exitCode = 0;
} catch (err) {
  console.error("ROTATED-GEOM-PROOF: FAIL");
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
} finally {
  try {
    if (browser) await browser.close();
  } catch (e) {
    console.error("browser close error:", String(e));
  }
  if (preview) {
    try {
      preview.kill("SIGTERM");
    } catch (e) {
      console.error("preview kill error:", String(e));
    }
  }
}
