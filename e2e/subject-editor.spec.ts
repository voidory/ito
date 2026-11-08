import { expect, test, type Page } from "@playwright/test";

/**
 * FEAT-004 — M1 SUBJECT LAYER + CONTINUOUS EDITOR, runtime validation in real
 * chromium (spec section 24). Every test drives the REAL app: real pdf.js text
 * layers, real text selection, a real ProseMirror editor, and real IndexedDB
 * persistence. Nothing is mocked; assertions read live DOM + live Workbench
 * state, never static strings.
 *
 * Coverage: deliberate subject creation from evidence (A03); compose
 * paragraph/quoteA/interpretation/quoteB/question then reorder + reload with
 * structure + provenance preserved (A04); insert-at-cursor with no mandatory
 * template, dotted->solid, source annotation survives (A05, R06); a removed
 * quote does not demote while another citation remains (section 6); precise
 * source-return without replacing the subject page + explicit mismatched-anchor
 * (A17); toggleable structural details (A07); R14 composition round-trip.
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

/** Commit a highlight over the given real phrase on the given page index. */
async function highlightPhrase(page: Page, phrase: string, pageIndex = 0): Promise<void> {
  const before = await page.locator(".ito-highlight").count();
  const ok = await page.evaluate(
    ([n, p]) => window.__ito.selectText(n as string, p as number),
    [phrase, pageIndex] as const,
  );
  expect(ok, `select "${phrase}" on page ${pageIndex}`).toBe(true);
  await page.getByTestId("commit-highlight").click();
  await expect
    .poll(() => page.locator(".ito-highlight").count())
    .toBeGreaterThan(before);
}

/** Commit a highlight over the default needle on the given page index. */
async function highlight(page: Page, pageIndex = 0): Promise<void> {
  await highlightPhrase(page, NEEDLE, pageIndex);
}

test("A03: a subject page is created ONLY by explicit action from selected evidence", async ({
  page,
}) => {
  await openFirstDocument(page);

  // Before any deliberate action: highlighting created NO page.
  await highlight(page);
  let counts = await page.evaluate(() => window.__ito.counts());
  expect(counts.pages).toBe(0);
  expect(counts.evidence).toBe(0);

  // Explicit deliberate creation from the evidence via the accessible menu.
  await page.getByTestId("toggle-highlights-tab").click();
  await page.getByTestId("row-actions").first().click();
  await page.getByTestId("menu-create-subject").click();
  await page.getByTestId("new-subject-title").fill("Causality in chemistry");
  await page.getByTestId("create-subject-confirm").click();

  // The subject editor opens alongside the reader (reader NOT replaced).
  await expect(page.getByTestId("subject-editor")).toBeVisible();
  await expect(page.getByTestId("subject-title")).toHaveText("Causality in chemistry");
  await expect(page.getByTestId("reader")).toBeVisible();

  // The quote is really composed in and the pair derives SOLID (source-local
  // -> solid, no prior association). The source annotation survives.
  const subjectId = await page.evaluate(() => window.__ito.openSubjectId());
  const annId = await page.evaluate(() => window.__ito.firstAnnotationId());
  expect(subjectId).toBeTruthy();
  expect(await page.evaluate(() => window.__ito.pageEvidenceCount(window.__ito.openSubjectId()!))).toBe(1);
  const status = await page.evaluate(
    ([a, p]) => window.__ito.referenceStatus(a as string, p as string),
    [annId, subjectId] as const,
  );
  expect(status).toBe("cited");
  counts = await page.evaluate(() => window.__ito.counts());
  expect(counts.pages).toBe(1);
  expect(counts.annotations).toBe(1); // annotation not moved/deleted
  expect(counts.associations).toBe(0); // direct citation, no tentative step
  // The quote chip is visible and visually distinct in the editor.
  await expect(page.getByTestId("evidence-chip").first()).toBeVisible();
});

test("A05 + R06: insert at the cursor with no mandatory template; dotted->solid; annotation survives", async ({
  page,
}) => {
  await openFirstDocument(page);
  await highlight(page);

  const subjectId = await page.evaluate(() => window.__ito.createSubject("Free composition"));
  // Tentatively associate first so we can watch dotted -> solid.
  const annId = await page.evaluate(() => window.__ito.firstAnnotationId());
  await page.getByTestId("toggle-highlights-tab").click();
  await page.getByTestId("row-actions").first().click();
  await page.getByTestId("menu-associate").click();
  await page.getByTestId("subject-search").fill("Free");
  await page.getByTestId("subject-option").first().click();
  expect(
    await page.evaluate(
      ([a, p]) => window.__ito.referenceStatus(a as string, p as string),
      [annId, subjectId] as const,
    ),
  ).toBe("tentative");

  // Open the subject and write some prose FIRST (no template imposed).
  await page.evaluate((id) => window.__ito.openSubject(id), subjectId);
  await expect(page.getByTestId("subject-editor")).toBeVisible();
  const doc = page.getByTestId("subject-prosemirror");
  await doc.click();
  await page.keyboard.type("I argue this because of the evidence.");

  // Place the cursor in the MIDDLE of the writing, then insert the quote there.
  await page.keyboard.press("Home");
  for (let i = 0; i < 12; i++) await page.keyboard.press("ArrowRight");
  await page.getByTestId("insert-at-cursor").click();
  await page.getByTestId("insert-annotation-option").first().click();

  // The quote landed inline among the writing (no mandatory evidence section).
  await expect(page.getByTestId("evidence-chip")).toHaveCount(1);
  const outline = await page.evaluate((id) => window.__ito.subjectOutline(id), subjectId);
  expect(outline.join("\n")).toContain("⟦evidence:");
  expect(outline.join("\n")).toContain("I argue this");

  // dotted -> solid; the source annotation is untouched.
  expect(
    await page.evaluate(
      ([a, p]) => window.__ito.referenceStatus(a as string, p as string),
      [annId, subjectId] as const,
    ),
  ).toBe("cited");
  const counts = await page.evaluate(() => window.__ito.counts());
  expect(counts.annotations).toBe(1);
  expect(counts.evidence).toBe(1);
});

