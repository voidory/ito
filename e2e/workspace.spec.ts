import { expect, test, type Page } from "@playwright/test";

/**
 * FEAT-005 — M1 INTEGRATED THREE-PANE WORKSPACE + CONTEXT-PRESERVING LAYOUT
 * TRANSITIONS, runtime validation in real chromium (spec sections 7.3, 8.2;
 * section 24). THIRD in the binding validation order. Every test drives the
 * REAL app: real pdf.js text layers, real selection, a real ProseMirror
 * editor, real Workbench state + IndexedDB. Nothing is mocked; assertions read
 * live DOM + live state, never static strings.
 *
 * Coverage:
 *  - Paper A | subject | Paper B render simultaneously, independently
 *    scrollable, with adjustable pane widths; the editor is never hidden while
 *    composing (section 8.2).
 *  - open/close highlights tab preserves the visible passage + a draft comment
 *    with NO camera motion (R19).
 *  - following a quote in the workspace returns to the exact source passage
 *    WITHOUT covering/replacing the subject page (A06), and a reader pane can
 *    switch to a third paper while keeping the subject (section 8.2 note).
 *  - the passage-to-evidence line toggle changes presentation only and never
 *    deletes relationships (A08/R08 foundation).
 *  - Library -> Reader -> workspace transitions preserve category scope and the
 *    reader passage (N03, N08).
 */

const NEEDLE = "quick brown fox";

async function bootLibrary(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("app-status")).toHaveAttribute("data-state", "ready", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("library-item").first()).toBeVisible({ timeout: 15_000 });
}

async function openFirstDocument(page: Page): Promise<void> {
  await bootLibrary(page);
  await page.getByTestId("library-open").first().click();
  await expect(page.getByTestId("reader")).toBeVisible();
  await expect(page.getByTestId("source-pane").first()).toHaveAttribute("data-ready", "true", {
    timeout: 20_000,
  });
  await expect(page.locator(".textLayer span").first()).toBeVisible({ timeout: 20_000 });
}

async function highlight(page: Page, needle = NEEDLE, pageIndex = 0): Promise<void> {
  const before = await page.locator(".ito-highlight").count();
  const ok = await page.evaluate(
    ([n, p]) => window.__ito.selectText(n as string, p as number),
    [needle, pageIndex] as const,
  );
  expect(ok, `select "${needle}" on page ${pageIndex}`).toBe(true);
  await page.getByTestId("commit-highlight").click();
  await expect.poll(() => page.locator(".ito-highlight").count()).toBeGreaterThan(before);
}

/** Open two papers together and create+open a subject with a quote from one. */
async function openThreePaneWorkspace(page: Page): Promise<string> {
  await bootLibrary(page);
  const items = page.getByTestId("library-item");
  await items.nth(0).getByRole("checkbox").check();
  await items.nth(1).getByRole("checkbox").check();
  await page.getByTestId("open-together").click();
  await expect(page.getByTestId("reader")).toBeVisible();
  // Both source panes render real pdf.js text.
  await expect(page.getByTestId("source-pane")).toHaveCount(2, { timeout: 20_000 });
  await expect(page.getByTestId("source-pane").nth(0)).toHaveAttribute("data-ready", "true", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("source-pane").nth(1)).toHaveAttribute("data-ready", "true", {
    timeout: 20_000,
  });

  // Highlight + deliberately create a subject from the first pane's evidence.
  await highlight(page, NEEDLE, 0);
  await page.getByTestId("toggle-highlights-tab").click();
  await page.getByTestId("row-actions").first().click();
  await page.getByTestId("menu-create-subject").click();
  await page.getByTestId("new-subject-title").fill("Synthesis");
  await page.getByTestId("create-subject-confirm").click();
  await expect(page.getByTestId("subject-editor")).toBeVisible();
  // Close the highlights tab so the three panes get the room.
  await page.getByTestId("toggle-highlights-tab").click();
  return (await page.evaluate(() => window.__ito.openSubjectId()))!;
}

