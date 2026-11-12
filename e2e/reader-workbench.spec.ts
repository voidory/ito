import { expect, test, type Page } from "@playwright/test";
import { clickCenter } from "./helpers";

/**
 * M1 READING WORKBENCH — runtime validation in real chromium (spec section 24,
 * FEAT-003). Every test drives the REAL app: real pdf.js text layers, real text
 * selection, real Workbench state + IndexedDB persistence. Nothing is mocked.
 *
 * Coverage (briefing numbering): R01 selection controls only, R02 quiet
 * comments reveal/dismiss, R03 range annotation identity, R04 micro-highlights
 * independent, R05 dotted association no page edit, R07 independent per-subject
 * state, R09/R20 soft rounded commit overlay, R11 reduced-motion, R12 failed
 * save retains draft, R14 annotations persist, R15 accessible association path,
 * R16/R17 range border + pp. label, R18 closed tab zero width.
 */

async function bootLibrary(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("app-status")).toHaveAttribute("data-state", "ready", {
    timeout: 15_000,
  });
  // The library seeds two fixtures on first run.
  await expect(page.getByTestId("library")).toBeVisible();
  await expect(page.getByTestId("library-item").first()).toBeVisible({ timeout: 15_000 });
}

async function openFirstDocument(page: Page, titleMatch?: RegExp): Promise<void> {
  await bootLibrary(page);
  if (titleMatch) {
    await page.getByTestId("library-open").filter({ hasText: titleMatch }).first().click();
  } else {
    await page.getByTestId("library-open").first().click();
  }
  await expect(page.getByTestId("reader")).toBeVisible();
  // Wait until the first pane has rendered its pdf.js pages.
  await expect(page.getByTestId("source-pane").first()).toHaveAttribute(
    "data-ready",
    "true",
    { timeout: 20_000 },
  );
  await expect(page.locator(".textLayer span").first()).toBeVisible({ timeout: 20_000 });
}

/** The fixture contains "quick brown fox" on each page. */
const NEEDLE = "quick brown fox";

test("library is the default view and lists imported PDFs in one flat table", async ({ page }) => {
  await bootLibrary(page);
  await expect(page.getByTestId("library")).toHaveAttribute("data-view", "library");
  await expect(page.getByTestId("library-table")).toBeVisible();
  await expect(page.getByTestId("library-category")).toHaveCount(0);
  // Two real fixtures imported.
  expect(await page.getByTestId("library-item").count()).toBeGreaterThanOrEqual(2);
});

test("'open together' opens a shared workspace with no auto-analysis", async ({ page }) => {
  await bootLibrary(page);
  const items = page.getByTestId("library-item");
  await items.nth(0).getByRole("checkbox").check();
  await items.nth(1).getByRole("checkbox").check();
  await page.getByTestId("open-together").click();
  await expect(page.getByTestId("reader")).toBeVisible();
  await expect(page.getByTestId("open-together-indicator")).toBeVisible();
  // No analysis: zero pages/relationships/categories created.
  const counts = await page.evaluate(() => window.__ito.graphRecordCount());
  expect(counts).toEqual({ pages: 0, relationships: 0, categories: 0 });
});

test("R18: closed highlights tab reserves zero width; opening adds the sidebar", async ({
  page,
}) => {
  await openFirstDocument(page);
  await expect(page.getByTestId("reader-body")).toHaveAttribute("data-tab-open", "false");
  // Closed: the sidebar element is not in the DOM at all (zero reserved width).
  await expect(page.getByTestId("highlights-tab")).toHaveCount(0);
  await page.getByTestId("toggle-highlights-tab").click();
  await expect(page.getByTestId("reader-body")).toHaveAttribute("data-tab-open", "true");
  await expect(page.getByTestId("highlights-tab")).toBeVisible();
});

