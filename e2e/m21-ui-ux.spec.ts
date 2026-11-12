import { test, expect } from "@playwright/test";

test.describe("M21 UI/UX priorities", () => {
  test("starts genuinely empty, supports explicit sample loading, and keeps empty state after deleting the final document", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("library-empty")).toBeVisible();
    await expect(page.getByTestId("load-sample-workspace")).toBeVisible();

    await page.getByTestId("load-sample-workspace").click();
    await expect(page.getByTestId("library-table")).toBeVisible();
    await expect(page.getByTestId("library-item")).toHaveCount(3);

    while (await page.getByTestId("delete-source").count() > 0) {
      await page.getByTestId("delete-source").first().click();
      await page.getByTestId("delete-confirm-yes").click();
    }

    await expect(page.getByTestId("library-empty")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("library-empty")).toBeVisible();
    await expect(page.getByTestId("library-item")).toHaveCount(0);
  });

  test("preserves the existing PDF import path from the empty state", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("library-empty")).toBeVisible();

    await page.getByTestId("empty-import-pdf").click();
    const chooser = page.waitForEvent("filechooser");
    // The hidden input is the existing import control; trigger it directly so
    // the test verifies the same Workbench import path as the visible button.
    await page.getByTestId("import-pdf-btn").click();
    const fileChooser = await chooser;
    await fileChooser.setFiles("src/test/fixtures/sample-3page.pdf");

    await expect(page.getByTestId("library-item")).toHaveCount(1);
    await expect(page.getByTestId("library-empty")).toHaveCount(0);
  });

  test("keeps first-use orientation dismissible and persistent", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("research-orientation")).toBeVisible();

    await page.getByTestId("orientation-dismiss").click();
    await expect(page.getByTestId("research-orientation")).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId("research-orientation")).toHaveCount(0);
  });

  test("selects nodes, exposes direct DOM actions, supports double-click, background deselection, and Escape", async ({ page }) => {
    await page.goto("/");

    page.on("dialog", async (dialog) => {
      await dialog.accept(dialog.defaultValue || "Test Subject");
    });

    await page.getByTestId("subjects-launcher-toggle").click();
    await page.getByTestId("create-standalone-subject").click();
    await page.getByTestId("subjects-launcher-toggle").click();
    await page.getByTestId("create-standalone-subject").click();

    await page.getByTestId("view-nodes").click();
    const nodes = page.getByTestId("graph-node");
    await expect(nodes).toHaveCount(2);

    await nodes.first().click();
    await expect(page.getByTestId("selected-node-actions")).toBeVisible();
    await expect(page.getByTestId("selected-node-open-page")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("selected-node-actions")).toHaveCount(0);

    await nodes.first().click();
    await page.getByTestId("selected-node-open-page").dblclick();
    await expect(page.getByTestId("view-files")).toHaveAttribute("aria-selected", "true");

    await page.getByTestId("view-nodes").click();
    await nodes.first().dblclick();
    await expect(page.getByTestId("view-files")).toHaveAttribute("aria-selected", "true");

    await page.getByTestId("view-nodes").click();
    await nodes.first().click();
    await expect(page.getByTestId("selected-node-actions")).toBeVisible();
    const canvas = page.getByTestId("nodes-canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("Nodes canvas has no bounding box");
    await page.mouse.click(box.x + 8, box.y + 8);
    await expect(page.getByTestId("selected-node-actions")).toHaveCount(0);
  });

  test("routes node context-menu Open page through the shared command", async ({ page }) => {
    await page.goto("/");

    page.on("dialog", async (dialog) => {
      await dialog.accept(dialog.defaultValue || "Context Node");
    });

    await page.getByTestId("subjects-launcher-toggle").click();
    await page.getByTestId("create-standalone-subject").click();

    await page.getByTestId("view-nodes").click();
    const node = page.getByTestId("graph-node").first();
    await expect(node).toBeVisible();
    await node.click({ button: "right" });

    await expect(page.getByTestId("ctx-node-open")).toBeVisible();
    await page.getByTestId("ctx-node-open").click();
    await expect(page.getByTestId("view-files")).toHaveAttribute("aria-selected", "true");
  });

  test("applies the same selection/action model to hubs", async ({ page }) => {
    await page.goto("/");

    page.on("dialog", async (dialog) => {
      await dialog.accept(dialog.defaultValue || "Hub Node");
    });

    await page.getByTestId("subjects-launcher-toggle").click();
    await page.getByTestId("create-standalone-subject").click();
    await page.getByTestId("subjects-launcher-toggle").click();
    await page.getByTestId("create-standalone-subject").click();

    await page.getByTestId("view-nodes").click();
    const nodes = page.getByTestId("graph-node");
    await expect(nodes).toHaveCount(2);

    await page.getByTestId("nodes-connect-mode-btn").click();
    await nodes.nth(0).click();
    await nodes.nth(1).click();
    await page.getByTestId("nodes-create-hub-btn").click();

    const hub = page.getByTestId("graph-hub").first();
    await expect(hub).toBeVisible();
    await hub.click();
    await expect(page.getByTestId("selected-hub-actions")).toBeVisible();

    await hub.click({ button: "right" });
    await expect(page.getByTestId("ctx-hub-open")).toBeVisible();
    await page.getByTestId("ctx-hub-open").click();
    await expect(page.getByTestId("view-files")).toHaveAttribute("aria-selected", "true");
  });
});