test("A04 + R14: compose paragraph/quoteA/interpretation/quoteB/question, reorder, reload; structure + provenance preserved", async ({
  page,
}) => {
  await openFirstDocument(page);
  // Two distinct highlights give two annotations to quote.
  await highlightPhrase(page, "quick brown fox", 0);
  await highlightPhrase(page, "lazy dog", 0);
  const anns = await page.evaluate(() => window.__ito.counts().annotations);
  expect(anns).toBe(2);

  const subjectId = await page.evaluate(() => window.__ito.createSubject("Structured piece"));
  await page.evaluate((id) => window.__ito.openSubject(id), subjectId);
  const doc = page.getByTestId("subject-prosemirror");
  await doc.click();

  // Build: paragraph / quoteA / interpretation / quoteB / question.
  await page.keyboard.type("Opening paragraph.");
  await page.keyboard.press("Enter");
  await page.getByTestId("insert-at-cursor").click();
  await page.getByTestId("insert-annotation-option").nth(0).click();
  await doc.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("My interpretation.");
  await page.keyboard.press("Enter");
  await page.getByTestId("insert-at-cursor").click();
  await page.getByTestId("insert-annotation-option").nth(1).click();
  await doc.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("A closing question?");

  // Let the debounced save flush.
  await page.waitForTimeout(300);

  const beforeOrder = await page.evaluate((id) => window.__ito.subjectEvidenceOrder(id), subjectId);
  expect(beforeOrder).toHaveLength(2);
  const beforeOutline = await page.evaluate((id) => window.__ito.subjectOutline(id), subjectId);
  // Two quotes interleaved with writing.
  expect(beforeOutline.filter((l) => l.includes("⟦evidence:")).length).toBe(2);

  // Reorder: move the LAST block to the top via the reorder control.
  await page.keyboard.press("Control+End");
  await page.getByTestId("move-block-up").click();
  await page.waitForTimeout(100);
  const movedOutline = await page.evaluate((id) => window.__ito.subjectOutline(id), subjectId);
  expect(movedOutline).not.toEqual(beforeOutline);

  // Capture the stored composition, then reload the whole app.
  const savedOutline = await page.evaluate((id) => window.__ito.subjectOutline(id), subjectId);
  const savedOrder = await page.evaluate((id) => window.__ito.subjectEvidenceOrder(id), subjectId);

  await page.reload();
  await expect(page.getByTestId("app-status")).toHaveAttribute("data-state", "ready", {
    timeout: 15_000,
  });
  // Reopen the document + subject from the SAME IndexedDB.
  await page.getByTestId("library-open").first().click();
  await expect(page.getByTestId("source-pane").first()).toHaveAttribute("data-ready", "true", {
    timeout: 20_000,
  });
  await page.evaluate((id) => window.__ito.openSubject(id), subjectId);
  await expect(page.getByTestId("subject-editor")).toBeVisible();

  const reloadedOutline = await page.evaluate((id) => window.__ito.subjectOutline(id), subjectId);
  const reloadedOrder = await page.evaluate((id) => window.__ito.subjectEvidenceOrder(id), subjectId);
  // Exact composition order + quote identities + provenance restored.
  expect(reloadedOutline).toEqual(savedOutline);
  expect(reloadedOrder).toEqual(savedOrder);
  const counts = await page.evaluate(() => window.__ito.counts());
  expect(counts.evidence).toBe(2);
});

