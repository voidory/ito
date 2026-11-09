import { expect, test, type Page } from "@playwright/test";

/**
 * Drag-selection only reaches text the pointer actually crosses: a press in a
 * blank margin selects nothing, a drag past the end of a line or through the gap
 * between lines does not grab the neighbouring line, and dragging across words
 * selects exactly those words.
 */
async function openSample(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("library-item").first()).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("library-open").filter({ hasText: /Sample Document/ }).click();
  await expect(page.locator(".textLayer span").first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(600);
}

const selected = (page: Page): Promise<string> =>
  page.evaluate(() => window.getSelection()?.toString() ?? "");

/** Boxes of the text spans on the first page, one entry per visual line. */
async function lineBoxes(page: Page) {
  return page.evaluate(() => {
    const layer = document.querySelector(".textLayer")!;
    return [...layer.querySelectorAll("span")]
      .filter((s) => s.textContent && s.textContent.trim().length > 0)
      .map((s) => {
        const r = s.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, text: s.textContent! };
      });
  });
}

test("pressing in the blank page margin selects nothing", async ({ page }) => {
  await openSample(page);
  const lines = await lineBoxes(page);
  const first = lines[1]!; // a body line
  // Far left margin, on the same row as the line.
  await page.mouse.move(first.x - 60, first.y + first.h / 2);
  await page.mouse.down();
  await page.mouse.move(first.x - 20, first.y + first.h / 2, { steps: 5 });
  await page.mouse.up();
  expect(await selected(page)).toBe("");
});

test("dragging across words selects exactly the words crossed", async ({ page }) => {
  await openSample(page);
  const lines = await lineBoxes(page);
  const l = lines[1]!;
  await page.mouse.move(l.x + 2, l.y + l.h / 2);
  await page.mouse.down();
  await page.mouse.move(l.x + l.w * 0.5, l.y + l.h / 2, { steps: 10 });
  await page.mouse.up();
  const text = await selected(page);
  expect(text.length).toBeGreaterThan(5);
  // Only text from this one line, and not its whole content.
  expect(l.text.startsWith(text.trim()) || l.text.includes(text.trim())).toBe(true);
  expect(text.trim().length).toBeLessThan(l.text.length);
});

test("dragging off the end of a line or into the gap below does not grab the next line", async ({ page }) => {
  await openSample(page);
  const lines = await lineBoxes(page);
  const a = lines[1]!;
  const b = lines.find((x) => x.y > a.y + a.h + 4)!; // the next visual line
  await page.mouse.move(a.x + 2, a.y + a.h / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.w * 0.6, a.y + a.h / 2, { steps: 6 });
  // Past the right end of the line, then down into the gap between lines.
  await page.mouse.move(a.x + a.w + 80, a.y + a.h / 2, { steps: 4 });
  await page.mouse.move(a.x + a.w + 80, (a.y + a.h + b.y) / 2, { steps: 4 });
  await page.mouse.up();
  const text = await selected(page);
  expect(text).not.toContain(b.text.slice(0, 12));
  expect(text.trim().length).toBeGreaterThan(0);
});

test("starting in a blank margin and crossing words selects from the first word crossed", async ({ page }) => {
  await openSample(page);
  const lines = await lineBoxes(page);
  const l = lines[1]!;
  await page.mouse.move(l.x - 50, l.y + l.h / 2);
  await page.mouse.down();
  await page.mouse.move(l.x - 10, l.y + l.h / 2, { steps: 3 }); // still blank
  await page.mouse.move(l.x + 40, l.y + l.h / 2, { steps: 4 }); // first glyphs
  await page.mouse.move(l.x + l.w * 0.5, l.y + l.h / 2, { steps: 8 });
  await page.mouse.up();
  const text = (await selected(page)).trim();
  expect(text.length).toBeGreaterThan(3);
  expect(l.text.includes(text)).toBe(true);
});
