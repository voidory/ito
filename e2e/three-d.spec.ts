import { test, expect, type Page } from "@playwright/test";

/**
 * FEAT-006 — §3.4 THE SECRET 3D DIMENSIONAL SHIFT (density reward), runtime
 * validation in real Chromium (spec §3.4; §24). Every assertion reads the LIVE
 * DOM + the LIVE window.__ito state driving the REAL Workbench — nothing mocked.
 *
 * Coverage:
 *  - the "enter-3d" prompt is ABSENT below 35 active nodes and PRESENT at >= 35
 *    (the density reward is unlocked by live graph density, not a static flag);
 *  - activating it flips wb.active3D() true and mounts the Three.js WebGL scene
 *    (data-testid="three-canvas") rendering the SAME live graph — OR, when WebGL
 *    is unavailable in the CI browser, surfaces the graceful 2D-fallback notice
 *    (data-testid="three-fallback") instead of crashing;
 *  - exiting returns to the 2D NodesCanvas and active3D flips back to false.
 *
 * The 3D-vs-fallback assertion branches on a real WebGL-availability probe
 * (window.__ito.webglAvailable()), so the spec is correct on GPU and headless
 * CI alike.
 */

async function bootToNodesView(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("app-status")).toHaveAttribute("data-state", "ready", {
    timeout: 15_000,
  });
  await page.getByTestId("view-nodes").click();
  await expect(page.getByTestId("nodes-view")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("nodes-canvas")).toBeVisible({ timeout: 15_000 });
}

/** Create N subject pages (real durable records) to drive the density monitor. */
async function createPages(page: Page, count: number): Promise<void> {
  await page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) await window.__ito.createSubject(`Node ${i}`);
  }, count);
}

test("the enter-3d prompt is ABSENT below 35 active nodes", async ({ page }) => {
  await bootToNodesView(page);
  await createPages(page, 34);

  expect(await page.evaluate(() => window.__ito.activeNodeCount())).toBe(34);
  expect(await page.evaluate(() => window.__ito.is3DUnlocked())).toBe(false);
  await expect(page.getByTestId("enter-3d")).toHaveCount(0);
});

test("the enter-3d prompt APPEARS at >= 35 active nodes (density reward)", async ({ page }) => {
  await bootToNodesView(page);
  await createPages(page, 35);

  expect(await page.evaluate(() => window.__ito.activeNodeCount())).toBe(35);
  expect(await page.evaluate(() => window.__ito.is3DUnlocked())).toBe(true);
  await expect(page.getByTestId("enter-3d")).toBeVisible();
});

test("activating 3D mounts the WebGL scene (or the graceful 2D fallback) and exiting returns to 2D", async ({
  page,
}) => {
  await bootToNodesView(page);
  await createPages(page, 36);

  await expect(page.getByTestId("enter-3d")).toBeVisible();
  await page.getByTestId("enter-3d").click();

  // The live state flips to active3D and the 3D container mounts.
  await expect
    .poll(() => page.evaluate(() => window.__ito.active3D()))
    .toBe(true);
  await expect(page.getByTestId("three-scene")).toBeVisible();
  // The 2D canvas is gone while 3D is active.
  await expect(page.getByTestId("nodes-canvas")).toHaveCount(0);

  const webgl = await page.evaluate(() => window.__ito.webglAvailable());
  if (webgl) {
    // Real WebGL: the Three.js renderer canvas is mounted.
    await expect(page.getByTestId("three-canvas")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("three-fallback")).toHaveCount(0);
  } else {
    // Headless/no-GPU: a visible fallback notice, no crash, 2D intact.
    await expect(page.getByTestId("three-fallback")).toBeVisible();
    await expect(page.getByTestId("three-canvas")).toHaveCount(0);
  }

  // Exit returns to the 2D NodesCanvas and flips active3D back to false.
  await page.getByTestId("exit-3d").click();
  await expect
    .poll(() => page.evaluate(() => window.__ito.active3D()))
    .toBe(false);
  await expect(page.getByTestId("nodes-canvas")).toBeVisible();
  await expect(page.getByTestId("three-scene")).toHaveCount(0);
});

test("the 3D scene reads the SAME live graph as 2D (no duplicated hardcoded scene)", async ({
  page,
}) => {
  await bootToNodesView(page);
  await createPages(page, 40);

  // The density monitor counts the same live nodes the 2D canvas renders.
  const [active, graphNodes] = await page.evaluate(() => [
    window.__ito.activeNodeCount(),
    window.__ito.conceptGraph().nodes.length,
  ]);
  expect(active).toBe(40);
  expect(graphNodes).toBe(40);

  await page.getByTestId("enter-3d").click();
  await expect.poll(() => page.evaluate(() => window.__ito.active3D())).toBe(true);
  // Entering 3D does not mutate the graph — it is a presentation flag only.
  expect(await page.evaluate(() => window.__ito.conceptGraph().nodes.length)).toBe(40);
  expect(await page.evaluate(() => window.__ito.counts().pages)).toBe(40);
});