test("R01 + R09 + R20: selecting real text shows ONLY compact controls and commits a soft rounded overlay", async ({
  page,
}) => {
  await openFirstDocument(page);

  // Select real text in the live pdf.js text layer.
  const selected = await page.evaluate((n) => window.__ito.selectText(n, 0), NEEDLE);
  expect(selected).toBe(true);

  const toolbar = page.getByTestId("selection-toolbar");
  await expect(toolbar).toBeVisible();
  // R01: ONLY highlight/underline + color controls. No comment editor, node
  // picker, category selector, or subject page is present in the toolbar.
  await expect(page.getByTestId("commit-highlight")).toBeVisible();
  await expect(page.getByTestId("color-controls")).toBeVisible();
  await expect(toolbar.getByTestId("comment-input")).toHaveCount(0);
  await expect(toolbar.getByTestId("subject-picker")).toHaveCount(0);

  await page.getByTestId("commit-highlight").click();

  // R09/R20: a highlight overlay appears, drawn as per-line fragment boxes with
  // uneven rounded corners (not one big bubble), and the glyph spans remain.
  const overlay = page.locator(".ito-highlight").first();
  await expect(overlay).toBeVisible();
  const fragCount = await page.locator(".ito-highlight-fragment").count();
  expect(fragCount).toBeGreaterThan(0);
  const radius = await page
    .locator(".ito-highlight-fragment")
    .first()
    .evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
  expect(radius).not.toBe("0px");
  // Text layer glyphs still present and legible (not replaced by the overlay).
  await expect(page.locator(".textLayer span").first()).toBeVisible();

  // R01 invariant: no graph content was created by highlighting.
  const counts = await page.evaluate(() => window.__ito.counts());
  expect(counts.annotations).toBe(1);
  expect(counts.pages).toBe(0);
  expect(counts.relationships).toBe(0);
  expect(counts.categories).toBe(0);
});

test("R11: OS prefers-reduced-motion suppresses the commit animation but keeps the overlay", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openFirstDocument(page);
  await page.evaluate((n) => window.__ito.selectText(n, 0), NEEDLE);
  await page.getByTestId("commit-highlight").click();
  const frag = page.locator(".ito-highlight-fragment").first();
  await expect(frag).toBeVisible();
  // State feedback preserved: the overlay exists and is NOT mid-animation.
  await expect(frag).toHaveAttribute("data-animated", "false");
});

test("reader overflow menu escapes the toolbar scroll container", async ({ page }) => {
  await openFirstDocument(page);

  const toolbar = page.getByTestId("reader-toolbar");
  const button = page.getByTestId("pane-overflow-menu-btn");
  await button.click();

  const menu = page.getByTestId("pane-overflow-menu");
  await expect(menu).toBeVisible();

  const geometry = await page.evaluate(() => {
    const toolbar = document.querySelector<HTMLElement>('[data-testid="reader-toolbar"]');
    const menu = document.querySelector<HTMLElement>('[data-testid="pane-overflow-menu"]');
    const layer = document.querySelector<HTMLElement>('[data-testid="ito-popover-layer"]');
    if (!toolbar || !menu || !layer) return null;
    const toolbarRect = toolbar.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    return {
      toolbar: { top: toolbarRect.top, bottom: toolbarRect.bottom, height: toolbarRect.height },
      menu: { top: menuRect.top, bottom: menuRect.bottom, left: menuRect.left, right: menuRect.right },
      layerPosition: getComputedStyle(layer).position,
      menuParent: menu.parentElement?.parentElement?.tagName,
      menuWithinToolbar: toolbar.contains(menu),
    };
  });

  expect(geometry).not.toBeNull();
  expect(geometry!.menuWithinToolbar).toBe(false);
  expect(geometry!.layerPosition).toBe("fixed");
  expect(geometry!.menu.top).toBeGreaterThanOrEqual(geometry!.toolbar.bottom);
  expect(geometry!.menu.left).toBeGreaterThanOrEqual(0);
  expect(geometry!.menu.right).toBeLessThanOrEqual(page.viewportSize()!.width);

  // A wheel gesture over the reader must not vertically scroll the toolbar.
  const toolbarBefore = await toolbar.evaluate((el) => el.scrollTop);
  // The wheel must be over the reader's scrollable pane (the toolbar itself no
  // longer scrolls), so the pane scrolls and the open menu dismisses.
  const pane = await page.getByTestId("pane-scroll").first().boundingBox();
  expect(pane).not.toBeNull();
  await page.mouse.move(pane!.x + pane!.width / 2, pane!.y + pane!.height / 2);
  await page.mouse.wheel(0, 500);
  await expect.poll(() => toolbar.evaluate((el) => el.scrollTop)).toBe(toolbarBefore);
  await expect(menu).toBeHidden();
});

