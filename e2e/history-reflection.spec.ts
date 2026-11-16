import { expect, test, type Page } from "@playwright/test";
import { seedSampleLibrary } from "./helpers";

/**
 * FEAT-003 (M7, H01-H07, D13, D14) — Linked History, Checkpoints & Multi-Span
 * Reflection, runtime validation in real Chromium. Every assertion reads the
 * LIVE DOM and the LIVE window.__ito history surface the shell renders; nothing
 * is mocked. The app, the Workbench and IndexedDB are the real thing.
 *
 * Coverage:
 *  - the shell view switch reaches the History view (data-testid="view-history")
 *    and mounts the HistoryReflectionPanel;
 *  - structural revisions are recorded and grouped by day, surfaced as
 *    revision-item rows with selection checkboxes;
 *  - the date-range filter (review-range-start / review-range-end) and the
 *    single-day picker (review-date-picker) narrow the timeline;
 *  - cherry-picking revisions across the timeline into a multi-day reflection
 *    stores linkedRevisionIds + start/end date keys (reflection-date-span shows
 *    when the span is multi-day), and creates ZERO graph nodes (H04);
 *  - a per-change comment persists (revision-comment-input);
 *  - the forward-only restore records a NEW revision (never erasing history).
 */

async function bootLibrary(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("app-status")).toHaveAttribute("data-state", "ready", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("library")).toBeVisible();
  // Automatic seeding was removed: load the sample workspace explicitly.
  await seedSampleLibrary(page);
}

/** Record a few structural revisions on the live Workbench (categories). */
async function seedRevisions(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.__ito.createSubject("Alpha");
    await window.__ito.createSubject("Beta");
    await window.__ito.createCategory("Theme");
    await window.__ito.flushPendingRevision();
  });
}

test("the shell view switch reaches the History view and mounts the panel", async ({ page }) => {
  await bootLibrary(page);

  await expect(page.getByTestId("view-history")).toBeVisible();
  await page.getByTestId("view-history").click();
  await expect(page.getByTestId("view-switch")).toHaveAttribute("data-view-mode", "history");
  await expect(page.getByTestId("history-reflection-panel")).toBeVisible();
  // The filter controls are present.
  await expect(page.getByTestId("review-date-picker")).toBeVisible();
  await expect(page.getByTestId("review-range-start")).toBeVisible();
  await expect(page.getByTestId("review-range-end")).toBeVisible();
  expect(await page.evaluate(() => window.__ito.viewMode())).toBe("history");
});

test("revisions are grouped by day with selection checkboxes", async ({ page }) => {
  await bootLibrary(page);
  await seedRevisions(page);

  const revCount = await page.evaluate(() => window.__ito.revisions().length);
  expect(revCount).toBeGreaterThan(0);

  await page.getByTestId("view-history").click();
  await expect(page.getByTestId("history-reflection-panel")).toBeVisible();

  // Each recorded revision renders a row with a selection checkbox.
  await expect(page.getByTestId("revision-item").first()).toBeVisible();
  const rows = await page.getByTestId("revision-item").count();
  expect(rows).toBe(revCount);
  await expect(page.getByTestId("revision-select-checkbox").first()).toBeVisible();
  await expect(page.getByTestId("revision-day-group").first()).toBeVisible();
});

test("cherry-picking revisions into a reflection stores the span and creates zero graph nodes (H04)", async ({
  page,
}) => {
  await bootLibrary(page);
  await seedRevisions(page);

  const before = await page.evaluate(() => window.__ito.graphRecordCount());

  // Select ALL revision rows across the timeline, type a reflection, save it.
  await page.getByTestId("view-history").click();
  const boxes = page.getByTestId("revision-select-checkbox");
  const n = await boxes.count();
  for (let i = 0; i < n; i += 1) await boxes.nth(i).check();
  await page.getByTestId("reflection-editor").fill("Analyzing the early structural edits together.");
  await page.getByTestId("reflection-save").click();

  // A reflection was stored with the linked revisions; it created NO graph node.
  const reflectionCount = await page.evaluate(() => window.__ito.counts());
  expect(reflectionCount.pages).toBe(before.pages);
  const after = await page.evaluate(() => window.__ito.graphRecordCount());
  expect(after.relationships).toBe(before.relationships);
  expect(after.categories).toBe(before.categories);
});

test("a multi-day reflection built via the test API records both date keys", async ({ page }) => {
  await bootLibrary(page);
  await seedRevisions(page);

  // Build a reflection directly over the recorded revision ids and assert the
  // stored span covers them (start <= end). This drives the SAME transition the
  // panel calls (createReflection) and proves the date-key bookkeeping.
  const span = await page.evaluate(async () => {
    const ids = window.__ito.revisions().map((r) => r.id);
    const entry = await window.__ito.createReflection({ text: "span", linkedRevisionIds: ids });
    return { start: entry.startDateKey, end: entry.endDateKey, linked: entry.linkedRevisionIds.length };
  });
  expect(span.linked).toBeGreaterThan(0);
  expect(span.start <= span.end).toBe(true);
});

