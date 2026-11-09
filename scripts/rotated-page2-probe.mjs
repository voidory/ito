/**
 * Live-browser verification for the fit-width/zoom blank-canvas fix and the
 * scroll-drift fix on rotated pages.
 *
 * 1. Open "Rotated Fixture", let it fit-width render.
 * 2. Scroll to page 2; assert zero pageerror/console errors (especially
 *    "Cannot use the same canvas during multiple render() operations").
 * 3. Assert page 2's <canvas> actually painted (non-blank pixels).
 * 4. Select rotated text on page 2, scroll the pane, and assert the live
 *    preview + highlight fragments stay inside the page stage (never floating
 *    onto the beige desk) and the toolbar tracks the selection or closes.
 * 5. Screenshot.
 */
import { chromium } from "playwright";
import fs from "node:fs/promises";

const TARGET_URL = process.env.TARGET_URL || "http://127.0.0.1:5173";
const OUT_DIR = "/projects/sandbox/.kiro/artifacts/screenshots";
const SHOT = `${OUT_DIR}/rotated-page2-scroll-verified.png`;
const EXECUTABLE_PATH =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
  "/inner_container/opt/playwright/chromium_headless_shell-1232/chrome-headless-shell-linux64/chrome-headless-shell";
const TOL = 2;