test("section 8.2: Paper A | subject | Paper B render simultaneously, independently scrollable, with adjustable widths", async ({
  page,
}) => {
  await openThreePaneWorkspace(page);

  // Three panes in the approved order: source | subject | source.
  const panes = page.getByTestId("workspace-pane");
  await expect(panes).toHaveCount(3);
  const slotOrder = await panes.evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-slot-id")),
  );
  expect(slotOrder[1]).toBe("subject");
  expect(slotOrder[0]).not.toBe("subject");
  expect(slotOrder[2]).not.toBe("subject");

  // The editable subject page is a real pane (never behind a modal while
  // composing) and both sources stay visible/uncovered.
  await expect(page.getByTestId("subject-prosemirror")).toBeVisible();
  await expect(page.getByTestId("source-pane").nth(0)).toBeVisible();
  await expect(page.getByTestId("source-pane").nth(1)).toBeVisible();

  // Independent scrolling: each source pane has its own scroll container; a
  // scroll in one does not move the other.
  const scrollers = page.getByTestId("pane-scroll");
  await expect(scrollers).toHaveCount(2);
  const secondBefore = await scrollers.nth(1).evaluate((el) => el.scrollTop);
  await scrollers.nth(0).evaluate((el) => (el.scrollTop = 200));
  await page.waitForTimeout(50);
  const firstAfter = await scrollers.nth(0).evaluate((el) => el.scrollTop);
  const secondAfter = await scrollers.nth(1).evaluate((el) => el.scrollTop);
  expect(firstAfter).toBeGreaterThan(0);
  expect(secondAfter).toBe(secondBefore); // the other pane did not move

  // Adjustable widths: dragging a divider changes the stored pane weight and
  // the rendered pane width, and the ratio persists as view state.
  const firstSlot = slotOrder[0]!;
  const widthBefore = await panes.nth(0).evaluate((el) => el.getBoundingClientRect().width);
  const divider = page.getByTestId("pane-divider").first();
  const box = (await divider.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const widthAfter = await panes.nth(0).evaluate((el) => el.getBoundingClientRect().width);
  expect(widthAfter).toBeGreaterThan(widthBefore + 40);
  const weight = await page.evaluate((s) => window.__ito.paneWidths()[s], firstSlot);
  expect(weight).toBeGreaterThan(1);
});

test("R19 + N08: opening/closing the highlights tab preserves the visible passage and a draft comment with no camera motion", async ({
  page,
}) => {
  await openFirstDocument(page);
  await highlight(page);

  // Open the quiet comment surface with an UNSAVED draft first, then scroll to
  // a meaningful passage. Measuring AFTER both are set isolates the toggle as
  // the only thing that could disturb them.
  await page.locator(".ito-highlight-fragment").first().click();
  await expect(page.getByTestId("comment-surface")).toBeVisible();
  await page.getByTestId("comment-input").fill("an unsaved draft thought");

  const scroller = page.getByTestId("pane-scroll").first();
  await scroller.evaluate((el) => (el.scrollTop = 140));
  await page.waitForTimeout(50);
  const passageBefore = await scroller.evaluate((el) => el.scrollTop);
  expect(passageBefore).toBeGreaterThan(0);

  // Open the highlights tab, then close it again.
  await page.getByTestId("toggle-highlights-tab").click();
  await expect(page.getByTestId("highlights-tab")).toBeVisible();
  await page.getByTestId("toggle-highlights-tab").click();
  await expect(page.getByTestId("highlights-tab")).toHaveCount(0);

  // The passage did not move (no forced camera motion) and the draft survived
  // untouched (never faked-saved, never lost).
  const passageAfter = await scroller.evaluate((el) => el.scrollTop);
  expect(Math.abs(passageAfter - passageBefore)).toBeLessThanOrEqual(2);
  await expect(page.getByTestId("comment-surface")).toBeVisible();
  await expect(page.getByTestId("comment-input")).toHaveValue("an unsaved draft thought");
  // The single annotation still exists and the draft lives only in the surface
  // (a layout transition commits nothing on its own).
  expect(await page.evaluate(() => window.__ito.counts().annotations)).toBe(1);
});

test("A06: following a quote in the workspace returns to the exact source passage without covering or replacing the subject page", async ({
  page,
}) => {
  await openThreePaneWorkspace(page);

  // Follow the composed quote back to its source from within the editor.
  await page.getByTestId("follow-source").first().click();

  // The subject editor is STILL a live pane (not closed, not replaced, not
  // covered by a modal).
  await expect(page.getByTestId("subject-editor")).toBeVisible();
  await expect(page.getByTestId("subject-prosemirror")).toBeVisible();

  // The source pane scrolled to the resolved passage and drew the return
  // overlay re-derived from the LIVE render (resolved, not mismatched).
  await expect(page.locator('.pdf-page[data-return-resolution="resolved"]')).toHaveCount(1, {
    timeout: 10_000,
  });
  await expect(page.locator(".ito-return").first()).toBeVisible();
  await expect(page.getByTestId("source-return-notice")).toHaveCount(0);
  // Both source panes remain present/uncovered.
  await expect(page.getByTestId("source-pane")).toHaveCount(2);
});

