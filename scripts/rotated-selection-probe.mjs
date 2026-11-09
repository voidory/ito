/**
 * Real-browser verification of rotated (90°/270°) PDF pointer text selection.
 *
 * jsdom cannot compute CSS 2D transform matrices or real per-character
 * `Range.getClientRects()`, so the geometric correctness of the fix is proven
 * here with chrome-headless-shell driving the actual Reader:
 *   1. Open "Rotated Fixture".
 *   2. For each rotated page (90° = page 0, 270° = page 2), measure the visible
 *      vertical glyph box and the baseline axis from per-character rects.
 *   3. Drag the real mouse along that vertical baseline.
 *   4. Assert the selected text matches AND the native Range + Ito's live
 *      preview geometry overlap the visible glyph box within tolerance.
 *   5. Save a screenshot of the aligned selection.
 */
import { chromium } from "playwright";
import fs from "node:fs/promises";

const TARGET_URL = process.env.TARGET_URL || "http://127.0.0.1:5173";
const OUT_DIR = "/projects/sandbox/.kiro/artifacts/screenshots";
const SHOT = `${OUT_DIR}/rotated-selection-verified.png`;
const EXECUTABLE_PATH =
  "/inner_container/opt/playwright/chromium_headless_shell-1232/chrome-headless-shell-linux64/chrome-headless-shell";