test("R11: the in-app suppress-motion setting also removes the animation", async ({
  page,
}) => {
  // OS motion preference left at default; use the in-app toggle instead. The
  // suppress-motion control now lives in the reader toolbar's overflow menu
  // (M9 single-toolbar rework).
  await openFirstDocument(page);
  await page.getByTestId("pane-overflow-menu-btn").click();
  await page.getByTestId("overflow-suppress-motion").click();
  await page.evaluate((n) => window.__ito.selectText(n, 0), NEEDLE);
  await page.getByTestId("commit-highlight").click();
  const frag = page.locator(".ito-highlight-fragment").first();
  await expect(frag).toBeVisible();
  await expect(frag).toHaveAttribute("data-animated", "false");
});

test("R02: a highlight saves quiet; comment is hidden until explicit reveal, then dismisses", async ({
  page,
}) => {
  await openFirstDocument(page);
  await page.evaluate((n) => window.__ito.selectText(n, 0), NEEDLE);
  await page.getByTestId("commit-highlight").click();
  await expect(page.locator(".ito-highlight").first()).toBeVisible();

  // Quiet by default: no comment surface in normal reading.
  await expect(page.getByTestId("comment-surface")).toHaveCount(0);

  // Explicit reveal: click the annotation overlay.
  await clickCenter(page, page.locator(".ito-highlight-fragment").first());
  const surface = page.getByTestId("comment-surface");
  await expect(surface).toBeVisible();
  const commentInput = page.getByTestId("comment-input");
  const originalViewport = page.viewportSize() ?? { width: 1280, height: 720 };

  for (const width of [originalViewport.width, 320]) {
    await page.setViewportSize({ width, height: originalViewport.height });
    const measureLayout = (): Promise<{
      fitsWithinPopover: boolean;
      fitsWithinViewport: boolean;
      boxSizing: string;
      maxWidth: string;
    } | null> =>
      page.evaluate(() => {
      const popover = document.querySelector<HTMLElement>('[data-testid="highlight-edit-popover"]');
      const textarea = document.querySelector<HTMLTextAreaElement>('[data-testid="comment-input"]');
      if (!popover || !textarea) return null;
      const popoverRect = popover.getBoundingClientRect();
      const textareaRect = textarea.getBoundingClientRect();
      const popoverStyle = getComputedStyle(popover);
      const textareaStyle = getComputedStyle(textarea);
      const innerLeft = popoverRect.left +
        Number.parseFloat(popoverStyle.borderLeftWidth) +
        Number.parseFloat(popoverStyle.paddingLeft);
      const innerRight = popoverRect.right -
        Number.parseFloat(popoverStyle.borderRightWidth) -
        Number.parseFloat(popoverStyle.paddingRight);
      return {
        fitsWithinPopover: textareaRect.left >= innerLeft - 0.5 && textareaRect.right <= innerRight + 0.5,
        fitsWithinViewport: popoverRect.left >= 0 && popoverRect.right <= window.innerWidth,
        boxSizing: textareaStyle.boxSizing,
        maxWidth: textareaStyle.maxWidth,
      };
    });
    // The popover re-clamps to the viewport after the resize event is handled,
    // so wait for the layout to settle instead of measuring in the same tick.
    await expect.poll(async () => (await measureLayout())?.fitsWithinViewport).toBe(true);
    const layout = await measureLayout();
    expect(layout?.fitsWithinPopover).toBe(true);
    expect(layout?.fitsWithinViewport).toBe(true);
    expect(layout?.boxSizing).toBe("border-box");
    expect(layout?.maxWidth).toBe("100%");
  }

  await page.setViewportSize(originalViewport);
  await commentInput.fill("a quiet thought");
  await page.getByTestId("comment-save").click();
  // Returns toward the passage, leaving no persistent obstruction.
  await expect(surface).toHaveCount(0);

  // Reopen round-trip: the comment persists and re-reveals.
  await clickCenter(page, page.locator(".ito-highlight-fragment").first());
  await expect(page.getByTestId("comment-input")).toHaveValue("a quiet thought");
  await page.getByTestId("comment-cancel").click();
  await expect(page.getByTestId("comment-surface")).toHaveCount(0);
});

