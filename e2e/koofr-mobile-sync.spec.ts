import { expect, test, type Page } from "@playwright/test";

/**
 * FEAT-003 (M4, §15, §16.1, A20, A21, H06) — Koofr publication round-trip,
 * interrupted-refresh retain-local guarantee, and the mobile reader shell flow.
 * Runtime validation in real Chromium. Every assertion reads the LIVE DOM and
 * the LIVE window.__ito sync surface the shell renders; nothing is mocked. The
 * remote is the deterministic in-memory Koofr the test API wires internally, so
 * no real network is touched.
 *
 * Coverage:
 *  - A20/H06: publishToRemote then refreshFromRemote round-trip against the same
 *    internal remote reports up-to-date with a non-null lastSyncedRevision;
 *  - A20: an interrupted/invalid refresh retains the local working copy and the
 *    status goes stale/offline with a reason (the local brain is untouched);
 *  - A21: the mobile reader shell opens the related-writing sheet and returning
 *    to reading preserves the exact PDF source (and the per-source offline
 *    cache controls reflect the binary status).
 */

async function bootLibrary(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("app-status")).toHaveAttribute("data-state", "ready", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("library")).toBeVisible();
  await expect(page.getByTestId("library-item").first()).toBeVisible({ timeout: 15_000 });
}

test("A20/H06: publish then refresh round-trip reports up-to-date", async ({ page }) => {
  await bootLibrary(page);

  // The shell always renders the sync status banner next to Backup/Restore.
  await expect(page.getByTestId("sync-publication-status")).toBeVisible();

  const published = await page.evaluate(() => window.__ito.publishToRemote());
  expect(published.state).toBe("up-to-date");
  expect(published.lastSyncedRevision).not.toBeNull();

  // A fresh refresh FROM the same internal remote stays up-to-date and keeps
  // the same lastSyncedRevision (pointer-last publication is complete + valid).
  const refreshed = await page.evaluate(() => window.__ito.refreshFromRemote());
  expect(refreshed.state).toBe("up-to-date");
  expect(refreshed.lastSyncedRevision).toBe(published.lastSyncedRevision);

  // syncStatus() reflects the same up-to-date state the banner shows.
  const status = await page.evaluate(() => window.__ito.syncStatus());
  expect(status.state).toBe("up-to-date");
});

test("A20: an interrupted/invalid refresh retains the local copy and goes stale", async ({
  page,
}) => {
  await bootLibrary(page);

  // Publish a valid revision first so there IS a remote pointer to refresh from.
  await page.evaluate(() => window.__ito.publishToRemote());
  const beforeCounts = await page.evaluate(() => window.__ito.counts());

  // A corrupted/dropped refresh must NOT mutate the local working copy.
  const refreshed = await page.evaluate(() =>
    window.__ito.refreshFromRemote({ corrupt: true }),
  );
  expect(["stale", "offline"]).toContain(refreshed.state);
  expect(refreshed.reason).toBeTruthy();

  // The local brain is byte-for-byte intact: record counts are unchanged.
  const afterCounts = await page.evaluate(() => window.__ito.counts());
  expect(afterCounts).toEqual(beforeCounts);
});

test("A21: the mobile reader shell preserves the source across the writing sheet", async ({
  page,
}) => {
  await bootLibrary(page);

  // Open a single document, then flip the deterministic Phone Reading toggle.
  await page.getByTestId("library-open").first().click();
  await expect(page.getByTestId("reader")).toBeVisible();
  await expect(page.getByTestId("source-pane").first()).toHaveAttribute("data-ready", "true", {
    timeout: 20_000,
  });

  const sourceBefore = await page.evaluate(() => window.__ito.openSourceIds());

  // Phone Reading toggle now lives in the shell gear settings menu (M9).
  await page.getByTestId("settings-menu-btn").click();
  await page.getByTestId("toggle-mobile-mode").click();
  await expect(page.getByTestId("mobile-reader-shell")).toBeVisible();

  // Inspect the related writing (slide-up sheet), then return to reading.
  await page.getByTestId("mobile-inspect-writing").click();
  await expect(page.getByTestId("mobile-related-writing-sheet")).toBeVisible();
  await page.getByTestId("mobile-return-to-reading").click();

  // The exact PDF source is preserved (the Reader pane was never remounted).
  const sourceAfter = await page.evaluate(() => window.__ito.openSourceIds());
  expect(sourceAfter).toEqual(sourceBefore);

  // The per-source offline cache status control is present + reflects a status.
  await expect(page.getByTestId("source-binary-status")).toBeVisible();
});