const GEOM_TOLERANCE = 6; // px, per handoff
const PREVIEW_TOLERANCE = 6; // px, preview vs native Range

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({
    executablePath: EXECUTABLE_PATH,
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  try {
    await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });
    await page.getByTestId("library-item").first().waitFor({ state: "visible", timeout: 20000 });
    await page.getByTestId("library-open").filter({ hasText: /Rotated Fixture/ }).click();
    await page
      .getByTestId("source-pane")
      .first()
      .waitFor({ state: "attached", timeout: 20000 });
    await page.locator(".textLayer span").first().waitFor({ state: "visible", timeout: 20000 });
    await page.waitForTimeout(600);

    for (const rotation of [90, 270]) {
      const pageIndex = rotation === 90 ? 0 : 2;
      const needle = `Rotated page at ${rotation} degrees`;

      // Scroll the target page into view so the drag path lands inside the
      // viewport (page 3 / 270° is far down the scroll container).
      await page.evaluate((pageIndex) => {
        const pageEl = [...document.querySelectorAll(".pdf-page")].find(
          (el) => el.getAttribute("data-page-index") === String(pageIndex),
        );
        pageEl?.scrollIntoView({ block: "center" });
      }, pageIndex);
      await page.waitForTimeout(300);

      const measure = () => page.evaluate(
        ({ needle, pageIndex }) => {
          const pageEl = [...document.querySelectorAll(".pdf-page")].find(
            (el) => el.getAttribute("data-page-index") === String(pageIndex),
          );
          const layer = pageEl?.querySelector(".textLayer");
          const span =
            layer &&
            [...layer.querySelectorAll("span")].find(
              (el) =>
                el.firstChild?.nodeType === Node.TEXT_NODE &&
                el.firstChild.textContent?.includes(needle),
            );
          const node = span?.firstChild;
          if (!(node instanceof Text) || !span) return null;
          const start = node.data.indexOf(needle);
          if (start < 0) return null;

          const charRects = [];
          for (let i = start; i < start + needle.length; i++) {
            const range = document.createRange();
            range.setStart(node, i);
            range.setEnd(node, i + 1);
            charRects.push(range.getBoundingClientRect());
          }
          const first = charRects[0];
          const last = charRects[charRects.length - 1];
          const fc = { x: first.left + first.width / 2, y: first.top + first.height / 2 };
          const lc = { x: last.left + last.width / 2, y: last.top + last.height / 2 };
          const dx = lc.x - fc.x;
          const dy = lc.y - fc.y;
          const length = Math.hypot(dx, dy);
          if (!length) return null;
          const axis = { x: dx / length, y: dy / length };
          const normal = { x: -axis.y, y: axis.x };
          const proj = (r) =>
            [
              [r.left, r.top],
              [r.right, r.top],
              [r.left, r.bottom],
              [r.right, r.bottom],
            ].map(([x, y]) => x * axis.x + y * axis.y);
          const firstAlong = proj(first);
          const lastAlong = proj(last);
          const across = fc.x * normal.x + fc.y * normal.y;
          const point = (along) => ({
            x: along * axis.x + across * normal.x,
            y: along * axis.y + across * normal.y,
          });
          const startPoint = point(Math.min(...firstAlong) + 0.75);
          const endPoint = point(Math.max(...lastAlong) - 0.75);
          const target = {
            left: Math.min(...charRects.map((r) => r.left)),
            top: Math.min(...charRects.map((r) => r.top)),
            right: Math.max(...charRects.map((r) => r.right)),
            bottom: Math.max(...charRects.map((r) => r.bottom)),
          };
          return {
            startPoint,
            endPoint,
            target,
            vertical: target.bottom - target.top > (target.right - target.left) * 5,
          };
        },
        { needle, pageIndex },
      );

      let path = await measure();

      // Nudge the run into a safe band (clear of toolbar + viewport edges) so
      // the drag presses on glyphs, not header UI, then re-measure.
      if (path) {
        const viewportH = page.viewportSize().height;
        const safeTop = 140;
        const safeBottom = viewportH - 40;
        const bandTop = Math.min(path.startPoint.y, path.endPoint.y, path.target.top);
        const bandBottom = Math.max(path.startPoint.y, path.endPoint.y, path.target.bottom);
        let delta = 0;
        if (bandTop < safeTop) delta = bandTop - safeTop;
        else if (bandBottom > safeBottom) delta = bandBottom - safeBottom;
        if (delta !== 0) {
          await page.evaluate((dy) => {
            document.querySelector('[data-testid="pane-scroll"]')?.scrollBy({ top: dy });
          }, delta);
          await page.waitForTimeout(250);
          path = await measure();
        }
      }

      if (!path) {
        fail(`${rotation}°: fixture text not measurable`);
        const dbg = await page.evaluate((pageIndex) => {
          const pageEl = [...document.querySelectorAll(".pdf-page")].find(
            (el) => el.getAttribute("data-page-index") === String(pageIndex),
          );
          const layer = pageEl?.querySelector(".textLayer");
          const spans = layer ? [...layer.querySelectorAll("span")].slice(0, 5) : [];
          return {
            pages: [...document.querySelectorAll(".pdf-page")].map((el) =>
              el.getAttribute("data-page-index"),
            ),
            spanCount: layer ? layer.querySelectorAll("span").length : 0,
            sample: spans.map((s) => ({
              text: (s.textContent || "").slice(0, 40),
              transform: getComputedStyle(s).transform,
            })),
          };
        }, pageIndex);
        console.error("  debug:", JSON.stringify(dbg, null, 2));
        continue;
      }
      if (!path.vertical) {
        fail(`${rotation}°: text is not visually vertical`);
        const dbg = await page.evaluate(
          ({ needle, pageIndex }) => {
            const pageEl = [...document.querySelectorAll(".pdf-page")].find(
              (el) => el.getAttribute("data-page-index") === String(pageIndex),
            );
            const layer = pageEl?.querySelector(".textLayer");
            const span =
              layer &&
              [...layer.querySelectorAll("span")].find((el) =>
                el.textContent?.includes(needle),
              );
            const pageStyle = pageEl ? getComputedStyle(pageEl) : null;
            const spanStyle = span ? getComputedStyle(span) : null;
            const r = span?.getBoundingClientRect();
            const canvas = pageEl?.querySelector("canvas");
            return {
              pageTransform: pageStyle?.transform,
              pageRotate: pageEl?.getAttribute("data-rotation") || pageEl?.dataset.rotate,
              pageW: pageEl?.getBoundingClientRect().width,
              pageH: pageEl?.getBoundingClientRect().height,
              canvasW: canvas?.getBoundingClientRect().width,
              canvasH: canvas?.getBoundingClientRect().height,
              spanTransform: spanStyle?.transform,
              spanWritingMode: spanStyle?.writingMode,
              spanRect: r && { w: r.width, h: r.height, left: r.left, top: r.top },
              layerTransform: layer ? getComputedStyle(layer).transform : null,
            };
          },
          { needle, pageIndex },
        );
        console.error("  debug:", JSON.stringify(dbg, null, 2));
        continue;
      }

      // Real vertical mouse drag along the visible baseline.
      await page.mouse.move(path.startPoint.x, path.startPoint.y);
      await page.mouse.down();
      await page.mouse.move(path.endPoint.x, path.endPoint.y, { steps: 30 });
      await page.mouse.up();

      await page
        .locator(".ito-selection-live-preview")
        .first()
        .waitFor({ state: "visible", timeout: 5000 })
        .catch(() => {});

      const measured = await page.evaluate(() => {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
        const range = selection.getRangeAt(0);
        const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
        const union = (items) => ({
          left: Math.min(...items.map((r) => r.left)),
          top: Math.min(...items.map((r) => r.top)),
          right: Math.max(...items.map((r) => r.right)),
          bottom: Math.max(...items.map((r) => r.bottom)),
        });
        const preview = [...document.querySelectorAll(".ito-selection-live-preview")]
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 0 && r.height > 0);
        return {
          text: selection.toString().trim(),
          rangeBox: union(rects),
          previewBox: preview.length ? union(preview) : null,
        };
      });

      console.log(
        `  [${rotation}°] drag start=(${path.startPoint.x.toFixed(0)},${path.startPoint.y.toFixed(0)}) ` +
          `end=(${path.endPoint.x.toFixed(0)},${path.endPoint.y.toFixed(0)}) ` +
          `target=[${path.target.left.toFixed(0)},${path.target.top.toFixed(0)},` +
          `${path.target.right.toFixed(0)},${path.target.bottom.toFixed(0)}]`,
      );
      if (!measured) {
        const sel = await page.evaluate(() => {
          const s = window.getSelection();
          return {
            text: s?.toString() ?? "",
            collapsed: s?.isCollapsed ?? true,
            ranges: s?.rangeCount ?? 0,
          };
        });
        fail(`${rotation}°: no non-collapsed selection produced — ${JSON.stringify(sel)}`);
        continue;
      }

      // 1. Text match (necessary but NOT sufficient).
      if (measured.text === needle) {
        console.log(`✓ ${rotation}°: selected text matches "${needle}"`);
      } else {
        fail(`${rotation}°: selected text "${measured.text}" !== "${needle}"`);
      }

      // 2. Selection is visually vertical.
      const rb = measured.rangeBox;
      if (rb.bottom - rb.top > (rb.right - rb.left) * 5) {
        console.log(`✓ ${rotation}°: Range geometry is vertical`);
      } else {
        fail(`${rotation}°: Range geometry is not vertical`);
      }

      // 3. Native Range geometry overlaps the visible glyph box.
      let geomOk = true;
      for (const key of ["left", "top", "right", "bottom"]) {
        const d = Math.abs(rb[key] - path.target[key]);
        if (d > GEOM_TOLERANCE) {
          geomOk = false;
          fail(`${rotation}°: Range ${key} off by ${d.toFixed(1)}px (> ${GEOM_TOLERANCE})`);
        }
      }
      if (geomOk)
        console.log(`✓ ${rotation}°: Range box aligns with visible glyphs (≤${GEOM_TOLERANCE}px)`);

      // 4. Ito live preview mirrors the native selection geometry.
      if (!measured.previewBox) {
        fail(`${rotation}°: no live preview rendered`);
      } else {
        let prevOk = true;
        for (const key of ["left", "top", "right", "bottom"]) {
          const d = Math.abs(measured.previewBox[key] - rb[key]);
          if (d > PREVIEW_TOLERANCE) {
            prevOk = false;
            fail(`${rotation}°: preview ${key} off by ${d.toFixed(1)}px (> ${PREVIEW_TOLERANCE})`);
          }
        }
        if (prevOk)
          console.log(
            `✓ ${rotation}°: live preview mirrors Range geometry (≤${PREVIEW_TOLERANCE}px)`,
          );
      }

      if (rotation === 90) {
        await page.screenshot({ path: SHOT });
        console.log(`• screenshot saved: ${SHOT}`);
      }

      await page.evaluate(() => window.getSelection()?.removeAllRanges());
    }
  } finally {
    await browser.close();
  }

  if (process.exitCode === 1) {
    console.error("\nPROBE RESULT: FAIL");
  } else {
    console.log("\nPROBE RESULT: PASS");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
