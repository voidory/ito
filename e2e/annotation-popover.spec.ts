import { expect, test } from "@playwright/test";
import { clickCenter } from "./helpers";

/** The comment popover stays attached to its highlight and inside the viewport. */
test("the comment popover follows its highlight while scrolling and never leaves the viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto("/");
  await expect(page.getByTestId("library-item").first()).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => !!window.__ito);
  await page.getByTestId("library-open").filter({ hasText: /Sample Document/ }).click();
  await expect(page.locator(".textLayer span").first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(500);

  await page.evaluate((n) => window.__ito.selectText(n, 0), "quick brown fox");
  await page.getByTestId("commit-highlight").click();
  await clickCenter(page, page.locator(".ito-highlight-fragment").first());
  const popover = page.getByTestId("highlight-edit-popover");
  await expect(popover).toBeVisible();

  const frag = page.locator(".ito-highlight-fragment").first();
  const gap = async () => {
    const f = (await frag.boundingBox())!;
    const p = (await popover.boundingBox())!;
    return { fragBottom: f.y + f.height, popTop: p.y, popBottom: p.y + p.height };
  };
  const before = await gap();
  expect(before.popBottom).toBeLessThanOrEqual(600);

  await page.getByTestId("pane-scroll").evaluate((el) => (el.scrollTop += 150));
  await expect
    .poll(async () => {
      const g = await gap();
      // Still hugging the highlight (just below it), not left behind.
      return Math.abs(g.popTop - (g.fragBottom + 8));
    })
    .toBeLessThan(4);

  const vp = page.viewportSize()!;
  const box = (await popover.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
});