test("R03 + R04 + R16 + R17: a 3-page range annotation is one identity with borders + pp. label; micro-highlights stay independent", async ({
  page,
}) => {
  await openFirstDocument(page, /3 pages/);

  // Create a continuous 3-page range via the visible start/end selector.
  await page.getByTestId("start-range").click();
  await expect(page.getByTestId("range-selector")).toBeVisible();
  // Select by VALUE (page index), not label — label "2" would be page index 1.
  await page.getByTestId("range-start").selectOption({ value: "0" });
  await page.getByTestId("range-end").selectOption({ value: "2" });
  await page.getByTestId("commit-range").click();

  // R16: each included page carries a highlight BORDER (not a tint wash).
  await expect(page.locator('.ito-highlight[data-page-border="true"]')).toHaveCount(3);
  const border = page.locator(".ito-highlight-border").first();
  await expect(border).toBeVisible();

  // Also add a micro-highlight inside the range. Scroll page 2 into view first:
  // selectText drives the real mouseup but cannot scroll, and the selection
  // popup anchors to the (otherwise off-screen) selection.
  await page.evaluate(() =>
    document
      .querySelector('.pdf-page[data-page-index="1"]')
      ?.scrollIntoView({ block: "start" }),
  );
  // Retry until page 2's text layer is rendered and the selection takes.
  await expect
    .poll(() => page.evaluate((n) => window.__ito.selectText(n, 1), NEEDLE))
    .toBe(true);
  await page.getByTestId("commit-highlight").click();

  // R03/R04: one range identity + one independent micro-highlight = 2 records.
  expect(await page.evaluate(() => window.__ito.annotationCount())).toBe(2);

  // R17: both annotations list in the annotations-only sidebar; the range card
  // carries a "pp. 1-3" badge. The text search isolates each by its quote.
  await page.getByTestId("toggle-highlights-tab").click();
  await expect(page.getByTestId("highlight-row")).toHaveCount(2);
  await expect(page.getByTestId("range-badge").first()).toBeVisible();

  // Search for the range label -> only the range card remains.
  await page.getByTestId("annotation-search").fill("pp. 1-3");
  await expect(page.getByTestId("highlight-row")).toHaveCount(1);
  await expect(page.getByTestId("range-badge").first()).toBeVisible();

  // Search for the micro-highlight needle -> only the micro card remains.
  await page.getByTestId("annotation-search").fill(NEEDLE);
  await expect(page.getByTestId("highlight-row")).toHaveCount(1);
  await expect(page.getByTestId("range-badge")).toHaveCount(0);
  await page.getByTestId("annotation-search").fill("");

  // Opening the range reveals the shared comment surface with the pp. label.
  await clickCenter(page, page.locator(".ito-highlight-border").first());
  await expect(page.getByTestId("range-label")).toHaveText("pp. 1-3");
});

test("R05 + R15: accessible (non right-click) path creates a DOTTED association without editing the page", async ({
  page,
}) => {
  await openFirstDocument(page);
  const subjectId = await page.evaluate(() => window.__ito.createSubject("Thermodynamics"));

  await page.evaluate((n) => window.__ito.selectText(n, 0), NEEDLE);
  await page.getByTestId("commit-highlight").click();

  // Open the highlights tab and use the ACCESSIBLE menu-button (R15), not a
  // right-click. (menu-button has aria-haspopup="menu".)
  await page.getByTestId("toggle-highlights-tab").click();
  await page.getByTestId("row-actions").first().click();
  await page.getByTestId("menu-associate").click();
  await page.getByTestId("subject-search").fill("Thermo");
  await page.getByTestId("subject-option").first().click();

  // Derived status is TENTATIVE (dotted), page composition unchanged (no evidence).
  const annId = await page.evaluate(
    () => document.querySelector('[data-testid="highlight-row"]')?.getAttribute("data-annotation-id") ?? "",
  );
  const status = await page.evaluate(
    ([a, p]) => window.__ito.referenceStatus(a, p),
    [annId, subjectId] as const,
  );
  expect(status).toBe("tentative");
  const counts = await page.evaluate(() => window.__ito.counts());
  expect(counts.associations).toBe(1);
  expect(counts.evidence).toBe(0);
  // Source annotation is NOT moved or deleted.
  expect(counts.annotations).toBe(1);
});

