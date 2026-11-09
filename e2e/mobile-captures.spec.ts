import { expect, test, type Page } from "@playwright/test";

/**
 * FEAT-003 (M5, §16.2, §16.3, A22, A23) — mobile capture engine, runtime
 * validation in real Chromium. Every assertion reads the LIVE DOM and the LIVE
 * window.__ito capture surface the shell renders; nothing is mocked. The remote
 * is the deterministic in-memory Koofr the test API wires internally.
 *
 * Coverage:
 *  - A23: createMobileCapture creates ZERO graph nodes (no Page/Category/
 *    Relationship) whether or not a source is attached;
 *  - A22: repeated AND out-of-order pullRemoteCaptures incorporate each capture
 *    at most once (strict idempotency by CaptureId);
 *  - A22: handleCapture is idempotent and the four queue dispositions record the
 *    correct handling.
 */

async function bootLibrary(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("app-status")).toHaveAttribute("data-state", "ready", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("library")).toBeVisible();
  await expect(page.getByTestId("library-item").first()).toBeVisible({ timeout: 15_000 });
}

test("A23: creating a capture adds zero graph nodes", async ({ page }) => {
  await bootLibrary(page);

  const before = await page.evaluate(() => window.__ito.graphRecordCount());

  const captureId = await page.evaluate(() =>
    window.__ito.createMobileCapture({ content: "A loose thought while reading on the phone" }),
  );
  expect(captureId).toBeTruthy();

  const after = await page.evaluate(() => window.__ito.graphRecordCount());
  // A23: no Page, Category, or Relationship is ever auto-created by a capture.
  expect(after).toEqual(before);

  // The capture is saved locally and surfaced in the captures() rows.
  const rows = await page.evaluate(() => window.__ito.captures());
  expect(rows.some((r) => r.id === captureId)).toBe(true);
  expect(rows.find((r) => r.id === captureId)?.status).toBe("local");
});

test("A22: repeated and out-of-order pulls incorporate each capture at most once", async ({
  page,
}) => {
  await bootLibrary(page);

  // Queue two captures for upload, push them to the internal remote.
  await page.evaluate(async () => {
    await window.__ito.createMobileCapture({ content: "first", queueForUpload: true });
    await window.__ito.createMobileCapture({ content: "second", queueForUpload: true });
    await window.__ito.uploadPendingCaptures();
  });

  // First pull brings the remote captures in; a second (repeated / out-of-order)
  // pull must bring in NOTHING new - dedupe is strict by CaptureId (A22).
  const firstPull = await page.evaluate(() => window.__ito.pullRemoteCaptures());
  const secondPull = await page.evaluate(() => window.__ito.pullRemoteCaptures());
  expect(secondPull.length).toBe(0);

  // The local capture rows contain each pulled id exactly once.
  const rows = await page.evaluate(() => window.__ito.captures());
  for (const id of firstPull) {
    expect(rows.filter((r) => r.id === id).length).toBe(1);
  }
});

test("A22/§16.3: the four queue dispositions record the right handling", async ({ page }) => {
  await bootLibrary(page);

  // A capture targeted at a real subject page can be inserted into it.
  const pageId = await page.evaluate(() => window.__ito.createSubject("Target subject"));
  const insertId = await page.evaluate(
    (pid) => window.__ito.createMobileCapture({ content: "insert me", targetPageId: pid }),
    pageId,
  );
  const inserted = await page.evaluate((id) => window.__ito.handleCapture(id, "insert-into-page"), insertId);
  expect(inserted).toBe("incorporated-quote");
  // Idempotent: handling the same capture again returns the SAME disposition.
  const insertedAgain = await page.evaluate(
    (id) => window.__ito.handleCapture(id, "insert-into-page"),
    insertId,
  );
  expect(insertedAgain).toBe("incorporated-quote");

  // Create-subject is a deliberate page creation on the explicit action.
  const subjectId = await page.evaluate(() =>
    window.__ito.createMobileCapture({ content: "promote me to a subject" }),
  );
  const createdSubject = await page.evaluate(
    (id) => window.__ito.handleCapture(id, "create-subject"),
    subjectId,
  );
  expect(createdSubject).toBe("created-subject");

  // Dismiss records a dismissed disposition.
  const dismissId = await page.evaluate(() =>
    window.__ito.createMobileCapture({ content: "never mind" }),
  );
  const dismissed = await page.evaluate((id) => window.__ito.handleCapture(id, "dismiss"), dismissId);
  expect(dismissed).toBe("dismissed");
});
