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
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error("clickCenter: target has no bounding box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