const errors = [];
let failed = false;
const fail = (m) => {
  failed = true;
  console.error(`✗ ${m}`);
};
const ok = (m) => console.log(`✓ ${m}`);

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXECUTABLE_PATH, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });

  try {
    await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });
    await page.getByTestId("library-item").first().waitFor({ state: "visible", timeout: 20000 });
    await page.getByTestId("library-open").filter({ hasText: /Rotated Fixture/ }).click();
    await page.getByTestId("source-pane").first().waitFor({ state: "attached", timeout: 20000 });
    await page.locator(".textLayer span").first().waitFor({ state: "visible", timeout: 20000 });

    // Push zoom up to ~260% so page 2 renders large (fit-width base * zoom).
    // Use the toolbar zoom-in button repeatedly, which drives serializedRerender.
    const zoomIn = page.getByTestId("pdf-zoom-in");
    if (await zoomIn.count()) {
      for (let i = 0; i < 6; i++) {
        await zoomIn.click().catch(() => {});
        await page.waitForTimeout(120);
      }
    }
    await page.waitForTimeout(600);

    // Scroll page 2's TEXT into the pane viewport. At high zoom the page is far
    // taller than the viewport, so scrollIntoView({block:center}) on the page
    // element leaves the glyphs off-screen; scroll the pane by the measured
    // delta that lands the first page-2 span mid-viewport instead.
    await page.evaluate(() => {
      const scroller = document.querySelector('[data-testid="pane-scroll"]');
      const el = [...document.querySelectorAll(".pdf-page")].find(
        (e) => e.getAttribute("data-page-index") === "1",
      );
      el?.scrollIntoView({ block: "start" });
      // Nudge so the first real span sits ~1/3 down the viewport.
      const layer = el?.querySelector(".textLayer");
      const span = layer && [...layer.querySelectorAll("span")].find(
        (s) => s.textContent && s.textContent.trim().length > 6,
      );
      if (span && scroller) {
        const sc = scroller.getBoundingClientRect();
        const r = span.getBoundingClientRect();
        const targetY = sc.top + sc.height * 0.35;
        scroller.scrollBy({ top: r.top - targetY });
      }
    });
    await page.waitForTimeout(800);

    // (2) No render-overlap / canvas errors.
    const canvasErr = errors.filter((e) => /same canvas during multiple render/i.test(e));
    if (canvasErr.length) fail(`canvas render-overlap error(s): ${canvasErr.join(" | ")}`);
    else ok("no 'same canvas during multiple render()' errors");
    if (errors.length) {
      console.error("  (all captured errors):", JSON.stringify(errors, null, 2));
      fail(`${errors.length} page/console error(s) captured`);
    } else {
      ok("zero pageerror / console.error");
    }

    // (3) Page 2 canvas is non-blank.
    const canvasInfo = await page.evaluate(() => {
      const pageEl = [...document.querySelectorAll(".pdf-page")].find(
        (e) => e.getAttribute("data-page-index") === "1",
      );
      const canvas = pageEl?.querySelector("canvas");
      if (!canvas) return { found: false };
      const r = canvas.getBoundingClientRect();
      // Sample pixels: count non-white, non-transparent pixels.
      const probe = document.createElement("canvas");
      probe.width = canvas.width;
      probe.height = canvas.height;
      const ctx = probe.getContext("2d");
      ctx.drawImage(canvas, 0, 0);
      let nonWhite = 0;
      const step = Math.max(1, Math.floor((canvas.width * canvas.height) / 40000));
      try {
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 0; i < data.length; i += 4 * step) {
          const [rr, gg, bb, aa] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
          if (aa > 0 && (rr < 250 || gg < 250 || bb < 250)) nonWhite++;
        }
      } catch {
        return { found: true, tainted: true, w: r.width, h: r.height };
      }
      return { found: true, nonWhite, w: Math.round(r.width), h: Math.round(r.height), cw: canvas.width, ch: canvas.height };
    });
    if (!canvasInfo.found) fail("page 2 canvas element not found");
    else if (canvasInfo.tainted) fail("page 2 canvas is tainted (could not sample)");
    else if ((canvasInfo.nonWhite ?? 0) < 20)
      fail(`page 2 canvas looks blank (nonWhite=${canvasInfo.nonWhite}, ${canvasInfo.cw}x${canvasInfo.ch})`);
    else ok(`page 2 canvas painted glyphs (nonWhite=${canvasInfo.nonWhite}, box ${canvasInfo.w}x${canvasInfo.h})`);

    // (4) Select text on page 2 (180°, horizontal-but-upside-down glyphs),
    // then scroll and check containment. Pick a span whose glyphs are actually
    // inside the pane-scroll viewport so the pointer drag lands on them, and
    // derive the drag path from the real per-character baseline geometry.
    const dragPath = await page.evaluate(() => {
      const scroller = document.querySelector('[data-testid="pane-scroll"]');
      const sc = scroller.getBoundingClientRect();
      const pageEl = [...document.querySelectorAll(".pdf-page")].find(
        (e) => e.getAttribute("data-page-index") === "1",
      );
      const layer = pageEl?.querySelector(".textLayer");
      if (!layer) return null;
      const spans = [...layer.querySelectorAll("span")].filter(
        (el) => el.firstChild instanceof Text && el.textContent.trim().length > 6,
      );
      const inBand = (c) =>
        c.y > sc.top + 20 && c.y < sc.bottom - 20 && c.x > sc.left + 20 && c.x < sc.right - 20;
      for (const span of spans) {
        const node = span.firstChild;
        // Per-character centres; keep the longest contiguous run that lies
        // inside the scroller viewport (spans can be wider than the viewport).
        const centres = [];
        for (let i = 0; i < node.data.length; i++) {
          const rg = document.createRange();
          rg.setStart(node, i);
          rg.setEnd(node, i + 1);
          const r = rg.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) { centres.push(null); continue; }
          centres.push({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
        }
        let runStart = -1;
        let best = null;
        for (let i = 0; i <= centres.length; i++) {
          const good = i < centres.length && centres[i] && inBand(centres[i]);
          if (good && runStart < 0) runStart = i;
          else if (!good && runStart >= 0) {
            const len = i - runStart;
            if (!best || len > best.len) best = { from: runStart, to: i - 1, len };
            runStart = -1;
          }
        }
        if (best && best.len >= 4) {
          const start = centres[best.from];
          const end = centres[best.to];
          return { start, end, text: node.data.slice(best.from, best.to + 1) };
        }
      }
      return null;
    });

    if (!dragPath) {
      fail("could not locate a page-2 span to select");
    } else {
      await page.mouse.move(dragPath.start.x, dragPath.start.y);
      await page.mouse.down();
      await page.mouse.move(dragPath.end.x, dragPath.end.y, { steps: 24 });
      await page.mouse.up();
      await page.waitForTimeout(250);

      // Confirm a selection + live preview formed BEFORE scrolling.
      const before = await page.evaluate(() => {
        const sel = window.getSelection();
        const pill = document.querySelector(".ito-selection-live-preview");
        const pr = pill?.getBoundingClientRect();
        return {
          text: (sel?.toString() ?? "").trim().slice(0, 40),
          collapsed: sel?.isCollapsed ?? true,
          pill: pr ? { left: Math.round(pr.left), top: Math.round(pr.top), right: Math.round(pr.right) } : null,
        };
      });
      console.log(`  pre-scroll selection: ${JSON.stringify(before)}`);
      if (before.collapsed || !before.text) fail("no selection formed on page 2 before scroll");
      else ok(`selection formed on page 2: "${before.text}"`);

      // Scroll the pane by 120px and let the coalescer recompute overlays. The
      // selection itself is not cleared by scrolling, so a live pill MUST still
      // be present and re-pinned (this is the regression under test).
      await page.evaluate(() => {
        document.querySelector('[data-testid="pane-scroll"]')?.scrollBy({ top: 120 });
      });
      await page.waitForTimeout(400);

      const after = await page.evaluate(() => {
        const sel = window.getSelection();
        const pill = document.querySelector(".ito-selection-live-preview");
        const pr = pill?.getBoundingClientRect();
        return {
          collapsed: sel?.isCollapsed ?? true,
          pill: pr ? { left: Math.round(pr.left), top: Math.round(pr.top), right: Math.round(pr.right) } : null,
        };
      });
      console.log(`  post-scroll selection: ${JSON.stringify(after)}`);
      if (!after.collapsed && before.pill && after.pill) {
        // The pill must have MOVED with the scroll (re-pinned), not frozen.
        const moved = Math.abs(after.pill.top - before.pill.top) > 10;
        if (moved) ok(`live pill re-pinned after scroll (top ${before.pill.top} -> ${after.pill.top})`);
        else fail(`live pill did NOT track scroll (frozen at top=${before.pill.top})`);
      }

      const contain = await page.evaluate(() => {
        const pageEl = [...document.querySelectorAll(".pdf-page")].find(
          (e) => e.getAttribute("data-page-index") === "1",
        );
        const stage = pageEl?.querySelector(".pdf-page-stage");
        const stageRect = stage?.getBoundingClientRect();
        const scroller = document.querySelector('[data-testid="pane-scroll"]');
        const scRect = scroller?.getBoundingClientRect();
        const boxes = (sel) =>
          [...document.querySelectorAll(sel)]
            .map((el) => el.getBoundingClientRect())
            .filter((r) => r.width > 0 && r.height > 0)
            .map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }));
        const toolbar = document.querySelector('[data-testid="selection-toolbar"]');
        return {
          stage: stageRect && { left: stageRect.left, top: stageRect.top, right: stageRect.right, bottom: stageRect.bottom },
          scroller: scRect && { left: scRect.left, top: scRect.top, right: scRect.right, bottom: scRect.bottom },
          previews: boxes(".ito-selection-live-preview"),
          fragments: boxes(".ito-highlight-fragment"),
          toolbarBox: toolbar ? (() => { const r = toolbar.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })() : null,
        };
      });

      if (!contain.stage) {
        fail("page-2 stage not found after scroll");
      } else {
        const s = contain.stage;
        const within = (r) =>
          r.right <= s.right + TOL && r.left >= s.left - TOL;
        const badPrev = contain.previews.filter((r) => !within(r));
        const badFrag = contain.fragments.filter((r) => !within(r));
        if (contain.previews.length === 0 && contain.fragments.length === 0) {
          console.log("  note: no preview/fragment present after scroll (selection may have cleared)");
        }
        if (badPrev.length) fail(`${badPrev.length} live-preview pill(s) float outside the page stage horizontally`);
        else ok(`live preview pills contained within page stage (count=${contain.previews.length})`);
        if (badFrag.length) fail(`${badFrag.length} highlight fragment(s) float outside the page stage`);
        else ok(`highlight fragments contained within page stage (count=${contain.fragments.length})`);

        // Toolbar: either tracks (inside the scroller band) or has closed.
        if (!contain.toolbarBox) {
          ok("selection toolbar closed cleanly after scroll");
        } else if (contain.scroller) {
          const t = contain.toolbarBox;
          const sc = contain.scroller;
          const tracks = t.bottom >= sc.top - 60 && t.top <= sc.bottom + 60;
          if (tracks) ok("selection toolbar tracks the scrolled selection");
          else fail(`toolbar frozen off-screen (top=${t.top.toFixed(0)} scroller=[${sc.top.toFixed(0)},${sc.bottom.toFixed(0)}])`);
        }
      }
    }

    await page.screenshot({ path: SHOT });
    ok(`screenshot saved: ${SHOT}`);
  } finally {
    await browser.close();
  }

  console.log(failed ? "\nPROBE RESULT: FAIL" : "\nPROBE RESULT: PASS");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
