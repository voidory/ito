/**
 * FEAT-001 (M7) - Linked history, checkpoints & multi-span reflection engine
 * (H01-H07, D13, D14). These drive the REAL Workbench + in-memory
 * StorageAdapter (nothing mocked) and assert:
 *
 *  - prose typing on the SAME page within COALESCE_WINDOW_MS coalesces into ONE
 *    revision via flushPendingRevision; an edit after the window (or to another
 *    page) starts a fresh revision (H01);
 *  - structural actions flush immediately as their own revision (H02);
 *  - setDragOffset/setZoom record NO revision (presentation-only);
 *  - a Checkpoint is written at exactly CHECKPOINT_INTERVAL revisions and its
 *    stateSnapshot EXCLUDES revisions+checkpoints and carries no asset bytes
 *    (H06);
 *  - reconstructRevisionState returns the reconstructed state on a complete
 *    chain and an explicit missing-segment result on a broken chain (H05);
 *  - restoreRevision records a NEW forward revision without erasing history;
 *  - measureHistoryOverhead returns the expected field shape (H07);
 *  - createReflection stores linkedRevisionIds/startDateKey/endDateKey and
 *    creates ZERO graph nodes; addRevisionComment persists a comment (H04).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import {
  CHECKPOINT_INTERVAL,
  COALESCE_WINDOW_MS,
  Workbench,
} from "./workbench";
import type { DocumentJson } from "../editor";
import type { Page } from "../model";

function doc(text: string): DocumentJson {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

/** Advance an ISO timestamp by `ms` milliseconds. */
function plus(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

describe("M7 H01 - coalesced prose revisions", () => {
  let wb: Workbench;
  let page: Page;
  const t0 = "2024-05-01T10:00:00.000Z";

  beforeEach(async () => {
    wb = await Workbench.open(new InMemoryStorageAdapter());
    page = await wb.createSubjectPage("S");
  });

  it("coalesces same-page typing within the idle window into ONE revision", async () => {
    await wb.recordProseEdit(page.id, doc("a"), t0);
    await wb.recordProseEdit(page.id, doc("ab"), plus(t0, 500));
    await wb.recordProseEdit(page.id, doc("abc"), plus(t0, 1000));
    // Nothing committed until flush.
    expect(wb.revisions()).toHaveLength(0);

    await wb.flushPendingRevision();
    const revs = wb.revisions();
    expect(revs).toHaveLength(1);
    expect(revs[0]!.kind).toBe("page-prose");
    // The single coalesced revision carries the ORIGINAL before + FINAL after.
    const before = revs[0]!.beforeSnapshot as { documentJson: DocumentJson };
    const after = revs[0]!.afterSnapshot as { documentJson: DocumentJson };
    expect(before.documentJson).toEqual(
      expect.objectContaining({ type: "doc" }),
    );
    expect(after.documentJson).toEqual(doc("abc"));
  });

  it("starts a new revision when the idle window elapses", async () => {
    await wb.recordProseEdit(page.id, doc("a"), t0);
    // A second edit AFTER the window flushes the first then buffers the second.
    await wb.recordProseEdit(page.id, doc("ab"), plus(t0, COALESCE_WINDOW_MS + 1));
    await wb.flushPendingRevision();
    expect(wb.revisions()).toHaveLength(2);
  });

  it("flushes the buffer when the edit targets a different page", async () => {
    const page2 = await wb.createSubjectPage("S2");
    await wb.recordProseEdit(page.id, doc("a"), t0);
    await wb.recordProseEdit(page2.id, doc("x"), plus(t0, 100));
    await wb.flushPendingRevision();
    const revs = wb.revisions();
    expect(revs).toHaveLength(2);
    expect(revs[0]!.affectedObjectIds).toEqual([page.id]);
    expect(revs[1]!.affectedObjectIds).toEqual([page2.id]);
  });

  it("flushPendingRevision is a no-op when nothing is buffered", async () => {
    await wb.flushPendingRevision();
    expect(wb.revisions()).toHaveLength(0);
  });
});

describe("M7 H02 - structural actions + presentation exclusions", () => {
  let wb: Workbench;

  beforeEach(async () => {
    wb = await Workbench.open(new InMemoryStorageAdapter());
  });

  it("records a structural action immediately as its own revision", async () => {
    await wb.recordStructuralRevision({ kind: "relationship", summary: "linked A-B" });
    const revs = wb.revisions();
    expect(revs).toHaveLength(1);
    expect(revs[0]!.kind).toBe("relationship");
  });

  it("flushes a pending prose buffer before a structural action (ordering)", async () => {
    const page = await wb.createSubjectPage("S");
    await wb.recordProseEdit(page.id, doc("a"), "2024-05-01T10:00:00.000Z");
    await wb.recordStructuralRevision({ kind: "category", summary: "new category" });
    const revs = wb.revisions();
    expect(revs).toHaveLength(2);
    expect(revs[0]!.kind).toBe("page-prose");
    expect(revs[1]!.kind).toBe("category");
  });

  it("setDragOffset and setZoom record NO revision (presentation only)", async () => {
    const page = await wb.createSubjectPage("S");
    await wb.setDragOffset(page.id, 12, 34);
    await wb.setZoom(2);
    expect(wb.revisions()).toHaveLength(0);
  });
});

describe("M7 H06 - periodic checkpoints", () => {
  it("writes a checkpoint at exactly CHECKPOINT_INTERVAL revisions with a history-free, binary-free snapshot", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    // Import a PDF so there is a Source with asset bytes in storage (the
    // checkpoint must NOT duplicate those bytes).
    const src = await wb.importSource({
      title: "Doc",
      bytes: new Uint8Array([9, 9, 9, 9]),
      versionHash: "hash-Doc",
      pageCount: 2,
      category: "Papers",
    });

    expect(wb.checkpoints()).toHaveLength(0);
    for (let i = 0; i < CHECKPOINT_INTERVAL; i += 1) {
      await wb.recordStructuralRevision({ kind: "other", summary: `r${i}` });
    }
    const checkpoints = wb.checkpoints();
    expect(checkpoints).toHaveLength(1);
    expect(wb.revisions()).toHaveLength(CHECKPOINT_INTERVAL);

    const snap = checkpoints[0]!.stateSnapshot as Record<string, unknown>;
    // (H06) the snapshot EXCLUDES recursive history collections.
    expect(snap["revisions"]).toEqual([]);
    expect(snap["checkpoints"]).toEqual([]);
    // It keeps the structured source record (by asset id) but no asset bytes.
    expect((snap["sources"] as unknown[]).length).toBe(1);
    const serialized = JSON.stringify(snap);
    // The source's asset id is present; the raw PDF bytes (9,9,9,9) are not.
    expect(serialized).toContain(src.assetId);
    expect(serialized).not.toContain("9,9,9,9");
  });
});

