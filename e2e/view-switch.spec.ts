import { expect, test, type Page } from "@playwright/test";

/**
 * FEAT-005 — Files / Nodes view switching + N06 placeholder, runtime validation
 * in real Chromium (spec §3.3, section 24). Every assertion reads the LIVE DOM
 * and the LIVE window.__ito counts — never a static string, never a mock. The
 * app, the Workbench, and IndexedDB are the real thing.
 *
 * Coverage:
 *  - the shell view switch toggles Files (Library) <-> Nodes (NodesCanvas);
 *  - opening a PDF from Files still launches the Reader;
 *  - a category selected in Files carries into Nodes and filters the canvas to
 *    that category's squircle + its overlapping network;
 *  - N06-M2: opening the Nodes view for an UNCONNECTED PDF renders a transient
 *    "Not connected yet" placeholder bearing the PDF title, and clicking it
 *    creates ZERO Page/Relationship/Category records (asserted via live counts).
 */

async function bootLibrary(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("app-status")).toHaveAttribute("data-state", "ready", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("library")).toBeVisible();
  await expect(page.getByTestId("library-item").first()).toBeVisible({ timeout: 15_000 });
}

test("the shell view switch toggles Files (Library) <-> Nodes (canvas)", async ({ page }) => {
  await bootLibrary(page);

  // Default view is Files: the Library is shown, the switch reports 'files'.
  await expect(page.getByTestId("view-switch")).toHaveAttribute("data-view-mode", "files");
  await expect(page.getByTestId("library")).toBeVisible();
  await expect(page.getByTestId("nodes-view")).toHaveCount(0);

  // Switch to Nodes: the canvas mounts, the Library is gone.
  await page.getByTestId("view-nodes").click();
  await expect(page.getByTestId("view-switch")).toHaveAttribute("data-view-mode", "nodes");
  await expect(page.getByTestId("nodes-view")).toBeVisible();
  await expect(page.getByTestId("nodes-canvas")).toBeVisible();
  await expect(page.getByTestId("library")).toHaveCount(0);
  // The live Workbench agrees.
  expect(await page.evaluate(() => window.__ito.viewMode())).toBe("nodes");

  // Switch back to Files.
  await page.getByTestId("view-files").click();
  await expect(page.getByTestId("view-switch")).toHaveAttribute("data-view-mode", "files");
  await expect(page.getByTestId("library")).toBeVisible();
});

test("opening a PDF from Files still launches the Reader", async ({ page }) => {
  await bootLibrary(page);
  await page.getByTestId("library-open").first().click();
  await expect(page.getByTestId("reader")).toBeVisible();
  await expect(page.getByTestId("source-pane").first()).toHaveAttribute("data-ready", "true", {
    timeout: 20_000,
  });
});

test("a category selected in Files carries into Nodes and filters the canvas", async ({
  page,
}) => {
  await bootLibrary(page);

  // Build a small network off the live Workbench: two overlapping categories
  // (Ecology {p1,p2}, Economics {p2,p3}) and one disjoint one (History {p4}).
  const ids = await page.evaluate(async () => {
    const p1 = await window.__ito.createSubject("Species");
    const p2 = await window.__ito.createSubject("Climate");
    const p3 = await window.__ito.createSubject("Markets");
    const p4 = await window.__ito.createSubject("Rome");
    const ecology = await window.__ito.createCategory("Ecology");
    const economics = await window.__ito.createCategory("Economics");
    const history = await window.__ito.createCategory("History");
    await window.__ito.addPageToCategory(ecology, p1);
    await window.__ito.addPageToCategory(ecology, p2);
    await window.__ito.addPageToCategory(economics, p2);
    await window.__ito.addPageToCategory(economics, p3);
    await window.__ito.addPageToCategory(history, p4);
    return { ecology, economics, history };
  });

  // Select the Ecology scope in Files (carried on the shared Workbench scope).
  await page.getByTestId("library-scope").selectOption("Ecology");
  expect(await page.evaluate(() => window.__ito.categoryScope())).toBe("Ecology");

  // Switch to Nodes: only Ecology + Economics squircles (overlap via p2) render;
  // History (disjoint) does NOT.
  await page.getByTestId("view-nodes").click();
  await expect(page.getByTestId("nodes-canvas")).toBeVisible();

  const squircleIds = await page
    .getByTestId("category-squircle")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-category-id")));
  expect(squircleIds).toContain(ids.ecology);
  expect(squircleIds).toContain(ids.economics);
  expect(squircleIds).not.toContain(ids.history);
});

test("N06: Nodes view for an unconnected PDF shows a transient placeholder and persists nothing", async ({
  page,
}) => {
  await bootLibrary(page);

  // Open the first (freshly imported, never-cited => unconnected) PDF.
  await page.getByTestId("library-open").first().click();
  await expect(page.getByTestId("reader")).toBeVisible();

  const sourceId = (await page.evaluate(() => window.__ito.openSourceIds()))[0]!;
  const connected = await page.evaluate((id) => window.__ito.sourceIsConnected(id), sourceId);
  expect(connected).toBe(false);

  // Record live counts BEFORE entering the Nodes view.
  const before = await page.evaluate(() => window.__ito.counts());

  // Switch to Nodes while this unconnected PDF is open → the transient
  // placeholder renders with the PDF's title.
  await page.getByTestId("view-nodes").click();
  const placeholder = page.getByTestId("node-placeholder");
  await expect(placeholder).toBeVisible();
  await expect(placeholder).toHaveAttribute("data-transient", "true");
  await expect(placeholder).toHaveAttribute("data-source-id", sourceId);

  // The placeholder carries the live PDF title (the title text contains it).
  const expectedTitle = await page.evaluate(
    (id) => window.__ito.nodePlaceholderFor(id).title,
    sourceId,
  );
  await expect(page.getByTestId("node-placeholder-title")).toHaveText(expectedTitle);

  // Clicking the placeholder must create NOTHING.
  await placeholder.click();

  const after = await page.evaluate(() => window.__ito.counts());
  expect(after.pages).toBe(before.pages);
  expect(after.relationships).toBe(before.relationships);
  expect(after.categories).toBe(before.categories);
  // And explicitly zero graph records from this flow.
  const graphCounts = await page.evaluate(() => window.__ito.graphRecordCount());
  expect(graphCounts).toEqual({ pages: 0, relationships: 0, categories: 0 });

  // Leaving the view discards the placeholder (ephemeral UI only).
  await page.getByTestId("view-files").click();
  await expect(page.getByTestId("node-placeholder")).toHaveCount(0);
});
