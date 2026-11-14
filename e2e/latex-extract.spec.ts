import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Box-selection LaTeX extraction, end to end in real Chromium: import the math
 * fixture, drag the Area tool over an equation, and read the LaTeX the reader
 * drafts from the text inside the box. Coordinates are PDF points (y up) and
 * mirror `makeMath()` in scripts/gen-fixtures.mjs.
 */
const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src/test/fixtures/sample-math.pdf",
);
const PAGE_W = 612;
const PAGE_H = 792;

async function openMathFixture(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("app-status")).toHaveAttribute("data-state", "ready", {
    timeout: 15_000,
  });
  await page.getByTestId("import-pdf-input").setInputFiles(FIXTURE);
  const item = page.getByTestId("library-item").filter({ hasText: "sample-math" });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.getByTestId("library-open").click();
  await expect(page.getByTestId("reader")).toBeVisible();
  await expect(page.locator(".pdf-page-stage .textLayer span").first()).toBeAttached({
    timeout: 15_000,
  });
}

/** Drag the Area tool over a PDF-point box and return the drafted LaTeX. */
async function extractBox(
  page: Page,
  box: { x0: number; x1: number; top: number; bottom: number },
  save = false,
): Promise<string> {
  const stage = page.locator('.pdf-page-stage[data-page-index="0"]');
  // Bring the box into the viewport (the page is taller than the window).
  const pre = (await stage.boundingBox())!;
  const midY = pre.y + ((PAGE_H - (box.top + box.bottom) / 2) / PAGE_H) * pre.height;
  const view = page.viewportSize()!;
  await page.mouse.move(pre.x + pre.width / 2, view.height / 2);
  await page.mouse.wheel(0, Math.round(midY - 230));
  await page.waitForTimeout(300);
  const sb = (await stage.boundingBox())!;
  const px = (x: number): number => sb.x + (x / PAGE_W) * sb.width;
  const py = (y: number): number => sb.y + ((PAGE_H - y) / PAGE_H) * sb.height;

  const tool = page.getByTestId("tool-area");
  if ((await tool.getAttribute("aria-pressed")) !== "true") await tool.click();
  const before = await page.locator(".ito-highlight").count();
  await page.mouse.move(px(box.x0), py(box.top));
  await page.mouse.down();
  await page.mouse.move(px((box.x0 + box.x1) / 2), py((box.top + box.bottom) / 2), { steps: 4 });
  await page.mouse.move(px(box.x1), py(box.bottom), { steps: 4 });
  await page.mouse.up();
  await expect(page.locator(".ito-highlight")).toHaveCount(before + 1);
  // Committing the box opens its popover.
  await expect(page.getByTestId("highlight-edit-popover")).toBeVisible();
  await page.getByTestId("scientific-tools-btn").click();
  await page.getByTestId("extract-latex-btn").click();
  const input = page.getByTestId("latex-input");
  await expect(input).not.toHaveValue("", { timeout: 10_000 });
  const value = await input.inputValue();
  // The draft compiles and previews before anything is saved.
  await expect(page.getByTestId("latex-draft-preview").locator("math")).toBeAttached();
  // Drafting stores nothing; only an explicit save does.
  await expect(page.getByTestId("annotation-latex-preview")).toHaveCount(0);
  if (save) {
    await page.getByTestId("save-latex-btn").click();
    await expect(page.getByTestId("annotation-latex-preview").locator("msup")).toBeAttached();
  }
  await page.getByTestId("popover-close").click();
  return value.replace(/\s+/g, "");
}

test("superscript: a box over E = mc² drafts E=mc^2", async ({ page }) => {
  await openMathFixture(page);
  expect(await extractBox(page, { x0: 66, x1: 140, top: 716, bottom: 693 })).toBe("E=mc^2");
});

test("fraction + radical: a box over the quadratic formula drafts nested structure", async ({
  page,
}) => {
  await openMathFixture(page);
  expect(await extractBox(page, { x0: 66, x1: 235, top: 664, bottom: 610 })).toBe(
    "x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}",
  );
});

test("limits and stacked scripts: a box over the sum", async ({ page }) => {
  await openMathFixture(page);
  expect(await extractBox(page, { x0: 66, x1: 200, top: 594, bottom: 534 })).toBe(
    "\\sum_{i=1}^na_i=\\alphax_k^2",
  );
});

test("partial selection: a box inside a sentence takes only the glyphs it covers", async ({
  page,
}) => {
  await openMathFixture(page);
  expect(await extractBox(page, { x0: 149, x1: 197, top: 496, bottom: 474 })).toBe("E=mc^2");
});

test("the drafted LaTeX is stored only when the user saves it", async ({ page }) => {
  await openMathFixture(page);
  expect(await extractBox(page, { x0: 66, x1: 140, top: 716, bottom: 693 }, true)).toBe("E=mc^2");
});

test("extraction does not depend on zoom or on a stored crop", async ({ page }) => {
  // A TeX page from the benchmark corpus: glyphs and rules come from the PDF's
  // own drawing operations, so the render scale cannot change the result.
  const corpus = resolve(dirname(fileURLToPath(import.meta.url)), "../src/science/research/latex/corpus");
  const manifest = JSON.parse(readFileSync(resolve(corpus, "manifest.json"), "utf8")) as {
    tiers: Record<string, { pageWidth: number; pageHeight: number; placements: [string, number, number, number, number, number][] }>;
  };
  const tier = manifest.tiers["tex-display"]!;
  const rects = tier.placements
    .filter((p) => p[1] === 0)
    .slice(0, 8)
    .map(([, , x0, y0, x1, y1]) => ({
      x: x0 / tier.pageWidth,
      y: (tier.pageHeight - y1) / tier.pageHeight,
      width: (x1 - x0) / tier.pageWidth,
      height: (y1 - y0) / tier.pageHeight,
    }));

  await page.goto("/");
  await expect(page.getByTestId("app-status")).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
  await page.getByTestId("import-pdf-input").setInputFiles(resolve(corpus, "tex-display.pdf"));
  const item = page.getByTestId("library-item").filter({ hasText: "tex-display" });
  await expect(item).toBeVisible({ timeout: 120_000 });
  const sourceId = (await item.getAttribute("data-source-id"))!;

  const at = (scale: number): Promise<string[]> =>
    page.evaluate(
      async ({ id, list, s }) => {
        const out: string[] = [];
        for (const rect of list) out.push(await window.__ito.extractLatexAt(id, 0, rect, { scale: s }));
        return out;
      },
      { id: sourceId, list: rects, s: scale },
    );
  const half = await at(0.5);
  expect(half.every((latex) => latex.length > 0)).toBe(true);
  expect(half.some((latex) => latex.includes("\\frac"))).toBe(true);
  expect(await at(1)).toEqual(half);
  expect(await at(2)).toEqual(half);
});