describe("M7 H05 - reconstruct + restore", () => {
  let wb: Workbench;
  let page: Page;
  const t0 = "2024-05-01T10:00:00.000Z";

  beforeEach(async () => {
    wb = await Workbench.open(new InMemoryStorageAdapter());
    page = await wb.createSubjectPage("S");
  });

  it("reconstructs state on a complete delta chain", async () => {
    await wb.recordProseEdit(page.id, doc("first"), t0);
    await wb.flushPendingRevision();
    const firstRev = wb.revisions()[0]!;

    await wb.recordProseEdit(page.id, doc("second"), plus(t0, COALESCE_WINDOW_MS + 1));
    await wb.flushPendingRevision();

    const result = wb.reconstructRevisionState(firstRev.id);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const pages = (result.state as { pages: { id: string; documentJson: DocumentJson }[] })
        .pages;
      const target = pages.find((p) => p.id === page.id)!;
      expect(target.documentJson).toEqual(doc("first"));
    }
  });

  it("returns a missing-segment result when a prose delta is unreplayable", async () => {
    await wb.recordProseEdit(page.id, doc("x"), t0);
    await wb.flushPendingRevision();
    const rev = wb.revisions()[0]!;
    // Corrupt the after-delta so the chain is broken.
    (rev as { afterSnapshot?: unknown }).afterSnapshot = { pageId: undefined };
    const result = wb.reconstructRevisionState(rev.id);
    expect(result.status).toBe("missing-segment");
    if (result.status === "missing-segment") {
      expect(result.missingIds).toContain(rev.id);
      expect(result.fallbackState).not.toBeNull();
    }
  });

  it("missing-segment for an unknown revision id", () => {
    const result = wb.reconstructRevisionState("rev_nope");
    expect(result.status).toBe("missing-segment");
  });

  it("restoreRevision records a NEW forward revision without erasing history", async () => {
    await wb.recordProseEdit(page.id, doc("v1"), t0);
    await wb.flushPendingRevision();
    const firstRev = wb.revisions()[0]!;
    await wb.recordProseEdit(page.id, doc("v2"), plus(t0, COALESCE_WINDOW_MS + 1));
    await wb.flushPendingRevision();

    const countBefore = wb.revisions().length;
    const forward = await wb.restoreRevision(firstRev.id);
    expect(forward).not.toBeNull();
    expect(forward!.kind).toBe("restore");
    // History GREW (the intermediate revisions are all still present).
    expect(wb.revisions().length).toBe(countBefore + 1);
    expect(wb.revisions().some((r) => r.id === firstRev.id)).toBe(true);
    // The live page was restored to the v1 content.
    const restored = wb.rawData().pages.find((p) => p.id === page.id)!;
    expect(restored.documentJson).toEqual(doc("v1"));
  });
});

