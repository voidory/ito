import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Seed the sample workspace from the empty-library state.
 *
 * Automatic first-run fixture seeding was removed (the library now starts
 * genuinely empty with an explicit "Load Sample Workspace" CTA — see the M21
 * empty-state redesign). Specs that need documents in the library must seed
 * themselves. This helper is idempotent: it loads the sample workspace only
 * when the library is empty, then waits for the fixtures to appear, so it is
 * safe to call from any spec's boot sequence regardless of prior state.
 *
 * Assumes the page has already navigated (`goto("/")`) and the app is ready.
 */
export async function seedSampleLibrary(page: Page): Promise<void> {
  const loadSample = page.getByTestId("load-sample-workspace");
  const anyItem = page.getByTestId("library-item").first();
  // The app boots asynchronously: wait until EITHER the empty-state CTA or an
  // already-present library item has rendered, so this is robust whether or not
  // the caller pre-waited for app-status=ready and whether the library was
  // already seeded (e.g. a reload).
  await expect(loadSample.or(anyItem).first()).toBeVisible({ timeout: 20_000 });
  // Load the sample workspace only when the library is still empty.
  if (await loadSample.count()) {
    await loadSample.click();
  }
  await expect(anyItem).toBeVisible({ timeout: 20_000 });
}

/**
 * Click the visual centre of an element with a real mouse click.
 *
 * Highlight fragments / range borders are drawn UNDER the pdf.js `.textLayer`
 * (which must stay on top so text stays selectable), so Playwright's actionable
 * `locator.click()` correctly refuses: another element intercepts the pointer.
 * The app resolves clicks on annotations by coordinate hit-testing against the
 * page stage, so tests drive the same path: scroll the target into view, then
 * click at its on-screen centre.
 */
export async function clickCenter(page: Page, target: Locator): Promise<void> {
  // Overlays are redrawn (detached + recreated) on refit/zoom/sidebar changes,
  // so a single read can land in the gap. Re-resolve until a stable box exists.
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      await target.scrollIntoViewIfNeeded({ timeout: 1_000 });
      const box = await target.boundingBox();
      if (box && box.width > 0 && box.height > 0) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        return;
      }
    } catch {
      // detached mid-redraw: retry
    }
    if (Date.now() > deadline) throw new Error("clickCenter: target never had a bounding box");
    await page.waitForTimeout(100);
  }
}
