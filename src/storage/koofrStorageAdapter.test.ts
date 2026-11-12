/**
 * FEAT-001 (M4, §15, D08) - KoofrStorageAdapter WebDAV primitives.
 *
 * Drives the adapter with a FAKE fetchImpl that captures every request so we
 * can assert the HTTP method, path, Authorization header, and body shapes
 * WITHOUT any network. Also proves 404 -> null on GET and that no credential is
 * ever hardcoded (an adapter built with no username/appPassword sends NO
 * Authorization header; an adapter built with credentials derives the Basic
 * header purely from the passed config).
 */

import { describe, expect, it } from "vitest";
import { KoofrStorageAdapter } from "./KoofrStorageAdapter";

type CapturedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
};

/** Build a fake fetch backed by an in-memory path->bytes store. */
function makeFakeFetch(seed?: Record<string, string>) {
  const store = new Map<string, Uint8Array>();
  const requests: CapturedRequest[] = [];
  const enc = new TextEncoder();
  if (seed) {
    for (const [path, value] of Object.entries(seed)) store.set(path, enc.encode(value));
  }

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = normalizeHeaders(init?.headers);
    const bodyStr =
      init?.body === undefined || init?.body === null
        ? undefined
        : new TextDecoder().decode(bodyToBytes(init.body, enc));
    requests.push({ url, method, headers, body: bodyStr });

    // Path relative to a known base so the store keys are stable.
    const path = url.replace("https://dav.example/Koofr/", "");

    if (method === "PUT") {
      store.set(path, bodyToBytes(init?.body, enc));
      return fakeResponse(201, "");
    }
    if (method === "GET") {
      const bytes = store.get(path);
      if (!bytes) return fakeResponse(404, "");
      return fakeResponse(200, bytes);
    }
    if (method === "MKCOL") {
      return fakeResponse(201, "");
    }
    if (method === "PROPFIND") {
      // Return a multistatus body listing every stored child of the collection.
      const children = [...store.keys()].filter((k) => k.startsWith(path + "/"));
      const hrefs = children
        .map((k) => `<d:response><d:href>/Koofr/${k}</d:href></d:response>`)
        .join("");
      return fakeResponse(207, `<d:multistatus xmlns:d="DAV:">${hrefs}</d:multistatus>`);
    }
    return fakeResponse(405, "");
  }) as unknown as typeof fetch;

  return { fetchImpl, requests, store };
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

function normalizeHeaders(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => (out[k.toLowerCase()] = v));
  } else if (Array.isArray(h)) {
    for (const [k, v] of h) out[k.toLowerCase()] = v;
  } else {
    for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  }
  return out;
}

function fakeResponse(status: number, body: string | Uint8Array): Response {
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

const BASE = "https://dav.example/Koofr";

describe("KoofrStorageAdapter WebDAV primitives", () => {
  it("sends a Basic auth header derived ONLY from the passed credentials", async () => {
    const { fetchImpl, requests } = makeFakeFetch();
    const adapter = new KoofrStorageAdapter({
      baseUrl: BASE,
      username: "user@example.com",
      appPassword: "app-pass-123",
      fetchImpl,
    });
    await adapter.put("snapshots/rev-1.json", "{}", "application/json");
    const put = requests.find((r) => r.method === "PUT")!;
    expect(put.url).toBe(`${BASE}/snapshots/rev-1.json`);
    const expected = "Basic " + Buffer.from("user@example.com:app-pass-123").toString("base64");
    expect(put.headers["authorization"]).toBe(expected);
    expect(put.headers["content-type"]).toBe("application/json");
  });

  it("sends NO Authorization header when no credentials are provided", async () => {
    const { fetchImpl, requests } = makeFakeFetch();
    const adapter = new KoofrStorageAdapter({ baseUrl: BASE, fetchImpl });
    await adapter.get("current-revision.json");
    const get = requests.find((r) => r.method === "GET")!;
    expect(get.headers["authorization"]).toBeUndefined();
  });

  it("GET returns null on a 404", async () => {
    const { fetchImpl } = makeFakeFetch();
    const adapter = new KoofrStorageAdapter({ baseUrl: BASE, fetchImpl });
    expect(await adapter.get("assets/missing")).toBeNull();
    expect(await adapter.getText("snapshots/rev-9.json")).toBeNull();
    expect(await adapter.readPointer()).toBeNull();
  });

  it("round-trips a snapshot write/read and reports hasAsset correctly", async () => {
    const { fetchImpl } = makeFakeFetch();
    const adapter = new KoofrStorageAdapter({ baseUrl: BASE, fetchImpl });
    await adapter.ensureLayout();
    await adapter.writeSnapshot(3, '{"ok":true}');
    expect(await adapter.readSnapshot(3)).toBe('{"ok":true}');
    expect(await adapter.hasAsset("asset-x")).toBe(false);
    await adapter.writeAsset("asset-x", new Uint8Array([1, 2, 3]));
    expect(await adapter.hasAsset("asset-x")).toBe(true);
    const bytes = await adapter.readAsset("asset-x");
    expect(Array.from(bytes!)).toEqual([1, 2, 3]);
  });

  it("PROPFIND lists capture ids with Depth:1 and application/xml", async () => {
    const { fetchImpl, requests } = makeFakeFetch();
    const adapter = new KoofrStorageAdapter({
      baseUrl: BASE,
      username: "u",
      appPassword: "p",
      fetchImpl,
    });
    await adapter.ensureLayout();
    await adapter.writeCapture("cap_1", '{"id":"cap_1"}');
    await adapter.writeCapture("cap_2", '{"id":"cap_2"}');
    const ids = await adapter.listCaptureIds();
    expect(ids.sort()).toEqual(["cap_1", "cap_2"]);
    const propfind = requests.find((r) => r.method === "PROPFIND")!;
    expect(propfind.headers["depth"]).toBe("1");
    expect(propfind.headers["content-type"]).toBe("application/xml");
  });

  it("MKCOL tolerates an already-existing collection (405/409)", async () => {
    const store = new Map<string, Uint8Array>();
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "").toUpperCase() === "MKCOL") return fakeResponse(405, "");
      return fakeResponse(200, "");
    }) as unknown as typeof fetch;
    void store;
    const adapter = new KoofrStorageAdapter({ baseUrl: BASE, fetchImpl });
    await expect(adapter.mkcol("snapshots")).resolves.toBeUndefined();
  });

  it("the module source contains no hardcoded credential literals", async () => {
    // Guard against a regression that bakes a password into the adapter.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.join(process.cwd(), "src/storage/KoofrStorageAdapter.ts"),
      "utf-8",
    );
    expect(src).not.toMatch(/appPassword\s*[:=]\s*['"][^'"]+['"]/);
    expect(src.toLowerCase()).not.toContain("password =");
  });
});
