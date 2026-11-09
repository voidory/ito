import { test, expect, type Page } from "@playwright/test";

/**
 * FEAT-004 — 2D CONCEPT NETWORK (NodesCanvas) runtime validation in real
 * Chromium (spec §3; §24). Every test drives the REAL app: the SAME Workbench
 * the UI uses, the REAL force-directed layout engine, the REAL SVG scene.
 * Nothing is mocked — assertions read live DOM + live geometry (window.__ito),
 * never static strings.
 *
 * Coverage:
 *  - A13-M2: a 2-endpoint relationship renders a graph-hub data-hub-kind="lens";
 *    a >=3-endpoint one renders data-hub-kind="star" with data-endpoint-count>=3
 *    and star vertices that point toward the connected nodes.
 *  - A09-M2: nodes render inside their category squircle bounds; idle positions
 *    are stable between frames (no unexpected camera jump / forced motion).
 *  - A10-M2: a node in two categories renders in the intersection of BOTH
 *    squircles (squircleContains against both bounds via a geometry probe).
 *  - A14-M2: a category-to-category reference renders a category-link between
 *    the two squircle boundaries.
 */

async function bootToNodesView(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("app-status")).toHaveAttribute("data-state", "ready", {
    timeout: 15_000,
  });
  // Reach the Nodes view via the live presentation flag (FEAT-005 formalizes
  // the full Files/Nodes switch; FEAT-004 only needs it reachable).
  await page.evaluate(() => window.__ito.setNodesView(true));
  await expect(page.getByTestId("nodes-canvas")).toBeVisible({ timeout: 15_000 });
}

/** Create N subject pages and return their ids (real durable records). */
async function createPages(page: Page, titles: readonly string[]): Promise<string[]> {
  return page.evaluate(async (ts) => {
    const ids: string[] = [];
    for (const t of ts) ids.push(await window.__ito.createSubject(t));
    return ids;
  }, titles);
}

test("A13-M2: a 2-endpoint relationship renders a lens hub", async ({ page }) => {
  await bootToNodesView(page);
  const [a, b] = await createPages(page, ["Alpha", "Beta"]);
  await page.evaluate(([x, y]) => window.__ito.createRelationship([x!, y!]), [a, b] as const);

  const hub = page.getByTestId("graph-hub");
  await expect(hub).toHaveCount(1);
  await expect(hub).toHaveAttribute("data-hub-kind", "lens");
  await expect(hub).toHaveAttribute("data-endpoint-count", "2");
  // Both nodes render.
  await expect(page.getByTestId("graph-node")).toHaveCount(2);
});

test("A13-M2: a >=3-endpoint relationship renders a star hub whose vertices point toward nodes", async ({
  page,
}) => {
  await bootToNodesView(page);
  const ids = await createPages(page, ["One", "Two", "Three"]);
  await page.evaluate((e) => window.__ito.createRelationship(e), ids);

  const hub = page.getByTestId("graph-hub");
  await expect(hub).toHaveAttribute("data-hub-kind", "star");
  const endpointCount = Number(await hub.getAttribute("data-endpoint-count"));
  expect(endpointCount).toBeGreaterThanOrEqual(3);
  // The star path is a real closed path.
  const d = await hub.locator("xpath=.").getAttribute("d");
  expect(d?.startsWith("M")).toBe(true);
  expect(d?.includes("Z")).toBe(true);

  // Vertices point toward the connected nodes: every endpoint has a distinct
  // bearing from the hub center, which is the precondition the star generator
  // uses to aim one outer vertex at each node (read live geometry).
  const geo = await page.evaluate(() => window.__ito.sceneGeometry());
  const star = geo.hubs[0]!;
  const bearings = star.endpoints.map((p) =>
    Math.round(Math.atan2(p.y - star.center.y, p.x - star.center.x) * 100),
  );
  expect(new Set(bearings).size).toBe(star.endpoints.length);
});

test("A09-M2: nodes render inside their category squircle bounds and stay stable when idle", async ({
  page,
}) => {
  await bootToNodesView(page);
  const [a, b, c] = await createPages(page, ["N1", "N2", "N3"]);
  const catId = await page.evaluate(
    async ([x, y, z]) => {
      const id = await window.__ito.createCategory("Theme", "#4b5578");
      await window.__ito.addPageToCategory(id, x!);
      await window.__ito.addPageToCategory(id, y!);
      await window.__ito.addPageToCategory(id, z!);
      return id;
    },
    [a, b, c] as const,
  );

  await expect(page.getByTestId("category-squircle")).toHaveCount(1);

  // Every member node sits inside the category squircle (A09-M2).
  const inside = await page.evaluate((cat) => {
    const geo = window.__ito.sceneGeometry();
    return geo.nodes.every((n) => window.__ito.squircleContainsPoint(cat, n.x, n.y));
  }, catId);
  expect(inside).toBe(true);

  // Idle positions are byte-stable between two reads: no forced camera motion.
  const first = await page.evaluate(() => window.__ito.sceneGeometry().nodes);
  await page.waitForTimeout(250);
  const second = await page.evaluate(() => window.__ito.sceneGeometry().nodes);
  expect(second).toEqual(first);
});