test("R07: the same annotation is solid for one subject and tentative for another", async ({
  page,
}) => {
  await openFirstDocument(page);
  const first = await page.evaluate(() => window.__ito.createSubject("First subject"));
  const second = await page.evaluate(() => window.__ito.createSubject("Second subject"));

  await page.evaluate((n) => window.__ito.selectText(n, 0), NEEDLE);
  await page.getByTestId("commit-highlight").click();
  await page.getByTestId("toggle-highlights-tab").click();

  const annId = await page.evaluate(
    () => document.querySelector('[data-testid="highlight-row"]')?.getAttribute("data-annotation-id") ?? "",
  );

  // Insert evidence into the first subject (solid), associate the second (dotted).
  await page.getByTestId("row-actions").first().click();
  await page.getByTestId("menu-insert").click();
  await page.getByTestId("subject-search").fill("First");
  await page.getByTestId("subject-option").first().click();

  await page.getByTestId("row-actions").first().click();
  await page.getByTestId("menu-associate").click();
  await page.getByTestId("subject-search").fill("Second");
  await page.getByTestId("subject-option").first().click();

  const firstStatus = await page.evaluate(
    ([a, p]) => window.__ito.referenceStatus(a, p),
    [annId, first] as const,
  );
  const secondStatus = await page.evaluate(
    ([a, p]) => window.__ito.referenceStatus(a, p),
    [annId, second] as const,
  );
  expect(firstStatus).toBe("cited");
  expect(secondStatus).toBe("tentative");
});

test("R12: a failed local save retains the draft and shows an actionable error", async ({
  page,
}) => {
  await openFirstDocument(page);
  await page.evaluate((n) => window.__ito.selectText(n, 0), NEEDLE);
  await page.getByTestId("commit-highlight").click();
  await clickCenter(page, page.locator(".ito-highlight-fragment").first());

  // Force the next persist to fail, then try to save the comment.
  await page.evaluate(() => window.__ito.forceNextSaveFailures(1));
  await page.getByTestId("comment-input").fill("thought that fails to save");
  await page.getByTestId("comment-save").click();

  // Actionable error is shown; the surface stays open; the draft is retained
  // (never faked as saved).
  await expect(page.getByTestId("comment-error")).toBeVisible();
  await expect(page.getByTestId("comment-input")).toHaveValue("thought that fails to save");
  await expect(page.getByTestId("comment-surface")).toBeVisible();
});

test("R14: annotations + comments persist across close and reopen", async ({ page }) => {
  await openFirstDocument(page);
  await page.evaluate((n) => window.__ito.selectText(n, 0), NEEDLE);
  await page.getByTestId("commit-highlight").click();
  await clickCenter(page, page.locator(".ito-highlight-fragment").first());
  await page.getByTestId("comment-input").fill("persist me");
  await page.getByTestId("comment-save").click();
  // The surface closes ONLY after the save+persist resolves, so waiting for it
  // to disappear guarantees the write landed before we reload.
  await expect(page.getByTestId("comment-surface")).toHaveCount(0);

  // Reload the whole app (a reload keeps the same origin IndexedDB) and reopen.
  await page.reload();
  await expect(page.getByTestId("app-status")).toHaveAttribute("data-state", "ready", {
    timeout: 15_000,
  });
  await page.getByTestId("library-open").first().click();
  await expect(page.getByTestId("source-pane").first()).toHaveAttribute("data-ready", "true", {
    timeout: 20_000,
  });
  // The annotation restored and its comment re-reveals.
  await expect(page.locator(".ito-highlight-fragment").first()).toBeVisible({ timeout: 20_000 });
  const diag = await page.evaluate(() => window.__ito.counts());
  expect(diag.annotations, JSON.stringify(diag)).toBe(1);
  await clickCenter(page, page.locator(".ito-highlight-fragment").first());
  await expect(page.getByTestId("comment-input")).toHaveValue("persist me");
});
