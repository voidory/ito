import type { Locator, Page } from "@playwright/test";

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
