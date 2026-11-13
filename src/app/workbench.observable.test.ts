/**
 * P4 (observable store) — Vitest coverage for the Workbench subscription that
 * the React binding (useWorkbench) consumes via useSyncExternalStore.
 *
 * These assert, against the REAL Workbench + in-memory storage (nothing mocked),
 * the three properties the store must guarantee so a forgotten manual `bump()`
 * can never leave the UI stale:
 *
 *  - subscribe() fires its listener on a TRANSIENT view mutation (setViewMode)
 *    AND on a DURABLE mutation (importSource, which persists);
 *  - snapshot() returns a STABLE reference between mutations (required by
 *    useSyncExternalStore) and a FRESH reference after a mutation notifies;
 *  - unsubscribe() stops further notifications.
 */

import { describe, expect, it } from "vitest";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { KoofrStorageAdapter } from "../storage";
import { Workbench } from "./workbench";

async function openWb(): Promise<Workbench> {
  return Workbench.open(new InMemoryStorageAdapter());
}

describe("Workbench observable store (P4)", () => {
  it("notifies subscribers on a transient view mutation", async () => {
    const wb = await openWb();
    let fired = 0;
    wb.subscribe(() => {
      fired += 1;
    });
    wb.setViewMode("nodes");
    expect(fired).toBeGreaterThan(0);
    expect(wb.snapshot().viewMode).toBe("nodes");
  });

  it("notifies subscribers on a durable (persisting) mutation", async () => {
    const wb = await openWb();
    let fired = 0;
    wb.subscribe(() => {
      fired += 1;
    });
    await wb.importSource({
      title: "Paper",
      bytes: new Uint8Array([1, 2, 3, 4]),
      versionHash: "a".repeat(64),
      pageCount: 1,
    });
    // persist() notifies immediately (in-memory applied) and again once the
    // write settles, so the listener fires at least once.
    expect(fired).toBeGreaterThan(0);
    expect(wb.snapshot().sources).toHaveLength(1);
  });

  it("returns a stable snapshot reference until the next mutation", async () => {
    const wb = await openWb();
    const a = wb.snapshot();
    const b = wb.snapshot();
    expect(b).toBe(a); // cached — identical reference
    wb.setViewMode("nodes");
    const c = wb.snapshot();
    expect(c).not.toBe(a); // invalidated by the mutation's notify()
  });

  it("stops notifying after unsubscribe", async () => {
    const wb = await openWb();
    let fired = 0;
    const unsubscribe = wb.subscribe(() => {
      fired += 1;
    });
    wb.setViewMode("nodes");
    const afterFirst = fired;
    expect(afterFirst).toBeGreaterThan(0);
    unsubscribe();
    wb.setViewMode("files");
    expect(fired).toBe(afterFirst); // no further notifications
  });

  // Regression guards for the two paths that swap `this.data` WITHOUT going
  // through persist() (flagged in the P4 semantic review): commitStagedImport
  // and refreshFromRemote must notify AFTER the swap, not rely on a bump().
  it("notifies after commitStagedImport swaps the live brain", async () => {
    // Build a donor brain, export it, then stage + commit into a fresh brain.
    const donor = await openWb();
    await donor.importSource({
      title: "Imported Paper",
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3]),
      versionHash: "b".repeat(64),
      pageCount: 1,
    });
    const { bytes } = await donor.exportBackup();

    const wb = await openWb();
    expect(wb.snapshot().sources).toHaveLength(0);
    await wb.stageImport(bytes);

    let fired = 0;
    wb.subscribe(() => {
      fired += 1;
    });
    // A cross-brain import stages as 'needs-confirmation' → commit leniently.
    const result = await wb.commitStagedImport({ lenient: true });
    expect(result.committed).toBe(true);
    // The listener fired AND the post-commit snapshot reflects the imported data.
    expect(fired).toBeGreaterThan(0);
    expect(wb.snapshot().sources).toHaveLength(1);
  });

  it("notifies after refreshFromRemote replaces the live brain", async () => {
    // Publisher populates a remote; a fresh workbench refreshes from it.
    const remote = makeInMemoryRemote();
    const publisher = await openWb();
    await publisher.importSource({
      title: "Remote Paper",
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 9, 9, 9]),
      versionHash: "c".repeat(64),
      pageCount: 1,
    });
    await publisher.publishToRemote(remote.adapter());

    const wb = await openWb();
    expect(wb.snapshot().sources).toHaveLength(0);
    let fired = 0;
    wb.subscribe(() => {
      fired += 1;
    });
    const status = await wb.refreshFromRemote(remote.adapter());
    expect(status.state).toBe("up-to-date");
    // The swap notified, and the snapshot taken AFTER the swap sees the brain.
    expect(fired).toBeGreaterThan(0);
    expect(wb.snapshot().sources).toHaveLength(1);
  });
});

/**
 * A minimal in-memory WebDAV-backed Koofr remote for the refresh test. Mirrors
 * the fake used by workbench.koofr.test.ts, kept local so this file is
 * self-contained.
 */
function makeInMemoryRemote(): { adapter: () => KoofrStorageAdapter } {
  const store = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  const resp = (status: number, body: string | Uint8Array): Response => {
    const bytes = typeof body === "string" ? enc.encode(body) : body;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: `status ${status}`,
      async text() {
        return new TextDecoder().decode(bytes);
      },
      async arrayBuffer() {
        return bytes.slice().buffer;
      },
    } as unknown as Response;
  };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const path = String(input).replace("https://dav.example/Koofr/", "");
    if (method === "PUT") {
      const body = init?.body;
      const bytes =
        typeof body === "string"
          ? enc.encode(body)
          : body instanceof Uint8Array
            ? body
            : new Uint8Array((body as ArrayBuffer) ?? new ArrayBuffer(0));
      store.set(path, bytes);
      return resp(201, "");
    }
    if (method === "GET") {
      const bytes = store.get(path);
      return bytes ? resp(200, bytes) : resp(404, "");
    }
    if (method === "MKCOL") return resp(201, "");
    if (method === "PROPFIND") {
      const children = [...store.keys()].filter((k) => k.startsWith(path + "/"));
      const hrefs = children
        .map((k) => `<d:response><d:href>/Koofr/${k}</d:href></d:response>`)
        .join("");
      return resp(207, `<d:multistatus xmlns:d="DAV:">${hrefs}</d:multistatus>`);
    }
    return resp(405, "");
  }) as unknown as typeof fetch;

  return {
    adapter: () =>
      new KoofrStorageAdapter({
        baseUrl: "https://dav.example/Koofr",
        username: "u",
        appPassword: "p",
        fetchImpl,
      }),
  };
}