describe("M7 H07 - history overhead probe", () => {
  it("returns the full overhead field shape", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    await wb.recordStructuralRevision({ kind: "other", summary: "one" });
    const probe = wb.measureHistoryOverhead();
    expect(probe).toEqual(
      expect.objectContaining({
        revisionCount: expect.any(Number),
        checkpointCount: expect.any(Number),
        deltaBytes: expect.any(Number),
        checkpointBytes: expect.any(Number),
        replayDurationMs: expect.any(Number),
      }),
    );
    expect(probe.revisionCount).toBe(1);
    expect(probe.deltaBytes).toBeGreaterThan(0);
    expect(probe.replayDurationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("M7 H04 / D14 - reflections + revision comments", () => {
  let wb: Workbench;
  let page: Page;

  beforeEach(async () => {
    wb = await Workbench.open(new InMemoryStorageAdapter());
    page = await wb.createSubjectPage("S");
  });

  it("createReflection stores linked ids + multi-day span and creates ZERO graph nodes", async () => {
    // Two revisions on different days.
    await wb.recordProseEdit(page.id, doc("d1"), "2024-05-01T10:00:00.000Z");
    await wb.flushPendingRevision();
    await wb.recordProseEdit(page.id, doc("d2"), "2024-05-10T10:00:00.000Z");
    await wb.flushPendingRevision();
    const [r1, r2] = wb.revisions();

    const pagesBefore = wb.rawData().pages.length;
    const relsBefore = wb.rawData().relationships.length;
    const catsBefore = wb.rawData().categories.length;
    const revsBefore = wb.revisions().length;

    const entry = await wb.createReflection({
      text: "comparing day 1 and day 10",
      linkedRevisionIds: [r1!.id, r2!.id],
    });

    expect(entry.linkedRevisionIds).toEqual([r1!.id, r2!.id]);
    expect(entry.startDateKey).toBe("2024-05-01");
    expect(entry.endDateKey).toBe("2024-05-10");
    expect(entry.startDateKey).not.toBe(entry.endDateKey);
    expect(wb.reflections()).toHaveLength(1);

    // H04: a reflection NEVER rewrites revisions and NEVER creates graph nodes.
    expect(wb.revisions()).toHaveLength(revsBefore);
    expect(wb.rawData().pages).toHaveLength(pagesBefore);
    expect(wb.rawData().relationships).toHaveLength(relsBefore);
    expect(wb.rawData().categories).toHaveLength(catsBefore);
  });

  it("addRevisionComment persists a per-change comment (and is a no-op for unknown ids)", async () => {
    await wb.recordStructuralRevision({ kind: "other", summary: "change" });
    const rev = wb.revisions()[0]!;
    await wb.addRevisionComment(rev.id, "I reworded this section");
    expect(wb.revisionComments()[rev.id]).toBe("I reworded this section");

    await wb.addRevisionComment("rev_unknown", "ignored");
    expect(wb.revisionComments()["rev_unknown"]).toBeUndefined();
  });
});
