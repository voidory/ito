/**
 * FEAT-001 (M5, §16.2, §16.3, A22, A23) - Workbench mobile-capture engine.
 *
 * Asserts:
 *  - createMobileCapture adds a Capture and creates ZERO Page/Category/
 *    Relationship records (A23) - with AND without a source;
 *  - status transitions local -> pending -> uploaded via uploadPendingCaptures;
 *  - pullRemoteCaptures + handleCapture dedupe strictly by CaptureId across
 *    repeated and out-of-order pulls so a capture is incorporated AT MOST ONCE
 *    (A22);
 *  - each disposition records the right CaptureHandling and preserves the
 *    original Capture with an updated status.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { Workbench } from "./workbench";
import { KoofrStorageAdapter } from "../storage";
import type { BrainData } from "../model";

function graphRecordCount(data: BrainData): number {
  return (
    data.pages.length +
    data.categories.length +
    data.relationships.length
  );
}

function makeRemote() {
  const store = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.replace("https://dav.example/Koofr/", "");
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
  return { store, fetchImpl };
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

function adapterFor(fetchImpl: typeof fetch): KoofrStorageAdapter {
  return new KoofrStorageAdapter({
    baseUrl: "https://dav.example/Koofr",
    username: "u",
    appPassword: "p",
    fetchImpl,
  });
}

describe("M5 createMobileCapture - A23 never creates a graph node", () => {
  let wb: Workbench;

  beforeEach(async () => {
    wb = await Workbench.open(new InMemoryStorageAdapter());
  });

  it("adds a capture with NO new Page/Category/Relationship (no source)", async () => {
    const before = graphRecordCount(wb.rawData());
    const cap = await wb.createMobileCapture({ content: "a loose thought" });
    expect(cap.status).toBe("local");
    expect(cap.text).toBe("a loose thought");
    expect(wb.captures()).toHaveLength(1);
    expect(graphRecordCount(wb.rawData())).toBe(before);
  });

  it("adds a capture with NO new graph node even WITH a source + anchor (A23)", async () => {
    const source = await wb.importSource({
      title: "Doc",
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
      versionHash: "h",
      pageCount: 1,
    });
    const before = graphRecordCount(wb.rawData());
    const cap = await wb.createMobileCapture({
      content: "quote from the doc",
      sourceId: source.id,
      originDevice: "phone",
      queueForUpload: true,
    });
    expect(cap.status).toBe("pending");
    expect(cap.sourceId).toBe(source.id);
    expect(cap.originDevice).toBe("phone");
    expect(graphRecordCount(wb.rawData())).toBe(before);
  });
});

describe("M5 upload/pull capture sync + A22 idempotency", () => {
  it("transitions local/pending -> uploaded and writes an independent remote item", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const remote = makeRemote();
    const cap = await wb.createMobileCapture({ content: "thought one" });
    expect(cap.status).toBe("local");

    const results = await wb.uploadPendingCaptures(adapterFor(remote.fetchImpl));
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("uploaded");
    expect(wb.captures()[0]!.status).toBe("uploaded");
    expect(remote.store.has(`captures/${cap.id}.json`)).toBe(true);
    // A second upload call is a no-op (nothing local/pending left).
    const second = await wb.uploadPendingCaptures(adapterFor(remote.fetchImpl));
    expect(second).toHaveLength(0);
  });

  it("keeps a capture pending with an honest error when the upload fails", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    await wb.createMobileCapture({ content: "offline thought" });
    const failingFetch = (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    const results = await wb.uploadPendingCaptures(adapterFor(failingFetch));
    expect(results[0]!.status).toBe("pending");
    expect(results[0]!.error).toBeTruthy();
    // The capture is NOT discarded.
    expect(wb.captures()).toHaveLength(1);
    expect(wb.captures()[0]!.status).toBe("pending");
  });

  it("incorporates each capture AT MOST ONCE across repeated + out-of-order pulls (A22)", async () => {
    // Producer phone publishes two captures to the remote.
    const phone = await Workbench.open(new InMemoryStorageAdapter());
    const remote = makeRemote();
    const c1 = await phone.createMobileCapture({ content: "cap one" });
    const c2 = await phone.createMobileCapture({ content: "cap two" });
    await phone.uploadPendingCaptures(adapterFor(remote.fetchImpl));

    // Desktop pulls.
    const desktop = await Workbench.open(new InMemoryStorageAdapter());
    const first = await desktop.pullRemoteCaptures(adapterFor(remote.fetchImpl));
    expect(first.sort()).toEqual([c1.id, c2.id].sort());
    expect(desktop.captures()).toHaveLength(2);

    // Repeated pull: nothing new (dedupe against captures).
    const repeat = await desktop.pullRemoteCaptures(adapterFor(remote.fetchImpl));
    expect(repeat).toHaveLength(0);
    expect(desktop.captures()).toHaveLength(2);

    // Handle one, then pull again (dedupe against captureHandlings too).
    await desktop.handleCapture(c1.id, "dismiss");
    const afterHandle = await desktop.pullRemoteCaptures(adapterFor(remote.fetchImpl));
    expect(afterHandle).toHaveLength(0);
    expect(desktop.captures()).toHaveLength(2);
  });

  it("dedupes against captureHandlings even if the Capture record is gone (out-of-order)", async () => {
    const phone = await Workbench.open(new InMemoryStorageAdapter());
    const remote = makeRemote();
    const c1 = await phone.createMobileCapture({ content: "x" });
    await phone.uploadPendingCaptures(adapterFor(remote.fetchImpl));

    const desktop = await Workbench.open(new InMemoryStorageAdapter());
    await desktop.pullRemoteCaptures(adapterFor(remote.fetchImpl));
    await desktop.handleCapture(c1.id, "dismiss");
    const handlings = desktop.captureHandlings();
    expect(handlings).toHaveLength(1);
    // A re-pull does not re-incorporate the already-handled capture.
    const again = await desktop.pullRemoteCaptures(adapterFor(remote.fetchImpl));
    expect(again).toHaveLength(0);
  });
});

describe("M5 handleCapture dispositions", () => {
  it("insert-into-page records incorporated-quote and preserves the capture", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const page = await wb.createSubjectPage("Target");
    const cap = await wb.createMobileCapture({
      content: "a thought to insert",
      targetPageId: page.id,
    });
    const before = graphRecordCount(wb.rawData());
    const handling = await wb.handleCapture(cap.id, "insert-into-page");
    expect(handling!.disposition).toBe("incorporated-quote");
    expect(handling!.destinationPageId).toBe(page.id);
    // No NEW graph node (the page already existed).
    expect(graphRecordCount(wb.rawData())).toBe(before);
    // Original capture preserved with updated status.
    expect(wb.captures()[0]!.status).toBe("incorporated");
    // The target page document now contains the capture text.
    expect(JSON.stringify(wb.subjectDocJson(page.id))).toContain("a thought to insert");
  });

  it("create-subject deliberately creates ONE new Page (disposition created-subject)", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const cap = await wb.createMobileCapture({ content: "new subject seed" });
    const beforePages = wb.rawData().pages.length;
    const handling = await wb.handleCapture(cap.id, "create-subject");
    expect(handling!.disposition).toBe("created-subject");
    expect(wb.rawData().pages.length).toBe(beforePages + 1);
    expect(handling!.destinationPageId).toBeTruthy();
  });

  it("dismiss records disposition dismissed and is idempotent on repeat", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const cap = await wb.createMobileCapture({ content: "noise" });
    const first = await wb.handleCapture(cap.id, "dismiss");
    expect(first!.disposition).toBe("dismissed");
    expect(wb.captures()[0]!.status).toBe("dismissed");
    // Repeat is a no-op: still exactly one handling, status unchanged.
    const second = await wb.handleCapture(cap.id, "dismiss");
    expect(second!.disposition).toBe("dismissed");
    expect(wb.captureHandlings()).toHaveLength(1);
  });
});