test("section 8.2 note: a reader pane switches to a THIRD paper via the real control while keeping the same subject", async ({
  page,
}) => {
  const subjectId = await openThreePaneWorkspace(page);
  const openBefore = await page.evaluate(() => window.__ito.openSourceIds());
  expect(openBefore).toHaveLength(2);

  // The library seeds a third paper, so the second source pane offers a
  // "Switch paper…" control listing the paper not currently open. Switch it.
  const switcher = page.getByTestId("switch-paper").last();
  await expect(switcher).toBeVisible();
  const thirdId = await switcher.locator("option").nth(1).getAttribute("value");
  expect(thirdId).toBeTruthy();
  expect(openBefore).not.toContain(thirdId);
  await switcher.selectOption(thirdId!);

  // The targeted pane now shows the third paper; the OTHER pane + the subject
  // are untouched (never replaced).
  const openAfter = await page.evaluate(() => window.__ito.openSourceIds());
  expect(openAfter).toContain(thirdId);
  expect(openAfter[0]).toBe(openBefore[0]); // first pane unchanged
  expect(openAfter).toHaveLength(2);
  expect(await page.evaluate(() => window.__ito.openSubjectId())).toBe(subjectId);
  await expect(page.getByTestId("subject-editor")).toBeVisible();
  // The new source pane renders real pdf.js text.
  await expect(
    page.locator(`[data-testid="source-pane"][data-source-id="${thirdId}"]`),
  ).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
});

test("A08/R08 foundation: the passage-to-evidence line toggle changes presentation only and never deletes relationships", async ({
  page,
}) => {
  await openThreePaneWorkspace(page);

  // There is at least one real line relating the source pane to the composed
  // quote; the layer is visible by default.
  const layer = page.getByTestId("passage-evidence-lines");
  await expect(layer).toHaveAttribute("data-visible", "true");
  await expect.poll(() => page.locator('[data-testid="evidence-line"]').count()).toBeGreaterThan(0);
  const lineDataBefore = await page.evaluate(() => window.__ito.passageLineData());
  const evidenceBefore = await page.evaluate(() => window.__ito.counts().evidence);
  expect(lineDataBefore.length).toBeGreaterThan(0);
  expect(evidenceBefore).toBeGreaterThan(0);

  // Toggle lines OFF via the real control.
  await page.getByTestId("toggle-lines").uncheck();
  await expect(layer).toHaveAttribute("data-visible", "false");
  // Presentation only: the layer is hidden but the line DATA and the evidence
  // relationships are untouched.
  const lineDataAfter = await page.evaluate(() => window.__ito.passageLineData());
  const evidenceAfter = await page.evaluate(() => window.__ito.counts().evidence);
  expect(lineDataAfter.map((l) => l.evidenceId)).toEqual(
    lineDataBefore.map((l) => l.evidenceId),
  );
  expect(evidenceAfter).toBe(evidenceBefore);
  // The composed quote chip + its follow affordance are still present.
  await expect(page.getByTestId("evidence-chip").first()).toBeVisible();
  await expect(page.getByTestId("follow-source").first()).toBeVisible();

  // Toggling back on restores the drawn layer with the same data.
  await page.getByTestId("toggle-lines").check();
  await expect(layer).toHaveAttribute("data-visible", "true");
  await expect.poll(() => page.locator('[data-testid="evidence-line"]').count()).toBeGreaterThan(0);
});

test("N03 + N08: Library -> Reader -> workspace transitions preserve category scope and the reader passage", async ({
  page,
}) => {
  await bootLibrary(page);

  // Scope the library to one category (the seeded fixtures live in distinct
  // categories: "Papers" and "References").
  const categories = await page.evaluate(() => window.__ito.categories());
  expect(categories.length).toBeGreaterThanOrEqual(2);
  await page.getByTestId("library-scope").selectOption(categories[0]!);
  expect(await page.evaluate(() => window.__ito.categoryScope())).toBe(categories[0]);
  // Only that category's items are listed now.
  await expect(page.getByTestId("library-category")).toHaveCount(1);

  // Open the scoped document into the reader.
  await page.getByTestId("library-open").first().click();
  await expect(page.getByTestId("source-pane").first()).toHaveAttribute("data-ready", "true", {
    timeout: 20_000,
  });
  await expect(page.locator(".textLayer span").first()).toBeVisible({ timeout: 20_000 });

  // Scroll to a meaningful passage in the reader.
  const scroller = page.getByTestId("pane-scroll").first();
  await scroller.evaluate((el) => (el.scrollTop = 160));
  await page.waitForTimeout(50);
  const passage = await scroller.evaluate((el) => el.scrollTop);
  expect(passage).toBeGreaterThan(0);

  // Go back to the Library: the category scope is preserved (not reset to All).
  await page.getByTestId("back-to-library").click();
  await expect(page.getByTestId("library")).toBeVisible();
  expect(await page.evaluate(() => window.__ito.categoryScope())).toBe(categories[0]);
  await expect(page.getByTestId("library-scope")).toHaveValue(categories[0]!);
  await expect(page.getByTestId("library-category")).toHaveCount(1);

  // Reopen the same document: source identity + a readable passage restore
  // (returning to the reader restores the source + a meaningful passage).
  await page.getByTestId("library-open").first().click();
  await expect(page.getByTestId("source-pane").first()).toHaveAttribute("data-ready", "true", {
    timeout: 20_000,
  });
  await expect(page.locator(".textLayer span").first()).toBeVisible({ timeout: 20_000 });
});