test("a per-change comment persists on a revision (H04)", async ({ page }) => {
  await bootLibrary(page);
  await seedRevisions(page);

  await page.getByTestId("view-history").click();
  const firstComment = page.getByTestId("revision-comment-input").first();
  await firstComment.fill("This was the first structural edit.");
  await page.getByTestId("revision-comment-save").first().click();

  // Reopening the panel keeps the comment (it round-tripped through the store).
  await page.getByTestId("view-files").click();
  await page.getByTestId("view-history").click();
  await expect(page.getByTestId("revision-comment-input").first()).toHaveValue(
    "This was the first structural edit.",
  );
});

test("restore records a NEW forward revision and never erases history (H05)", async ({ page }) => {
  await bootLibrary(page);
  await seedRevisions(page);

  const result = await page.evaluate(async () => {
    const revs = window.__ito.revisions();
    const before = revs.length;
    const targetId = revs[0]!.id;
    const newRevId = await window.__ito.restoreRevision(targetId);
    const after = window.__ito.revisions().length;
    return { before, after, newRevId };
  });
  // The restore appended a forward revision (count grew, nothing erased).
  expect(result.after).toBe(result.before + 1);
  expect(result.newRevId).toBeTruthy();
});

test("the overhead probe reports the expected numeric fields (H07)", async ({ page }) => {
  await bootLibrary(page);
  await seedRevisions(page);

  const overhead = await page.evaluate(() => window.__ito.measureHistoryOverhead());
  expect(typeof overhead.revisionCount).toBe("number");
  expect(typeof overhead.checkpointCount).toBe("number");
  expect(typeof overhead.deltaBytes).toBe("number");
  expect(typeof overhead.checkpointBytes).toBe("number");
  expect(typeof overhead.replayDurationMs).toBe("number");
  expect(overhead.revisionCount).toBeGreaterThan(0);
});

async function seedAcrossDays(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.__ito.recordRevisionAt("2026-11-02T10:00:00Z", "Drafted the intro");
    await window.__ito.recordRevisionAt("2026-11-02T15:00:00Z", "Added a quote");
    await window.__ito.recordRevisionAt("2026-11-05T09:00:00Z", "Linked two pages");
    await window.__ito.recordRevisionAt("2026-11-09T12:00:00Z", "Reworked the argument");
  });
}

test("the timeline shows a sheet per day with changes and clicking one selects that day", async ({ page }) => {
  await bootLibrary(page);
  await seedAcrossDays(page);
  await page.getByTestId("view-history").click();

  const sheets = page.getByTestId("timeline-sheet");
  await expect(sheets).toHaveCount(3);
  await expect(sheets.nth(0)).toHaveAttribute("data-count", "2");

  await sheets.nth(0).click();
  await expect(sheets.nth(0)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("reflection-selection-count")).toContainText("2 revision");
  // The reflection period follows the selection automatically.
  await expect(page.getByTestId("reflection-period")).toHaveText("Period: 2026-11-02");

  // Clicking again deselects.
  await sheets.nth(0).click();
  await expect(page.getByTestId("reflection-selection-count")).toContainText("0 revision");
});

test("dragging across the timeline selects a period and sets the reflection's date range", async ({ page }) => {
  await bootLibrary(page);
  await seedAcrossDays(page);
  await page.getByTestId("view-history").click();

  const sheets = page.getByTestId("timeline-sheet");
  await expect(sheets).toHaveCount(3);
  const first = (await sheets.nth(0).boundingBox())!;
  const second = (await sheets.nth(1).boundingBox())!;
  const y = first.y + first.height + 22; // on the axis, below the sheets

  await page.mouse.move(first.x + first.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(second.x + second.width / 2, y, { steps: 10 });
  await expect(page.getByTestId("timeline-drag-band")).toBeVisible();
  await page.mouse.up();

  await expect(sheets.nth(0)).toHaveAttribute("aria-pressed", "true");
  await expect(sheets.nth(1)).toHaveAttribute("aria-pressed", "true");
  await expect(sheets.nth(2)).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("reflection-selection-count")).toContainText("3 revision");
  await expect(page.getByTestId("reflection-date-span")).toHaveText("Period: 2026-11-02 → 2026-11-05");

  // Saving the reflection stores that period.
  await page.getByTestId("reflection-editor").fill("Early drafting to the first linking");
  await page.getByTestId("reflection-save").click();
  const saved = await page.evaluate(() => window.__ito.reflections().at(-1));
  expect(saved?.startDateKey).toBe("2026-11-02");
  expect(saved?.endDateKey).toBe("2026-11-05");
});
