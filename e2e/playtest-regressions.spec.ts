import { expect, test, type Page } from "@playwright/test";

/**
 * Regressions for bugs found by playtesting the running app. Each test drives
 * the real UI (real pdf.js text layer, real ProseMirror editor, real IndexedDB)
 * through the exact steps that used to lose or corrupt data.
 */

async function openSample(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("app-status")).toHaveAttribute("data-state", "ready", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("library-item")).toHaveCount(3, { timeout: 15_000 });
  await page.getByTestId("library-open").filter({ hasText: "Sample Document" }).click();
  await expect(page.getByTestId("source-pane").first()).toHaveAttribute("data-ready", "true", {
    timeout: 20_000,
  });
}

async function highlight(page: Page, phrase: string): Promise<string> {
  const before = await page.locator(".ito-highlight").count();
  expect(await page.evaluate((n) => window.__ito.selectText(n, 0), phrase)).toBe(true);
  await page.getByTestId("commit-highlight").click();
  await expect.poll(() => page.locator(".ito-highlight").count()).toBe(before + 1);
  return page.evaluate(
    () => [...document.querySelectorAll<HTMLElement>(".ito-highlight")].at(0)!.dataset.annotationId!,
  );
}

function fragmentOf(page: Page, annotationId: string) {
  return page.locator(`.ito-highlight[data-annotation-id="${annotationId}"] .ito-highlight-fragment`).first();
}

async function idbSummary(page: Page): Promise<{ pointers: number; payloads: number }> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open("ito");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const count = (store: string) =>
      new Promise<number>((res) => {
        const r = db.transaction(store).objectStore(store).count();
        r.onsuccess = () => res(r.result);
      });
    const out = { pointers: await count("pointers"), payloads: await count("payloads") };
    db.close();
    return out;
  });
}

test("storage keeps one brain and one live payload, not a full copy per save", async ({ page }) => {
  await openSample(page);
  const id = await highlight(page, "quick brown fox");
  for (let i = 0; i < 5; i++) {
    await fragmentOf(page, id).click();
    await page.getByTestId("comment-input").fill(`note ${i}`);
    await page.getByTestId("comment-save").click();
    await expect(page.getByTestId("comment-surface")).toHaveCount(0);
  }
  expect(await idbSummary(page)).toEqual({ pointers: 1, payloads: 1 });
  await page.reload();
  await expect(page.getByTestId("app-status")).toHaveAttribute("data-state", "ready");
  await expect.poll(() => page.evaluate(() => window.__ito.annotationCount())).toBe(1);
});

test("switching the comment surface to another highlight never carries the old draft over", async ({
  page,
}) => {
  await openSample(page);
  await highlight(page, "quick brown fox");
  await highlight(page, "lazy dog");
  const ids = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".ito-highlight")].map((e) => e.dataset.annotationId!),
  );
  await fragmentOf(page, ids[0]!).click();
  await page.getByTestId("comment-input").fill("draft meant for the first highlight");
  await fragmentOf(page, ids[1]!).click();
  await expect(page.getByTestId("comment-surface")).toHaveAttribute("data-annotation-id", ids[1]!);
  await expect(page.getByTestId("comment-input")).toHaveValue("");
});

test("closing the subject page right after typing keeps the text", async ({ page }) => {
  await openSample(page);
  const subject = await page.evaluate(() => window.__ito.createSubject("Fast close"));
  await page.evaluate((s) => window.__ito.openSubject(s), subject);
  await page.getByTestId("subject-prosemirror").click();
  await page.keyboard.type("typed then closed");
  await page.getByTestId("close-subject").click();
  await expect
    .poll(() => page.evaluate((s) => window.__ito.subjectOutline(s).join("|"), subject))
    .toContain("typed then closed");
});

test("a quote inserted from the reader menu survives further typing in the open editor", async ({
  page,
}) => {
  await openSample(page);
  const first = await highlight(page, "quick brown fox");
  await fragmentOf(page, first).click({ button: "right" });
  await page.getByTestId("menu-create-subject").click();
  await page.getByTestId("new-subject-title").fill("Menu insert");
  await page.getByTestId("create-subject-confirm").click();
  await expect(page.getByTestId("evidence-chip")).toHaveCount(1);
  const subject = (await page.evaluate(() => window.__ito.openSubjectId()))!;

  const second = await highlight(page, "lazy dog");
  await fragmentOf(page, second).click({ button: "right" });
  await page.getByTestId("menu-insert").click();
  await page.getByTestId("subject-option").first().click();
  await expect(page.getByTestId("evidence-chip")).toHaveCount(2);

  await page.getByTestId("subject-prosemirror").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" and more");
  await expect
    .poll(() => page.evaluate((s) => window.__ito.subjectOutline(s).join("|"), subject))
    .toContain("and more");
  expect(await page.evaluate((s) => window.__ito.subjectEvidenceOrder(s).length, subject)).toBe(2);
  expect(await page.evaluate((s) => window.__ito.pageEvidenceCount(s), subject)).toBe(2);
});

test("deleting a quote chip in the editor demotes the pair from cited", async ({ page }) => {
  await openSample(page);
  const id = await highlight(page, "quick brown fox");
  await fragmentOf(page, id).click({ button: "right" });
  await page.getByTestId("menu-create-subject").click();
  await page.getByTestId("new-subject-title").fill("Delete chip");
  await page.getByTestId("create-subject-confirm").click();
  await expect(page.getByTestId("evidence-chip")).toHaveCount(1);
  const subject = (await page.evaluate(() => window.__ito.openSubjectId()))!;
  expect(await page.evaluate(([a, s]) => window.__ito.referenceStatus(a!, s!), [id, subject])).toBe(
    "cited",
  );
  await page.getByTestId("evidence-chip").locator(".evidence-quote").click();
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("evidence-chip")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(([a, s]) => window.__ito.referenceStatus(a!, s!), [id, subject]))
    .toBe("none");
});

test("a failed save is surfaced with a retry, and retrying persists the change", async ({ page }) => {
  await openSample(page);
  await page.evaluate(() => window.__ito.forceNextSaveFailures(1));
  expect(await page.evaluate(() => window.__ito.selectText("lazy dog", 0))).toBe(true);
  await page.getByTestId("commit-highlight").click();
  await expect(page.getByTestId("save-error-banner")).toBeVisible();
  await expect(page.getByTestId("selection-toolbar")).toHaveCount(0);
  await page.getByTestId("retry-save").click();
  await expect(page.getByTestId("save-error-banner")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("app-status")).toHaveAttribute("data-state", "ready");
  await expect.poll(() => page.evaluate(() => window.__ito.annotationCount())).toBe(1);
});

test("highlights on a drifted source edition are explicitly marked, not silently drawn", async ({
  page,
}) => {
  await openSample(page);
  await highlight(page, "quick brown fox");
  const sid = (await page.evaluate(() => window.__ito.openSourceIds()))[0]!;
  await page.evaluate((s) => window.__ito.forceSourceVersionDrift(s), sid);
  await page.getByTestId("back-to-library").click();
  await page.getByTestId("library-open").filter({ hasText: "Sample Document" }).click();
  await expect(page.getByTestId("source-pane").first()).toHaveAttribute("data-ready", "true");
  await expect(page.locator(".ito-highlight").first()).toHaveAttribute("data-resolution", "mismatched");
});