test("section 6: removing one quote does NOT demote a relationship while another citation remains", async ({
  page,
}) => {
  await openFirstDocument(page);
  await highlight(page);
  const subjectId = await page.evaluate(() => window.__ito.createSubject("Two citations"));
  const annId = await page.evaluate(() => window.__ito.firstAnnotationId());
  await page.evaluate((id) => window.__ito.openSubject(id), subjectId);
  const doc = page.getByTestId("subject-prosemirror");
  await doc.click();

  // Insert the SAME annotation twice (two quotes for one pair).
  await page.getByTestId("insert-at-cursor").click();
  await page.getByTestId("insert-annotation-option").first().click();
  await doc.click();
  await page.keyboard.press("Control+End");
  await page.getByTestId("insert-at-cursor").click();
  await page.getByTestId("insert-annotation-option").first().click();
  await page.waitForTimeout(200);
  await expect(page.getByTestId("evidence-chip")).toHaveCount(2);
  expect(await page.evaluate(() => window.__ito.counts().evidence)).toBe(2);

  // Remove ONE quote node from the editor (select the first chip, delete it).
  const firstChip = page.getByTestId("evidence-chip").first();
  await firstChip.click();
  // Place the selection just after the chip and backspace it out.
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(200);

  // Still cited: one quote remains for the pair.
  const status = await page.evaluate(
    ([a, p]) => window.__ito.referenceStatus(a as string, p as string),
    [annId, subjectId] as const,
  );
  expect(status).toBe("cited");
  await expect(page.getByTestId("evidence-chip")).toHaveCount(1);
});

test("A17: following a quote returns to the exact source WITHOUT replacing the subject page", async ({
  page,
}) => {
  await openFirstDocument(page);
  await highlight(page);
  await page.getByTestId("toggle-highlights-tab").click();
  await page.getByTestId("row-actions").first().click();
  await page.getByTestId("menu-create-subject").click();
  await page.getByTestId("new-subject-title").fill("Return target");
  await page.getByTestId("create-subject-confirm").click();
  await expect(page.getByTestId("subject-editor")).toBeVisible();

  // Follow the quote back to its source.
  await page.getByTestId("follow-source").first().click();

  // The subject page is STILL open (not closed or replaced).
  await expect(page.getByTestId("subject-editor")).toBeVisible();
  // The source pane scrolled to the resolved passage and drew the return
  // overlay re-derived from the LIVE render (resolved, not mismatched).
  await expect(page.locator('.pdf-page[data-return-resolution="resolved"]')).toHaveCount(1, {
    timeout: 10_000,
  });
  await expect(page.locator(".ito-return").first()).toBeVisible();
  // No unresolved notice for an intact source.
  await expect(page.getByTestId("source-return-notice")).toHaveCount(0);
});

test("A17: a changed source version yields an explicit mismatched-anchor state, never silent nav", async ({
  page,
}) => {
  await openFirstDocument(page);
  await highlight(page);
  const sourceId = await page.evaluate(() => window.__ito.openSourceIds()[0]!);
  await page.getByTestId("toggle-highlights-tab").click();
  await page.getByTestId("row-actions").first().click();
  await page.getByTestId("menu-create-subject").click();
  await page.getByTestId("new-subject-title").fill("Drifted source");
  await page.getByTestId("create-subject-confirm").click();
  await expect(page.getByTestId("subject-editor")).toBeVisible();

  // Drift the source edition: the quote's anchor hash no longer matches the
  // stored source version.
  await page.evaluate((id) => window.__ito.forceSourceVersionDrift(id), sourceId);

  // Follow the quote: the app must report an EXPLICIT mismatched state and must
  // NOT draw a highlight over unrelated content.
  await page.getByTestId("follow-source").first().click();
  await expect(page.getByTestId("source-return-notice")).toBeVisible();
  await expect(page.getByTestId("source-return-notice")).toContainText(/version changed/i);
  await expect(page.locator('.pdf-page[data-return-resolution="mismatched"]')).toHaveCount(1, {
    timeout: 10_000,
  });
  // No silent highlight was drawn for the unresolved return.
  await expect(page.locator(".ito-return")).toHaveCount(0);
  // The subject page is still open (never replaced).
  await expect(page.getByTestId("subject-editor")).toBeVisible();
});

test("A07: structural details are toggleable and hiding them never breaks attribution", async ({
  page,
}) => {
  await openFirstDocument(page);
  await highlight(page);
  await page.getByTestId("toggle-highlights-tab").click();
  await page.getByTestId("row-actions").first().click();
  await page.getByTestId("menu-create-subject").click();
  await page.getByTestId("new-subject-title").fill("Details subject");
  await page.getByTestId("create-subject-confirm").click();
  await expect(page.getByTestId("subject-editor")).toBeVisible();

  // Details are hidden by default; the quote attribution is still present.
  await expect(page.getByTestId("subject-details")).toHaveCount(0);
  await expect(page.getByTestId("evidence-chip").first()).toBeVisible();
  await expect(page.getByTestId("follow-source").first()).toBeVisible();

  // Toggle details on: counts appear.
  await page.getByTestId("toggle-details").click();
  await expect(page.getByTestId("subject-details")).toBeVisible();
  await expect(page.getByTestId("detail-quotes")).toHaveText(/Quotes: 1/);
  await expect(page.getByTestId("detail-sources")).toHaveText(/Source documents: 1/);

  // Toggle details back off: attribution (the chip + follow affordance) is
  // unaffected — hiding metadata never breaks source attribution.
  await page.getByTestId("toggle-details").click();
  await expect(page.getByTestId("subject-details")).toHaveCount(0);
  await expect(page.getByTestId("evidence-chip").first()).toBeVisible();
  await expect(page.getByTestId("follow-source").first()).toBeVisible();
});
