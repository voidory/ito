import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const TARGET_URL = process.env.TARGET_URL || 'http://127.0.0.1:5173';
const OUT_DIR = process.env.OUT_DIR || '/projects/sandbox/.kiro/artifacts/screenshots';
// The sandbox-resident chromium headless-shell binary. The default fallback is
// the REAL on-disk path (note the `chrome-headless-shell-linux64` segment that
// earlier revisions dropped); override it with PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.
const EXECUTABLE_PATH =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
  '/inner_container/opt/playwright/chromium_headless_shell-1232/chrome-headless-shell-linux64/chrome-headless-shell';

// The viewport widths captured in a SINGLE pass (FEAT-002 step 7).
const WIDTHS = [1024, 1280, 1440];
const VIEWPORT_HEIGHT = 900;

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
      readerToolbar: rectOf(document.querySelector('[data-testid="reader-toolbar"]')),
      selectionToolbar: rectOf(document.querySelector('[data-testid="selection-toolbar"]')),
      annotationSidebar: rectOf(document.querySelector('[data-testid="highlights-tab"]')),
      highlightPopover: rectOf(document.querySelector('[data-testid="highlight-edit-popover"]')),
      commentSurface: rectOf(document.querySelector('[data-testid="comment-surface"]')),
      contextMenu: rectOf(document.querySelector('[data-testid="reader-context-menu"]')),
      testIds,
    };
  }, viewName);
}

/** Open the first document in the Library and wait for a page stage to appear. */
async function openFirstDocument(page) {
  const docEntry = page
    .locator('text=/Sample Document|Rotated Fixture|Multi-Column Fixture/i')
    .first();
  if (await docEntry.count()) {
    await docEntry.click();
  } else {
    const firstOpen = page.locator('[data-testid="library-open"]').first();
    if (await firstOpen.count()) {
      await firstOpen.click();
    } else {
      const firstCheckbox = page.locator('input[type="checkbox"]').first();
      if (await firstCheckbox.count()) {
        await firstCheckbox.check();
        const openBtn = page.locator('button:has-text("Open together")');
        if (await openBtn.count()) await openBtn.click();
      }
    }
  }
  await page
    .waitForSelector('.pdf-page-stage, [data-testid="pdf-page-stage"]', { timeout: 10000 })
    .catch(() => {});
  await page.waitForTimeout(800);
}

/** Capture library / reader / reader-with-popover / nodes for one viewport width. */
async function captureWidth(browser, width, report) {
  const context = await browser.newContext({
    viewport: { width, height: VIEWPORT_HEIGHT },
  });
  const page = await context.newPage();
  const consoleLogs = [];
  const pageErrors = [];
  page.on('console', (msg) => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  const views = {};
  try {
    // 1. LIBRARY --------------------------------------------------------------
    await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT_DIR, `library-live-${width}.png`), fullPage: true });
    views.library = await captureDomMetrics(page, 'library');

    // 2. READER ---------------------------------------------------------------
    await openFirstDocument(page);

    // Open the annotations sidebar so the panels-open state is captured.
    const sidebarToggle = page.locator('[data-testid="toggle-highlights-tab"]').first();
    if (await sidebarToggle.count()) {
      await sidebarToggle.click();
      await page.waitForTimeout(150);
    }
    await page.screenshot({ path: path.join(OUT_DIR, `reader-live-${width}.png`), fullPage: false });
    views.reader = await captureDomMetrics(page, 'reader');

    // 3. READER WITH POPOVER --------------------------------------------------
    // Click an existing highlight to open the annotation popover; fall back to a
    // right-click on the stage for the page context menu.
    const highlightFrag = page.locator('.ito-highlight-fragment, .ito-highlight').first();
    if (await highlightFrag.count()) {
      const box = await highlightFrag.boundingBox();
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(300);
      }
    } else {
      const stage = page.locator('.pdf-page-stage, [data-testid="pdf-page-stage"]').first();
      if (await stage.count()) {
        const box = await stage.boundingBox();
        if (box) {
          await page.mouse.click(box.x + 120, box.y + 120, { button: 'right' });
          await page.waitForTimeout(300);
        }
      }
    }
    await page.screenshot({
      path: path.join(OUT_DIR, `reader-with-popover-live-${width}.png`),
      fullPage: false,
    });
    views.readerWithPopover = await captureDomMetrics(page, 'reader-with-popover');

    // 4. NODES ----------------------------------------------------------------
    const nodesTab = page
      .locator('button:has-text("Nodes"), [role="tab"]:has-text("Nodes")')
      .first();
    if (await nodesTab.count()) {
      await nodesTab.click();
      await page.waitForTimeout(600);
    }
    await page.screenshot({ path: path.join(OUT_DIR, `nodes-live-${width}.png`), fullPage: false });
    views.nodes = await captureDomMetrics(page, 'nodes');
  } finally {
    report.widths[String(width)] = { views, consoleLogs, pageErrors };
    await context.close();
  }
}

(async () => {
  if (!existsSync(EXECUTABLE_PATH)) {
    console.error(
      `[local-shot] Chromium headless-shell binary not found at:\n  ${EXECUTABLE_PATH}\n` +
        `Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to the correct path and retry.`,
    );
    process.exit(1);
  }

  await fs.mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    executablePath: EXECUTABLE_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  const report = { url: TARGET_URL, widths: {} };

  try {
    for (const width of WIDTHS) {
      await captureWidth(browser, width, report);
    }
    const reportPath = path.join(OUT_DIR, 'ui-verification-report.json');
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(
      `Captured library/reader/reader-with-popover/nodes at widths ${WIDTHS.join(', ')} ` +
        `(library-live-<w>.png, reader-live-<w>.png, reader-with-popover-live-<w>.png, ` +
        `nodes-live-<w>.png) & ${reportPath}`,
    );
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
