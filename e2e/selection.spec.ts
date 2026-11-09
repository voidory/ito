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

test("rotated PDF selection follows visible glyph geometry at 90 and 270 degrees", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("library-item").first()).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("library-open").filter({ hasText: /Rotated Fixture/ }).click();
  await expect(page.getByTestId("source-pane").first()).toHaveAttribute("data-ready", "true", {
    timeout: 20_000,
  });
  await expect(page.locator(".textLayer span").first()).toBeVisible({ timeout: 20_000 });

  for (const rotation of [90, 270]) {
    const needle = "Rotated page at " + rotation + " degrees";
    const path = await page.evaluate(({ needle, pageIndex }) => {
      const page = [...document.querySelectorAll(".pdf-page")].find(
        (el) => el.getAttribute("data-page-index") === String(pageIndex),
      );
      const layer = page?.querySelector(".textLayer");
      const span = layer && [...layer.querySelectorAll("span")].find((el) =>
        el.firstChild?.nodeType === Node.TEXT_NODE && el.firstChild.textContent?.includes(needle),
      );
      const node = span?.firstChild;
      if (!(node instanceof Text) || !span) return null;
      const start = node.data.indexOf(needle);
      if (start < 0) return null;

      const charRects: DOMRect[] = [];
      for (let i = start; i < start + needle.length; i++) {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        charRects.push(range.getBoundingClientRect());
      }
      const first = charRects[0]!;
      const last = charRects[charRects.length - 1]!;
      const firstCenter = { x: first.left + first.width / 2, y: first.top + first.height / 2 };
      const lastCenter = { x: last.left + last.width / 2, y: last.top + last.height / 2 };
      const dx = lastCenter.x - firstCenter.x;
      const dy = lastCenter.y - firstCenter.y;
      const length = Math.hypot(dx, dy);
      if (!length) return null;
      const axis = { x: dx / length, y: dy / length };
      const normal = { x: -axis.y, y: axis.x };
      const project = (r: DOMRect) => [
        [r.left, r.top], [r.right, r.top], [r.left, r.bottom], [r.right, r.bottom],
      ].map(([x, y]) => x * axis.x + y * axis.y);
      const firstAlong = project(first);
      const lastAlong = project(last);
      const across = firstCenter.x * normal.x + firstCenter.y * normal.y;
      const point = (along: number) => ({
        x: along * axis.x + across * normal.x,
        y: along * axis.y + across * normal.y,
      });
      const startAlong = Math.min(...firstAlong) + 0.75;
      const endAlong = Math.max(...lastAlong) - 0.75;
      const startPoint = point(startAlong);
      const endPoint = point(endAlong);
      const target = {
        left: Math.min(...charRects.map((r) => r.left)),
        top: Math.min(...charRects.map((r) => r.top)),
        right: Math.max(...charRects.map((r) => r.right)),
        bottom: Math.max(...charRects.map((r) => r.bottom)),
      };
      return {
        startPoint,
        endPoint,
        target,
        vertical: target.bottom - target.top > (target.right - target.left) * 5,
      };
    }, { needle, pageIndex: rotation === 90 ? 0 : 2 });

    expect(path, "fixture text should be measurable").not.toBeNull();
    expect(path!.vertical, "text should be visually vertical").toBe(true);

    // Follow the actual baseline from the first glyph to the last glyph.
    await page.mouse.move(path!.startPoint.x, path!.startPoint.y);
    await page.mouse.down();
    await page.mouse.move(path!.endPoint.x, path!.endPoint.y, { steps: 30 });
    await page.mouse.up();

    await expect(page.getByTestId("live-selection-preview")).toBeVisible();
    await expect(page.getByTestId("selection-toolbar")).toBeVisible();

    const measured = await page.evaluate(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
      const range = selection.getRangeAt(0);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
      const union = (items: readonly DOMRect[]) => ({
        left: Math.min(...items.map((r) => r.left)),
        top: Math.min(...items.map((r) => r.top)),
        right: Math.max(...items.map((r) => r.right)),
        bottom: Math.max(...items.map((r) => r.bottom)),
      });
      const preview = [...document.querySelectorAll<HTMLElement>(".ito-selection-live-preview")]
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0);
      return {
        text: selection.toString().trim(),
        rangeBox: union(rects),
        previewBox: preview.length ? union(preview) : null,
      };
    });

    expect(measured).not.toBeNull();
    expect(measured!.text).toBe(needle);
    expect(measured!.rangeBox.bottom - measured!.rangeBox.top)
      .toBeGreaterThan((measured!.rangeBox.right - measured!.rangeBox.left) * 5);

    // Native Range geometry must occupy the same viewport region as the
    // individually measured rendered glyphs, not merely contain the right text.
    for (const key of ["left", "top", "right", "bottom"] as const) {
      expect(Math.abs(measured!.rangeBox[key] - path!.target[key]), "Range geometry " + key)
        .toBeLessThanOrEqual(2);
    }

    // Ito's live preview must mirror the native Selection's client geometry.
    expect(measured!.previewBox).not.toBeNull();
    for (const key of ["left", "top", "right", "bottom"] as const) {
      expect(Math.abs(measured!.previewBox![key] - measured!.rangeBox[key]), "preview " + key)
        .toBeLessThanOrEqual(1);
    }
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
  }
});
