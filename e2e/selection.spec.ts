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

test("rotated PDF text remains visibly selectable along its vertical baseline", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("library-item").first()).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("library-open").filter({ hasText: /Rotated Fixture/ }).click();
  await expect(page.getByTestId("source-pane").first()).toHaveAttribute("data-ready", "true", {
    timeout: 20_000,
  });
  await expect(page.locator(".textLayer span").first()).toBeVisible({ timeout: 20_000 });

  // Force the geometry-based fallback so the regression covers browsers that
  // cannot return a reliable caret inside a CSS-transformed text span.
  await page.evaluate(() => {
    Object.defineProperty(document, "caretPositionFromPoint", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(document, "caretRangeFromPoint", {
      configurable: true,
      value: undefined,
    });
  });

  const needle = "Rotated page at 90 degrees";
  const target = await page.evaluate((text) => {
    const layer = document.querySelector(".textLayer");
    if (!layer) return null;
    const span = [...layer.querySelectorAll("span")].find((el) =>
      el.firstChild?.nodeType === Node.TEXT_NODE && el.firstChild.textContent?.includes(text),
    );
    const node = span?.firstChild;
    if (!(node instanceof Text) || !span) return null;
    const start = node.data.indexOf(text);
    if (getComputedStyle(span).transform === "none") return null;
    if (start < 0) return null;

    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + text.length);
    const rect = range.getBoundingClientRect();
    const matrix = new DOMMatrixReadOnly(getComputedStyle(span).transform);
    const length = Math.hypot(matrix.a, matrix.b);
    if (length < 1e-6) return null;
    const axis = { x: matrix.a / length, y: matrix.b / length };
    const extent = Math.abs(axis.x) * rect.width + Math.abs(axis.y) * rect.height;
    const center = { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
    const inset = Math.max(1, extent / 2 - 2);
    return {
      start: { x: center.x - axis.x * inset, y: center.y - axis.y * inset },
      end: { x: center.x + axis.x * inset, y: center.y + axis.y * inset },
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
      axis,
    };
  }, needle);

  expect(target).not.toBeNull();
  expect(Math.abs(target!.axis.y)).toBeGreaterThan(0.8);
  expect(target!.rect.height).toBeGreaterThan(target!.rect.width * 5);

  await page.mouse.move(target!.start.x, target!.start.y);
  await page.mouse.down();
  await page.mouse.move(target!.end.x, target!.end.y, { steps: 20 });
  await page.mouse.up();

  const selection = await page.evaluate(() => {
    const current = window.getSelection();
    if (!current || current.rangeCount === 0) return null;
    const rects = [...current.getRangeAt(0).getClientRects()];
    return {
      text: current.toString(),
      rects: rects.map((rect) => ({
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      })),
    };
  });
  expect(selection).not.toBeNull();
  expect(selection!.text).toContain(needle);
  await expect(page.getByTestId("live-selection-preview")).toBeVisible();
  await expect(page.getByTestId("selection-toolbar")).toBeVisible();

  const preview = await page.getByTestId("live-selection-preview").locator("div").evaluateAll((els) =>
    els.map((el) => {
      const rect = el.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    }),
  );
  expect(preview.length).toBeGreaterThan(0);
  expect(Math.abs(Math.min(...preview.map((r) => r.left)) - Math.min(...selection!.rects.map((r) => r.left)))).toBeLessThan(2);
  expect(Math.abs(Math.min(...preview.map((r) => r.top)) - Math.min(...selection!.rects.map((r) => r.top)))).toBeLessThan(2);
  expect(Math.abs(Math.max(...preview.map((r) => r.right)) - Math.max(...selection!.rects.map((r) => r.right)))).toBeLessThan(2);
  expect(Math.abs(Math.max(...preview.map((r) => r.bottom)) - Math.max(...selection!.rects.map((r) => r.bottom)))).toBeLessThan(2);
});

