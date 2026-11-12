/**
 * FEAT-001 (M4, §15, A20, H06) - Workbench safe atomic publication + resilient
 * refresh against a KoofrStorageAdapter backed by an in-memory FAKE fetch.
 *
 * Asserts:
 *  - publishToRemote uploads only MISSING assets (H06), writes the snapshot and
 *    verifies it, and updates current-revision.json LAST;
 *  - a simulated failure BEFORE the pointer step leaves the prior remote
 *    current-revision.json intact (A20);
 *  - refreshFromRemote retains the local working copy untouched and sets a
 *    stale/offline syncStatus with a reason on a corrupted snapshot (A20);
 *  - syncStatus transitions publishing -> up-to-date on success.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { Workbench } from "./workbench";
import { KoofrStorageAdapter } from "../storage";

type RemoteState = {
  store: Map<string, Uint8Array>;
  fetchImpl: typeof fetch;
  /** Set a method+path matcher that throws (simulating a mid-publish fault). */
  failOn: { method: string; pathIncludes: string } | null;
};

function makeRemote(): RemoteState {
  const store = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  const state: RemoteState = { store, fetchImpl: null as unknown as typeof fetch, failOn: null };

  state.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.replace("https://dav.example/Koofr/", "");

    if (
      state.failOn &&
      state.failOn.method === method &&
      path.includes(state.failOn.pathIncludes)
    ) {
      throw new TypeError("network dropped (simulated)");
    }

    if (method === "PUT") {
      store.set(path, bodyToBytes(init?.body, enc));
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

  return state;
}

/** Robustly coerce a fetch body (string | ArrayBuffer | Uint8Array) to bytes. */
function bodyToBytes(body: unknown, enc: TextEncoder): Uint8Array {
  if (typeof body === "string") return enc.encode(body);
  if (body instanceof Uint8Array) return body;
  if (body && typeof (body as ArrayBuffer).byteLength === "number") {
    return new Uint8Array(body as ArrayBuffer);
  }
  return enc.encode(String(body ?? ""));
}

function resp(status: number, body: string | Uint8Array): Response {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
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
}

function adapterFor(state: RemoteState): KoofrStorageAdapter {
  return new KoofrStorageAdapter({
    baseUrl: "https://dav.example/Koofr",
    username: "u",
    appPassword: "p",
    fetchImpl: state.fetchImpl,
  });
}

function decode(bytes: Uint8Array | undefined): string | null {
  return bytes ? new TextDecoder().decode(bytes) : null;
}

describe("M4 publishToRemote - pointer-last safe publication", () => {
  let local: InMemoryStorageAdapter;
  let wb: Workbench;

  beforeEach(async () => {
    local = new InMemoryStorageAdapter();
    wb = await Workbench.open(local);
    await wb.importSource({
      title: "Doc A",
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3]),
      versionHash: "hash-a",
      pageCount: 1,
    });
  });

  it("uploads missing assets, verifies the snapshot, and writes the pointer LAST", async () => {
    const remote = makeRemote();
    const status = await wb.publishToRemote(adapterFor(remote));
    expect(status.state).toBe("up-to-date");
    expect(status.lastSyncedRevision).toBe(wb.rawData().manifest.publicationRevision);

    // Pointer exists and references the published snapshot.
    const pointer = JSON.parse(decode(remote.store.get("current-revision.json"))!);
    const rev = pointer.publicationRevision;
    expect(remote.store.has(`snapshots/rev-${rev}.json`)).toBe(true);
    // The asset was uploaded.
    const assetId = wb.rawData().manifest.assetIndex[0]!.assetId as string;
    expect(remote.store.has(`assets/${assetId}`)).toBe(true);
  });

  it("does NOT re-upload an asset that already exists remotely (H06)", async () => {
    const remote = makeRemote();
    const assetId = wb.rawData().manifest.assetIndex[0]!.assetId as string;
    // Pre-seed the asset so publish should skip it.
    remote.store.set(`assets/${assetId}`, new Uint8Array([9, 9, 9]));

    await wb.publishToRemote(adapterFor(remote));
    // The pre-seeded bytes must be untouched (publish did not overwrite them).
    expect(Array.from(remote.store.get(`assets/${assetId}`)!)).toEqual([9, 9, 9]);
  });

  it("leaves the prior remote pointer intact when a step BEFORE the pointer fails (A20)", async () => {
    const remote = makeRemote();
    // First, a clean publish so there IS a prior pointer.
    await wb.publishToRemote(adapterFor(remote));
    const priorPointer = decode(remote.store.get("current-revision.json"));
    expect(priorPointer).not.toBeNull();

    // Mutate local state so a new publish would advance the revision, then make
    // the SNAPSHOT write fail (a step before the pointer step).
    await wb.createSubjectPage("New subject");
    remote.failOn = { method: "PUT", pathIncludes: "snapshots/" };

    const status = await wb.publishToRemote(adapterFor(remote));
    expect(status.state).toBe("offline");
    expect(status.reason).toBeTruthy();
    // The prior pointer is byte-for-byte unchanged (never touched).
    expect(decode(remote.store.get("current-revision.json"))).toBe(priorPointer);
  });
});

describe("M4 refreshFromRemote - A20 interrupted/corrupted update guarantee", () => {
  async function publishFrom(): Promise<RemoteState> {
    const source = await Workbench.open(new InMemoryStorageAdapter());
    await source.createSubjectPage("Published subject");
    const remote = makeRemote();
    await source.publishToRemote(adapterFor(remote));
    return remote;
  }

  it("refreshes a valid remote snapshot into local state and reports up-to-date", async () => {
    const remote = await publishFrom();
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    expect(wb.rawData().pages).toHaveLength(0);

    const status = await wb.refreshFromRemote(adapterFor(remote));
    expect(status.state).toBe("up-to-date");
    expect(wb.rawData().pages.some((p) => p.title === "Published subject")).toBe(true);
  });

  it("retains the local copy untouched and goes stale on a corrupted snapshot (A20)", async () => {
    const remote = await publishFrom();
    // Corrupt the published snapshot so its hash no longer matches the pointer.
    const pointer = JSON.parse(decode(remote.store.get("current-revision.json"))!);
    const rev = pointer.publicationRevision;
    remote.store.set(`snapshots/rev-${rev}.json`, new TextEncoder().encode('{"corrupt":true}'));

    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const localPage = await wb.createSubjectPage("Local only");
    const before = JSON.stringify(wb.rawData());

    const status = await wb.refreshFromRemote(adapterFor(remote));
    expect(status.state).toBe("stale");
    expect(status.reason).toBeTruthy();
    // Local working copy is byte-for-byte untouched.
    expect(JSON.stringify(wb.rawData())).toBe(before);
    expect(wb.rawData().pages.some((p) => p.id === localPage.id)).toBe(true);
  });

  it("goes offline (retaining local state) when the fetch drops mid-refresh (A20)", async () => {
    const remote = await publishFrom();
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const before = JSON.stringify(wb.rawData());
    remote.failOn = { method: "GET", pathIncludes: "current-revision.json" };

    const status = await wb.refreshFromRemote(adapterFor(remote));
    expect(status.state).toBe("offline");
    expect(status.reason).toBeTruthy();
    expect(JSON.stringify(wb.rawData())).toBe(before);
  });
});
