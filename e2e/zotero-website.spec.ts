import { expect, test, type Page } from "@playwright/test";
import { seedSampleLibrary } from "./helpers";

/**
 * FEAT-003 (M6, A15, A24, D01, D10, D11) — Zotero import, snapshot websites and
 * area annotations, runtime validation in real Chromium. Every assertion reads
 * the LIVE DOM and the LIVE window.__ito surface; nothing is mocked.
 *
 * Coverage:
 *  - idempotent Zotero import (A24, D10): re-importing the SAME bundle matches on
 *    externalId in place, adding ZERO duplicate Source/Annotation records and
 *    ZERO graph nodes;
 *  - website sources (A15, D11): the add-website modal requires a URL AND a
 *    snapshot; a URL-only submit is rejected with website-snapshot-required-error;
 *  - a website imported via the test API carries kind "website" +
 *    availabilityStatus "snapshot-cached";
 *  - area annotations (D01): commitAreaAnnotation creates a kind "area"
 *    annotation (one more annotation, zero graph nodes) that is citable.
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

/** A minimal native-Zotero JSON bundle: one parent item with one highlight. */
const ZOTERO_BUNDLE = JSON.stringify([
  {
    key: "ITEMKEY1",
    itemType: "journalArticle",
    title: "A Study of Things",
    annotations: [
      {
        key: "ANNKEY1",
        annotationType: "highlight",
        annotationText: "an important passage",
        annotationComment: "note",
        annotationPageLabel: "3",
      },
    ],
  },
]);

test("Zotero import is idempotent: re-import adds zero duplicates and zero graph nodes (A24, D10)", async ({
  page,
}) => {
  await bootLibrary(page);

  const first = await page.evaluate(async (bundle) => {
    const graphBefore = window.__ito.graphRecordCount();
    const summary = await window.__ito.importZoteroBundle(bundle);
    const counts = window.__ito.counts();
    const graphAfter = window.__ito.graphRecordCount();
    return { summary, counts, graphBefore, graphAfter };
  }, ZOTERO_BUNDLE);

  // First import adds the source + annotation but NO graph node.
  expect(first.summary.sourcesAdded).toBe(1);
  expect(first.summary.annotationsAdded).toBe(1);
  expect(first.graphAfter).toEqual(first.graphBefore);

  // Re-importing the SAME bundle updates in place: zero NEW sources/annotations.
  const second = await page.evaluate(async (bundle) => {
    const countsBefore = window.__ito.counts();
    const summary = await window.__ito.importZoteroBundle(bundle);
    const countsAfter = window.__ito.counts();
    const graph = window.__ito.graphRecordCount();
    return { summary, countsBefore, countsAfter, graph };
  }, ZOTERO_BUNDLE);

  expect(second.summary.sourcesAdded).toBe(0);
  expect(second.summary.annotationsAdded).toBe(0);
  expect(second.countsAfter.sources).toBe(second.countsBefore.sources);
  expect(second.countsAfter.annotations).toBe(second.countsBefore.annotations);
  expect(second.graph).toEqual({ pages: 0, relationships: 0, categories: 0 });
});

test("the add-website modal rejects a URL-only submit with the required-error (A15, D11)", async ({
  page,
}) => {
  await bootLibrary(page);

  await page.getByTestId("add-website").click();
  await expect(page.getByTestId("add-website-modal")).toBeVisible();
  await expect(page.getByTestId("website-url-input")).toBeVisible();
  // The snapshot dropzone sits directly under the URL input (D11).
  await expect(page.getByTestId("website-snapshot-dropzone")).toBeVisible();

  // Fill ONLY the URL and submit: the snapshot-required error must appear.
  await page.getByTestId("website-url-input").fill("https://example.com/article");
  await page.getByTestId("add-website-submit").click();
  await expect(page.getByTestId("website-snapshot-required-error")).toBeVisible();
});

test("a website imported via the test API is kind 'website' + snapshot-cached", async ({ page }) => {
  await bootLibrary(page);

  const result = await page.evaluate(async () => {
    const snapshot = Array.from(new TextEncoder().encode("<html><body>Hello</body></html>"));
    return window.__ito.importWebsiteSource({
      url: "https://example.com/article",
      snapshot,
      title: "Example Article",
    });
  });
  expect(result.kind).toBe("website");
  expect(result.availabilityStatus).toBe("snapshot-cached");
});

test("area annotations: commitAreaAnnotation creates a kind 'area' annotation and no graph node (D01)", async ({
  page,
}) => {
  await bootLibrary(page);

  // Open the first PDF so we have a real source id to annotate.
  await page.getByTestId("library-open").first().click();
  await expect(page.getByTestId("reader")).toBeVisible();
  const sourceId = (await page.evaluate(() => window.__ito.openSourceIds()))[0]!;

  const result = await page.evaluate(async (id) => {
    const before = window.__ito.counts();
    const graphBefore = window.__ito.graphRecordCount();
    const annotationId = await window.__ito.commitAreaAnnotation(
      id,
      0,
      { x: 0.1, y: 0.1, width: 0.3, height: 0.2 },
      "a figure",
    );
    const after = window.__ito.counts();
    const graphAfter = window.__ito.graphRecordCount();
    return { annotationId, before, after, graphBefore, graphAfter };
  }, sourceId);

  // Exactly one more annotation; zero graph nodes created.
  expect(result.annotationId).toBeTruthy();
  expect(result.after.annotations).toBe(result.before.annotations + 1);
  expect(result.graphAfter).toEqual(result.graphBefore);

  // The area annotation is citable into a Subject Page (reuses the evidence path).
  const cited = await page.evaluate(async (annId) => {
    const pageId = await window.__ito.createSubject("Figures");
    const evidenceId = await window.__ito.citeAnnotationIntoPage(annId, pageId);
    return { evidenceId, pageEvidence: window.__ito.pageEvidenceCount(pageId) };
  }, result.annotationId);
  expect(cited.evidenceId).toBeTruthy();
  expect(cited.pageEvidence).toBe(1);
});
