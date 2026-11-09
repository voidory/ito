/**
 * FEAT-001 (Pass-A engine refinement 1.3.1) - reconstructRevisionState must also
 * replay `restore` revisions during delta replay.
 *
 * A restore records its `afterSnapshot` as an array of { pageId, documentJson }.
 * Reconstructing a revision recorded at/after a mid-segment restore must reflect
 * the RESTORED content (not the pre-restore content), even before the next
 * 20-revision checkpoint. Before the fix the replay loop skipped every non
 * `page-prose` kind, so a reconstruct that landed on a restore revision would
 * show stale content.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { Workbench } from "./workbench";
import type { DocumentJson } from "../editor";
import type { Page } from "../model";

function doc(text: string): DocumentJson {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function plus(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

describe("reconstructRevisionState replays restore revisions (1.3.1)", () => {
  let wb: Workbench;
  let page: Page;
  const t0 = "2024-06-01T10:00:00.000Z";

  beforeEach(async () => {
    wb = await Workbench.open(new InMemoryStorageAdapter());
    page = await wb.createSubjectPage("S");
  });

  it("reconstructing the restore revision reflects the RESTORED page content", async () => {
    // rev 1: content "alpha"
    await wb.recordProseEdit(page.id, doc("alpha"), t0);
    await wb.flushPendingRevision();
    const revAlpha = wb.revisions()[0]!;

    // rev 2: content "beta" (a separate, flushed revision)
    await wb.recordProseEdit(page.id, doc("beta"), plus(t0, 5000));
    await wb.flushPendingRevision();

    // Restore back to "alpha": records a NEW forward `restore` revision whose
    // afterSnapshot is [{ pageId, documentJson: alpha }].
    const restoreRev = await wb.restoreRevision(revAlpha.id);
    expect(restoreRev).not.toBeNull();
    expect(restoreRev!.kind).toBe("restore");

    // Reconstructing the restore revision must show "alpha" (the restored
    // content), proving the replay loop handled kind === "restore".
    const result = wb.reconstructRevisionState(restoreRev!.id);
    expect(result.status).toBe("ok");
    const state = (result as { status: "ok"; state: Record<string, unknown> }).state;
    const pages = state["pages"] as { id: string; documentJson: unknown }[];
    const reconstructed = pages.find((p) => p.id === page.id)!;
    expect(JSON.stringify(reconstructed.documentJson)).toContain("alpha");
    expect(JSON.stringify(reconstructed.documentJson)).not.toContain("beta");
  });

  it("a prose edit recorded AFTER a restore reconstructs on top of the restored state", async () => {
    await wb.recordProseEdit(page.id, doc("one"), t0);
    await wb.flushPendingRevision();
    const revOne = wb.revisions()[0]!;

    await wb.recordProseEdit(page.id, doc("two"), plus(t0, 5000));
    await wb.flushPendingRevision();

    await wb.restoreRevision(revOne.id); // restore revision records "one"

    // A further edit to "three" after the restore.
    await wb.recordProseEdit(page.id, doc("three"), plus(t0, 20000));
    await wb.flushPendingRevision();
    const latest = wb.revisions()[wb.revisions().length - 1]!;

    const result = wb.reconstructRevisionState(latest.id);
    expect(result.status).toBe("ok");
    const state = (result as { status: "ok"; state: Record<string, unknown> }).state;
    const pages = state["pages"] as { id: string; documentJson: unknown }[];
    const reconstructed = pages.find((p) => p.id === page.id)!;
    expect(JSON.stringify(reconstructed.documentJson)).toContain("three");
  });
});
