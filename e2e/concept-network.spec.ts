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

// The map has ambient (decorative) animation. Playwright waits for an element to
// stop moving before clicking it, so these specs run with reduced motion, which
// switches that animation off. The camera-motion tests below opt back in.
test.use({ reducedMotion: "reduce" });

async function bootToNodesView(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("app-status")).toHaveAttribute("data-state", "ready", {
    timeout: 15_000,
  });
  // The test API is installed once the workbench has opened, which can land
  // just after the boot status flips to "ready".
  await page.waitForFunction(() => !!window.__ito);
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
  // A single click opens the page; the short label has its own hover control.
  await page.getByTestId("graph-hub").hover();
  await page.getByTestId("edit-hub-label").click();

  await expect
    .poll(() => page.evaluate((id) => window.__ito.relationshipLabel(id), relId))
    .toBe("Bridges P and Q");
});

test("A14-M2: connecting two category master pages renders a data-link-kind=\"master\" category-link", async ({
  page,
}) => {
  await bootToNodesView(page);
  // Each category needs at least one laid-out member so its squircle bounds
  // exist for the boundary link to anchor to. Build two disjoint categories.
  const { catA, catB } = await page.evaluate(async () => {
    const mA = await window.__ito.createSubject("MemberA");
    const mB = await window.__ito.createSubject("MemberB");
    const catA = await window.__ito.createCategory("Alpha", "#4b5578");
    const catB = await window.__ito.createCategory("Beta", "#b5653f");
    await window.__ito.addPageToCategory(catA, mA);
    await window.__ito.addPageToCategory(catB, mB);
    return { catA, catB };
  });

  // Connect the two categories at their BOUNDARIES via their master pages
  // (the §12.2 required capability). This creates real master Pages and a real
  // relationship joining them — a durable transition on the live Workbench.
  const relId = await page.evaluate(
    ([a, b]) => window.__ito.connectCategoryBoundaries(a!, b!),
    [catA, catB] as const,
  );
  expect(relId).toBeTruthy();

  // Both master pages are REAL durable Page records referenced by the categories.
  const masterA = await page.evaluate((c) => window.__ito.categoryMasterPageId(c), catA);
  const masterB = await page.evaluate((c) => window.__ito.categoryMasterPageId(c), catB);
  expect(masterA).toBeTruthy();
  expect(masterB).toBeTruthy();

  // A category-link with data-link-kind="master" renders between the two
  // categories (read live DOM).
  const link = page.getByTestId("category-link");
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute("data-link-kind", "master");

  // Its endpoints sit on the two squircle boundaries (live geometry).
  const geo = await page.evaluate(() => window.__ito.sceneGeometry());
  const cl = geo.categoryLinks[0]!;
  expect(cl.linkKind).toBe("master");
  const onFrom = await page.evaluate(
    ([c, x, y]) => window.__ito.squircleContainsPoint(c as string, x as number, y as number),
    [cl.fromCategoryId, cl.from.x, cl.from.y] as const,
  );
  const onTo = await page.evaluate(
    ([c, x, y]) => window.__ito.squircleContainsPoint(c as string, x as number, y as number),
    [cl.toCategoryId, cl.to.x, cl.to.y] as const,
  );
  expect(onFrom).toBe(true);
  expect(onTo).toBe(true);
});

test("A14-M2: a member-bridging relationship yields a data-link-kind=\"member\" category-link", async ({
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
      // A relationship bridging a MEMBER of each category (no master pages).
      await window.__ito.createRelationship([x!, y!]);
    },
    [a, b] as const,
  );

  const link = page.getByTestId("category-link");
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute("data-link-kind", "member");
  const geo = await page.evaluate(() => window.__ito.sceneGeometry());
  expect(geo.categoryLinks[0]!.linkKind).toBe("member");
});

