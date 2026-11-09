import { expect, test, type Page } from "@playwright/test";

/**
 * App-wide right-click menu: the browser's default menu is replaced everywhere
 * except editable text, with a short list that depends on what was clicked.
 */
async function boot(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("library-item").first()).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => !!window.__ito);
}

test("right-clicking a library row offers document actions, not the browser menu", async ({ page }) => {
  await boot(page);
  await page.getByTestId("library-item").first().click({ button: "right" });
  const menu = page.getByTestId("app-context-menu");
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute("aria-label", "Document actions");
  await expect(page.getByTestId("ctx-doc-open")).toBeVisible();
  await expect(page.getByTestId("ctx-doc-delete")).toBeVisible();
  await expect(page.getByTestId("ctx-go-nodes")).toBeVisible();

  // Esc dismisses it.
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});

test("the Library background offers import actions; Go to navigates", async ({ page }) => {
  await boot(page);
  await page.getByTestId("library").click({ button: "right", position: { x: 10, y: 150 } });
  await expect(page.getByTestId("ctx-lib-import")).toBeVisible();
  await page.getByTestId("ctx-go-nodes").click();
  await expect(page.getByTestId("view-switch")).toHaveAttribute("data-view-mode", "nodes");
});

test("a delete from the menu goes through the confirmation", async ({ page }) => {
  await boot(page);
  const before = await page.getByTestId("library-item").count();
  await page.getByTestId("library-item").first().click({ button: "right" });
  await page.getByTestId("ctx-doc-delete").click();
  await expect(page.getByTestId("delete-confirm")).toBeVisible();
  expect(await page.getByTestId("library-item").count()).toBe(before);
});

test("the map background and a node get their own actions", async ({ page }) => {
  await boot(page);
  const a = await page.evaluate(() => window.__ito.createSubject("Node A"));
  await page.getByTestId("view-nodes").click();
  await page.getByTestId("nodes-canvas").click({ button: "right", position: { x: 500, y: 400 } });
  await expect(page.getByTestId("app-context-menu")).toHaveAttribute("aria-label", "Map actions");
  await expect(page.getByTestId("ctx-map-subject")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.locator(`[data-testid="graph-node"][data-page-id="${a}"] circle`).click({ button: "right" });
  await expect(page.getByTestId("app-context-menu")).toHaveAttribute("aria-label", "Node actions");
  await page.getByTestId("ctx-node-open").click();
  await expect(page.getByTestId("nodes-page-dock")).toBeVisible();
});

test("editable text keeps the native menu", async ({ page }) => {
  await boot(page);
  await page.getByPlaceholder("Search pages, categories, annotations…").click({ button: "right" });
  await expect(page.getByTestId("app-context-menu")).toHaveCount(0);
});
