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

test("N06 (open-together): every open unconnected PDF renders its own transient placeholder; returning to Reader creates nothing", async ({
  page,
}) => {
  await bootLibrary(page);

  // Open TWO unconnected PDFs together (the library seeds >=2 fixtures). No
  // analysis runs, so both sources stay unconnected.
  const items = page.getByTestId("library-item");
  await items.nth(0).getByRole("checkbox").check();
  await items.nth(1).getByRole("checkbox").check();
  await page.getByTestId("open-together").click();
  await expect(page.getByTestId("reader")).toBeVisible();

  const openIds = await page.evaluate(() => window.__ito.openSourceIds());
  expect(openIds.length).toBeGreaterThanOrEqual(2);
  for (const id of openIds) {
    expect(await page.evaluate((s) => window.__ito.sourceIsConnected(s), id)).toBe(false);
  }

  const before = await page.evaluate(() => window.__ito.counts());

  // Switch to Nodes: a transient placeholder renders for EACH open unconnected
  // source — not just one.
  await page.getByTestId("view-nodes").click();
  const placeholders = page.getByTestId("node-placeholder");
  await expect(placeholders).toHaveCount(openIds.length);

  // Each placeholder carries the right source id, is transient, and exposes a
  // Return-to-Reader control (live DOM).
  const renderedSourceIds = await placeholders.evaluateAll((els) =>
    els.map((e) => ({
      sourceId: e.getAttribute("data-source-id"),
      transient: e.getAttribute("data-transient"),
      hasReturn: !!e.querySelector('[data-testid="placeholder-return-reader"]'),
    })),
  );
  for (const id of openIds) {
    const row = renderedSourceIds.find((r) => r.sourceId === id)!;
    expect(row.transient).toBe("true");
    expect(row.hasReturn).toBe(true);
  }

  // Zero durable graph records created by any of this.
  expect(await page.evaluate(() => window.__ito.graphRecordCount())).toEqual({
    pages: 0,
    relationships: 0,
    categories: 0,
  });

  // Clicking a placeholder's Return-to-Reader switches back to Files/Reader
  // focused on THAT source, still creating nothing.
  const targetId = openIds[1]!;
  await page
    .locator(`[data-testid="node-placeholder"][data-source-id="${targetId}"]`)
    .getByTestId("placeholder-return-reader")
    .click();
  await expect(page.getByTestId("view-switch")).toHaveAttribute("data-view-mode", "files");
  await expect(page.getByTestId("reader")).toBeVisible();
  expect(await page.evaluate(() => window.__ito.openSourceIds())).toContain(targetId);

  const after = await page.evaluate(() => window.__ito.counts());
  expect(after.pages).toBe(before.pages);
  expect(after.relationships).toBe(before.relationships);
  expect(after.categories).toBe(before.categories);
});

/** The fixtures contain "quick brown fox" on each page. */
const HIGHLIGHT_NEEDLE = "quick brown fox";

/** Open the first PDF, select real text and commit ONE highlight; return its id. */
async function openAndHighlight(page: Page): Promise<string> {
  await bootLibrary(page);
  await page.getByTestId("library-open").first().click();
  await expect(page.getByTestId("reader")).toBeVisible();
  await expect(page.getByTestId("source-pane").first()).toHaveAttribute("data-ready", "true", {
    timeout: 20_000,
  });
  await expect(page.locator(".textLayer span").first()).toBeVisible({ timeout: 20_000 });
  const selected = await page.evaluate((n) => window.__ito.selectText(n, 0), HIGHLIGHT_NEEDLE);
  expect(selected).toBe(true);
  await page.getByTestId("commit-highlight").click();
  const annotationId = await page.evaluate(() => window.__ito.firstAnnotationId());
  expect(annotationId).toBeTruthy();
  return annotationId!;
}