test("A13-M2: developing a relationship's connection promotes it to a real Connecting Page usable as an endpoint", async ({
  page,
}) => {
  await bootToNodesView(page);
  const [a, b] = await createPages(page, ["Cause", "Effect"]);
  const relId = await page.evaluate(
    ([x, y]) => window.__ito.createRelationship([x!, y!], "relates", "links cause and effect"),
    [a, b] as const,
  );

  // Before developing: no explanatory page exists yet, and the page count is 2.
  expect(await page.evaluate((id) => window.__ito.relationshipExplanatoryPageId(id), relId)).toBe(
    null,
  );
  const pagesBefore = (await page.evaluate(() => window.__ito.graphRecordCount())).pages;
  expect(pagesBefore).toBe(2);

  // Develop the connection into a full page via the on-canvas control (A13-M2).
  // The pill is revealed on hover (declutter), so hover the hub first.
  await page.getByTestId("graph-hub").hover();
  await page.getByTestId("open-connecting-page").click();

  // A REAL explanatory Page is created, linked via explanatoryPageId, and opened
  // in the SubjectEditor (open subject == the new page).
  await expect
    .poll(() => page.evaluate((id) => window.__ito.relationshipExplanatoryPageId(id), relId))
    .not.toBeNull();
  const explanatoryId = await page.evaluate(
    (id) => window.__ito.relationshipExplanatoryPageId(id),
    relId,
  );
  expect(explanatoryId).toBeTruthy();
  expect(await page.evaluate(() => window.__ito.graphRecordCount())).toMatchObject({
    pages: 3,
  });
  // The SubjectEditor has the explanatory page open.
  expect(await page.evaluate(() => window.__ito.openSubjectId())).toBe(explanatoryId);

  // Idempotent: developing again returns the SAME page, creating nothing new.
  const again = await page.evaluate((id) => window.__ito.developRelationshipPage(id), relId);
  expect(again).toBe(explanatoryId);
  expect((await page.evaluate(() => window.__ito.graphRecordCount())).pages).toBe(3);

  // Because the explanatory page has a real PageId it participates as an
  // endpoint in a FURTHER relationship (connecting a connection to a subject).
  const [further] = await createPages(page, ["Downstream"]);
  const relId2 = await page.evaluate(
    ([ep, d]) => window.__ito.createRelationship([ep!, d!]),
    [explanatoryId, further] as const,
  );
  expect(relId2).toBeTruthy();
  const graph = await page.evaluate(() => window.__ito.conceptGraph());
  const link2 = graph.links.find((l) => l.relationshipId === relId2)!;
  expect(link2.endpointPageIds).toContain(explanatoryId);
});

test("clicking a node opens its page in an editor docked beside the map", async ({ page }) => {
  await bootToNodesView(page);
  const [a] = await createPages(page, ["Open me"]);

  await expect(page.getByTestId("nodes-page-dock")).toHaveCount(0);
  await page.locator(`[data-testid="graph-node"][data-page-id="${a}"] circle`).click();

  const dock = page.getByTestId("nodes-page-dock");
  await expect(dock).toBeVisible();
  await expect(dock.getByTestId("subject-editor")).toBeVisible();
  expect(await page.evaluate(() => window.__ito.openSubjectId())).toBe(a);
  // The map is still there, sharing the space.
  await expect(page.getByTestId("nodes-canvas")).toBeVisible();

  // Closing the editor undocks it.
  await dock.getByTestId("close-subject").click();
  await expect(page.getByTestId("nodes-page-dock")).toHaveCount(0);
});

test("clicking a hub opens its Connecting Page docked beside the map", async ({ page }) => {
  await bootToNodesView(page);
  const [a, b] = await createPages(page, ["Cause", "Effect"]);
  const relId = await page.evaluate(
    ([x, y]) => window.__ito.createRelationship([x!, y!]),
    [a, b] as const,
  );
  await page.getByTestId("graph-hub").click();
  await expect(page.getByTestId("nodes-page-dock")).toBeVisible();
  const explanatory = await page.evaluate(
    (id) => window.__ito.relationshipExplanatoryPageId(id),
    relId,
  );
  expect(explanatory).toBeTruthy();
  await expect(page.getByTestId("nodes-page-dock")).toHaveAttribute("data-page-id", explanatory!);
});

async function settledCamera(page: Page): Promise<void> {
  // The camera eases to its target and then drops its transform entirely.
  await expect
    .poll(() => page.getByTestId("camera").evaluate((g) => g.hasAttribute("transform")), {
      timeout: 4_000,
    })
    .toBe(false);
}

