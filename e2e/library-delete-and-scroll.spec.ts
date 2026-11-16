import { expect, test, type Page } from "@playwright/test";
import { seedSampleLibrary } from "./helpers";

/**
 * Library delete + fixed-viewport shell, validated in real chromium.
 *
 *  - Deleting a PDF asks first, then removes the row (and persists across a
 *    reload).
 *  - The DOCUMENT never scrolls in any view: the shell is exactly the viewport.
 *    Inner views (library list, reader pages) scroll within their own
 *    containers.
 */

async function boot(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("app-status")).toHaveAttribute("data-state", "ready", {
    timeout: 15_000,
  });
  // Automatic seeding was removed: load the sample workspace explicitly.
  await seedSampleLibrary(page);
}

async function documentOverflow(page: Page): Promise<{ v: number; h: number }> {
  return page.evaluate(() => ({
    v: document.documentElement.scrollHeight - window.innerHeight,
    h: document.documentElement.scrollWidth - window.innerWidth,
  }));
}

test("deleting a PDF asks for confirmation, then removes it for good", async ({ page }) => {
  await boot(page);
  const before = await page.getByTestId("library-item").count();
  expect(before).toBeGreaterThanOrEqual(2);

  const victim = page.getByTestId("library-item").first();
  const victimId = (await victim.getAttribute("data-source-id"))!;

  await victim.getByTestId("delete-source").click();
  await expect(page.getByTestId("delete-confirm")).toBeVisible();
  // Cancel leaves everything in place.
  await page.getByTestId("delete-cancel").click();
  await expect(page.getByTestId("delete-confirm")).toHaveCount(0);
  await expect(page.getByTestId("library-item")).toHaveCount(before);

  await page.locator(`[data-testid="delete-source"][data-source-id="${victimId}"]`).click();
  await page.getByTestId("delete-confirm-yes").click();
  await expect(page.getByTestId("library-item")).toHaveCount(before - 1);
  await expect(
    page.locator(`[data-testid="library-item"][data-source-id="${victimId}"]`),
  ).toHaveCount(0);
});

test("the document never scrolls in any view", async ({ page }) => {
  await boot(page);
  const views = ["view-files", "view-nodes", "view-history", "view-captures"] as const;
  for (const v of views) {
    await page.getByTestId(v).click();
    await page.waitForTimeout(150);
    expect(await documentOverflow(page), v).toEqual({ v: 0, h: 0 });
  }

  // Wheel over the Nodes canvas must not move the page either.
  await page.getByTestId("view-nodes").click();
  await page.getByTestId("nodes-canvas").hover();
  await page.mouse.wheel(0, 400);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  // Reader.
  await page.getByTestId("view-files").click();
  await page.getByTestId("library-open").first().click();
  await expect(page.getByTestId("source-pane").first()).toHaveAttribute("data-ready", "true", {
    timeout: 20_000,
  });
  expect(await documentOverflow(page)).toEqual({ v: 0, h: 0 });
  // The page stack scrolls inside its own container, not the document.
  const scroller = page.getByTestId("pane-scroll").first();
  await scroller.evaluate((el) => (el.scrollTop = 300));
  expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});