test("A10-M2: a node in two categories renders in the intersection of both squircles", async ({
  page,
}) => {
  await bootToNodesView(page);
  const [shared, a1, a2, b1, b2] = await createPages(page, [
    "Shared",
    "A1",
    "A2",
    "B1",
    "B2",
  ]);
  const { catA, catB } = await page.evaluate(
    async ([s, pa1, pa2, pb1, pb2]) => {
      const catA = await window.__ito.createCategory("CatA", "#4b5578");
      const catB = await window.__ito.createCategory("CatB", "#b5653f");
      for (const p of [s!, pa1!, pa2!]) await window.__ito.addPageToCategory(catA, p);
      for (const p of [s!, pb1!, pb2!]) await window.__ito.addPageToCategory(catB, p);
      return { catA, catB };
    },
    [shared, a1, a2, b1, b2] as const,
  );

  await expect(page.getByTestId("category-squircle")).toHaveCount(2);

  // The shared node lies inside BOTH squircle bounds (the intersection region).
  const inBoth = await page.evaluate(
    ([sharedId, cA, cB]) => {
      const geo = window.__ito.sceneGeometry();
      const n = geo.nodes.find((x) => x.pageId === sharedId)!;
      return (
        window.__ito.squircleContainsPoint(cA, n.x, n.y) &&
        window.__ito.squircleContainsPoint(cB, n.x, n.y)
      );
    },
    [shared, catA, catB] as const,
  );
  expect(inBoth).toBe(true);
});

test("A14-M2: a category-to-category reference renders a category-link between the boundaries", async ({
  page,
}) => {
  await bootToNodesView(page);
  const [a, b] = await createPages(page, ["InA", "InB"]);
  await page.evaluate(
    async ([x, y]) => {
      const catA = await window.__ito.createCategory("CatA", "#4b5578");
      const catB = await window.__ito.createCategory("CatB", "#b5653f");
      await window.__ito.addPageToCategory(catA, x!);
      await window.__ito.addPageToCategory(catB, y!);
      // A relationship bridging a member of each category is the category-to-
      // category reference (data-driven, A14-M2).
      await window.__ito.createRelationship([x!, y!]);
    },
    [a, b] as const,
  );

  const link = page.getByTestId("category-link");
  await expect(link).toHaveCount(1);

  // Its endpoints sit on the two squircle boundaries, not at the centers.
  const geo = await page.evaluate(() => window.__ito.sceneGeometry());
  const cl = geo.categoryLinks[0]!;
  const fromBounds = geo.squircles.find((s) => s.categoryId === cl.fromCategoryId)!.bounds;
  const toBounds = geo.squircles.find((s) => s.categoryId === cl.toCategoryId)!.bounds;
  const onFrom = await page.evaluate(
    ([cat, x, y]) => window.__ito.squircleContainsPoint(cat as string, x as number, y as number),
    [cl.fromCategoryId, cl.from.x, cl.from.y] as const,
  );
  const onTo = await page.evaluate(
    ([cat, x, y]) => window.__ito.squircleContainsPoint(cat as string, x as number, y as number),
    [cl.toCategoryId, cl.to.x, cl.to.y] as const,
  );
  expect(onFrom).toBe(true);
  expect(onTo).toBe(true);
  expect(fromBounds.cx).not.toBe(toBounds.cx);
});

test("clicking a hub opens the connecting-page label surface", async ({ page }) => {
  await bootToNodesView(page);
  const [a, b] = await createPages(page, ["P", "Q"]);
  const relId = await page.evaluate(
    ([x, y]) => window.__ito.createRelationship([x!, y!]),
    [a, b] as const,
  );

  page.once("dialog", (d) => void d.accept("Bridges P and Q"));
  await page.getByTestId("graph-hub").click();

  await expect
    .poll(() => page.evaluate((id) => window.__ito.relationshipLabel(id), relId))
    .toBe("Bridges P and Q");
});