test("N04: Show-in-Nodes for an annotation cited into ONE subject page focuses that node", async ({
  page,
}) => {
  const annotationId = await openAndHighlight(page);

  // Cite the annotation into exactly ONE subject page (a real EvidenceInstance).
  const pageId = await page.evaluate(async (ann) => {
    const p = await window.__ito.createSubject("Single Subject");
    await window.__ito.citeAnnotationIntoPage(ann, p);
    return p;
  }, annotationId);

  const cited = await page.evaluate((ann) => window.__ito.citedSubjectPagesForAnnotation(ann), annotationId);
  expect(cited).toEqual([pageId]);

  // Open the highlights tab so the Show-in-Nodes control is visible.
  await page.getByTestId("toggle-highlights-tab").click();
  const row = page.locator(`[data-testid="highlight-row"][data-annotation-id="${annotationId}"]`);
  const showInNodes = row.getByTestId("show-in-nodes");
  await expect(showInNodes).toHaveAttribute("data-cited-count", "1");

  // N04: single cited subject page — clicking locates straight to Nodes with
  // that subject node focused. No destination picker.
  await showInNodes.click();
  await expect(page.getByTestId("view-switch")).toHaveAttribute("data-view-mode", "nodes");
  await expect(page.getByTestId("nodes-destination-picker")).toHaveCount(0);
  expect(await page.evaluate(() => window.__ito.focusedPageId())).toBe(pageId);
  const node = page.locator(`[data-testid="graph-node"][data-page-id="${pageId}"]`);
  await expect(node).toHaveAttribute("data-focused", "true");
});

test("N05: Show-in-Nodes for an annotation cited into TWO subject pages opens a destination picker", async ({
  page,
}) => {
  const annotationId = await openAndHighlight(page);

  // Cite the SAME annotation into TWO subject pages.
  const { p1, p2 } = await page.evaluate(async (ann) => {
    const p1 = await window.__ito.createSubject("Subject One");
    const p2 = await window.__ito.createSubject("Subject Two");
    await window.__ito.citeAnnotationIntoPage(ann, p1);
    await window.__ito.citeAnnotationIntoPage(ann, p2);
    return { p1, p2 };
  }, annotationId);

  const cited = await page.evaluate((ann) => window.__ito.citedSubjectPagesForAnnotation(ann), annotationId);
  expect(cited).toHaveLength(2);

  await page.getByTestId("toggle-highlights-tab").click();
  const row = page.locator(`[data-testid="highlight-row"][data-annotation-id="${annotationId}"]`);
  const showInNodes = row.getByTestId("show-in-nodes");
  await expect(showInNodes).toHaveAttribute("data-cited-count", "2");

  // N05: multiple cited subject pages — a lightweight destination picker opens
  // listing BOTH linked subject pages.
  await showInNodes.click();
  const picker = row.getByTestId("nodes-destination-picker");
  await expect(picker).toBeVisible();
  const options = picker.getByTestId("nodes-destination-option");
  await expect(options).toHaveCount(2);
  const optionIds = await options.evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-page-id")),
  );
  expect(optionIds).toEqual(expect.arrayContaining([p1, p2]));

  // Choosing one focuses THAT node in the Nodes view.
  await picker.locator(`[data-page-id="${p2}"]`).click();
  await expect(page.getByTestId("view-switch")).toHaveAttribute("data-view-mode", "nodes");
  expect(await page.evaluate(() => window.__ito.focusedPageId())).toBe(p2);
  await expect(
    page.locator(`[data-testid="graph-node"][data-page-id="${p2}"]`),
  ).toHaveAttribute("data-focused", "true");
});

test("search: typing into the network search surfaces a matching page/category and selecting it opens it", async ({
  page,
}) => {
  await bootLibrary(page);

  // Build a real, searchable graph on the live Workbench.
  const { pageId } = await page.evaluate(async () => {
    const pageId = await window.__ito.createSubject("Photosynthesis");
    await window.__ito.createCategory("Biology");
    return { pageId };
  });

  // Type a query that matches the page title AND the category name.
  const input = page.getByTestId("network-search-input");
  await input.fill("bio");
  const results = page.getByTestId("network-search-results");
  await expect(results).toBeVisible();
  const categoryResult = results.locator('[data-result-kind="category"]');
  await expect(categoryResult).toHaveCount(1);

  // A page query surfaces the subject page and selecting it opens it.
  await input.fill("Photosyn");
  const pageResult = results.locator(`[data-result-kind="page"][data-result-id="${pageId}"]`);
  await expect(pageResult).toHaveCount(1);
  await pageResult.click();
  expect(await page.evaluate(() => window.__ito.openSubjectId())).toBe(pageId);

  // Selecting a result created ZERO new durable records (search only reads).
  expect(await page.evaluate(() => window.__ito.graphRecordCount())).toEqual({
    pages: 1,
    relationships: 0,
    categories: 1,
  });
});
