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

  // The popover anchors to the union box of the highlight's drawn fragments
  // (clampFixedAnchor): 48px ABOVE the highlight when it has room (top > 64),
  // otherwise 12px BELOW its bottom. Highlight overlays are removed and redrawn
  // on refit, so a read can land in the gap; the poll below retries.
  const placement = () =>
    page.evaluate(() => {
      const frags = Array.from(
        document.querySelectorAll<HTMLElement>(".ito-highlight .ito-highlight-fragment"),
      ).map((el) => el.getBoundingClientRect());
      const pop = document
        .querySelector<HTMLElement>('[data-testid="highlight-edit-popover"]')
        ?.getBoundingClientRect();
      if (frags.length === 0 || !pop) return null;
      const top = Math.min(...frags.map((r) => r.top));
      const bottom = Math.max(...frags.map((r) => r.bottom));
      const expectedTop = top > 64 ? top - 48 : bottom + 12;
      return { off: Math.abs(pop.top - expectedTop), top, popBottom: pop.bottom };
    });
  const before = await placement();
  expect(before).not.toBeNull();
  expect(before!.popBottom).toBeLessThanOrEqual(600);

  const topBefore = before!.top;
  await page.getByTestId("pane-scroll").evaluate((el) => (el.scrollTop += 150));
  // The highlight really moved, and the popover re-anchored to it (not left behind).
  await expect.poll(async () => (await placement())?.top ?? topBefore).toBeLessThan(topBefore - 100);
  await expect.poll(async () => (await placement())?.off ?? Infinity).toBeLessThan(4);

  const vp = page.viewportSize()!;
  const box = (await popover.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
});
