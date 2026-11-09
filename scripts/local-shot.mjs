import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const TARGET_URL = process.env.TARGET_URL || 'http://127.0.0.1:5173';
const OUT_DIR = process.env.OUT_DIR || '/projects/sandbox/.kiro/artifacts/screenshots';
const EXECUTABLE_PATH =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
  '/inner_container/opt/playwright/chromium_headless_shell-1232/chrome-headless-shell/chrome-headless-shell';

async function captureDomMetrics(page, viewName) {
  return await page.evaluate((view) => {
    const rectOf = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
        position: s.position,
        zIndex: s.zIndex,
        clippedHorizontally: r.left < 0 || r.right > window.innerWidth,
        clippedVertically: r.top < 0 || r.bottom > window.innerHeight,
      };
    };

    const testIds = Array.from(document.querySelectorAll('[data-testid]')).map((el) => ({
      testId: el.getAttribute('data-testid'),
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').trim().slice(0, 60),
      rect: rectOf(el),
    }));

    return {
      view,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      selectionToolbar: rectOf(document.querySelector('[data-testid="selection-toolbar"]')),
      commentSurface: rectOf(document.querySelector('[data-testid="comment-surface"]')),
      contextMenu: rectOf(document.querySelector('[data-testid="reader-context-menu"]')),
      testIds,
    };
  }, viewName);
}

(async () => {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const consoleLogs = [];
  const pageErrors = [];

  const browser = await chromium.launch({
    executablePath: EXECUTABLE_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  page.on('console', (msg) => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  const report = { url: TARGET_URL, views: {}, consoleLogs, pageErrors };

  try {
    // =========================================================================
    // 1. LIBRARY VIEW (FEAT-001: + Import PDF, Dropzone, Subjects Launcher)
    // =========================================================================
    await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT_DIR, 'library-live.png'), fullPage: true });
    report.views.library = await captureDomMetrics(page, 'library');

    // =========================================================================
    // 2. READER VIEW (FEAT-002: PDF Stage, Zoom, Area Cropper, Highlight Popover)
    // =========================================================================
    const docEntry = page.locator('text=/Sample Document|Rotated Fixture|Multi-Column Fixture/i').first();
    if (await docEntry.count()) {
      await docEntry.click();
    } else {
      const firstCheckbox = page.locator('input[type="checkbox"]').first();
      if (await firstCheckbox.count()) {
        await firstCheckbox.check();
        const openBtn = page.locator('button:has-text("Open together")');
        if (await openBtn.count()) await openBtn.click();
      }
    }

    await page.waitForSelector('.pdf-page-stage, [data-testid="pdf-page-stage"]', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(800);

    // Trigger 1-click highlight popover if a highlight exists, else right-click stage
    const highlightFrag = page.locator('.ito-highlight-fragment').first();
    if (await highlightFrag.count()) {
      const box = await highlightFrag.boundingBox();
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(250);
      }
    } else {
      const stage = page.locator('.pdf-page-stage, [data-testid="pdf-page-stage"]').first();
      if (await stage.count()) {
        const box = await stage.boundingBox();
        if (box) {
          await page.mouse.click(box.x + 120, box.y + 120, { button: 'right' });
          await page.waitForTimeout(250);
        }
      }
    }

    await page.screenshot({ path: path.join(OUT_DIR, 'reader-live.png'), fullPage: false });
    report.views.reader = await captureDomMetrics(page, 'reader');

    // =========================================================================
    // 3. NODES VIEW (FEAT-003: + Subject, + Category, Connect Nodes Toolbar)
    // =========================================================================
    const nodesTab = page.locator('button:has-text("Nodes"), [role="tab"]:has-text("Nodes")').first();
    if (await nodesTab.count()) {
      await nodesTab.click();
      await page.waitForTimeout(600);
    }

    await page.screenshot({ path: path.join(OUT_DIR, 'nodes-live.png'), fullPage: false });
    report.views.nodes = await captureDomMetrics(page, 'nodes');

    const reportPath = path.join(OUT_DIR, 'ui-verification-report.json');
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(`Captured library-live.png, reader-live.png, nodes-live.png & ${reportPath}`);
  } finally {
    await browser.close();
  }
})();