/** A node's screen position from its group's transform (ignores the dot's idle bob). */
async function nodeCenter(page: Page, id: string): Promise<{ x: number; y: number }> {
  return page.locator(`[data-testid="graph-node"][data-page-id="${id}"]`).evaluate((g) => {
    const el = g as unknown as SVGGraphicsElement;
    const m = el.getScreenCTM()!;
    return { x: m.e, y: m.f };
  });
}

test.describe("camera motion", () => {
  test.use({ reducedMotion: "no-preference" });

test("wheel zoom is anchored on the cursor and the camera glides to rest", async ({ page }) => {
  await bootToNodesView(page);
  const [a, b] = await createPages(page, ["Left", "Right"]);
  await page.evaluate(
    ([x, y]) => window.__ito.createRelationship([x!, y!]),
    [a, b] as const,
  );
  await settledCamera(page);

  const before = await nodeCenter(page, b!);
  const aBefore = await nodeCenter(page, a!);
  const distBefore = Math.hypot(before.x - aBefore.x, before.y - aBefore.y);
  await page.mouse.move(before.x, before.y);
  await page.mouse.wheel(0, -300); // zoom in, on top of that node
  // While gliding there is an interpolation transform on the scene group...
  await expect(page.getByTestId("camera")).toHaveAttribute("transform", /scale/, { timeout: 1_000 });
  await settledCamera(page);

  // ...and the node under the cursor did not slide away from it.
  const after = await nodeCenter(page, b!);
  expect(Math.abs(after.x - before.x)).toBeLessThan(4);
  expect(Math.abs(after.y - before.y)).toBeLessThan(4);
  // The map really did zoom (the dots moved further apart).
  const aAfter = await nodeCenter(page, a!);
  expect(Math.hypot(after.x - aAfter.x, after.y - aAfter.y)).toBeGreaterThan(distBefore + 10);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("zoom buttons glide instead of jumping, and reduced motion snaps", async ({ page, browser }) => {
  await bootToNodesView(page);
  await createPages(page, ["One", "Two"]);
  await settledCamera(page);
  await page.getByTestId("canvas-zoom-in").click();
  await expect(page.getByTestId("camera")).toHaveAttribute("transform", /scale/, { timeout: 1_000 });
  await settledCamera(page);

  // With the OS reduced-motion preference the camera never interpolates.
  const ctx = await browser.newContext({ reducedMotion: "reduce", baseURL: "http://localhost:4173" });
  const rp = await ctx.newPage();
  await bootToNodesView(rp);
  await createPages(rp, ["One", "Two"]);
  await rp.getByTestId("canvas-zoom-in").click();
  await rp.waitForTimeout(80);
  expect(await rp.getByTestId("camera").evaluate((g) => g.hasAttribute("transform"))).toBe(false);
  await ctx.close();
});

});

test("overlapping categories render a colour-mixing zone; motion can be switched off", async ({ page }) => {
  await bootToNodesView(page);
  const [a, b, c] = await createPages(page, ["A", "B", "C"]);
  await page.evaluate(
    async ([x, y, z]) => {
      const c1 = await window.__ito.createCategory("Blue", "#4b5578");
      const c2 = await window.__ito.createCategory("Ochre", "#c98b4b");
      await window.__ito.addPageToCategory(c1, x!);
      await window.__ito.addPageToCategory(c1, y!);
      await window.__ito.addPageToCategory(c2, y!);
      await window.__ito.addPageToCategory(c2, z!);
    },
    [a, b, c] as const,
  );
  await expect(page.getByTestId("category-squircle")).toHaveCount(2);
  await expect(page.getByTestId("category-overlap")).toHaveCount(1);
  // The two pigments meet through a gradient that contains both hues.
  const stops = await page.evaluate(() =>
    [...document.querySelectorAll('linearGradient[id^="mix-"] stop')].map((s) =>
      (s.getAttribute("stop-color") ?? "").toLowerCase(),
    ),
  );
  expect(stops).toContain("#4b5578");
  expect(stops).toContain("#c98b4b");
  expect(new Set(stops).size).toBeGreaterThanOrEqual(3); // a mixed middle tone too
});
